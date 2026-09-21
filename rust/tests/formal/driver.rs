//! The behavior driver: executes the shared replay commands against the real
//! Rust cache under the deterministic test executor. It controls external
//! effects only (sources, codecs, the fake remote, policy replies, clocks,
//! faults) and reports actual observations; no expected state enters it.

use std::collections::HashMap;
use std::fmt;
use std::sync::Arc;

use dialcache::observe::{Event, LogEvent, Logger, Observer};
use dialcache::protocol::{decode_frame, encode_frame, read_result_from_untrusted_json};
use dialcache::testing::{TestExecutor, VirtualClock};
use dialcache::{
    BoxError, Codec, DialCache, Error, FallbackTimeout, Identity, InvalidateRequest, LocalEntry,
    LocalRead, LocalStore, LruLocalStore, Operation, Payload, Policy, ReadContext, ReadRequest,
    ReadResult, Remote, RuntimePolicy, Scope, SourceBudget, WriteRequest,
};
use futures::future::BoxFuture;
use parking_lot::Mutex;
use serde_json::{json, Map, Value};

use super::causal::{
    assert_publication_causality, current_invocation, property_failure, CausalEvent,
    InvocationFuture, InvocationRuntime,
};
use super::gate::Gate;
use super::json::json_equal;

/// Epoch of every controlled history: 2026-09-08T12:00:00.000Z.
pub const WALL_EPOCH_MS: i64 = 1_788_868_800_000;

/// Panic payload of every controlled callback failure; the harness panic hook
/// keeps it out of the test output.
pub struct ControlledFailure;

pub fn controlled_panic() -> ! {
    std::panic::panic_any(ControlledFailure)
}

/// Install a panic hook that stays silent for controlled failures.
pub fn install_panic_hook() {
    let default = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if info.payload().downcast_ref::<ControlledFailure>().is_none() {
            default(info);
        }
    }));
}

type ComparatorFn = Box<dyn Fn(&Val, &Val) -> bool + Send + Sync>;

/// The N-th controlled source failure.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("source failure {0}")]
pub struct SourceFailure(pub usize);

/// The controlled mutation failure returned by the fake remote.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("controlled mutation failure")]
pub struct MaintenanceFailure;

/// The cached value domain of the histories: JSON primitives plus absence.
#[derive(Debug, Clone)]
pub enum Val {
    Absent,
    Json(Value),
}

impl Val {
    fn from_json(value: Value) -> Val {
        Val::Json(value)
    }

    /// The observation encoding: `{absent:true}` for absence, else the primitive.
    pub fn observed(&self) -> Value {
        match self {
            Val::Absent => json!({ "absent": true }),
            Val::Json(value) => value.clone(),
        }
    }

    pub fn json_preview(&self) -> Option<String> {
        match self {
            Val::Absent => None,
            Val::Json(value) => serde_json::to_string(value).ok(),
        }
    }
}

impl PartialEq for Val {
    fn eq(&self, other: &Val) -> bool {
        match (self, other) {
            (Val::Absent, Val::Absent) => true,
            (Val::Json(a), Val::Json(b)) => json_equal(a, b),
            _ => false,
        }
    }
}

#[derive(Clone)]
enum LoaderOutcome {
    Value(Val),
    Fail(usize),
    Timeout(usize),
}

struct Stored {
    raw: Vec<u8>,
    expires: i64,
}

#[derive(Clone, Debug)]
pub struct HistoryEvent {
    pub event: &'static str,
    pub id: usize,
    pub at: i64,
    pub outcome: &'static str,
    pub duration_ms: f64,
    pub failed: bool,
}

pub struct Shared {
    fixture: Value,
    observed: Map<String, Value>,
    loaders: Vec<Gate<LoaderOutcome>>,
    timeout_errors: Vec<Error>,
    faults: HashMap<String, bool>,
    runtime_policy: Value,
    values: HashMap<String, Stored>,
    reply: Option<Value>,
    effects: HashMap<String, HashMap<usize, Gate<Result<(), String>>>>,
    history: Vec<HistoryEvent>,
    causal_history: Vec<CausalEvent>,
    source_by_invocation: HashMap<usize, usize>,
    fallback_failed: bool,
    pub discard_writes: bool,
    pub discard_invalidations: bool,
}

impl Shared {
    fn increment(&mut self, field: &str) -> usize {
        let current = self
            .observed
            .get(field)
            .and_then(Value::as_u64)
            .unwrap_or(0);
        self.observed
            .insert(field.to_string(), Value::from(current + 1));
        current as usize
    }

    fn push(&mut self, field: &str, value: Value) {
        if let Some(Value::Array(items)) = self.observed.get_mut(field) {
            items.push(value);
        }
    }

    fn fault(&self, name: &str) -> bool {
        self.faults.get(name).copied().unwrap_or(false)
    }

    fn observes(&self, kind: &str) -> bool {
        self.fixture
            .get("observe")
            .and_then(Value::as_array)
            .is_some_and(|kinds| kinds.iter().any(|k| k.as_str() == Some(kind)))
    }

    fn record(&mut self, kind: &str, fields: Map<String, Value>) {
        if !self.observes(kind) {
            return;
        }
        let mut event = Map::new();
        event.insert("event".to_string(), Value::from(kind));
        for (k, v) in fields {
            event.insert(k, v);
        }
        self.push("events", Value::Object(event));
    }

    fn observer_fails(&self) -> bool {
        self.fixture.get("observerFailure") == Some(&Value::Bool(true)) || self.fault("observer")
    }

    fn raw(&mut self, key: &str, elapsed_ms: i64) -> Option<Vec<u8>> {
        let expired = self.values.get(key)?.expires <= elapsed_ms;
        if expired {
            self.values.remove(key);
            return None;
        }
        self.values.get(key).map(|item| item.raw.clone())
    }

    fn timeout_index(&mut self, error: &Error) -> usize {
        let ptr = |error: &Error| -> usize {
            match error {
                Error::FallbackTimeout(arc) => Arc::as_ptr(arc) as *const () as usize,
                Error::Source(arc) => Arc::as_ptr(arc) as *const () as usize,
                _ => 0,
            }
        };
        let wanted = ptr(error);
        if let Some(index) = self.timeout_errors.iter().position(|e| ptr(e) == wanted) {
            return index;
        }
        self.timeout_errors.push(error.clone());
        self.timeout_errors.len() - 1
    }

    fn classify_error(&mut self, error: &Error) -> String {
        match error {
            Error::Source(source) => {
                if let Some(SourceFailure(id)) = source.downcast_ref::<SourceFailure>() {
                    format!("source:{id}")
                } else if let Some(timeout) = source.downcast_ref::<FallbackTimeout>() {
                    // The source returned a deadline error of its own (a nested call's);
                    // it is that loader's failure, not this call's deadline.
                    match timeout.use_case.strip_prefix("NestedSource:") {
                        Some(id) => format!("source:{id}"),
                        None => format!("timeout:{}", self.timeout_index(error)),
                    }
                } else {
                    format!("unexpected:{error}")
                }
            }
            Error::FallbackTimeout(_) => format!("timeout:{}", self.timeout_index(error)),
            other => format!("unexpected:{other}"),
        }
    }
}

/// The empty observation record for a fixture: `events` only when it observes.
pub fn empty_observation(fixture: &Value) -> Map<String, Value> {
    let mut o = Map::new();
    if fixture.get("observe").is_some() {
        o.insert("events".to_string(), json!([]));
    }
    o.insert("calls".to_string(), json!([]));
    for key in [
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
        o.insert(key.to_string(), json!(0));
    }
    for key in [
        "maintenance",
        "sourceScopes",
        "writeTtls",
        "shadow",
        "recovery",
    ] {
        o.insert(key.to_string(), json!([]));
    }
    o
}

struct ScopeHandle {
    instance: String,
    scope: Arc<Mutex<Option<Scope>>>,
    gate: Gate<()>,
    done: Gate<()>,
}

/// One history's driver.
pub struct Driver {
    pub exec: TestExecutor,
    shared: Arc<Mutex<Shared>>,
    clock: Arc<VirtualClock>,
    fixture: Value,
    instances: HashMap<String, DialCache>,
    scopes: HashMap<String, ScopeHandle>,
    reported: Value,
    settlement_receipt: Value,
    reported_wall_ms: i64,
    /// Harness control only: skip the first settlement drain and let the
    /// verification drain attest to the work it finds still runnable.
    pub skip_settle: bool,
}

impl fmt::Debug for Driver {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Driver")
            .field("instances", &self.instances.len())
            .finish()
    }
}

fn number(value: Option<&Value>) -> i64 {
    match value {
        Some(Value::Number(n)) => n
            .as_i64()
            .or_else(|| n.as_f64().map(|f| f as i64))
            .unwrap_or(0),
        _ => 0,
    }
}

fn text(value: Option<&Value>) -> String {
    value.and_then(Value::as_str).unwrap_or("").to_string()
}

fn shared_labels(shared: &Shared) -> Map<String, Value> {
    let _ = shared;
    Map::new()
}

impl Driver {
    pub fn new(fixture: Value) -> Driver {
        let exec = TestExecutor::new(WALL_EPOCH_MS);
        let clock = exec.clock.clone();
        let shared = Shared {
            observed: empty_observation(&fixture),
            fixture: fixture.clone(),
            loaders: Vec::new(),
            timeout_errors: Vec::new(),
            faults: HashMap::new(),
            runtime_policy: json!({}),
            values: HashMap::new(),
            reply: None,
            effects: HashMap::new(),
            history: Vec::new(),
            causal_history: Vec::new(),
            source_by_invocation: HashMap::new(),
            fallback_failed: false,
            discard_writes: false,
            discard_invalidations: false,
        };
        let mut driver = Driver {
            exec,
            shared: Arc::new(Mutex::new(shared)),
            clock,
            fixture,
            instances: HashMap::new(),
            scopes: HashMap::new(),
            reported: Value::Null,
            settlement_receipt: Value::Null,
            reported_wall_ms: WALL_EPOCH_MS,
            skip_settle: false,
        };
        driver.instance("default");
        driver.settle();
        driver
    }

    pub fn shared(&self) -> &Arc<Mutex<Shared>> {
        &self.shared
    }

    pub fn wall_ms(&self) -> i64 {
        use dialcache::Clock;
        self.clock.wall_ms()
    }

    fn elapsed_ms(&self) -> i64 {
        use dialcache::Clock;
        self.clock.elapsed_ms()
    }

    fn identity(&self, key: &str, use_case: &str) -> Identity {
        let key = if key.is_empty() { "1" } else { key };
        let use_case = if use_case.is_empty() {
            "Behavior"
        } else {
            use_case
        };
        Identity::new("id", key, use_case)
            .namespace("urn")
            .tracked(self.fixture.get("tracked") == Some(&Value::Bool(true)))
    }

    fn classifier(&self, mode: &str) -> impl Fn(&Error) -> bool + Send + Sync + 'static {
        let shared = self.shared.clone();
        let mode = mode.to_string();
        move |_error: &Error| {
            shared.lock().increment("classifications");
            if mode == "error" {
                controlled_panic();
            }
            mode == "allow"
        }
    }

    fn instance(&mut self, id: &str) -> DialCache {
        if let Some(cache) = self.instances.get(id) {
            return cache.clone();
        }
        let fixture = &self.fixture;
        let shared = self.shared.clone();
        let clock = self.clock.clone();
        let capacity = fixture
            .get("localMaxSize")
            .map(|v| number(Some(v)) as usize)
            .unwrap_or(10_000);
        let mut builder = DialCache::builder()
            .clock_arc(self.clock.clone())
            .runtime(InvocationRuntime(self.exec.runtime.clone()))
            .disable_compression()
            .local_capacity(capacity)
            .shadow_max_in_flight(
                fixture
                    .get("shadowMaxInFlight")
                    .map(|v| number(Some(v)) as usize)
                    .unwrap_or(1),
            )
            .observer_arc(Arc::new(DriverObserver {
                shared: shared.clone(),
                clock: clock.clone(),
                shadow_hook: fixture.get("shadowHook") != Some(&Value::Bool(false)),
            }))
            .logger_arc(Arc::new(DriverLogger {
                shared: shared.clone(),
            }))
            .policy_provider({
                let shared = shared.clone();
                move |_identity: Identity| {
                    let shared = shared.clone();
                    async move {
                        let (index, hold) = {
                            let mut s = shared.lock();
                            let index = s.increment("policyCalls");
                            (index, s.fault("holdPolicies"))
                        };
                        if hold {
                            hold_effect(&shared, "policy", index)
                                .await
                                .map_err(|e| -> BoxError { e.into() })?;
                        }
                        let s = shared.lock();
                        if s.fault("policy") {
                            return Err("controlled policy failure".into());
                        }
                        Ok(Some(RuntimePolicy::from_json(s.runtime_policy.clone())))
                    }
                }
            });
        if fixture.get("remote") != Some(&Value::Bool(false)) {
            builder = builder.remote_arc(Arc::new(DriverRemote {
                shared: shared.clone(),
                clock: clock.clone(),
            }));
        }
        if fixture.get("localFaultInjection") == Some(&Value::Bool(true)) {
            let inner = std::num::NonZeroUsize::new(capacity).map(LruLocalStore::new);
            builder = builder.local_store(Box::new(FaultStore {
                inner,
                shared: shared.clone(),
            }));
        }
        if fixture.get("readTimeoutMs") != Some(&Value::from("default")) {
            builder = builder.remote_read_timeout_ms(
                fixture
                    .get("readTimeoutMs")
                    .map(|v| number(Some(v)) as u64)
                    .unwrap_or(50),
            );
        }
        if let Some(mode) = fixture.get("recovery").and_then(Value::as_str) {
            if mode != "default" {
                builder = builder.should_recover(self.classifier(mode));
            }
        }
        let cache = builder.build().expect("valid fixture configuration");
        self.instances.insert(id.to_string(), cache.clone());
        cache
    }

    fn budget(&self) -> SourceBudget {
        match self.fixture.get("fallbackTimeoutMs") {
            None => SourceBudget::Millis(10),
            Some(Value::Null) => SourceBudget::Unbounded,
            Some(Value::String(s)) if s == "default" => SourceBudget::Default,
            Some(other) => SourceBudget::Millis(number(Some(other)) as u64),
        }
    }

    fn scope_of(&self, id: &str) -> Result<(Scope, String), String> {
        let handle = self
            .scopes
            .get(id)
            .ok_or_else(|| format!("unknown scope {id}"))?;
        let scope = handle
            .scope
            .lock()
            .clone()
            .ok_or_else(|| format!("scope {id} not ready"))?;
        Ok((scope, handle.instance.clone()))
    }

    /// Apply one external command, then settle authorized work.
    pub fn apply(&mut self, input: &Value) -> Result<(), String> {
        let op = text(input.get("op"));
        match op.as_str() {
            "begin" => self.begin(input)?,
            "resolve" | "reject" => {
                let index = number(input.get("loader"));
                let mut s = self.shared.lock();
                if index < 0
                    || index as usize >= s.loaders.len()
                    || s.loaders[index as usize].is_settled()
                {
                    return Err(format!("no unsettled source {index}"));
                }
                let index = index as usize;
                let at = self.elapsed_ms();
                let outcome = if op == "reject" {
                    let gate = s.loaders[index].clone();
                    if input.get("error") == Some(&Value::from("timeout")) {
                        gate.settle(LoaderOutcome::Timeout(index));
                    } else {
                        gate.settle(LoaderOutcome::Fail(index));
                    }
                    "reject"
                } else {
                    let value = match input.get("value") {
                        None => Val::Absent,
                        Some(value) => Val::from_json(value.clone()),
                    };
                    let gate = s.loaders[index].clone();
                    gate.settle(LoaderOutcome::Value(value));
                    "resolve"
                };
                s.causal_history.push(CausalEvent::SourceSettlement {
                    id: index,
                    at_ms: at,
                    outcome,
                });
                s.history.push(HistoryEvent {
                    event: "sourceSettlement",
                    id: index,
                    at,
                    outcome,
                    duration_ms: 0.0,
                    failed: false,
                });
            }
            "advance" => {
                let ms = input.get("ms").and_then(Value::as_f64).unwrap_or(0.0);
                if ms < 0.0 {
                    return Err("negative elapsed advance".to_string());
                }
                let deliver = input.get("deliverTimers") != Some(&Value::Bool(false));
                self.exec.advance(ms as i64, deliver);
            }
            "shiftWall" => self.clock.shift(number(input.get("ms")), true),
            "seed" => {
                let identity = self.identity(&text(input.get("key")), &text(input.get("useCase")));
                let keys = identity.keys().map_err(|e| e.to_string())?;
                let raw = if let Some(frame) = input.get("frameHex").and_then(Value::as_str) {
                    hex::decode(frame).map_err(|e| e.to_string())?
                } else {
                    let mut encoding = 0u8;
                    let payload: Vec<u8> =
                        if let Some(h) = input.get("payloadHex").and_then(Value::as_str) {
                            encoding = 1;
                            hex::decode(h).map_err(|e| e.to_string())?
                        } else if let Some(t) = input.get("payloadText").and_then(Value::as_str) {
                            t.as_bytes().to_vec()
                        } else if let Some(value) = input.get("value") {
                            serde_json::to_vec(value).map_err(|e| e.to_string())?
                        } else {
                            b"undefined".to_vec()
                        };
                    let stamp = (self.wall_ms() - number(input.get("ageMs"))) as u64;
                    let mut raw = Vec::with_capacity(10 + payload.len());
                    raw.push(1);
                    raw.extend_from_slice(&stamp.to_be_bytes());
                    raw.push(encoding);
                    raw.extend_from_slice(&payload);
                    raw
                };
                let ttl = input
                    .get("ttlMs")
                    .map(|v| number(Some(v)))
                    .unwrap_or(60_000);
                let expires = self.elapsed_ms() + ttl;
                self.shared
                    .lock()
                    .values
                    .insert(keys.value, Stored { raw, expires });
            }
            "invalidate" => {
                let cache = self.instance("default");
                let key = text(input.get("key"));
                let key = if key.is_empty() { "1".to_string() } else { key };
                let buffer = number(input.get("futureBufferMs")).max(0) as u64;
                let result = self
                    .exec
                    .block_on(async move { cache.invalidate("id", &key, buffer).await });
                let status = match result {
                    Ok(()) => "ok",
                    Err(Error::Remote(error))
                        if error.downcast_ref::<MaintenanceFailure>().is_some() =>
                    {
                        "mutation_error"
                    }
                    Err(Error::MissingRemote) => "missing_remote",
                    Err(other) => return Err(format!("unexpected invalidation error: {other}")),
                };
                self.shared.lock().push("maintenance", Value::from(status));
            }
            "observeMarker" => {
                let identity = self.identity(&text(input.get("key")), "").tracked(true);
                let keys = identity.keys().map_err(|e| e.to_string())?;
                let watermark = keys.watermark.ok_or("tracked identity without watermark")?;
                let elapsed = self.elapsed_ms();
                let (cutoff, ttl) = {
                    let mut s = self.shared.lock();
                    match s.raw(&watermark, elapsed) {
                        Some(raw) => {
                            let stamp: i64 = String::from_utf8_lossy(&raw)
                                .parse()
                                .map_err(|e| format!("{e}"))?;
                            let ttl = s
                                .values
                                .get(&watermark)
                                .map(|item| item.expires - elapsed)
                                .unwrap_or(-2);
                            (stamp - WALL_EPOCH_MS, ttl)
                        }
                        None => (-1, -2),
                    }
                };
                let mut fields = Map::new();
                fields.insert("cutoffMs".to_string(), Value::from(cutoff));
                fields.insert("ttlMs".to_string(), Value::from(ttl));
                self.shared.lock().record("marker", fields);
            }
            "inspectCoalescing" => {
                let instance = input
                    .get("instance")
                    .and_then(Value::as_str)
                    .unwrap_or("default");
                let state = self.instance(instance).coalescing_state().process;
                let fields = json!({
                    "instance": instance,
                    "activeLeaders": state.active_leaders,
                    "activeFollowers": state.active_followers,
                    "oldestLeaderAgeMs": state.oldest_leader_age_ms,
                });
                self.shared.lock().record(
                    "coalescingState",
                    fields.as_object().expect("fields").clone(),
                );
            }
            "adapterReply" => {
                let mut s = self.shared.lock();
                if s.reply.is_some() {
                    return Err("unconsumed adapter reply".to_string());
                }
                s.reply = Some(input.get("value").cloned().unwrap_or(Value::Null));
            }
            "policy" => {
                self.shared.lock().runtime_policy =
                    input.get("value").cloned().unwrap_or(Value::Null)
            }
            "faults" => {
                let mut s = self.shared.lock();
                if let Some(Value::Object(faults)) = input.get("value") {
                    for (k, v) in faults {
                        s.faults.insert(k.clone(), v.as_bool().unwrap_or(false));
                    }
                }
            }
            "release" => {
                let effect = text(input.get("effect"));
                let index = number(input.get("index")).max(0) as usize;
                let gate = {
                    let mut s = self.shared.lock();
                    s.effects
                        .get_mut(&effect)
                        .and_then(|gates| gates.remove(&index))
                };
                let Some(gate) = gate.filter(|gate| !gate.is_settled()) else {
                    return Err(format!("no pending {effect} {index}"));
                };
                if input.get("fail") == Some(&Value::Bool(true)) {
                    gate.settle(Err(format!("controlled {effect} failure")));
                } else {
                    gate.settle(Ok(()));
                }
            }
            "openScope" => self.open_scope(input)?,
            "closeScope" => {
                let id = text(input.get("id"));
                let handle = self.scopes.get(&id).ok_or("unknown/already closed scope")?;
                if handle.gate.is_settled() {
                    return Err("unknown/already closed scope".to_string());
                }
                handle.gate.settle(());
                let done = handle.done.clone();
                self.exec.drain();
                if !done.is_settled() {
                    return Err(format!("scope {id} did not close"));
                }
            }
            other => return Err(format!("unknown behavior input {other}: {input}")),
        }
        self.settle();
        self.assert_publication_causality()
    }

    /// Attest to a single instant, then verify it with a second zero-time drain.
    /// Counts come from actual executor polls and external gates, never predictions.
    fn settle(&mut self) {
        if !self.skip_settle {
            self.exec.drain();
        }
        let shared = self.shared.lock();
        self.reported = Value::Object(shared.observed.clone());
        let mut held = Map::new();
        held.insert(
            "loaders".to_string(),
            json!(shared
                .loaders
                .iter()
                .filter(|gate| !gate.is_settled())
                .count()),
        );
        for (kind, field) in [
            ("read", "reads"),
            ("write", "writes"),
            ("dump", "dumps"),
            ("load", "loads"),
            ("policy", "policies"),
        ] {
            held.insert(
                field.to_string(),
                json!(shared.effects.get(kind).map_or(0, HashMap::len)),
            );
        }
        held.insert(
            "scopes".to_string(),
            json!(self
                .scopes
                .values()
                .filter(|scope| !scope.gate.is_settled())
                .count()),
        );
        drop(shared);
        let elapsed = self.elapsed_ms();
        self.reported_wall_ms = self.wall_ms();
        let polls = self.exec.poll_count();
        let timers = self.clock.pending_timers();
        self.exec.drain();
        let changed = self.reported != Value::Object(self.shared.lock().observed.clone());
        let runnable = self.exec.poll_count() - polls
            + u64::from(changed)
            + timers.abs_diff(self.clock.pending_timers()) as u64;
        self.settlement_receipt = json!({"elapsedMs": elapsed, "runnable": runnable, "held": held});
    }

    fn begin(&mut self, input: &Value) -> Result<(), String> {
        let index = {
            let mut s = self.shared.lock();
            let index = s
                .observed
                .get("calls")
                .and_then(Value::as_array)
                .map(|c| c.len())
                .unwrap_or(0);
            s.push("calls", json!({ "status": "pending" }));
            index
        };
        let (ctx, instance) = match input.get("scope").and_then(Value::as_str) {
            Some(scope_id) => {
                let (scope, scope_instance) = self.scope_of(scope_id)?;
                let instance = input
                    .get("instance")
                    .and_then(Value::as_str)
                    .map(str::to_string)
                    .unwrap_or(scope_instance);
                (Some(scope), instance)
            }
            None => (
                None,
                input
                    .get("instance")
                    .and_then(Value::as_str)
                    .unwrap_or("default")
                    .to_string(),
            ),
        };
        let cache = self.instance(&instance);
        let policy = Policy::from_json(self.fixture.get("policy").unwrap_or(&Value::Null))
            .map_err(|e| format!("invalid fixture policy: {e}"))?;
        let identity = self.identity(&text(input.get("key")), &text(input.get("useCase")));
        let shared = self.shared.clone();
        let clock = self.clock.clone();
        let comparator_mode = self
            .fixture
            .get("comparator")
            .and_then(Value::as_str)
            .map(str::to_string);
        let comparison_ms = number(self.fixture.get("comparisonMs"));
        let comparator: ComparatorFn = match comparator_mode {
            None => Box::new(|a: &Val, b: &Val| a == b),
            Some(mode) => {
                let shared = shared.clone();
                let clock = clock.clone();
                Box::new(move |_a: &Val, _b: &Val| {
                    shared.lock().increment("comparisons");
                    clock.shift(comparison_ms, false);
                    if mode == "error" {
                        controlled_panic();
                    }
                    mode == "equal"
                })
            }
        };
        let codec: Arc<dyn Codec<Val>> = Arc::new(DriverCodec {
            shared: shared.clone(),
        });
        let mut operation = Operation::with_codec(identity, codec, comparator)
            .policy(policy)
            .budget(self.budget())
            .preview(|value: &Val| value.json_preview());
        if let Some(mode) = input.get("recovery").and_then(Value::as_str) {
            operation = operation.should_recover(self.classifier(mode));
        }
        let probe_scope = self.fixture.get("probeSourceScope") == Some(&Value::Bool(true));
        let source_work_ms = number(self.fixture.get("sourceWorkMs"));
        let source_cache = cache.clone();
        let source_shared = shared.clone();
        let source_clock = clock.clone();
        // Filled from the actual scope when this driver-owned call starts.
        let source_budget = Arc::new(Mutex::new(None));
        let loader_budget = source_budget.clone();
        let load = move |scope: Scope| {
            let shared = source_shared.clone();
            let clock = source_clock.clone();
            let cache = source_cache.clone();
            let source_budget = loader_budget.clone();
            async move {
                let gate = {
                    let mut s = shared.lock();
                    let id = s.loaders.len();
                    let gate: Gate<LoaderOutcome> = Gate::new();
                    s.loaders.push(gate.clone());
                    s.increment("loaders");
                    use dialcache::Clock;
                    let at = clock.elapsed_ms();
                    s.source_by_invocation.insert(index, id);
                    s.causal_history.push(CausalEvent::SourceStart {
                        id,
                        owner: index,
                        at_ms: at,
                        budget_ms: *source_budget.lock(),
                    });
                    s.history.push(HistoryEvent {
                        event: "sourceStart",
                        id,
                        at,
                        outcome: "",
                        duration_ms: 0.0,
                        failed: false,
                    });
                    if probe_scope {
                        let enabled = cache.is_enabled(&scope);
                        s.push("sourceScopes", Value::Bool(enabled));
                    }
                    gate
                };
                clock.shift(source_work_ms, false);
                match gate.wait().await {
                    LoaderOutcome::Value(value) => Ok(value),
                    LoaderOutcome::Fail(id) => Err(Box::new(SourceFailure(id)) as BoxError),
                    LoaderOutcome::Timeout(id) => {
                        // A timeout propagated by the source keeps the loader's identity.
                        Err(Box::new(FallbackTimeout {
                            use_case: format!("NestedSource:{id}"),
                            timeout_ms: 10,
                        }) as BoxError)
                    }
                }
            }
        };
        let call_shared = shared.clone();
        let call_cache = cache.clone();
        let call = move |scope: Scope| {
            let shared = call_shared.clone();
            let cache = call_cache.clone();
            let operation = operation.clone();
            let load = load.clone();
            let source_budget = source_budget.clone();
            InvocationFuture::new(Some(index), async move {
                *source_budget.lock() = if !cache.is_enabled(&scope) {
                    None
                } else {
                    match operation.budget {
                        SourceBudget::Default => Some(60_000),
                        SourceBudget::Unbounded => None,
                        SourceBudget::Millis(ms) => Some(ms),
                    }
                };
                let result = cache.get_or_load(&scope, operation, load).await;
                let mut s = shared.lock();
                let record = match result {
                    Ok(value) => json!({ "status": "value", "value": value.observed() }),
                    Err(error) => json!({ "status": "error", "error": s.classify_error(&error) }),
                };
                if let Some(Value::Array(calls)) = s.observed.get_mut("calls") {
                    calls[index] = record;
                }
            })
        };
        let disabled = input.get("disabled") == Some(&Value::Bool(true));
        let outside = input.get("outside") == Some(&Value::Bool(true));
        match ctx {
            Some(ctx) => {
                if disabled {
                    self.exec
                        .spawn(async move { cache.disable_in(&ctx, call).await });
                } else {
                    self.exec.spawn(call(ctx));
                }
            }
            None if outside => {
                let ctx = Scope::outside();
                if disabled {
                    self.exec
                        .spawn(async move { cache.disable_in(&ctx, call).await });
                } else {
                    self.exec.spawn(call(ctx));
                }
            }
            None => {
                if disabled {
                    let inner = cache.clone();
                    self.exec.spawn(async move {
                        cache
                            .enable(|scope| async move { inner.disable_in(&scope, call).await })
                            .await
                    });
                } else {
                    self.exec.spawn(async move { cache.enable(call).await });
                }
            }
        }
        Ok(())
    }

    fn open_scope(&mut self, input: &Value) -> Result<(), String> {
        let id = text(input.get("id"));
        if self.scopes.contains_key(&id) {
            return Err(format!("duplicate scope {id}"));
        }
        let parent = match input.get("parent").and_then(Value::as_str) {
            Some(parent_id) => Some(self.scope_of(parent_id)?),
            None => None,
        };
        let instance = input
            .get("instance")
            .and_then(Value::as_str)
            .map(str::to_string)
            .or_else(|| parent.as_ref().map(|(_, instance)| instance.clone()))
            .unwrap_or_else(|| "default".to_string());
        let cache = self.instance(&instance);
        let handle = ScopeHandle {
            instance,
            scope: Arc::new(Mutex::new(None)),
            gate: Gate::new(),
            done: Gate::new(),
        };
        let slot = handle.scope.clone();
        let gate = handle.gate.clone();
        let done = handle.done.clone();
        let disabled = input.get("disabled") == Some(&Value::Bool(true));
        let body = move |scope: Scope| {
            let slot = slot.clone();
            let gate = gate.clone();
            async move {
                *slot.lock() = Some(scope);
                gate.wait().await;
            }
        };
        let parent_scope = parent.map(|(scope, _)| scope);
        self.exec.spawn(async move {
            match (parent_scope, disabled) {
                (Some(parent), true) => cache.disable_in(&parent, body).await,
                (Some(parent), false) => cache.enable_in(&parent, body).await,
                (None, true) => cache.disable_in(&Scope::outside(), body).await,
                (None, false) => cache.enable(body).await,
            }
            done.settle(());
        });
        self.exec.drain();
        if handle.scope.lock().is_none() {
            return Err(format!("scope {id} did not open"));
        }
        self.scopes.insert(id, handle);
        Ok(())
    }

    /// The reported observation at the instant its receipt describes.
    pub fn observation(&self) -> Value {
        self.reported.clone()
    }

    pub fn receipt(&self) -> Value {
        self.settlement_receipt.clone()
    }

    pub fn observation_wall_ms(&self) -> i64 {
        self.reported_wall_ms
    }

    /// Release every driver-owned gate so no work leaks into the next history.
    pub fn close(&mut self) {
        {
            let mut s = self.shared.lock();
            for name in [
                "holdReads",
                "holdWrites",
                "holdDumps",
                "holdLoads",
                "holdPolicies",
            ] {
                s.faults.insert(name.to_string(), false);
            }
        }
        for handle in self.scopes.values() {
            handle.gate.settle(());
        }
        loop {
            let mut pending = false;
            {
                let mut s = self.shared.lock();
                for gates in s.effects.values_mut() {
                    for gate in gates.values() {
                        if gate.settle(Ok(())) {
                            pending = true;
                        }
                    }
                }
                for gate in &s.loaders {
                    if gate.settle(LoaderOutcome::Value(Val::Json(json!(0)))) {
                        pending = true;
                    }
                }
            }
            self.exec.drain();
            if !pending {
                break;
            }
        }
    }

    pub fn causal_history(&self) -> Vec<CausalEvent> {
        self.shared.lock().causal_history.clone()
    }

    pub fn assert_publication_causality(&self) -> Result<(), String> {
        assert_publication_causality(&self.causal_history())
    }

    pub fn history(&self) -> Vec<HistoryEvent> {
        self.shared.lock().history.clone()
    }

    /// C23/C25/C26 monitor over the actual callback history (effects profile).
    pub fn assert_effects_history(&self) -> Result<(), String> {
        Self::assert_effects_events(&self.history())
    }

    pub fn assert_effects_events(history: &[HistoryEvent]) -> Result<(), String> {
        struct Source {
            at: i64,
            settled: &'static str,
        }
        let mut sources: HashMap<usize, Source> = HashMap::new();
        let mut active: Option<usize> = None;
        let mut authorized = false;
        let mut previous = -1i64;
        for (index, e) in history.iter().enumerate() {
            let fail = |reason: &str| {
                Err(format!(
                    "effects contract event {index} {}: {reason}",
                    e.event
                ))
            };
            if e.at < previous {
                return fail("elapsed time moved backward");
            }
            previous = e.at;
            match e.event {
                "sourceStart" => {
                    if sources.contains_key(&e.id) || active.is_some() {
                        return fail("source started before prior fallback completed");
                    }
                    sources.insert(
                        e.id,
                        Source {
                            at: e.at,
                            settled: "",
                        },
                    );
                    active = Some(e.id);
                    authorized = false;
                }
                "sourceSettlement" => {
                    let Some(source) = sources.get_mut(&e.id) else {
                        return fail("invalid source settlement identity");
                    };
                    if !source.settled.is_empty()
                        || (e.outcome != "resolve" && e.outcome != "reject")
                    {
                        return fail("invalid source settlement identity");
                    }
                    source.settled = e.outcome;
                }
                "fallbackCompletion" => {
                    let Some(id) = active else {
                        return fail("fallback completion has no source");
                    };
                    let source = &sources[&id];
                    if !e.duration_ms.is_finite() || e.duration_ms < 0.0 {
                        return fail("invalid observed fallback duration");
                    }
                    let elapsed = (e.at - source.at) as f64;
                    if (e.duration_ms - elapsed).abs() > 1e-7 {
                        return Err(property_failure(
                            "C23",
                            "duration includes lookup or omits source time",
                            json!({"event":e.event, "index":index, "atMs":e.at, "elapsedMs":elapsed, "durationMs":e.duration_ms}),
                        ));
                    }
                    if !e.failed && (elapsed >= 10.0 || source.settled != "resolve") {
                        return Err(property_failure(
                            "C25",
                            "success must be accepted before its source deadline",
                            json!({"event":e.event, "index":index, "atMs":e.at, "elapsedMs":elapsed, "budgetMs":10, "settlement":source.settled, "failed":e.failed}),
                        ));
                    }
                    if e.failed && elapsed < 10.0 && source.settled != "reject" {
                        return Err(property_failure(
                            "C23",
                            "source lost its full source-relative budget",
                            json!({"event":e.event, "index":index, "atMs":e.at, "elapsedMs":elapsed, "budgetMs":10, "settlement":source.settled, "failed":e.failed}),
                        ));
                    }
                    active = None;
                    authorized = !e.failed;
                }
                "writeDispatch" => {
                    if !authorized {
                        return Err(property_failure(
                            "C26",
                            "publication without accepted source success",
                            json!({"event":e.event, "index":index, "atMs":e.at, "authorized":false}),
                        ));
                    }
                }
                _ => return fail("unknown monitor event"),
            }
        }
        Ok(())
    }
}

/// Block an external effect until the history releases it.
fn hold_effect(
    shared: &Arc<Mutex<Shared>>,
    effect: &str,
    index: usize,
) -> impl std::future::Future<Output = Result<(), String>> + Send {
    let gate: Gate<Result<(), String>> = Gate::new();
    shared
        .lock()
        .effects
        .entry(effect.to_string())
        .or_default()
        .insert(index, gate.clone());
    async move { gate.wait().await }
}

struct DriverCodec {
    shared: Arc<Mutex<Shared>>,
}

impl Codec<Val> for DriverCodec {
    fn encode<'a>(&'a self, value: &'a Val) -> BoxFuture<'a, Result<Payload, BoxError>> {
        let shared = self.shared.clone();
        let value = value.clone();
        Box::pin(async move {
            let (index, hold) = {
                let mut s = shared.lock();
                let index = s.increment("dumps");
                (index, s.fault("holdDumps"))
            };
            if hold {
                hold_effect(&shared, "dump", index)
                    .await
                    .map_err(|e| -> BoxError { e.into() })?;
            }
            if shared.lock().fault("dump") {
                return Err("controlled serialization failure".into());
            }
            Ok(match value {
                Val::Absent => Payload::text("undefined"),
                Val::Json(json) => Payload::text(serde_json::to_string(&json)?),
            })
        })
    }

    fn decode(&self, payload: Payload) -> BoxFuture<'_, Result<Val, BoxError>> {
        let shared = self.shared.clone();
        Box::pin(async move {
            let (index, hold) = {
                let mut s = shared.lock();
                let index = s.increment("loads");
                (index, s.fault("holdLoads"))
            };
            if hold {
                hold_effect(&shared, "load", index)
                    .await
                    .map_err(|e| -> BoxError { e.into() })?;
            }
            if shared.lock().fault("load") {
                return Err("controlled deserialization failure".into());
            }
            if payload.bytes == b"undefined" {
                return Ok(Val::Absent);
            }
            let value: Value = serde_json::from_slice(&payload.bytes)?;
            Ok(Val::Json(value))
        })
    }
}

struct DriverRemote {
    shared: Arc<Mutex<Shared>>,
    clock: Arc<VirtualClock>,
}

impl Remote for DriverRemote {
    fn read(
        &self,
        request: ReadRequest,
        context: ReadContext,
    ) -> BoxFuture<'_, Result<ReadResult, BoxError>> {
        let shared = self.shared.clone();
        let clock = self.clock.clone();
        Box::pin(async move {
            let (index, hold) = {
                let mut s = shared.lock();
                let index = s.increment("reads");
                let mut fields = Map::new();
                fields.insert("index".to_string(), Value::from(index));
                fields.insert("timeoutMs".to_string(), Value::from(context.timeout_ms));
                fields.insert(
                    "aborted".to_string(),
                    Value::Bool(context.cancel.is_cancelled()),
                );
                s.record("readContext", fields);
                (index, s.fault("holdReads"))
            };
            {
                let shared = shared.clone();
                context.cancel.on_cancel(move || {
                    let mut fields = Map::new();
                    fields.insert("index".to_string(), Value::from(index));
                    shared.lock().record("readAbort", fields);
                });
            }
            if hold {
                hold_effect(&shared, "read", index)
                    .await
                    .map_err(|e| -> BoxError { e.into() })?;
            }
            let mut s = shared.lock();
            if s.fault("read") {
                return Err("controlled read failure".into());
            }
            if let Some(reply) = s.reply.take() {
                return Ok(read_result_from_untrusted_json(&reply));
            }
            use dialcache::Clock;
            let elapsed = clock.elapsed_ms();
            let raw = s.raw(&request.value_key, elapsed);
            let marker = match &request.watermark_key {
                Some(key) => s.raw(key, elapsed),
                None => None,
            };
            let tracked = request.watermark_key.is_some();
            Ok(decode_frame(raw.as_deref(), tracked, marker.as_deref())?)
        })
    }

    fn write(&self, request: WriteRequest) -> BoxFuture<'_, Result<(), BoxError>> {
        let shared = self.shared.clone();
        let clock = self.clock.clone();
        Box::pin(async move {
            use dialcache::Clock;
            let (index, hold) = {
                let mut s = shared.lock();
                let index = s.increment("writes");
                let at = clock.elapsed_ms();
                let owner = current_invocation();
                let source = owner.and_then(|owner| s.source_by_invocation.get(&owner).copied());
                s.causal_history.push(CausalEvent::WriteDispatch {
                    source,
                    owner,
                    at_ms: at,
                });
                s.history.push(HistoryEvent {
                    event: "writeDispatch",
                    id: 0,
                    at,
                    outcome: "",
                    duration_ms: 0.0,
                    failed: false,
                });
                let mut fields = Map::new();
                fields.insert("index".to_string(), Value::from(index));
                s.record("writeDispatch", fields);
                s.push("writeTtls", Value::from(request.ttl_ms));
                (index, s.fault("holdWrites"))
            };
            if hold {
                hold_effect(&shared, "write", index)
                    .await
                    .map_err(|e| -> BoxError { e.into() })?;
            }
            let mut s = shared.lock();
            if s.fault("write") {
                return Err(Box::new(MaintenanceFailure) as BoxError);
            }
            let raw = encode_frame(&request.frame)?;
            if !s.discard_writes {
                let expires = clock.elapsed_ms() + request.ttl_ms as i64;
                s.values.insert(request.value_key, Stored { raw, expires });
            }
            Ok(())
        })
    }

    fn invalidate(&self, request: InvalidateRequest) -> BoxFuture<'_, Result<(), BoxError>> {
        let shared = self.shared.clone();
        let clock = self.clock.clone();
        Box::pin(async move {
            use dialcache::Clock;
            let mut s = shared.lock();
            s.increment("invalidations");
            if s.fault("write") {
                return Err(Box::new(MaintenanceFailure) as BoxError);
            }
            if s.discard_invalidations {
                return Ok(());
            }
            let now = request.invalidated_at_ms as i64;
            let mut cutoff = now + request.future_buffer_ms as i64;
            let elapsed = clock.elapsed_ms();
            let prior = s.raw(&request.watermark_key, elapsed);
            let old: i64 = prior
                .and_then(|raw| String::from_utf8_lossy(&raw).parse().ok())
                .unwrap_or(0);
            if old > cutoff {
                cutoff = old;
            }
            let mut ttl: i64 = 7_200_000;
            if cutoff - now + 3_660_000 > ttl {
                ttl = cutoff - now + 3_660_000;
            }
            if let Some(item) = s.values.get(&request.watermark_key) {
                if item.expires - elapsed > ttl {
                    ttl = item.expires - elapsed;
                }
            }
            s.values.insert(
                request.watermark_key,
                Stored {
                    raw: cutoff.to_string().into_bytes(),
                    expires: elapsed + ttl,
                },
            );
            Ok(())
        })
    }
}

struct DriverObserver {
    shared: Arc<Mutex<Shared>>,
    clock: Arc<VirtualClock>,
    shadow_hook: bool,
}

fn labels_map(labels: &dialcache::Labels) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert(
        "cacheNamespace".to_string(),
        Value::from(labels.namespace.as_ref()),
    );
    m.insert("useCase".to_string(), Value::from(labels.use_case.as_ref()));
    m.insert("keyType".to_string(), Value::from(labels.key_type.as_ref()));
    m.insert("layer".to_string(), Value::from(labels.layer.as_str()));
    m
}

fn outcome_map(labels: &dialcache::observe::OutcomeLabels) -> Map<String, Value> {
    let mut m = Map::new();
    m.insert(
        "cacheNamespace".to_string(),
        Value::from(labels.namespace.as_ref()),
    );
    m.insert("useCase".to_string(), Value::from(labels.use_case.as_ref()));
    m.insert("keyType".to_string(), Value::from(labels.key_type.as_ref()));
    m
}

impl Observer for DriverObserver {
    fn observe(&self, event: &Event) {
        use dialcache::Clock;
        let mut s = self.shared.lock();
        let (kind, mut fields): (&str, Map<String, Value>) = match event {
            Event::Request { labels } => ("request", labels_map(labels)),
            Event::Miss { labels, reason } => {
                let mut m = labels_map(labels);
                m.insert("reason".to_string(), Value::from(reason.as_str()));
                ("miss", m)
            }
            Event::Disabled { labels, reason } => {
                let mut m = labels_map(labels);
                m.insert("reason".to_string(), Value::from(reason.as_str()));
                ("disabled", m)
            }
            Event::Error {
                labels,
                error,
                in_fallback,
            } => {
                let mut m = labels_map(labels);
                m.insert("error".to_string(), Value::from(error.as_str()));
                m.insert("inFallback".to_string(), Value::Bool(*in_fallback));
                if *in_fallback && *error == dialcache::observe::ErrorKind::Fallback {
                    s.fallback_failed = true;
                }
                ("error", m)
            }
            Event::Invalidation {
                namespace,
                key_type,
                layer,
            } => {
                let mut m = Map::new();
                m.insert(
                    "cacheNamespace".to_string(),
                    Value::from(namespace.as_ref()),
                );
                m.insert("keyType".to_string(), Value::from(key_type.as_ref()));
                m.insert("layer".to_string(), Value::from(layer.as_str()));
                ("invalidation", m)
            }
            Event::Coalesced { labels, scope } => {
                let mut m = outcome_map(labels);
                m.insert("scope".to_string(), Value::from(scope.as_str()));
                ("coalesced", m)
            }
            Event::ShadowValidation { labels, outcome } => {
                s.push("shadow", Value::from(outcome.as_str()));
                let mut m = outcome_map(labels);
                m.insert("outcome".to_string(), Value::from(outcome.as_str()));
                ("shadowValidation", m)
            }
            Event::ShadowValueAge {
                labels,
                outcome,
                seconds,
            } => {
                let mut m = outcome_map(labels);
                m.insert("outcome".to_string(), Value::from(outcome.as_str()));
                m.insert("seconds".to_string(), Value::from(*seconds));
                ("shadowAge", m)
            }
            Event::FutureTimestampOffset { labels, seconds } => {
                let mut m = labels_map(labels);
                m.insert("seconds".to_string(), Value::from(*seconds));
                ("futureOffset", m)
            }
            Event::StaleRecovery { labels, outcome } => {
                s.push("recovery", Value::from(outcome.as_str()));
                let mut m = outcome_map(labels);
                m.insert("outcome".to_string(), Value::from(outcome.as_str()));
                ("staleRecovery", m)
            }
            Event::StaleRecoveryValueAge {
                labels,
                outcome,
                seconds,
            } => {
                let mut m = outcome_map(labels);
                m.insert("outcome".to_string(), Value::from(outcome.as_str()));
                m.insert("seconds".to_string(), Value::from(*seconds));
                ("recoveryAge", m)
            }
            Event::Compression { labels, outcome } => {
                let mut m = labels_map(labels);
                m.insert("outcome".to_string(), Value::from(outcome.as_str()));
                ("compression", m)
            }
            Event::Get { labels, seconds } => {
                let mut m = labels_map(labels);
                m.insert("seconds".to_string(), Value::from(*seconds));
                ("get", m)
            }
            Event::Fallback { labels, seconds } => {
                let mut m = labels_map(labels);
                m.insert("seconds".to_string(), Value::from(*seconds));
                let at = self.clock.elapsed_ms();
                let failed = s.fallback_failed;
                s.history.push(HistoryEvent {
                    event: "fallbackCompletion",
                    id: 0,
                    at,
                    outcome: "",
                    duration_ms: seconds * 1000.0,
                    failed,
                });
                s.fallback_failed = false;
                ("fallback", m)
            }
            Event::Serialization {
                labels,
                operation,
                seconds,
            } => {
                let mut m = labels_map(labels);
                m.insert("operation".to_string(), Value::from(operation.as_str()));
                m.insert("seconds".to_string(), Value::from(*seconds));
                ("serialization", m)
            }
            Event::Size { labels, bytes } => {
                let mut m = labels_map(labels);
                m.insert("bytes".to_string(), Value::from(*bytes));
                ("size", m)
            }
            Event::StoredSize { labels, bytes } => {
                let mut m = labels_map(labels);
                m.insert("bytes".to_string(), Value::from(*bytes));
                ("storedSize", m)
            }
            Event::CompressionRatio { labels, ratio } => {
                let mut m = labels_map(labels);
                m.insert("value".to_string(), Value::from(*ratio));
                ("compressionRatio", m)
            }
            Event::CompressionDuration {
                labels,
                operation,
                seconds,
            } => {
                let mut m = labels_map(labels);
                m.insert("operation".to_string(), Value::from(operation.as_str()));
                m.insert("seconds".to_string(), Value::from(*seconds));
                ("compressionDuration", m)
            }
        };
        fields.retain(|k, _| k != "value" || kind == "compressionRatio");
        s.record(kind, fields);
        let fail = s.observer_fails();
        drop(s);
        if fail {
            controlled_panic();
        }
    }

    fn observes_shadow_outcomes(&self) -> bool {
        self.shadow_hook
    }
}

struct DriverLogger {
    shared: Arc<Mutex<Shared>>,
}

impl Logger for DriverLogger {
    fn log(&self, event: &LogEvent) {
        let mut s = self.shared.lock();
        if let LogEvent::ShadowMismatch(details) = event {
            let mut fields = Map::new();
            fields.insert(
                "cacheNamespace".to_string(),
                Value::from(details.namespace.as_ref()),
            );
            fields.insert(
                "useCase".to_string(),
                Value::from(details.use_case.as_ref()),
            );
            fields.insert(
                "keyType".to_string(),
                Value::from(details.key_type.as_ref()),
            );
            fields.insert("outcome".to_string(), Value::from("mismatch"));
            fields.insert(
                "cacheKey".to_string(),
                Value::from(details.cache_key.as_str()),
            );
            fields.insert(
                "cachedValueJson".to_string(),
                details
                    .cached_value_json
                    .clone()
                    .map(Value::from)
                    .unwrap_or(Value::Null),
            );
            fields.insert(
                "sourceValueJson".to_string(),
                details
                    .source_value_json
                    .clone()
                    .map(Value::from)
                    .unwrap_or(Value::Null),
            );
            s.record("mismatchWarning", fields);
        }
        let fail = s.observer_fails();
        drop(s);
        if fail {
            controlled_panic();
        }
    }
}

/// Local storage that fails on command, at the native storage boundary.
struct FaultStore {
    inner: Option<LruLocalStore>,
    shared: Arc<Mutex<Shared>>,
}

impl LocalStore for FaultStore {
    fn get(&mut self, key: &str, now_ms: i64) -> Result<LocalRead, BoxError> {
        if self.shared.lock().fault("localStorage") {
            return Err("controlled local storage failure".into());
        }
        match self.inner.as_mut() {
            Some(inner) => inner.get(key, now_ms),
            None => Ok(LocalRead::Absent),
        }
    }

    fn put(&mut self, key: String, entry: LocalEntry) -> Result<Option<LocalEntry>, BoxError> {
        if self.shared.lock().fault("localStorage") {
            return Err("controlled local storage failure".into());
        }
        match self.inner.as_mut() {
            Some(inner) => inner.put(key, entry),
            None => Ok(None),
        }
    }
}

#[allow(dead_code)]
fn _unused(shared: &Shared) -> Map<String, Value> {
    shared_labels(shared)
}
