//! Replays every key, invalid-key, argument-normalization and rollout vector
//! of the portable protocol corpus (fixed plus generated) through
//! `dialcache::identity`.
//!
//! Set `DIALCACHE_PROTOCOL_CORPUS=fixed|generated` to narrow the corpus.

#[path = "formal/fixtures.rs"]
mod fixtures;
#[path = "formal/key_vectors.rs"]
mod key_vectors;

use serde_json::Value;

type Check = fn(&Value) -> Result<(), String>;

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
