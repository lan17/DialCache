//! Runners for the frame, decode, timestamp, duration and envelope vector
//! groups of the portable protocol corpus. Each mirrors the corresponding
//! part of `go/protocol_test.go` field for field.

use dialcache::limits::MAX_DECOMPRESSED_BYTES;
use dialcache::observe::CompressionOutcome;
use dialcache::protocol::{
    ceil_supported_cache_ttl_ms, compress_payload, decode_frame, decompress_payload, encode_frame,
    escape_raw_payload, validate_timestamp_ms, CompressionConfig, ProtocolError,
    MARKER_ZSTD_BINARY, MARKER_ZSTD_UTF8,
};
use dialcache::{Frame, Payload, ReadResult};
use serde_json::{json, Value};

use super::fixtures::LONE_SURROGATE_MARKER;

/// The fixture level every `codecBytes` entry was measured at.
const FIXTURE_ZSTD_LEVEL: i32 = 3;

fn field<'a>(vector: &'a Value, name: &str) -> Result<&'a Value, String> {
    vector
        .get(name)
        .ok_or_else(|| format!("missing field {name}"))
}

fn text_field<'a>(vector: &'a Value, name: &str) -> Result<&'a str, String> {
    field(vector, name)?
        .as_str()
        .ok_or_else(|| format!("field {name} is not a string"))
}

fn unhex(text: &str) -> Result<Vec<u8>, String> {
    hex::decode(text).map_err(|error| format!("invalid hex {text:?}: {error}"))
}

fn usize_field(vector: &Value, name: &str) -> Result<usize, String> {
    let number = field(vector, name)?
        .as_u64()
        .ok_or_else(|| format!("field {name} is not an unsigned integer"))?;
    usize::try_from(number).map_err(|_| format!("field {name} exceeds usize"))
}

/// The `payloadType` / `payloadUtf8` / `payloadHex` triple as a payload.
/// `replace_lone_surrogates` applies the binding's input conversion: an
/// unpaired UTF-16 surrogate in caller text becomes U+FFFD.
fn vector_payload(vector: &Value, replace_lone_surrogates: bool) -> Result<Payload, String> {
    match text_field(vector, "payloadType")? {
        "binary" => Ok(Payload::binary(unhex(text_field(vector, "payloadHex")?)?)),
        "string" => {
            let text = text_field(vector, "payloadUtf8")?;
            if replace_lone_surrogates {
                Ok(Payload::text(
                    text.replace(LONE_SURROGATE_MARKER, "\u{FFFD}"),
                ))
            } else {
                Ok(Payload::text(text))
            }
        }
        other => Err(format!("unknown payloadType {other:?}")),
    }
}

/// A numeric fixture input; JSON carries nonfinite values as `specialInput`.
fn number_input(vector: &Value) -> Result<f64, String> {
    match vector.get("specialInput").and_then(Value::as_str) {
        Some("NaN") => Ok(f64::NAN),
        Some("Infinity") => Ok(f64::INFINITY),
        Some("-Infinity") => Ok(f64::NEG_INFINITY),
        Some(other) => Err(format!("unknown specialInput {other:?}")),
        None => field(vector, "input")?
            .as_f64()
            .ok_or_else(|| "input is not a number".to_string()),
    }
}

fn outcome_name(outcome: Option<CompressionOutcome>) -> &'static str {
    outcome.map_or("passthrough", CompressionOutcome::as_str)
}

fn max_decompressed_bytes(vector: &Value) -> Result<usize, String> {
    match vector.get("maxDecompressedBytes") {
        None | Some(Value::Null) => Ok(MAX_DECOMPRESSED_BYTES),
        Some(_) => usize_field(vector, "maxDecompressedBytes"),
    }
}

/// `frameVectors`: encoding a payload with a stamp yields the exact frame bytes.
pub fn check_frame_vector(vector: &Value) -> Result<(), String> {
    let created_at_ms = field(vector, "createdAtMs")?
        .as_u64()
        .ok_or("createdAtMs is not an unsigned integer")?;
    let payload = vector_payload(vector, true)?;
    let frame = encode_frame(&Frame {
        created_at_ms,
        payload,
    })
    .map_err(|error| format!("encode failed: {error}"))?;
    let actual = hex::encode(&frame);
    let expected = text_field(vector, "frameHex")?;
    if actual != expected {
        return Err(format!("frame: got {actual}, want {expected}"));
    }
    Ok(())
}

pub fn check_tracked_decode_vector(vector: &Value) -> Result<(), String> {
    check_decode_vector(vector, true)
}

pub fn check_untracked_decode_vector(vector: &Value) -> Result<(), String> {
    check_decode_vector(vector, false)
}

/// `trackedDecodeVectors` / `untrackedDecodeVectors`: `frameHex` null is an
/// absent value and `""` a present empty one; `watermarkUtf8` null is absent.
/// The classified result is compared with `expected` as JSON, retaining
/// integer precision.
fn check_decode_vector(vector: &Value, tracked: bool) -> Result<(), String> {
    let raw = match field(vector, "frameHex")? {
        Value::Null => None,
        Value::String(text) => Some(unhex(text)?),
        _ => return Err("frameHex is neither null nor a string".to_string()),
    };
    let watermark = match vector.get("watermarkUtf8").unwrap_or(&Value::Null) {
        Value::Null => None,
        Value::String(text) => Some(text.as_bytes().to_vec()),
        _ => return Err("watermarkUtf8 is neither null nor a string".to_string()),
    };
    let actual = match decode_frame(raw.as_deref(), tracked, watermark.as_deref()) {
        Err(ProtocolError::PayloadEncoding) => json!({ "kind": "payload_encoding_error" }),
        Err(other) => return Err(format!("unexpected decode error {other}")),
        Ok(ReadResult::Miss {
            reason,
            observed_watermark_ms,
        }) => {
            let mut object = json!({ "kind": "miss", "reason": reason.as_str() });
            if let Some(fence) = observed_watermark_ms {
                object["observedWatermarkMs"] = json!(fence);
            }
            object
        }
        Ok(ReadResult::Hit(frame)) => {
            let mut object = json!({ "kind": "hit", "createdAtMs": frame.created_at_ms });
            if frame.payload.binary {
                object["payloadType"] = json!("binary");
                object["payloadHex"] = json!(hex::encode(&frame.payload.bytes));
            } else {
                object["payloadType"] = json!("string");
                let text = String::from_utf8(frame.payload.bytes)
                    .map_err(|_| "text payload is not UTF-8")?;
                object["payloadUtf8"] = json!(text);
            }
            object
        }
    };
    let expected = field(vector, "expected")?;
    if &actual != expected {
        return Err(format!("got {actual}\nwant {expected}"));
    }
    Ok(())
}

/// `invalidTimestampVectors`: every input is outside the timestamp domain.
pub fn check_invalid_timestamp_vector(vector: &Value) -> Result<(), String> {
    match validate_timestamp_ms(number_input(vector)?) {
        Ok(accepted) => Err(format!("invalid timestamp accepted as {accepted}")),
        Err(_) => Ok(()),
    }
}

/// `durationVectors`: `expected` null rejects; otherwise the ceiled TTL.
pub fn check_duration_vector(vector: &Value) -> Result<(), String> {
    let result = ceil_supported_cache_ttl_ms(number_input(vector)?);
    match (field(vector, "expected")?.as_u64(), result) {
        (None, Err(_)) => Ok(()),
        (None, Ok(accepted)) => Err(format!("invalid duration accepted as {accepted}")),
        (Some(expected), Ok(actual)) if actual == expected => Ok(()),
        (Some(expected), other) => Err(format!("got {other:?} want {expected}")),
    }
}

/// `envelopeVectors`: escaping, unconditional read interpretation and the
/// escape round trip over raw binary input.
pub fn check_envelope_vector(vector: &Value) -> Result<(), String> {
    let raw = Payload::binary(unhex(text_field(vector, "inputHex")?)?);
    let escaped = escape_raw_payload(raw.clone());
    if escaped.bytes != unhex(text_field(vector, "escapedHex")?)? {
        return Err(format!("escape differs: {}", hex::encode(&escaped.bytes)));
    }
    let decoded = decompress_payload(raw.clone(), MAX_DECOMPRESSED_BYTES);
    let expected_outcome = text_field(vector, "outcome")?;
    if outcome_name(decoded.outcome) != expected_outcome
        || !decoded.payload.binary
        || decoded.payload.bytes != unhex(text_field(vector, "decodedHex")?)?
    {
        return Err(format!(
            "decoded {decoded:?}, want {expected_outcome} {}",
            text_field(vector, "decodedHex")?
        ));
    }
    if decompress_payload(escaped, MAX_DECOMPRESSED_BYTES)
        .payload
        .bytes
        != raw.bytes
    {
        return Err("escape roundtrip differs".to_string());
    }
    Ok(())
}

/// `compressedDecodeVectors`: the native decoder confirms the environmental
/// `codecFixture`, then the wrapper's outcome, type and bytes are checked
/// under the optional per-call cap.
pub fn check_compressed_decode_vector(vector: &Value) -> Result<(), String> {
    let input = unhex(text_field(vector, "inputHex")?)?;
    if let Some(fixture) = vector
        .get("codecFixture")
        .filter(|fixture| !fixture.is_null())
    {
        let succeeds = field(fixture, "succeeds")?
            .as_bool()
            .ok_or("codecFixture.succeeds is not a boolean")?;
        let native = zstd::decode_all(input.get(1..).unwrap_or_default());
        match (succeeds, native) {
            (true, Ok(decoded)) if decoded == unhex(text_field(fixture, "decodedHex")?)? => {}
            (true, other) => return Err(format!("native codec fixture differs: {other:?}")),
            (false, Ok(decoded)) => {
                return Err(format!(
                    "native decoder accepted rejected fixture: {}",
                    hex::encode(decoded)
                ))
            }
            (false, Err(_)) => {}
        }
    }
    let got = decompress_payload(Payload::binary(input), max_decompressed_bytes(vector)?);
    let want = vector_payload(vector, false)?;
    let outcome = vector
        .get("outcome")
        .and_then(Value::as_str)
        .unwrap_or("decompressed");
    if outcome_name(got.outcome) != outcome || got.payload != want {
        return Err(format!("got {got:?} want {outcome} {want:?}"));
    }
    Ok(())
}

/// `compressionWriteVectors`: when this binding's native level-3 encoder
/// reproduces the TypeScript fixture length, the TypeScript per-binding
/// expectations apply; otherwise only the generic outcome and the selection
/// rule are checked. Every result must round-trip and respect the escape rule.
pub fn check_compression_write_vector(vector: &Value) -> Result<(), String> {
    let name = vector
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("<unnamed>");
    let raw = vector_payload(vector, false)?;
    let escaped = escape_raw_payload(raw.clone());
    let threshold_bytes = usize_field(vector, "thresholdBytes")?;
    let max = max_decompressed_bytes(vector)?;

    let mut modeled = None;
    if let Some(codec_bytes) = vector.get("codecBytes").filter(|codec| !codec.is_null()) {
        let fixture = usize_field(codec_bytes, "typescript")?;
        let native = native_zstd_len(&raw.bytes)?;
        if native == fixture {
            modeled = Some(field(field(vector, "expectedByBinding")?, "typescript")?);
            println!("compressionWriteVectors {name}: native level-3 length {native} matches the TypeScript fixture; using its expectations");
        } else {
            println!("compressionWriteVectors {name}: native level-3 length {native} differs from the TypeScript fixture {fixture}; checking the generic outcome and selection rule only");
        }
    }

    let got = compress_payload(
        raw.clone(),
        &CompressionConfig {
            threshold_bytes,
            level: FIXTURE_ZSTD_LEVEL,
        },
        max,
    )
    .map_err(|error| format!("compress failed: {error}"))?;
    let expected_outcome = match modeled {
        Some(expected) => text_field(expected, "outcome")?,
        None => text_field(vector, "outcome")?,
    };
    if got.outcome.as_str() != expected_outcome {
        return Err(format!(
            "got outcome {} want {expected_outcome} ({got:?})",
            got.outcome
        ));
    }
    if let Some(expected) = modeled {
        let stored = usize_field(expected, "storedBytes")?;
        if got.stored_bytes != stored {
            return Err(format!("storedBytes {} want {stored}", got.stored_bytes));
        }
        if vector.get("originalBytes").is_none()
            || vector.get("rawStoredBytes").is_none()
            || vector.get("escapedHex").is_none()
        {
            return Err(
                "modeled vector lacks originalBytes, rawStoredBytes or escapedHex".to_string(),
            );
        }
    }
    if let Some(original) = vector.get("originalBytes").filter(|value| !value.is_null()) {
        let original = original.as_u64().ok_or("originalBytes is not a number")? as usize;
        if got.original_bytes != original {
            return Err(format!(
                "originalBytes {} want {original}",
                got.original_bytes
            ));
        }
    }
    if let Some(raw_stored) = vector
        .get("rawStoredBytes")
        .filter(|value| !value.is_null())
    {
        let raw_stored = raw_stored
            .as_u64()
            .ok_or("rawStoredBytes is not a number")? as usize;
        if escaped.len() != raw_stored {
            return Err(format!(
                "escaped length {} want rawStoredBytes {raw_stored}",
                escaped.len()
            ));
        }
    }
    if let Some(escaped_hex) = vector.get("escapedHex").and_then(Value::as_str) {
        if escaped.bytes != unhex(escaped_hex)? {
            return Err(format!(
                "escaped bytes {} want {escaped_hex}",
                hex::encode(&escaped.bytes)
            ));
        }
    }

    let decoded = decompress_payload(got.payload.clone(), MAX_DECOMPRESSED_BYTES);
    if decoded.payload != raw {
        return Err(format!("compression changed value: {decoded:?}"));
    }
    if got.outcome == CompressionOutcome::Compressed {
        if !got.payload.binary
            || got.stored_bytes >= escaped.len()
            || got.payload.len() != got.stored_bytes
        {
            return Err(format!("compression grew or misreported: {got:?}"));
        }
        let mut marker = if raw.binary {
            MARKER_ZSTD_BINARY
        } else {
            MARKER_ZSTD_UTF8
        };
        if let Some(expected) = modeled {
            marker = u8::try_from(
                field(expected, "marker")?
                    .as_i64()
                    .ok_or("marker is not an integer")?,
            )
            .map_err(|_| "modeled marker is not a byte".to_string())?;
        }
        if got.payload.bytes.first() != Some(&marker) {
            return Err(format!(
                "compressed payload marker {:?} want {marker}",
                got.payload.bytes.first()
            ));
        }
    } else if got.payload != escaped {
        return Err(format!("raw representation differs: {got:?}"));
    }
    Ok(())
}

/// The native single-frame, checksum-free zstd length at the fixture level,
/// computed independently of the crate's wrapper.
fn native_zstd_len(bytes: &[u8]) -> Result<usize, String> {
    let describe = |code: usize| format!("native zstd: {}", zstd_safe::get_error_name(code));
    let mut context = zstd_safe::CCtx::create();
    context
        .set_parameter(zstd_safe::CParameter::CompressionLevel(FIXTURE_ZSTD_LEVEL))
        .map_err(describe)?;
    context
        .set_parameter(zstd_safe::CParameter::ChecksumFlag(false))
        .map_err(describe)?;
    let mut out = vec![0u8; zstd_safe::compress_bound(bytes.len())];
    context.compress2(&mut out[..], bytes).map_err(describe)
}
