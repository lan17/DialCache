//! Corpus discovery and the language-neutral case inventory.
//!
//! Ports the trace selection of the Go harness (`TestCoreConformance`,
//! `effectsPaths`, `featurePaths`, `featureRegressionPaths`), its registry
//! checks (`validateRegistry`, `validateBehaviorProfileRegistry`) and the id
//! scheme of `formal/conformance.mjs` `conformanceInventory`, so the Rust
//! replay reports the same `sampled/…`, `regression/…`, `scenario/…`,
//! `protocol/…` and `witness/…` ids the completion checker requires.

use super::json::strict_parse;
use serde_json::Value;
use std::path::{Path, PathBuf};

/// Absolute repository root (the parent of the `rust/` crate directory).
pub fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .expect("crate lives in <repo>/rust")
        .to_path_buf()
}

/// Resolves a repository-relative path such as `formal/profiles.json`.
pub fn repo_path(relative: &str) -> PathBuf {
    repo_root().join(relative)
}

/// Where one replay corpus comes from.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum TraceSource {
    /// The committed smoke history under `formal/`.
    Smoke,
    /// One explicit history file.
    File(PathBuf),
    /// A generated corpus directory plus its scheduled regressions.
    Directory(PathBuf),
}

impl TraceSource {
    fn from_env(file: &str, directory: &str, conflict: &str) -> Result<TraceSource, String> {
        let file = std::env::var(file).unwrap_or_default();
        let directory = std::env::var(directory).unwrap_or_default();
        match (file.is_empty(), directory.is_empty()) {
            (false, false) => Err(conflict.to_string()),
            (false, true) => Ok(TraceSource::File(PathBuf::from(file))),
            (true, false) => Ok(TraceSource::Directory(PathBuf::from(directory))),
            (true, true) => Ok(TraceSource::Smoke),
        }
    }

    /// Whether this source is a full generated corpus.
    pub fn is_directory(&self) -> bool {
        matches!(self, TraceSource::Directory(_))
    }
}

/// Which protocol vector rows a run replays.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProtocolCorpus {
    /// Fixed and generated rows (the default and `all`).
    All,
    /// Quint-generated rows only.
    Generated,
    /// Checked-in rows only.
    Fixed,
}

/// Which halves of the suite a run executes (`DIALCACHE_RUST_SUITE`).
///
/// The mutation measurement runs the Quint-generated evidence and the fixed
/// supplement as separate cohorts; a normal run executes both.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Suite {
    /// Generated histories, witness evidence and fixed scenarios (the default and `all`).
    All,
    /// Generated histories and witness evidence only: no fixed scenarios.
    Generated,
    /// Fixed scenarios only: no histories and no witness evidence.
    Fixed,
}

impl Suite {
    /// Whether generated histories and witness evidence run.
    pub fn runs_generated(self) -> bool {
        self != Suite::Fixed
    }

    /// Whether the fixed scenarios run.
    pub fn runs_fixed(self) -> bool {
        self != Suite::Generated
    }
}

/// The environment-driven selection of what one conformance run replays.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Selection {
    /// `DIALCACHE_MBT_TRACE_FILE` / `DIALCACHE_MBT_TRACE_DIR`.
    pub core: TraceSource,
    /// `DIALCACHE_EFFECTS_TRACE_FILE` / `DIALCACHE_EFFECTS_TRACE_DIR`.
    pub effects: TraceSource,
    /// `DIALCACHE_FEATURE_TRACE_FILE` / `DIALCACHE_FEATURE_TRACE_DIR`.
    pub features: TraceSource,
    /// `DIALCACHE_FEATURE_PROFILE`: replay one feature profile only.
    pub feature_profile: Option<String>,
    /// `DIALCACHE_WITNESS_EVIDENCE_DIR`: evaluated witness evidence files.
    pub witness_evidence_dir: Option<PathBuf>,
    /// `DIALCACHE_PROTOCOL_CORPUS`.
    pub protocol_corpus: ProtocolCorpus,
    /// `DIALCACHE_RUST_SUITE`.
    pub suite: Suite,
    /// `DIALCACHE_RUST_REPORT`: JSONL assertion report path.
    pub report: Option<PathBuf>,
    /// `DIALCACHE_BEHAVIOR_SCENARIO`: substring filter on scenario names.
    pub behavior_scenario: Option<String>,
}

fn optional(name: &str) -> Option<String> {
    std::env::var(name).ok().filter(|value| !value.is_empty())
}

impl Selection {
    /// Reads the selection from the environment.
    pub fn from_env() -> Result<Selection, String> {
        let protocol_corpus = match optional("DIALCACHE_PROTOCOL_CORPUS").as_deref() {
            None | Some("all") => ProtocolCorpus::All,
            Some("generated") => ProtocolCorpus::Generated,
            Some("fixed") => ProtocolCorpus::Fixed,
            Some(other) => return Err(format!("unknown protocol corpus selection {other}")),
        };
        let suite = match optional("DIALCACHE_RUST_SUITE").as_deref() {
            None | Some("all") => Suite::All,
            Some("generated") => Suite::Generated,
            Some("fixed") => Suite::Fixed,
            Some(other) => return Err(format!("unknown suite selection {other}")),
        };
        Ok(Selection {
            core: TraceSource::from_env(
                "DIALCACHE_MBT_TRACE_FILE",
                "DIALCACHE_MBT_TRACE_DIR",
                "select either a trace file or directory",
            )?,
            effects: TraceSource::from_env(
                "DIALCACHE_EFFECTS_TRACE_FILE",
                "DIALCACHE_EFFECTS_TRACE_DIR",
                "select either an effects trace file or directory",
            )?,
            features: TraceSource::from_env(
                "DIALCACHE_FEATURE_TRACE_FILE",
                "DIALCACHE_FEATURE_TRACE_DIR",
                "select either a feature trace file or directory",
            )?,
            feature_profile: optional("DIALCACHE_FEATURE_PROFILE"),
            witness_evidence_dir: optional("DIALCACHE_WITNESS_EVIDENCE_DIR").map(PathBuf::from),
            protocol_corpus,
            suite,
            report: optional("DIALCACHE_RUST_REPORT").map(PathBuf::from),
            behavior_scenario: optional("DIALCACHE_BEHAVIOR_SCENARIO"),
        })
    }

    /// Core histories: the smoke history, one file, or a directory's `*.itf.json`
    /// plus the scheduled core regressions.
    pub fn core_paths(&self) -> Result<Vec<PathBuf>, String> {
        match &self.core {
            TraceSource::Smoke => Ok(vec![repo_path("formal/conformance-smoke.itf.json")]),
            TraceSource::File(file) => Ok(vec![file.clone()]),
            TraceSource::Directory(directory) => {
                let mut paths = glob_itf(directory)?;
                if paths.is_empty() {
                    return Err("empty trace corpus".to_string());
                }
                paths.extend(regression_paths("core", directory)?);
                Ok(paths)
            }
        }
    }

    /// Effects histories, including scheduled regressions for a directory corpus.
    pub fn effects_paths(&self) -> Result<Vec<PathBuf>, String> {
        let paths = match &self.effects {
            TraceSource::Smoke => vec![repo_path("formal/effects-smoke.itf.json")],
            TraceSource::File(file) => vec![file.clone()],
            TraceSource::Directory(directory) => {
                let mut paths = glob_itf(directory)?;
                paths.extend(regression_paths("effects", directory)?);
                paths
            }
        };
        if paths.is_empty() {
            return Err("empty effects corpus".to_string());
        }
        Ok(paths)
    }

    /// Histories of one feature profile (including `local-clock`). An explicit
    /// file is used only when it belongs to the profile; a directory corpus
    /// reads `<dir>/<profile>/*.itf.json` plus the scheduled regressions.
    pub fn feature_paths(&self, profile: &str) -> Result<Vec<PathBuf>, String> {
        match &self.features {
            TraceSource::File(file) => {
                let parent = file
                    .parent()
                    .and_then(Path::file_name)
                    .map(|name| name.to_string_lossy().into_owned());
                let name = file_name(file);
                if parent.as_deref() == Some(profile) || name.contains(&format!("{profile}-smoke"))
                {
                    Ok(vec![file.clone()])
                } else {
                    Ok(Vec::new())
                }
            }
            TraceSource::Directory(directory) => {
                let mut paths = glob_itf(&directory.join(profile))?;
                if paths.is_empty() {
                    return Err(format!("empty feature corpus {profile}"));
                }
                paths.extend(regression_paths(profile, directory)?);
                Ok(paths)
            }
            TraceSource::Smoke => Ok(vec![repo_path(&format!("formal/{profile}-smoke.itf.json"))]),
        }
    }
}

fn file_name(path: &Path) -> String {
    path.file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// Sorted `*.itf.json` files directly inside `directory`.
pub fn glob_itf(directory: &Path) -> Result<Vec<PathBuf>, String> {
    let entries = match std::fs::read_dir(directory) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("{}: {error}", directory.display())),
    };
    let mut names = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| format!("{}: {error}", directory.display()))?;
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.ends_with(".itf.json") {
            names.push(name);
        }
    }
    names.sort();
    Ok(names.into_iter().map(|name| directory.join(name)).collect())
}

/// Lexically resolves `<directory>/..` the way Go's `filepath.Join` does.
fn parent_of(directory: &Path) -> PathBuf {
    let mut parent = directory.to_path_buf();
    match directory.components().next_back() {
        Some(std::path::Component::Normal(_)) => {
            parent.pop();
        }
        _ => parent.push(".."),
    }
    parent
}

/// Exported Quint regressions of `profile`, read from
/// `<directory>/../regressions/<profile>/`. The shared inventory derives which
/// runs export from the Quint source and the full-report gate requires exactly
/// those histories; the native driver only discovers their generated files.
pub fn regression_paths(profile: &str, directory: &Path) -> Result<Vec<PathBuf>, String> {
    let regressions = parent_of(directory).join("regressions").join(profile);
    let paths = glob_itf(&regressions)?;
    if paths.is_empty() {
        return Err(format!("missing Quint regressions for {profile}"));
    }
    Ok(paths)
}

fn read_json(relative: &str) -> Result<Value, String> {
    let path = repo_path(relative);
    let text =
        std::fs::read_to_string(&path).map_err(|error| format!("{}: {error}", path.display()))?;
    strict_parse(&text).map_err(|error| format!("{relative}: {error}"))
}

/// A history's kind follows the corpus layout the shared evaluator classifies
/// by: exported regressions live under `regressions/<profile>/`, every other
/// replayed history is a sampled one.
pub fn trace_kind(path: &Path) -> &'static str {
    let grandparent = path
        .parent()
        .and_then(Path::parent)
        .and_then(Path::file_name);
    if grandparent.is_some_and(|name| name == "regressions") {
        "regression"
    } else {
        "sampled"
    }
}

/// Inventory id of one replayed history: `regression/<profile>/<name>` for an
/// exported regression, `sampled/<profile>/<i>` for `trace_<i>.itf.json` of a
/// full generated corpus, otherwise `smoke/<profile>/<file name>`.
pub fn trace_case_id(profile: &str, path: &Path, full: bool) -> String {
    let name = file_name(path);
    let stem = name.strip_suffix(".itf.json").unwrap_or(&name);
    if trace_kind(path) == "regression" {
        return format!("regression/{profile}/{stem}");
    }
    if full {
        if let Some(index) = stem.strip_prefix("trace_") {
            if !index.is_empty()
                && index.bytes().all(|byte| byte.is_ascii_digit())
                && (index == "0" || !index.starts_with('0'))
            {
                return format!("sampled/{profile}/{index}");
            }
        }
    }
    format!("smoke/{profile}/{name}")
}

/// `scenario/<feature>/<name>` with percent-encoded components.
pub fn scenario_case_id(feature: &str, name: &str) -> String {
    format!(
        "scenario/{}/{}",
        percent_encode_component(feature),
        percent_encode_component(name)
    )
}

/// `protocol/<group>/<name>` with a percent-encoded vector name.
pub fn protocol_case_id(group: &str, name: &str) -> String {
    format!("protocol/{group}/{}", percent_encode_component(name))
}

/// `witness/<profile>`.
pub fn witness_case_id(profile: &str) -> String {
    format!("witness/{profile}")
}

/// Exactly JavaScript's `encodeURIComponent`: every byte of the UTF-8 encoding
/// outside `A-Z a-z 0-9 - _ . ! ~ * ' ( )` becomes `%XX` with uppercase hex.
pub fn percent_encode_component(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    for byte in text.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            out.push(byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

/// Behavior profile versions this port implements, from
/// `go/internal/dialcache/behavior_registry_test.go`.
pub const BEHAVIOR_PROFILE_VERSIONS: [(&str, i64); 16] = [
    ("recovery-read", 1),
    ("local-failure", 1),
    ("runtime-boundaries", 1),
    ("shadow-layers", 1),
    ("local-clock", 1),
    ("source-budgets", 1),
    ("effects", 3),
    ("scope", 2),
    ("policy", 3),
    ("layers", 2),
    ("recovery", 1),
    ("independent", 2),
    ("shadow", 3),
    ("admission", 1),
    ("dark-layers", 2),
    ("shadow-read-deadlines", 1),
];

/// The version this port implements of a behavior profile, if it knows it.
pub fn behavior_profile_version(profile: &str) -> Option<i64> {
    BEHAVIOR_PROFILE_VERSIONS
        .iter()
        .find(|(name, _)| *name == profile)
        .map(|(_, version)| *version)
}

/// Ports `validateRegistry`: `formal/profiles.json` must declare schema 1,
/// specification 0.1.0, protocol schema 3 and exactly one core profile at version 1.
pub fn registry_check() -> Result<(), String> {
    registry_check_text(&read_registry_text()?)
}

fn read_registry_text() -> Result<String, String> {
    let path = repo_path("formal/profiles.json");
    std::fs::read_to_string(&path).map_err(|error| format!("{}: {error}", path.display()))
}

/// [`registry_check`] over explicit registry text.
pub fn registry_check_text(raw: &str) -> Result<(), String> {
    let registry = strict_parse(raw)?;
    if registry.get("schemaVersion").and_then(Value::as_f64) != Some(1.0)
        || registry.get("specificationVersion").and_then(Value::as_str) != Some("0.1.0")
        || registry
            .get("protocolSchemaVersion")
            .and_then(Value::as_f64)
            != Some(3.0)
    {
        return Err("unsupported specification/profile/protocol registry version".to_string());
    }
    let mut core = 0;
    for profile in registry
        .get("profiles")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if profile.get("id").and_then(Value::as_str) == Some("core") {
            core += 1;
            if profile.get("version").and_then(Value::as_f64) != Some(1.0) {
                return Err("unsupported core profile version".to_string());
            }
        }
    }
    if core != 1 {
        return Err("registry requires exactly one core profile".to_string());
    }
    Ok(())
}

/// Ports `validateBehaviorProfileRegistry` against `formal/profiles.json`.
pub fn profile_registry_check(profile: &str, version: i64) -> Result<(), String> {
    profile_registry_check_text(&read_registry_text()?, profile, version)
}

/// [`profile_registry_check`] over explicit registry text.
pub fn profile_registry_check_text(raw: &str, name: &str, version: i64) -> Result<(), String> {
    let registry = strict_parse(raw)?;
    if registry.get("schemaVersion").and_then(Value::as_f64) != Some(1.0)
        || registry.get("specificationVersion").and_then(Value::as_str) != Some("0.1.0")
        || registry
            .get("behavioralSchemaVersion")
            .and_then(Value::as_f64)
            != Some(2.0)
        || registry
            .get("protocolSchemaVersion")
            .and_then(Value::as_f64)
            != Some(3.0)
    {
        return Err("unsupported specification/behavioral registry".to_string());
    }
    let mut count = 0;
    for profile in registry
        .get("profiles")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        if profile.get("id").and_then(Value::as_str) != Some(name) {
            continue;
        }
        count += 1;
        if profile.get("version").and_then(Value::as_f64) != Some(version as f64)
            || profile.get("model").and_then(Value::as_str)
                != Some(format!("formal/dialcache-{name}-conformance.qnt").as_str())
            || profile.get("smoke").and_then(Value::as_str)
                != Some(format!("formal/{name}-smoke.itf.json").as_str())
        {
            return Err(format!("unsupported {name} profile definition/version"));
        }
    }
    if count != 1 {
        return Err(format!("registry needs exactly one {name} profile"));
    }
    Ok(())
}

/// Checks the registry entry of a behavior profile at the version this port implements.
pub fn require_behavior_profile(profile: &str) -> Result<(), String> {
    let version = behavior_profile_version(profile)
        .ok_or_else(|| format!("unknown behavior profile {profile}"))?;
    profile_registry_check(profile, version)
}
