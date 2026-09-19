//! Payload envelopes: escaping and zstd compression.

use crate::codec::Payload;
use crate::limits::{DEFAULT_COMPRESSION_THRESHOLD_BYTES, DEFAULT_ZSTD_LEVEL, MAX_DECOMPRESSED_BYTES};
use crate::observe::CompressionOutcome;

use super::frame::ProtocolError;

pub const MARKER_ESCAPED_RAW: u8 = 0x00;
pub const MARKER_ZSTD_UTF8: u8 = 0x01;
pub const MARKER_ZSTD_BINARY: u8 = 0x02;

/// Write-side compression policy.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CompressionConfig {
    /// Payloads of at least this many serialized bytes are compressed.
    pub threshold_bytes: usize,
    /// zstd level, `1..=22`.
    pub level: i32,
}

impl Default for CompressionConfig {
    fn default() -> Self {
        CompressionConfig { threshold_bytes: DEFAULT_COMPRESSION_THRESHOLD_BYTES, level: DEFAULT_ZSTD_LEVEL }
    }
}

impl CompressionConfig {
    pub fn validate(&self) -> Result<(), ProtocolError> {
        let _ = MAX_DECOMPRESSED_BYTES;
        todo!("CompressionConfig::validate")
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompressionWriteResult {
    pub payload: Payload,
    pub outcome: CompressionOutcome,
    pub original_bytes: usize,
    pub stored_bytes: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompressionReadResult {
    pub payload: Payload,
    /// `None` when the payload passed through untouched.
    pub outcome: Option<CompressionOutcome>,
}

/// Prefix raw binary output whose first byte would collide with the envelope.
pub fn escape_raw_payload(payload: Payload) -> Payload {
    let _ = payload;
    todo!("escape_raw_payload")
}

/// Compress when the payload meets the threshold and the marked result is
/// strictly smaller than the escaped raw form.
pub fn compress_payload(
    payload: Payload,
    config: &CompressionConfig,
    max_decompressed_bytes: usize,
) -> Result<CompressionWriteResult, ProtocolError> {
    let _ = (payload, config, max_decompressed_bytes);
    todo!("compress_payload")
}

/// Reverse of [`compress_payload`], applied to every read.
pub fn decompress_payload(payload: Payload, max_decompressed_bytes: usize) -> CompressionReadResult {
    let _ = (payload, max_decompressed_bytes);
    todo!("decompress_payload")
}
