//! Strict JSON handling for the replay harness.
//!
//! Ports the Go harness helpers `validateBehaviorJSON`, `behaviorITF`, `bequal`
//! and `behaviorKeys`. Generated histories, coordinator replies and evidence
//! files are trust boundaries: an ambiguous document (duplicate member names,
//! non-finite or unsafe integers, trailing content) is rejected instead of being
//! decoded with last-key-wins or silent rounding.

use serde_json::{Map, Value};
use std::collections::HashSet;

/// Largest integer JavaScript represents exactly; ITF integers outside
/// `[-MAX_SAFE_INTEGER, MAX_SAFE_INTEGER]` are rejected.
pub const MAX_SAFE_INTEGER: i64 = 9_007_199_254_740_991;

/// Parses `text` as JSON, rejecting duplicate object member names (compared
/// after unescaping), non-finite numbers and trailing content.
pub fn strict_parse(text: &str) -> Result<Value, String> {
    let value: Value =
        serde_json::from_str(text).map_err(|error| format!("invalid JSON: {error}"))?;
    check_duplicate_keys(text.as_bytes())?;
    check_finite(&value)?;
    Ok(value)
}

/// Decodes every `{"#bigint":"..."}` object into a JSON number after checking
/// it is a safe integer, and rejects NaN, infinities and unsafe plain numbers.
pub fn decode_itf(value: Value) -> Result<Value, String> {
    match value {
        Value::Object(map) => {
            if let Some(raw) = map.get("#bigint") {
                if map.len() != 1 {
                    return Err("malformed ITF integer".to_string());
                }
                let parsed = raw.as_str().and_then(|text| text.parse::<i64>().ok());
                return match parsed {
                    Some(n) if (-MAX_SAFE_INTEGER..=MAX_SAFE_INTEGER).contains(&n) => {
                        Ok(Value::from(n))
                    }
                    _ => Err("unsafe ITF integer".to_string()),
                };
            }
            let mut out = Map::new();
            for (key, item) in map {
                out.insert(key, decode_itf(item)?);
            }
            Ok(Value::Object(out))
        }
        Value::Array(items) => items
            .into_iter()
            .map(decode_itf)
            .collect::<Result<Vec<_>, _>>()
            .map(Value::Array),
        Value::Number(ref number) => match number.as_f64() {
            Some(n) if n.is_finite() && n.abs() <= MAX_SAFE_INTEGER as f64 => Ok(value),
            _ => Err("unsafe JSON number".to_string()),
        },
        other => Ok(other),
    }
}

/// Compares two JSON values, treating numbers numerically (`1 == 1.0`) and
/// everything else structurally. `null`, `false`, `0`, `""` and `[]` are all
/// distinct from each other.
pub fn json_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Null, Value::Null) => true,
        (Value::Bool(x), Value::Bool(y)) => x == y,
        (Value::Number(x), Value::Number(y)) => match (x.as_f64(), y.as_f64()) {
            (Some(x), Some(y)) => x == y,
            _ => false,
        },
        (Value::String(x), Value::String(y)) => x == y,
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(a, b)| json_equal(a, b))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(key, value)| y.get(key).is_some_and(|other| json_equal(value, other)))
        }
        _ => false,
    }
}

/// Joins an object's member names in sorted order with commas, like the Go
/// harness's `behaviorKeys`; used for exact envelope and reply shape checks.
pub fn sorted_keys(object: &Map<String, Value>) -> String {
    let mut keys: Vec<&str> = object.keys().map(String::as_str).collect();
    keys.sort_unstable();
    keys.join(",")
}

/// Sorted keys of `value` when it is an object, otherwise the empty string.
pub fn keys_of(value: &Value) -> String {
    value.as_object().map(sorted_keys).unwrap_or_default()
}

fn check_finite(value: &Value) -> Result<(), String> {
    match value {
        Value::Number(number) => match number.as_f64() {
            Some(n) if n.is_finite() => Ok(()),
            _ => Err("non-finite JSON number".to_string()),
        },
        Value::Array(items) => items.iter().try_for_each(check_finite),
        Value::Object(map) => map.values().try_for_each(check_finite),
        _ => Ok(()),
    }
}

/// Second walk over syntactically valid JSON that checks duplicate object member
/// names without allocating every scalar. Escaped names are decoded before
/// comparison so `"a"` and its `\u0061` escape spell the same member name.
fn check_duplicate_keys(raw: &[u8]) -> Result<(), String> {
    let mut walker = Walker { raw, at: 0 };
    walker.walk()
}

struct Walker<'a> {
    raw: &'a [u8],
    at: usize,
}

impl Walker<'_> {
    fn peek(&self) -> Result<u8, String> {
        self.raw
            .get(self.at)
            .copied()
            .ok_or_else(|| "truncated JSON".to_string())
    }

    fn space(&mut self) {
        while self.at < self.raw.len() && matches!(self.raw[self.at], b' ' | b'\n' | b'\r' | b'\t')
        {
            self.at += 1;
        }
    }

    fn quoted(&mut self) -> Result<String, String> {
        let start = self.at;
        self.at += 1;
        let mut escaped = false;
        loop {
            match self.peek()? {
                b'"' => break,
                b'\\' => {
                    escaped = true;
                    self.at += 2;
                }
                _ => self.at += 1,
            }
        }
        self.at += 1;
        let slice = &self.raw[start..self.at];
        if !escaped {
            return std::str::from_utf8(&slice[1..slice.len() - 1])
                .map(str::to_owned)
                .map_err(|error| error.to_string());
        }
        let text = std::str::from_utf8(slice).map_err(|error| error.to_string())?;
        serde_json::from_str::<String>(text).map_err(|error| error.to_string())
    }

    fn walk(&mut self) -> Result<(), String> {
        self.space();
        match self.peek()? {
            b'{' => {
                self.at += 1;
                self.space();
                if self.peek()? == b'}' {
                    self.at += 1;
                    return Ok(());
                }
                let mut seen: HashSet<String> = HashSet::new();
                loop {
                    self.space();
                    let key = self.quoted()?;
                    if !seen.insert(key.clone()) {
                        return Err(format!("duplicate JSON key {key:?}"));
                    }
                    self.space();
                    self.at += 1; // ':'
                    self.walk()?;
                    self.space();
                    if self.peek()? == b'}' {
                        self.at += 1;
                        return Ok(());
                    }
                    self.at += 1; // ','
                }
            }
            b'[' => {
                self.at += 1;
                self.space();
                if self.peek()? == b']' {
                    self.at += 1;
                    return Ok(());
                }
                loop {
                    self.walk()?;
                    self.space();
                    if self.peek()? == b']' {
                        self.at += 1;
                        return Ok(());
                    }
                    self.at += 1; // ','
                }
            }
            b'"' => self.quoted().map(|_| ()),
            _ => {
                while self.at < self.raw.len()
                    && !matches!(
                        self.raw[self.at],
                        b',' | b'}' | b']' | b' ' | b'\n' | b'\r' | b'\t'
                    )
                {
                    self.at += 1;
                }
                Ok(())
            }
        }
    }
}
