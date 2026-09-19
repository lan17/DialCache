//! Bounded previews for mismatch warnings.

/// Maximum UTF-8 bytes of a logged cache key.
pub const SHADOW_LOG_KEY_MAX_BYTES: usize = 2 * 1024;
/// Maximum UTF-8 bytes of a logged value preview.
pub const SHADOW_LOG_VALUE_MAX_BYTES: usize = 8 * 1024;
/// Marker appended to a clamped preview.
pub const SHADOW_LOG_TRUNCATION_MARKER: &str = "...[truncated]";

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

    #[test]
    fn clamps_on_character_boundaries() {
        let text = "é".repeat(2000);
        let clamped = clamp_utf8(&text, 100);
        assert!(clamped.len() <= 100);
        assert!(clamped.ends_with(SHADOW_LOG_TRUNCATION_MARKER));
        assert_eq!(clamp_utf8("short", 100), "short");
    }
}
