//! Portable validation for the closed Work tool schema subset. Unknown schema types fail closed.
use lori_work_provider::ProviderError;
use serde_json::Value;

pub fn normalize(schema: &Value, value: &mut Value) {
    if let (Some(properties), Some(object)) =
        (schema["properties"].as_object(), value.as_object_mut())
    {
        let required = schema["required"].as_array();
        for (key, property) in properties {
            let mandatory = required.is_some_and(|fields| fields.iter().any(|field| field == key));
            let omitted = !mandatory
                && object.get(key).is_some_and(|v| {
                    (v.is_null() && validate(property, v).is_err())
                        || (matches!(
                            key.as_str(),
                            "reference"
                                | "jobId"
                                | "versionId"
                                | "cwd"
                                | "sheet"
                                | "pluginId"
                                | "expectedHash"
                        ) && v.as_str().is_some_and(|s| s.trim().is_empty()))
                });
            if omitted {
                object.remove(key);
            } else if let Some(child) = object.get_mut(key) {
                normalize(property, child);
            }
        }
    } else if let Some(items) = value.as_array_mut() {
        if schema["items"].is_object() {
            for item in items {
                normalize(&schema["items"], item);
            }
        }
    }
}

pub fn validate(schema: &Value, value: &Value) -> Result<(), ProviderError> {
    let fail = || {
        ProviderError::new(
            "invalidArguments",
            "The tool arguments do not match its schema.",
        )
    };
    if let Some(options) = schema["anyOf"].as_array() {
        return if options.iter().any(|option| validate(option, value).is_ok()) {
            Ok(())
        } else {
            Err(fail())
        };
    }
    if let Some(types) = schema["type"].as_array() {
        return if types.iter().any(|kind| {
            let mut single = schema.clone();
            single["type"] = kind.clone();
            validate(&single, value).is_ok()
        }) {
            Ok(())
        } else {
            Err(fail())
        };
    }
    let valid_type = match schema["type"].as_str() {
        Some("object") => value.is_object(),
        Some("string") => value.is_string(),
        Some("integer") => value.as_u64().is_some(),
        Some("number") => value.as_f64().is_some_and(f64::is_finite),
        Some("array") => value.is_array(),
        Some("boolean") => value.is_boolean(),
        Some("null") => value.is_null(),
        _ => false,
    };
    if !valid_type {
        return Err(fail());
    }
    if let Some(options) = schema["enum"].as_array() {
        if !options.contains(value) {
            return Err(fail());
        }
    }
    if let Some(s) = value.as_str() {
        if s.len() < schema["minLength"].as_u64().unwrap_or(0) as usize
            || s.len() > schema["maxLength"].as_u64().unwrap_or(1048576) as usize
            || s.contains('\0')
        {
            return Err(fail());
        }
    }
    if schema["type"] == "number" {
        let n = value.as_f64().ok_or_else(fail)?;
        if n < schema["minimum"].as_f64().unwrap_or(f64::NEG_INFINITY)
            || n > schema["maximum"].as_f64().unwrap_or(f64::INFINITY)
        {
            return Err(fail());
        }
    }
    if schema["type"] == "integer" {
        let n = value.as_u64().ok_or_else(fail)?;
        if n < schema["minimum"].as_u64().unwrap_or(0)
            || n > schema["maximum"].as_u64().unwrap_or(u64::MAX)
        {
            return Err(fail());
        }
    }
    if let Some(items) = value.as_array() {
        if items.len() < schema["minItems"].as_u64().unwrap_or(0) as usize
            || items.len() > schema["maxItems"].as_u64().unwrap_or(200) as usize
        {
            return Err(fail());
        }
        for item in items {
            validate(&schema["items"], item)?;
        }
    }
    if let Some(object) = value.as_object() {
        if let Some(required) = schema["required"].as_array() {
            for key in required {
                if !object.contains_key(key.as_str().ok_or_else(fail)?) {
                    return Err(fail());
                }
            }
        }
        for (key, value) in object {
            if let Some(property) = schema["properties"].get(key) {
                validate(property, value)?;
            } else if schema["additionalProperties"] != true {
                return Err(fail());
            }
        }
    }
    Ok(())
}
