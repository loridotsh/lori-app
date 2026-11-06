//! Credential-free streaming wire adapters. Execution and permissions belong to the host.
use crate::{Protocol, ProviderError};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: String,
    pub text: String,
    #[serde(default)]
    pub native: Option<Value>,
}

pub fn request(
    protocol: Protocol,
    native_openai: bool,
    base: &str,
    model: &str,
    system: &str,
    messages: &[ChatMessage],
    output: u32,
) -> (String, Value) {
    let base = base.trim_end_matches('/');
    match protocol {
        Protocol::Openai if native_openai => (
            format!("{base}/responses"),
            json!({"model":model,"instructions":system,"input":messages.iter().flat_map(|m| m.native.as_ref().and_then(Value::as_array).cloned().unwrap_or_else(|| vec![json!({"role":m.role,"content":m.text})])).collect::<Vec<_>>(),"stream":true,"store":false,"max_output_tokens":output}),
        ),
        Protocol::Openai => {
            let mut input = vec![json!({"role":"system","content":system})];
            input.extend(messages.iter().map(|m| {
                let mut message = m
                    .native
                    .clone()
                    .unwrap_or_else(|| json!({"role":m.role,"content":m.text}));
                // Older saved text-only responses included an empty array.
                // Chat Completions requires a nonempty array when it is present.
                if message["role"] == "assistant"
                    && message["tool_calls"].as_array().is_some_and(Vec::is_empty)
                {
                    message.as_object_mut().unwrap().remove("tool_calls");
                }
                message
            }));
            (
                format!("{base}/chat/completions"),
                json!({"model":model,"messages":input,"stream":true,"stream_options":{"include_usage":true},"max_tokens":output}),
            )
        }
        Protocol::Anthropic => (
            format!("{base}/v1/messages"),
            json!({"model":model,"system":system,"messages":messages.iter().map(|m|json!({"role":m.role,"content":m.native.clone().unwrap_or_else(||json!([{"type":"text","text":m.text}]))})).collect::<Vec<_>>(),"stream":true,"max_tokens":output}),
        ),
        Protocol::Gemini => (
            format!(
                "{base}/models/{}:streamGenerateContent?alt=sse",
                url::form_urlencoded::byte_serialize(model.as_bytes()).collect::<String>()
            ),
            json!({"systemInstruction":{"parts":[{"text":system}]},"contents":gemini_contents(messages),"generationConfig":{"maxOutputTokens":output}}),
        ),
        Protocol::Ollama => {
            let mut input = vec![json!({"role":"system","content":system})];
            input.extend(messages.iter().map(|m| {
                m.native
                    .clone()
                    .unwrap_or_else(|| json!({"role":m.role,"content":m.text}))
            }));
            (
                format!("{base}/api/chat"),
                json!({"model":model,"messages":input,"stream":true,"options":{"num_predict":output}}),
            )
        }
    }
}

fn gemini_contents(messages: &[ChatMessage]) -> Vec<Value> {
    let mut contents: Vec<Value> = Vec::new();
    for message in messages {
        let role = if message.role == "assistant" {
            "model"
        } else {
            "user"
        };
        let parts = message
            .native
            .clone()
            .unwrap_or_else(|| json!([{"text":message.text}]));
        // A tool batch is stored as individual results (and optional images).
        // Gemini requires every response in the next single user content turn.
        if role == "user"
            && contents
                .last()
                .is_some_and(|content| content["role"] == "user")
        {
            contents.last_mut().unwrap()["parts"]
                .as_array_mut()
                .unwrap()
                .extend(parts.as_array().cloned().unwrap_or_default());
        } else {
            contents.push(json!({"role":role,"parts":parts}));
        }
    }
    contents
}

/// Incremental framing: UTF-8 is decoded only after complete SSE/NDJSON frames.
#[derive(Default)]
pub struct Frames {
    buffer: Vec<u8>,
}
impl Frames {
    pub fn push(&mut self, bytes: &[u8], ndjson: bool) -> Result<Vec<String>, ProviderError> {
        self.buffer.extend_from_slice(bytes);
        let mut frames = Vec::new();
        while let Some((end, width)) = if ndjson {
            self.buffer.iter().position(|b| *b == b'\n').map(|n| (n, 1))
        } else {
            let lf = self
                .buffer
                .windows(2)
                .position(|w| w == b"\n\n")
                .map(|n| (n, 2));
            let crlf = self
                .buffer
                .windows(4)
                .position(|w| w == b"\r\n\r\n")
                .map(|n| (n, 4));
            lf.into_iter()
                .chain(crlf)
                .min_by_key(|(position, _)| *position)
        } {
            if end > 1024 * 1024 {
                return Err(invalid("The provider sent an oversized stream frame."));
            }
            let raw = String::from_utf8(self.buffer.drain(..end + width).collect())
                .map_err(|_| invalid("The provider sent invalid UTF-8."))?;
            let data = if ndjson {
                raw.trim().to_owned()
            } else {
                raw.lines()
                    .filter_map(|line| {
                        line.strip_prefix("data:")
                            .map(|s| s.strip_prefix(' ').unwrap_or(s))
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            };
            if !data.is_empty() {
                frames.push(data);
            }
        }
        if self.buffer.len() > 1024 * 1024 {
            return Err(invalid("The provider sent an oversized stream frame."));
        }
        Ok(frames)
    }
    pub fn finish(&mut self, ndjson: bool) -> Result<Vec<String>, ProviderError> {
        if self.buffer.iter().all(u8::is_ascii_whitespace) {
            return Ok(vec![]);
        }
        if ndjson {
            self.push(b"\n", true)
        } else {
            Err(invalid("The provider stream ended inside an event."))
        }
    }
}
fn invalid(message: &str) -> ProviderError {
    ProviderError::new("invalidResponse", message)
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum ResponsePart {
    Text {
        text: String,
    },
    Reasoning {
        text: String,
    },
    Tool {
        #[serde(rename = "invocationId")]
        invocation_id: String,
    },
}
impl ResponsePart {
    pub fn text(&self) -> &str {
        match self {
            Self::Text { text } | Self::Reasoning { text } => text,
            Self::Tool { .. } => "",
        }
    }
}

/// Only readable provider output crosses the display boundary. Opaque
/// reasoning signatures/encrypted content remain in native continuation.
pub fn visible_parts(value: &Value) -> Vec<ResponsePart> {
    fn visit(value: &Value, out: &mut Vec<ResponsePart>) {
        if let Some(items) = value.as_array() {
            for item in items {
                visit(item, out);
            }
            return;
        }
        if !value.is_object() {
            return;
        }
        let kind = value["type"].as_str().unwrap_or_default();
        match kind {
            "reasoning" => {
                visit(&value["summary"], out);
                visit(&value["content"], out);
            }
            "thinking" => {
                if let Some(text) = value["thinking"].as_str() {
                    out.push(ResponsePart::Reasoning { text: text.into() });
                }
            }
            "reasoning_text" | "summary_text" | "reasoning.text" => {
                if let Some(text) = value["text"].as_str() {
                    out.push(ResponsePart::Reasoning { text: text.into() });
                }
            }
            "reasoning.summary" => {
                if let Some(text) = value["summary"].as_str() {
                    out.push(ResponsePart::Reasoning { text: text.into() });
                }
            }
            "redacted_thinking"
            | "reasoning.encrypted"
            | "function_call"
            | "tool_use"
            | "tool_result" => {}
            "refusal" => {
                if let Some(text) = value["refusal"].as_str() {
                    out.push(ResponsePart::Text { text: text.into() });
                }
            }
            "message" => visit(&value["content"], out),
            _ => {
                if let Some(text) = reasoning_text(value) {
                    out.push(ResponsePart::Reasoning { text: text.into() });
                } else {
                    visit(&value["reasoning_details"], out);
                }
                if let Some(text) = value["text"].as_str() {
                    out.push(if value["thought"] == true {
                        ResponsePart::Reasoning { text: text.into() }
                    } else {
                        ResponsePart::Text { text: text.into() }
                    });
                }
                if let Some(text) = value["content"].as_str() {
                    out.push(ResponsePart::Text { text: text.into() });
                } else if value["content"].is_array() {
                    visit(&value["content"], out);
                }
            }
        }
    }
    let mut parts = Vec::new();
    visit(value, &mut parts);
    parts.retain(|p| !p.text().is_empty());
    parts
}
fn reasoning_text(value: &Value) -> Option<&str> {
    ["reasoning_content", "reasoning", "thinking"]
        .iter()
        .find_map(|key| value[key].as_str().filter(|s| !s.is_empty()))
}

// Only unsigned text fragments can be joined. Signed parts, function calls,
// and unfamiliar metadata must retain their original boundaries for replay.
fn gemini_text_kind(part: &Value) -> Option<bool> {
    let fields = part.as_object()?;
    if !part["text"].is_string()
        || fields
            .keys()
            .any(|key| !matches!(key.as_str(), "text" | "thought"))
    {
        return None;
    }
    match fields.get("thought") {
        None => Some(false),
        Some(value) => value.as_bool(),
    }
}

#[derive(Default)]
pub struct Completion {
    pub text: String,
    pub output: Vec<ResponsePart>,
    pub done: bool,
    pub finish: Option<String>,
    pub usage: Option<Value>,
    pub request_id: Option<String>,
    pub native: Vec<Value>,
}
impl Completion {
    fn visible(&mut self, text: &str, reasoning: bool) {
        if text.is_empty() {
            return;
        }
        if !reasoning {
            self.text.push_str(text);
        }
        match (self.output.last_mut(), reasoning) {
            (Some(ResponsePart::Text { text: prior }), false)
            | (Some(ResponsePart::Reasoning { text: prior }), true) => prior.push_str(text),
            (_, true) => self
                .output
                .push(ResponsePart::Reasoning { text: text.into() }),
            (_, false) => self.output.push(ResponsePart::Text { text: text.into() }),
        }
    }
    pub fn visible_len(&self) -> usize {
        self.output.iter().map(|p| p.text().len()).sum()
    }
    pub fn accept(
        &mut self,
        protocol: Protocol,
        native_openai: bool,
        data: &str,
    ) -> Result<(), ProviderError> {
        if data == "[DONE]" {
            self.done = true;
            return Ok(());
        }
        let v: Value = serde_json::from_str(data)
            .map_err(|_| invalid("The provider sent an unreadable stream event."))?;
        if v.get("error").is_some_and(|e| !e.is_null())
            || v["type"] == "error"
            || v["type"] == "response.failed"
        {
            return Err(ProviderError::new("generationFailed", "The provider could not complete this response. Check the model, account limits, and connection, then retry."));
        }
        if let Some(id) = v.get("id").and_then(Value::as_str) {
            self.request_id = Some(id.to_owned());
        }
        match protocol {
            Protocol::Openai if native_openai => match v["type"].as_str().unwrap_or("") {
                "response.output_item.done" => self.native.push(v["item"].clone()),
                "response.output_text.delta" | "response.refusal.delta" => {
                    self.visible(v["delta"].as_str().unwrap_or(""), false)
                }
                "response.reasoning_summary_text.delta" | "response.reasoning_text.delta" => {
                    self.visible(v["delta"].as_str().unwrap_or(""), true)
                }
                "response.completed" | "response.incomplete" => {
                    self.done = true;
                    self.finish = Some(
                        if v["type"] == "response.incomplete" {
                            "length"
                        } else {
                            "stop"
                        }
                        .into(),
                    );
                    if let Some(items) = v["response"]["output"].as_array() {
                        self.native = items.clone();
                        let parts = visible_parts(&v["response"]["output"]);
                        if !parts.is_empty() {
                            self.text = parts
                                .iter()
                                .filter_map(|p| {
                                    if let ResponsePart::Text { text } = p {
                                        Some(text.as_str())
                                    } else {
                                        None
                                    }
                                })
                                .collect::<String>();
                            self.output = parts;
                        }
                    }
                    self.usage = Some(v["response"]["usage"].clone());
                    self.request_id = v["response"]["id"].as_str().map(str::to_owned);
                }
                _ => {}
            },
            Protocol::Openai => {
                if self.native.is_empty() {
                    self.native.push(json!({"role":"assistant","content":""}));
                }
                if let Some(calls) = v["choices"][0]["delta"]["tool_calls"].as_array() {
                    for call in calls {
                        let index = call["index"]
                            .as_u64()
                            .ok_or_else(|| invalid("Missing tool call index."))?
                            as usize;
                        if index >= 64 {
                            return Err(invalid("Too many tool calls."));
                        }
                        let target = self.native[0]
                            .as_object_mut()
                            .unwrap()
                            .entry("tool_calls")
                            .or_insert_with(|| json!([]))
                            .as_array_mut()
                            .unwrap();
                        if target.len() <= index {
                            target.resize_with(index + 1, || json!({"id":"","type":"function","function":{"name":"","arguments":""}}));
                        }
                        for (key, value) in [
                            ("id", &call["id"]),
                            ("name", &call["function"]["name"]),
                            ("arguments", &call["function"]["arguments"]),
                        ] {
                            if let Some(fragment) = value.as_str() {
                                let slot = if key == "id" {
                                    &mut target[index][key]
                                } else {
                                    &mut target[index]["function"][key]
                                };
                                let mut text = slot.as_str().unwrap_or_default().to_owned();
                                text.push_str(fragment);
                                *slot = json!(text);
                            }
                        }
                    }
                }
                let delta = &v["choices"][0]["delta"];
                self.visible(reasoning_text(delta).unwrap_or(""), true);
                if let Some(details) = delta["reasoning_details"].as_array() {
                    if reasoning_text(delta).is_none() {
                        for part in visible_parts(&delta["reasoning_details"]) {
                            self.visible(part.text(), true);
                        }
                    }
                    if !self.native[0]["reasoning_details"].is_array() {
                        self.native[0]["reasoning_details"] = json!([]);
                    }
                    let target = self.native[0]["reasoning_details"].as_array_mut().unwrap();
                    for detail in details {
                        let same = target.iter_mut().find(|prior| {
                            prior["type"] == detail["type"]
                                && ((!detail["id"].is_null() && prior["id"] == detail["id"])
                                    || (!detail["index"].is_null()
                                        && prior["index"] == detail["index"]))
                        });
                        if let Some(prior) = same {
                            if let Some(fields) = detail.as_object() {
                                for (key, value) in fields {
                                    if matches!(
                                        key.as_str(),
                                        "text" | "summary" | "signature" | "data"
                                    ) && value.is_string()
                                    {
                                        let mut joined =
                                            prior[key].as_str().unwrap_or_default().to_owned();
                                        joined.push_str(value.as_str().unwrap());
                                        prior[key] = json!(joined);
                                    } else {
                                        prior[key] = value.clone();
                                    }
                                }
                            }
                        } else {
                            target.push(detail.clone());
                        }
                    }
                }
                for key in ["reasoning_content", "reasoning", "thinking"] {
                    if let Some(fragment) = delta[key].as_str() {
                        let mut text = self.native[0][key].as_str().unwrap_or_default().to_owned();
                        text.push_str(fragment);
                        self.native[0][key] = json!(text);
                    }
                }
                if let Some(text) = delta["content"].as_str() {
                    self.visible(text, false);
                } else if delta["content"].is_array() {
                    for part in visible_parts(&json!({"content":delta["content"]})) {
                        self.visible(part.text(), matches!(part, ResponsePart::Reasoning { .. }));
                    }
                }
                self.visible(delta["refusal"].as_str().unwrap_or(""), false);
                self.native[0]["content"] = json!(self.text);
                if let Some(reason) = v["choices"][0]["finish_reason"].as_str() {
                    self.finish = Some(reason.into());
                    self.done = true;
                }
                if let Some(usage) = v
                    .get("usage")
                    .filter(|u| u.is_object())
                    .or_else(|| v.pointer("/x_groq/usage").filter(|u| u.is_object()))
                {
                    crate::usage::merge(&mut self.usage, usage);
                }
            }
            Protocol::Anthropic => match v["type"].as_str().unwrap_or("") {
                "message_start" => {
                    crate::usage::merge(&mut self.usage, &v["message"]["usage"]);
                    self.request_id = v["message"]["id"].as_str().map(str::to_owned);
                }
                "content_block_start" => {
                    let i = v["index"].as_u64().unwrap_or(0) as usize;
                    if i > 1024 {
                        return Err(invalid("Too many response blocks."));
                    }
                    self.native.resize(i + 1, Value::Null);
                    self.native[i] = v["content_block"].clone();
                    self.visible(v["content_block"]["text"].as_str().unwrap_or(""), false);
                    self.visible(v["content_block"]["thinking"].as_str().unwrap_or(""), true);
                }
                "content_block_delta" => {
                    let delta = &v["delta"];
                    let field = match delta["type"].as_str().unwrap_or("") {
                        "text_delta" => "text",
                        "thinking_delta" => "thinking",
                        "signature_delta" => "signature",
                        "input_json_delta" => "_arguments",
                        _ => "",
                    };
                    if field == "text" {
                        self.visible(delta[field].as_str().unwrap_or(""), false);
                    } else if field == "thinking" {
                        self.visible(delta[field].as_str().unwrap_or(""), true);
                    }
                    if !field.is_empty() {
                        if let Some(block) = self
                            .native
                            .get_mut(v["index"].as_u64().unwrap_or(0) as usize)
                        {
                            let mut s = block[field].as_str().unwrap_or("").to_owned();
                            s.push_str(
                                delta[if field == "_arguments" {
                                    "partial_json"
                                } else {
                                    field
                                }]
                                .as_str()
                                .unwrap_or(""),
                            );
                            block[field] = json!(s);
                        }
                    }
                }
                "message_delta" => {
                    self.finish = v["delta"]["stop_reason"].as_str().map(str::to_owned);
                    crate::usage::merge(&mut self.usage, &v["usage"]);
                }
                "content_block_stop" => {
                    if let Some(block) = self
                        .native
                        .get_mut(v["index"].as_u64().unwrap_or(0) as usize)
                    {
                        if let Some(arguments) =
                            block.as_object_mut().and_then(|b| b.remove("_arguments"))
                        {
                            block["input"] =
                                serde_json::from_str(arguments.as_str().unwrap_or_default())
                                    .map_err(|_| invalid("Incomplete tool arguments."))?;
                        }
                    }
                }
                "message_stop" => self.done = true,
                _ => {}
            },
            Protocol::Gemini => {
                if let Some(parts) = v["candidates"][0]["content"]["parts"].as_array() {
                    for part in parts {
                        self.visible(part["text"].as_str().unwrap_or(""), part["thought"] == true);
                        if let Some(previous) = self.native.last_mut().filter(|previous| {
                            gemini_text_kind(part).is_some()
                                && gemini_text_kind(previous) == gemini_text_kind(part)
                        }) {
                            if let Value::String(text) = &mut previous["text"] {
                                text.push_str(part["text"].as_str().unwrap());
                            }
                        } else {
                            self.native.push(part.clone());
                        }
                    }
                }
                if let Some(reason) = v["candidates"][0]["finishReason"].as_str() {
                    self.done = true;
                    self.finish = Some(reason.into());
                }
                if v["promptFeedback"].get("blockReason").is_some() {
                    return Err(ProviderError::new(
                        "contentBlocked",
                        "The provider declined this request.",
                    ));
                }
                if v["usageMetadata"].is_object() {
                    crate::usage::merge(&mut self.usage, &v["usageMetadata"]);
                }
            }
            Protocol::Ollama => {
                if self.native.is_empty() {
                    self.native.push(
                        json!({"role":"assistant","content":"","thinking":"","tool_calls":[]}),
                    );
                }
                if let Some(calls) = v["message"]["tool_calls"].as_array() {
                    self.native[0]["tool_calls"]
                        .as_array_mut()
                        .unwrap()
                        .extend(calls.iter().cloned());
                }
                let mut thinking = self.native[0]["thinking"]
                    .as_str()
                    .unwrap_or_default()
                    .to_owned();
                thinking.push_str(v["message"]["thinking"].as_str().unwrap_or_default());
                self.native[0]["thinking"] = json!(thinking);
                self.visible(v["message"]["thinking"].as_str().unwrap_or(""), true);
                self.visible(v["message"]["content"].as_str().unwrap_or(""), false);
                self.native[0]["content"] = json!(self.text);
                if v["done"] == true {
                    self.done = true;
                    self.finish = v["done_reason"].as_str().map(str::to_owned);
                    self.usage = Some(
                        json!({"input_tokens":v["prompt_eval_count"],"output_tokens":v["eval_count"]}),
                    );
                }
            }
        }
        if self.text.len() > 8 * 1024 * 1024
            || self.visible_len() > 8 * 1024 * 1024
            || self.output.len() > 1024
            || self.native.len() > 1024
            || self
                .native
                .iter()
                .map(|v| v.to_string().len())
                .sum::<usize>()
                > 8 * 1024 * 1024
        {
            return Err(invalid("The response exceeded the safe size limit."));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn compatible_text_continuation_omits_empty_calls_in_new_and_saved_messages() {
        let mut completion = Completion::default();
        for delta in [
            json!({"role":"assistant"}),
            json!({"content":"Hello"}),
            json!({"tool_calls":[]}),
        ] {
            completion
                .accept(
                    Protocol::Openai,
                    false,
                    &json!({"choices":[{"delta":delta}]}).to_string(),
                )
                .unwrap();
        }
        completion
            .accept(
                Protocol::Openai,
                false,
                r#"{"choices":[{"delta":{},"finish_reason":"stop"}]}"#,
            )
            .unwrap();
        let message = completion.assistant_message(Protocol::Openai, false);
        assert!(message.native.as_ref().unwrap().get("tool_calls").is_none());
        assert!(completion
            .tool_calls(Protocol::Openai, false)
            .unwrap()
            .is_empty());
        let saved = ChatMessage {
            role: "assistant".into(),
            text: "Saved answer".into(),
            native: Some(
                json!({"role":"assistant","content":"Saved answer","tool_calls":[],"reasoning_content":"Keep this"}),
            ),
        };
        let (_, body) = request(
            Protocol::Openai,
            false,
            "https://example.com/v1",
            "model",
            "System",
            &[message, saved.clone()],
            512,
        );
        for message in body["messages"].as_array().unwrap().iter().skip(1) {
            assert!(message.get("tool_calls").is_none());
        }
        assert_eq!(body["messages"][1]["content"], "Hello");
        assert_eq!(body["messages"][2]["reasoning_content"], "Keep this");
        assert_eq!(saved.native.unwrap()["tool_calls"], json!([]));
    }
    #[test]
    fn gemini_fragmentation_does_not_consume_the_native_block_budget() {
        let mut completion = Completion::default();
        for (thought, text) in [(true, "r"), (false, "x")] {
            let frame =
                json!({"candidates":[{"content":{"parts":[{"text":text,"thought":thought}]}}]})
                    .to_string();
            for _ in 0..1025 {
                completion.accept(Protocol::Gemini, false, &frame).unwrap();
            }
        }
        completion
            .accept(
                Protocol::Gemini,
                false,
                r#"{"candidates":[{"finishReason":"STOP"}]}"#,
            )
            .unwrap();
        assert_eq!(
            completion.native,
            vec![
                json!({"text":"r".repeat(1025),"thought":true}),
                json!({"text":"x".repeat(1025),"thought":false})
            ]
        );
        assert_eq!(completion.text, "x".repeat(1025));
        let (_, body) = request(
            Protocol::Gemini,
            false,
            "https://example.com",
            "model",
            "System",
            &[completion.assistant_message(Protocol::Gemini, false)],
            512,
        );
        assert_eq!(body["contents"][0]["parts"], json!(completion.native));
    }
    #[test]
    fn gemini_coalescing_preserves_signatures_calls_and_other_metadata() {
        let parts = vec![
            json!({"text":"First "}),
            json!({"text":"answer"}),
            json!({"text":"signed","thoughtSignature":"one"}),
            json!({"text":"signed again","thoughtSignature":"one"}),
            json!({"text":"","thoughtSignature":"final"}),
            json!({"functionCall":{"id":"call","name":"read_file","args":{"path":"a"}},"thoughtSignature":"call-signature"}),
            json!({"text":"After "}),
            json!({"text":"call"}),
            json!({"text":"metadata","custom":"keep"}),
            json!({"text":"metadata","custom":"keep"}),
        ];
        let mut completion = Completion::default();
        for part in &parts {
            completion
                .accept(
                    Protocol::Gemini,
                    false,
                    &json!({"candidates":[{"content":{"parts":[part]}}]}).to_string(),
                )
                .unwrap();
        }
        completion
            .accept(
                Protocol::Gemini,
                false,
                r#"{"candidates":[{"finishReason":"STOP"}]}"#,
            )
            .unwrap();
        assert_eq!(
            completion.native,
            vec![
                json!({"text":"First answer"}),
                parts[2].clone(),
                parts[3].clone(),
                parts[4].clone(),
                parts[5].clone(),
                json!({"text":"After call"}),
                parts[8].clone(),
                parts[9].clone()
            ]
        );
        assert_eq!(
            completion.tool_calls(Protocol::Gemini, false).unwrap()[0].id,
            "call"
        );
    }
    #[test]
    fn gemini_still_limits_distinct_native_blocks_and_response_bytes() {
        let mut completion = Completion::default();
        let frame =
            json!({"candidates":[{"content":{"parts":[{"text":"","thoughtSignature":"opaque"}]}}]})
                .to_string();
        for _ in 0..1024 {
            completion.accept(Protocol::Gemini, false, &frame).unwrap();
        }
        assert!(completion.accept(Protocol::Gemini, false, &frame).is_err());
        let mut completion = Completion::default();
        let frame = json!({"candidates":[{"content":{"parts":[{"text":"x".repeat(512 * 1024)}]}}]})
            .to_string();
        for _ in 0..15 {
            completion.accept(Protocol::Gemini, false, &frame).unwrap();
        }
        assert!(completion.accept(Protocol::Gemini, false, &frame).is_err());
    }
    #[test]
    fn provider_reasoning_is_readable_but_opaque_state_stays_native() {
        let cases = [
            (
                Protocol::Openai,
                false,
                vec![
                    json!({"choices":[{"delta":{"reasoning_content":"Check files first."}}]}),
                    json!({"choices":[{"delta":{"content":"Here is the answer."},"finish_reason":"stop"}]}),
                ],
            ),
            (
                Protocol::Anthropic,
                false,
                vec![
                    json!({"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}),
                    json!({"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Check files first."}}),
                    json!({"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"secret-signature"}}),
                    json!({"type":"content_block_start","index":1,"content_block":{"type":"text","text":"Here is the answer."}}),
                ],
            ),
            (
                Protocol::Gemini,
                false,
                vec![
                    json!({"candidates":[{"content":{"parts":[{"thought":true,"text":"Check files first.","thoughtSignature":"secret-signature"},{"text":"Here is the answer."}]},"finishReason":"STOP"}]}),
                ],
            ),
            (
                Protocol::Ollama,
                false,
                vec![
                    json!({"message":{"thinking":"Check files first.","content":"Here is the answer."},"done":true}),
                ],
            ),
        ];
        for (protocol, native, frames) in cases {
            let mut completion = Completion::default();
            for frame in frames {
                completion
                    .accept(protocol, native, &frame.to_string())
                    .unwrap();
            }
            assert_eq!(completion.text, "Here is the answer.");
            assert_eq!(
                completion.output,
                vec![
                    ResponsePart::Reasoning {
                        text: "Check files first.".into()
                    },
                    ResponsePart::Text {
                        text: "Here is the answer.".into()
                    }
                ]
            );
            assert!(!serde_json::to_string(&completion.output)
                .unwrap()
                .contains("secret-signature"));
            assert_eq!(
                visible_parts(&serde_json::to_value(&completion.native).unwrap()),
                completion.output
            );
        }
    }
    #[test]
    fn responses_final_snapshot_reconciles_text_and_summary_without_duplicates() {
        let mut c = Completion::default();
        c.accept(
            Protocol::Openai,
            true,
            r#"{"type":"response.reasoning_summary_text.delta","delta":"Check files first."}"#,
        )
        .unwrap();
        c.accept(
            Protocol::Openai,
            true,
            r#"{"type":"response.output_text.delta","delta":"Here"}"#,
        )
        .unwrap();
        c.accept(Protocol::Openai,true,&json!({"type":"response.completed","response":{"output":[{"type":"reasoning","summary":[{"type":"summary_text","text":"Check files first."}],"encrypted_content":"opaque"},{"type":"message","content":[{"type":"output_text","text":"Here is the answer."}]}]}}).to_string()).unwrap();
        assert_eq!(c.text, "Here is the answer.");
        assert_eq!(c.output.len(), 2);
        assert_eq!(c.output[0].text(), "Check files first.");
        assert!(!serde_json::to_string(&c.output).unwrap().contains("opaque"));
    }
    #[test]
    fn compatible_reasoning_details_are_accumulated_for_display_and_continuation() {
        let mut c = Completion::default();
        for text in ["First ", "read the folder."] {
            c.accept(Protocol::Openai,false,&json!({"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.text","index":0,"id":"r1","text":text}]}}]}).to_string()).unwrap();
        }
        c.accept(Protocol::Openai,false,&json!({"choices":[{"delta":{"reasoning_details":[{"type":"reasoning.encrypted","index":1,"data":"opaque"}],"content":"Answer"},"finish_reason":"stop"}]}).to_string()).unwrap();
        assert_eq!(c.output[0].text(), "First read the folder.");
        assert_eq!(
            c.native[0]["reasoning_details"][0]["text"],
            "First read the folder."
        );
        assert!(!serde_json::to_string(&c.output).unwrap().contains("opaque"));
    }
    #[test]
    fn mixed_sse_newline_styles_keep_event_boundaries() {
        let mut frames = Frames::default();
        assert_eq!(
            frames
                .push(b"data: one\r\n\r\ndata: two\n\n", false)
                .unwrap(),
            vec!["one", "two"]
        );
    }
    #[test]
    fn all_protocols_preserve_messages_and_use_text_only_requests() {
        let messages = [ChatMessage {
            role: "user".into(),
            text: "Hello".into(),
            native: None,
        }];
        for protocol in [
            Protocol::Openai,
            Protocol::Anthropic,
            Protocol::Gemini,
            Protocol::Ollama,
        ] {
            let (url, body) = request(
                protocol,
                false,
                "http://localhost:1234",
                "test-model",
                "System",
                &messages,
                512,
            );
            assert!(url.starts_with("http://localhost:1234/"));
            assert!(body.to_string().contains("Hello"));
            assert!(body.get("tools").is_none());
        }
        let (url, body) = request(
            Protocol::Openai,
            true,
            "https://api.openai.com/v1",
            "test",
            "System",
            &messages,
            512,
        );
        assert!(url.ends_with("/responses"));
        assert_eq!(body["store"], false);
    }
    #[test]
    fn native_anthropic_and_ollama_completion_markers_are_required() {
        let mut anthropic = Completion::default();
        anthropic.accept(Protocol::Anthropic,false,r#"{"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}"#).unwrap();
        anthropic.accept(Protocol::Anthropic,false,r#"{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}"#).unwrap();
        assert!(!anthropic.done);
        anthropic
            .accept(Protocol::Anthropic, false, r#"{"type":"message_stop"}"#)
            .unwrap();
        assert!(anthropic.done);
        assert_eq!(anthropic.native[0]["text"], "Hello");
        let mut ollama = Completion::default();
        ollama
            .accept(
                Protocol::Ollama,
                false,
                r#"{"message":{"content":"Hello","tool_calls":[]},"done":false}"#,
            )
            .unwrap();
        assert!(!ollama.done);
        ollama
            .accept(
                Protocol::Ollama,
                false,
                r#"{"message":{"content":""},"done":true,"done_reason":"stop","eval_count":4}"#,
            )
            .unwrap();
        assert!(ollama.done);
        assert_eq!(ollama.text, "Hello");
    }
    #[test]
    fn groq_streaming_usage_preserves_cache_counters() {
        let mut completion = Completion::default();
        completion.accept(Protocol::Openai, false, r#"{"choices":[],"x_groq":{"usage":{"prompt_tokens":100,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":80}}}}"#).unwrap();
        let usage = crate::usage::normalize(Protocol::Openai, completion.usage.as_ref());
        assert_eq!(usage["uncachedInputTokens"], 20);
        assert_eq!(usage["outputTokens"], 20);
        assert_eq!(usage["cacheReadTokens"], 80);
    }
    #[test]
    fn fragmented_utf8_and_crlf() {
        let mut f = Frames::default();
        let bytes = "data: {\"text\":\"नमस्ते\"}\r\n\r\n".as_bytes();
        let mut out = vec![];
        for b in bytes {
            out.extend(f.push(&[*b], false).unwrap());
        }
        assert_eq!(out, vec!["{\"text\":\"नमस्ते\"}"]);
    }
    #[test]
    fn detects_truncated_frames() {
        let mut f = Frames::default();
        f.push(b"data: {", false).unwrap();
        assert!(f.finish(false).is_err());
    }
    #[test]
    fn stream_error_is_not_success() {
        let mut c = Completion::default();
        assert!(c
            .accept(
                Protocol::Anthropic,
                false,
                r#"{"type":"error","error":{"type":"overloaded_error"}}"#
            )
            .is_err());
        assert!(!c.done);
    }
    #[test]
    fn native_metadata_preserved() {
        let mut c = Completion::default();
        c.accept(Protocol::Gemini,false,r#"{"candidates":[{"content":{"parts":[{"text":"Hello","thoughtSignature":"opaque"}]},"finishReason":"STOP"}]}"#).unwrap();
        assert_eq!(c.text, "Hello");
        assert_eq!(c.native[0]["thoughtSignature"], "opaque");
        assert!(c.done);
    }
}
