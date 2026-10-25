//! Confirmed-mismatch warnings end to end: the fields each mismatch-logging
//! leaf adds, the hook, the `ShadowMismatchLogging` outcome and its
//! precedence, logger failures, absent values and runtime leaf resolution.

use std::future::{ready, Future};
use std::pin::Pin;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use dialcache::observe::{ErrorKind, Layer, ShadowMismatchLoggingOutcome, ShadowOutcome};
use dialcache::testing::{TestExecutor, WALL_EPOCH_MS};
use dialcache::{
    BoxError, DialCache, Event, Frame, FromSync, Identity, InvalidateRequest, JsonCodec, KeySpec,
    LogEvent, Logger, MismatchDiff, MismatchEntry, MismatchLogging, Observer, Operation, Payload,
    Policy, ReadContext, ReadRequest, ReadResult, Remote, RuntimePolicy, ShadowMismatchDetails,
    ShadowMismatchDiffDetails, ShadowMismatchValueDetails, ShadowPolicy, SyncCodec, WriteRequest,
};
use futures::channel::oneshot;
use futures::future::BoxFuture;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize, Serializer};
use serde_json::{json, Value};

const AGE_MS: u64 = 30_500;
const CACHED_JSON: &str = r#"{"id":"123","version":1}"#;
const SOURCE_JSON: &str = r#"{"id":"123","version":2}"#;
const DIFF_JSON: &str = r#"[{"path":"/version","cached":1,"source":2}]"#;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
struct Record {
    id: String,
    version: u64,
}

fn record(version: u64) -> Record {
    Record {
        id: "123".into(),
        version,
    }
}

/// Every read returns the same frame, so the confirmation read finds the
/// payload unchanged.
struct SnapshotRemote(String);

impl Remote for SnapshotRemote {
    fn read(&self, _: ReadRequest, _: ReadContext) -> BoxFuture<'_, Result<ReadResult, BoxError>> {
        Box::pin(ready(Ok(ReadResult::Hit(Frame {
            created_at_ms: WALL_EPOCH_MS as u64 - AGE_MS,
            payload: Payload::text(self.0.clone()),
        }))))
    }

    fn write(&self, _: WriteRequest) -> BoxFuture<'_, Result<(), BoxError>> {
        Box::pin(ready(Ok(())))
    }

    fn invalidate(&self, _: InvalidateRequest) -> BoxFuture<'_, Result<(), BoxError>> {
        Box::pin(ready(Ok(())))
    }
}

/// One step of the shared diagnostic sequence.
#[derive(Debug, Clone, PartialEq)]
enum Step {
    Event(Event),
    Warning(Box<ShadowMismatchDetails>),
}

#[derive(Default)]
struct Recorder {
    steps: Mutex<Vec<Step>>,
    logger_panics: bool,
}

impl Recorder {
    fn events(&self) -> Vec<Event> {
        self.steps
            .lock()
            .iter()
            .filter_map(|step| match step {
                Step::Event(event) => Some(event.clone()),
                Step::Warning(_) => None,
            })
            .collect()
    }

    fn warnings(&self) -> Vec<ShadowMismatchDetails> {
        self.steps
            .lock()
            .iter()
            .filter_map(|step| match step {
                Step::Warning(details) => Some(*details.clone()),
                Step::Event(_) => None,
            })
            .collect()
    }

    fn verdicts(&self) -> Vec<ShadowOutcome> {
        self.events()
            .into_iter()
            .filter_map(|event| match event {
                Event::ShadowValidation { outcome, .. } => Some(outcome),
                _ => None,
            })
            .collect()
    }

    fn logging_outcomes(&self) -> Vec<ShadowMismatchLoggingOutcome> {
        self.events()
            .into_iter()
            .filter_map(|event| match event {
                Event::ShadowMismatchLogging { outcome, .. } => Some(outcome),
                _ => None,
            })
            .collect()
    }

    fn config_resolutions(&self) -> usize {
        self.events()
            .iter()
            .filter(|event| {
                matches!(
                    event,
                    Event::Error {
                        error: ErrorKind::ConfigResolution,
                        labels,
                        in_fallback: false,
                    } if labels.layer == Layer::Remote
                )
            })
            .count()
    }

    fn age_seconds(&self) -> Vec<f64> {
        self.events()
            .into_iter()
            .filter_map(|event| match event {
                Event::ShadowValueAge { seconds, .. } => Some(seconds),
                _ => None,
            })
            .collect()
    }
}

struct RecordingObserver(Arc<Recorder>);

impl Observer for RecordingObserver {
    fn observe(&self, event: &Event) {
        self.0.steps.lock().push(Step::Event(event.clone()));
    }

    fn observes_shadow_outcomes(&self) -> bool {
        true
    }
}

struct RecordingLogger(Arc<Recorder>);

impl Logger for RecordingLogger {
    fn log(&self, event: &LogEvent) {
        if let LogEvent::ShadowMismatch(details) = event {
            self.0
                .steps
                .lock()
                .push(Step::Warning(Box::new(details.clone())));
            if self.0.logger_panics {
                panic!("logger unavailable");
            }
        }
    }
}

type Overlay = Option<Value>;

fn cache(executor: &TestExecutor, recorder: &Arc<Recorder>, overlay: Overlay) -> DialCache {
    let mut builder = DialCache::builder()
        .clock_arc(executor.clock.clone())
        .runtime_arc(executor.runtime.clone())
        .remote(SnapshotRemote(CACHED_JSON.to_string()))
        .observer(RecordingObserver(recorder.clone()))
        .logger(RecordingLogger(recorder.clone()));
    if let Some(overlay) = overlay {
        builder = builder.policy_provider(move |_| {
            let overlay = overlay.clone();
            async move { Ok(Some(RuntimePolicy::from_json(overlay))) }
        });
    }
    builder.build().expect("valid configuration")
}

fn shadow(log_mismatches: Option<bool>, logging: Option<MismatchLogging>) -> Policy {
    Policy::default().remote_ttl_sec(60).shadow(ShadowPolicy {
        ramp: Some(100.0),
        log_mismatches,
        mismatch_logging: logging,
    })
}

fn leaves(value: Option<bool>, diff: Option<MismatchDiff>) -> Option<MismatchLogging> {
    Some(MismatchLogging { value, diff })
}

fn operation(use_case: &str, policy: Policy) -> Operation<Record> {
    Operation::new(Identity::new("user_id", "123", use_case)).policy(policy)
}

/// One served-hit call whose shadow job confirms a mismatch, run to quiescence.
fn run<T: Clone + Send + Sync + 'static>(
    recorder: &Arc<Recorder>,
    overlay: Overlay,
    operation: Operation<T>,
    source: T,
) -> Arc<T> {
    let mut executor = TestExecutor::new(WALL_EPOCH_MS);
    let cache = cache(&executor, recorder, overlay);
    let result = executor.block_on(async move {
        let request = cache.enable_guard();
        cache
            .get_or_load(request.scope(), operation, move |_| {
                let source = source.clone();
                async move { Ok(source) }
            })
            .await
    });
    executor.drain();
    result.expect("the caller is served")
}

fn confirmed(use_case: &str, policy: Policy, overlay: Overlay) -> Arc<Recorder> {
    let recorder = Arc::new(Recorder::default());
    let served = run(&recorder, overlay, operation(use_case, policy), record(2));
    assert_eq!(*served, record(1));
    assert_eq!(recorder.verdicts(), vec![ShadowOutcome::Mismatch]);
    recorder
}

fn paths(level: MismatchDiff, diff_json: Option<&str>) -> Option<ShadowMismatchDiffDetails> {
    Some(ShadowMismatchDiffDetails {
        level,
        mismatch_paths: Some(vec!["/version".to_string()]),
        mismatch_path_count: Some(1),
        diff_json: diff_json.map(str::to_owned),
    })
}

fn failed_diff(level: MismatchDiff) -> Option<ShadowMismatchDiffDetails> {
    Some(ShadowMismatchDiffDetails {
        level,
        mismatch_paths: None,
        mismatch_path_count: None,
        diff_json: None,
    })
}

fn values(cached: Option<&str>, source: Option<&str>) -> Option<ShadowMismatchValueDetails> {
    Some(ShadowMismatchValueDetails {
        cached_value_json: cached.map(str::to_owned),
        source_value_json: source.map(str::to_owned),
    })
}

/// The one warning, checked against the expected content fields.
fn assert_warning(
    recorder: &Recorder,
    use_case: &str,
    diff: Option<ShadowMismatchDiffDetails>,
    values: Option<ShadowMismatchValueDetails>,
    logging_outcome: Option<ShadowMismatchLoggingOutcome>,
) {
    assert_eq!(
        recorder.warnings(),
        vec![ShadowMismatchDetails {
            namespace: "urn".into(),
            use_case: use_case.into(),
            key_type: "user_id".into(),
            cached_value_age_seconds: AGE_MS as f64 / 1000.0,
            cache_key: format!("urn:user_id:123#{use_case}"),
            diff,
            values,
            logging_outcome,
        }]
    );
}

#[test]
fn no_warning_or_logging_event_while_logging_is_omitted() {
    let recorder = confirmed("LoggingOff", shadow(None, None), None);
    assert!(recorder.warnings().is_empty());
    assert!(recorder.logging_outcomes().is_empty());
}

#[test]
fn diff_paths_logs_only_the_paths_and_their_count() {
    let recorder = confirmed(
        "PathsOnly",
        shadow(None, leaves(None, Some(MismatchDiff::Paths))),
        None,
    );
    assert_warning(
        &recorder,
        "PathsOnly",
        paths(MismatchDiff::Paths, None),
        None,
        None,
    );
    assert_eq!(
        recorder.logging_outcomes(),
        vec![ShadowMismatchLoggingOutcome::Logged]
    );
    // The warning carries the age the verdict's metric observed.
    assert_eq!(recorder.age_seconds(), vec![30.5]);
}

#[test]
fn diff_values_without_value_logs_the_entries_without_whole_values() {
    let recorder = confirmed(
        "ValuesDiffOnly",
        shadow(None, leaves(Some(false), Some(MismatchDiff::Values))),
        None,
    );
    assert_warning(
        &recorder,
        "ValuesDiffOnly",
        paths(MismatchDiff::Values, Some(DIFF_JSON)),
        None,
        None,
    );
}

#[test]
fn value_alone_logs_the_whole_values_and_never_runs_the_hook() {
    let recorder = Arc::new(Recorder::default());
    let calls = Arc::new(AtomicUsize::new(0));
    let seen = calls.clone();
    let operation = operation("ValueOnly", shadow(None, leaves(Some(true), None))).mismatch_diff(
        move |_: &Record, _: &Record| {
            seen.fetch_add(1, Ordering::SeqCst);
            Vec::new()
        },
    );
    run(&recorder, None, operation, record(2));
    assert_warning(
        &recorder,
        "ValueOnly",
        None,
        values(Some(CACHED_JSON), Some(SOURCE_JSON)),
        None,
    );
    assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn the_shorthand_logs_every_field_in_the_reference_order() {
    let recorder = confirmed("Shorthand", shadow(Some(true), None), None);
    assert_warning(
        &recorder,
        "Shorthand",
        paths(MismatchDiff::Values, Some(DIFF_JSON)),
        values(Some(CACHED_JSON), Some(SOURCE_JSON)),
        None,
    );
    let warning = LogEvent::ShadowMismatch(recorder.warnings().remove(0));
    assert_eq!(
        warning.to_string(),
        format!(
            "DialCache shadow validation mismatch: namespace=urn useCase=Shorthand keyType=user_id \
             cachedValueAgeSeconds=30.5 cacheKey=urn:user_id:123#Shorthand \
             mismatchPaths=[\"/version\"] mismatchPathCount=1 diffJson={DIFF_JSON} \
             cachedValue={CACHED_JSON} sourceValue={SOURCE_JSON}"
        )
    );
}

#[test]
fn the_logging_event_follows_the_verdict_and_the_warning_and_a_match_emits_none() {
    let recorder = Arc::new(Recorder::default());
    let mut executor = TestExecutor::new(WALL_EPOCH_MS);
    let cache = cache(&executor, &recorder, None);
    for version in [1, 2, 3] {
        let cache = cache.clone();
        executor.block_on(async move {
            let request = cache.enable_guard();
            let operation = operation(
                "LoggingOrder",
                shadow(None, leaves(None, Some(MismatchDiff::Paths))),
            );
            cache
                .get_or_load(request.scope(), operation, move |_| {
                    ready(Ok(record(version)))
                })
                .await
                .unwrap();
        });
        executor.drain();
    }
    assert_eq!(
        recorder.verdicts(),
        vec![
            ShadowOutcome::Match,
            ShadowOutcome::Mismatch,
            ShadowOutcome::Mismatch
        ]
    );
    let sequence: Vec<&'static str> = recorder
        .steps
        .lock()
        .iter()
        .filter_map(|step| match step {
            Step::Event(Event::ShadowValidation { .. }) => Some("verdict"),
            Step::Event(Event::ShadowValueAge { .. }) => Some("age"),
            Step::Warning(_) => Some("warning"),
            Step::Event(Event::ShadowMismatchLogging { .. }) => Some("logging"),
            _ => None,
        })
        .collect();
    assert_eq!(
        sequence,
        [
            "verdict", "age", "verdict", "age", "warning", "logging", "verdict", "age", "warning",
            "logging"
        ]
    );
}

#[test]
fn the_hook_replaces_the_built_in_walk_for_inline_and_registered_use_cases() {
    let hook = |cached: &Record, source: &Record| {
        assert_eq!((cached, source), (&record(1), &record(2)));
        vec![
            MismatchEntry {
                path: "/custom".into(),
                cached: Some(json!("c")),
                source: Some(json!("s")),
            },
            MismatchEntry {
                path: "/only-path".into(),
                cached: None,
                source: None,
            },
            MismatchEntry {
                path: "/one-side".into(),
                cached: None,
                source: Some(json!({"nested": true})),
            },
        ]
    };
    let expected = Some(ShadowMismatchDiffDetails {
        level: MismatchDiff::Values,
        mismatch_paths: Some(vec![
            "/custom".to_string(),
            "/only-path".to_string(),
            "/one-side".to_string(),
        ]),
        mismatch_path_count: Some(3),
        diff_json: Some(
            r#"[{"path":"/custom","cached":"c","source":"s"},{"path":"/only-path"},{"path":"/one-side","source":{"nested":true}}]"#
                .to_string(),
        ),
    });

    let recorder = Arc::new(Recorder::default());
    let inline = operation("HookInline", shadow(Some(true), None)).mismatch_diff(hook);
    run(&recorder, None, inline, record(2));
    assert_warning(
        &recorder,
        "HookInline",
        expected.clone(),
        values(Some(CACHED_JSON), Some(SOURCE_JSON)),
        None,
    );

    let recorder = Arc::new(Recorder::default());
    let mut executor = TestExecutor::new(WALL_EPOCH_MS);
    let cache = cache(&executor, &recorder, None);
    let use_case = cache
        .use_case::<(), Record>("user_id", "HookRegistered")
        .policy(shadow(Some(true), None))
        .key(|_| KeySpec::new("123"))
        .source(|_, ()| ready(Ok(record(2))))
        .mismatch_diff(hook)
        .register()
        .unwrap();
    executor.block_on(async move {
        let request = cache.enable_guard();
        use_case.get(request.scope(), ()).await.unwrap();
    });
    executor.drain();
    assert_warning(
        &recorder,
        "HookRegistered",
        expected,
        values(Some(CACHED_JSON), Some(SOURCE_JSON)),
        None,
    );
    assert_eq!(
        recorder.logging_outcomes(),
        vec![ShadowMismatchLoggingOutcome::Logged]
    );
}

#[test]
fn a_panicking_hook_logs_hook_error_without_touching_the_verdict_or_the_caller() {
    let recorder = Arc::new(Recorder::default());
    let operation = operation("HookPanics", shadow(Some(true), None))
        .mismatch_diff(|_: &Record, _: &Record| panic!("diff hook unavailable"));
    assert_eq!(*run(&recorder, None, operation, record(2)), record(1));
    assert_eq!(recorder.verdicts(), vec![ShadowOutcome::Mismatch]);
    assert_warning(
        &recorder,
        "HookPanics",
        failed_diff(MismatchDiff::Values),
        values(Some(CACHED_JSON), Some(SOURCE_JSON)),
        Some(ShadowMismatchLoggingOutcome::HookError),
    );
    assert_eq!(
        recorder.logging_outcomes(),
        vec![ShadowMismatchLoggingOutcome::HookError]
    );
}

#[test]
fn a_panicking_logger_records_logger_error_and_leaves_the_caller_unaffected() {
    let recorder = Arc::new(Recorder {
        logger_panics: true,
        ..Recorder::default()
    });
    let operation = operation("LoggerPanics", shadow(Some(true), None));
    assert_eq!(*run(&recorder, None, operation, record(2)), record(1));
    assert_eq!(recorder.verdicts(), vec![ShadowOutcome::Mismatch]);
    assert_warning(
        &recorder,
        "LoggerPanics",
        paths(MismatchDiff::Values, Some(DIFF_JSON)),
        values(Some(CACHED_JSON), Some(SOURCE_JSON)),
        None,
    );
    assert_eq!(
        recorder.logging_outcomes(),
        vec![ShadowMismatchLoggingOutcome::LoggerError]
    );
}

/// A source value whose serialization fails, as the replay's unrenderable
/// source input does.
#[derive(Debug, Clone, PartialEq)]
enum Unrenderable {
    Record(Record),
    Fails,
}

impl Serialize for Unrenderable {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Unrenderable::Record(record) => record.serialize(serializer),
            Unrenderable::Fails => Err(serde::ser::Error::custom("not serializable")),
        }
    }
}

impl<'de> Deserialize<'de> for Unrenderable {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Record::deserialize(deserializer).map(Unrenderable::Record)
    }
}

#[test]
fn hook_error_and_render_error_rank_above_a_failing_logger() {
    for (name, hook_panics, outcome) in [
        (
            "HookAndLoggerFail",
            true,
            ShadowMismatchLoggingOutcome::HookError,
        ),
        (
            "RenderAndLoggerFail",
            false,
            ShadowMismatchLoggingOutcome::RenderError,
        ),
    ] {
        let recorder = Arc::new(Recorder {
            logger_panics: true,
            ..Recorder::default()
        });
        let mut operation = Operation::<Unrenderable>::new(Identity::new("user_id", "123", name))
            .policy(shadow(Some(true), None));
        if hook_panics {
            operation = operation.mismatch_diff(|_, _| panic!("hook failed"));
        }
        let served = run(&recorder, None, operation, Unrenderable::Fails);
        assert_eq!(*served, Unrenderable::Record(record(1)));
        assert_warning(
            &recorder,
            name,
            failed_diff(MismatchDiff::Values),
            values(Some(CACHED_JSON), None),
            Some(outcome),
        );
        assert_eq!(recorder.logging_outcomes(), vec![outcome]);
    }
}

#[test]
fn an_unrenderable_source_value_logs_render_error_with_its_fields_null() {
    let recorder = Arc::new(Recorder::default());
    let operation = Operation::<Unrenderable>::new(Identity::new("user_id", "123", "Unrenderable"))
        .policy(shadow(None, leaves(Some(true), Some(MismatchDiff::Paths))));
    run(&recorder, None, operation, Unrenderable::Fails);
    assert_warning(
        &recorder,
        "Unrenderable",
        failed_diff(MismatchDiff::Paths),
        values(Some(CACHED_JSON), None),
        Some(ShadowMismatchLoggingOutcome::RenderError),
    );
    assert_eq!(
        recorder.logging_outcomes(),
        vec![ShadowMismatchLoggingOutcome::RenderError]
    );
}

/// A value the default codec cannot hold: the test-only absent marker stands
/// for TypeScript's top-level `undefined`.
#[derive(Debug, Clone, PartialEq)]
enum Maybe {
    Absent,
    Present(Record),
}

impl Serialize for Maybe {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Maybe::Absent => dialcache::testing::Absent.serialize(serializer),
            Maybe::Present(record) => record.serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for Maybe {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Record::deserialize(deserializer).map(Maybe::Present)
    }
}

struct MaybeCodec;

impl SyncCodec<Maybe> for MaybeCodec {
    fn encode(&self, value: &Maybe) -> Result<Payload, BoxError> {
        match value {
            Maybe::Absent => Ok(Payload::text("__absent__")),
            Maybe::Present(record) => JsonCodec::encode_value(record),
        }
    }

    fn decode(&self, payload: Payload) -> Result<Maybe, BoxError> {
        if payload.as_text() == "__absent__" {
            return Ok(Maybe::Absent);
        }
        JsonCodec::decode_value(&payload).map(Maybe::Present)
    }
}

#[test]
fn an_absent_cached_value_is_an_absent_side_not_a_render_failure() {
    let recorder = Arc::new(Recorder::default());
    let mut executor = TestExecutor::new(WALL_EPOCH_MS);
    let cache = DialCache::builder()
        .clock_arc(executor.clock.clone())
        .runtime_arc(executor.runtime.clone())
        .remote(SnapshotRemote("__absent__".to_string()))
        .observer(RecordingObserver(recorder.clone()))
        .logger(RecordingLogger(recorder.clone()))
        .build()
        .unwrap();
    let mut operation = Operation::<Maybe>::new(Identity::new("user_id", "123", "AbsentCached"))
        .policy(shadow(Some(true), None));
    // The JSON rendering stays when the codec is replaced.
    operation.codec = Arc::new(FromSync(MaybeCodec));
    let served = executor.block_on(async move {
        let request = cache.enable_guard();
        cache
            .get_or_load(request.scope(), operation, |_| {
                ready(Ok(Maybe::Present(record(2))))
            })
            .await
    });
    executor.drain();
    assert_eq!(*served.unwrap(), Maybe::Absent);
    assert_eq!(recorder.verdicts(), vec![ShadowOutcome::Mismatch]);
    assert_warning(
        &recorder,
        "AbsentCached",
        Some(ShadowMismatchDiffDetails {
            level: MismatchDiff::Values,
            mismatch_paths: Some(vec![String::new()]),
            mismatch_path_count: Some(1),
            diff_json: Some(format!(r#"[{{"path":"","source":{SOURCE_JSON}}}]"#)),
        }),
        values(None, Some(SOURCE_JSON)),
        None,
    );
    assert_eq!(
        recorder.logging_outcomes(),
        vec![ShadowMismatchLoggingOutcome::Logged]
    );
}

struct TextCodec;

impl SyncCodec<String> for TextCodec {
    fn encode(&self, text: &String) -> Result<Payload, BoxError> {
        Ok(Payload::text(text.clone()))
    }

    fn decode(&self, payload: Payload) -> Result<String, BoxError> {
        Ok(payload.as_text().into_owned())
    }
}

#[test]
fn a_custom_codec_operation_logs_diff_fields_only_through_its_hook() {
    let custom = |name: &str| {
        Operation::with_codec(
            Identity::new("user_id", "123", name),
            Arc::new(FromSync(TextCodec)),
            |a: &String, b: &String| a == b,
        )
        .policy(shadow(Some(true), None))
    };
    let recorder = Arc::new(Recorder::default());
    run(&recorder, None, custom("CustomCodec"), "source".to_string());
    assert_warning(
        &recorder,
        "CustomCodec",
        failed_diff(MismatchDiff::Values),
        values(None, None),
        Some(ShadowMismatchLoggingOutcome::RenderError),
    );

    let recorder = Arc::new(Recorder::default());
    let operation = custom("CustomCodecHook")
        .preview(|text: &String| Some(format!("<{text}>")))
        .mismatch_diff(|_: &String, _: &String| {
            vec![MismatchEntry {
                path: String::new(),
                cached: None,
                source: None,
            }]
        });
    run(&recorder, None, operation, "source".to_string());
    assert_warning(
        &recorder,
        "CustomCodecHook",
        Some(ShadowMismatchDiffDetails {
            level: MismatchDiff::Values,
            mismatch_paths: Some(vec![String::new()]),
            mismatch_path_count: Some(1),
            diff_json: Some(r#"[{"path":""}]"#.to_string()),
        }),
        values(Some(&format!("<{CACHED_JSON}>")), Some("<source>")),
        None,
    );
}

#[test]
fn an_invalid_runtime_leaf_keeps_the_valid_default_leaf_with_one_config_resolution() {
    let recorder = confirmed(
        "InvalidRuntimeLeaf",
        shadow(None, leaves(Some(true), None)),
        Some(json!({"shadow": {"mismatchLogging": {"diff": "everything"}}})),
    );
    assert_eq!(recorder.config_resolutions(), 1);
    assert_warning(
        &recorder,
        "InvalidRuntimeLeaf",
        None,
        values(Some(CACHED_JSON), Some(SOURCE_JSON)),
        None,
    );
}

#[test]
fn a_malformed_runtime_shorthand_owes_one_config_resolution_and_its_leaves_still_log() {
    let recorder = confirmed(
        "MalformedShorthand",
        shadow(Some(true), None),
        Some(json!({"shadow": {
            "logMismatches": "yes",
            "mismatchLogging": {"value": false, "diff": "paths"},
        }})),
    );
    assert_eq!(recorder.config_resolutions(), 1);
    assert_warning(
        &recorder,
        "MalformedShorthand",
        paths(MismatchDiff::Paths, None),
        None,
        None,
    );
    // A malformed shorthand alone turns logging off, still with one diagnostic.
    let recorder = confirmed(
        "MalformedShorthandAlone",
        shadow(Some(true), None),
        Some(json!({"shadow": {"logMismatches": null, "mismatchLogging": {"value": 1}}})),
    );
    assert_eq!(recorder.config_resolutions(), 1);
    assert!(recorder.warnings().is_empty());
    assert!(recorder.logging_outcomes().is_empty());
}

#[test]
fn the_recorded_table_rows_hold_end_to_end() {
    for (name, policy, overlay, expected) in [
        (
            "RowShorthandTrueValueFalse",
            shadow(Some(true), leaves(Some(false), None)),
            None,
            Some((paths(MismatchDiff::Values, Some(DIFF_JSON)), None)),
        ),
        (
            "RowShorthandFalseDiffPaths",
            shadow(Some(false), leaves(None, Some(MismatchDiff::Paths))),
            None,
            Some((paths(MismatchDiff::Paths, None), None)),
        ),
        (
            "RowRuntimeFalseOverPaths",
            shadow(None, leaves(None, Some(MismatchDiff::Paths))),
            Some(json!({"shadow": {"logMismatches": false}})),
            None,
        ),
        (
            "RowRuntimeTrueOverValueFalse",
            shadow(None, leaves(Some(false), None)),
            Some(json!({"shadow": {"logMismatches": true}})),
            Some((
                paths(MismatchDiff::Values, Some(DIFF_JSON)),
                values(Some(CACHED_JSON), Some(SOURCE_JSON)),
            )),
        ),
    ] {
        let recorder = confirmed(name, policy, overlay);
        assert_eq!(recorder.config_resolutions(), 0, "{name}");
        match expected {
            None => {
                assert!(recorder.warnings().is_empty(), "{name}");
                assert!(recorder.logging_outcomes().is_empty(), "{name}");
            }
            Some((diff, values)) => assert_warning(&recorder, name, diff, values, None),
        }
    }
}

#[test]
fn the_disabled_overlay_turns_off_every_inherited_mismatch_logging_leaf() {
    let all_on = shadow(Some(true), leaves(Some(true), Some(MismatchDiff::Values)));
    let disabled = RuntimePolicy::from(Policy::disabled()).0;
    let recorder = Arc::new(Recorder::default());
    let served = run(
        &recorder,
        Some(disabled.clone()),
        operation("DisabledOverlay", all_on.clone()),
        record(2),
    );
    assert_eq!(*served, record(2));
    assert!(recorder.verdicts().is_empty());
    assert!(recorder.warnings().is_empty());

    // With only the shadow ramp restored, the verdict runs, but the overlay's
    // leaves replace both inherited ones.
    let mut overlay = disabled;
    overlay["shadow"]["ramp"] = json!(100);
    overlay["ramp"] = json!({});
    let recorder = confirmed("DisabledLeaves", all_on, Some(overlay));
    assert!(recorder.warnings().is_empty());
    assert!(recorder.logging_outcomes().is_empty());
    assert_eq!(recorder.config_resolutions(), 0);
}

type Gate = Arc<Mutex<Option<oneshot::Receiver<()>>>>;

/// A source whose first call waits for the gate, holding its shadow job.
fn gated_source(
    gate: Gate,
) -> impl Fn(dialcache::Scope) -> Pin<Box<dyn Future<Output = Result<Record, BoxError>> + Send>>
       + Send
       + Sync
       + 'static {
    move |_| {
        let held = gate.lock().take();
        Box::pin(async move {
            if let Some(held) = held {
                let _ = held.await;
            }
            Ok(record(2))
        })
    }
}

#[test]
fn an_admitted_job_records_one_config_resolution_and_a_dropped_job_none() {
    let recorder = Arc::new(Recorder::default());
    let mut executor = TestExecutor::new(WALL_EPOCH_MS);
    let cache = cache(
        &executor,
        &recorder,
        Some(json!({"shadow": {
            "logMismatches": 0,
            "mismatchLogging": {"value": "yes", "diff": "everything"},
        }})),
    );
    let (release, held) = oneshot::channel();
    let gate: Gate = Arc::new(Mutex::new(Some(held)));
    for _ in 0..2 {
        let cache = cache.clone();
        let source = gated_source(gate.clone());
        executor.block_on(async move {
            let request = cache.enable_guard();
            let operation = operation("ConfigResolutionCount", shadow(Some(true), None));
            cache
                .get_or_load(request.scope(), operation, source)
                .await
                .unwrap();
        });
        executor.drain();
    }
    // The first job holds the only slot, so the second is dropped before admission.
    assert_eq!(recorder.verdicts(), vec![ShadowOutcome::Dropped]);
    assert_eq!(recorder.config_resolutions(), 1);
    release.send(()).unwrap();
    executor.drain();
    assert_eq!(
        recorder.verdicts(),
        vec![ShadowOutcome::Dropped, ShadowOutcome::Mismatch]
    );
    assert_eq!(recorder.config_resolutions(), 1);
    assert!(recorder.warnings().is_empty());
}
