//! Local interpreter for `formal/replay/protocol.schema.json`.
//!
//! Ports `readReplaySchema`, `validateReplaySchema`, `matchesReplaySchema`,
//! `replaySchemaType` and `replayObservationError` from the Go harness. Each
//! port interprets the schema mechanics; the shared schema owns the command and
//! observation field lists, so no second copy of them lives here.

use super::json::{json_equal, keys_of, strict_parse, MAX_SAFE_INTEGER};
use serde_json::{Map, Value};
use std::path::PathBuf;

/// Repository-relative location of the shared protocol schema.
pub const SCHEMA_PATH: &str = "formal/replay/protocol.schema.json";

/// Observation definitions a prepare result may name. Every observation the
/// driver reports is validated against the named definition before it is sent.
pub const OBSERVATION_DEFINITIONS: [&str; 3] = [
    "behaviorObservation",
    "coreObservation",
    "localClockObservation",
];

/// Schema keywords the interpreter understands; any other keyword is rejected at
/// load so an unknown constraint cannot be silently ignored.
const KEYWORDS: [&str; 20] = [
    "$schema",
    "$id",
    "$defs",
    "$ref",
    "title",
    "description",
    "oneOf",
    "anyOf",
    "const",
    "enum",
    "type",
    "properties",
    "required",
    "additionalProperties",
    "items",
    "minItems",
    "minimum",
    "maximum",
    "minLength",
    "pattern",
];

/// The loaded protocol schema.
#[derive(Debug, Clone)]
pub struct Schema {
    root: Map<String, Value>,
}

/// Absolute path of the shared schema, resolved from this crate's manifest.
pub fn schema_path() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join(SCHEMA_PATH)
}

impl Schema {
    /// Reads and validates `../formal/replay/protocol.schema.json`.
    pub fn load() -> Result<Schema, String> {
        let path = schema_path();
        let text = std::fs::read_to_string(&path)
            .map_err(|error| format!("{}: {error}", path.display()))?;
        Schema::parse(&text)
    }

    /// Parses schema text, rejecting unsupported keywords and patterns.
    pub fn parse(text: &str) -> Result<Schema, String> {
        let root = match strict_parse(text)? {
            Value::Object(root) => root,
            _ => return Err("replay schema is not an object".to_string()),
        };
        validate_schema_keywords(&root)?;
        validate_patterns(&root)?;
        if !root.get("$defs").is_some_and(Value::is_object) {
            return Err("replay schema lacks $defs".to_string());
        }
        Ok(Schema { root })
    }

    /// The `$defs` table every `$ref` resolves against.
    pub fn defs(&self) -> &Map<String, Value> {
        self.root
            .get("$defs")
            .and_then(Value::as_object)
            .expect("validated at load")
    }

    /// Looks up one `$defs` definition.
    pub fn definition(&self, name: &str) -> Option<&Map<String, Value>> {
        self.defs().get(name).and_then(Value::as_object)
    }

    /// Whether `value` satisfies the named `$defs` definition.
    pub fn matches_definition(&self, value: &Value, name: &str) -> bool {
        self.definition(name)
            .is_some_and(|rule| matches(value, rule, self.defs()))
    }

    /// Validates one driver observation against the definition `prepare` named.
    pub fn observation_error(&self, observed: &Value, definition: &str) -> Result<(), String> {
        observation_error(observed, definition, self.defs())
    }

    /// Whether every input is a well-formed `$defs/command`.
    pub fn commands_valid(&self, inputs: &[Value]) -> bool {
        commands_valid(inputs, self.defs())
    }
}

/// Rejects any keyword outside the supported list, recursively through
/// `$defs`, `properties`, `oneOf`, `anyOf`, `items` and `additionalProperties`.
pub fn validate_schema_keywords(rule: &Map<String, Value>) -> Result<(), String> {
    for key in rule.keys() {
        if !KEYWORDS.contains(&key.as_str()) {
            return Err(format!("unsupported replay schema keyword: {key}"));
        }
    }
    for child in children(rule) {
        validate_schema_keywords(child)?;
    }
    Ok(())
}

fn validate_patterns(rule: &Map<String, Value>) -> Result<(), String> {
    if let Some(pattern) = rule.get("pattern") {
        match pattern.as_str() {
            Some(text) if pattern_supported(text) => {}
            _ => return Err(format!("unsupported replay schema pattern: {pattern}")),
        }
    }
    for child in children(rule) {
        validate_patterns(child)?;
    }
    Ok(())
}

fn children(rule: &Map<String, Value>) -> Vec<&Map<String, Value>> {
    let mut out = Vec::new();
    for key in ["$defs", "properties"] {
        if let Some(table) = rule.get(key).and_then(Value::as_object) {
            out.extend(table.values().filter_map(Value::as_object));
        }
    }
    for key in ["oneOf", "anyOf"] {
        if let Some(options) = rule.get(key).and_then(Value::as_array) {
            out.extend(options.iter().filter_map(Value::as_object));
        }
    }
    for key in ["items", "additionalProperties"] {
        if let Some(child) = rule.get(key).and_then(Value::as_object) {
            out.push(child);
        }
    }
    out
}

/// Whether `value` satisfies `rule`, resolving `#/$defs/<name>` references in `defs`.
pub fn matches(value: &Value, rule: &Map<String, Value>, defs: &Map<String, Value>) -> bool {
    if let Some(reference) = rule.get("$ref").and_then(Value::as_str) {
        let name = reference.strip_prefix("#/$defs/").unwrap_or(reference);
        return match defs.get(name) {
            Some(Value::Object(target)) => matches(value, target, defs),
            Some(_) => matches(value, &Map::new(), defs),
            None => false,
        };
    }
    if let Some(options) = rule.get("oneOf").and_then(Value::as_array) {
        let count = options
            .iter()
            .filter(|option| matches(value, as_rule(option), defs))
            .count();
        if count != 1 {
            return false;
        }
    }
    if let Some(options) = rule.get("anyOf").and_then(Value::as_array) {
        if !options
            .iter()
            .any(|option| matches(value, as_rule(option), defs))
        {
            return false;
        }
    }
    if let Some(constant) = rule.get("const") {
        if !json_equal(value, constant) {
            return false;
        }
    }
    if let Some(options) = rule.get("enum").and_then(Value::as_array) {
        if !options.iter().any(|option| json_equal(value, option)) {
            return false;
        }
    }
    if let Some(expected) = rule.get("type") {
        let matched = match expected {
            Value::String(name) => schema_type(value, name),
            Value::Array(names) => names
                .iter()
                .any(|name| schema_type(value, name.as_str().unwrap_or(""))),
            _ => false,
        };
        if !matched {
            return false;
        }
    }
    match value {
        Value::Number(number) => {
            let n = number.as_f64().unwrap_or(f64::NAN);
            if let Some(minimum) = rule.get("minimum").and_then(Value::as_f64) {
                if n < minimum {
                    return false;
                }
            }
            if let Some(maximum) = rule.get("maximum").and_then(Value::as_f64) {
                if n > maximum {
                    return false;
                }
            }
        }
        Value::String(text) => {
            if let Some(minimum) = rule.get("minLength").and_then(Value::as_f64) {
                if (text.chars().count() as f64) < minimum.trunc() {
                    return false;
                }
            }
            if let Some(pattern) = rule.get("pattern") {
                if !pattern
                    .as_str()
                    .is_some_and(|pattern| pattern_matches(pattern, text))
                {
                    return false;
                }
            }
        }
        Value::Array(items) => {
            if let Some(minimum) = rule.get("minItems").and_then(Value::as_f64) {
                if (items.len() as f64) < minimum.trunc() {
                    return false;
                }
            }
            if let Some(schema) = rule.get("items").and_then(Value::as_object) {
                if !items.iter().all(|item| matches(item, schema, defs)) {
                    return false;
                }
            }
        }
        Value::Object(members) => {
            if let Some(required) = rule.get("required").and_then(Value::as_array) {
                if !required
                    .iter()
                    .all(|key| members.contains_key(key.as_str().unwrap_or("")))
                {
                    return false;
                }
            }
            let empty = Map::new();
            let properties = rule
                .get("properties")
                .and_then(Value::as_object)
                .unwrap_or(&empty);
            let additional = rule.get("additionalProperties");
            for (key, item) in members {
                if let Some(property) = properties.get(key) {
                    if !matches(item, as_rule(property), defs) {
                        return false;
                    }
                } else if additional == Some(&Value::Bool(false)) {
                    return false;
                } else if let Some(schema) = additional.and_then(Value::as_object) {
                    if !matches(item, schema, defs) {
                        return false;
                    }
                }
            }
        }
        _ => {}
    }
    true
}

fn as_rule(value: &Value) -> &Map<String, Value> {
    static EMPTY: std::sync::OnceLock<Map<String, Value>> = std::sync::OnceLock::new();
    value
        .as_object()
        .unwrap_or_else(|| EMPTY.get_or_init(Map::new))
}

/// JSON Schema primitive type check; `integer` means a finite integral number.
pub fn schema_type(value: &Value, expected: &str) -> bool {
    match expected {
        "null" => value.is_null(),
        "object" => value.is_object(),
        "array" => value.is_array(),
        "string" => value.is_string(),
        "boolean" => value.is_boolean(),
        "integer" | "number" => match value.as_f64() {
            Some(n) => n.is_finite() && (expected == "number" || n.trunc() == n),
            None => false,
        },
        _ => false,
    }
}

/// Validates one driver observation against the `$defs` definition the prepare
/// result named. The diagnostic names the record's keys, never its values, and
/// carries no `expected:`/`actual:` markers: a shape defect is infrastructure
/// evidence, not a mutation detection.
pub fn observation_error(
    observed: &Value,
    definition: &str,
    defs: &Map<String, Value>,
) -> Result<(), String> {
    let target = match defs.get(definition) {
        Some(Value::Object(target)) if OBSERVATION_DEFINITIONS.contains(&definition) => target,
        _ => {
            return Err(format!(
                "unknown replay observation definition {definition:?}"
            ))
        }
    };
    if !matches(observed, target, defs) {
        return Err(format!(
            "driver produced a malformed {definition} observation: keys [{}]",
            keys_of(observed)
        ));
    }
    Ok(())
}

/// Whether every input is a well-formed `$defs/command`.
pub fn commands_valid(inputs: &[Value], defs: &Map<String, Value>) -> bool {
    match defs.get("command") {
        Some(Value::Object(command)) => inputs.iter().all(|input| matches(input, command, defs)),
        _ => false,
    }
}

/// Whether `value` is a whole number in `[minimum, MAX_SAFE_INTEGER]`, the
/// check the transport applies to step counts and indices.
pub fn safe_index(value: Option<&Value>, minimum: i64) -> bool {
    match value.and_then(Value::as_f64) {
        Some(n) => n >= minimum as f64 && n <= MAX_SAFE_INTEGER as f64 && n.trunc() == n,
        None => false,
    }
}

// The schema uses exactly two regular expressions. They are matched by hand so
// the harness needs no regex dependency; `validate_patterns` fails loading if
// the schema ever gains another one.
const POSITIVE_INTEGER: &str = "^[1-9][0-9]*$";
const CALL_ERROR: &str = "^(source|timeout):(0|[1-9][0-9]*)$|^unexpected:";

fn pattern_supported(pattern: &str) -> bool {
    pattern == POSITIVE_INTEGER || pattern == CALL_ERROR
}

fn pattern_matches(pattern: &str, text: &str) -> bool {
    match pattern {
        POSITIVE_INTEGER => positive_integer(text),
        CALL_ERROR => {
            if text.starts_with("unexpected:") {
                return true;
            }
            ["source:", "timeout:"]
                .iter()
                .filter_map(|prefix| text.strip_prefix(prefix))
                .any(|rest| rest == "0" || positive_integer(rest))
        }
        _ => false,
    }
}

fn positive_integer(text: &str) -> bool {
    let mut chars = text.chars();
    matches!(chars.next(), Some('1'..='9')) && chars.all(|c| c.is_ascii_digit())
}
