//! Witness-evidence check.
//!
//! Ports `checkWitnessEvidenceAt`, `witnessTraceKind` and `sharedReplaySources`
//! from `go/witness_evidence_test.go`. Required reachability witnesses have one
//! evaluator shared by the language drivers (`node formal/witnesses.mjs
//! evaluate`); reusing its result requires the exact corpus and definition
//! hashes recorded in `<directory>/<profile>.json` to match this checkout byte
//! for byte. It does not replace any native execution or observation assertion.

use super::inventory::trace_kind;
use super::json::strict_parse;
use serde::{Deserialize, Deserializer};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

/// Hex SHA-256 of a file's bytes.
pub fn file_sha256(path: &Path) -> Result<String, String> {
    let raw = std::fs::read(path).map_err(|error| format!("{}: {error}", path.display()))?;
    Ok(sha256_hex(&raw))
}

/// Hex SHA-256 of `data`.
pub fn sha256_hex(data: &[u8]) -> String {
    sha256::digest(data)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn null_default<'de, D: Deserializer<'de>, T: Default + Deserialize<'de>>(
    deserializer: D,
) -> Result<T, D::Error> {
    Option::<T>::deserialize(deserializer).map(Option::unwrap_or_default)
}

/// `{ path?, name?, sha256 }` fingerprint of one input or history.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, serde::Serialize)]
#[serde(default)]
pub struct Digest {
    /// Repository-relative definition path (inputs).
    pub path: String,
    /// History file name (corpus).
    pub name: String,
    /// Hex SHA-256.
    pub sha256: String,
}

/// One history that earned a label.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, serde::Serialize)]
#[serde(default)]
pub struct Trace {
    /// History file name.
    pub name: String,
    /// `sampled` or `regression`.
    pub kind: String,
    /// Step indices at which the classifier credited the label.
    #[serde(deserialize_with = "null_default")]
    pub checkpoints: Vec<i64>,
}

/// Per-label provenance (schema 2).
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, serde::Serialize)]
#[serde(default)]
pub struct Label {
    /// Sampled histories that earned the label.
    pub sampled: i64,
    /// Exported regressions that earned the label.
    pub regression: i64,
    /// The citing histories.
    #[serde(deserialize_with = "null_default")]
    pub traces: Vec<Trace>,
}

/// The evidence document written by `node formal/witnesses.mjs evaluate`.
#[derive(Debug, Clone, Default, PartialEq, Eq, Deserialize, serde::Serialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Evidence {
    pub schema_version: i64,
    pub profile: String,
    pub traces: i64,
    #[serde(deserialize_with = "null_default")]
    pub required: Vec<String>,
    #[serde(deserialize_with = "null_default")]
    pub seen: Vec<String>,
    /// `None` when the document lacks per-label provenance entirely.
    pub labels: Option<HashMap<String, Label>>,
    #[serde(deserialize_with = "null_default")]
    pub inputs: Vec<Digest>,
    #[serde(deserialize_with = "null_default")]
    pub corpus: Vec<Digest>,
}

fn read_strict(path: &Path) -> Result<serde_json::Value, String> {
    let text =
        std::fs::read_to_string(path).map_err(|error| format!("{}: {error}", path.display()))?;
    strict_parse(&text).map_err(|error| format!("{}: {error}", path.display()))
}

fn decode<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<T, String> {
    serde_json::from_value(read_strict(path)?)
        .map_err(|error| format!("{}: {error}", path.display()))
}

/// Checks `<directory>/<profile>.json` against the registry, definitions and
/// corpus of the checkout at `root`, where `paths` are the histories this run
/// replays for the profile.
pub fn check_witness_evidence(
    root: &Path,
    profile: &str,
    directory: &Path,
    paths: &[PathBuf],
) -> Result<(), String> {
    let evidence: Evidence = decode(&directory.join(format!("{profile}.json")))?;
    if evidence.schema_version != 2
        || evidence.profile != profile
        || evidence.traces != paths.len() as i64
        || evidence.corpus.len() != paths.len()
    {
        return Err(format!("unsupported/incomplete {profile} witness evidence"));
    }
    let registry: HashMap<String, Vec<String>> =
        decode(&root.join("formal/coverage-witnesses.json"))?;
    let required = registry.get(profile).cloned().unwrap_or_default();
    if required.is_empty() || required != evidence.required {
        return Err(format!("{profile} required witness registry differs"));
    }
    let mut seen = std::collections::HashSet::new();
    for name in &evidence.seen {
        if !seen.insert(name.as_str()) {
            return Err(format!("duplicate witness {name}"));
        }
    }
    for name in &required {
        if !seen.contains(name.as_str()) {
            return Err(format!("{profile} missing witness {name}"));
        }
    }
    // Every required label names the histories that earned it: at least one
    // sampled history or exported regression, each part of the bound corpus
    // with the kind its directory gives it and cited at a checkpoint, and the
    // split counts must agree with the cited histories.
    let labels = evidence
        .labels
        .as_ref()
        .ok_or_else(|| format!("{profile} witness evidence lacks per-label provenance"))?;
    let corpus_kinds: HashMap<String, &str> = paths
        .iter()
        .map(|path| (base_name(path), trace_kind(path)))
        .collect();
    for name in &required {
        let label = match labels.get(name) {
            Some(label) if label.sampled + label.regression >= 1 => label,
            _ => return Err(format!("{profile} witness {name} lacks provenance")),
        };
        let (mut sampled, mut regression) = (0i64, 0i64);
        for trace in &label.traces {
            let kind = *corpus_kinds.get(&trace.name).ok_or_else(|| {
                format!(
                    "{profile} witness {name} cites an unknown history {}",
                    trace.name
                )
            })?;
            if trace.kind != kind {
                return Err(format!(
                    "{profile} witness {name} reports {kind} history {} as {}",
                    trace.name, trace.kind
                ));
            }
            if trace.checkpoints.is_empty() {
                return Err(format!(
                    "{profile} witness {name} cites {} without a checkpoint",
                    trace.name
                ));
            }
            if kind == "sampled" {
                sampled += 1;
            } else {
                regression += 1;
            }
        }
        if sampled != label.sampled || regression != label.regression {
            return Err(format!(
                "{profile} witness {name} counts {} sampled and {} regression hits but cites {sampled} and {regression}",
                label.sampled, label.regression
            ));
        }
    }
    // The evidence binds language-neutral definitions only: the registry, the
    // required witnesses, the execution manifest, the profile's model and the
    // observation library, then every Quint library, the shared replay closure
    // (which holds the witness classifiers) and the profile's witness sources.
    let mut expected: Vec<String> = [
        "formal/profiles.json".to_string(),
        "formal/coverage-witnesses.json".to_string(),
        "formal/execution.json".to_string(),
        format!("formal/dialcache-{profile}-conformance.qnt"),
        "formal/conformance-observations.qnt".to_string(),
    ]
    .to_vec();
    let execution = read_strict(&root.join("formal/execution.json"))?;
    let definitions = read_strict(&root.join("formal/profiles.json"))?;
    let shared = shared_replay_sources(root)?;
    let claimed: HashSet<String> = execution
        .get("models")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
        .map(|model| {
            model
                .get("path")
                .and_then(serde_json::Value::as_str)
                .map(str::to_owned)
                .ok_or_else(|| "execution model must name its path".to_string())
        })
        .collect::<Result<_, _>>()?;
    let mut additional = quint_libraries(root, &claimed)?;
    additional.extend(shared);
    for definition in definitions
        .get("profiles")
        .and_then(serde_json::Value::as_array)
        .into_iter()
        .flatten()
    {
        if definition.get("id").and_then(serde_json::Value::as_str) == Some(profile) {
            additional.extend(strings_at(definition, "witnessSources")?);
        }
    }
    for path in additional {
        if !expected.contains(&path) {
            expected.push(path);
        }
    }
    if evidence.inputs.len() != expected.len() {
        return Err("incomplete witness definition fingerprints".to_string());
    }
    for (item, path) in evidence.inputs.iter().zip(&expected) {
        if &item.path != path {
            return Err(format!("unexpected witness input {}", item.path));
        }
        if file_sha256(&root.join(path))? != item.sha256 {
            return Err(format!("stale witness definition {path}"));
        }
    }
    let mut actual: HashMap<String, String> = HashMap::new();
    for path in paths {
        let name = base_name(path);
        if actual.contains_key(&name) {
            return Err(format!("duplicate trace name {name}"));
        }
        actual.insert(name, file_sha256(path)?);
    }
    for item in &evidence.corpus {
        match actual.remove(&item.name) {
            Some(hash) if hash == item.sha256 => {}
            _ => return Err(format!("{profile} witness corpus differs at {}", item.name)),
        }
    }
    if !actual.is_empty() {
        return Err("unaccounted replay traces".to_string());
    }
    Ok(())
}

/// Every Quint source in `formal/` and `formal/kernel/` not claimed by a
/// scheduled model, sorted as `formal/execution.mjs` derives library inputs.
pub fn quint_libraries(root: &Path, claimed: &HashSet<String>) -> Result<Vec<String>, String> {
    let mut libraries = Vec::new();
    for folder in ["formal", "formal/kernel"] {
        let directory = root.join(folder);
        let entries = match std::fs::read_dir(&directory) {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("{}: {error}", directory.display())),
        };
        for entry in entries {
            let entry = entry.map_err(|error| format!("{}: {error}", directory.display()))?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if entry
                .file_type()
                .map_err(|error| format!("{}: {error}", entry.path().display()))?
                .is_dir()
                || !name.ends_with(".qnt")
            {
                continue;
            }
            let path = format!("{folder}/{name}");
            if !claimed.contains(&path) {
                libraries.push(path);
            }
        }
    }
    libraries.sort();
    Ok(libraries)
}

fn strings_at(value: &serde_json::Value, key: &str) -> Result<Vec<String>, String> {
    match value.get(key) {
        None | Some(serde_json::Value::Null) => Ok(Vec::new()),
        Some(serde_json::Value::Array(items)) => items
            .iter()
            .map(|item| {
                item.as_str()
                    .map(str::to_owned)
                    .ok_or_else(|| format!("{key} must list strings"))
            })
            .collect(),
        Some(_) => Err(format!("{key} must be an array")),
    }
}

fn base_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Matches `replaySources` of `formal/profiles.json` against the `.mjs`,
/// `.mts` and `.json` files below `formal/replay`, sorted, and returns them.
pub fn shared_replay_sources(root: &Path) -> Result<Vec<String>, String> {
    let registry = read_strict(&root.join("formal/profiles.json"))?;
    let declared = strings_at(&registry, "replaySources")?;
    let mut actual = Vec::new();
    walk(root, &root.join("formal/replay"), &mut actual)?;
    actual.sort();
    if actual.is_empty() || declared != actual {
        return Err("shared replay source inventory differs from formal/replay".to_string());
    }
    Ok(actual)
}

fn walk(root: &Path, directory: &Path, out: &mut Vec<String>) -> Result<(), String> {
    let entries = std::fs::read_dir(directory)
        .map_err(|error| format!("{}: {error}", directory.display()))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("{}: {error}", directory.display()))?;
        let path = entry.path();
        if path.is_dir() {
            walk(root, &path, out)?;
            continue;
        }
        if matches!(
            path.extension().and_then(|extension| extension.to_str()),
            Some("mjs" | "mts" | "json")
        ) {
            let relative = path
                .strip_prefix(root)
                .map_err(|error| format!("{}: {error}", path.display()))?;
            out.push(
                relative
                    .components()
                    .map(|part| part.as_os_str().to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
                    .join("/"),
            );
        }
    }
    Ok(())
}

/// Self-contained SHA-256 (FIPS 180-4), kept private so the harness needs no
/// extra dependency for file fingerprints.
mod sha256 {
    const K: [u32; 64] = [
        0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4,
        0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe,
        0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f,
        0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7,
        0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc,
        0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
        0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070, 0x19a4c116,
        0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7,
        0xc67178f2,
    ];

    pub fn digest(data: &[u8]) -> [u8; 32] {
        let mut state: [u32; 8] = [
            0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab,
            0x5be0cd19,
        ];
        let mut message = data.to_vec();
        message.push(0x80);
        while message.len() % 64 != 56 {
            message.push(0);
        }
        message.extend_from_slice(&((data.len() as u64) * 8).to_be_bytes());
        for block in message.chunks_exact(64) {
            let mut w = [0u32; 64];
            for (i, word) in block.chunks_exact(4).enumerate() {
                w[i] = u32::from_be_bytes([word[0], word[1], word[2], word[3]]);
            }
            for i in 16..64 {
                let s0 = w[i - 15].rotate_right(7) ^ w[i - 15].rotate_right(18) ^ (w[i - 15] >> 3);
                let s1 = w[i - 2].rotate_right(17) ^ w[i - 2].rotate_right(19) ^ (w[i - 2] >> 10);
                w[i] = w[i - 16]
                    .wrapping_add(s0)
                    .wrapping_add(w[i - 7])
                    .wrapping_add(s1);
            }
            let [mut a, mut b, mut c, mut d, mut e, mut f, mut g, mut h] = state;
            for i in 0..64 {
                let s1 = e.rotate_right(6) ^ e.rotate_right(11) ^ e.rotate_right(25);
                let ch = (e & f) ^ (!e & g);
                let t1 = h
                    .wrapping_add(s1)
                    .wrapping_add(ch)
                    .wrapping_add(K[i])
                    .wrapping_add(w[i]);
                let s0 = a.rotate_right(2) ^ a.rotate_right(13) ^ a.rotate_right(22);
                let maj = (a & b) ^ (a & c) ^ (b & c);
                let t2 = s0.wrapping_add(maj);
                h = g;
                g = f;
                f = e;
                e = d.wrapping_add(t1);
                d = c;
                c = b;
                b = a;
                a = t1.wrapping_add(t2);
            }
            for (slot, value) in state.iter_mut().zip([a, b, c, d, e, f, g, h]) {
                *slot = slot.wrapping_add(value);
            }
        }
        let mut out = [0u8; 32];
        for (chunk, word) in out.chunks_exact_mut(4).zip(state) {
            chunk.copy_from_slice(&word.to_be_bytes());
        }
        out
    }
}
