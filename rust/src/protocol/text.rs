//! Text payload conversion.

/// Decode bytes as UTF-8 with one U+FFFD per maximal ill-formed subpart and
/// no BOM removal (the WHATWG decoder with replacement error handling).
pub fn replacement_utf8(bytes: &[u8]) -> Vec<u8> {
    let _ = bytes;
    todo!("replacement_utf8")
}
