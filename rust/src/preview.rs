//! Bounded previews for mismatch warnings.

use std::io::{self, Write};

use serde::Serialize;

/// Maximum UTF-8 bytes of a logged cache key.
pub const SHADOW_LOG_KEY_MAX_BYTES: usize = 2 * 1024;
/// Maximum UTF-8 bytes of a logged value preview.
pub const SHADOW_LOG_VALUE_MAX_BYTES: usize = 8 * 1024;
/// Marker appended to a clamped preview.
pub const SHADOW_LOG_TRUNCATION_MARKER: &str = "...[truncated]";

/// Retain only the logged prefix, but consume the complete serialization so
/// errors beyond the cap still suppress the preview.
struct JsonPrefix {
    bytes: Vec<u8>,
    truncated: bool,
}

impl JsonPrefix {
    fn new() -> Self {
        Self {
            bytes: Vec::with_capacity(SHADOW_LOG_VALUE_MAX_BYTES),
            truncated: false,
        }
    }

    fn finish(mut self) -> String {
        if self.truncated {
            self.bytes
                .truncate(SHADOW_LOG_VALUE_MAX_BYTES - SHADOW_LOG_TRUNCATION_MARKER.len());
        }
        // The prefix can end inside a multibyte character. JSON serialization
        // produces valid UTF-8, so only that trailing character can be partial.
        if let Err(error) = std::str::from_utf8(&self.bytes) {
            self.bytes.truncate(error.valid_up_to());
        }
        let mut text = String::from_utf8(self.bytes).expect("valid JSON prefix");
        if self.truncated {
            text.push_str(SHADOW_LOG_TRUNCATION_MARKER);
        }
        text
    }
}

impl Write for JsonPrefix {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        let retained = bytes
            .len()
            .min(SHADOW_LOG_VALUE_MAX_BYTES - self.bytes.len());
        self.bytes.extend_from_slice(&bytes[..retained]);
        self.truncated |= retained < bytes.len();
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

pub(crate) fn json_preview<T: Serialize>(value: &T) -> Option<String> {
    let mut prefix = JsonPrefix::new();
    serde_json::to_writer(&mut prefix, value).ok()?;
    Some(prefix.finish())
}

/// Clamp text to `max_bytes` of UTF-8, ending a clamped result with the
/// truncation marker on a character boundary.
pub fn clamp_utf8(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_string();
    }
    let mut limit = max_bytes.saturating_sub(SHADOW_LOG_TRUNCATION_MARKER.len());
    while limit > 0 && !value.is_char_boundary(limit) {
        limit -= 1;
    }
    let mut result = String::with_capacity(limit + SHADOW_LOG_TRUNCATION_MARKER.len());
    result.push_str(&value[..limit]);
    result.push_str(SHADOW_LOG_TRUNCATION_MARKER);
    result
}

/// Clamp a logical key to [`SHADOW_LOG_KEY_MAX_BYTES`].
pub fn preview_key(key: &str) -> String {
    clamp_utf8(key, SHADOW_LOG_KEY_MAX_BYTES)
}

/// Clamp a value's JSON preview to [`SHADOW_LOG_VALUE_MAX_BYTES`].
pub fn preview_value(json: &str) -> String {
    clamp_utf8(json, SHADOW_LOG_VALUE_MAX_BYTES)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::ser::{Error, SerializeSeq};

    #[test]
    fn clamps_on_character_boundaries() {
        let text = "é".repeat(2000);
        let clamped = clamp_utf8(&text, 100);
        assert!(clamped.len() <= 100);
        assert!(clamped.ends_with(SHADOW_LOG_TRUNCATION_MARKER));
        assert_eq!(clamp_utf8("short", 100), "short");
    }

    #[test]
    fn streamed_json_preserves_the_existing_preview_prefix() {
        for value in [
            "short".to_owned(),
            "x".repeat(SHADOW_LOG_VALUE_MAX_BYTES - 2),
            "x".repeat(SHADOW_LOG_VALUE_MAX_BYTES - 1),
            "é🙂".repeat(SHADOW_LOG_VALUE_MAX_BYTES),
            "\n\t\"\\".repeat(SHADOW_LOG_VALUE_MAX_BYTES),
        ] {
            assert_eq!(
                json_preview(&value).unwrap(),
                preview_value(&serde_json::to_string(&value).unwrap())
            );
        }
    }

    struct LargeSequence {
        fail_at_end: bool,
    }

    impl Serialize for LargeSequence {
        fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
            let mut sequence = serializer.serialize_seq(Some(10_000))?;
            for _ in 0..10_000 {
                sequence.serialize_element(&"large element".repeat(100))?;
            }
            if self.fail_at_end {
                return Err(S::Error::custom("failure after the logged prefix"));
            }
            sequence.end()
        }
    }

    #[test]
    fn large_json_construction_keeps_a_capped_buffer_and_detects_late_errors() {
        let mut prefix = JsonPrefix::new();
        serde_json::to_writer(&mut prefix, &LargeSequence { fail_at_end: false }).unwrap();
        assert_eq!(prefix.bytes.len(), SHADOW_LOG_VALUE_MAX_BYTES);
        assert_eq!(prefix.bytes.capacity(), SHADOW_LOG_VALUE_MAX_BYTES);
        assert!(prefix.finish().ends_with(SHADOW_LOG_TRUNCATION_MARKER));
        assert!(json_preview(&LargeSequence { fail_at_end: true }).is_none());
    }
}
