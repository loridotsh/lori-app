//! Bounded planning state. A checked item is an agent claim, never execution evidence.
use crate::provider::ProviderError;
use serde_json::{json, Value};
use std::collections::HashSet;

pub const MAX_BYTES: usize = 6144;
pub fn parameters() -> Value {
    serde_json::from_str(include_str!("todos.schema.json")).expect("bundled todo schema")
}
pub fn empty() -> Value {
    json!({"revision":0,"todos":[]})
}
pub fn update(current: &Value, arguments: &Value) -> Result<Value, ProviderError> {
    crate::schema::validate(&parameters(), arguments)?;
    let fail = || {
        ProviderError::new("invalidTodos", "Use up to 20 unique todo IDs (letters, digits, _ or -), nonblank content up to 240 UTF-8 bytes, at most one in_progress item, and keep the list below 6 KiB.")
    };
    let todos = arguments["todos"].as_array().ok_or_else(fail)?;
    let mut ids = HashSet::new();
    let mut active = 0;
    for todo in todos {
        let id = todo["id"].as_str().ok_or_else(fail)?;
        let content = todo["content"].as_str().ok_or_else(fail)?;
        if !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            || !ids.insert(id)
            || content.trim().is_empty()
        {
            return Err(fail());
        }
        active += usize::from(todo["status"] == "in_progress");
    }
    if active > 1 || arguments.to_string().len() > MAX_BYTES {
        return Err(fail());
    }
    let revision = current["revision"].as_u64().ok_or_else(fail)?;
    if arguments["expectedRevision"].as_u64() != Some(revision) {
        return Err(ProviderError::new("todoConflict", "The todo list changed. Read it with read_todos, preserve current work, then write using its revision."));
    }
    Ok(json!({"revision":revision+1,"todos":todos}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_conformance() {
        let fixtures: Value = serde_json::from_str(include_str!("todos.fixtures.json")).unwrap();
        for fixture in fixtures.as_array().unwrap() {
            assert_eq!(
                update(&empty(), &fixture["arguments"]).is_ok(),
                fixture["valid"] == true,
                "{}",
                fixture["name"]
            );
        }
    }
    #[test]
    fn validates_and_rejects_stale_or_ambiguous_lists() {
        let args = json!({"expectedRevision":0,"todos":[{"id":"inspect","content":"Inspect sources","status":"in_progress"}]});
        let saved = update(&empty(), &args).unwrap();
        assert_eq!(saved["revision"], 1);
        assert_eq!(update(&saved, &args).unwrap_err().code, "todoConflict");
        for todos in [
            json!([{"id":"x","content":" ","status":"pending"}]),
            json!([{"id":"../x","content":"A","status":"pending"}]),
            json!([{"id":"x","content":"A","status":"pending"},{"id":"x","content":"B","status":"pending"}]),
            json!([{"id":"x","content":"A","status":"in_progress"},{"id":"y","content":"B","status":"in_progress"}]),
            json!([{"id":"x","content":"A","status":"completed","extra":true}]),
            json!([{"id":"x","content":"é".repeat(121),"status":"pending"}]),
        ] {
            assert!(update(&empty(), &json!({"expectedRevision":0,"todos":todos})).is_err());
        }
        assert_eq!(
            update(&saved, &json!({"expectedRevision":1,"todos":[]})).unwrap()["revision"],
            2
        );
    }
}
