//! Portable multi-round harness. A host persists each round, explicitly dispatches
//! validated calls, then supplies terminal results. Pending/unknown outcomes never
//! authorize another generation or an automatic replay of a tool.
use crate::{prepare, schema, GenerationRequest, PreparedGeneration, ToolCapability};
use lori_work_provider::{
    generation::{ChatMessage, Completion},
    tools::{self, ToolCall, ToolDefinition},
    Protocol, ProviderError,
};
use serde_json::{json, Value};
use std::collections::HashSet;

pub struct AgentConfig {
    pub protocol: Protocol,
    pub native_openai: bool,
    pub model: String,
    pub system: String,
    pub messages: Vec<ChatMessage>,
    pub tools: Vec<ToolDefinition>,
    pub context_tokens: u32,
    pub output_tokens: u32,
    pub max_rounds: u32,
}
pub struct AgentSession {
    config: AgentConfig,
    rounds: u32,
    call_count: usize,
    native_ids: HashSet<String>,
    pending: Vec<ToolCall>,
    awaiting_completion: bool,
    finished: bool,
}
pub struct AgentRound {
    pub index: u32,
    pub generation: PreparedGeneration,
}
pub struct AcceptedRound {
    pub assistant: ChatMessage,
    pub calls: Vec<ToolCall>,
    pub finished: bool,
}
fn error(code: &str, message: &str) -> ProviderError {
    ProviderError::new(code, message)
}
/// Conservative planning estimate, never billing. Non-ASCII/opaque continuation
/// bytes receive a larger reservation than ordinary English text.
pub fn text_tokens(text: &str) -> u64 {
    let ascii = text.bytes().filter(u8::is_ascii).count() as u64;
    ascii.div_ceil(3) + (text.len() as u64 - ascii)
}
pub fn request_tokens(
    messages: &[ChatMessage],
    system: &str,
    definitions: &[ToolDefinition],
) -> u64 {
    let history = messages
        .iter()
        .map(|m| {
            text_tokens(
                &m.native
                    .as_ref()
                    .map(Value::to_string)
                    .unwrap_or_else(|| m.text.clone()),
            ) + 32
        })
        .sum::<u64>();
    let tools = definitions
        .iter()
        .map(|t| text_tokens(&serde_json::to_string(t).unwrap_or_default()) + 32)
        .sum::<u64>();
    history + tools + text_tokens(system) + 128
}
impl AgentSession {
    pub fn new(config: AgentConfig) -> Result<Self, ProviderError> {
        if !(1..=32).contains(&config.max_rounds)
            || config.output_tokens == 0
            || config.context_tokens < 1024
            || config.output_tokens >= config.context_tokens
            || config.tools.len() > 64
        {
            return Err(error(
                "invalidAgentBudget",
                "The agent context or execution budget is invalid.",
            ));
        }
        let mut names = HashSet::new();
        if config.tools.iter().any(|t| {
            t.name.is_empty() || !names.insert(t.name.clone()) || t.parameters["type"] != "object"
        }) {
            return Err(error(
                "invalidToolSchema",
                "The offered tool definitions are invalid.",
            ));
        }
        Ok(Self {
            config,
            rounds: 0,
            call_count: 0,
            native_ids: HashSet::new(),
            pending: vec![],
            awaiting_completion: false,
            finished: false,
        })
    }
    pub fn prepare_round(&mut self, base_url: &str) -> Result<AgentRound, ProviderError> {
        if self.awaiting_completion || !self.pending.is_empty() {
            return Err(error("toolOutcomePending","A previous generation or tool outcome has not been resolved. It must not be repeated."));
        }
        if self.finished {
            return Err(error(
                "agentCompleted",
                "This agent attempt is already complete.",
            ));
        }
        if self.rounds >= self.config.max_rounds {
            return Err(error(
                "turnLimit",
                "This turn reached its generation limit. Completed actions are saved.",
            ));
        }
        let input_budget = self
            .config
            .context_tokens
            .saturating_sub(self.config.output_tokens)
            .saturating_sub(self.config.context_tokens / 10) as u64;
        if request_tokens(
            &self.config.messages,
            &self.config.system,
            &self.config.tools,
        ) > input_budget
        {
            return Err(error("contextBudgetExceeded","The conversation and tool results exceed the model's safe context budget. Completed actions are saved; start a new conversation or explicitly continue with less context."));
        }
        let generation = prepare(GenerationRequest {
            protocol: self.config.protocol,
            native_openai: self.config.native_openai,
            base_url,
            model: &self.config.model,
            system: &self.config.system,
            messages: &self.config.messages,
            output_tokens: self.config.output_tokens,
            tools: ToolCapability::Authorized(&self.config.tools),
        })?;
        let index = self.rounds;
        self.rounds += 1;
        self.awaiting_completion = true;
        Ok(AgentRound { index, generation })
    }
    pub fn accept_round(
        &mut self,
        completion: &Completion,
    ) -> Result<AcceptedRound, ProviderError> {
        if !self.awaiting_completion {
            return Err(error(
                "unexpectedRound",
                "No generation round is awaiting completion.",
            ));
        }
        if !completion.done {
            return Err(error(
                "interrupted",
                "An interrupted provider round must not dispatch tools.",
            ));
        }
        let mut calls = completion.tool_calls(self.config.protocol, self.config.native_openai)?;
        if self.call_count + calls.len() > 64 {
            return Err(error(
                "turnLimit",
                "This turn reached its tool limit. Completed actions are saved.",
            ));
        }
        let mut batch = HashSet::new();
        for call in &mut calls {
            if call.id_is_native
                && (!batch.insert(call.id.clone()) || self.native_ids.contains(&call.id))
            {
                return Err(error("invalidToolCall","The provider reused a tool call ID. No action from this response was executed."));
            }
            let definition = self
                .config
                .tools
                .iter()
                .find(|t| t.name == call.name)
                .ok_or_else(|| {
                    error("unexpectedTool", "The model requested an unavailable tool.")
                })?;
            schema::normalize(&definition.parameters, &mut call.arguments);
            schema::validate(&definition.parameters, &call.arguments)?;
        }
        if calls.is_empty()
            && matches!(
                completion.finish.as_deref(),
                Some("length" | "max_tokens" | "MAX_TOKENS")
            )
        {
            return Err(error("outputLimit","The model reached its output limit. Partial output and completed actions are saved."));
        }
        if calls.is_empty() && completion.text.trim().is_empty() {
            return Err(error(
                "emptyResponse",
                "The model returned no answer or valid action.",
            ));
        }
        let assistant =
            completion.assistant_message(self.config.protocol, self.config.native_openai);
        self.config.messages.push(assistant.clone());
        self.awaiting_completion = false;
        self.call_count += calls.len();
        for call in &calls {
            if call.id_is_native {
                self.native_ids.insert(call.id.clone());
            }
        }
        self.pending = calls.clone();
        self.finished = calls.is_empty();
        Ok(AcceptedRound {
            assistant,
            calls,
            finished: self.finished,
        })
    }
    pub fn resolve_tool(
        &mut self,
        call_id: &str,
        output: Value,
        failed: bool,
    ) -> Result<(), ProviderError> {
        let position = self
            .pending
            .iter()
            .position(|c| c.id == call_id)
            .ok_or_else(|| {
                error(
                    "unexpectedToolResult",
                    "This tool has already resolved or was never dispatched.",
                )
            })?;
        // Preserve full results in the host's durable receipt; only bounded data
        // crosses the model context boundary. The receipt ID remains available.
        let raw = output.to_string();
        let limit = 8192;
        let portable = if raw.len() > limit {
            let mut end = limit.min(raw.len());
            while !raw.is_char_boundary(end) {
                end -= 1;
            }
            json!({"truncated":true,"preview":&raw[..end],"bytes":raw.len(),"invocationId":output.get("invocationId")})
        } else {
            output
        };
        let call = self.pending.remove(position);
        self.config.messages.push(tools::result_message(
            self.config.protocol,
            self.config.native_openai,
            &call,
            portable,
            failed,
        ));
        Ok(())
    }
    pub fn messages(&self) -> &[ChatMessage] {
        &self.config.messages
    }
    pub fn tools(&self) -> &[ToolDefinition] {
        &self.config.tools
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn agent(protocol: Protocol) -> AgentSession {
        AgentSession::new(AgentConfig {protocol,native_openai:false,model:"model".into(),system:"System".into(),messages:vec![ChatMessage {role:"user".into(),text:"read then answer".into(),native:None}],tools:vec![ToolDefinition {name:"read_file".into(),description:"Read".into(),parameters:json!({"type":"object","properties":{"path":{"type":"string"}},"required":["path"],"additionalProperties":false})}],context_tokens:16384,output_tokens:1024,max_rounds:3}).unwrap()
    }
    fn call() -> Completion {
        let mut c = Completion::default();
        c.accept(Protocol::Openai,false,r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call1","function":{"name":"read_file","arguments":"{\"path\":\"notes.txt\"}"}}]},"finish_reason":"tool_calls"}]}"#).unwrap();
        c.accept(Protocol::Openai, false, "[DONE]").unwrap();
        c
    }
    #[test]
    fn round_trip_requires_terminal_tool_outcome_and_preserves_native_continuation() {
        let mut a = agent(Protocol::Openai);
        a.prepare_round("https://broker.invalid").unwrap();
        let accepted = a.accept_round(&call()).unwrap();
        assert_eq!(accepted.calls[0].arguments["path"], "notes.txt");
        assert_eq!(
            a.prepare_round("https://broker.invalid")
                .err()
                .unwrap()
                .code,
            "toolOutcomePending"
        );
        a.resolve_tool("call1", json!({"text":"facts"}), false)
            .unwrap();
        let next = a.prepare_round("https://broker.invalid").unwrap();
        assert_eq!(next.index, 1);
        assert_eq!(next.generation.body["messages"][3]["tool_call_id"], "call1");
        assert!(a.resolve_tool("call1", json!({}), false).is_err());
    }
    #[test]
    fn denied_action_is_error_result_and_native_call_ids_never_replay() {
        let mut a = agent(Protocol::Openai);
        a.prepare_round("https://broker.invalid").unwrap();
        a.accept_round(&call()).unwrap();
        a.resolve_tool("call1", json!({"error":{"code":"approval_denied"}}), true)
            .unwrap();
        a.prepare_round("https://broker.invalid").unwrap();
        assert_eq!(
            a.accept_round(&call()).err().unwrap().code,
            "invalidToolCall"
        );
    }
    #[test]
    fn validates_entire_batch_before_host_dispatch_and_reserves_context() {
        let mut a = agent(Protocol::Openai);
        a.prepare_round("https://broker.invalid").unwrap();
        let mut c = call();
        c.native[0]["tool_calls"][0]["function"]["arguments"] =
            json!("{\"path\":\"a\",\"extra\":true}");
        assert_eq!(a.accept_round(&c).err().unwrap().code, "invalidArguments");
        let mut a = agent(Protocol::Openai);
        a.config.messages[0].text = "x".repeat(100000);
        assert_eq!(
            a.prepare_round("https://broker.invalid")
                .err()
                .unwrap()
                .code,
            "contextBudgetExceeded"
        );
        assert_eq!(a.rounds, 0);
    }
    #[test]
    fn anthropic_signature_survives_tool_and_denial_result() {
        let mut a = agent(Protocol::Anthropic);
        a.prepare_round("https://broker.invalid").unwrap();
        let mut c = Completion::default();
        for event in [
            json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"plan","signature":"opaque-signature"}}),
            json!({"type":"content_block_stop","index":0}),
            json!({"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"call1","name":"read_file","input":{"path":"a"}}}),
            json!({"type":"content_block_stop","index":1}),
            json!({"type":"message_delta","delta":{"stop_reason":"tool_use"}}),
            json!({"type":"message_stop"}),
        ] {
            c.accept(Protocol::Anthropic, false, &event.to_string())
                .unwrap();
        }
        let accepted = a.accept_round(&c).unwrap();
        assert_eq!(
            accepted.assistant.native.as_ref().unwrap()[0]["signature"],
            "opaque-signature"
        );
        a.resolve_tool("call1", json!({"error":"denied"}), true)
            .unwrap();
        let next = a.prepare_round("https://broker.invalid").unwrap();
        assert_eq!(
            next.generation.body["messages"][1]["content"][0]["signature"],
            "opaque-signature"
        );
        assert_eq!(
            next.generation.body["messages"][2]["content"][0]["is_error"],
            true
        );
    }
}
