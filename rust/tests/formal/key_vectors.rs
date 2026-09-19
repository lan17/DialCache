//! Replay of the key, invalid-key, argument-normalization and rollout vector
//! groups against `dialcache::identity`.
//!
//! Include from a test binary alongside `fixtures.rs`:
//! `#[path = "formal/fixtures.rs"] mod fixtures;`
//! `#[path = "formal/key_vectors.rs"] mod key_vectors;`

#![allow(dead_code)]

use std::collections::BTreeMap;

use dialcache::identity::{cohort, cohort_hash, normalize_args, ArgValue, Identity};
use serde_json::Value;

use super::fixtures::LONE_SURROGATE_MARKER;

fn identity_from(value: &Value) -> Result<Identity, String> {
    serde_json::from_value(value.clone())
        .map_err(|error| format!("identity input does not parse: {error}"))
}

fn components(identity: &Identity) -> impl Iterator<Item = &str> {
    [
        identity.namespace.as_str(),
        identity.key_type.as_str(),
        identity.id.as_str(),
        identity.use_case.as_str(),
    ]
    .into_iter()
    .chain(
        identity
            .args
            .iter()
            .flat_map(|(name, value)| [name.as_str(), value.as_str()]),
    )
}

fn expected_str(value: &Value, field: &str) -> Result<Option<String>, String> {
    match value.get(field) {
        None | Some(Value::Null) => Ok(None),
        Some(Value::String(text)) => Ok(Some(text.clone())),
        Some(other) => Err(format!("{field} is neither a string nor null: {other}")),
    }
}

/// `keyVectors`: `keys()` must succeed and equal `logicalKey`, `valueKey` and `watermarkKey`.
pub fn check_key_vector(vector: &Value) -> Result<(), String> {
    let identity = identity_from(&vector["input"])?;
    let keys = identity
        .keys()
        .map_err(|error| format!("keys rejected a valid identity: {error}"))?;
    let logical = expected_str(vector, "logicalKey")?.ok_or("logicalKey missing")?;
    let value = expected_str(vector, "valueKey")?.ok_or("valueKey missing")?;
    let watermark = expected_str(vector, "watermarkKey")?;
    if keys.logical != logical {
        return Err(format!(
            "logical key {:?} != expected {logical:?}",
            keys.logical
        ));
    }
    if keys.value != value {
        return Err(format!("value key {:?} != expected {value:?}", keys.value));
    }
    if keys.watermark != watermark {
        return Err(format!(
            "watermark key {:?} != expected {watermark:?}",
            keys.watermark
        ));
    }
    Ok(())
}

/// Decode one `inputUtf16` field: `Ok(None)` when the units are not valid UTF-16.
fn utf16_field(value: &Value, what: &str) -> Result<Option<String>, String> {
    let units = value
        .as_array()
        .ok_or_else(|| format!("inputUtf16 {what} is not an array"))?;
    let units: Vec<u16> = units
        .iter()
        .map(|unit| {
            unit.as_u64()
                .and_then(|unit| u16::try_from(unit).ok())
                .ok_or_else(|| format!("inputUtf16 {what} has an invalid unit {unit}"))
        })
        .collect::<Result<_, _>>()?;
    Ok(String::from_utf16(&units).ok())
}

/// Rebuild the identity from `inputUtf16` code units, keeping the tracking
/// flag of the parsed input; `Ok(None)` when any field is not valid UTF-16.
fn identity_from_utf16(raw: &Value, tracked: bool) -> Result<Option<Identity>, String> {
    let Some(namespace) = utf16_field(&raw["namespace"], "namespace")? else {
        return Ok(None);
    };
    let Some(key_type) = utf16_field(&raw["keyType"], "keyType")? else {
        return Ok(None);
    };
    let Some(id) = utf16_field(&raw["id"], "id")? else {
        return Ok(None);
    };
    let Some(use_case) = utf16_field(&raw["useCase"], "useCase")? else {
        return Ok(None);
    };
    let mut args = Vec::new();
    for pair in raw["args"]
        .as_array()
        .ok_or("inputUtf16 args is not an array")?
    {
        let pair = pair
            .as_array()
            .filter(|pair| pair.len() == 2)
            .ok_or("inputUtf16 args entry is not a pair")?;
        let Some(name) = utf16_field(&pair[0], "argument name")? else {
            return Ok(None);
        };
        let Some(value) = utf16_field(&pair[1], "argument value")? else {
            return Ok(None);
        };
        args.push((name, value));
    }
    Ok(Some(Identity {
        namespace,
        key_type,
        id,
        use_case,
        tracked,
        args,
    }))
}

/// `invalidKeyVectors`: the identity must be rejected. A component carrying
/// [`LONE_SURROGATE_MARKER`] was already rejected while decoding the fixture,
/// which the protocol allows for scalar-only string types; every other input
/// must make `keys()` fail. When `inputUtf16` is present the identity is also
/// rebuilt from code units and must fail either UTF-16 decoding or `keys()`.
pub fn check_invalid_key_vector(vector: &Value) -> Result<(), String> {
    let identity = identity_from(&vector["input"])?;
    let unrepresentable =
        components(&identity).any(|component| component.contains(LONE_SURROGATE_MARKER));
    if !unrepresentable && identity.keys().is_ok() {
        return Err("invalid key accepted".to_owned());
    }
    if let Some(raw) = vector.get("inputUtf16") {
        if let Some(rebuilt) = identity_from_utf16(raw, identity.tracked)? {
            if rebuilt.keys().is_ok() {
                return Err("invalid key rebuilt from UTF-16 units accepted".to_owned());
            }
        }
    }
    Ok(())
}

fn arg_from_json(value: &Value) -> Result<ArgValue, String> {
    Ok(match value {
        Value::Null => ArgValue::Null,
        Value::Bool(flag) => ArgValue::Bool(*flag),
        Value::Number(number) => match number.as_i64() {
            Some(integer) => ArgValue::Int(integer),
            None => ArgValue::Number(
                number
                    .as_f64()
                    .ok_or_else(|| format!("number {number} is not representable"))?,
            ),
        },
        Value::String(text) => ArgValue::Str(text.clone()),
        other => return Err(format!("unsupported normalizeArgs input {other}")),
    })
}

/// `normalizeArgsVectors`: build the host record (sentinel strings become
/// `Absent`, `bigintArgs` become `BigInt`, `specialArgs` become `Number`) and
/// require exactly the expected ordered pairs.
pub fn check_normalize_args_vector(vector: &Value) -> Result<(), String> {
    let sentinel = vector.get("undefinedSentinel").and_then(Value::as_str);
    let mut record: BTreeMap<String, ArgValue> = BTreeMap::new();
    for (name, value) in vector["input"]
        .as_object()
        .ok_or("input is not an object")?
    {
        let arg = match (value.as_str(), sentinel) {
            (Some(text), Some(sentinel)) if text == sentinel => ArgValue::Absent,
            _ => arg_from_json(value)?,
        };
        record.insert(name.clone(), arg);
    }
    if let Some(bigints) = vector.get("bigintArgs") {
        for (name, text) in bigints.as_object().ok_or("bigintArgs is not an object")? {
            let text = text
                .as_str()
                .ok_or_else(|| format!("bigintArgs {name} is not a string"))?;
            record.insert(name.clone(), ArgValue::BigInt(text.to_owned()));
        }
    }
    if let Some(specials) = vector.get("specialArgs") {
        for (name, text) in specials.as_object().ok_or("specialArgs is not an object")? {
            let text = text
                .as_str()
                .ok_or_else(|| format!("specialArgs {name} is not a string"))?;
            let number: f64 = text
                .parse()
                .map_err(|error| format!("specialArgs {name} {text:?} is not a number: {error}"))?;
            record.insert(name.clone(), ArgValue::Number(number));
        }
    }
    let expected: Vec<(String, String)> = serde_json::from_value(vector["expected"].clone())
        .map_err(|error| format!("expected pairs do not parse: {error}"))?;
    let actual =
        normalize_args(record).map_err(|error| format!("normalize_args failed: {error}"))?;
    if actual != expected {
        return Err(format!("normalized {actual:?} != expected {expected:?}"));
    }
    Ok(())
}

/// `rampVectors`: the cohort of the logical key and `layer` must equal `sample`
/// exactly, and the FNV-1a numerator must equal `hashNumerator` when present.
pub fn check_ramp_vector(vector: &Value) -> Result<(), String> {
    let identity = identity_from(&vector["input"])?;
    let keys = identity
        .keys()
        .map_err(|error| format!("keys rejected the ramp identity: {error}"))?;
    let layer = vector["layer"].as_str().ok_or("layer missing")?;
    let sample = vector["sample"].as_f64().ok_or("sample missing")?;
    let actual = cohort(&keys.logical, layer);
    if actual != sample {
        return Err(format!("cohort {actual:.17} != expected {sample:.17}"));
    }
    if let Some(numerator) = vector.get("hashNumerator") {
        let numerator = numerator
            .as_u64()
            .ok_or("hashNumerator is not an unsigned integer")?;
        let hash = u64::from(cohort_hash(&keys.logical, layer));
        if hash != numerator {
            return Err(format!("hash numerator {hash} != expected {numerator}"));
        }
    }
    Ok(())
}
