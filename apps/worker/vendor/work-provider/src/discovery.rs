use crate::{
    AuthMode, CredentialStatus, DiscoveryStatus, ModelOption, Preparation, Protocol,
    ProviderDefinition, ProviderError, MAX_MODELS,
};
use rig_core::client::ModelListingClient;
use serde_json::Value;
use std::collections::HashSet;

pub const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const MAX_PAGES: usize = 50;

pub struct HttpResponse {
    pub status: u16,
    pub body: Vec<u8>,
    pub json: bool,
    pub retry_after_seconds: Option<u64>,
}
pub trait ProviderHttp: Send + Sync {
    /// Implementors must validate the destination, bound the body and enforce a deadline.
    fn get(&self, url: &str, headers: &[(String, String)]) -> Result<HttpResponse, ProviderError>;
    fn post_json(
        &self,
        _url: &str,
        _headers: &[(String, String)],
        _body: &Value,
    ) -> Result<HttpResponse, ProviderError> {
        Err(ProviderError::new(
            "discoveryUnsupported",
            "This transport cannot read model details.",
        ))
    }
}

pub fn http_error(response: &HttpResponse) -> ProviderError {
    let body: Value = serde_json::from_slice(&response.body).unwrap_or(Value::Null);
    let provider_code = body
        .pointer("/error/code")
        .or_else(|| body.pointer("/error/type"))
        .and_then(Value::as_str)
        .unwrap_or("");
    let invalid_google_key = body
        .pointer("/error/details")
        .and_then(Value::as_array)
        .is_some_and(|details| {
            details.iter().any(|detail| {
                detail.get("reason").and_then(Value::as_str) == Some("API_KEY_INVALID")
            })
        });
    if invalid_google_key {
        return ProviderError::new(
            "invalidCredential",
            "The provider rejected this API key. Check it and try again.",
        );
    }
    let mut error = match (response.status, provider_code) {
        (_, "insufficient_quota" | "billing_hard_limit_reached") => ProviderError::new("quotaExceeded", "The provider reports no available quota. Check the account's billing and limits."),
        (401, _) => ProviderError::new("invalidCredential", "The provider rejected this API key. Check it and try again."),
        (403, _) => ProviderError::new("permissionDenied", "This key cannot access the required endpoint. Check its permissions and account restrictions."),
        (404 | 405, _) => ProviderError::new("discoveryUnsupported", "This endpoint does not support model discovery."),
        (429, _) => ProviderError::transient("rateLimited", "The provider is rate limiting requests. Wait and try again."),
        (500..=599, _) => ProviderError::transient("providerUnavailable", "The provider is temporarily unavailable. Try again shortly."),
        (300..=399, _) => ProviderError::new("invalidEndpoint", "The provider redirected this request. Enter the final API base URL."),
        _ => ProviderError::new("providerRequestFailed", "The provider could not complete this request. Check the endpoint and account settings."),
    };
    error.retry_after_seconds = response.retry_after_seconds;
    error
}

fn is_success(response: &HttpResponse) -> bool {
    (200..300).contains(&response.status)
}
pub(crate) fn headers(protocol: Protocol, key: &str) -> Vec<(String, String)> {
    let mut out = vec![("accept".into(), "application/json".into())];
    if protocol == Protocol::Anthropic {
        out.push(("anthropic-version".into(), "2023-06-01".into()));
    }
    if !key.is_empty() {
        out.push(match protocol {
            Protocol::Anthropic => ("x-api-key".into(), key.into()),
            Protocol::Gemini => ("x-goog-api-key".into(), key.into()),
            _ => ("authorization".into(), format!("Bearer {key}")),
        });
    }
    out
}

pub async fn prepare(
    http: &dyn ProviderHttp,
    definition: &ProviderDefinition,
    base: &str,
    auth: AuthMode,
    key: &str,
) -> Preparation {
    let failed = |error: ProviderError| Preparation {
        credential_status: if error.code == "invalidCredential" {
            CredentialStatus::Rejected
        } else {
            CredentialStatus::Unverifiable
        },
        discovery_status: DiscoveryStatus::Failed,
        models: vec![],
        error: Some(error),
    };
    if definition.subscription {
        return failed(ProviderError::new(
            "subscriptionUnavailable",
            "Subscription connections are not available yet.",
        ));
    }
    if auth == AuthMode::None && !definition.allows_keyless {
        return failed(ProviderError::new(
            "missingCredential",
            "An API key is required for this provider.",
        ));
    }
    if auth == AuthMode::ApiKey
        && (key.is_empty() || key.len() > 8192 || key.chars().any(char::is_control))
    {
        return failed(ProviderError::new(
            "invalidCredential",
            "Enter a valid API key without line breaks.",
        ));
    }
    let endpoint = match definition.protocol {
        Protocol::Anthropic => format!("{base}/v1/models?limit=100"),
        Protocol::Gemini => format!("{base}/models?pageSize=1000"),
        Protocol::Ollama => format!("{base}/api/tags"),
        Protocol::Openai => format!("{base}/models"),
    };
    let request_headers = headers(definition.protocol, key);
    let mut independently_verified = false;
    if matches!(definition.id.as_str(), "openrouter" | "venice") {
        let validation_path = if definition.id == "venice" {
            "api_keys/rate_limits"
        } else {
            "key"
        };
        match http.get(&format!("{base}/{validation_path}"), &request_headers) {
            Ok(r)
                if is_success(&r)
                    && r.json
                    && serde_json::from_slice::<Value>(&r.body)
                        .ok()
                        .and_then(|v| v.get("data").cloned())
                        .is_some_and(|v| v.is_object()) =>
            {
                independently_verified = true
            }
            Ok(r) if !is_success(&r) => return failed(http_error(&r)),
            Ok(_) => {
                return failed(ProviderError::new(
                    "invalidResponse",
                    "The provider returned an unexpected key-validation response.",
                ))
            }
            Err(e) => return failed(e),
        }
    }
    // Unknown/custom and local gateways may expose a public catalog. Prove that
    // the endpoint rejects both no key and an intentionally invalid key before
    // attributing its successful response to the supplied credential.
    if auth == AuthMode::ApiKey && (definition.id == "custom" || definition.local) {
        for probe_key in ["", "lori-invalid-key-validation-probe"] {
            match http.get(&endpoint, &headers(definition.protocol, probe_key)) {
                Ok(r) if matches!(r.status, 401 | 403) => {}
                Ok(_) => {
                    return failed(ProviderError::new(
                        "credentialVerificationUnavailable",
                        if definition.allows_keyless {
                            "This endpoint does not expose a reliable API-key check. Use an authenticated endpoint, or select No API key if the server is intentionally keyless."
                        } else {
                            "This endpoint does not expose a reliable API-key check. Use an authenticated endpoint that rejects missing and invalid keys."
                        },
                    ))
                }
                Err(e) => return failed(e),
            }
        }
    }
    let first = match http.get(&endpoint, &request_headers) {
        Ok(r) if is_success(&r) && r.json => r,
        Ok(r) if !is_success(&r) => {
            let error = http_error(&r);
            if independently_verified && !matches!(r.status, 401 | 403) {
                return Preparation {
                    credential_status: CredentialStatus::Verified,
                    discovery_status: DiscoveryStatus::Failed,
                    models: vec![],
                    error: Some(error),
                };
            }
            return failed(error);
        }
        Ok(_) => {
            return failed(ProviderError::new(
                "invalidResponse",
                "The URL returned a webpage instead of a model API. Check the API base URL.",
            ))
        }
        Err(e) if independently_verified => {
            return Preparation {
                credential_status: CredentialStatus::Verified,
                discovery_status: DiscoveryStatus::Failed,
                models: vec![],
                error: Some(e),
            }
        }
        Err(e) => return failed(e),
    };
    let first = if definition.id == "together" {
        match serde_json::from_slice::<Value>(&first.body) {
            Ok(value) if value.is_array() => HttpResponse {
                body: serde_json::to_vec(&serde_json::json!({ "data": value })).unwrap_or_default(),
                ..first
            },
            _ => first,
        }
    } else {
        first
    };
    if !key.is_empty() && String::from_utf8_lossy(&first.body).contains(key) {
        return Preparation { credential_status: CredentialStatus::Verified, discovery_status: DiscoveryStatus::Failed, models: vec![], error: Some(ProviderError::new("unsafeResponse", "The provider returned credential data in its model list. Enter model IDs manually instead.")) };
    }
    let result = discover(
        http,
        definition.protocol,
        &definition.id,
        base,
        &request_headers,
        first,
        key,
    )
    .await;
    match result {
        Ok(mut models) => {
            for model in &mut models {
                crate::limits::published_defaults(&definition.id, model);
                model.work_pricing = crate::pricing::resolve_published(
                    &definition.id,
                    &definition.base_url,
                    base,
                    &model.id,
                    model.work_pricing.take(),
                );
            }
            Preparation {
                credential_status: if auth == AuthMode::None {
                    CredentialStatus::NotRequired
                } else {
                    CredentialStatus::Verified
                },
                discovery_status: if models.is_empty() {
                    DiscoveryStatus::Empty
                } else {
                    DiscoveryStatus::Loaded
                },
                models,
                error: None,
            }
        }
        Err(e)
            if auth == AuthMode::ApiKey
                && e.code != "invalidCredential"
                && e.code != "permissionDenied" =>
        {
            Preparation {
                credential_status: CredentialStatus::Verified,
                discovery_status: DiscoveryStatus::Failed,
                models: vec![],
                error: Some(e),
            }
        }
        Err(e) => failed(e),
    }
}

async fn discover(
    http: &dyn ProviderHttp,
    protocol: Protocol,
    provider_id: &str,
    base: &str,
    headers: &[(String, String)],
    first: HttpResponse,
    key: &str,
) -> Result<Vec<ModelOption>, ProviderError> {
    let mut response = first;
    let mut models = Vec::new();
    let mut cursors = HashSet::new();
    for _ in 0..MAX_PAGES {
        if response.body.len() > MAX_RESPONSE_BYTES {
            return Err(ProviderError::new(
                "responseTooLarge",
                "The model response exceeded the safe size limit.",
            ));
        }
        let value: Value = serde_json::from_slice(&response.body).map_err(|_| ProviderError::new("invalidResponse", "The provider returned an unreadable model list. Retry, or enter model IDs manually."))?;
        // Check decoded values on every page, including pagination cursors.
        // Raw text matching alone misses JSON-escaped credentials.
        if !key.is_empty() && contains_secret(&value, key) {
            return Err(ProviderError::new("unsafeResponse", "The provider returned credential data in its model list. Enter model IDs manually instead."));
        }
        let next = match protocol {
            Protocol::Openai => {
                // Rig maps the bounded response without another network request,
                // retaining its native OpenAI model-listing behavior. No user key
                // is passed into the replay client or its diagnostic strings.
                let client = rig_core::providers::openai::Client::builder()
                    .api_key("lori-response-replay")
                    .base_url(base)
                    .http_client(BoundedResponse(response.body.clone()))
                    .build()
                    .map_err(|_| {
                        ProviderError::new(
                            "invalidResponse",
                            "Could not read the provider's model response.",
                        )
                    })?;
                let listed = client.list_models().await.map_err(|_| ProviderError::new("invalidResponse", "The provider returned an unreadable model list. Retry, or enter model IDs manually."))?;
                let raw_models: std::collections::HashMap<_, _> = value
                    .get("data")
                    .and_then(Value::as_array)
                    .map(|entries| {
                        entries
                            .iter()
                            .filter_map(|entry| {
                                entry
                                    .get("id")
                                    .and_then(Value::as_str)
                                    .map(|id| (id, entry))
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                for model in listed.data {
                    let raw = raw_models.get(model.id.as_str());
                    let name = raw
                        .and_then(|entry| entry.get("name").or_else(|| entry.get("display_name")))
                        .and_then(Value::as_str)
                        .or(model.name.as_deref());
                    let context_length = raw
                        .and_then(|entry| entry.get("context_length"))
                        .and_then(Value::as_u64)
                        .and_then(|n| u32::try_from(n).ok())
                        .or(model.context_length)
                        .filter(|n| *n > 0);
                    let mut option = ModelOption {
                        work_pricing: None,
                        id: crate::validate_model_id(&model.id)?,
                        name: safe_name(name, &model.id),
                        source: "discovered".into(),
                        available: Some(true),
                        context_length,
                        input_token_limit: raw.and_then(|v| token_limit(v, "max_input_tokens")),
                        output_token_limit: raw.and_then(|v| token_limit(v, "max_output_tokens")),
                        context_source: None,
                        supported_methods: vec![],
                    };
                    if let Some(raw) = raw {
                        crate::limits::apply(&mut option, raw);
                        option.work_pricing = crate::pricing::metadata(provider_id, raw);
                    }
                    models.push(option);
                }
                None
            }
            Protocol::Anthropic => {
                let entries = value
                    .get("data")
                    .and_then(Value::as_array)
                    .ok_or_else(invalid_models)?;
                for entry in entries {
                    let mut model = from_entry(entry, "id", "display_name")?;
                    model.input_token_limit = token_limit(entry, "max_input_tokens");
                    model.output_token_limit = token_limit(entry, "max_tokens");
                    crate::limits::apply(&mut model, entry);
                    models.push(model);
                }
                if value.get("has_more").and_then(Value::as_bool) == Some(true) {
                    let cursor = value
                        .get("last_id")
                        .and_then(Value::as_str)
                        .filter(|s| !s.is_empty())
                        .ok_or_else(invalid_models)?;
                    Some(("after_id", cursor.to_string()))
                } else {
                    None
                }
            }
            Protocol::Gemini => {
                let entries = value
                    .get("models")
                    .and_then(Value::as_array)
                    .ok_or_else(invalid_models)?;
                for entry in entries {
                    let mut model = from_entry(entry, "name", "displayName")?;
                    model.id = model
                        .id
                        .strip_prefix("models/")
                        .unwrap_or(&model.id)
                        .to_string();
                    model.input_token_limit = token_limit(entry, "inputTokenLimit");
                    model.output_token_limit = token_limit(entry, "outputTokenLimit");
                    model.supported_methods = entry
                        .get("supportedGenerationMethods")
                        .and_then(Value::as_array)
                        .map(|a| {
                            a.iter()
                                .filter_map(Value::as_str)
                                .filter(|s| s.len() <= 128)
                                .take(32)
                                .map(str::to_string)
                                .collect()
                        })
                        .unwrap_or_default();
                    models.push(model);
                }
                value
                    .get("nextPageToken")
                    .and_then(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(|s| ("pageToken", s.to_string()))
            }
            Protocol::Ollama => {
                let entries = value
                    .get("models")
                    .and_then(Value::as_array)
                    .ok_or_else(invalid_models)?;
                for entry in entries {
                    models.push(from_entry(entry, "name", "name")?);
                }
                None
            }
        };
        if models.len() > MAX_MODELS {
            return Err(ProviderError::new(
                "tooManyModels",
                "The provider returned more than 5,000 models.",
            ));
        }
        match next {
            None => {
                models.sort_by(|a, b| a.id.cmp(&b.id));
                models.dedup_by(|a, b| a.id == b.id);
                return Ok(models);
            }
            Some((parameter, cursor)) => {
                if cursor.len() > 4096 || !cursors.insert(cursor.clone()) {
                    return Err(invalid_models());
                }
                let root = if protocol == Protocol::Anthropic {
                    format!("{base}/v1/models?limit=100")
                } else {
                    format!("{base}/models?pageSize=1000")
                };
                let mut url = url::Url::parse(&root).map_err(|_| invalid_models())?;
                url.query_pairs_mut().append_pair(parameter, &cursor);
                response = http.get(url.as_str(), headers)?;
                if !is_success(&response) {
                    return Err(http_error(&response));
                }
                if !response.json {
                    return Err(invalid_models());
                }
            }
        }
    }
    Err(ProviderError::new(
        "tooManyPages",
        "Model discovery exceeded the pagination limit. Retry or enter model IDs manually.",
    ))
}
fn contains_secret(value: &Value, key: &str) -> bool {
    match value {
        Value::String(value) => value.contains(key),
        Value::Array(values) => values.iter().any(|value| contains_secret(value, key)),
        Value::Object(values) => values
            .iter()
            .any(|(name, value)| name.contains(key) || contains_secret(value, key)),
        _ => false,
    }
}
fn invalid_models() -> ProviderError {
    ProviderError::new(
        "invalidResponse",
        "The provider returned an unexpected model list. Retry, or enter model IDs manually.",
    )
}
fn token_limit(entry: &Value, key: &str) -> Option<u32> {
    entry
        .get(key)
        .and_then(Value::as_u64)
        .and_then(|n| u32::try_from(n).ok())
        .filter(|n| *n > 0)
}
fn safe_name(name: Option<&str>, fallback: &str) -> String {
    name.filter(|s| !s.is_empty() && s.chars().count() <= 512 && !s.chars().any(char::is_control))
        .unwrap_or(fallback)
        .to_string()
}
fn from_entry(
    entry: &Value,
    id_field: &str,
    name_field: &str,
) -> Result<ModelOption, ProviderError> {
    let id = crate::validate_model_id(
        entry
            .get(id_field)
            .and_then(Value::as_str)
            .ok_or_else(invalid_models)?,
    )?;
    Ok(ModelOption {
        work_pricing: None,
        name: safe_name(entry.get(name_field).and_then(Value::as_str), &id),
        id,
        source: "discovered".into(),
        available: Some(true),
        context_length: None,
        input_token_limit: None,
        output_token_limit: None,
        context_source: None,
        supported_methods: vec![],
    })
}

/// Read-only Rig transport for an already authenticated, bounded HTTP response.
#[derive(Clone)]
struct BoundedResponse(Vec<u8>);
impl rig_core::http_client::HttpClientExt for BoundedResponse {
    fn send<T, U>(
        &self,
        request: http::Request<T>,
    ) -> impl std::future::Future<
        Output = rig_core::http_client::Result<http::Response<rig_core::http_client::LazyBody<U>>>,
    > + Send
           + 'static
    where
        T: Into<bytes::Bytes> + Send,
        U: From<bytes::Bytes> + Send + 'static,
    {
        let bytes = bytes::Bytes::copy_from_slice(&self.0);
        let valid =
            request.method() == http::Method::GET && request.uri().path().ends_with("/models");
        async move {
            if !valid {
                return Err(rig_core::http_client::Error::StreamEnded);
            }
            let body: rig_core::http_client::LazyBody<U> =
                Box::pin(async move { Ok(U::from(bytes)) });
            Ok(http::Response::new(body))
        }
    }
    // An async fn would capture &self and fail Rig's 'static future contract.
    #[allow(clippy::manual_async_fn)]
    fn send_multipart<U>(
        &self,
        _: http::Request<rig_core::http_client::MultipartForm>,
    ) -> impl std::future::Future<
        Output = rig_core::http_client::Result<http::Response<rig_core::http_client::LazyBody<U>>>,
    > + Send
           + 'static
    where
        U: From<bytes::Bytes> + Send + 'static,
    {
        async { Err(rig_core::http_client::Error::StreamEnded) }
    }
    async fn send_streaming<T>(
        &self,
        _: http::Request<T>,
    ) -> rig_core::http_client::Result<rig_core::http_client::StreamingResponse>
    where
        T: Into<bytes::Bytes> + Send,
    {
        Err(rig_core::http_client::Error::StreamEnded)
    }
}
