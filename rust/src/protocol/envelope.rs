//! Payload envelopes: escaping and zstd compression.
//!
//! Byte 0 of a binary payload written by this version or later selects the
//! envelope: `0x00` escapes raw serializer output whose own first byte would
//! collide, `0x01` marks a zstd frame of UTF-8 text and `0x02` a zstd frame of
//! binary bytes. Raw output is escaped on every write, and every read
//! interprets the envelope, so disabling compression never strands entries.
//! See "Envelope selection and codec environment" in `formal/PROTOCOL.md`.

use crate::codec::Payload;
use crate::limits::{DEFAULT_COMPRESSION_THRESHOLD_BYTES, DEFAULT_ZSTD_LEVEL, MAX_SAFE_INTEGER};
use crate::observe::CompressionOutcome;

use super::frame::ProtocolError;
use super::text::replacement_utf8;

/// Envelope byte `0x00`: the rest is raw serializer output whose own first
/// byte would have collided with a marker.
pub const MARKER_ESCAPED_RAW: u8 = 0x00;
/// Envelope byte `0x01`: the rest is one zstd frame of UTF-8 text.
pub const MARKER_ZSTD_UTF8: u8 = 0x01;
/// Envelope byte `0x02`: the rest is one zstd frame of binary bytes.
pub const MARKER_ZSTD_BINARY: u8 = 0x02;

const MIN_ZSTD_LEVEL: i32 = 1;
const MAX_ZSTD_LEVEL: i32 = 22;

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
        CompressionConfig {
            threshold_bytes: DEFAULT_COMPRESSION_THRESHOLD_BYTES,
            level: DEFAULT_ZSTD_LEVEL,
        }
    }
}

impl CompressionConfig {
    /// The threshold must be a positive safe integer and the level `1..=22`.
    pub fn validate(&self) -> Result<(), ProtocolError> {
        if self.threshold_bytes < 1 || self.threshold_bytes as u64 > MAX_SAFE_INTEGER {
            return Err(ProtocolError::Compression(
                "threshold_bytes must be a positive safe integer".to_string(),
            ));
        }
        if !(MIN_ZSTD_LEVEL..=MAX_ZSTD_LEVEL).contains(&self.level) {
            return Err(ProtocolError::Compression(
                "level must be an integer between 1 and 22".to_string(),
            ));
        }
        Ok(())
    }
}

/// What [`compress_payload`] chose to store, and why.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompressionWriteResult {
    /// The bytes to store: marked zstd output, or the escaped raw form.
    pub payload: Payload,
    /// One of the write outcomes: compressed, below threshold, not smaller
    /// or over limit.
    pub outcome: CompressionOutcome,
    /// Length of the serializer output after text replacement, before escaping.
    pub original_bytes: usize,
    /// Length of `payload`.
    pub stored_bytes: usize,
}

/// What [`decompress_payload`] produced from a stored payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CompressionReadResult {
    /// The decoded payload; the input with its `0x00` escape prefix removed
    /// when it was escaped raw output; or the input unchanged when it passed
    /// through untouched or zstd rejected it.
    pub payload: Payload,
    /// `None` when no zstd envelope was involved: the payload passed through
    /// untouched or only had its escape prefix removed.
    pub outcome: Option<CompressionOutcome>,
}

fn needs_raw_escape(payload: &Payload) -> bool {
    payload.binary
        && payload
            .bytes
            .first()
            .is_some_and(|first| *first <= MARKER_ZSTD_BINARY)
}

/// Prefix raw binary output whose first byte would collide with the envelope.
pub fn escape_raw_payload(payload: Payload) -> Payload {
    if needs_raw_escape(&payload) {
        let mut escaped = Vec::with_capacity(payload.bytes.len() + 1);
        escaped.push(MARKER_ESCAPED_RAW);
        escaped.extend_from_slice(&payload.bytes);
        return Payload::binary(escaped);
    }
    payload
}

/// Compress when the payload meets the threshold and the marked result is
/// strictly smaller than the escaped raw form.
///
/// Text payloads receive replacement UTF-8 conversion first, so the measured
/// size is the stored text's. The threshold comparison precedes the output
/// cap: a value the read side would refuse is stored raw (`write_over_limit`)
/// and subject to Redis's own value limit instead. `original_bytes` is the
/// payload's own length and `stored_bytes` the length actually written.
pub fn compress_payload(
    payload: Payload,
    config: &CompressionConfig,
    max_decompressed_bytes: usize,
) -> Result<CompressionWriteResult, ProtocolError> {
    config.validate()?;
    let payload = if payload.binary {
        payload
    } else {
        Payload {
            bytes: replacement_utf8(&payload.bytes),
            binary: false,
        }
    };
    let original_bytes = payload.len();
    let outcome = if original_bytes < config.threshold_bytes {
        CompressionOutcome::BelowThreshold
    } else if original_bytes > max_decompressed_bytes {
        CompressionOutcome::WriteOverLimit
    } else {
        let compressed = zstd_compress(&payload.bytes, config.level)?;
        let raw_bytes = original_bytes + usize::from(needs_raw_escape(&payload));
        if compressed.len() + 1 < raw_bytes {
            let mut marked = Vec::with_capacity(compressed.len() + 1);
            marked.push(if payload.binary {
                MARKER_ZSTD_BINARY
            } else {
                MARKER_ZSTD_UTF8
            });
            marked.extend_from_slice(&compressed);
            return Ok(CompressionWriteResult {
                stored_bytes: marked.len(),
                payload: Payload::binary(marked),
                outcome: CompressionOutcome::Compressed,
                original_bytes,
            });
        }
        CompressionOutcome::NotSmaller
    };
    let raw = escape_raw_payload(payload);
    Ok(CompressionWriteResult {
        stored_bytes: raw.len(),
        payload: raw,
        outcome,
        original_bytes,
    })
}

/// Reverse of [`compress_payload`], applied to every read.
///
/// Text payloads and empty binary payloads pass through. An escape prefix is
/// removed only when the next byte is one the writer escapes; other `0x00`
/// leads and unknown markers pass through unchanged. A marked payload decodes
/// only its first zstd frame and ignores trailing bytes, like Node's
/// synchronous decoder. Malformed or truncated zstd data keeps the original
/// marked bytes with `fallback_raw`; output beyond `max_decompressed_bytes`
/// (or a frame demanding more decoder memory than allowed) keeps them with
/// `read_over_limit`. Successful `0x01` output receives replacement UTF-8
/// conversion; `0x02` output is exact bytes. The input is never mutated, so
/// repeated loads of a retained payload are independent.
pub fn decompress_payload(
    payload: Payload,
    max_decompressed_bytes: usize,
) -> CompressionReadResult {
    let passthrough = |payload| CompressionReadResult {
        payload,
        outcome: None,
    };
    if !payload.binary {
        return passthrough(payload);
    }
    let Some(&marker) = payload.bytes.first() else {
        return passthrough(payload);
    };
    match marker {
        MARKER_ESCAPED_RAW => {
            if payload
                .bytes
                .get(1)
                .is_some_and(|next| *next <= MARKER_ZSTD_BINARY)
            {
                return passthrough(Payload::binary(&payload.bytes[1..]));
            }
            passthrough(payload)
        }
        MARKER_ZSTD_UTF8 | MARKER_ZSTD_BINARY => {
            match decode_first_zstd_frame(&payload.bytes[1..], max_decompressed_bytes) {
                Ok(decoded) => {
                    let decoded = if marker == MARKER_ZSTD_UTF8 {
                        Payload {
                            bytes: replacement_utf8(&decoded),
                            binary: false,
                        }
                    } else {
                        Payload::binary(decoded)
                    };
                    CompressionReadResult {
                        payload: decoded,
                        outcome: Some(CompressionOutcome::Decompressed),
                    }
                }
                Err(outcome) => CompressionReadResult {
                    payload,
                    outcome: Some(outcome),
                },
            }
        }
        _ => passthrough(payload),
    }
}

/// One zstd frame of `bytes` at `level`, without a checksum, as the writer
/// stores it (single-shot, so the frame header carries the content size).
fn zstd_compress(bytes: &[u8], level: i32) -> Result<Vec<u8>, ProtocolError> {
    let codec =
        |code: usize| ProtocolError::Compression(zstd_safe::get_error_name(code).to_string());
    let mut context = zstd_safe::CCtx::create();
    context
        .set_parameter(zstd_safe::CParameter::CompressionLevel(level))
        .map_err(codec)?;
    context
        .set_parameter(zstd_safe::CParameter::ChecksumFlag(false))
        .map_err(codec)?;
    let mut out = vec![0u8; zstd_safe::compress_bound(bytes.len())];
    let written = context.compress2(&mut out[..], bytes).map_err(codec)?;
    out.truncate(written);
    Ok(out)
}

/// Decode only the first zstd frame of `body`, ignoring any trailer, with the
/// output cap enforced while streaming so a small stored frame can never force
/// a large allocation. Skippable frames decode to empty output.
fn decode_first_zstd_frame(
    body: &[u8],
    max_decompressed_bytes: usize,
) -> Result<Vec<u8>, CompressionOutcome> {
    // Rejects truncated and malformed headers or block sequences up front,
    // like Go's firstZstdFrame; only a complete first frame is decoded.
    let frame_len =
        zstd_safe::find_frame_compressed_size(body).map_err(|_| CompressionOutcome::FallbackRaw)?;
    let frame = body
        .get(..frame_len)
        .ok_or(CompressionOutcome::FallbackRaw)?;

    let mut context = zstd_safe::DCtx::create();
    let mut out = Vec::new();
    let mut input = zstd_safe::InBuffer::around(frame);
    // Each step writes at most one chunk; a cap smaller than a chunk still
    // only needs one chunk to observe the overflow.
    let chunk_len = zstd_safe::DCtx::out_size().max(1);
    let mut chunk = vec![0u8; chunk_len];
    loop {
        let mut output = zstd_safe::OutBuffer::around(&mut chunk[..]);
        let consumed_before = input.pos();
        let hint = context
            .decompress_stream(&mut output, &mut input)
            .map_err(classify_decoder_error)?;
        let produced = output.as_slice();
        if out.len() + produced.len() > max_decompressed_bytes {
            return Err(CompressionOutcome::ReadOverLimit);
        }
        out.extend_from_slice(produced);
        if hint == 0 {
            return Ok(out);
        }
        if input.pos() == frame.len() && produced.is_empty() {
            // The verified frame ended without the decoder finishing it.
            return Err(CompressionOutcome::FallbackRaw);
        }
        if input.pos() == consumed_before && produced.is_empty() {
            return Err(CompressionOutcome::FallbackRaw);
        }
    }
}

/// zstd errors that mean the frame exceeds the decoder's resource limits are
/// read-limit outcomes; anything else falls back to the raw bytes.
fn classify_decoder_error(code: usize) -> CompressionOutcome {
    let name = zstd_safe::get_error_name(code);
    if name.contains("too much memory") || name.contains("Destination buffer is too small") {
        CompressionOutcome::ReadOverLimit
    } else {
        CompressionOutcome::FallbackRaw
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::limits::MAX_DECOMPRESSED_BYTES;

    fn text(len: usize) -> Payload {
        Payload::text("x".repeat(len))
    }

    fn compressed(payload: Payload) -> CompressionWriteResult {
        let result = compress_payload(
            payload,
            &CompressionConfig {
                threshold_bytes: 1,
                level: 3,
            },
            MAX_DECOMPRESSED_BYTES,
        )
        .unwrap();
        assert_eq!(result.outcome, CompressionOutcome::Compressed);
        result
    }

    #[test]
    fn config_validation() {
        assert_eq!(CompressionConfig::default().validate(), Ok(()));
        assert!(CompressionConfig {
            threshold_bytes: 0,
            level: 3
        }
        .validate()
        .is_err());
        assert!(CompressionConfig {
            threshold_bytes: usize::MAX,
            level: 3
        }
        .validate()
        .is_err());
        assert!(CompressionConfig {
            threshold_bytes: 1,
            level: 0
        }
        .validate()
        .is_err());
        assert!(CompressionConfig {
            threshold_bytes: 1,
            level: 23
        }
        .validate()
        .is_err());
        assert_eq!(
            CompressionConfig {
                threshold_bytes: 1,
                level: 22
            }
            .validate(),
            Ok(())
        );
        let invalid = compress_payload(
            text(1),
            &CompressionConfig {
                threshold_bytes: 1,
                level: 23,
            },
            MAX_DECOMPRESSED_BYTES,
        );
        assert!(matches!(invalid, Err(ProtocolError::Compression(_))));
    }

    #[test]
    fn escaping_and_passthrough() {
        assert_eq!(
            escape_raw_payload(Payload::binary(vec![0, 9])).bytes,
            [0, 0, 9]
        );
        assert_eq!(escape_raw_payload(Payload::binary(vec![2])).bytes, [0, 2]);
        assert_eq!(escape_raw_payload(Payload::binary(vec![3])).bytes, [3]);
        assert_eq!(
            escape_raw_payload(Payload::binary(Vec::new())).bytes,
            Vec::<u8>::new()
        );
        assert_eq!(escape_raw_payload(Payload::text("\u{0}")).bytes, [0]);
        // Only a prefix the writer produces is stripped; legacy 0x00 leads stay.
        assert_eq!(
            decompress_payload(Payload::binary(vec![0, 1, 7]), 10),
            CompressionReadResult {
                payload: Payload::binary(vec![1, 7]),
                outcome: None
            }
        );
        for untouched in [
            Payload::binary(vec![0, 3]),
            Payload::binary(vec![0]),
            Payload::binary(vec![3, 1]),
            Payload::binary(Vec::new()),
            Payload::text("\u{1}x"),
        ] {
            assert_eq!(
                decompress_payload(untouched.clone(), 10),
                CompressionReadResult {
                    payload: untouched,
                    outcome: None
                }
            );
        }
    }

    /// Port of go/internal/testsuite/codec_test.go TestCompressionLimitsAndIndependentLoads.
    #[test]
    fn compression_limits_and_independent_loads() {
        let raw = text(4096);
        let written = compressed(raw.clone());
        let too_large = decompress_payload(written.payload.clone(), 4095);
        assert_eq!(too_large.outcome, Some(CompressionOutcome::ReadOverLimit));
        assert_eq!(too_large.payload, written.payload);
        let exact = decompress_payload(written.payload.clone(), 4096);
        assert_eq!(
            exact,
            CompressionReadResult {
                payload: raw.clone(),
                outcome: Some(CompressionOutcome::Decompressed)
            }
        );
        let refused = compress_payload(
            raw.clone(),
            &CompressionConfig {
                threshold_bytes: 1,
                level: 3,
            },
            4095,
        )
        .unwrap();
        assert_eq!(refused.outcome, CompressionOutcome::WriteOverLimit);
        assert_eq!(refused.payload, raw);
        assert_eq!((refused.original_bytes, refused.stored_bytes), (4096, 4096));
        // Repeated loads of a retained input are independent.
        let mut first = decompress_payload(written.payload.clone(), MAX_DECOMPRESSED_BYTES);
        first.payload.bytes[0] = b'y';
        assert_eq!(
            decompress_payload(written.payload.clone(), MAX_DECOMPRESSED_BYTES).payload,
            raw
        );
        let escaped = escape_raw_payload(Payload::binary(vec![1, 2, 3]));
        let mut first = decompress_payload(escaped.clone(), MAX_DECOMPRESSED_BYTES);
        first.payload.bytes[0] = 9;
        assert_eq!(
            decompress_payload(escaped, MAX_DECOMPRESSED_BYTES)
                .payload
                .bytes,
            [1, 2, 3]
        );
        // A zero cap admits only empty output.
        assert_eq!(
            decompress_payload(written.payload.clone(), 0).outcome,
            Some(CompressionOutcome::ReadOverLimit)
        );
    }

    /// Port of go/internal/testsuite/codec_test.go TestZstdFirstFrameAndMalformedBodies.
    #[test]
    fn first_frame_and_malformed_bodies() {
        let source = Payload::text("first".repeat(100));
        let written = compressed(source.clone());
        for trailer in [&b"CRC!"[..], &written.payload.bytes[1..]] {
            let mut marked = written.payload.bytes.clone();
            marked.extend_from_slice(trailer);
            let result = decompress_payload(Payload::binary(marked), MAX_DECOMPRESSED_BYTES);
            assert_eq!(
                result,
                CompressionReadResult {
                    payload: source.clone(),
                    outcome: Some(CompressionOutcome::Decompressed)
                }
            );
        }
        let half = written.payload.bytes[..written.payload.bytes.len() / 2].to_vec();
        for marked in [
            vec![1],
            vec![2],
            half,
            vec![1, 0x28, 0xB5, 0x2F, 0xFD],
            vec![2, 0xFF, 0xFF],
        ] {
            let got = decompress_payload(Payload::binary(marked.clone()), MAX_DECOMPRESSED_BYTES);
            assert_eq!(
                got,
                CompressionReadResult {
                    payload: Payload::binary(marked),
                    outcome: Some(CompressionOutcome::FallbackRaw)
                }
            );
        }
    }

    #[test]
    fn skippable_frames_decode_to_empty_output() {
        // Magic 0x184D2A50, 4-byte little-endian size, then that many bytes.
        let skippable = [
            0x01, 0x50, 0x2A, 0x4D, 0x18, 0x02, 0x00, 0x00, 0x00, 0xAA, 0xBB, 0xCC,
        ];
        let got = decompress_payload(Payload::binary(skippable.to_vec()), MAX_DECOMPRESSED_BYTES);
        assert_eq!(
            got,
            CompressionReadResult {
                payload: Payload::text(""),
                outcome: Some(CompressionOutcome::Decompressed)
            }
        );
        // Zero cap with empty output is still a successful decode.
        assert_eq!(
            decompress_payload(Payload::binary(skippable.to_vec()), 0).outcome,
            Some(CompressionOutcome::Decompressed)
        );
        let truncated = skippable[..8].to_vec();
        assert_eq!(
            decompress_payload(Payload::binary(truncated), MAX_DECOMPRESSED_BYTES).outcome,
            Some(CompressionOutcome::FallbackRaw)
        );
    }

    #[test]
    fn selection_rule_and_types() {
        let config = CompressionConfig {
            threshold_bytes: 4,
            level: 3,
        };
        let below = compress_payload(text(3), &config, MAX_DECOMPRESSED_BYTES).unwrap();
        assert_eq!(
            (below.outcome, below.original_bytes, below.stored_bytes),
            (CompressionOutcome::BelowThreshold, 3, 3)
        );
        let incompressible = compress_payload(
            Payload::binary(vec![1, 2, 3, 4]),
            &config,
            MAX_DECOMPRESSED_BYTES,
        )
        .unwrap();
        assert_eq!(incompressible.outcome, CompressionOutcome::NotSmaller);
        assert_eq!(incompressible.payload.bytes, [0, 1, 2, 3, 4]);
        assert_eq!(
            (incompressible.original_bytes, incompressible.stored_bytes),
            (4, 5)
        );
        let binary = compressed(Payload::binary(vec![7; 500]));
        assert_eq!(binary.payload.bytes[0], MARKER_ZSTD_BINARY);
        assert!(binary.payload.binary && binary.stored_bytes < 500);
        assert_eq!(
            decompress_payload(binary.payload, MAX_DECOMPRESSED_BYTES).payload,
            Payload::binary(vec![7; 500])
        );
        let text_result = compressed(text(500));
        assert_eq!(text_result.payload.bytes[0], MARKER_ZSTD_UTF8);
        assert_eq!(
            decompress_payload(text_result.payload, MAX_DECOMPRESSED_BYTES).payload,
            text(500)
        );
        // Ill-formed text is replaced before measuring and compressing.
        let ill_formed = Payload {
            bytes: vec![0xE2, 0x82, b'A'],
            binary: false,
        };
        let stored = compress_payload(
            ill_formed,
            &CompressionConfig {
                threshold_bytes: 100,
                level: 3,
            },
            MAX_DECOMPRESSED_BYTES,
        )
        .unwrap();
        assert_eq!(stored.payload, Payload::text("\u{FFFD}A"));
        assert_eq!((stored.original_bytes, stored.stored_bytes), (4, 4));
        // Decoded 0x01 text is replaced; 0x02 bytes are exact.
        let mut marked_text =
            compressed(Payload::binary([0xE2, 0x82, b'A', 0xFF].repeat(50))).payload;
        marked_text.bytes[0] = MARKER_ZSTD_UTF8;
        let decoded = decompress_payload(marked_text, MAX_DECOMPRESSED_BYTES);
        assert_eq!(
            decoded.payload,
            Payload::text("\u{FFFD}A\u{FFFD}".repeat(50))
        );
    }
}
