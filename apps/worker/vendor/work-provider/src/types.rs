use serde::{Deserialize, Serialize};

pub const CONTRACT_VERSION: u32 = 1;
pub const MAX_MODELS: usize = 5_000;
pub const MAX_MODEL_ID_CHARS: usize = 512;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum Protocol {
    Openai,
    Anthropic,
    Gemini,
    Ollama,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum AuthMode {
    ApiKey,
    None,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderDefinition {
    pub id: String,
    pub name: String,
    pub protocol: Protocol,
    pub base_url: String,
    pub local: bool,
    pub editable_endpoint: bool,
    pub allows_keyless: bool,
    pub subscription: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProviderError {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    pub retry_after_seconds: Option<u64>,
}
impl ProviderError {
    pub fn new(code: &str, message: &str) -> Self {
        Self {
            code: code.into(),
            message: message.into(),
            retryable: false,
            retry_after_seconds: None,
        }
    }
    pub fn transient(code: &str, message: &str) -> Self {
        Self {
            retryable: true,
            ..Self::new(code, message)
        }
    }
}
impl std::fmt::Display for ProviderError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}
impl std::error::Error for ProviderError {}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum CredentialStatus {
    Verified,
    Rejected,
    Unverifiable,
    NotRequired,
}

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum DiscoveryStatus {
    Loaded,
    Empty,
    Failed,
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelOption {
    #[serde(default)]
    pub work_pricing: Option<serde_json::Value>,
    pub id: String,
    pub name: String,
    pub source: String,
    pub available: Option<bool>,
    pub context_length: Option<u32>,
    #[serde(default)]
    pub input_token_limit: Option<u32>,
    #[serde(default)]
    pub output_token_limit: Option<u32>,
    #[serde(default)]
    pub context_source: Option<String>,
    pub supported_methods: Vec<String>,
}
impl ModelOption {
    pub fn manual(id: &str) -> Result<Self, ProviderError> {
        let id = validate_model_id(id)?;
        Ok(Self {
            work_pricing: None,
            name: id.clone(),
            id,
            source: "manual".into(),
            available: None,
            context_length: None,
            input_token_limit: None,
            output_token_limit: None,
            context_source: None,
            supported_methods: vec![],
        })
    }
}

pub fn validate_model_id(id: &str) -> Result<String, ProviderError> {
    let id = id.trim();
    if id.is_empty() || id.chars().count() > MAX_MODEL_ID_CHARS || id.chars().any(char::is_control)
    {
        return Err(ProviderError::new(
            "invalidModelId",
            "Enter a model ID of 1–512 characters without control characters.",
        ));
    }
    Ok(id.into())
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Preparation {
    pub credential_status: CredentialStatus,
    pub discovery_status: DiscoveryStatus,
    pub models: Vec<ModelOption>,
    pub error: Option<ProviderError>,
}
impl Preparation {
    pub fn verified(&self) -> bool {
        matches!(
            self.credential_status,
            CredentialStatus::Verified | CredentialStatus::NotRequired
        )
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ModelReference {
    pub connection_id: String,
    pub model_id: String,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Connection {
    pub id: String,
    pub provider_id: String,
    pub name: String,
    pub base_url: String,
    pub auth_mode: AuthMode,
    pub revision: u64,
    pub connected: bool,
    pub credential_present: bool,
    pub models: Vec<ModelOption>,
    pub credential_status: CredentialStatus,
    pub discovery_status: DiscoveryStatus,
    pub validated_at: String,
    pub models_updated_at: Option<String>,
    pub last_error: Option<ProviderError>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderSnapshot {
    pub contract_version: u32,
    pub catalog: Vec<ProviderDefinition>,
    pub connections: Vec<Connection>,
    pub default_model: Option<ModelReference>,
    pub cleanup_pending: bool,
}
