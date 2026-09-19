//! Text payload conversion.
//!
//! Text frame payloads and decompressed `0x01` envelopes may hold any bytes.
//! `formal/PROTOCOL.md` ("Text payload domain") fixes how they become text:
//! the WHATWG UTF-8 decoder with replacement error handling and without BOM
//! removal, so every maximal ill-formed subpart becomes exactly one U+FFFD.

/// The UTF-8 encoding of U+FFFD.
const REPLACEMENT: [u8; 3] = [0xEF, 0xBF, 0xBD];

/// Decode bytes as UTF-8 with one U+FFFD per maximal ill-formed subpart and
/// no BOM removal (the WHATWG decoder with replacement error handling).
///
/// The result is always valid UTF-8. Well-formed input is returned unchanged,
/// so valid text costs one validation pass and one copy.
pub fn replacement_utf8(bytes: &[u8]) -> Vec<u8> {
    if std::str::from_utf8(bytes).is_ok() {
        return bytes.to_vec();
    }
    let mut out = Vec::with_capacity(bytes.len() + REPLACEMENT.len());
    let mut rest = bytes;
    while !rest.is_empty() {
        match std::str::from_utf8(rest) {
            Ok(_) => {
                out.extend_from_slice(rest);
                break;
            }
            Err(error) => {
                let valid = error.valid_up_to();
                out.extend_from_slice(&rest[..valid]);
                rest = &rest[valid..];
                let consumed = ill_formed_subpart_len(rest);
                out.extend_from_slice(&REPLACEMENT);
                rest = &rest[consumed..];
            }
        }
    }
    out
}

/// Length of the maximal ill-formed subpart at the start of `bytes`, whose
/// first byte is known not to begin a well-formed sequence.
///
/// A lead in `C2..DF`, `E0..EF` or `F0..F4` swallows the continuation bytes
/// that are valid *in their position* (including the narrowed second-byte
/// ranges after `E0`, `ED`, `F0` and `F4`); the first byte that is not valid
/// there is left to be reprocessed as the next lead. Any other first byte is a
/// one-byte subpart.
fn ill_formed_subpart_len(bytes: &[u8]) -> usize {
    let lead = bytes[0];
    let wanted = match lead {
        0xC2..=0xDF => 2,
        0xE0..=0xEF => 3,
        0xF0..=0xF4 => 4,
        _ => return 1,
    };
    let mut consumed = 1;
    while consumed < wanted && consumed < bytes.len() {
        let byte = bytes[consumed];
        let (lower, upper) = if consumed == 1 {
            match lead {
                0xE0 => (0xA0, 0xBF),
                0xED => (0x80, 0x9F),
                0xF0 => (0x90, 0xBF),
                0xF4 => (0x80, 0x8F),
                _ => (0x80, 0xBF),
            }
        } else {
            (0x80, 0xBF)
        };
        if byte < lower || byte > upper {
            break;
        }
        consumed += 1;
    }
    consumed
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
