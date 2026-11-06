//! Provider-reported billing counters. Missing counters remain unknown.
use crate::Protocol;
use serde_json::{json, Value};

pub fn merge(previous: &mut Option<Value>, next: &Value) {
    let target = previous.get_or_insert(json!({}));
    for key in [
        "input_tokens",
        "prompt_tokens",
        "output_tokens",
        "completion_tokens",
        "cache_read_input_tokens",
        "cache_creation_input_tokens",
        "promptTokenCount",
        "candidatesTokenCount",
        "cachedContentTokenCount",
        "thoughtsTokenCount",
        "cost",
    ] {
        let valid = if key == "cost" {
            next[key].as_f64().is_some_and(|n| {
                n.is_finite() && n >= 0.0 && (n * 1_000_000.0).round() <= 9_007_199_254_740_991.0
            })
        } else {
            next[key]
                .as_u64()
                .is_some_and(|n| n <= 9_007_199_254_740_991)
        };
        if valid {
            target[key] = next[key].clone();
        }
    }
    for key in [
        "input_tokens_details",
        "prompt_tokens_details",
        "output_tokens_details",
        "completion_tokens_details",
        "cache_creation",
    ] {
        for field in [
            "cached_tokens",
            "reasoning_tokens",
            "ephemeral_5m_input_tokens",
            "ephemeral_1h_input_tokens",
        ] {
            if next[key][field]
                .as_u64()
                .is_some_and(|n| n <= 9_007_199_254_740_991)
            {
                target[key][field] = next[key][field].clone();
            }
        }
    }
}

pub fn normalize(protocol: Protocol, raw: Option<&Value>) -> Value {
    let empty = Value::Null;
    let v = raw.unwrap_or(&empty);
    let (input, output, cached, writes, reasoning) = match protocol {
        Protocol::Openai => (
            v["input_tokens"]
                .as_u64()
                .or_else(|| v["prompt_tokens"].as_u64()),
            v["output_tokens"]
                .as_u64()
                .or_else(|| v["completion_tokens"].as_u64()),
            v["input_tokens_details"]["cached_tokens"]
                .as_u64()
                .or_else(|| v["prompt_tokens_details"]["cached_tokens"].as_u64()),
            None,
            v["output_tokens_details"]["reasoning_tokens"]
                .as_u64()
                .or_else(|| v["completion_tokens_details"]["reasoning_tokens"].as_u64()),
        ),
        Protocol::Anthropic => (
            v["input_tokens"].as_u64(),
            v["output_tokens"].as_u64(),
            v["cache_read_input_tokens"].as_u64(),
            v["cache_creation_input_tokens"].as_u64(),
            None,
        ),
        Protocol::Gemini => (
            v["promptTokenCount"].as_u64(),
            v["candidatesTokenCount"].as_u64().and_then(|visible| {
                visible.checked_add(v["thoughtsTokenCount"].as_u64().unwrap_or(0))
            }),
            v["cachedContentTokenCount"].as_u64(),
            None,
            v["thoughtsTokenCount"].as_u64(),
        ),
        Protocol::Ollama => (
            v["input_tokens"].as_u64(),
            v["output_tokens"].as_u64(),
            None,
            None,
            None,
        ),
    };
    // Anthropic input_tokens excludes cache reads/writes. OpenAI/Gemini include reads.
    let uncached = if protocol == Protocol::Anthropic {
        input
    } else {
        input.zip(cached).map(|(i, c)| i.saturating_sub(c))
    };
    let cost = v["cost"]
        .as_f64()
        .filter(|n| n.is_finite() && *n >= 0.0)
        .map(|n| (n * 1_000_000.0).round())
        .filter(|n| n.is_finite() && *n <= 9_007_199_254_740_991.0)
        .map(|n| n as u64);
    json!({"costMicrousd":cost,"inputTokens":input,"outputTokens":output,"uncachedInputTokens":uncached,
        "cacheReadTokens":cached,"cacheWriteTokens":writes,"cacheWrite5mTokens":v["cache_creation"]["ephemeral_5m_input_tokens"].as_u64(),"cacheWrite1hTokens":v["cache_creation"]["ephemeral_1h_input_tokens"].as_u64(),"reasoningTokens":reasoning})
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn malformed_updates_do_not_erase_reported_usage() {
        let mut raw = None;
        merge(
            &mut raw,
            &json!({"prompt_tokens":100,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":80}}),
        );
        merge(
            &mut raw,
            &json!({"prompt_tokens":-1,"completion_tokens":1.5,"prompt_tokens_details":{"cached_tokens":9007199254740992u64}}),
        );
        let usage = normalize(Protocol::Openai, raw.as_ref());
        assert_eq!(usage["inputTokens"], 100);
        assert_eq!(usage["outputTokens"], 20);
        assert_eq!(usage["cacheReadTokens"], 80);
    }
    #[test]
    fn split_reports_keep_input_cost_and_late_cache_details() {
        let mut report = None;
        merge(&mut report, &json!({"prompt_tokens":100,"cost":0.002}));
        merge(
            &mut report,
            &json!({"prompt_tokens_details":{"cached_tokens":80},"completion_tokens":20}),
        );
        let normalized = normalize(Protocol::Openai, report.as_ref());
        assert_eq!(normalized["inputTokens"], 100);
        assert_eq!(normalized["uncachedInputTokens"], 20);
        assert_eq!(normalized["costMicrousd"], 2000);
    }
    #[test]
    fn gemini_counts_thinking_as_output_but_openai_does_not_add_it_twice() {
        let gemini = normalize(
            Protocol::Gemini,
            Some(&json!({"candidatesTokenCount":20,"thoughtsTokenCount":30})),
        );
        assert_eq!(gemini["outputTokens"], 50);
        assert_eq!(gemini["reasoningTokens"], 30);
        let openai = normalize(
            Protocol::Openai,
            Some(
                &json!({"completion_tokens":50,"completion_tokens_details":{"reasoning_tokens":30}}),
            ),
        );
        assert_eq!(openai["outputTokens"], 50);
    }
    #[test]
    fn provider_cost_is_optional_and_never_suppresses_tokens() {
        for (raw, expected) in [
            (json!({"prompt_tokens":12}), Value::Null),
            (json!({"prompt_tokens":12,"cost":0}), json!(0)),
            (json!({"prompt_tokens":12,"cost":0.00125}), json!(1250)),
            (json!({"prompt_tokens":12,"cost":-1}), Value::Null),
        ] {
            let usage = normalize(Protocol::Openai, Some(&raw));
            assert_eq!(usage["inputTokens"], 12);
            assert_eq!(usage["costMicrousd"], expected);
        }
    }
    #[test]
    fn billing_types_preserve_unknowns_and_provider_semantics() {
        let openai = normalize(
            Protocol::Openai,
            Some(
                &json!({"prompt_tokens":100,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":80}}),
            ),
        );
        assert_eq!(openai["uncachedInputTokens"], 20);
        let anthropic = normalize(
            Protocol::Anthropic,
            Some(
                &json!({"input_tokens":20,"cache_read_input_tokens":80,"cache_creation_input_tokens":10}),
            ),
        );
        assert_eq!(anthropic["uncachedInputTokens"], 20);
        assert_eq!(anthropic["cacheWriteTokens"], 10);
        assert!(normalize(Protocol::Openai, None)["inputTokens"].is_null());
        assert!(
            normalize(Protocol::Ollama, Some(&json!({"input_tokens":10})))["cacheReadTokens"]
                .is_null()
        );
    }
}
