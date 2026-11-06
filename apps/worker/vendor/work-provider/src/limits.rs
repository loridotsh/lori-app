//! Model capacities are metadata, not usage counters or guesses from names.
//! Provider schemas and published fallback sources: docs/WORK_MODEL_CONTEXT.md.
use crate::{ModelOption, ProviderDefinition, ProviderHttp, MAX_RESPONSE_BYTES};
use serde_json::{json, Value};

fn number(value: &Value) -> Option<u32> {
    value
        .as_u64()
        .and_then(|v| u32::try_from(v).ok())
        .filter(|v| *v > 0)
}
fn at(value: &Value, paths: &[&str]) -> Option<u32> {
    paths.iter().find_map(|p| value.pointer(p).and_then(number))
}
fn smaller(a: Option<u32>, b: Option<u32>) -> Option<u32> {
    match (a, b) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (a, b) => a.or(b),
    }
}

/// Read documented compatible-provider extensions without flattening separate
/// input/output limits into a single invented window.
pub fn apply(model: &mut ModelOption, value: &Value) {
    let total = at(
        value,
        &[
            "/context_length",
            "/context_window",
            "/max_context_length",
            "/max_model_len",
            "/contextLength",
            "/model_spec/availableContextTokens",
        ],
    );
    // A gateway can expose a smaller limit for its selected upstream route.
    let total = smaller(total, at(value, &["/top_provider/context_length"]));
    if let Some(total) = total {
        model.context_length = Some(total);
        model.context_source = Some("provider".into());
    }
    if let Some(input) = at(value, &["/max_input_tokens", "/inputTokenLimit"]) {
        if total.is_none() {
            model.context_length = None;
        }
        model.input_token_limit = Some(input);
        model.context_source = Some("provider".into());
    }
    if let Some(output) = at(
        value,
        &[
            "/max_output_tokens",
            "/max_completion_tokens",
            "/outputTokenLimit",
            "/max_tokens",
        ],
    ) {
        model.output_token_limit = Some(output);
    }
    model.output_token_limit = smaller(
        model.output_token_limit,
        at(value, &["/top_provider/max_completion_tokens"]),
    );
}

/// OpenAI's Models API has no context field. Exact, reviewed IDs only; never
/// apply a native-provider specification to an arbitrary gateway/fine-tune.
/// Verified 2026-10-02 against developers.openai.com/api/docs/models/<id>.
pub fn published_defaults(provider: &str, model: &mut ModelOption) {
    if provider != "openai" {
        return;
    }
    let (context, output) = match model.id.as_str() {
        "gpt-6-astra" | "gpt-6.1-sol" | "gpt-6-luna" => (1_050_000, 128_000),
        "gpt-4.1" | "gpt-4.1-mini" | "gpt-4.1-nano" => (1_047_576, 32_768),
        "gpt-5" | "gpt-5-mini" | "gpt-5-nano" => (400_000, 128_000),
        "gpt-4o" | "gpt-4o-mini" => (128_000, 16_384),
        _ => return,
    };
    if model.context_length.is_none() && model.input_token_limit.is_none() {
        model.context_length = Some(context);
        model.context_source = Some("published".into());
    }
    model.output_token_limit.get_or_insert(output);
}

fn decoded(
    response: Result<crate::HttpResponse, crate::ProviderError>,
    key: &str,
) -> Option<Value> {
    let response = response.ok()?;
    if !(200..300).contains(&response.status)
        || !response.json
        || response.body.len() > MAX_RESPONSE_BYTES
    {
        return None;
    }
    let value: Value = serde_json::from_slice(&response.body).ok()?;
    fn secret(v: &Value, key: &str) -> bool {
        match v {
            Value::String(s) => s.contains(key),
            Value::Array(a) => a.iter().any(|v| secret(v, key)),
            Value::Object(o) => o.iter().any(|(k, v)| k.contains(key) || secret(v, key)),
            _ => false,
        }
    }
    if !key.is_empty() && secret(&value, key) {
        return None;
    }
    Some(value)
}

fn model_entry<'a>(value: &'a Value, id: &str) -> Option<&'a Value> {
    let entries = value
        .get("data")
        .or_else(|| value.get("models"))
        .unwrap_or(value);
    if let Some(entries) = entries.as_array() {
        entries.iter().find(|v| {
            v["id"]
                .as_str()
                .or(v["name"].as_str())
                .or(v["model"].as_str())
                == Some(id)
        })
    } else if value["id"].as_str() == Some(id)
        || value["name"].as_str() == Some(id)
        || value["name"].as_str() == Some(format!("models/{id}").as_str())
    {
        Some(value)
    } else {
        None
    }
}

/// Best-effort, read-only enrichment for the selected model. All URLs stay on
/// the configured origin; no credentials or model IDs go to a third-party catalog.
pub fn resolve(
    http: &dyn ProviderHttp,
    definition: &ProviderDefinition,
    base: &str,
    key: &str,
    model: &mut ModelOption,
) {
    published_defaults(&definition.id, model);
    model.work_pricing = crate::pricing::resolve_published(
        &definition.id,
        &definition.base_url,
        base,
        &model.id,
        model.work_pricing.take(),
    );
    let headers = crate::discovery::headers(definition.protocol, key);
    let base = base.trim_end_matches('/');
    let encoded: String = url::form_urlencoded::byte_serialize(model.id.as_bytes()).collect();
    if definition.id == "ollama" {
        model.context_length = None;
        model.context_source = None;
        let mut running = None;
        if let Some(value) = decoded(http.get(&format!("{base}/api/ps"), &headers), key) {
            if let Some(entry) = model_entry(&value, &model.id) {
                if let Some(window) = at(entry, &["/context_length"]) {
                    running = Some(window);
                }
            }
        }
        if let Some(value) = decoded(
            http.post_json(
                &format!("{base}/api/show"),
                &headers,
                &json!({"model":model.id}),
            ),
            key,
        ) {
            let configured = value["parameters"].as_str().and_then(|p| {
                p.lines().find_map(|line| {
                    let mut parts = line.split_whitespace();
                    (parts.next() == Some("num_ctx"))
                        .then(|| {
                            parts
                                .next()
                                .and_then(|s| s.parse::<u32>().ok())
                                .filter(|v| *v > 0)
                        })
                        .flatten()
                })
            });
            let architecture = value["model_info"]["general.architecture"].as_str();
            let maximum = architecture
                .and_then(|a| value["model_info"].get(format!("{a}.context_length")))
                .and_then(number);
            model.context_length = smaller(configured, maximum);
            model.context_source = model.context_length.map(|_| {
                if configured.is_some() {
                    "configured"
                } else {
                    "modelMaximum"
                }
                .into()
            });
        }
        // A small window allocated by Lori for an earlier short request must
        // not become a permanent cap on later requests. Explicit Modelfile
        // limits win; otherwise grow allocations within the model maximum.
        if model.context_length.is_none() {
            model.context_length = running;
            model.context_source = running.map(|_| "configured".into());
        }
        return;
    }
    if definition.id == "lmstudio" {
        model.context_length = None;
        model.context_source = None;
        // Preserve reverse-proxy prefixes, replacing only the final /v1.
        let Some(root) = base.strip_suffix("/v1") else {
            return;
        };
        if let Some(value) = decoded(http.get(&format!("{root}/api/v1/models"), &headers), key) {
            if let Some(models) = value["models"].as_array() {
                for entry in models {
                    if let Some(instances) = entry["loaded_instances"].as_array() {
                        let windows = instances
                            .iter()
                            .filter(|v| {
                                v["id"].as_str() == Some(&model.id)
                                    || entry["key"].as_str() == Some(&model.id)
                            })
                            .filter_map(|v| at(v, &["/config/context_length"]));
                        if let Some(window) = windows.min() {
                            model.context_length = Some(window);
                            model.context_source = Some("configured".into());
                            return;
                        }
                    }
                }
            }
        }
        // Older LM Studio servers expose the same distinction through v0.
        if let Some(value) = decoded(
            http.get(&format!("{root}/api/v0/models/{encoded}"), &headers),
            key,
        ) {
            if model_entry(&value, &model.id).is_some() {
                if let Some(window) = at(&value, &["/loaded_context_length"]) {
                    model.context_length = Some(window);
                    model.context_source = Some("configured".into());
                }
            }
        }
        return;
    }
    let endpoint = match definition.id.as_str() {
        "openai" => return,
        "anthropic" => format!("{base}/v1/models/{encoded}"),
        "google" | "groq" | "mistral" => format!("{base}/models/{encoded}"),
        "openrouter" | "together" | "venice" | "akashml" | "vllm" => format!("{base}/models"),
        "fireworks" => {
            let parts: Vec<_> = model.id.split('/').collect();
            if parts.len() != 4
                || parts[0] != "accounts"
                || parts[2] != "models"
                || parts
                    .iter()
                    .any(|p| p.is_empty() || *p == "." || *p == "..")
            {
                return;
            }
            let Some(root) = base.strip_suffix("/inference/v1") else {
                return;
            };
            format!(
                "{root}/v1/{}",
                parts
                    .iter()
                    .map(|p| url::form_urlencoded::byte_serialize(p.as_bytes()).collect::<String>())
                    .collect::<Vec<_>>()
                    .join("/")
            )
        }
        _ => return,
    };
    if let Some(value) = decoded(http.get(&endpoint, &headers), key) {
        if let Some(entry) = model_entry(&value, &model.id) {
            apply(model, entry);
            if model
                .work_pricing
                .as_ref()
                .and_then(|p| p["source"].as_str())
                != Some("configured")
            {
                model.work_pricing = crate::pricing::metadata(&definition.id, entry)
                    .or_else(|| model.work_pricing.clone());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{collections::VecDeque, sync::Mutex};
    struct Http {
        values: Mutex<VecDeque<Value>>,
        calls: Mutex<Vec<(String, Option<Value>)>>,
    }
    impl Http {
        fn new(values: Vec<Value>) -> Self {
            Self {
                values: Mutex::new(values.into()),
                calls: Mutex::new(vec![]),
            }
        }
        fn reply(
            &self,
            url: &str,
            body: Option<Value>,
        ) -> Result<crate::HttpResponse, crate::ProviderError> {
            self.calls.lock().unwrap().push((url.into(), body));
            Ok(crate::HttpResponse {
                status: 200,
                json: true,
                retry_after_seconds: None,
                body: self
                    .values
                    .lock()
                    .unwrap()
                    .pop_front()
                    .unwrap()
                    .to_string()
                    .into_bytes(),
            })
        }
    }
    impl ProviderHttp for Http {
        fn get(
            &self,
            url: &str,
            _: &[(String, String)],
        ) -> Result<crate::HttpResponse, crate::ProviderError> {
            self.reply(url, None)
        }
        fn post_json(
            &self,
            url: &str,
            _: &[(String, String)],
            body: &Value,
        ) -> Result<crate::HttpResponse, crate::ProviderError> {
            self.reply(url, Some(body.clone()))
        }
    }
    #[test]
    fn compatible_provider_shapes_keep_real_limits_and_ignore_invalid_values() {
        for value in [
            json!({"context_window":1_000_000}),
            json!({"max_context_length":1_000_000}),
            json!({"max_model_len":1_000_000}),
            json!({"model_spec":{"availableContextTokens":1_000_000}}),
            json!({"contextLength":1_000_000}),
        ] {
            let mut model = ModelOption::manual("model").unwrap();
            apply(&mut model, &value);
            assert_eq!(model.context_length, Some(1_000_000));
        }
        let mut model = ModelOption::manual("model").unwrap();
        apply(
            &mut model,
            &json!({"context_length":1_000_000,"top_provider":{"context_length":200000,"max_completion_tokens":8192},"max_completion_tokens":32000}),
        );
        assert_eq!(model.context_length, Some(200000));
        assert_eq!(model.output_token_limit, Some(8192));
        let mut unknown = ModelOption::manual("model").unwrap();
        apply(
            &mut unknown,
            &json!({"context_length":0,"max_tokens":-1,"max_input_tokens":u64::MAX}),
        );
        assert!(unknown.context_length.is_none());
        assert!(unknown.output_token_limit.is_none());
        assert!(unknown.input_token_limit.is_none());
    }
    #[test]
    fn native_input_metadata_replaces_legacy_combined_window() {
        let mut model = ModelOption::manual("model").unwrap();
        model.context_length = Some(8192);
        apply(
            &mut model,
            &json!({"inputTokenLimit":1_048_576,"outputTokenLimit":65536}),
        );
        assert_eq!(model.context_length, None);
        assert_eq!(model.input_token_limit, Some(1_048_576));
    }
    #[test]
    fn published_specs_are_exact_native_provider_fallbacks_only() {
        for (provider, id, expected) in [
            ("openai", "gpt-6-luna", Some(1_050_000)),
            ("custom", "gpt-6-luna", None),
            ("openai", "gpt-6-luna-custom", None),
            ("openai", "ft:gpt-4.1:org:test", None),
        ] {
            let mut model = ModelOption::manual(id).unwrap();
            published_defaults(provider, &mut model);
            assert_eq!(model.context_length, expected);
        }
        let mut model = ModelOption::manual("gpt-6-luna").unwrap();
        model.context_length = Some(500000);
        published_defaults("openai", &mut model);
        assert_eq!(model.context_length, Some(500000));
    }
    #[test]
    fn ollama_reads_configured_limits_without_capping_later_turns_to_an_old_allocation() {
        for configured in [false, true] {
            let http = Http::new(vec![
                json!({"models":[{"model":"local:latest","context_length":4096}]}),
                json!({"parameters":if configured{"num_ctx 32768\nstop x"}else{"stop x"},"model_info":{"general.architecture":"llama","llama.context_length":131072}}),
            ]);
            let mut model = ModelOption::manual("local:latest").unwrap();
            resolve(
                &http,
                &crate::definition("ollama").unwrap(),
                "http://localhost:11434/proxy",
                "",
                &mut model,
            );
            assert_eq!(
                model.context_length,
                Some(if configured { 32768 } else { 131072 })
            );
            assert_eq!(
                model.context_source.as_deref(),
                Some(if configured {
                    "configured"
                } else {
                    "modelMaximum"
                })
            );
            let calls = http.calls.lock().unwrap();
            assert_eq!(calls[1].0, "http://localhost:11434/proxy/api/show");
            assert_eq!(calls[1].1.as_ref().unwrap()["model"], "local:latest");
        }
    }
    #[test]
    fn lmstudio_uses_loaded_instance_capacity_and_preserves_proxy_prefix() {
        let http = Http::new(vec![
            json!({"models":[{"key":"downloaded","max_context_length":131072,"loaded_instances":[{"id":"my-alias","config":{"context_length":32768}}]}]}),
        ]);
        let mut model = ModelOption::manual("my-alias").unwrap();
        resolve(
            &http,
            &crate::definition("lmstudio").unwrap(),
            "http://localhost:1234/prefix/v1",
            "",
            &mut model,
        );
        assert_eq!(model.context_length, Some(32768));
        assert_eq!(
            http.calls.lock().unwrap()[0].0,
            "http://localhost:1234/prefix/api/v1/models"
        );
    }
    #[test]
    fn unrelated_models_and_credential_echoes_cannot_supply_limits() {
        for value in [
            json!({"data":[{"id":"other","context_length":1000000}]}),
            json!({"data":[{"id":"selected","context_length":1000000,"description":"private-key"}]}),
        ] {
            let http = Http::new(vec![value]);
            let mut model = ModelOption::manual("selected").unwrap();
            resolve(
                &http,
                &crate::definition("openrouter").unwrap(),
                "https://openrouter.ai/api/v1",
                "private-key",
                &mut model,
            );
            assert_eq!(model.context_length, None);
        }
    }
    #[test]
    fn fireworks_uses_same_origin_model_resource_and_rejects_traversal() {
        let http = Http::new(vec![
            json!({"name":"accounts/team/models/model","contextLength":262144}),
        ]);
        let mut model = ModelOption::manual("accounts/team/models/model").unwrap();
        resolve(
            &http,
            &crate::definition("fireworks").unwrap(),
            "https://api.fireworks.ai/inference/v1",
            "",
            &mut model,
        );
        assert_eq!(model.context_length, Some(262144));
        assert_eq!(
            http.calls.lock().unwrap()[0].0,
            "https://api.fireworks.ai/v1/accounts/team/models/model"
        );
        let mut invalid = ModelOption::manual("accounts/../models/model").unwrap();
        resolve(
            &http,
            &crate::definition("fireworks").unwrap(),
            "https://api.fireworks.ai/inference/v1",
            "",
            &mut invalid,
        );
        assert_eq!(http.calls.lock().unwrap().len(), 1);
    }
}
