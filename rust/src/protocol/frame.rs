//! Version-1 frames and semantic read results.
//!
//! A frame is `[0x01] ++ big-endian u64 createdAtMs ++ [0x00 text | 0x01 binary]
//! ++ payload`. [`decode_frame`] applies the protocol's classification
//! precedence to one raw read; [`normalize_read_result`] is the trust boundary
//! above wire decoding that every semantic adapter result passes through.

use crate::codec::Payload;
use crate::limits::{MAX_SAFE_INTEGER, MAX_SUPPORTED_DURATION_MS};
use crate::remote::{Frame, MissReason, ReadResult};

use super::text::replacement_utf8;

/// Wire-level failures that are errors rather than misses.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ProtocolError {
    /// A frame's encoding tag is neither text (`0x00`) nor binary (`0x01`).
    #[error("Invalid DialCache Redis payload encoding")]
    PayloadEncoding,
    /// The server accepted a command but replied outside the protocol; the
    /// text says how, for example a watermark that is not a digit string.
    #[error("Invalid DialCache Redis reply: {0}")]
    InvalidReply(String),
    /// A stamp is not a nonnegative safe integer, or an invalidation would
    /// push its watermark past one.
    #[error("DialCache timestamp must be a nonnegative safe integer")]
    InvalidTimestamp,
    /// A TTL is not positive, or a TTL or future buffer exceeds 365 days.
    #[error("DialCache cache TTL must be positive and no greater than 365 days")]
    InvalidDuration,
    /// zstd or its configuration failed on the write side; the text is
    /// zstd's error name or the rejected option.
    #[error("DialCache compression failed: {0}")]
    Compression(String),
}

const FRAME_VERSION: u8 = 1;
const FRAME_HEADER_LEN: usize = 10;
const ENCODING_TEXT: u8 = 0;
const ENCODING_BINARY: u8 = 1;

/// Encode a frame: version byte, big-endian uint64 stamp, encoding tag, payload.
/// Text payloads receive replacement UTF-8 conversion first.
pub fn encode_frame(frame: &Frame) -> Result<Vec<u8>, ProtocolError> {
    if frame.created_at_ms > MAX_SAFE_INTEGER {
        return Err(ProtocolError::InvalidTimestamp);
    }
    let mut out = Vec::with_capacity(FRAME_HEADER_LEN + frame.payload.len());
    out.push(FRAME_VERSION);
    out.extend_from_slice(&frame.created_at_ms.to_be_bytes());
    if frame.payload.binary {
        out.push(ENCODING_BINARY);
        out.extend_from_slice(&frame.payload.bytes);
    } else {
        out.push(ENCODING_TEXT);
        out.extend_from_slice(&replacement_utf8(&frame.payload.bytes));
    }
    Ok(out)
}

/// Parse a watermark bulk string. `None` input is absent (a valid zero
/// baseline); `Some(Err)` is malformed; `Some(Ok(value))` is a valid stamp.
///
/// Only ASCII digits are accepted. Leading zeros are ignored even when the
/// literal would overflow a machine integer; the remaining digits must fit
/// the safe-integer domain.
pub fn parse_watermark(raw: Option<&[u8]>) -> Option<Result<u64, ProtocolError>> {
    let raw = raw?;
    Some(parse_watermark_digits(raw))
}

fn parse_watermark_digits(raw: &[u8]) -> Result<u64, ProtocolError> {
    let malformed =
        || ProtocolError::InvalidReply("watermark is not a nonnegative safe integer".to_string());
    if raw.is_empty() || !raw.iter().all(u8::is_ascii_digit) {
        return Err(malformed());
    }
    let mut value: u64 = 0;
    for digit in raw.iter().skip_while(|byte| **byte == b'0') {
        value = value
            .checked_mul(10)
            .and_then(|scaled| scaled.checked_add(u64::from(digit - b'0')))
            .ok_or_else(malformed)?;
    }
    if value > MAX_SAFE_INTEGER {
        return Err(malformed());
    }
    Ok(value)
}

/// Classify one raw read with the protocol's precedence: absent value,
/// unsupported frame, tracked marker validity and zero stamp, fence,
/// payload encoding, then a hit.
///
/// `watermark` is consulted only when `tracked`. A miss carries the parsed
/// fence whenever the marker was valid (including the absent baseline, which
/// carries none); a malformed marker yields an unclassified miss without one.
/// The stamp is returned with full `u64` precision; the safe-integer check
/// belongs to [`normalize_read_result`].
pub fn decode_frame(
    raw: Option<&[u8]>,
    tracked: bool,
    watermark: Option<&[u8]>,
) -> Result<ReadResult, ProtocolError> {
    let (fence, valid_marker) = if tracked {
        match parse_watermark(watermark) {
            None => (None, true),
            Some(Ok(value)) => (Some(value), true),
            Some(Err(_)) => (None, false),
        }
    } else {
        (None, true)
    };
    let miss = |reason: MissReason| {
        Ok(ReadResult::Miss {
            reason,
            observed_watermark_ms: fence,
        })
    };

    let Some(raw) = raw else {
        return miss(MissReason::ValueAbsent);
    };
    if raw.len() < FRAME_HEADER_LEN || raw[0] != FRAME_VERSION {
        return miss(MissReason::Unclassified);
    }
    let stamp = u64::from_be_bytes(
        raw[1..9]
            .try_into()
            .expect("frame header holds eight stamp bytes"),
    );
    if tracked && (!valid_marker || stamp == 0) {
        return miss(MissReason::Unclassified);
    }
    if let (true, Some(fence)) = (tracked, fence) {
        if stamp <= fence {
            return miss(MissReason::WatermarkFenced);
        }
    }
    let payload = match raw[9] {
        ENCODING_TEXT => Payload {
            bytes: replacement_utf8(&raw[FRAME_HEADER_LEN..]),
            binary: false,
        },
        ENCODING_BINARY => Payload::binary(&raw[FRAME_HEADER_LEN..]),
        _ => return Err(ProtocolError::PayloadEncoding),
    };
    Ok(ReadResult::Hit(Frame {
        created_at_ms: stamp,
        payload,
    }))
}

/// Interpret an untrusted JSON-shaped semantic reply from a custom adapter.
/// Unknown shapes become unclassified misses; frame-shaped objects ignore
/// stray miss metadata.
///
/// Only `"kind": "miss"` selects the miss branch. Its reason is parsed from
/// `"reason"` (unknown strings become unclassified) and its
/// `observedWatermarkMs` is kept only when it is a JSON number in the
/// timestamp domain. Any other object is frame-shaped: `createdAtMs` must be a
/// number in the timestamp domain, and a JSON string `payload` is text while
/// anything else is an empty text payload. The result still needs
/// [`normalize_read_result`] for the tracked-key fence rules.
pub fn read_result_from_untrusted_json(value: &serde_json::Value) -> ReadResult {
    let Some(object) = value.as_object() else {
        return ReadResult::miss(MissReason::Unclassified);
    };
    if object.get("kind").and_then(serde_json::Value::as_str) == Some("miss") {
        let reason = object
            .get("reason")
            .and_then(serde_json::Value::as_str)
            .and_then(MissReason::parse)
            .unwrap_or(MissReason::Unclassified);
        let observed_watermark_ms = object
            .get("observedWatermarkMs")
            .and_then(serde_json::Value::as_f64)
            .and_then(|number| validate_timestamp_ms(number).ok());
        return ReadResult::Miss {
            reason,
            observed_watermark_ms,
        };
    }
    let Some(created_at_ms) = object
        .get("createdAtMs")
        .and_then(serde_json::Value::as_f64)
        .and_then(|number| validate_timestamp_ms(number).ok())
    else {
        return ReadResult::miss(MissReason::Unclassified);
    };
    let payload = match object.get("payload").and_then(serde_json::Value::as_str) {
        Some(text) => Payload::text(text),
        None => Payload::default(),
    };
    ReadResult::Hit(Frame {
        created_at_ms,
        payload,
    })
}

/// The core trust boundary above wire decoding: drop fences on untracked
/// keys or outside the safe domain, and demote a fenced claim without a fence.
pub fn normalize_read_result(result: ReadResult, tracked: bool) -> ReadResult {
    match result {
        ReadResult::Miss {
            reason,
            observed_watermark_ms,
        } => {
            let observed_watermark_ms =
                observed_watermark_ms.filter(|fence| tracked && *fence <= MAX_SAFE_INTEGER);
            let reason = match reason {
                MissReason::WatermarkFenced if observed_watermark_ms.is_none() => {
                    MissReason::Unclassified
                }
                other => other,
            };
            ReadResult::Miss {
                reason,
                observed_watermark_ms,
            }
        }
        ReadResult::Hit(frame) if frame.created_at_ms > MAX_SAFE_INTEGER => {
            ReadResult::miss(MissReason::Unclassified)
        }
        hit @ ReadResult::Hit(_) => hit,
    }
}

/// A nonnegative safe-integer timestamp.
pub fn validate_timestamp_ms(value: f64) -> Result<u64, ProtocolError> {
    if !value.is_finite()
        || value < 0.0
        || value.trunc() != value
        || value > MAX_SAFE_INTEGER as f64
    {
        return Err(ProtocolError::InvalidTimestamp);
    }
    Ok(value as u64)
}

/// Round a write TTL up to whole milliseconds and check the 365-day domain.
pub fn ceil_supported_cache_ttl_ms(value: f64) -> Result<u64, ProtocolError> {
    let ceiled = value.ceil();
    if !ceiled.is_finite() || ceiled <= 0.0 || ceiled > MAX_SUPPORTED_DURATION_MS as f64 {
        return Err(ProtocolError::InvalidDuration);
    }
    Ok(ceiled as u64)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn text_frame(stamp: u64, text: &str) -> Vec<u8> {
        encode_frame(&Frame {
            created_at_ms: stamp,
            payload: Payload::text(text),
        })
        .expect("encodes")
    }

    #[test]
    fn encode_layout_and_domain() {
        assert_eq!(text_frame(1, "A"), [1, 0, 0, 0, 0, 0, 0, 0, 1, 0, b'A']);
        let binary = Frame {
            created_at_ms: 0x0102,
            payload: Payload::binary(vec![0xFF]),
        };
        assert_eq!(
            encode_frame(&binary).unwrap(),
            [1, 0, 0, 0, 0, 0, 0, 1, 2, 1, 0xFF]
        );
        let unsafe_stamp = Frame {
            created_at_ms: MAX_SAFE_INTEGER + 1,
            payload: Payload::text(""),
        };
        assert_eq!(
            encode_frame(&unsafe_stamp),
            Err(ProtocolError::InvalidTimestamp)
        );
        // Ill-formed text is replaced at encode time; binary bytes stay exact.
        let ill_formed = Frame {
            created_at_ms: 1,
            payload: Payload {
                bytes: vec![0xE2, 0x82],
                binary: false,
            },
        };
        assert_eq!(
            &encode_frame(&ill_formed).unwrap()[10..],
            [0xEF, 0xBF, 0xBD]
        );
    }

    #[test]
    fn watermark_parsing() {
        assert_eq!(parse_watermark(None), None);
        assert_eq!(parse_watermark(Some(b"0")), Some(Ok(0)));
        assert_eq!(
            parse_watermark(Some(b"000000000000000000000000000042")),
            Some(Ok(42))
        );
        assert_eq!(
            parse_watermark(Some(b"9007199254740991")),
            Some(Ok(MAX_SAFE_INTEGER))
        );
        for malformed in [
            &b""[..],
            b"9007199254740992",
            b"99999999999999999999999",
            b"-1",
            b"1.0",
            b" 1",
            b"1a",
            "١".as_bytes(),
        ] {
            assert!(
                matches!(
                    parse_watermark(Some(malformed)),
                    Some(Err(ProtocolError::InvalidReply(_)))
                ),
                "{malformed:?}"
            );
        }
    }

    #[test]
    fn decode_precedence() {
        let frame = text_frame(1000, "cached");
        let fenced = decode_frame(Some(&frame), true, Some(b"1000")).unwrap();
        assert_eq!(
            fenced,
            ReadResult::Miss {
                reason: MissReason::WatermarkFenced,
                observed_watermark_ms: Some(1000)
            }
        );
        let hit = decode_frame(Some(&frame), true, Some(b"999")).unwrap();
        assert_eq!(
            hit,
            ReadResult::Hit(Frame {
                created_at_ms: 1000,
                payload: Payload::text("cached")
            })
        );
        // Untracked reads never consult the marker.
        assert_eq!(
            decode_frame(Some(&frame), false, Some(b"garbage")).unwrap(),
            hit
        );
        // Absent value carries a valid fence; a malformed marker drops it.
        assert_eq!(
            decode_frame(None, true, Some(b"7")).unwrap(),
            ReadResult::Miss {
                reason: MissReason::ValueAbsent,
                observed_watermark_ms: Some(7)
            }
        );
        assert_eq!(
            decode_frame(None, true, Some(b"x")).unwrap(),
            ReadResult::miss(MissReason::ValueAbsent)
        );
        // Short or unversioned frames are unclassified before the marker is examined.
        assert_eq!(
            decode_frame(Some(&frame[..9]), true, Some(b"5")).unwrap(),
            ReadResult::Miss {
                reason: MissReason::Unclassified,
                observed_watermark_ms: Some(5)
            }
        );
        assert_eq!(
            decode_frame(Some(b""), false, None).unwrap(),
            ReadResult::miss(MissReason::Unclassified)
        );
        // Zero stamps and malformed markers are unclassified only on tracked keys.
        let zero = text_frame(0, "z");
        assert_eq!(
            decode_frame(Some(&zero), true, None).unwrap(),
            ReadResult::miss(MissReason::Unclassified)
        );
        assert!(matches!(
            decode_frame(Some(&zero), false, None).unwrap(),
            ReadResult::Hit(_)
        ));
        assert_eq!(
            decode_frame(Some(&frame), true, Some(b"")).unwrap(),
            ReadResult::miss(MissReason::Unclassified)
        );
        // The fence check precedes the encoding tag; a fenced bad tag is a miss.
        let mut bad_tag = frame.clone();
        bad_tag[9] = 2;
        assert_eq!(
            decode_frame(Some(&bad_tag), false, None),
            Err(ProtocolError::PayloadEncoding)
        );
        assert_eq!(
            decode_frame(Some(&bad_tag), true, Some(b"1000")).unwrap(),
            ReadResult::Miss {
                reason: MissReason::WatermarkFenced,
                observed_watermark_ms: Some(1000)
            }
        );
        // Full u64 stamps survive decoding; normalization demotes them.
        let mut huge = text_frame(1, "h");
        huge[1..9].copy_from_slice(&u64::MAX.to_be_bytes());
        let decoded = decode_frame(Some(&huge), false, None).unwrap();
        assert!(matches!(
            decoded,
            ReadResult::Hit(Frame {
                created_at_ms: u64::MAX,
                ..
            })
        ));
        assert_eq!(
            normalize_read_result(decoded, false),
            ReadResult::miss(MissReason::Unclassified)
        );
    }

    #[test]
    fn untrusted_json_shapes() {
        assert_eq!(
            read_result_from_untrusted_json(&json!(null)),
            ReadResult::miss(MissReason::Unclassified)
        );
        assert_eq!(
            read_result_from_untrusted_json(&json!([1])),
            ReadResult::miss(MissReason::Unclassified)
        );
        assert_eq!(
            read_result_from_untrusted_json(
                &json!({"kind": "miss", "reason": "watermark_fenced", "observedWatermarkMs": 5})
            ),
            ReadResult::Miss {
                reason: MissReason::WatermarkFenced,
                observed_watermark_ms: Some(5)
            }
        );
        assert_eq!(
            read_result_from_untrusted_json(
                &json!({"kind": "miss", "reason": "bogus", "observedWatermarkMs": "5"})
            ),
            ReadResult::miss(MissReason::Unclassified)
        );
        assert_eq!(
            read_result_from_untrusted_json(
                &json!({"kind": "miss", "reason": "expired", "observedWatermarkMs": 1.5})
            ),
            ReadResult::miss(MissReason::Expired)
        );
        // Frame-shaped objects ignore stray miss metadata and non-string payloads.
        assert_eq!(
            read_result_from_untrusted_json(
                &json!({"kind": "hit", "createdAtMs": 3, "payload": "p", "reason": "expired"})
            ),
            ReadResult::Hit(Frame {
                created_at_ms: 3,
                payload: Payload::text("p")
            })
        );
        assert_eq!(
            read_result_from_untrusted_json(&json!({"createdAtMs": 3, "payload": [1, 2]})),
            ReadResult::Hit(Frame {
                created_at_ms: 3,
                payload: Payload::default()
            })
        );
        for bad in [
            json!({"createdAtMs": -1}),
            json!({"createdAtMs": "3"}),
            json!({"payload": "p"}),
            json!({"createdAtMs": 1.5}),
        ] {
            assert_eq!(
                read_result_from_untrusted_json(&bad),
                ReadResult::miss(MissReason::Unclassified),
                "{bad}"
            );
        }
    }

    #[test]
    fn normalization_rules() {
        let fenced = ReadResult::Miss {
            reason: MissReason::WatermarkFenced,
            observed_watermark_ms: Some(9),
        };
        assert_eq!(normalize_read_result(fenced.clone(), true), fenced);
        assert_eq!(
            normalize_read_result(fenced, false),
            ReadResult::miss(MissReason::Unclassified)
        );
        let unsafe_fence = ReadResult::Miss {
            reason: MissReason::Expired,
            observed_watermark_ms: Some(MAX_SAFE_INTEGER + 1),
        };
        assert_eq!(
            normalize_read_result(unsafe_fence, true),
            ReadResult::miss(MissReason::Expired)
        );
        let hit = ReadResult::Hit(Frame {
            created_at_ms: MAX_SAFE_INTEGER,
            payload: Payload::text("ok"),
        });
        assert_eq!(normalize_read_result(hit.clone(), true), hit);
    }

    #[test]
    fn timestamp_and_duration_domains() {
        assert_eq!(validate_timestamp_ms(0.0), Ok(0));
        assert_eq!(
            validate_timestamp_ms(MAX_SAFE_INTEGER as f64),
            Ok(MAX_SAFE_INTEGER)
        );
        for bad in [
            -1.0,
            1.5,
            9007199254740992.0,
            f64::NAN,
            f64::INFINITY,
            f64::NEG_INFINITY,
            -0.5,
        ] {
            assert_eq!(
                validate_timestamp_ms(bad),
                Err(ProtocolError::InvalidTimestamp),
                "{bad}"
            );
        }
        assert_eq!(validate_timestamp_ms(-0.0), Ok(0));
        assert_eq!(ceil_supported_cache_ttl_ms(0.1), Ok(1));
        assert_eq!(ceil_supported_cache_ttl_ms(1.1), Ok(2));
        assert_eq!(
            ceil_supported_cache_ttl_ms(31535999999.999),
            Ok(MAX_SUPPORTED_DURATION_MS)
        );
        assert_eq!(
            ceil_supported_cache_ttl_ms(MAX_SUPPORTED_DURATION_MS as f64),
            Ok(MAX_SUPPORTED_DURATION_MS)
        );
        for bad in [
            0.0,
            -1.0,
            31536000000.001,
            f64::NAN,
            f64::INFINITY,
            f64::NEG_INFINITY,
        ] {
            assert_eq!(
                ceil_supported_cache_ttl_ms(bad),
                Err(ProtocolError::InvalidDuration),
                "{bad}"
            );
        }
    }
}
