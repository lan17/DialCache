//! Frame, decode, timestamp, duration and envelope conformance against the
//! portable protocol corpus (`formal/protocol-vectors.json` plus the
//! Quint-generated frame and envelope artifacts).

// TODO(integrator): switch to `formal/fixtures.rs` and delete `formal/fixtures_tmp.rs`.
#[path = "formal/fixtures_tmp.rs"]
mod fixtures;
#[path = "formal/frame_vectors.rs"]
mod frame_vectors;

use serde_json::Value;

type Check = fn(&Value) -> Result<(), String>;

/// The eight groups this test owns, with their fixed-corpus sizes.
const GROUPS: [(&str, usize, Check); 8] = [
    ("frameVectors", 8, frame_vectors::check_frame_vector),
    (
        "trackedDecodeVectors",
        38,
        frame_vectors::check_tracked_decode_vector,
    ),
    (
        "untrackedDecodeVectors",
        18,
        frame_vectors::check_untracked_decode_vector,
    ),
    (
        "invalidTimestampVectors",
        3,
        frame_vectors::check_invalid_timestamp_vector,
    ),
    ("durationVectors", 7, frame_vectors::check_duration_vector),
    ("envelopeVectors", 7, frame_vectors::check_envelope_vector),
    (
        "compressedDecodeVectors",
        12,
        frame_vectors::check_compressed_decode_vector,
    ),
    (
        "compressionWriteVectors",
        6,
        frame_vectors::check_compression_write_vector,
    ),
];

#[test]
fn protocol_frame_groups_conform() {
    let groups = fixtures::protocol_groups("all");
    let generated = fixtures::protocol_groups("generated");
    let mut failures = Vec::new();
    let mut total = 0;
    let mut expected_total = 0;
    for (name, fixed_count, check) in GROUPS {
        let rows = groups
            .get(name)
            .unwrap_or_else(|| panic!("protocol corpus lacks group {name}"));
        let generated_rows = generated.get(name).map_or(0, Vec::len);
        expected_total += fixed_count + generated_rows;
        let mut passed = 0;
        for vector in rows {
            total += 1;
            let vector_name = vector
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("<unnamed>");
            match check(vector) {
                Ok(()) => passed += 1,
                Err(reason) => failures.push(format!("{name} / {vector_name}: {reason}")),
            }
        }
        println!(
            "{name}: {passed}/{} ({fixed_count} fixed + {generated_rows} generated)",
            rows.len()
        );
    }
    assert!(
        failures.is_empty(),
        "{} protocol vector(s) failed:\n{}",
        failures.len(),
        failures.join("\n")
    );
    assert_eq!(total, expected_total, "review protocol vector coverage");
    println!("frame protocol groups exercised: {total} vectors");
}
