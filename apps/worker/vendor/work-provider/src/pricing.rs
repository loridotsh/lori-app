use serde_json::{json, Value};
use std::sync::LazyLock;
static CATALOG: LazyLock<Value> = LazyLock::new(|| {
    serde_json::from_str(include_str!("pricing.json")).expect("bundled Work pricing")
});
const MAX: f64 = 9_007_199_254_740_991.0;
fn rate(v: &Value) -> Option<f64> {
    v.as_f64()
        .filter(|n| n.is_finite() && *n >= 0.0 && *n <= 1_000_000.0)
}
fn tokens(v: &Value) -> Option<u64> {
    v.as_u64().filter(|n| *n <= 9_007_199_254_740_991)
}
pub const RATE_KEYS: [&str; 5] = ["input", "output", "cacheRead", "cacheWrite", "cacheWrite1h"];
fn rates_valid(v: &Value) -> bool {
    RATE_KEYS
        .iter()
        .all(|k| v.get(*k).is_none() || rate(&v[*k]).is_some())
}
pub fn valid(v: &Value) -> bool {
    v.as_object().is_some_and(|o| {
        o.keys().all(|k| {
            RATE_KEYS.contains(&k.as_str())
                || ["source", "version", "currency", "unit", "longContext"].contains(&k.as_str())
        })
    }) && v["currency"] == "USD"
        && v["unit"] == "perMillionTokens"
        && v["source"]
            .as_str()
            .is_some_and(|s| !s.is_empty() && s.len() <= 512)
        && v["version"]
            .as_str()
            .is_some_and(|s| !s.is_empty() && s.len() <= 100)
        && rates_valid(v)
        && v.get("longContext").is_none_or(|l| {
            l.as_object().is_some_and(|o| {
                o.keys()
                    .all(|k| k == "above" || RATE_KEYS.contains(&k.as_str()))
            }) && tokens(&l["above"]).is_some_and(|n| n > 0 && n <= 4_000_000)
                && rates_valid(l)
        })
}
pub fn published(provider: &str, model: &str) -> Option<Value> {
    CATALOG.get(format!("{provider}:{model}")).cloned()
}
pub fn resolve_published(
    provider: &str,
    native_base: &str,
    base: &str,
    model: &str,
    current: Option<Value>,
) -> Option<Value> {
    let catalog = current.as_ref().is_none_or(|p| {
        p["source"]
            .as_str()
            .is_some_and(|s| s.starts_with("https://"))
    });
    if catalog && base.trim_end_matches('/') == native_base.trim_end_matches('/') {
        published(provider, model).or(current)
    } else {
        current
    }
}
pub fn metadata(provider: &str, entry: &Value) -> Option<Value> {
    if valid(&entry["workPricing"]) {
        let mut pricing = entry["workPricing"].clone();
        pricing["source"] = format!("{provider}:models").into();
        return Some(pricing);
    }
    let p = entry
        .get("pricing")
        .or_else(|| entry.pointer("/model_spec/pricing"))?;
    let fields: &[(&str, &str)] = match provider {
        "openrouter" => &[
            ("input", "/prompt"),
            ("output", "/completion"),
            ("cacheRead", "/input_cache_read"),
            ("cacheWrite", "/input_cache_write"),
        ],
        "together" => &[
            ("input", "/input"),
            ("output", "/output"),
            ("cacheRead", "/cached_input"),
        ],
        "venice" => &[
            ("input", "/input/usd"),
            ("output", "/output/usd"),
            ("cacheRead", "/cache_input/usd"),
        ],
        _ => return None,
    };
    let mut out = json!({"currency":"USD","unit":"perMillionTokens","source":format!("{provider}:models"),"version":"provider-metadata"});
    let mut any = false;
    for (key, path) in fields {
        let Some(v) = p.pointer(path) else { continue };
        let value = v
            .as_f64()
            .or_else(|| v.as_str().and_then(|s| s.parse::<f64>().ok()))
            .map(|n| {
                n * if provider == "openrouter" {
                    1_000_000.0
                } else {
                    1.0
                }
            });
        if let Some(value) = value.filter(|n| n.is_finite() && *n >= 0.0 && *n <= 1_000_000.0) {
            out[*key] = json!(value);
            any = true;
        }
    }
    any.then_some(out)
}
pub fn price(mut usage: Value, snapshot: Option<&Value>) -> Value {
    let read = tokens(&usage["cacheReadTokens"]);
    let write = tokens(&usage["cacheWriteTokens"]);
    let input = tokens(&usage["uncachedInputTokens"]).or_else(|| {
        if read.unwrap_or(0) == 0 {
            tokens(&usage["inputTokens"])
        } else {
            None
        }
    });
    let output = tokens(&usage["outputTokens"]);
    let total = [input, output, read, write]
        .into_iter()
        .flatten()
        .sum::<u64>();
    usage["pricingSnapshot"] = snapshot
        .filter(|p| valid(p))
        .cloned()
        .unwrap_or(Value::Null);
    usage["estimatedCostMicrousd"] = Value::Null;
    usage["costCoveredTokens"] = json!(0);
    if let Some(cost) = tokens(&usage["costMicrousd"]).filter(|_| total as f64 <= MAX) {
        usage["estimatedCostMicrousd"] = json!(cost);
        usage["costCoveredTokens"] = json!(total);
        return usage;
    }
    let Some(p) = snapshot.filter(|p| valid(p)) else {
        return usage;
    };
    let prompt = input.map(|n| n + read.unwrap_or(0) + write.unwrap_or(0));
    if p.get("longContext").is_some() && prompt.is_none() {
        return usage;
    }
    let mut rates = p.clone();
    if p.get("longContext")
        .is_some_and(|l| prompt.unwrap_or(0) > tokens(&l["above"]).unwrap_or(u64::MAX))
    {
        for (key, value) in p["longContext"].as_object().unwrap() {
            rates[key] = value.clone();
        }
    }
    let mut components = vec![(input, "input"), (output, "output"), (read, "cacheRead")];
    let mut five = tokens(&usage["cacheWrite5mTokens"]);
    let mut hour = tokens(&usage["cacheWrite1hTokens"]);
    let has_duration = five.is_some() || hour.is_some();
    if let Some(w) = write {
        if let (Some(h), None) = (hour, five) {
            five = w.checked_sub(h);
        }
        if let (Some(f), None) = (five, hour) {
            hour = w.checked_sub(f);
        }
    }
    if five
        .zip(hour)
        .zip(write)
        .is_some_and(|((f, h), w)| f + h == w)
    {
        components.push((five, "cacheWrite"));
        components.push((hour, "cacheWrite1h"));
    } else if !has_duration {
        components.push((write, "cacheWrite"));
    }
    let mut cost = 0.0;
    let mut covered = 0u64;
    let mut known = false;
    for (n, key) in components {
        if let (Some(n), Some(r)) = (n, rate(&rates[key])) {
            cost += n as f64 * r;
            covered += n;
            known = true;
        }
    }
    if known && cost.is_finite() && cost.round() <= MAX && covered as f64 <= MAX {
        usage["estimatedCostMicrousd"] = json!(cost.round() as u64);
        usage["costCoveredTokens"] = json!(covered);
    }
    usage
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn partial_duration_and_sparse_tier_rates_do_not_underprice() {
        let rates = json!({"input":2,"output":10,"cacheWrite":2.5,"cacheWrite1h":4,"source":"configured","version":"test","currency":"USD","unit":"perMillionTokens"});
        let partial = price(
            json!({"inputTokens":100,"outputTokens":10,"cacheWriteTokens":75,"cacheWrite1hTokens":25}),
            Some(&rates),
        );
        assert_eq!(partial["estimatedCostMicrousd"], 525);
        assert_eq!(partial["costCoveredTokens"], 185);
        let invalid = price(
            json!({"inputTokens":100,"outputTokens":10,"cacheWriteTokens":75,"cacheWrite1hTokens":80}),
            Some(&rates),
        );
        assert_eq!(invalid["estimatedCostMicrousd"], 300);
        assert_eq!(invalid["costCoveredTokens"], 110);
        let mut tiered = rates;
        tiered["longContext"] = json!({"above":100,"input":4});
        assert_eq!(
            price(json!({"inputTokens":200,"outputTokens":20}), Some(&tiered))
                ["estimatedCostMicrousd"],
            1000
        );
        tiered["longContext"]["unknown"] = json!(1);
        assert!(!valid(&tiered));
    }
    #[test]
    fn native_pricing_counts_caches_reasoning_and_rounding_once() {
        let rates = json!({"input":2,"output":10,"cacheRead":0.2,"cacheWrite":2.5,"cacheWrite1h":4,"source":"configured","version":"test","currency":"USD","unit":"perMillionTokens"});
        let p = price(
            json!({"inputTokens":1000,"uncachedInputTokens":600,"outputTokens":50,"cacheReadTokens":400,"reasoningTokens":20}),
            Some(&rates),
        );
        assert_eq!(p["estimatedCostMicrousd"], 1780);
        assert_eq!(p["costCoveredTokens"], 1050);
        let p = price(
            json!({"inputTokens":100,"uncachedInputTokens":100,"outputTokens":10,"cacheReadTokens":300,"cacheWriteTokens":75,"cacheWrite5mTokens":50,"cacheWrite1hTokens":25}),
            Some(&rates),
        );
        assert_eq!(p["estimatedCostMicrousd"], 585);
        assert_eq!(p["costCoveredTokens"], 485);
        assert!(price(json!({}), Some(&rates))["estimatedCostMicrousd"].is_null());
    }
    #[test]
    fn official_luna_cost_and_long_context_match_cloud() {
        let p = published("openai", "gpt-6-luna").unwrap();
        assert_eq!(
            price(
                json!({"inputTokens":6857,"outputTokens":13,"cacheReadTokens":0}),
                Some(&p)
            )["estimatedCostMicrousd"],
            692
        );
        assert_eq!(
            price(
                json!({"inputTokens":272001,"outputTokens":100,"cacheReadTokens":0}),
                Some(&p)
            )["estimatedCostMicrousd"],
            54475
        );
        assert!(published("custom", "gpt-6-luna").is_none());
        assert_eq!(
            price(
                json!({"inputTokens":100,"outputTokens":20,"costMicrousd":0}),
                Some(&p)
            )["estimatedCostMicrousd"],
            0
        );
    }
    #[test]
    fn metadata_units_are_provider_specific() {
        assert_eq!(
            metadata(
                "openrouter",
                &json!({"pricing":{"prompt":"0.000002","completion":"0.00001"}})
            )
            .unwrap()["input"],
            2.0
        );
        assert_eq!(
            metadata("together", &json!({"pricing":{"input":2,"output":10}})).unwrap()["input"],
            2.0
        );
        assert_eq!(
            metadata(
                "venice",
                &json!({"model_spec":{"pricing":{"input":{"usd":2},"output":{"usd":10}}}})
            )
            .unwrap()["input"],
            2.0
        );
        assert!(metadata("custom", &json!({"pricing":{"input":2}})).is_none());
        let forged = json!({"workPricing":{"input":0,"source":"configured","version":"x","currency":"USD","unit":"perMillionTokens"}});
        assert_eq!(
            metadata("custom", &forged).unwrap()["source"],
            "custom:models"
        );
    }
}
