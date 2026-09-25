//! Controls for the replay infrastructure itself: the coordinator transport,
//! strict JSON, schema validation, inventory ids and the witness-evidence check.
//! These port the harness tests of `go/replay_coordinator_test.go`,
//! `go/behavior_replay_test.go` and `go/witness_evidence_test.go`.
//!
//! The transport tests spawn `node`; `node` on `PATH` must be Node 24 (see
//! `formal::transport`). Prepend `/opt/homebrew/opt/node@24/bin` to `PATH`
//! when the default toolchain is another major version.

#[path = "formal/digest.rs"]
mod digest;

mod formal;

use formal::inventory::{
    percent_encode_component, profile_registry_check_text, protocol_case_id, registry_check,
    regression_paths, repo_root, require_behavior_profile, scenario_case_id, trace_case_id,
    trace_kind, witness_case_id, BEHAVIOR_PROFILE_VERSIONS,
};
use formal::json::{decode_itf, json_equal, sorted_keys, strict_parse};
use formal::report::Report;
use formal::schema::{observation_error, Schema};
use formal::transport::{read_frame, Coordinator, Prepared, SETTLEMENT};
use formal::witness::{
    check_witness_evidence, file_sha256, sha256_hex, Digest, Evidence, Label, Trace,
};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

fn node(program: &str) -> Command {
    let mut command = Command::new("node");
    command.arg("-e").arg(program);
    command
}

fn request(op: &str) -> Map<String, Value> {
    let mut request = Map::new();
    request.insert("op".to_string(), Value::from(op));
    request
}

/// The flat all-zero record `$defs/coreObservation` accepts.
fn healthy_core_observation() -> Value {
    let mut observed = Map::new();
    for field in "sourceVersion lastResult outsideLoaderCalls requestLoaderCalls localLoaderCalls coalescedLoaderCalls remoteLoaderCalls redisReads redisWrites".split(' ') {
        observed.insert(field.to_string(), Value::from(0));
    }
    Value::Object(observed)
}

/// The empty behavior record; `events` is present exactly when the fixture observes.
fn empty_behavior_observation(observe: bool) -> Value {
    let mut observed = Map::new();
    for field in [
        "loaders",
        "reads",
        "writes",
        "invalidations",
        "loads",
        "dumps",
        "policyCalls",
        "classifications",
        "comparisons",
    ] {
        observed.insert(field.to_string(), Value::from(0));
    }
    for field in [
        "calls",
        "maintenance",
        "sourceScopes",
        "writeTtls",
        "shadow",
        "recovery",
    ] {
        observed.insert(field.to_string(), Value::Array(Vec::new()));
    }
    if observe {
        observed.insert("events".to_string(), Value::Array(Vec::new()));
    }
    Value::Object(observed)
}

fn with(base: &Value, field: &str, value: Value) -> Value {
    let mut changed = base.as_object().cloned().unwrap_or_default();
    changed.insert(field.to_string(), value);
    Value::Object(changed)
}

fn without(base: &Value, field: &str) -> Value {
    let mut changed = base.as_object().cloned().unwrap_or_default();
    changed.remove(field);
    Value::Object(changed)
}

#[test]
fn publication_causality_distinguishes_overlapping_source_owners_and_deadlines() {
    use formal::causal::{assert_publication_causality, CausalEvent::*};
    let overlap = vec![
        SourceStart {
            id: 0,
            owner: 10,
            at_ms: 0,
            budget_ms: Some(10),
        },
        SourceStart {
            id: 1,
            owner: 20,
            at_ms: 10,
            budget_ms: Some(10),
        },
        SourceSettlement {
            id: 0,
            at_ms: 15,
            outcome: "resolve",
        },
        SourceSettlement {
            id: 1,
            at_ms: 16,
            outcome: "resolve",
        },
    ];
    for (source, owner, expected) in [
        (0, 10, "late raw settlement"),
        (1, 10, "different invocation"),
    ] {
        let mut history = overlap.clone();
        history.push(WriteDispatch {
            source: Some(source),
            owner: Some(owner),
            at_ms: 17,
        });
        let error = assert_publication_causality(&history).unwrap_err();
        assert!(error.starts_with("CAUSAL_PROPERTY_FAILURE"), "{error}");
        assert!(error.contains(expected), "{error}");
    }
    let mut accepted = overlap.clone();
    accepted.push(WriteDispatch {
        source: Some(1),
        owner: Some(20),
        at_ms: 30,
    });
    assert_publication_causality(&accepted)
        .expect("publication can outlive an accepted source's deadline");
    assert_publication_causality(&overlap[..2]).expect("pending prefixes are allowed");
    assert_publication_causality(&[
        SourceStart {
            id: 0,
            owner: 0,
            at_ms: 0,
            budget_ms: None,
        },
        SourceSettlement {
            id: 0,
            at_ms: 100_000,
            outcome: "resolve",
        },
        WriteDispatch {
            source: Some(0),
            owner: Some(0),
            at_ms: 100_000,
        },
    ])
    .expect("unbounded sources stay unbounded");
    for outcome in [None, Some("reject")] {
        let mut history = vec![SourceStart {
            id: 0,
            owner: 0,
            at_ms: 0,
            budget_ms: Some(10),
        }];
        if let Some(outcome) = outcome {
            history.push(SourceSettlement {
                id: 0,
                at_ms: 1,
                outcome,
            });
        }
        history.push(WriteDispatch {
            source: Some(0),
            owner: Some(0),
            at_ms: 1,
        });
        assert!(assert_publication_causality(&history)
            .unwrap_err()
            .contains("exact source's successful settlement"));
    }
}

#[test]
fn malformed_monitor_inputs_never_become_mutation_evidence() {
    use formal::causal::{assert_publication_causality, CausalEvent::*};
    use formal::driver::{Driver, HistoryEvent};
    for history in [
        vec![SourceStart {
            id: 0,
            owner: 0,
            at_ms: 0,
            budget_ms: Some(0),
        }],
        vec![SourceSettlement {
            id: 0,
            at_ms: 0,
            outcome: "resolve",
        }],
        vec![WriteDispatch {
            source: None,
            owner: None,
            at_ms: 0,
        }],
        vec![SourceStart {
            id: 0,
            owner: 0,
            at_ms: -1,
            budget_ms: None,
        }],
        vec![
            SourceStart {
                id: 0,
                owner: 0,
                at_ms: 0,
                budget_ms: None,
            },
            SourceSettlement {
                id: 0,
                at_ms: 1,
                outcome: "unknown",
            },
        ],
    ] {
        let error = assert_publication_causality(&history).unwrap_err();
        assert!(!error.contains("CAUSAL_PROPERTY_FAILURE"), "{error}");
    }
    let start = HistoryEvent {
        event: "sourceStart",
        id: 0,
        at: 0,
        outcome: "",
        duration_ms: 0.0,
        failed: false,
    };
    let settled = HistoryEvent {
        event: "sourceSettlement",
        at: 10,
        outcome: "resolve",
        ..start.clone()
    };
    let completed = HistoryEvent {
        event: "fallbackCompletion",
        at: 10,
        duration_ms: 10.0,
        ..start.clone()
    };
    for history in [
        vec![completed.clone()],
        vec![settled.clone()],
        vec![
            start.clone(),
            HistoryEvent {
                outcome: "unknown",
                ..settled.clone()
            },
        ],
    ] {
        let error = Driver::assert_effects_events(&history).unwrap_err();
        assert!(!error.contains("CAUSAL_PROPERTY_FAILURE"), "{error}");
    }
    let error = Driver::assert_effects_events(&[start, settled, completed]).unwrap_err();
    assert!(
        error.starts_with("CAUSAL_PROPERTY_FAILURE rule=C25 event="),
        "{error}"
    );
}

#[test]
fn invocation_context_follows_spawn_and_defer_without_leaking_between_polls() {
    use dialcache::{testing::TestExecutor, Runtime};
    use formal::causal::{current_invocation, InvocationFuture, InvocationRuntime};
    use formal::gate::Gate;
    use parking_lot::Mutex;
    use std::sync::Arc;
    let mut exec = TestExecutor::new(0);
    let runtime = Arc::new(InvocationRuntime(exec.runtime.clone()));
    let seen = Arc::new(Mutex::new(Vec::new()));
    let gate = Gate::<()>::new();
    for owner in [10, 20] {
        let runtime = runtime.clone();
        let seen = seen.clone();
        let gate = gate.clone();
        exec.spawn(InvocationFuture::new(Some(owner), async move {
            seen.lock().push(current_invocation());
            let deferred_seen = seen.clone();
            runtime.defer(Box::pin(async move {
                deferred_seen.lock().push(current_invocation());
            }));
            runtime.spawn(Box::pin(async move {
                gate.wait().await;
                seen.lock().push(current_invocation());
            }));
        }));
    }
    exec.drain();
    assert_eq!(current_invocation(), None);
    gate.settle(());
    exec.drain();
    assert_eq!(current_invocation(), None);
    let mut seen = seen.lock().clone();
    seen.sort();
    assert_eq!(
        seen,
        [Some(10), Some(10), Some(10), Some(20), Some(20), Some(20)]
    );
    let panicking = InvocationFuture::new(Some(30), async { panic!("controlled context unwind") });
    assert!(std::panic::catch_unwind(std::panic::AssertUnwindSafe(
        || futures::executor::block_on(panicking)
    ))
    .is_err());
    assert_eq!(current_invocation(), None);
}

#[test]
fn behavior_driver_attributes_detached_writes_to_their_actual_sources() {
    use formal::causal::CausalEvent;
    use formal::driver::Driver;
    let mut driver = Driver::new(json!({"policy":{"ttlSec":{"remote":10},"coalesce":false}}));
    for input in [
        json!({"op":"begin", "key":"same"}),
        json!({"op":"begin", "key":"same"}),
        json!({"op":"resolve", "loader":1, "value":2}),
        json!({"op":"resolve", "loader":0, "value":1}),
    ] {
        driver.apply(&input).unwrap();
    }
    let writes: Vec<_> = driver
        .causal_history()
        .into_iter()
        .filter_map(|event| match event {
            CausalEvent::WriteDispatch { source, owner, .. } => Some((source, owner)),
            _ => None,
        })
        .collect();
    assert_eq!(writes, [(Some(1), Some(1)), (Some(0), Some(0))]);
    driver.close();
}

fn prepared_control() -> Prepared {
    Prepared {
        session: "1".to_string(),
        steps: 2,
        observation: "coreObservation".to_string(),
        receipt: None,
        fixture: Value::Object(Map::new()),
        setup: Vec::new(),
        actions: vec!["init".to_string(), "outsideCall".to_string()],
    }
}

struct TempDir(PathBuf);

impl TempDir {
    fn new(name: &str) -> TempDir {
        let path = std::env::temp_dir().join(format!(
            "dialcache-rust-harness-{}-{name}",
            std::process::id()
        ));
        let _ = std::fs::remove_dir_all(&path);
        std::fs::create_dir_all(&path).expect("temp dir");
        TempDir(path)
    }

    fn write(&self, relative: &str, content: &str) {
        let path = self.0.join(relative);
        std::fs::create_dir_all(path.parent().expect("parent")).expect("mkdir");
        std::fs::write(&path, content).expect("write");
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

#[test]
fn coordinator_answers_repeated_profile_requests() {
    let mut coordinator = Coordinator::spawn().expect("shared replay requires Node 24 on PATH");
    let mut profiles = Map::new();
    for _ in 0..20 {
        let result = coordinator.call(request("profiles")).expect("profiles");
        assert_eq!(
            result.get("settlement").and_then(Value::as_str),
            Some(SETTLEMENT)
        );
        profiles = result
            .get("profiles")
            .and_then(Value::as_object)
            .cloned()
            .expect("profiles object");
    }
    assert_eq!(profiles.len(), 17, "profiles: {}", sorted_keys(&profiles));
    for name in [
        "core",
        "effects",
        "local-clock",
        "scope",
        "policy",
        "shadow",
        "recovery",
    ] {
        assert!(profiles.contains_key(name), "missing profile {name}");
    }
    for (name, actions) in &profiles {
        let actions = actions
            .as_array()
            .unwrap_or_else(|| panic!("{name} actions must be a list"));
        assert!(!actions.is_empty(), "{name} lists no actions");
        assert!(
            actions
                .iter()
                .all(|action| action.as_str().is_some_and(|action| !action.is_empty())),
            "{name} has a malformed action"
        );
    }
    coordinator.finish().expect("coordinator exits cleanly");
}

#[test]
fn coordinator_rejects_broken_responses() {
    let cases = [
        ("malformed JSON", "not-json"),
        (
            "unknown version",
            r#"{"version":2,"id":1,"ok":true,"result":{}}"#,
        ),
        (
            "wrong sequence",
            r#"{"version":1,"id":2,"ok":true,"result":{}}"#,
        ),
        (
            "unknown member",
            r#"{"version":1,"id":1,"ok":true,"result":{},"extra":true}"#,
        ),
        (
            "duplicate member",
            r#"{"version":1,"id":1,"ok":true,"result":{},"result":{}}"#,
        ),
        (
            "missing status",
            r#"{"version":1,"id":1,"error":"missing status"}"#,
        ),
        (
            "mixed success",
            r#"{"version":1,"id":1,"ok":true,"result":{},"error":"hidden"}"#,
        ),
    ];
    for (name, response) in cases {
        let encoded = serde_json::to_string(&format!("{response}\n")).expect("encode");
        let program = format!("process.stdin.once('data', () => {{ process.stdout.write({encoded}); process.stdin.resume(); }});");
        let mut coordinator =
            Coordinator::start(node(&program), Duration::from_secs(1), false).expect("start");
        assert!(
            coordinator.call(request("profiles")).is_err(),
            "{name}: accepted malformed coordinator response"
        );
        coordinator
            .finish()
            .unwrap_or_else(|error| panic!("{name}: {error}"));
    }
}

#[test]
fn coordinator_times_out_and_closes_broken_process() {
    // Both a blocked RPC and a child ignoring EOF must be bounded by real time.
    let started = Instant::now();
    let mut coordinator = Coordinator::start(
        node("process.stdin.resume(); setInterval(() => {}, 1000);"),
        Duration::from_millis(100),
        true,
    )
    .expect("start");
    let error = coordinator
        .call(request("profiles"))
        .expect_err("accepted a process that never acknowledged the request");
    assert!(
        error.contains("coordinator unavailable or exceeded real-time request limit"),
        "{error}"
    );
    coordinator
        .finish()
        .expect("expected failure is not reported");
    assert!(
        started.elapsed() < Duration::from_secs(10),
        "watchdog did not bound the broken process"
    );
}

#[test]
fn coordinator_rejects_premature_completion_and_empty_commands() {
    let cases = [
        ("premature completion", r#"{"complete":true,"steps":2}"#),
        (
            "empty commands",
            r#"{"complete":false,"index":1,"inputs":[]}"#,
        ),
        (
            "fractional index",
            r#"{"complete":false,"index":1.5,"inputs":[{"op":"begin"}]}"#,
        ),
        (
            "non-command input",
            r#"{"complete":false,"index":1,"inputs":[null]}"#,
        ),
        (
            "missing argument",
            r#"{"complete":false,"index":1,"inputs":[{"op":"resolve"}]}"#,
        ),
        (
            "wrong argument type",
            r#"{"complete":false,"index":1,"inputs":[{"op":"resolve","loader":"0"}]}"#,
        ),
        (
            "unexpected argument",
            r#"{"complete":false,"index":1,"inputs":[{"op":"begin","expected":0}]}"#,
        ),
        (
            "unknown operation",
            r#"{"complete":false,"index":1,"inputs":[{"op":"invented"}]}"#,
        ),
    ];
    for (name, result) in cases {
        let program = format!(
            "require('readline').createInterface({{input:process.stdin}}).on('line', line => {{ const request=JSON.parse(line); process.stdout.write(JSON.stringify({{version:1,id:request.id,ok:true,result:{result}}})+'\\n'); }});"
        );
        let mut coordinator =
            Coordinator::start(node(&program), Duration::from_secs(1), false).expect("start");
        let mut applied = 0;
        // A well-formed core observation passes the local shape check, so the
        // coordinator's malformed reply is what execution must reject.
        let error = coordinator.execute(
            &prepared_control(),
            &mut |_input| {
                applied += 1;
                Ok(())
            },
            &mut healthy_core_observation,
            &mut || 0,
            None,
            &mut [],
        );
        assert!(
            error.is_err() && applied == 0,
            "{name}: malformed reply advanced execution: {error:?}, commands={applied}"
        );
        coordinator
            .finish()
            .unwrap_or_else(|error| panic!("{name}: {error}"));
    }
}

#[test]
fn transport_validates_observations_locally() {
    let schema = Schema::load().expect("schema");
    let defs = schema.defs();
    let behavior = empty_behavior_observation(true);
    let local = empty_behavior_observation(false);
    for (definition, observed) in [
        ("behaviorObservation", &behavior),
        ("coreObservation", &healthy_core_observation()),
        ("localClockObservation", &local),
    ] {
        observation_error(observed, definition, defs)
            .unwrap_or_else(|error| panic!("well-formed {definition} rejected: {error}"));
    }
    let core = healthy_core_observation();
    let controls: Vec<(&str, &str, Value)> = vec![
        (
            "string counter",
            "behaviorObservation",
            with(&behavior, "loaders", json!("1")),
        ),
        (
            "pending call value",
            "behaviorObservation",
            with(&behavior, "calls", json!([{"status": "value"}])),
        ),
        (
            "invented event",
            "behaviorObservation",
            with(&behavior, "events", json!([{"event": "invented"}])),
        ),
        (
            "unknown field",
            "behaviorObservation",
            with(&behavior, "extra", json!(1)),
        ),
        (
            "missing list",
            "behaviorObservation",
            without(&behavior, "maintenance"),
        ),
        (
            "negative counter",
            "coreObservation",
            with(&core, "redisReads", json!(-1)),
        ),
        (
            "missing counter",
            "coreObservation",
            without(&core, "redisWrites"),
        ),
        (
            "fractional counter",
            "coreObservation",
            with(&core, "redisReads", json!(0.5)),
        ),
        (
            "structured local call",
            "localClockObservation",
            with(&local, "calls", json!([{"status": "pending"}])),
        ),
        (
            "events on local clock",
            "localClockObservation",
            with(&local, "events", json!([])),
        ),
        ("non-object observation", "behaviorObservation", json!([])),
        ("nil observation", "coreObservation", Value::Null),
    ];
    for (name, definition, observed) in &controls {
        let error = observation_error(observed, definition, defs)
            .err()
            .unwrap_or_else(|| panic!("{name}: malformed {definition} accepted: {observed}"));
        assert!(
            error.starts_with(&format!(
                "driver produced a malformed {definition} observation: "
            )),
            "{name}: shape defect lacks the driver attribution: {error}"
        );
        assert!(
            !carries_comparison_markers(&error),
            "{name}: shape defect acquired comparison markers: {error}"
        );
        assert!(
            !error.contains("\"1\"") && !error.contains("invented"),
            "{name}: diagnostic leaked a value: {error}"
        );
    }
    for definition in ["", "invented", "observedEvent", "command"] {
        let error = observation_error(&behavior, definition, defs)
            .err()
            .unwrap_or_else(|| panic!("definition {definition:?} accepted"));
        assert!(
            error.contains("unknown replay observation definition"),
            "{definition:?}: {error}"
        );
    }

    // Rejected before any request reaches the coordinator: the stand-in exits
    // nonzero if an observe request ever arrives, which finish() reports.
    let program = "require('readline').createInterface({input:process.stdin}).on('line', line => { const request=JSON.parse(line); if (request.op === 'observe') process.exit(3); process.stdout.write(JSON.stringify({version:1,id:request.id,ok:true,result:{complete:true,steps:2}})+'\\n'); });";
    let mut coordinator =
        Coordinator::start(node(program), Duration::from_secs(1), false).expect("start");
    let mut applied = 0;
    let mut prepared = prepared_control();
    prepared.setup = vec![json!({"op": "bumpSource"})];
    let error = coordinator
        .execute(
            &prepared,
            &mut |_input| {
                applied += 1;
                Ok(())
            },
            &mut || with(&healthy_core_observation(), "redisReads", json!("many")),
            &mut || 0,
            None,
            &mut [],
        )
        .expect_err("malformed observation accepted");
    assert!(
        error.contains("driver produced a malformed coreObservation observation"),
        "not attributed to the driver: {error}"
    );
    assert_eq!(applied, 1, "setup must run before the first observation");
    coordinator
        .finish()
        .expect("an observe request reached the coordinator");

    // prepare rejects an unknown observation definition.
    let program = "require('readline').createInterface({input:process.stdin}).on('line', line => { const request=JSON.parse(line); process.stdout.write(JSON.stringify({version:1,id:request.id,ok:true,result:{session:'1',settlement:'causally-ready-v1',observation:'observedEvent',receipt:null,fixture:{},setup:[],actions:['init','outsideCall'],steps:2}})+'\\n'); });";
    let mut coordinator =
        Coordinator::start(node(program), Duration::from_secs(1), false).expect("start");
    let error = coordinator
        .prepare("core", Path::new("control.itf.json"), None)
        .expect_err("unknown observation definition accepted");
    assert!(
        error.contains("malformed replay observation definition"),
        "{error}"
    );
    coordinator.finish().expect("clean exit");
}

fn carries_comparison_markers(text: &str) -> bool {
    text.find("expected:")
        .is_some_and(|at| text[at..].contains("actual:"))
}

#[test]
fn transport_validates_settlement_receipts_before_sending() {
    let receipt = json!({"elapsedMs": 0, "runnable": 0, "held": {
        "loaders": 0, "reads": 0, "writes": 0, "dumps": 0,
        "loads": 0, "policies": 0, "scopes": 0
    }});
    let schema = Schema::load().expect("schema");
    assert!(schema.matches_definition(&receipt, "settlementReceipt"));
    let mut bad_held = receipt.clone();
    bad_held["held"]["reads"] = json!(-1);
    let malformed = [
        without(&receipt, "held"),
        with(&receipt, "runnable", json!(0.5)),
        with(&receipt, "elapsedMs", json!("0")),
        with(&receipt, "extra", json!(0)),
        bad_held,
    ];
    // The process rejects any observe request; a malformed receipt must be
    // attributed to the driver before it spends a coordinator round trip.
    let program = "require('readline').createInterface({input:process.stdin}).on('line', line => { const r=JSON.parse(line); if (r.op === 'observe') process.exit(3); process.stdout.write(JSON.stringify({version:1,id:r.id,ok:true,result:{discarded:true}})+'\\n'); });";
    let mut coordinator =
        Coordinator::start(node(program), Duration::from_secs(1), false).expect("start");
    let mut prepared = prepared_control();
    prepared.observation = "behaviorObservation".to_string();
    prepared.receipt = Some("settlementReceipt".to_string());
    for malformed in malformed {
        let error = coordinator
            .execute(
                &prepared,
                &mut |_| Ok(()),
                &mut || empty_behavior_observation(true),
                &mut || 0,
                Some(&mut || malformed.clone()),
                &mut [],
            )
            .expect_err("malformed receipt accepted");
        assert!(
            error.contains("malformed settlementReceipt receipt"),
            "{error}"
        );
        assert!(!carries_comparison_markers(&error), "{error}");
    }
    let missing = coordinator
        .execute(
            &prepared,
            &mut |_| Ok(()),
            &mut || empty_behavior_observation(true),
            &mut || 0,
            None,
            &mut [],
        )
        .expect_err("missing receipt callback accepted");
    assert!(
        missing.contains("omitted its settlement receipt"),
        "{missing}"
    );
    coordinator
        .finish()
        .expect("an observe request reached the coordinator");

    // prepare must reject invalid receipt definitions and prevent a core
    // session from attaching a behavior driver's receipt.
    for (observation, value) in [
        ("behaviorObservation", Value::Null),
        ("behaviorObservation", json!("coreObservation")),
        ("coreObservation", json!("settlementReceipt")),
    ] {
        let result = json!({"session":"1", "settlement":SETTLEMENT,
            "observation":observation, "receipt":value, "fixture":{},
            "setup":[], "actions":["init","outsideCall"], "steps":2});
        let program = format!("require('readline').createInterface({{input:process.stdin}}).on('line', line => {{ const r=JSON.parse(line); process.stdout.write(JSON.stringify({{version:1,id:r.id,ok:true,result:{result}}})+'\\n'); }});");
        let mut coordinator =
            Coordinator::start(node(&program), Duration::from_secs(1), false).expect("start");
        let error = coordinator
            .prepare("core", Path::new("control.itf.json"), None)
            .expect_err("invalid receipt definition accepted");
        assert!(
            error.contains("malformed replay receipt definition"),
            "{error}"
        );
        coordinator.finish().expect("clean exit");
    }
}

#[test]
fn coordinator_prepares_and_replays_the_smoke_history_shape() {
    // The real coordinator's prepare result must satisfy every structural check.
    let mut coordinator = Coordinator::spawn().expect("shared replay requires Node 24 on PATH");
    let path = repo_root().join("formal/conformance-smoke.itf.json");
    let raw = std::fs::read_to_string(&path).expect("smoke history");
    let prepared = coordinator
        .prepare("core", &path, Some(&raw))
        .expect("prepare");
    assert_eq!(prepared.observation, "coreObservation");
    assert_eq!(prepared.actions.len() as i64, prepared.steps);
    assert_eq!(prepared.actions[0], "init");
    assert!(prepared.fixture.is_object());
    // Discarding is the early-exit path execute() takes; a stale session is an error.
    let mut discard = request("discard");
    discard.insert("session".to_string(), Value::from(prepared.session.clone()));
    coordinator.call(discard.clone()).expect("discard");
    let error = coordinator
        .call(discard)
        .expect_err("second discard accepted");
    assert!(error.starts_with("shared replay: "), "{error}");
    let error = coordinator
        .prepare("core", Path::new("missing-history"), Some("{"))
        .expect_err("malformed history accepted");
    assert!(error.starts_with("shared replay: "), "{error}");
    coordinator.finish().expect("clean exit");
}

#[test]
fn frames_are_bounded_before_buffering() {
    let mut reader =
        BufReader::with_capacity(16, "12345678901234567890123456789012345\n".as_bytes());
    let error = read_frame(&mut reader, 32).expect_err("oversized frame accepted");
    assert!(error.contains("oversized"), "{error}");
    let mut reader = BufReader::with_capacity(16, "{\"value\":1}".as_bytes());
    let error = read_frame(&mut reader, 32).expect_err("unterminated frame accepted");
    assert!(!error.contains("oversized"), "{error}");
    let mut reader = BufReader::with_capacity(4, "{\"value\":1}\nnext\n".as_bytes());
    assert_eq!(
        read_frame(&mut reader, 32).expect("frame"),
        b"{\"value\":1}\n"
    );
    assert_eq!(read_frame(&mut reader, 32).expect("frame"), b"next\n");
}

#[test]
fn strict_json_rejects_ambiguous_inputs() {
    for raw in [
        r#"{"action":1,"action":2}"#,
        r#"{"action":1,"action":2}"#,
        r#"[{"s":{"calls":[],"calls":[]}}]"#,
        r#"{"value":NaN}"#,
        r#"{"value":1} trailing"#,
        "{",
        "1e999",
    ] {
        assert!(
            strict_parse(raw).is_err(),
            "ambiguous/malformed JSON accepted: {raw}"
        );
    }
    for raw in [
        r#"{"value":"escaped \\\" delimiter } ]","nested":[null,false,1,-2.5e3,{"empty":{}}]}"#,
        r#"{"a":1,"b":2}"#,
        r#"[{},[],true,false,null,"",1]"#,
        " {\"a\" : { \"b\" : [ 1 , 2 ] } , \"c\" : \"x\" }\n",
    ] {
        strict_parse(raw).unwrap_or_else(|error| panic!("valid JSON rejected: {raw}: {error}"));
    }
}

#[test]
fn json_projection_distinguishes_values() {
    assert!(
        json_equal(
            &json!({"n": 1, "a": [false, null, ""]}),
            &json!({"n": 1.0, "a": [false, null, ""]})
        ),
        "equivalent JSON numbers differed"
    );
    for (a, b) in [
        (json!(false), json!(0)),
        (Value::Null, json!(false)),
        (json!("1"), json!(1)),
        (json!([]), Value::Null),
        (json!({"x": null}), json!({})),
    ] {
        assert!(
            !json_equal(&a, &b),
            "distinct observations compared equal: {a} {b}"
        );
    }
}

#[test]
fn itf_integers_decode_exactly_or_fail() {
    let decoded =
        decode_itf(json!({"s": {"calls": [{"#bigint": "1"}, {"#bigint": "-7"}]}, "n": 2.5}))
            .expect("decode");
    assert!(
        json_equal(&decoded, &json!({"s": {"calls": [1, -7]}, "n": 2.5})),
        "{decoded}"
    );
    for (raw, message) in [
        (json!({"#bigint": "9007199254740992"}), "unsafe ITF integer"),
        (
            json!({"#bigint": "-9007199254740992"}),
            "unsafe ITF integer",
        ),
        (json!({"#bigint": "1.5"}), "unsafe ITF integer"),
        (json!({"#bigint": 1}), "unsafe ITF integer"),
        (
            json!({"#bigint": "1", "extra": true}),
            "malformed ITF integer",
        ),
        (json!([9007199254740992i64]), "unsafe JSON number"),
    ] {
        let error = decode_itf(raw.clone())
            .err()
            .unwrap_or_else(|| panic!("accepted {raw}"));
        assert_eq!(error, message, "{raw}");
    }
    assert!(json_equal(
        &decode_itf(json!({"#bigint": "9007199254740991"})).expect("boundary"),
        &json!(9007199254740991i64)
    ));
}

#[test]
fn inventory_ids_follow_the_shared_scheme() {
    assert_eq!(percent_encode_component("a b"), "a%20b");
    assert_eq!(
        percent_encode_component("scope: nested/close"),
        "scope%3A%20nested%2Fclose"
    );
    assert_eq!(percent_encode_component("café ✓"), "caf%C3%A9%20%E2%9C%93");
    assert_eq!(
        percent_encode_component("A-Z_a.z!~*'()09"),
        "A-Z_a.z!~*'()09"
    );
    assert_eq!(percent_encode_component("#?&=+"), "%23%3F%26%3D%2B");
    assert_eq!(
        scenario_case_id("stale recovery", "adapter legacy null"),
        "scenario/stale%20recovery/adapter%20legacy%20null"
    );
    assert_eq!(
        protocol_case_id("keyVectors", "user id: 1"),
        "protocol/keyVectors/user%20id%3A%201"
    );
    assert_eq!(witness_case_id("effects"), "witness/effects");

    let sampled = Path::new(".formal-traces/features/scope/trace_12.itf.json");
    assert_eq!(trace_kind(sampled), "sampled");
    assert_eq!(trace_case_id("scope", sampled, true), "sampled/scope/12");
    assert_eq!(
        trace_case_id("scope", sampled, false),
        "smoke/scope/trace_12.itf.json"
    );
    let regression = Path::new(
        ".formal-traces/features/../regressions/scope/absentValueIsMemoizedTest.itf.json",
    );
    assert_eq!(trace_kind(regression), "regression");
    assert_eq!(
        trace_case_id("scope", regression, true),
        "regression/scope/absentValueIsMemoizedTest"
    );
    assert_eq!(
        trace_case_id("scope", regression, false),
        "regression/scope/absentValueIsMemoizedTest"
    );
    let smoke = repo_root().join("formal/scope-smoke.itf.json");
    assert_eq!(
        trace_case_id("scope", &smoke, false),
        "smoke/scope/scope-smoke.itf.json"
    );
    assert_eq!(
        trace_case_id("core", Path::new("/tmp/custom.itf.json"), true),
        "smoke/core/custom.itf.json"
    );
    assert_eq!(
        trace_case_id("core", Path::new("/x/conformance/trace_007.itf.json"), true),
        "smoke/core/trace_007.itf.json"
    );
}

#[test]
fn missing_scheduled_regressions_fail_corpus_selection() {
    let corpus = TempDir::new("effects-corpus");
    let error =
        regression_paths("effects", &corpus.0).expect_err("missing scheduled histories accepted");
    assert!(error.contains("missing Quint regression"), "{error}");
    assert!(regression_paths("not-a-profile", &corpus.0)
        .expect_err("unknown profile without exports accepted")
        .contains("missing Quint regression"));
}

#[test]
fn registry_checks_match_go() {
    registry_check().expect("core registry");
    for (profile, _) in BEHAVIOR_PROFILE_VERSIONS {
        require_behavior_profile(profile).unwrap_or_else(|error| panic!("{profile}: {error}"));
    }
    assert!(
        require_behavior_profile("core").is_err(),
        "core is not a behavior profile"
    );
    let raw = std::fs::read_to_string(repo_root().join("formal/profiles.json")).expect("registry");
    for mode in ["version", "missing", "duplicate", "model", "schema"] {
        let mut registry = strict_parse(&raw).expect("parse");
        let profiles = registry["profiles"].as_array().cloned().expect("profiles");
        let at = profiles
            .iter()
            .position(|profile| profile["id"] == "scope")
            .expect("scope profile");
        let mut profile = profiles[at].clone();
        match mode {
            "version" => profile["version"] = json!(999),
            "model" => profile["model"] = json!("formal/unknown.qnt"),
            "schema" => registry["behavioralSchemaVersion"] = json!(999),
            _ => {}
        }
        let mut changed = profiles.clone();
        match mode {
            "missing" => {
                changed.remove(at);
            }
            "duplicate" => changed.push(profile.clone()),
            _ => changed[at] = profile,
        }
        registry["profiles"] = Value::Array(changed);
        assert!(
            profile_registry_check_text(&registry.to_string(), "scope", 2).is_err(),
            "{mode}: unsupported profile registry accepted"
        );
    }
}

#[test]
fn report_writes_jsonl_records() {
    let directory = TempDir::new("report");
    let path = directory.0.join("rust-replay.jsonl");
    let mut report = Report::create(Some(&path)).expect("create");
    report.start().expect("start");
    report
        .case("sampled/core/0", &Ok(()), 10, 20)
        .expect("case");
    report
        .case(
            "witness/scope",
            &Err("stale witness definition x".to_string()),
            30,
            40,
        )
        .expect("case");
    let summary = report.finish().expect("finish");
    assert_eq!(
        (summary.cases, summary.failed, summary.status()),
        (2, 1, "failed")
    );
    let text = std::fs::read_to_string(&path).expect("report");
    let records: Vec<Value> = text
        .lines()
        .map(|line| strict_parse(line).expect("record"))
        .collect();
    assert_eq!(records.len(), 4);
    assert_eq!(records[0]["kind"], "start");
    assert_eq!(records[0]["schemaVersion"], 1);
    assert_eq!(records[0]["implementation"], "rust");
    assert!(records[0]["startedAt"]
        .as_i64()
        .is_some_and(|ms| ms > 1_700_000_000_000));
    assert_eq!(
        records[1],
        json!({"kind": "case", "id": "sampled/core/0", "status": "passed", "startedAt": 10, "finishedAt": 20})
    );
    assert_eq!(
        records[2],
        json!({"kind": "case", "id": "witness/scope", "status": "failed", "startedAt": 30, "finishedAt": 40, "message": "stale witness definition x"})
    );
    assert_eq!(records[3]["kind"], "finish");
    assert_eq!(records[3]["status"], "failed");
    assert_eq!(records[3]["cases"], 2);
    assert_eq!(records[3]["failed"], 1);
    let mut silent = Report::create(None).expect("no-op");
    silent.start().expect("start");
    assert!(silent.run_case("x", || Ok(())).is_ok());
    assert_eq!(silent.finish().expect("finish").cases, 1);
}

#[test]
fn sha256_matches_known_vectors() {
    assert_eq!(
        sha256_hex(b""),
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_eq!(
        sha256_hex(b"abc"),
        "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
    );
    assert_eq!(
        sha256_hex(b"abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
        "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1"
    );
    assert_eq!(
        sha256_hex(&[b'a'; 1_000_000]),
        "cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0"
    );
    // 55, 56 and 64 byte messages straddle the padding boundary.
    assert_eq!(
        sha256_hex(&[0u8; 55]),
        "02779466cdec163811d078815c633f21901413081449002f24aa3e80f0b88ef7"
    );
    assert_eq!(
        sha256_hex(&[0u8; 56]),
        "d4817aa5497628e7c77e6b606107042bbba3130888c5f47a375e6179be789fbb"
    );
    assert_eq!(
        sha256_hex(&[0u8; 64]),
        "f5a5fd42d16a20302798ef6ed309979b43003d2320d9f0e8ea9831a92759fb4b"
    );
    let schema = repo_root().join("formal/replay/protocol.schema.json");
    let expected = Command::new("shasum")
        .arg("-a")
        .arg("256")
        .arg(&schema)
        .output()
        .ok()
        .filter(|output| output.status.success());
    if let Some(output) = expected {
        let text = String::from_utf8_lossy(&output.stdout);
        assert_eq!(
            text.split_whitespace().next(),
            Some(file_sha256(&schema).expect("hash").as_str())
        );
    }
}

#[test]
fn witness_evidence_binds_shared_replay_sources() {
    let root = TempDir::new("witness-root");
    let inputs = [
        "formal/profiles.json",
        "formal/coverage-witnesses.json",
        "formal/execution.json",
        "formal/dialcache-effects-conformance.qnt",
        "formal/conformance-observations.qnt",
        "formal/replay/coordinator.mjs",
        "formal/replay/mapping.mjs",
    ];
    for path in inputs {
        root.write(path, "reviewed input");
    }
    root.write("formal/profiles.json", r#"{"profiles":[{"id":"effects"}],"replaySources":["formal/replay/coordinator.mjs","formal/replay/mapping.mjs"]}"#);
    root.write(
        "formal/coverage-witnesses.json",
        r#"{"effects":["observed"]}"#,
    );
    root.write(
        "formal/execution.json",
        r#"{"models":[{"path":"formal/dialcache-effects-conformance.qnt"}]}"#,
    );
    root.write("trace.itf.json", "controlled trace");
    let trace = root.0.join("trace.itf.json");
    let cite = |name: &str, kind: &str, checkpoints: Vec<i64>| Trace {
        name: name.to_string(),
        kind: kind.to_string(),
        checkpoints,
    };
    let mut evidence = Evidence {
        schema_version: 2,
        profile: "effects".to_string(),
        traces: 1,
        required: vec!["observed".to_string()],
        seen: vec!["observed".to_string()],
        labels: Some(HashMap::from([(
            "observed".to_string(),
            Label {
                sampled: 1,
                regression: 0,
                traces: vec![cite("trace.itf.json", "sampled", vec![1])],
            },
        )])),
        inputs: Vec::new(),
        corpus: Vec::new(),
    };
    for path in inputs {
        evidence.inputs.push(Digest {
            path: path.to_string(),
            name: String::new(),
            sha256: file_sha256(&root.0.join(path)).expect("hash"),
        });
    }
    evidence.corpus = vec![Digest {
        path: String::new(),
        name: "trace.itf.json".to_string(),
        sha256: file_sha256(&trace).expect("hash"),
    }];
    let write = |evidence: &Evidence| {
        root.write(
            "effects.json",
            &serde_json::to_string(evidence).expect("encode"),
        )
    };
    write(&evidence);
    let check =
        || check_witness_evidence(&root.0, "effects", &root.0, std::slice::from_ref(&trace));
    check().expect("valid evidence rejected");

    let expect = |patch: &dyn Fn(&mut Evidence), fragment: &str| {
        let mut copied = evidence.clone();
        patch(&mut copied);
        write(&copied);
        let error = check()
            .err()
            .unwrap_or_else(|| panic!("evidence accepted; expected {fragment:?}"));
        assert!(error.contains(fragment), "expected {fragment:?} in {error}");
    };
    expect(&|e| e.schema_version = 1, "unsupported");
    expect(&|e| e.labels = Some(HashMap::new()), "lacks provenance");
    expect(&|e| e.labels = None, "lacks per-label provenance");
    expect(
        &|e| {
            e.labels = Some(HashMap::from([(
                "observed".to_string(),
                Label {
                    sampled: 1,
                    regression: 0,
                    traces: vec![cite("other.itf.json", "sampled", vec![1])],
                },
            )]))
        },
        "unknown history",
    );
    expect(
        &|e| {
            e.labels = Some(HashMap::from([(
                "observed".to_string(),
                Label {
                    sampled: 0,
                    regression: 1,
                    traces: vec![cite("trace.itf.json", "regression", vec![1])],
                },
            )]))
        },
        "as regression",
    );
    expect(
        &|e| {
            e.labels = Some(HashMap::from([(
                "observed".to_string(),
                Label {
                    sampled: 2,
                    regression: 0,
                    traces: vec![cite("trace.itf.json", "sampled", vec![1])],
                },
            )]))
        },
        "cites 1 and 0",
    );
    expect(
        &|e| {
            e.labels = Some(HashMap::from([(
                "observed".to_string(),
                Label {
                    sampled: 1,
                    regression: 0,
                    traces: vec![cite("trace.itf.json", "sampled", Vec::new())],
                },
            )]))
        },
        "without a checkpoint",
    );
    expect(
        &|e| e.seen = vec!["observed".to_string(), "observed".to_string()],
        "duplicate witness observed",
    );
    expect(&|e| e.seen = Vec::new(), "missing witness observed");
    expect(
        &|e| e.required = Vec::new(),
        "required witness registry differs",
    );
    expect(
        &|e| e.inputs.pop().map(drop).unwrap_or_default(),
        "incomplete witness definition fingerprints",
    );
    expect(
        &|e| e.inputs[6].path = "formal/replay/other.mjs".to_string(),
        "unexpected witness input formal/replay/other.mjs",
    );
    expect(
        &|e| e.corpus[0].sha256 = "00".to_string(),
        "witness corpus differs at trace.itf.json",
    );
    expect(
        &|e| e.corpus[0].name = "other.itf.json".to_string(),
        "witness corpus differs at other.itf.json",
    );

    // Go-encoded evidence spells empty lists as null; the reader accepts that.
    root.write(
        "effects.json",
        &serde_json::to_string(&evidence)
            .expect("encode")
            .replace(r#""regression":0"#, r#""regression":0,"extra":null"#),
    );
    check().expect("unknown members are ignored");
    write(&evidence);
    check().expect("restored evidence rejected");

    // Library membership is discovered from actual Quint sources, so adding
    // a kernel library must invalidate the old evidence even without a
    // manifest edit; updating its digest then makes subsequent drift visible.
    root.write("formal/kernel/new-library.qnt", "new reviewed library");
    let error = check().expect_err("new kernel library omitted from evidence");
    assert!(
        error.contains("incomplete witness definition fingerprints"),
        "{error}"
    );
    let mut with_library = evidence.clone();
    with_library.inputs.insert(
        5,
        Digest {
            path: "formal/kernel/new-library.qnt".to_string(),
            name: String::new(),
            sha256: file_sha256(&root.0.join("formal/kernel/new-library.qnt")).expect("hash"),
        },
    );
    write(&with_library);
    check().expect("new library fingerprint rejected");
    root.write("formal/kernel/new-library.qnt", "changed library");
    let error = check().expect_err("stale kernel library digest accepted");
    assert!(
        error.contains("stale witness definition formal/kernel/new-library.qnt"),
        "{error}"
    );
    std::fs::remove_file(root.0.join("formal/kernel/new-library.qnt")).expect("remove library");
    write(&evidence);
    check().expect("restored library inventory rejected");

    root.write("formal/replay/mapping.mjs", "changed input mapping");
    let error = check().expect_err("changed shared mapping accepted");
    assert!(
        error.contains("stale witness definition formal/replay/mapping.mjs"),
        "{error}"
    );
    root.write("formal/replay/mapping.mjs", "reviewed input");
    root.write("formal/replay/new-helper.mjs", "unregistered helper");
    let error = check().expect_err("new dependency accepted");
    assert!(error.contains("inventory differs"), "{error}");
    std::fs::remove_file(root.0.join("formal/replay/new-helper.mjs")).expect("remove");
    std::fs::remove_file(root.0.join("formal/replay/mapping.mjs")).expect("remove");
    let error = check().expect_err("missing dependency accepted");
    assert!(error.contains("inventory differs"), "{error}");
}

#[test]
fn observe_requests_reach_the_coordinator_comparison() {
    // A driver that reports zeros diverges from the smoke history, but only
    // after the coordinator accepted the observe request shape and compared the
    // record: the failure is an observation mismatch, not a protocol violation.
    let mut coordinator = Coordinator::spawn().expect("shared replay requires Node 24 on PATH");
    let path = repo_root().join("formal/conformance-smoke.itf.json");
    let prepared = coordinator.prepare("core", &path, None).expect("prepare");
    let mut applied = Vec::new();
    let error = coordinator
        .execute(
            &prepared,
            &mut |input| {
                applied.push(input.clone());
                Ok(())
            },
            &mut healthy_core_observation,
            &mut || 1_788_868_800_000,
            None,
            &mut [],
        )
        .expect_err("a zero observation matched the smoke history");
    assert!(
        error.starts_with("shared replay: ") && error.contains("Observation mismatch"),
        "{error}"
    );
    assert!(
        !error.contains("Malformed") && !error.contains("schema"),
        "observe request was rejected structurally: {error}"
    );
    assert_eq!(
        applied.len(),
        prepared.setup.len(),
        "commands applied before the first observation mismatch"
    );
    // The failed session was discarded, so the coordinator no longer knows it.
    let mut observe = request("observe");
    observe.insert("session".to_string(), Value::from(prepared.session.clone()));
    observe.insert("index".to_string(), Value::from(0));
    observe.insert("settlement".to_string(), Value::from(SETTLEMENT));
    observe.insert("observed".to_string(), healthy_core_observation());
    observe.insert(
        "environment".to_string(),
        json!({"wallMs": 1_788_868_800_000i64}),
    );
    let error = coordinator
        .call(observe)
        .expect_err("discarded session accepted");
    assert!(error.contains("Unknown replay session"), "{error}");
    coordinator.finish().expect("clean exit");
}

#[test]
fn checked_in_replay_sources_match_the_registry() {
    // The real registry must agree with the real formal/replay tree, or no
    // witness evidence produced from this checkout could ever be accepted.
    let sources =
        formal::witness::shared_replay_sources(&repo_root()).expect("shared replay sources");
    assert!(sources
        .iter()
        .any(|path| path == "formal/replay/coordinator.mjs"));
    assert!(sources
        .iter()
        .any(|path| path == "formal/replay/protocol.schema.json"));
}
