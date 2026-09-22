//! Text payload conversion.
//!
//! Text frame payloads and decompressed `0x01` envelopes may hold any bytes.
//! `formal/PROTOCOL.md` ("Text payload domain") fixes how they become text:
//! the WHATWG UTF-8 decoder with replacement error handling and without BOM
//! removal, so every maximal ill-formed subpart becomes exactly one U+FFFD.

/// Decode bytes as UTF-8 with one U+FFFD per maximal ill-formed subpart and
/// no BOM removal (the WHATWG decoder with replacement error handling).
///
/// The result is always valid UTF-8. Well-formed input is returned unchanged,
/// so valid text costs one validation pass and one copy.
pub fn replacement_utf8(bytes: &[u8]) -> Vec<u8> {
    String::from_utf8_lossy(bytes).into_owned().into_bytes()
}

#[cfg(test)]
mod tests {
    use super::replacement_utf8;

    fn decoded(bytes: &[u8]) -> String {
        String::from_utf8(replacement_utf8(bytes)).expect("replacement output is UTF-8")
    }

    #[test]
    fn protocol_replacement_table() {
        // The representative outcomes fixed by formal/PROTOCOL.md.
        assert_eq!(decoded(&[0x22, 0xFF, 0x22]), "\"\u{FFFD}\"");
        assert_eq!(decoded(&[0xE2, 0x82]), "\u{FFFD}");
        assert_eq!(decoded(&[0xE2, 0x82, 0x41]), "\u{FFFD}A");
        assert_eq!(decoded(&[0xED, 0xA0, 0x80]), "\u{FFFD}\u{FFFD}\u{FFFD}");
        assert_eq!(
            decoded(&[0xF4, 0x90, 0x80, 0x80]),
            "\u{FFFD}\u{FFFD}\u{FFFD}\u{FFFD}"
        );
        assert_eq!(decoded(&[0xEF, 0xBB, 0xBF, 0x61]), "\u{FEFF}a");
    }

    #[test]
    fn well_formed_input_is_unchanged() {
        let text = "\u{80}\u{7FF}\u{800}\u{D7FF}\u{E000}\u{FFFF}\u{10000}\u{10FFFF}\0";
        assert_eq!(replacement_utf8(text.as_bytes()), text.as_bytes());
        assert!(replacement_utf8(b"").is_empty());
    }

    #[test]
    fn isolated_continuations_and_overlong_forms_replace_separately() {
        assert_eq!(decoded(&[0x80, 0xBF]), "\u{FFFD}\u{FFFD}");
        assert_eq!(
            decoded(&[0xC0, 0xAF, 0xE0, 0x80, 0x80]),
            "\u{FFFD}\u{FFFD}\u{FFFD}\u{FFFD}\u{FFFD}"
        );
        // A lead that reaches end of input after accepted continuations.
        assert_eq!(decoded(&[0xF0, 0x9F, 0x98]), "\u{FFFD}");
        // The narrowed second byte after F0 rejects 8F; 8F is then a lone continuation.
        assert_eq!(
            decoded(&[0xF0, 0x8F, 0x80, 0x80]),
            "\u{FFFD}\u{FFFD}\u{FFFD}\u{FFFD}"
        );
        // A complete prefix interrupted by a new lead keeps the second sequence intact.
        assert_eq!(decoded(&[0xE2, 0x82, 0xC3, 0xA9]), "\u{FFFD}\u{E9}");
        // Leads beyond F4 and FE/FF are single-byte subparts.
        assert_eq!(
            decoded(&[0xF5, 0x80, 0xFE, 0xFF, 0x41]),
            "\u{FFFD}\u{FFFD}\u{FFFD}\u{FFFD}A"
        );
    }
}
