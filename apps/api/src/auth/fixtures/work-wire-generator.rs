// Reproduce with a temporary Cargo package depending on chrono 0.4 and serde_json 1.
// These json! payload shapes mirror enterprise/work_usage.rs; fixed timestamps
// make the fixture deterministic while retaining Chrono's real +00:00 encoding.
use chrono::{TimeZone, Utc};
use serde_json::json;
fn main() {
    let enrolled_at = Utc.with_ymd_and_hms(2026, 8, 11, 1, 0, 0).unwrap().to_rfc3339();
    let occurred_at = Utc.with_ymd_and_hms(2026, 8, 11, 1, 30, 0).unwrap().to_rfc3339();
    // Exclusive input plus cache reads matches the enterprise aggregation
    // contract: a 100-input/80-cached/20-output OpenAI request totals 120.
    let snapshot = json!({"usageDate":"2026-08-11","agentId":"work-agent",
        "model":"model+fast","totalTurns":1,"inputTokens":20,"outputTokens":20,
        "cacheReadTokens":80,"cacheWriteTokens":0,"estimatedCostMicrousd":0,
        "costCoveredTokens":0,"appVersion":"1.6.0","pricingVersion":"work-unpriced-v1"});
    let usage = json!({"epoch":"30000000-0000-4000-8000-000000000001",
        "sourceId":"40000000-0000-4000-8000-000000000001","enrolledAt":enrolled_at,
        "snapshots":[snapshot]});
    let audit = json!({"events":[{"eventId":"50000000-0000-4000-8000-000000000001",
        "action":"turn_completed","occurredAt":occurred_at,"policyRevision":1,
        "providerId":"openai","modelId":"model+fast"}]});
    println!("{}", serde_json::to_string_pretty(&json!({"usage":usage,"audit":audit})).unwrap());
}
