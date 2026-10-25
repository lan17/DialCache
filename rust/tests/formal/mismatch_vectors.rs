//! Runner for the `mismatchPathVectors` group (W10): the built-in walk over
//! two JSON values, and the difference fields a confirmed-mismatch warning
//! builds from the same pair at each `diff` level. Mirrors the TypeScript
//! `computes mismatch paths:` tests.
//!
//! An omitted `cached` or `source` member is an absent side (D13), which only
//! the test-only [`dialcache::testing::Absent`] marker expresses in Rust;
//! every other value is parsed JSON. Entries compare as parsed JSON, so each
//! side's rendering text stays native. The walk runs through
//! [`diff_shadow_mismatch_json`]. The warning fields come from a real
//! served-hit shadow job whose comparator always reports a mismatch, so every
//! vector reaches a warning that carries exactly its two values.
//!
//! Include from a test binary alongside `fixtures.rs`:
//! `#[path = "formal/fixtures.rs"] mod fixtures;`
//! `#[path = "formal/mismatch_vectors.rs"] mod mismatch_vectors;`

#![allow(dead_code)]

use std::future::ready;
use std::sync::Arc;

use dialcache::observe::{Event, LogEvent, Logger, Observer, ShadowMismatchLoggingOutcome};
use dialcache::protocol::diff_shadow_mismatch_json;
use dialcache::testing::{TestExecutor, WALL_EPOCH_MS};
use dialcache::{
    BoxError, DialCache, Frame, FromSync, Identity, InvalidateRequest, MismatchDiff,
    MismatchLogging, Operation, Payload, Policy, ReadContext, ReadRequest, ReadResult, Remote,
    ShadowMismatchDetails, ShadowMismatchDiffDetails, ShadowPolicy, SyncCodec, WriteRequest,
};
use futures::future::BoxFuture;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize, Serializer};
use serde_json::Value;

use super::fixtures::assertion_mismatch;

/// The payload the codec stores for an absent value.
const ABSENT_PAYLOAD: &str = "undefined";

/// One compared side: parsed JSON, or absent.
#[derive(Debug, Clone, PartialEq)]
enum Side {
    Absent,
    Json(Value),
}

impl Serialize for Side {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        match self {
            Side::Absent => dialcache::testing::Absent.serialize(serializer),
            Side::Json(value) => value.serialize(serializer),
        }
    }
}

impl<'de> Deserialize<'de> for Side {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        Value::deserialize(deserializer).map(Side::Json)
    }
}

struct SideCodec;

impl SyncCodec<Side> for SideCodec {
    fn encode(&self, value: &Side) -> Result<Payload, BoxError> {
        Ok(match value {
            Side::Absent => Payload::text(ABSENT_PAYLOAD),
            Side::Json(value) => Payload::text(serde_json::to_string(value)?),
        })
    }

    fn decode(&self, payload: Payload) -> Result<Side, BoxError> {
        if payload.as_text() == ABSENT_PAYLOAD {
            return Ok(Side::Absent);
        }
        Ok(Side::Json(serde_json::from_slice(&payload.bytes)?))
    }
}

/// Serves the cached side on every read, the confirmation read included.
struct CachedSide(Payload);

impl Remote for CachedSide {
    fn read(&self, _: ReadRequest, _: ReadContext) -> BoxFuture<'_, Result<ReadResult, BoxError>> {
        Box::pin(ready(Ok(ReadResult::Hit(Frame {
            created_at_ms: WALL_EPOCH_MS as u64,
            payload: self.0.clone(),
        }))))
    }

    fn write(&self, _: WriteRequest) -> BoxFuture<'_, Result<(), BoxError>> {
        Box::pin(ready(Ok(())))
    }

    fn invalidate(&self, _: InvalidateRequest) -> BoxFuture<'_, Result<(), BoxError>> {
        Box::pin(ready(Ok(())))
    }
}

#[derive(Default)]
struct Recorded {
    warnings: Mutex<Vec<ShadowMismatchDetails>>,
    outcomes: Mutex<Vec<ShadowMismatchLoggingOutcome>>,
}

struct Recorder(Arc<Recorded>);

impl Observer for Recorder {
    fn observe(&self, event: &Event) {
        if let Event::ShadowMismatchLogging { outcome, .. } = event {
            self.0.outcomes.lock().push(*outcome);
        }
    }

    fn observes_shadow_outcomes(&self) -> bool {
        true
    }
}

impl Logger for Recorder {
    fn log(&self, event: &LogEvent) {
        if let LogEvent::ShadowMismatch(details) = event {
            self.0.warnings.lock().push(details.clone());
        }
    }
}

/// The side a vector member names: absent when omitted.
fn side(vector: &Value, name: &str) -> Side {
    vector.get(name).cloned().map_or(Side::Absent, Side::Json)
}

/// Parsed-JSON equality: numbers by value, everything else structurally.
fn same_json(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(x), Value::Number(y)) => x.as_f64() == y.as_f64(),
        (Value::Array(x), Value::Array(y)) => {
            x.len() == y.len() && x.iter().zip(y).all(|(a, b)| same_json(a, b))
        }
        (Value::Object(x), Value::Object(y)) => {
            x.len() == y.len()
                && x.iter()
                    .all(|(name, a)| y.get(name).is_some_and(|b| same_json(a, b)))
        }
        _ => a == b,
    }
}

/// The warnings and logging outcomes of one served-hit call whose shadow job
/// confirms a mismatch between the two sides, logging at `level` with
/// `value` off.
fn warn_once(
    cached: &Side,
    source: Side,
    level: MismatchDiff,
) -> Result<
    (
        Vec<ShadowMismatchDetails>,
        Vec<ShadowMismatchLoggingOutcome>,
    ),
    String,
> {
    let payload = SideCodec
        .encode(cached)
        .map_err(|error| format!("cached side does not encode: {error}"))?;
    let recorded = Arc::new(Recorded::default());
    let mut executor = TestExecutor::new(WALL_EPOCH_MS);
    let cache = DialCache::builder()
        .clock_arc(executor.clock.clone())
        .runtime_arc(executor.runtime.clone())
        .remote(CachedSide(payload))
        .observer(Recorder(recorded.clone()))
        .logger(Recorder(recorded.clone()))
        .build()
        .map_err(|error| format!("cache does not build: {error}"))?;
    let policy = Policy::default().remote_ttl_sec(60).shadow(ShadowPolicy {
        ramp: Some(100.0),
        log_mismatches: None,
        mismatch_logging: Some(MismatchLogging {
            value: Some(false),
            diff: Some(level),
        }),
    });
    let mut operation =
        Operation::<Side>::new(Identity::new("vector", "1", "MismatchPathVector")).policy(policy);
    // The JSON rendering stays when the codec and comparator are replaced.
    operation.codec = Arc::new(FromSync(SideCodec));
    operation.comparator = Arc::new(|_: &Side, _: &Side| false);
    let served = executor.block_on(async move {
        let request = cache.enable_guard();
        cache
            .get_or_load(request.scope(), operation, move |_| {
                ready(Ok(source.clone()))
            })
            .await
    });
    executor.drain();
    if let Err(error) = served {
        return Err(assertion_mismatch(
            "the cached side served",
            error.to_string(),
        ));
    }
    let warnings = recorded.warnings.lock().clone();
    let outcomes = recorded.outcomes.lock().clone();
    Ok((warnings, outcomes))
}

/// `mismatchPathVectors`: the walk returns `entries` and `count` when both
/// sides are present, and a warning at `diff: "values"` and at
/// `diff: "paths"` carries the entries' paths, the count and, at `values`,
/// the entries, all without a failure.
pub fn check_mismatch_path_vector(vector: &Value) -> Result<(), String> {
    let entries = vector
        .get("entries")
        .and_then(Value::as_array)
        .ok_or("entries is not an array")?;
    let count = vector
        .get("count")
        .and_then(Value::as_u64)
        .ok_or("count is not an unsigned integer")?;
    let paths = entries
        .iter()
        .map(|entry| {
            entry
                .get("path")
                .and_then(Value::as_str)
                .map(str::to_owned)
                .ok_or_else(|| format!("entry without a string path: {entry}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let (cached, source) = (side(vector, "cached"), side(vector, "source"));
    let expected_entries = Value::Array(entries.clone());

    if let (Side::Json(cached), Side::Json(source)) = (&cached, &source) {
        let diff = diff_shadow_mismatch_json(cached, source);
        let actual = serde_json::to_value(&diff.entries).map_err(|error| error.to_string())?;
        if !same_json(&actual, &expected_entries) || diff.count != count {
            return Err(assertion_mismatch(
                (&expected_entries, count),
                (&actual, diff.count),
            ));
        }
    }

    for level in [MismatchDiff::Values, MismatchDiff::Paths] {
        let (warnings, outcomes) = warn_once(&cached, source.clone(), level)?;
        if outcomes != [ShadowMismatchLoggingOutcome::Logged] {
            return Err(assertion_mismatch(
                (level, [ShadowMismatchLoggingOutcome::Logged]),
                (level, outcomes),
            ));
        }
        let [warning] = &warnings[..] else {
            return Err(assertion_mismatch(
                (level, "one warning"),
                (level, warnings),
            ));
        };
        let Some(diff) = &warning.diff else {
            return Err(assertion_mismatch(
                (level, "difference fields"),
                (level, warning),
            ));
        };
        // At `values` the logged entries must parse to the vector's entries;
        // at `paths` no entries are logged.
        let entries_match = match (&diff.diff_json, level) {
            (Some(text), MismatchDiff::Values) => serde_json::from_str::<Value>(text)
                .is_ok_and(|logged| same_json(&logged, &expected_entries)),
            (None, MismatchDiff::Paths) => true,
            _ => false,
        };
        let expected = ShadowMismatchDiffDetails {
            level,
            mismatch_paths: Some(paths.clone()),
            mismatch_path_count: Some(count),
            diff_json: diff.diff_json.clone(),
        };
        if !entries_match
            || diff != &expected
            || warning.values.is_some()
            || warning.logging_outcome.is_some()
        {
            let expected_entries = (level == MismatchDiff::Values).then_some(&expected_entries);
            return Err(assertion_mismatch(
                (level, &paths, count, expected_entries),
                (
                    level,
                    &diff.mismatch_paths,
                    diff.mismatch_path_count,
                    &diff.diff_json,
                    &warning.values,
                    warning.logging_outcome,
                ),
            ));
        }
    }
    Ok(())
}
