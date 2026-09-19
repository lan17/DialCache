//! The Rust conformance harness: replays the shared corpus through the real
//! cache API against the Node replay coordinator, runs the fixed behavioral
//! scenarios and protocol vectors, and checks the shared witness evidence.
//!
//! Without selectors it replays the committed smoke histories. With the
//! `DIALCACHE_*_TRACE_DIR` selectors it replays the complete generated corpus
//! and writes the JSONL report named by `DIALCACHE_RUST_REPORT`. Node 24 must
//! be on `PATH` for the coordinator.

#![allow(dead_code)]

#[path = "formal/fixtures.rs"]
mod fixtures;
mod formal;
#[path = "formal/frame_vectors.rs"]
mod frame_vectors;
#[path = "formal/key_vectors.rs"]
mod key_vectors;

use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::process::ExitCode;

use formal::core_driver::CoreDriver;
use formal::driver::{install_panic_hook, Driver};
use formal::inventory::{self, repo_root, Selection, TraceSource};
use formal::local_clock::LocalClockDriver;
use formal::report::Report;
use formal::scenarios;
use formal::transport::{Coordinator, Prepared};
use serde_json::{Map, Value};

const FEATURE_PROFILES: [&str; 13] = [
    "admission",
    "independent",
    "layers",
    "local-failure",
    "policy",
    "recovery",
    "recovery-read",
    "runtime-boundaries",
    "scope",
    "shadow",
    "shadow-layers",
    "source-budgets",
    "runtime-boundaries-placeholder",
];

struct Run {
    selection: Selection,
    report: Report,
    coordinator: Coordinator,
    profile_actions: BTreeMap<String, BTreeSet<String>>,
    seen_actions: BTreeMap<String, BTreeSet<String>>,
    failures: usize,
    coverage_failures: Vec<String>,
}

fn main() -> ExitCode {
    install_panic_hook();
    match run() {
        Ok(true) => ExitCode::SUCCESS,
        Ok(false) => ExitCode::FAILURE,
        Err(error) => {
            eprintln!("conformance harness failed: {error}");
            ExitCode::FAILURE
        }
    }
}

fn run() -> Result<bool, String> {
    let selection = Selection::from_env()?;
    let mut report = Report::from_env()?;
    report.start()?;
    inventory::registry_check()?;
    let mut coordinator = Coordinator::spawn()?;
    let mut request = Map::new();
    request.insert("op".to_string(), Value::from("profiles"));
    let info = coordinator.call(request)?;
    let mut profile_actions = BTreeMap::new();
    if let Some(profiles) = info.get("profiles").and_then(Value::as_object) {
        for (name, actions) in profiles {
            let actions: BTreeSet<String> = actions
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect();
            profile_actions.insert(name.clone(), actions);
        }
    }
    let mut run = Run {
        selection,
        report,
        coordinator,
        profile_actions,
        seen_actions: BTreeMap::new(),
        failures: 0,
        coverage_failures: Vec::new(),
    };
    run.core()?;
    run.effects()?;
    run.features()?;
    run.local_clock()?;
    run.scenarios()?;
    run.protocol_vectors()?;
    run.witnesses()?;
    for (profile, expected) in &run.profile_actions {
        let selected_full = match profile.as_str() {
            "core" => run.selection.core.is_directory(),
            "effects" => run.selection.effects.is_directory(),
            _ => {
                run.selection.features.is_directory()
                    && run
                        .selection
                        .feature_profile
                        .as_deref()
                        .is_none_or(|p| p == profile)
            }
        };
        if !selected_full {
            continue;
        }
        let seen = run.seen_actions.get(profile).cloned().unwrap_or_default();
        for action in expected {
            if action != "init" && !seen.contains(action) {
                run.coverage_failures
                    .push(format!("{profile} corpus omits action {action}"));
            }
        }
    }
    let summary = run.report.finish()?;
    let Run {
        coordinator,
        coverage_failures,
        ..
    } = run;
    coordinator.finish()?;
    for failure in &coverage_failures {
        eprintln!("coverage: {failure}");
    }
    Ok(summary.failed == 0 && coverage_failures.is_empty())
}

fn note_actions(seen: &mut BTreeMap<String, BTreeSet<String>>, profile: &str, prepared: &Prepared) {
    let entry = seen.entry(profile.to_string()).or_default();
    for action in &prepared.actions {
        entry.insert(action.clone());
    }
}

impl Run {
    fn replay_core(&mut self, path: &Path) -> Result<(), String> {
        let raw = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
        let prepared = self.coordinator.prepare("core", path, Some(&raw))?;
        note_actions(&mut self.seen_actions, "core", &prepared);
        let mut driver = CoreDriver::new();
        let cell = std::cell::RefCell::new(&mut driver);
        let mut apply = |input: &Value| cell.borrow_mut().apply(input);
        let mut observation = || cell.borrow().observation();
        let mut wall = || cell.borrow().wall_ms();
        self.coordinator
            .execute(&prepared, &mut apply, &mut observation, &mut wall, &mut [])
    }

    fn core(&mut self) -> Result<(), String> {
        let full = self.selection.core.is_directory();
        for path in self.selection.core_paths()? {
            let id = inventory::trace_case_id("core", &path, full);
            let outcome = self.replay_core(&path);
            self.record(&id, outcome)?;
        }
        Ok(())
    }

    fn replay_behavior(
        &mut self,
        profile: &str,
        path: &Path,
        effects_monitor: bool,
    ) -> Result<(), String> {
        let prepared = self.coordinator.prepare(profile, path, None)?;
        note_actions(&mut self.seen_actions, profile, &prepared);
        let mut driver = Driver::new(prepared.fixture.clone());
        let result = {
            let driver_ref = &mut driver;
            let cell = std::cell::RefCell::new(driver_ref);
            let mut apply = |input: &Value| cell.borrow_mut().apply(input);
            let mut observation = || cell.borrow().observation();
            let mut wall = || cell.borrow().wall_ms();
            let mut monitor = || cell.borrow().assert_effects_history();
            let mut monitors: Vec<&mut dyn FnMut() -> Result<(), String>> = Vec::new();
            if effects_monitor {
                monitors.push(&mut monitor);
            }
            self.coordinator.execute(
                &prepared,
                &mut apply,
                &mut observation,
                &mut wall,
                &mut monitors,
            )
        };
        driver.close();
        result
    }

    fn effects(&mut self) -> Result<(), String> {
        inventory::require_behavior_profile("effects")?;
        let full = self.selection.effects.is_directory();
        for path in self.selection.effects_paths()? {
            let id = inventory::trace_case_id("effects", &path, full);
            let outcome = self.replay_behavior("effects", &path, true);
            self.record(&id, outcome)?;
        }
        Ok(())
    }

    fn features(&mut self) -> Result<(), String> {
        let mut names: Vec<String> = self
            .profile_actions
            .keys()
            .filter(|n| !matches!(n.as_str(), "core" | "effects" | "local-clock"))
            .cloned()
            .collect();
        names.sort();
        let full = self.selection.features.is_directory();
        for name in names {
            if let Some(selected) = &self.selection.feature_profile {
                if selected != &name {
                    continue;
                }
            }
            let paths = self.selection.feature_paths(&name)?;
            if !paths.is_empty() {
                inventory::require_behavior_profile(&name)?;
            }
            for path in paths {
                let id = inventory::trace_case_id(&name, &path, full);
                let outcome = self.replay_behavior(&name, &path, false);
                self.record(&id, outcome)?;
            }
        }
        Ok(())
    }

    fn local_clock(&mut self) -> Result<(), String> {
        let paths = self.selection.feature_paths("local-clock")?;
        if paths.is_empty() {
            return Ok(());
        }
        if let Some(selected) = &self.selection.feature_profile {
            if selected != "local-clock" {
                return Ok(());
            }
        }
        inventory::require_behavior_profile("local-clock")?;
        let full = self.selection.features.is_directory();
        for path in paths {
            let id = inventory::trace_case_id("local-clock", &path, full);
            let outcome = (|| {
                let prepared = self.coordinator.prepare("local-clock", &path, None)?;
                note_actions(&mut self.seen_actions, "local-clock", &prepared);
                let mut driver = LocalClockDriver::new();
                let cell = std::cell::RefCell::new(&mut driver);
                let mut apply = |input: &Value| cell.borrow_mut().apply(input);
                let mut observation = || cell.borrow().observation();
                let mut wall = || formal::report::now_ms();
                self.coordinator.execute(
                    &prepared,
                    &mut apply,
                    &mut observation,
                    &mut wall,
                    &mut [],
                )
            })();
            self.record(&id, outcome)?;
        }
        Ok(())
    }

    fn scenarios(&mut self) -> Result<(), String> {
        let scenarios = scenarios::load_scenarios()?;
        let filter = self.selection.behavior_scenario.clone();
        let mut matched = 0;
        for scenario in &scenarios {
            let name = scenario.get("name").and_then(Value::as_str).unwrap_or("");
            let feature = scenario
                .get("feature")
                .and_then(Value::as_str)
                .unwrap_or("");
            if let Some(filter) = &filter {
                if !name.contains(filter.as_str()) {
                    continue;
                }
            }
            matched += 1;
            let id = inventory::scenario_case_id(feature, name);
            let outcome = scenarios::replay_scenario(scenario);
            self.record(&id, outcome)?;
        }
        if matched == 0 {
            return Err("no behavioral scenario matched".to_string());
        }
        Ok(())
    }

    fn protocol_vectors(&mut self) -> Result<(), String> {
        let selection = match self.selection.protocol_corpus {
            inventory::ProtocolCorpus::All => "all",
            inventory::ProtocolCorpus::Generated => "generated",
            inventory::ProtocolCorpus::Fixed => "fixed",
        };
        let groups = fixtures::protocol_groups(selection);
        for (group, vectors) in &groups {
            let check: fn(&Value) -> Result<(), String> = match group.as_str() {
                "keyVectors" => key_vectors::check_key_vector,
                "invalidKeyVectors" => key_vectors::check_invalid_key_vector,
                "normalizeArgsVectors" => key_vectors::check_normalize_args_vector,
                "rampVectors" => key_vectors::check_ramp_vector,
                "frameVectors" => frame_vectors::check_frame_vector,
                "trackedDecodeVectors" => frame_vectors::check_tracked_decode_vector,
                "untrackedDecodeVectors" => frame_vectors::check_untracked_decode_vector,
                "invalidTimestampVectors" => frame_vectors::check_invalid_timestamp_vector,
                "durationVectors" => frame_vectors::check_duration_vector,
                "envelopeVectors" => frame_vectors::check_envelope_vector,
                "compressedDecodeVectors" => frame_vectors::check_compressed_decode_vector,
                "compressionWriteVectors" => frame_vectors::check_compression_write_vector,
                other => return Err(format!("unknown protocol vector group {other}")),
            };
            for vector in vectors {
                let name = vector.get("name").and_then(Value::as_str).unwrap_or("");
                let id = inventory::protocol_case_id(group, name);
                let outcome = check(vector);
                self.record(&id, outcome)?;
            }
        }
        Ok(())
    }

    fn witnesses(&mut self) -> Result<(), String> {
        let mut profiles: BTreeMap<String, Vec<PathBuf>> = BTreeMap::new();
        if self.selection.effects.is_directory() {
            profiles.insert("effects".to_string(), self.selection.effects_paths()?);
        }
        if self.selection.features.is_directory() && self.selection.feature_profile.is_none() {
            for name in self.profile_actions.keys() {
                if matches!(name.as_str(), "core" | "effects") {
                    continue;
                }
                profiles.insert(name.clone(), self.selection.feature_paths(name)?);
            }
        }
        if profiles.is_empty() {
            return Ok(());
        }
        let Some(directory) = self.selection.witness_evidence_dir.clone() else {
            return Err("full generated replay requires DIALCACHE_WITNESS_EVIDENCE_DIR with matching evaluated witness evidence".to_string());
        };
        let root = repo_root();
        for (profile, paths) in profiles {
            let id = inventory::witness_case_id(&profile);
            let outcome =
                formal::witness::check_witness_evidence(&root, &profile, &directory, &paths);
            self.record(&id, outcome)?;
        }
        Ok(())
    }

    fn record(&mut self, id: &str, outcome: Result<(), String>) -> Result<(), String> {
        let started = formal::report::now_ms();
        if let Err(message) = &outcome {
            self.failures += 1;
            eprintln!("FAIL {id}\n{message}");
        }
        self.report
            .case(id, &outcome, started, formal::report::now_ms())?;
        Ok(())
    }
}

#[allow(dead_code)]
fn _profiles() -> &'static [&'static str] {
    &FEATURE_PROFILES
}

#[allow(dead_code)]
fn _trace(source: &TraceSource) -> bool {
    source.is_directory()
}
