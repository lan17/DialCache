//! TEMPORARY stand-in for `tests/formal/fixtures.rs`, which another agent
//! writes concurrently with the same function names. The integrator switches
//! `#[path = "formal/fixtures_tmp.rs"]` in `tests/protocol_frames.rs` to
//! `formal/fixtures.rs` and deletes this file. This copy performs no
//! provenance (source hash) checks.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use serde_json::Value;

/// Replaces every lone UTF-16 surrogate escape in a fixture file so the JSON
/// still parses; vector runners substitute the binding's input conversion.
pub const LONE_SURROGATE_MARKER: char = '\u{E000}';

/// A path relative to the repository root.
pub fn repo_path(relative: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join(relative)
}

/// Parse a JSON file whose strings may contain lone UTF-16 surrogate escapes,
/// which `serde_json` rejects; each becomes [`LONE_SURROGATE_MARKER`].
pub fn load_json_marking_lone_surrogates(path: impl AsRef<Path>) -> Value {
    let path = path.as_ref();
    let raw = std::fs::read_to_string(path)
        .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    serde_json::from_str(&mark_lone_surrogates(&raw))
        .unwrap_or_else(|error| panic!("parse {}: {error}", path.display()))
}

fn mark_lone_surrogates(raw: &str) -> String {
    let bytes = raw.as_bytes();
    let mut out = String::with_capacity(raw.len());
    let mut index = 0;
    let escape_at = |at: usize| -> Option<u32> {
        let hex = bytes.get(at..at + 6)?;
        if &hex[..2] != b"\\u" {
            return None;
        }
        u32::from_str_radix(std::str::from_utf8(&hex[2..]).ok()?, 16).ok()
    };
    while index < bytes.len() {
        if bytes[index] != b'\\' {
            let char_len = utf8_char_len(bytes[index]);
            out.push_str(&raw[index..index + char_len]);
            index += char_len;
            continue;
        }
        match escape_at(index) {
            Some(unit) if (0xD800..=0xDBFF).contains(&unit) => {
                if escape_at(index + 6).is_some_and(|low| (0xDC00..=0xDFFF).contains(&low)) {
                    out.push_str(&raw[index..index + 12]);
                    index += 12;
                } else {
                    out.push_str(&format!("\\u{:04X}", LONE_SURROGATE_MARKER as u32));
                    index += 6;
                }
            }
            Some(unit) if (0xDC00..=0xDFFF).contains(&unit) => {
                out.push_str(&format!("\\u{:04X}", LONE_SURROGATE_MARKER as u32));
                index += 6;
            }
            Some(_) => {
                out.push_str(&raw[index..index + 6]);
                index += 6;
            }
            None => {
                // Any other escape is two bytes: copy both so `\\` never hides a `\u`.
                let end = (index + 2).min(bytes.len());
                out.push_str(&raw[index..end]);
                index = end;
            }
        }
    }
    out
}

fn utf8_char_len(lead: u8) -> usize {
    match lead {
        0x00..=0x7F => 1,
        0xC0..=0xDF => 2,
        0xE0..=0xEF => 3,
        _ => 4,
    }
}

/// The portable protocol vector groups: `formal/protocol-vectors.json` merged
/// with every Quint-generated protocol artifact listed in
/// `formal/execution.json`. `selection` is `"all"`, `"generated"` or
/// `"fixed"` (the values of `DIALCACHE_PROTOCOL_CORPUS`).
pub fn protocol_groups(selection: &str) -> BTreeMap<String, Vec<Value>> {
    assert!(
        matches!(selection, "all" | "generated" | "fixed"),
        "unknown protocol corpus selection {selection}"
    );
    let fixed = load_json_marking_lone_surrogates(repo_path("formal/protocol-vectors.json"));
    assert_eq!(
        fixed.get("schemaVersion").and_then(Value::as_u64),
        Some(3),
        "unsupported protocol vector schema"
    );
    let mut groups: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    for (name, rows) in fixed.as_object().expect("protocol vectors are an object") {
        if name == "schemaVersion" {
            continue;
        }
        let rows = rows
            .as_array()
            .unwrap_or_else(|| panic!("protocol group {name} is not an array"));
        let entry = groups.entry(name.clone()).or_default();
        if selection != "generated" {
            entry.extend(rows.iter().cloned());
        }
    }
    if selection == "fixed" {
        return groups;
    }
    let manifest = load_json_marking_lone_surrogates(repo_path("formal/execution.json"));
    let models = manifest
        .get("models")
        .and_then(Value::as_array)
        .expect("execution.json lists models");
    for model in models {
        let Some(export) = model.get("vectorExport") else {
            continue;
        };
        if export.get("kind").and_then(Value::as_str) != Some("protocol") {
            continue;
        }
        let artifact = export
            .get("artifact")
            .and_then(Value::as_str)
            .expect("protocol export names an artifact");
        let generated = load_json_marking_lone_surrogates(repo_path(artifact));
        assert_eq!(
            generated.get("schemaVersion").and_then(Value::as_u64),
            Some(3),
            "{artifact}: unsupported schema"
        );
        let mut count = 0;
        for (name, rows) in generated
            .as_object()
            .expect("generated artifact is an object")
        {
            if name == "schemaVersion" || name == "provenance" {
                continue;
            }
            let rows = rows
                .as_array()
                .unwrap_or_else(|| panic!("{artifact}: group {name} is not an array"));
            let entry = groups
                .get_mut(name)
                .unwrap_or_else(|| panic!("{artifact}: unknown generated protocol group {name}"));
            entry.extend(rows.iter().cloned());
            count += rows.len();
        }
        let expected = export
            .get("cases")
            .and_then(Value::as_u64)
            .expect("protocol export declares cases") as usize;
        assert_eq!(
            count, expected,
            "{artifact}: incomplete generated protocol vector inventory"
        );
    }
    groups
}
