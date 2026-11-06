use lori_work_provider::*;
use serde_json::json;
use std::collections::VecDeque;
use std::sync::Mutex;

struct FakeHttp {
    responses: Mutex<VecDeque<HttpResponse>>,
    calls: Mutex<Vec<String>>,
}
impl FakeHttp {
    fn new(responses: Vec<HttpResponse>) -> Self {
        Self {
            responses: Mutex::new(responses.into()),
            calls: Mutex::new(vec![]),
        }
    }
}
impl ProviderHttp for FakeHttp {
    fn get(&self, url: &str, _: &[(String, String)]) -> Result<HttpResponse, ProviderError> {
        self.calls.lock().unwrap().push(url.into());
        Ok(self
            .responses
            .lock()
            .unwrap()
            .pop_front()
            .expect("unexpected request"))
    }
}
fn response(status: u16, body: serde_json::Value) -> HttpResponse {
    HttpResponse {
        status,
        body: serde_json::to_vec(&body).unwrap(),
        json: true,
        retry_after_seconds: None,
    }
}
async fn run(http: &FakeHttp, id: &str) -> Preparation {
    let d = definition(id).unwrap();
    prepare(http, &d, &d.base_url, AuthMode::ApiKey, "test-key").await
}

#[tokio::test]
async fn custom_endpoints_require_a_key_before_any_request() {
    let http = FakeHttp::new(vec![]);
    let d = definition("custom").unwrap();
    let result = prepare(&http, &d, "https://example.com/v1", AuthMode::None, "").await;
    assert!(!result.verified());
    assert_eq!(result.error.unwrap().code, "missingCredential");
    assert!(http.calls.lock().unwrap().is_empty());
}

#[tokio::test]
async fn invalid_keys_do_not_produce_verified_candidates() {
    let result = run(
        &FakeHttp::new(vec![response(
            401,
            json!({"error":{"message":"secret-test-key"}}),
        )]),
        "openai",
    )
    .await;
    assert_eq!(result.credential_status, CredentialStatus::Rejected);
    assert!(!serde_json::to_string(&result).unwrap().contains("test-key"));
}
#[tokio::test]
async fn rig_discovery_preserves_names_and_deduplicates_ids() {
    let http = FakeHttp::new(vec![response(
        200,
        json!({"data":[{"id":"org/model:v1","name":"Model"},{"id":"org/model:v1"}]}),
    )]);
    let result = run(&http, "openai").await;
    assert!(result.verified());
    assert_eq!(result.models.len(), 1);
    assert_eq!(result.models[0].id, "org/model:v1");
    assert_eq!(http.calls.lock().unwrap().len(), 1);
}
#[tokio::test]
async fn protected_success_with_bad_model_shape_allows_manual_fallback() {
    let result = run(
        &FakeHttp::new(vec![response(200, json!({"unexpected":[]}))]),
        "openai",
    )
    .await;
    assert!(result.verified());
    assert_eq!(result.discovery_status, DiscoveryStatus::Failed);
}
#[tokio::test]
async fn openrouter_validates_key_before_failed_discovery() {
    let http = FakeHttp::new(vec![
        response(200, json!({"data":{"label":"key"}})),
        response(500, json!({})),
    ]);
    let result = run(&http, "openrouter").await;
    assert!(result.verified());
    assert_eq!(result.discovery_status, DiscoveryStatus::Failed);
    assert!(http.calls.lock().unwrap()[0].ends_with("/key"));
}
#[tokio::test]
async fn revoked_key_during_discovery_invalidates_prior_validation() {
    let result = run(
        &FakeHttp::new(vec![
            response(200, json!({"data":{}})),
            response(401, json!({})),
        ]),
        "openrouter",
    )
    .await;
    assert!(!result.verified());
}
#[tokio::test]
async fn custom_public_catalog_never_validates_an_api_key() {
    let d = definition("custom").unwrap();
    let http = FakeHttp::new(vec![response(200, json!({"data":[]}))]);
    let result = prepare(
        &http,
        &d,
        "https://example.com/v1",
        AuthMode::ApiKey,
        "wrong-key",
    )
    .await;
    assert!(!result.verified());
    assert!(!result
        .error
        .as_ref()
        .unwrap()
        .message
        .contains("No API key"));
    assert_eq!(
        result.error.unwrap().code,
        "credentialVerificationUnavailable"
    );
}
#[tokio::test]
async fn custom_server_must_reject_an_invalid_bearer_key_too() {
    let d = definition("custom").unwrap();
    let http = FakeHttp::new(vec![
        response(401, json!({})),
        response(200, json!({"data":[]})),
    ]);
    let result = prepare(&http, &d, "https://example.com/v1", AuthMode::ApiKey, "key").await;
    assert!(!result.verified());
}
#[tokio::test]
async fn custom_authenticated_catalog_passes_and_loads() {
    let d = definition("custom").unwrap();
    let http = FakeHttp::new(vec![
        response(401, json!({})),
        response(401, json!({})),
        response(200, json!({"data":[{"id":"my-model"}]})),
    ]);
    let result = prepare(
        &http,
        &d,
        "https://example.com/prefix/v1",
        AuthMode::ApiKey,
        "key",
    )
    .await;
    assert!(result.verified());
    assert_eq!(result.models[0].id, "my-model");
}
#[tokio::test]
async fn keyless_local_endpoints_need_a_valid_protocol_response() {
    let d = definition("ollama").unwrap();
    let result = prepare(
        &FakeHttp::new(vec![response(200, json!({"models":[]}))]),
        &d,
        &d.base_url,
        AuthMode::None,
        "",
    )
    .await;
    assert_eq!(result.credential_status, CredentialStatus::NotRequired);
    assert_eq!(result.discovery_status, DiscoveryStatus::Empty);
    let malformed = prepare(
        &FakeHttp::new(vec![response(200, json!({}))]),
        &d,
        &d.base_url,
        AuthMode::None,
        "",
    )
    .await;
    assert!(!malformed.verified());
}
#[tokio::test]
async fn anthropic_pagination_and_repeated_cursors_are_bounded() {
    let http = FakeHttp::new(vec![
        response(
            200,
            json!({"data":[{"id":"claude-a"}],"has_more":true,"last_id":"a/b"}),
        ),
        response(200, json!({"data":[{"id":"claude-b"}],"has_more":false})),
    ]);
    let result = run(&http, "anthropic").await;
    assert_eq!(result.models.len(), 2);
    assert!(http.calls.lock().unwrap()[1].contains("after_id=a%2Fb"));
}
#[tokio::test]
async fn gemini_metadata_uses_native_model_ids() {
    let result=run(&FakeHttp::new(vec![response(200,json!({"models":[{"name":"models/gemini-x","displayName":"Gemini X","inputTokenLimit":1024,"outputTokenLimit":512,"supportedGenerationMethods":["generateContent"]}]}))]),"google").await;
    assert_eq!(result.models[0].id, "gemini-x");
    assert_eq!(result.models[0].input_token_limit, Some(1024));
    assert_eq!(result.models[0].context_length, None);
    assert_eq!(result.models[0].output_token_limit, Some(512));
}
#[tokio::test]
async fn anthropic_discovers_separate_limits_and_ignores_invalid_values() {
    let result = run(
        &FakeHttp::new(vec![response(
            200,
            json!({"data":[
        {"id":"claude-large","max_input_tokens":1_000_000,"max_tokens":64000},
        {"id":"claude-unknown","max_input_tokens":0,"max_tokens":-1}
    ],"has_more":false}),
        )]),
        "anthropic",
    )
    .await;
    assert_eq!(result.models[0].input_token_limit, Some(1_000_000));
    assert_eq!(result.models[0].output_token_limit, Some(64000));
    assert_eq!(result.models[1].input_token_limit, None);
    assert_eq!(result.models[1].output_token_limit, None);
}
#[tokio::test]
async fn html_and_forbidden_responses_do_not_verify_keys() {
    let html = HttpResponse {
        status: 200,
        body: b"<html>login</html>".to_vec(),
        json: false,
        retry_after_seconds: None,
    };
    assert!(!run(&FakeHttp::new(vec![html]), "openai").await.verified());
    let forbidden = run(&FakeHttp::new(vec![response(403, json!({}))]), "openai").await;
    assert_eq!(forbidden.error.unwrap().code, "permissionDenied");
}
#[tokio::test]
async fn subscription_placeholders_make_no_network_requests() {
    let result = run(&FakeHttp::new(vec![]), "chatgpt-subscription").await;
    assert_eq!(result.error.unwrap().code, "subscriptionUnavailable");
}
#[test]
fn endpoint_normalization_preserves_prefixes_and_rejects_url_secrets() {
    let d = definition("custom").unwrap();
    assert_eq!(
        catalog::normalize_endpoint(&d, "https://example.com/prefix/v1/chat/completions").unwrap(),
        "https://example.com/prefix/v1"
    );
    assert_eq!(
        catalog::normalize_endpoint(&d, "https://example.com").unwrap(),
        "https://example.com/v1"
    );
    assert!(catalog::normalize_endpoint(&d, "https://user:password@example.com").is_err());
    assert!(catalog::normalize_endpoint(&d, "https://example.com?key=secret").is_err());
}

#[tokio::test]
async fn together_native_array_maps_to_compatible_models() {
    let http = FakeHttp::new(vec![response(
        200,
        json!([{"id":"org/model","display_name":"Readable model","context_length":32768}]),
    )]);
    let result = run(&http, "together").await;
    assert!(result.verified());
    assert_eq!(result.models[0].name, "Readable model");
    assert_eq!(result.models[0].context_length, Some(32768));
}
#[tokio::test]
async fn venice_validates_against_rate_limits_before_discovery() {
    let http = FakeHttp::new(vec![
        response(200, json!({"data":{"accessPermitted":true}})),
        response(200, json!({"data":[{"id":"venice-model"}]})),
    ]);
    assert!(run(&http, "venice").await.verified());
    assert!(http.calls.lock().unwrap()[0].ends_with("/api_keys/rate_limits"));
}
#[tokio::test]
async fn later_pages_cannot_echo_credentials_into_model_metadata() {
    let result = run(
        &FakeHttp::new(vec![
            response(
                200,
                json!({"data":[{"id":"model-a"}],"has_more":true,"last_id":"next"}),
            ),
            response(
                200,
                json!({"data":[{"id":"model-b","display_name":"test-key"}],"has_more":false}),
            ),
        ]),
        "anthropic",
    )
    .await;
    assert!(result.verified());
    assert!(result.models.is_empty());
    assert_eq!(result.error.unwrap().code, "unsafeResponse");
}

#[tokio::test]
async fn json_escaped_credentials_cannot_reach_model_metadata() {
    let mut escaped = response(200, json!({}));
    escaped.body = br#"{"data":[{"id":"model-a","name":"test-\u006bey"}]}"#.to_vec();
    let result = run(&FakeHttp::new(vec![escaped]), "openai").await;
    assert!(result.verified());
    assert!(result.models.is_empty());
    assert_eq!(result.error.unwrap().code, "unsafeResponse");
}

#[tokio::test]
async fn echoed_credentials_never_reach_model_outputs() {
    let result = run(
        &FakeHttp::new(vec![response(200, json!({"data":[{"id":"test-key"}]}))]),
        "openai",
    )
    .await;
    assert!(result.models.is_empty());
    assert!(!serde_json::to_string(&result).unwrap().contains("test-key"));
}
#[tokio::test]
async fn native_google_invalid_key_is_reported_as_authentication_failure() {
    let result = run(
        &FakeHttp::new(vec![response(
            400,
            json!({"error":{"details":[{"reason":"API_KEY_INVALID"}]}}),
        )]),
        "google",
    )
    .await;
    assert_eq!(result.credential_status, CredentialStatus::Rejected);
}
#[tokio::test]
async fn pagination_cycles_and_oversized_models_stop_discovery() {
    let http = FakeHttp::new(vec![
        response(200, json!({"data":[],"has_more":true,"last_id":"same"})),
        response(200, json!({"data":[],"has_more":true,"last_id":"same"})),
    ]);
    assert_eq!(
        run(&http, "anthropic").await.discovery_status,
        DiscoveryStatus::Failed
    );
    let model = "x".repeat(513);
    let result = run(
        &FakeHttp::new(vec![response(200, json!({"data":[{"id":model}]}))]),
        "openai",
    )
    .await;
    assert!(result.models.is_empty());
    assert_eq!(result.error.unwrap().code, "invalidModelId");
}
