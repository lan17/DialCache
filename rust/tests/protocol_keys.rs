//! Replays every key, invalid-key, argument-normalization and rollout vector
//! of the portable protocol corpus (fixed plus generated) through
//! `dialcache::identity`.
//!
//! Set `DIALCACHE_PROTOCOL_CORPUS=fixed|generated` to narrow the corpus.

#[path = "formal/digest.rs"]
mod digest;

#[path = "formal/fixtures.rs"]
mod fixtures;
#[path = "formal/key_vectors.rs"]
mod key_vectors;

use dialcache::identity::{normalize_args, ArgValue, Identity};
use serde_json::{json, Value};

type Check = fn(&Value) -> Result<(), String>;

#[test]
fn bigint_text_uses_canonical_keys_but_strings_remain_literal() {
    for (text, expected) in [
        ("1", "1"),
        ("0001", "1"),
        ("-1", "-1"),
        ("-0001", "-1"),
        ("0", "0"),
        ("-0", "0"),
        ("000", "0"),
        ("-000", "0"),
        ("0010200", "10200"),
        ("-0010200", "-10200"),
    ] {
        let args = normalize_args([("n", ArgValue::BigInt(text.into()))]).unwrap();
        assert_eq!(args, vec![("n".into(), expected.into())], "{text}");
        for tracked in [false, true] {
            let identity = Identity::new("id", text, "Get")
                .namespace("urn")
                .tracked(tracked);
            let canonical = normalize_args([("n", ArgValue::Str(expected.into()))]).unwrap();
            assert_eq!(
                identity.clone().args(args.clone()).keys().unwrap(),
                identity.clone().args(canonical).keys().unwrap(),
                "{text}, tracked={tracked}"
            );
            assert_eq!(identity.id, text);
        }
        let literal = normalize_args([("n", ArgValue::Str(text.into()))]).unwrap();
        assert_eq!(literal, vec![("n".into(), text.into())]);
    }
}

#[test]
fn bigint_text_preserves_arbitrary_width_magnitudes() {
    let magnitude = "12345678901234567890".repeat(100);
    for sign in ["", "-"] {
        let expected = format!("{sign}{magnitude}");
        for text in [expected.clone(), format!("{sign}000{magnitude}")] {
            let actual = normalize_args([("n", ArgValue::BigInt(text))]).unwrap();
            assert_eq!(actual, vec![("n".into(), expected.clone())]);
        }
    }
}

#[test]
fn key_assertions_distinguish_library_rejections_from_bad_fixtures() {
    let valid_shape = json!({
        "input":{"namespace":"bad{namespace", "keyType":"id", "id":"1", "useCase":"Example", "tracked":false, "args":[]},
        "logicalKey":"expected", "valueKey":"expected", "watermarkKey":null,
    });
    let error = key_vectors::check_key_vector(&valid_shape).unwrap_err();
    assert!(
        error.starts_with("PROTOCOL_ASSERTION_FAILURE expected:"),
        "{error}"
    );
    let mut malformed = valid_shape;
    malformed["logicalKey"] = json!(5);
    let error = key_vectors::check_key_vector(&malformed).unwrap_err();
    assert!(!error.contains("PROTOCOL_ASSERTION_FAILURE"), "{error}");
}

const GROUPS: [(&str, Check); 4] = [
    ("keyVectors", key_vectors::check_key_vector),
    ("invalidKeyVectors", key_vectors::check_invalid_key_vector),
    (
        "normalizeArgsVectors",
        key_vectors::check_normalize_args_vector,
    ),
    ("rampVectors", key_vectors::check_ramp_vector),
];

#[test]
fn key_protocol_vectors_replay() {
    let groups = fixtures::protocol_groups("all");
    let mut failures = Vec::new();
    for (group, check) in GROUPS {
        let rows = groups
            .get(group)
            .unwrap_or_else(|| panic!("protocol corpus has no {group} group"));
        assert!(!rows.is_empty(), "{group}: no vectors selected");
        let mut passed = 0;
        for row in rows {
            let name = row["name"].as_str().unwrap_or("<unnamed>");
            match check(row) {
                Ok(()) => passed += 1,
                Err(reason) => failures.push(format!("{group} {name:?}: {reason}")),
            }
        }
        println!("{group}: {passed}/{} passed", rows.len());
    }
    assert!(
        failures.is_empty(),
        "{} vector(s) failed:\n{}",
        failures.len(),
        failures.join("\n")
    );
}
