use crate::{Protocol, ProviderDefinition, ProviderError};

pub fn catalog() -> Vec<ProviderDefinition> {
    let presets = [
        (
            "openai",
            "OpenAI",
            Protocol::Openai,
            "https://api.openai.com/v1",
            false,
        ),
        (
            "anthropic",
            "Anthropic",
            Protocol::Anthropic,
            "https://api.anthropic.com",
            false,
        ),
        (
            "google",
            "Google Gemini",
            Protocol::Gemini,
            "https://generativelanguage.googleapis.com/v1beta",
            false,
        ),
        (
            "openrouter",
            "OpenRouter",
            Protocol::Openai,
            "https://openrouter.ai/api/v1",
            false,
        ),
        (
            "groq",
            "Groq",
            Protocol::Openai,
            "https://api.groq.com/openai/v1",
            false,
        ),
        (
            "mistral",
            "Mistral",
            Protocol::Openai,
            "https://api.mistral.ai/v1",
            false,
        ),
        (
            "together",
            "Together AI",
            Protocol::Openai,
            "https://api.together.ai/v1",
            false,
        ),
        (
            "fireworks",
            "Fireworks",
            Protocol::Openai,
            "https://api.fireworks.ai/inference/v1",
            false,
        ),
        (
            "akashml",
            "AkashML",
            Protocol::Openai,
            "https://api.akashml.com/v1",
            false,
        ),
        (
            "venice",
            "Venice AI",
            Protocol::Openai,
            "https://api.venice.ai/api/v1",
            false,
        ),
        (
            "ollama",
            "Ollama",
            Protocol::Ollama,
            "http://127.0.0.1:11434",
            true,
        ),
        (
            "lmstudio",
            "LM Studio",
            Protocol::Openai,
            "http://127.0.0.1:1234/v1",
            true,
        ),
        (
            "vllm",
            "vLLM",
            Protocol::Openai,
            "http://127.0.0.1:8000/v1",
            true,
        ),
        ("custom", "Custom provider", Protocol::Openai, "", false),
    ];
    let mut definitions: Vec<_> = presets
        .into_iter()
        .map(|(id, name, protocol, base, local)| ProviderDefinition {
            id: id.into(),
            name: name.into(),
            protocol,
            base_url: base.into(),
            local,
            editable_endpoint: local || id == "custom",
            allows_keyless: local,
            subscription: false,
        })
        .collect();
    for (id, name) in [
        ("chatgpt-subscription", "ChatGPT subscription"),
        ("claude-subscription", "Claude subscription"),
        ("gemini-subscription", "Gemini subscription"),
    ] {
        definitions.push(ProviderDefinition {
            id: id.into(),
            name: name.into(),
            protocol: Protocol::Openai,
            base_url: String::new(),
            local: false,
            editable_endpoint: false,
            allows_keyless: false,
            subscription: true,
        });
    }
    definitions
}

pub fn definition(id: &str) -> Result<ProviderDefinition, ProviderError> {
    catalog()
        .into_iter()
        .find(|p| p.id == id)
        .ok_or_else(|| ProviderError::new("unknownProvider", "This provider is not supported."))
}

pub fn normalize_endpoint(
    definition: &ProviderDefinition,
    raw: &str,
) -> Result<String, ProviderError> {
    if definition.subscription {
        return Err(ProviderError::new(
            "subscriptionUnavailable",
            "Subscription connections are coming later. Use an API key connection.",
        ));
    }
    let raw = if definition.editable_endpoint {
        raw.trim()
    } else {
        definition.base_url.as_str()
    };
    let mut url = url::Url::parse(raw).map_err(|_| {
        ProviderError::new("invalidEndpoint", "Enter a complete provider base URL.")
    })?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(ProviderError::new(
            "invalidEndpoint",
            "Use an HTTP or HTTPS base URL without credentials, query parameters, or a fragment.",
        ));
    }
    let mut path = url.path().trim_end_matches('/').to_string();
    for suffix in ["/chat/completions", "/responses", "/models"] {
        if definition.protocol == Protocol::Openai && path.ends_with(suffix) {
            path.truncate(path.len() - suffix.len());
            break;
        }
    }
    if definition.protocol == Protocol::Openai && path.is_empty() {
        path = "/v1".into();
    }
    if definition.protocol == Protocol::Ollama && path.ends_with("/v1") {
        path.truncate(path.len() - 3);
    }
    url.set_path(&path);
    Ok(url.as_str().trim_end_matches('/').to_string())
}
