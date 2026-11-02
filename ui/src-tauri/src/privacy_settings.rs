//! Shared build-time validation, also exercised by native unit tests.
pub fn builtin_enabled(raw: &str) -> Result<bool, String> {
    let value: serde_json::Value =
        serde_json::from_str(raw).map_err(|e| format!("Invalid log-privacy.json: {e}"))?;
    let object = value.as_object().ok_or("Invalid log privacy settings")?;
    if object.keys().any(|key| {
        !key.starts_with("_comment") && !matches!(key.as_str(), "builtinProfile" | "endpointAlias")
    }) {
        return Err("Unknown log privacy field".into());
    }
    if object.get("endpointAlias").is_some_and(|v| !v.is_null()) {
        return Err("endpointAlias is obsolete; use builtinProfile.enabled (true or false)".into());
    }
    let Some(builtin) = object.get("builtinProfile") else {
        // Existing null legacy settings retain the previous, unmasked behavior.
        return Ok(false);
    };
    let builtin = builtin
        .as_object()
        .ok_or("builtinProfile must be an object")?;
    if builtin
        .keys()
        .any(|key| key != "enabled" && !key.starts_with("_comment"))
    {
        return Err("Unknown builtinProfile privacy field".into());
    }
    builtin
        .get("enabled")
        .and_then(|v| v.as_bool())
        .ok_or_else(|| "builtinProfile.enabled must be a boolean (true or false)".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_switches_comments_and_disabled_legacy_settings() {
        for (raw, expected) in [
            (
                r#"{"builtinProfile":{"enabled":true,"_comment":"开启"}}"#,
                true,
            ),
            (
                r#"{"_comment":"说明","builtinProfile":{"enabled":false}}"#,
                false,
            ),
            (r#"{"endpointAlias":null}"#, false),
            ("{}", false),
        ] {
            assert_eq!(builtin_enabled(raw).unwrap(), expected);
        }
    }

    #[test]
    fn rejects_ambiguous_or_misspelled_settings() {
        for raw in [
            "null",
            "[]",
            "{",
            r#"{"enabled":true}"#,
            r#"{"builtinProfile":null}"#,
            r#"{"builtinProfile":{}}"#,
            r#"{"builtinProfile":{"enabled":"false"}}"#,
            r#"{"builtinProfile":{"enabled":1}}"#,
            r#"{"builtinProfile":{"enabled":true,"enabeld":false}}"#,
            r#"{"endpointAlias":"demo.vpn"}"#,
        ] {
            assert!(builtin_enabled(raw).is_err(), "{raw}");
        }
    }
}
