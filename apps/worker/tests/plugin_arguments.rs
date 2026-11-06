use lori_work_core::schema;
use serde_json::{json, Value};

#[test]
fn cloud_mcp_call_accepts_nonempty_remote_arguments_without_opening_its_envelope() {
    // Exported from the real Cloud API definition; an API test checks it for drift.
    let definition: Value =
        serde_json::from_str(include_str!("fixtures/cloud-plugin-tool.json")).unwrap();
    let mut call = json!({
        "pluginId": "linear",
        "connectionId": "2d05f41b-cc20-49e1-b413-00525235104b",
        "connectionRevision": 3,
        "name": "list_teams",
        "schemaHash": "a".repeat(64),
        "arguments": { "limit": 1, "includeArchived": false, "filter": {"name": null}, "ids": ["example"] }
    });
    schema::normalize(&definition["parameters"], &mut call);
    assert!(schema::validate(&definition["parameters"], &call).is_ok());
    call["unexpectedEnvelopeField"] = json!(true);
    assert!(schema::validate(&definition["parameters"], &call).is_err());
    call.as_object_mut()
        .unwrap()
        .remove("unexpectedEnvelopeField");
    call["arguments"] = json!("not an object");
    assert!(schema::validate(&definition["parameters"], &call).is_err());
}
