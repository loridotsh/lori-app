//! Shared Work generation orchestration. Hosts own identity, credentials, storage,
//! transport and tool dispatch; none of those capabilities are implicit here.
pub mod agent;
pub mod budget;
pub mod progress;
pub mod schema;
pub mod todos;

pub const INSTRUCTIONS_VERSION: u32 = 4;
pub const WORK_INSTRUCTIONS: &str = include_str!("instructions.md");

use lori_work_provider::{
    generation::{self, ChatMessage, Completion, Frames, ResponsePart},
    tools::{self, ToolDefinition},
    Protocol, ProviderError,
};
use serde_json::Value;
use std::{
    ops::{Deref, DerefMut},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
};

pub use lori_work_provider as provider;
pub const MAX_REQUEST_BYTES: usize = 32 * 1024 * 1024;
pub const MAX_RESPONSE_BYTES: usize = 8 * 1024 * 1024;

/// A host must explicitly supply the tools authorized for this generation.
/// This grants no execution authority: dispatch still requires host policy.
pub enum ToolCapability<'a> {
    TextOnly,
    Authorized(&'a [ToolDefinition]),
}
impl ToolCapability<'_> {
    fn definitions(&self) -> &[ToolDefinition] {
        match self {
            Self::TextOnly => &[],
            Self::Authorized(tools) => tools,
        }
    }
}

pub struct GenerationRequest<'a> {
    pub protocol: Protocol,
    pub native_openai: bool,
    pub base_url: &'a str,
    pub model: &'a str,
    pub system: &'a str,
    pub messages: &'a [ChatMessage],
    pub output_tokens: u32,
    pub tools: ToolCapability<'a>,
}
pub struct PreparedGeneration {
    pub endpoint: String,
    pub body: Value,
    pub session: GenerationSession,
}
pub fn prepare(request: GenerationRequest<'_>) -> Result<PreparedGeneration, ProviderError> {
    let (endpoint, mut body) = generation::request(
        request.protocol,
        request.native_openai,
        request.base_url,
        request.model,
        request.system,
        request.messages,
        request.output_tokens,
    );
    tools::configure(
        &mut body,
        request.protocol,
        request.native_openai,
        request.tools.definitions(),
    );
    if serde_json::to_vec(&body)
        .map_err(|_| error("invalidRequest", "Could not encode the model request."))?
        .len()
        > MAX_REQUEST_BYTES
    {
        return Err(error("requestTooLarge", "This request exceeds Work's 32 MB transport limit. Start a new chat with a shorter request; your history is saved."));
    }
    Ok(PreparedGeneration {
        endpoint,
        body,
        session: GenerationSession::new(
            request.protocol,
            request.native_openai,
            request
                .tools
                .definitions()
                .iter()
                .map(|t| t.name.clone())
                .collect(),
        ),
    })
}

#[derive(Clone, Default)]
pub struct Cancellation(Arc<AtomicBool>);
impl Cancellation {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }
    pub fn check(&self) -> Result<(), ProviderError> {
        if self.0.load(Ordering::Acquire) {
            Err(error("cancelled", "Response stopped."))
        } else {
            Ok(())
        }
    }
}

/// One attempt only. Interrupted streams are errors and are never retried here.
pub struct GenerationSession {
    completion: Completion,
    frames: Frames,
    protocol: Protocol,
    native_openai: bool,
    authorized_tools: Vec<String>,
    bytes: usize,
    cancellation: Cancellation,
}
impl GenerationSession {
    pub fn new(protocol: Protocol, native_openai: bool, authorized_tools: Vec<String>) -> Self {
        Self {
            completion: Completion::default(),
            frames: Frames::default(),
            protocol,
            native_openai,
            authorized_tools,
            bytes: 0,
            cancellation: Cancellation::default(),
        }
    }
    pub fn cancellation(&self) -> Cancellation {
        self.cancellation.clone()
    }
    pub fn accept_chunk(&mut self, chunk: &[u8]) -> Result<(), ProviderError> {
        self.cancellation.check()?;
        self.bytes = self.bytes.saturating_add(chunk.len());
        if self.bytes > MAX_RESPONSE_BYTES {
            return Err(error(
                "responseTooLarge",
                "The response reached the safe size limit.",
            ));
        }
        for frame in self.frames.push(chunk, self.protocol == Protocol::Ollama)? {
            self.completion
                .accept(self.protocol, self.native_openai, &frame)?;
        }
        Ok(())
    }
    pub fn finish_transport(&mut self) -> Result<(), ProviderError> {
        self.cancellation.check()?;
        for frame in self.frames.finish(self.protocol == Protocol::Ollama)? {
            self.completion
                .accept(self.protocol, self.native_openai, &frame)?;
        }
        Ok(())
    }
    pub fn validate_response(&self) -> Result<(), ProviderError> {
        self.cancellation.check()?;
        if !self.completion.done {
            return Err(error("interrupted", "The provider ended the stream before confirming completion. Retry to start a new attempt."));
        }
        let calls = self
            .completion
            .tool_calls(self.protocol, self.native_openai)?;
        if calls
            .iter()
            .any(|call| !self.authorized_tools.contains(&call.name))
        {
            return Err(error(
                "unexpectedTool",
                "The model requested a tool unavailable in this conversation.",
            ));
        }
        if self.completion.text.trim().is_empty() && calls.is_empty() {
            if self.completion.output.iter().any(
                |part| matches!(part, ResponsePart::Reasoning { text } if !text.trim().is_empty()),
            ) {
                return Err(error("reasoningOnlyResponse", "The model returned reasoning without an answer. Retry or choose another model."));
            }
            return Err(error(
                "emptyResponse",
                "The model returned no text. Try another model or retry.",
            ));
        }
        Ok(())
    }
    pub fn usage(&self) -> Value {
        provider::usage::normalize(self.protocol, self.completion.usage.as_ref())
    }
    pub fn into_completion(self) -> Completion {
        self.completion
    }
}
impl Deref for GenerationSession {
    type Target = Completion;
    fn deref(&self) -> &Completion {
        &self.completion
    }
}
impl DerefMut for GenerationSession {
    fn deref_mut(&mut self) -> &mut Completion {
        &mut self.completion
    }
}
fn error(code: &str, message: &str) -> ProviderError {
    ProviderError::new(code, message)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn session() -> GenerationSession {
        GenerationSession::new(Protocol::Openai, false, vec![])
    }
    #[test]
    fn bytewise_utf8_crlf_stream_preserves_usage() {
        let mut stream = session();
        let wire = "data: {\"choices\":[{\"delta\":{\"content\":\"héllo\"}}]}\r\n\r\ndata: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":3,\"completion_tokens\":2}}\n\ndata: [DONE]\n\n";
        for byte in wire.as_bytes() {
            stream.accept_chunk(&[*byte]).unwrap();
        }
        stream.finish_transport().unwrap();
        stream.validate_response().unwrap();
        assert_eq!(stream.text, "héllo");
        assert_eq!(stream.usage()["inputTokens"], 3);
    }
    #[test]
    fn interruption_and_error_keep_partial_output() {
        let mut stream = session();
        stream
            .accept_chunk(b"data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n")
            .unwrap();
        stream.finish_transport().unwrap();
        assert_eq!(stream.validate_response().unwrap_err().code, "interrupted");
        assert_eq!(
            stream
                .accept_chunk(b"data: {\"error\":{\"message\":\"private provider detail\"}}\n\n")
                .unwrap_err()
                .code,
            "generationFailed"
        );
        assert_eq!(stream.text, "partial");
    }
    #[test]
    fn cancellation_is_sticky_and_does_not_erase_output() {
        let mut stream = session();
        let cancel = stream.cancellation();
        cancel.cancel();
        assert_eq!(
            stream.accept_chunk(b"data: [DONE]\n\n").unwrap_err().code,
            "cancelled"
        );
        assert_eq!(stream.finish_transport().unwrap_err().code, "cancelled");
    }
    #[test]
    fn unoffered_tools_cannot_cross_text_boundary() {
        let mut stream = session();
        stream.accept_chunk(b"data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"call1\",\"function\":{\"name\":\"shell\",\"arguments\":\"{}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n").unwrap();
        stream.finish_transport().unwrap();
        assert_eq!(
            stream.validate_response().unwrap_err().code,
            "unexpectedTool"
        );
    }
}
