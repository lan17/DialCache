//! Shared loading of the portable protocol vector corpus.
//!
//! Mirrors `go/protocol_test.go` `vectors()` and
//! `go/generated_protocol_test.go`: the fixed vectors in
//! `formal/protocol-vectors.json` are merged with every generated protocol
//! artifact registered in `formal/execution.json`, after the artifact's
//! provenance fingerprints are verified against the model sources.
//!
//! Include from a test binary with `#[path = "formal/fixtures.rs"] mod fixtures;`.

#![allow(dead_code)]

use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

use serde_json::Value;

/// Replaces every lone UTF-16 surrogate escape in fixture JSON so the text
/// can be parsed at all. Components carrying this marker are unrepresentable
/// as Rust strings and are rejected at the fixture boundary.
pub const LONE_SURROGATE_MARKER: char = '\u{E000}';

/// Environment variable selecting the corpus: `all` (default), `generated` or `fixed`.
pub const CORPUS_ENV: &str = "DIALCACHE_PROTOCOL_CORPUS";

/// Resolve a repository-relative path from the crate manifest directory's parent.
pub fn repo_path(relative: &str) -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("..")
        .join(relative)
}

fn read_repo_text(relative: &str) -> String {
    let path = repo_path(relative);
    fs::read_to_string(&path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()))
}

/// Parse fixture JSON that may contain lone surrogate escapes (`\ud800`,
/// `\udc00`), which `serde_json` rejects. Each lone escape is replaced with
/// [`LONE_SURROGATE_MARKER`] before parsing; valid surrogate pairs and every
/// other escape are left untouched.
pub fn load_json_marking_lone_surrogates(path: impl AsRef<Path>) -> Value {
    let path = path.as_ref();
    let text =
        fs::read_to_string(path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
    let marked = mark_lone_surrogate_escapes(&text);
    serde_json::from_str(&marked)
        .unwrap_or_else(|error| panic!("parse {}: {error}", path.display()))
}

/// Replace every lone surrogate escape in JSON source text with `\ue000`.
pub fn mark_lone_surrogate_escapes(text: &str) -> String {
    const MARKER_ESCAPE: &str = "\\ue000";
    let bytes = text.as_bytes();
    let mut out = String::with_capacity(text.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] != b'\\' {
            let rest = &text[index..];
            let ch = rest.chars().next().expect("index is on a char boundary");
            out.push(ch);
            index += ch.len_utf8();
            continue;
        }
        match unicode_escape_at(bytes, index) {
            Some(unit) if (0xD800..=0xDBFF).contains(&unit) => {
                let pair = unicode_escape_at(bytes, index + 6)
                    .filter(|low| (0xDC00..=0xDFFF).contains(low));
                if pair.is_some() {
                    out.push_str(&text[index..index + 12]);
                    index += 12;
                } else {
                    out.push_str(MARKER_ESCAPE);
                    index += 6;
                }
            }
            Some(unit) if (0xDC00..=0xDFFF).contains(&unit) => {
                // A low surrogate preceded by a high one was consumed with its pair above.
                out.push_str(MARKER_ESCAPE);
                index += 6;
            }
            Some(_) => {
                out.push_str(&text[index..index + 6]);
                index += 6;
            }
            None => {
                // Any other escape: copy the backslash and the escaped byte so a
                // `\\` cannot be mistaken for the start of a `\u` escape.
                let end = (index + 2).min(bytes.len());
                out.push_str(&text[index..end]);
                index = end;
            }
        }
    }
    out
}

/// The code unit of a `\uXXXX` escape starting at `index`, when one is there.
fn unicode_escape_at(bytes: &[u8], index: usize) -> Option<u16> {
    if index + 6 > bytes.len() || bytes[index] != b'\\' || bytes[index + 1] != b'u' {
        return None;
    }
    let hex = std::str::from_utf8(&bytes[index + 2..index + 6]).ok()?;
    if !hex.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return None;
    }
    u16::from_str_radix(hex, 16).ok()
}

pub use crate::digest::sha256_hex;

/// Every generated protocol vector group registered in `formal/execution.json`,
/// keyed by field name, after validating each artifact's schema, provenance
/// and case inventory the way `go/generated_protocol_test.go` does.
pub fn quint_protocol_groups() -> BTreeMap<String, Vec<Value>> {
    let manifest: Value = serde_json::from_str(&read_repo_text("formal/execution.json"))
        .expect("parse formal/execution.json");
    let models = manifest["models"]
        .as_array()
        .expect("execution.json models array");
    let mut groups: BTreeMap<String, Vec<Value>> = BTreeMap::new();
    for model in models {
        let Some(export) = model
            .get("vectorExport")
            .filter(|export| export["kind"] == "protocol")
        else {
            continue;
        };
        let model_path = model["path"].as_str().expect("model path");
        let artifact = export["artifact"].as_str().expect("vectorExport.artifact");
        let sources: Vec<&str> = export["sources"]
            .as_array()
            .expect("vectorExport.sources")
            .iter()
            .map(|s| s.as_str().expect("source path"))
            .collect();
        let cases = export["cases"].as_u64().expect("vectorExport.cases") as usize;

        let envelope = load_json_marking_lone_surrogates(repo_path(artifact));
        let object = envelope
            .as_object()
            .unwrap_or_else(|| panic!("{artifact}: artifact is not an object"));
        assert_eq!(
            object.get("schemaVersion"),
            Some(&Value::from(3)),
            "{artifact}: unsupported schemaVersion"
        );
        let provenance = &object["provenance"];
        assert_eq!(
            provenance["model"].as_str(),
            Some(model_path),
            "{artifact}: provenance.model mismatch"
        );
        let digests = provenance["sourceSha256"]
            .as_object()
            .unwrap_or_else(|| panic!("{artifact}: provenance.sourceSha256 missing"));
        assert_eq!(
            digests.len(),
            sources.len(),
            "{artifact}: provenance source count differs from execution.json"
        );
        for source in &sources {
            let bytes = fs::read(repo_path(source))
                .unwrap_or_else(|error| panic!("read {source}: {error}"));
            let expected = digests
                .get(*source)
                .and_then(Value::as_str)
                .unwrap_or_else(|| panic!("{artifact}: no provenance digest for {source}"));
            assert_eq!(
                sha256_hex(&bytes),
                expected,
                "stale generated protocol source: {source}"
            );
        }

        let mut seen = std::collections::BTreeSet::new();
        let mut count = 0;
        for (field, rows) in object {
            if field == "schemaVersion" || field == "provenance" {
                continue;
            }
            let rows = rows
                .as_array()
                .unwrap_or_else(|| panic!("{artifact}: field {field} is not an array"));
            for row in rows {
                let name = row["name"].as_str().unwrap_or("");
                assert!(
                    !name.is_empty() && seen.insert(name.to_owned()),
                    "{artifact}: duplicate or missing generated protocol case {name:?}"
                );
            }
            count += rows.len();
            groups
                .entry(field.clone())
                .or_default()
                .extend(rows.iter().cloned());
        }
        assert_eq!(
            count, cases,
            "{artifact}: incomplete generated protocol vector inventory"
        );
    }
    groups
}

/// The effective corpus selection: the `DIALCACHE_PROTOCOL_CORPUS` variable
/// when set and non-empty, otherwise `default`.
pub fn corpus_selection(default: &str) -> String {
    match std::env::var(CORPUS_ENV) {
        Ok(value) if !value.is_empty() => value,
        _ => default.to_owned(),
    }
}

/// The fixed protocol vectors merged with the generated groups, keyed by
/// group name. `selection` is the default corpus (`all`, `generated` or
/// `fixed`); `DIALCACHE_PROTOCOL_CORPUS` overrides it like `go/protocol_test.go`.
pub fn protocol_groups(selection: &str) -> BTreeMap<String, Vec<Value>> {
    let selection = corpus_selection(selection);
    assert!(
        matches!(selection.as_str(), "all" | "generated" | "fixed"),
        "unknown protocol corpus selection {selection:?}"
    );

    let fixed = load_json_marking_lone_surrogates(repo_path("formal/protocol-vectors.json"));
    let fixed = fixed
        .as_object()
        .expect("protocol-vectors.json is an object");
    assert_eq!(
        fixed.get("schemaVersion"),
        Some(&Value::from(3)),
        "unsupported protocol vector schema"
    );
    let mut groups: BTreeMap<String, Vec<Value>> = fixed
        .iter()
        .filter(|(name, _)| name.as_str() != "schemaVersion")
        .map(|(name, rows)| {
            let rows = rows
                .as_array()
                .unwrap_or_else(|| panic!("protocol-vectors.json: {name} is not an array"));
            (
                name.clone(),
                if selection == "generated" {
                    Vec::new()
                } else {
                    rows.clone()
                },
            )
        })
        .collect();
    if selection != "fixed" {
        for (name, rows) in quint_protocol_groups() {
            groups
                .get_mut(&name)
                .unwrap_or_else(|| panic!("unknown generated protocol group {name}"))
                .extend(rows);
        }
    }
    groups
}

/// An executed protocol assertion, distinguished from malformed fixture input
/// and environmental codec failures by the mutation measurement.
pub fn assertion_mismatch(expected: impl std::fmt::Debug, actual: impl std::fmt::Debug) -> String {
    format!("PROTOCOL_ASSERTION_FAILURE expected: {expected:?}\nactual: {actual:?}")
}

#[cfg(test)]
mod tests {
    #[allow(unused_imports)]
    use super::*;

    #[test]
    fn sha256_matches_known_digests() {
        assert_eq!(
            sha256_hex(b""),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(
            sha256_hex(b"abc"),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
        let long = b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq";
        assert_eq!(
            sha256_hex(long),
            "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
        );
        assert_eq!(
            sha256_hex(&[b'a'; 1_000_000]),
            "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"
        );
    }

    #[test]
    fn lone_surrogates_are_marked_and_pairs_kept() {
        assert_eq!(mark_lone_surrogate_escapes(r#""\ud800""#), r#""\ue000""#);
        assert_eq!(mark_lone_surrogate_escapes(r#""\udc00""#), r#""\ue000""#);
        assert_eq!(
            mark_lone_surrogate_escapes(r#""\ud83d\ude00""#),
            r#""\ud83d\ude00""#
        );
        assert_eq!(
            mark_lone_surrogate_escapes(r#""\udc00\ud800""#),
            r#""\ue000\ue000""#
        );
        assert_eq!(
            mark_lone_surrogate_escapes(r#""\ud800\ud800\udc00""#),
            r#""\ue000\ud800\udc00""#
        );
        assert_eq!(
            mark_lone_surrogate_escapes(r#""a\\ud800""#),
            r#""a\\ud800""#
        );
        assert_eq!(
            mark_lone_surrogate_escapes(r#""\u00e9\ue000""#),
            r#""\u00e9\ue000""#
        );
        assert_eq!(
            mark_lone_surrogate_escapes(r#""\uD800x\uDC00""#),
            r#""\ue000x\ue000""#
        );
        let parsed: Value =
            serde_json::from_str(&mark_lone_surrogate_escapes(r#"{"id":"x\ud800y"}"#)).unwrap();
        assert_eq!(parsed["id"].as_str(), Some("x\u{e000}y"));
    }
}
