//! The portable wire protocol: frames, envelopes, text conversion and
//! duration/timestamp domains (W04–W08 in `formal/CONTRACTS.md`).

mod envelope;
mod frame;
mod text;

pub use envelope::{
    compress_payload, decompress_payload, escape_raw_payload, CompressionConfig, CompressionReadResult,
    CompressionWriteResult, MARKER_ESCAPED_RAW, MARKER_ZSTD_BINARY, MARKER_ZSTD_UTF8,
};
pub use frame::{
    ceil_supported_cache_ttl_ms, decode_frame, encode_frame, normalize_read_result, parse_watermark,
    read_result_from_untrusted_json, validate_timestamp_ms, ProtocolError,
};
pub use text::replacement_utf8;
