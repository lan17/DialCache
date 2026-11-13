#[cfg(not(panic = "unwind"))]
compile_error!("The panic-containment check requires unwinding");

use std::fmt::Debug;
use std::future::ready;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use dialcache::observe::{ShadowMismatchLoggingOutcome, ShadowOutcome};
use dialcache::preview::{
    SHADOW_LOG_DIFF_MAX_BYTES, SHADOW_LOG_TRUNCATION_MARKER, SHADOW_LOG_VALUE_MAX_BYTES,
    SHADOW_MISMATCH_MAX_ENTRIES,
};
use dialcache::{
    BoxError, Clock, DialCache, Event, Frame, Identity, InvalidateRequest, LogEvent, Logger,
    MismatchDiff, MismatchLogging, Observer, Operation, Payload, Policy, ReadContext, ReadRequest,
    ReadResult, Remote, ShadowMismatchDetails, ShadowPolicy, SourceBudget, SystemClock,
    WriteRequest,
};
use futures::future::BoxFuture;
use serde::de::DeserializeOwned;
use serde::ser::{Error, SerializeSeq};
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{json, Value};
use tokio::sync::oneshot;

struct Snapshot(Frame);

impl Remote for Snapshot {
    fn read(&self, _: ReadRequest, _: ReadContext) -> BoxFuture<'_, Result<ReadResult, BoxError>> {
        Box::pin(ready(Ok(ReadResult::Hit(self.0.clone()))))
    }

    fn write(&self, _: WriteRequest) -> BoxFuture<'_, Result<(), BoxError>> {
        Box::pin(ready(Ok(())))
    }

    fn invalidate(&self, _: InvalidateRequest) -> BoxFuture<'_, Result<(), BoxError>> {
        Box::pin(ready(Ok(())))
    }
}

struct Recorder {
    warning: Mutex<Option<ShadowMismatchDetails>>,
    verdicts: Mutex<Vec<ShadowOutcome>>,
    completion: Mutex<Option<oneshot::Sender<ShadowMismatchLoggingOutcome>>>,
    logger_panics: bool,
}

impl Observer for Recorder {
    fn observe(&self, event: &Event) {
        match event {
            Event::ShadowValidation { outcome, .. } => {
                self.verdicts.lock().unwrap().push(*outcome);
            }
            Event::ShadowMismatchLogging { outcome, .. } => {
                if let Some(completion) = self.completion.lock().unwrap().take() {
                    let _ = completion.send(*outcome);
                }
            }
            _ => {}
        }
    }

    fn observes_shadow_outcomes(&self) -> bool {
        true
    }
}

impl Logger for Recorder {
    fn log(&self, event: &LogEvent) {
        if let LogEvent::ShadowMismatch(details) = event {
            *self.warning.lock().unwrap() = Some(details.clone());
            assert!(!self.logger_panics, "synthetic logger panic");
        }
    }
}

fn operation<T>(diff: MismatchDiff) -> Operation<T>
where
    T: Serialize + DeserializeOwned + PartialEq + Send + Sync + 'static,
{
    Operation::new(Identity::new("record", 1, "production_renderer"))
        .policy(Policy::default().remote_ttl_sec(60).shadow(ShadowPolicy {
            ramp: Some(100.0),
            mismatch_logging: Some(MismatchLogging {
                value: Some(true),
                diff: Some(diff),
            }),
            ..ShadowPolicy::default()
        }))
        .budget(SourceBudget::Millis(5_000))
}

async fn mismatch<T>(
    operation: Operation<T>,
    cached: T,
    source: T,
    logger_panics: bool,
) -> (ShadowMismatchDetails, ShadowMismatchLoggingOutcome)
where
    T: Clone + Debug + PartialEq + Serialize + Send + Sync + 'static,
{
    let (completion, completed) = oneshot::channel();
    let recorder = Arc::new(Recorder {
        warning: Mutex::new(None),
        verdicts: Mutex::new(Vec::new()),
        completion: Mutex::new(Some(completion)),
        logger_panics,
    });
    let clock = SystemClock::new();
    let frame = Frame {
        created_at_ms: clock.wall_ms() as u64 - 1_000,
        payload: Payload::text(serde_json::to_string(&cached).unwrap()),
    };
    let cache = DialCache::builder()
        .clock(clock)
        .remote(Snapshot(frame))
        .observer_arc(recorder.clone())
        .logger_arc(recorder.clone())
        .build()
        .unwrap();
    let request = cache.enable_guard();
    let served = cache
        .get_or_load(request.scope(), operation, move |_| {
            let source = source.clone();
            async move { Ok(source) }
        })
        .await
        .unwrap();
    assert_eq!(*served, cached);
    let outcome = tokio::time::timeout(Duration::from_secs(5), completed)
        .await
        .expect("shadow logging must settle")
        .expect("shadow logging must report its outcome");
    assert_eq!(
        *recorder.verdicts.lock().unwrap(),
        [ShadowOutcome::Mismatch]
    );
    let warning = recorder.warning.lock().unwrap().take().unwrap();
    (warning, outcome)
}

// This name has special meaning only under test-util. A normal application
// must serialize the unit struct as null, not as an absent value.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename = "$dialcache::testing::Absent")]
struct Unit;

#[derive(Clone, Copy, Debug, PartialEq)]
enum Failure {
    Error,
    Panic,
}

#[derive(Clone, Debug, PartialEq)]
struct Fallible {
    value: Value,
    failure: Option<Failure>,
}

impl Serialize for Fallible {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let Some(failure) = self.failure else {
            return self.value.serialize(serializer);
        };
        let mut sequence = serializer.serialize_seq(None)?;
        sequence.serialize_element(&"é".repeat(6_000))?;
        match failure {
            Failure::Error => Err(S::Error::custom("synthetic error after the logged prefix")),
            Failure::Panic => panic!("synthetic panic after the logged prefix"),
        }
    }
}

impl<'de> Deserialize<'de> for Fallible {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Ok(Self {
            value: Value::deserialize(deserializer)?,
            failure: None,
        })
    }
}

async fn check() {
    let mut unit = operation(MismatchDiff::Values);
    unit.comparator = Arc::new(|_, _| false);
    let (warning, outcome) = mismatch(unit, Unit, Unit, false).await;
    assert_eq!(outcome, ShadowMismatchLoggingOutcome::Logged);
    let values = warning.values.unwrap();
    assert_eq!(values.cached_value_json.as_deref(), Some("null"));
    assert_eq!(values.source_value_json.as_deref(), Some("null"));
    assert_eq!(warning.diff.unwrap().diff_json.as_deref(), Some("[]"));
    println!("PASS shipped JSON renderer without the test-only absent adapter");

    let cached =
        json!({"a/b~": "quote\" slash\\ newline\n tab\t nul\u{0} é😀", "items": [null, 1]});
    let source = json!({"a/b~": "other\"\\\n\t\u{0}😀", "items": [null, 2]});
    let (warning, outcome) = mismatch(
        operation(MismatchDiff::Values),
        cached.clone(),
        source.clone(),
        false,
    )
    .await;
    assert_eq!(outcome, ShadowMismatchLoggingOutcome::Logged);
    assert_eq!(warning.logging_outcome, None);
    let values = warning.values.unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(&values.cached_value_json.unwrap()).unwrap(),
        cached
    );
    assert_eq!(
        serde_json::from_str::<Value>(&values.source_value_json.unwrap()).unwrap(),
        source
    );
    let diff = warning.diff.unwrap();
    assert_eq!(diff.mismatch_paths.unwrap(), ["/a~1b~0", "/items/1"]);
    assert_eq!(diff.mismatch_path_count, Some(2));
    assert_eq!(
        serde_json::from_str::<Value>(&diff.diff_json.unwrap()).unwrap(),
        json!([
            {"path": "/a~1b~0", "cached": cached["a/b~"], "source": source["a/b~"]},
            {"path": "/items/1", "cached": 1, "source": 2}
        ])
    );
    println!("PASS valid JSON, escaped content and JSON Pointer paths");

    let cached = json!("é😀".repeat(4_000));
    let source = json!("😀é".repeat(4_000));
    let (warning, outcome) = mismatch(
        operation(MismatchDiff::Off),
        cached.clone(),
        source.clone(),
        false,
    )
    .await;
    assert_eq!(outcome, ShadowMismatchLoggingOutcome::Logged);
    assert!(warning.diff.is_none());
    let values = warning.values.unwrap();
    for (text, value) in [
        (values.cached_value_json.unwrap(), cached),
        (values.source_value_json.unwrap(), source),
    ] {
        assert!(text.len() <= SHADOW_LOG_VALUE_MAX_BYTES);
        let prefix = text.strip_suffix(SHADOW_LOG_TRUNCATION_MARKER).unwrap();
        assert!(serde_json::to_string(&value).unwrap().starts_with(prefix));
        assert!(text.len() > SHADOW_LOG_VALUE_MAX_BYTES - 4);
    }
    println!("PASS streamed value-only UTF-8 truncation");

    let fields = |value: &str| -> Value {
        (0..80)
            .map(|index| (format!("field_{index:02}"), json!(value.repeat(200))))
            .collect::<serde_json::Map<_, _>>()
            .into()
    };
    let (warning, outcome) = mismatch(
        operation(MismatchDiff::Values),
        fields("é"),
        fields("😀"),
        false,
    )
    .await;
    assert_eq!(outcome, ShadowMismatchLoggingOutcome::Logged);
    let diff = warning.diff.unwrap();
    assert_eq!(
        diff.mismatch_paths.unwrap().len(),
        SHADOW_MISMATCH_MAX_ENTRIES
    );
    assert_eq!(diff.mismatch_path_count, Some(80));
    let text = diff.diff_json.unwrap();
    assert!(text.len() <= SHADOW_LOG_DIFF_MAX_BYTES);
    assert!(text.ends_with(SHADOW_LOG_TRUNCATION_MARKER));
    let values = warning.values.unwrap();
    for text in [
        values.cached_value_json.unwrap(),
        values.source_value_json.unwrap(),
    ] {
        assert!(text.len() <= SHADOW_LOG_VALUE_MAX_BYTES);
        assert!(text.ends_with(SHADOW_LOG_TRUNCATION_MARKER));
    }
    println!("PASS full-render value, diff and entry caps");

    for diff in [MismatchDiff::Off, MismatchDiff::Values] {
        for failure in [Failure::Error, Failure::Panic] {
            let (warning, outcome) = mismatch(
                operation(diff),
                Fallible {
                    value: json!({"version": 1}),
                    failure: None,
                },
                Fallible {
                    value: json!({"version": 2}),
                    failure: Some(failure),
                },
                false,
            )
            .await;
            assert_eq!(outcome, ShadowMismatchLoggingOutcome::RenderError);
            assert_eq!(warning.logging_outcome, Some(outcome));
            let values = warning.values.unwrap();
            assert_eq!(values.cached_value_json.as_deref(), Some("{\"version\":1}"));
            assert!(values.source_value_json.is_none());
            if diff == MismatchDiff::Off {
                assert!(warning.diff.is_none());
            } else {
                let diff = warning.diff.expect("requested difference fields");
                assert!(diff.mismatch_paths.is_none());
                assert!(diff.mismatch_path_count.is_none());
                assert!(diff.diff_json.is_none());
            }
            println!("PASS {diff:?} rendering contains late serialization {failure:?}");
        }
    }

    let op = operation(MismatchDiff::Values)
        .mismatch_diff(|_, _| panic!("synthetic mismatch hook panic"));
    let (warning, outcome) = mismatch(op, json!(1), json!(2), false).await;
    assert_eq!(outcome, ShadowMismatchLoggingOutcome::HookError);
    assert_eq!(warning.logging_outcome, Some(outcome));
    assert!(warning.diff.unwrap().diff_json.is_none());
    println!("PASS mismatch hook panic containment");

    let (warning, outcome) =
        mismatch(operation(MismatchDiff::Values), json!(1), json!(2), true).await;
    assert_eq!(outcome, ShadowMismatchLoggingOutcome::LoggerError);
    assert_eq!(warning.logging_outcome, None);
    assert_eq!(
        warning.values.unwrap().source_value_json.as_deref(),
        Some("2")
    );
    println!("PASS logger panic containment");
}

#[tokio::main(flavor = "current_thread")]
async fn main() {
    tokio::time::timeout(Duration::from_secs(30), check())
        .await
        .expect("production consumer checks must finish");
}
