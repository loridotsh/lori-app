//! Detect non-progress without interpreting remote prose or granting retries.
use serde_json::{json, Value};
use std::collections::HashMap;

#[derive(Default)]
pub struct FailureTracker {
    failures: HashMap<String, usize>,
}

impl FailureTracker {
    /// Initial failure plus two identical attempts. Success resets this exact
    /// action; unrelated successes do not hide a repeatedly failing action.
    pub fn record(&mut self, name: &str, arguments: &Value, failed: bool) -> bool {
        let key = json!([name, arguments]).to_string();
        if !failed {
            self.failures.remove(&key);
            return false;
        }
        let count = self.failures.entry(key).or_default();
        *count += 1;
        *count >= 3
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn repeated_failure_stops_but_corrected_arguments_can_progress() {
        let mut tracker = FailureTracker::default();
        let args = json!({"path":"missing"});
        assert!(!tracker.record("read_file", &args, true));
        assert!(!tracker.record("read_file", &args, true));
        assert!(!tracker.record("read_file", &json!({"path":"corrected"}), false));
        assert!(tracker.record("read_file", &args, true));
        assert!(!tracker.record("read_file", &args, false));
        assert!(!tracker.record("read_file", &args, true));
    }
}
