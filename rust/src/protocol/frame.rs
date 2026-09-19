//! Version-1 frames and semantic read results.

use crate::remote::{Frame, ReadResult};

/// Wire-level failures that are errors rather than misses.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum ProtocolError {
    #[error("Invalid DialCache Redis payload encoding")]
    PayloadEncoding,
    #[error("Invalid DialCache Redis reply: {0}")]
    InvalidReply(String),
    #[error("DialCache timestamp must be a nonnegative safe integer")]
    InvalidTimestamp,
    #[error("DialCache cache TTL must be positive and no greater than 365 days")]
    InvalidDuration,
    #[error("DialCache compression failed: {0}")]
    Compression(String),
}

/// Encode a frame: version byte, big-endian uint64 stamp, encoding tag, payload.
/// Text payloads receive replacement UTF-8 conversion first.
pub fn encode_frame(frame: &Frame) -> Result<Vec<u8>, ProtocolError> {
    let _ = frame;
    todo!("encode_frame")
}

/// Parse a watermark bulk string. `None` input is absent (a valid zero
/// baseline); `Some(Err)` is malformed; `Some(Ok(value))` is a valid stamp.
pub fn parse_watermark(raw: Option<&[u8]>) -> Option<Result<u64, ProtocolError>> {
    let _ = raw;
    todo!("parse_watermark")
}

/// Classify one raw read with the protocol's precedence: absent value,
/// unsupported frame, tracked marker validity and zero stamp, fence,
/// payload encoding, then a hit.
pub fn decode_frame(raw: Option<&[u8]>, tracked: bool, watermark: Option<&[u8]>) -> Result<ReadResult, ProtocolError> {
    let _ = (raw, tracked, watermark);
    todo!("decode_frame")
}

/// Interpret an untrusted JSON-shaped semantic reply from a custom adapter.
/// Unknown shapes become unclassified misses; frame-shaped objects ignore
/// stray miss metadata.
pub fn read_result_from_untrusted_json(value: &serde_json::Value) -> ReadResult {
    let _ = value;
    todo!("read_result_from_untrusted_json")
}

/// The core trust boundary above wire decoding: drop fences on untracked
/// keys or outside the safe domain, and demote a fenced claim without a fence.
pub fn normalize_read_result(result: ReadResult, tracked: bool) -> ReadResult {
    let _ = (result, tracked);
    todo!("normalize_read_result")
}

/// A nonnegative safe-integer timestamp.
pub fn validate_timestamp_ms(value: f64) -> Result<u64, ProtocolError> {
    let _ = value;
    todo!("validate_timestamp_ms")
}

/// Round a write TTL up to whole milliseconds and check the 365-day domain.
pub fn ceil_supported_cache_ttl_ms(value: f64) -> Result<u64, ProtocolError> {
    let _ = value;
    todo!("ceil_supported_cache_ttl_ms")
}
