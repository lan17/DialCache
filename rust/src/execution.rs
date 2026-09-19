//! One enabled call: admission, policy capture, traversal, source, publication
//! and stale recovery. Ported transition by transition from the reference
//! implementations; the Quint models define the behavior.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures::future::BoxFuture;
use futures::FutureExt;

use crate::cancel::CancelToken;
use crate::deadline::{await_deadline, seconds_since};
use crate::engine::Core;
use crate::error::{BoxError, Error, FallbackTimeout, RemoteReadTimeout, SharedError};
use crate::flight::{panic_message, start_pending, Flight, Settled, ValueResult, DROPPED_MESSAGE};
use crate::identity::{Identity, Keys};
use crate::limits::{MAX_DECOMPRESSED_BYTES, MAX_SAFE_INTEGER, MAX_TRACKED_VALUE_TTL_MS};
use crate::local::StoredValue;
use crate::observe::{
    CoalescingScope, CompressionOperation, DisabledReason, ErrorKind, Event, Labels, Layer,
    LogEvent, MissReason, OutcomeLabels, RecoveryOutcome, SerializationOperation,
};
use crate::operation::ErasedOperation;
use crate::policy::{resolve_policy, PolicyDefaults, ResolvedLayer, ResolvedPolicy};
use crate::protocol::{
    compress_payload, decompress_payload, escape_raw_payload, normalize_read_result,
};
use crate::remote::{Frame, ReadContext, ReadRequest, ReadResult, WriteRequest};
use crate::scope::{Owner, Scope};

/// The raw outcome of one adapter read.
pub(crate) type RawRead = Result<ReadResult, SharedError>;

#[derive(Debug, thiserror::Error)]
#[error("DialCache callback panicked: {0}")]
pub(crate) struct PanicError(pub Arc<str>);

/// The registered leader of one key in the request or process flight table.
///
/// Dropping it before [`Leader::finish`] means the leader's detached task was
/// dropped unpolled (the runtime shut down while the cache outlived it); the
/// flight is then unregistered and settled with an error so later callers,
/// possibly on another runtime, start a fresh execution instead of joining a
/// flight that can never complete.
struct Leader {
    core: Arc<Core>,
    owner: Option<Arc<Owner>>,
    key: String,
    flight: Arc<Flight>,
    settled: bool,
}

impl Leader {
    fn unregister(&self) {
        match &self.owner {
            Some(owner) => {
                let mut state = owner.state.lock();
                if state
                    .flights
                    .get(&self.key)
                    .is_some_and(|f| Arc::ptr_eq(f, &self.flight))
                {
                    state.flights.remove(&self.key);
                }
            }
            None => {
                let mut state = self.core.state.lock();
                if state
                    .flights
                    .get(&self.key)
                    .is_some_and(|f| Arc::ptr_eq(f, &self.flight))
                {
                    state.flights.remove(&self.key);
                }
            }
        }
    }

    /// Unregister first, then settle: a caller arriving between the two
    /// starts a new flight rather than joining a settled one.
    fn finish(&mut self, result: ValueResult) {
        self.settled = true;
        self.unregister();
        self.flight.result.settle(result);
    }
}

impl Drop for Leader {
    fn drop(&mut self) {
        if !self.settled {
            self.unregister();
            self.flight
                .result
                .settle(Err(Error::Panic(Arc::from(DROPPED_MESSAGE))));
        }
    }
}

/// One admitted enabled call.
pub(crate) struct Execution {
    pub(crate) core: Arc<Core>,
    pub(crate) scope: Scope,
    pub(crate) op: Arc<ErasedOperation>,
    pub(crate) identity: Identity,
    pub(crate) keys: Keys,
    pub(crate) policy: ResolvedPolicy,
    pub(crate) labels: OutcomeLabels,
    pub(crate) timed_out: Arc<AtomicBool>,
}

/// What the serving remote read produced.
pub(crate) enum RemoteValue {
    Hit {
        value: StoredValue,
        frame: Frame,
    },
    /// A valid stale frame retained only as a recovery candidate.
    Retained {
        frame: Frame,
    },
    Miss {
        fence: Option<u64>,
    },
    DecodeError,
    Error,
}

/// Run one call from admission to result.
pub(crate) async fn run(core: Arc<Core>, scope: Scope, op: Arc<ErasedOperation>) -> ValueResult {
    let mut identity = op.identity.clone();
    let noop_labels = crate::engine::outcome_labels(&identity);
    let noop = |reason: DisabledReason| Event::Disabled {
        labels: layer_labels(&noop_labels, Layer::Noop),
        reason,
    };
    if !core.id_enabled(&scope) {
        core.emit(noop(DisabledReason::Context));
        return call_load(&op, scope).await;
    }
    if let Some(provider) = &op.identity_provider {
        let computed = catch_unwind(AssertUnwindSafe(|| provider()))
            .unwrap_or_else(|payload| Err(Box::new(PanicError(panic_message(payload))) as BoxError))
            .and_then(|identity| {
                if identity.use_case == crate::limits::WATERMARK_USE_CASE {
                    Err("reserved use case: watermark".into())
                } else {
                    Ok(identity)
                }
            });
        match computed {
            Ok(mut computed) => {
                if computed.namespace.is_empty() {
                    computed.namespace = core.namespace.to_string();
                }
                identity = computed;
            }
            Err(error) => {
                core.log(LogEvent::KeyConstructionFailed(error));
                core.emit(Event::Error {
                    labels: layer_labels(&noop_labels, Layer::Noop),
                    error: ErrorKind::KeyConstruction,
                    in_fallback: false,
                });
                return uncached_source(&core, &op, scope, &noop_labels).await;
            }
        }
    }
    let labels = crate::engine::outcome_labels(&identity);
    let keys = match identity.keys() {
        Ok(keys) => keys,
        Err(error) => {
            core.log(LogEvent::KeyConstructionFailed(Box::new(error)));
            core.emit(Event::Error {
                labels: layer_labels(&labels, Layer::Noop),
                error: ErrorKind::KeyConstruction,
                in_fallback: false,
            });
            return uncached_source(&core, &op, scope, &labels).await;
        }
    };
    let overlay: Result<Option<crate::policy::RuntimePolicy>, BoxError> = match &core.provider {
        Some(provider) => {
            let pending = start_pending(
                core.runtime.as_ref(),
                {
                    let provider = provider.clone();
                    let identity = identity.clone();
                    async move {
                        provider(identity)
                            .await
                            .map_err(|e| Arc::from(e) as SharedError)
                    }
                },
                |message| Err(Arc::new(PanicError(message)) as SharedError),
            );
            pending
                .wait()
                .await
                .map_err(|e| Box::new(SharedErrorWrapper(e)) as BoxError)
        }
        None => Ok(None),
    };
    let resolved = overlay.and_then(|overlay| {
        resolve_policy(
            &op.policy,
            overlay.as_ref(),
            &keys.logical,
            PolicyDefaults {
                remote_read_timeout_ms: core.remote_read_timeout_ms,
            },
        )
        .map_err(|e| Box::new(e) as BoxError)
    });
    let policy = match resolved {
        Ok(policy) => policy,
        Err(error) => {
            core.log(LogEvent::PolicyResolutionFailed(error));
            core.emit(Event::Error {
                labels: layer_labels(&labels, Layer::Noop),
                error: ErrorKind::ConfigResolution,
                in_fallback: false,
            });
            core.emit(Event::Disabled {
                labels: layer_labels(&labels, Layer::Noop),
                reason: DisabledReason::ConfigError,
            });
            return uncached_source(&core, &op, scope, &labels).await;
        }
    };
    if !core.id_enabled(&scope) {
        core.emit(Event::Disabled {
            labels: layer_labels(&labels, Layer::Noop),
            reason: DisabledReason::Context,
        });
        return uncached_source(&core, &op, scope, &labels).await;
    }
    let execution = Arc::new(Execution {
        core: core.clone(),
        scope: scope.clone(),
        op,
        identity,
        keys,
        policy,
        labels,
        timed_out: Arc::new(AtomicBool::new(false)),
    });
    if !execution.policy.request_local {
        return execution.shared(Layer::Local).await;
    }
    let Some(owner) = scope.owner.clone() else {
        return execution.shared(Layer::Local).await;
    };
    let request_run = {
        let x = execution.clone();
        let owner = owner.clone();
        move || -> BoxFuture<'static, ValueResult> {
            Box::pin(async move { x.through_request(owner).await })
        }
    };
    if !execution.policy.coalesce {
        return request_run().await;
    }
    execution
        .single_flight(Some(owner), CoalescingScope::RequestLocal, request_run)
        .await
}

#[derive(Debug)]
struct SharedErrorWrapper(SharedError);

impl std::fmt::Display for SharedErrorWrapper {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        self.0.fmt(f)
    }
}

impl std::error::Error for SharedErrorWrapper {}

impl Core {
    pub(crate) fn id_enabled(&self, scope: &Scope) -> bool {
        scope.cache_id == self.id && scope.is_enabled()
    }
}

pub(crate) fn layer_labels(labels: &OutcomeLabels, layer: Layer) -> Labels {
    Labels {
        namespace: labels.namespace.clone(),
        use_case: labels.use_case.clone(),
        key_type: labels.key_type.clone(),
        layer,
    }
}

/// Invoke the source directly with panic isolation; errors keep their identity.
async fn call_load(op: &ErasedOperation, scope: Scope) -> ValueResult {
    let future = (op.load)(scope);
    match AssertUnwindSafe(future).catch_unwind().await {
        Ok(Ok(value)) => Ok(value),
        Ok(Err(error)) => Err(Error::Source(Arc::from(error))),
        Err(payload) => Err(Error::Panic(panic_message(payload))),
    }
}

/// The enabled but uncached path: the source runs with its enabled deadline.
async fn uncached_source(
    core: &Arc<Core>,
    op: &Arc<ErasedOperation>,
    scope: Scope,
    labels: &OutcomeLabels,
) -> ValueResult {
    source_with_budget(core, op, scope, labels, Layer::Noop, None).await
}

/// Run the source under the operation budget, reporting the fallback trail.
async fn source_with_budget(
    core: &Arc<Core>,
    op: &Arc<ErasedOperation>,
    scope: Scope,
    labels: &OutcomeLabels,
    layer: Layer,
    timed_out: Option<&AtomicBool>,
) -> ValueResult {
    let clock = core.clock.clone();
    let start = clock.elapsed();
    let budget = op.budget.millis();
    let pending: Settled<ValueResult> = start_pending(
        core.runtime.as_ref(),
        {
            let op = op.clone();
            async move { call_load(&op, scope).await }
        },
        |message| Err(Error::Panic(message)),
    );
    let use_case = labels.use_case.to_string();
    let result = await_deadline(
        clock.as_ref(),
        core.runtime.as_ref(),
        &pending,
        start,
        budget,
        || {
            if let Some(flag) = timed_out {
                flag.store(true, Ordering::SeqCst);
            }
            Err(Error::FallbackTimeout(Arc::new(FallbackTimeout {
                use_case,
                timeout_ms: budget.unwrap_or(0),
            })))
        },
    )
    .await;
    if result.is_err() {
        core.emit(Event::Error {
            labels: layer_labels(labels, layer),
            error: ErrorKind::Fallback,
            in_fallback: true,
        });
    }
    core.emit(Event::Fallback {
        labels: layer_labels(labels, layer),
        seconds: seconds_since(clock.as_ref(), start),
    });
    result
}

impl Execution {
    pub(crate) fn labels(&self, layer: Layer) -> Labels {
        layer_labels(&self.labels, layer)
    }

    pub(crate) fn emit(&self, event: Event) {
        self.core.emit(event);
    }

    pub(crate) fn error_event(&self, layer: Layer, error: ErrorKind, in_fallback: bool) {
        self.emit(Event::Error {
            labels: self.labels(layer),
            error,
            in_fallback,
        });
    }

    pub(crate) fn elapsed(&self) -> Duration {
        self.core.clock.elapsed()
    }

    pub(crate) fn seconds_since(&self, start: Duration) -> f64 {
        seconds_since(self.core.clock.as_ref(), start)
    }

    pub(crate) fn wall_ms(&self) -> i64 {
        self.core.clock.wall_ms()
    }

    /// The source under the operation budget, attributed to `layer`.
    pub(crate) async fn source(&self, layer: Layer) -> ValueResult {
        source_with_budget(
            &self.core,
            &self.op,
            self.scope.clone(),
            &self.labels,
            layer,
            Some(&self.timed_out),
        )
        .await
    }

    async fn through_request(self: Arc<Self>, owner: Arc<Owner>) -> ValueResult {
        let start = self.elapsed();
        let (memo, live) = {
            let state = owner.state.lock();
            (state.memo.get(&self.keys.logical).cloned(), state.live)
        };
        self.emit(Event::Request {
            labels: self.labels(Layer::RequestLocal),
        });
        self.emit(Event::Get {
            labels: self.labels(Layer::RequestLocal),
            seconds: self.seconds_since(start),
        });
        if let (true, Some(value)) = (live, memo) {
            return Ok(value);
        }
        self.emit(Event::Miss {
            labels: self.labels(Layer::RequestLocal),
            reason: MissReason::ValueAbsent,
        });
        let result = self.clone().shared(Layer::RequestLocal).await;
        if let Ok(value) = &result {
            let displaced = {
                let mut state = owner.state.lock();
                if state.live {
                    state.memo.insert(self.keys.logical.clone(), value.clone())
                } else {
                    None
                }
            };
            // A replaced memo value drops here, outside the lock.
            drop(displaced);
        }
        result
    }

    /// Join an existing execution for this key or lead a new one.
    pub(crate) async fn single_flight<F>(
        self: &Arc<Self>,
        owner: Option<Arc<Owner>>,
        label: CoalescingScope,
        run: F,
    ) -> ValueResult
    where
        F: FnOnce() -> BoxFuture<'static, ValueResult>,
    {
        // Read the clock before taking any lock: it is external code.
        let started = self.elapsed();
        let key = self.keys.logical.clone();
        let flight = {
            let joined = match &owner {
                Some(owner) => {
                    let mut state = owner.state.lock();
                    if !state.live {
                        None
                    } else if let Some(existing) = state.flights.get(&key) {
                        existing.join();
                        Some(Ok(existing.clone()))
                    } else {
                        let flight = Flight::new(started);
                        state.flights.insert(key.clone(), flight.clone());
                        Some(Err(flight))
                    }
                }
                None => {
                    let mut state = self.core.state.lock();
                    if let Some(existing) = state.flights.get(&key) {
                        existing.join();
                        Some(Ok(existing.clone()))
                    } else {
                        let flight = Flight::new(started);
                        state.flights.insert(key.clone(), flight.clone());
                        Some(Err(flight))
                    }
                }
            };
            match joined {
                None => return run().await,
                Some(Ok(existing)) => {
                    self.emit(Event::Coalesced {
                        labels: self.labels.clone(),
                        scope: label,
                    });
                    return existing.result.wait().await;
                }
                Some(Err(flight)) => flight,
            }
        };
        let mut leader = Leader {
            core: self.core.clone(),
            owner,
            key,
            flight,
            settled: false,
        };
        let result = match AssertUnwindSafe(run()).catch_unwind().await {
            Ok(result) => result,
            Err(payload) => Err(Error::Panic(panic_message(payload))),
        };
        leader.finish(result.clone());
        result
    }

    fn layer_event(&self, layer: Layer, resolved: &ResolvedLayer) {
        if !resolved.enabled {
            let reason = resolved.reason.unwrap_or(DisabledReason::PolicyDisabled);
            self.emit(Event::Disabled {
                labels: self.labels(layer),
                reason,
            });
            if matches!(
                reason,
                DisabledReason::InvalidTtl | DisabledReason::InvalidRamp
            ) {
                self.error_event(layer, ErrorKind::ConfigResolution, false);
            }
        }
    }

    /// Traverse the shared layers below the request layer.
    pub(crate) async fn shared(self: Arc<Self>, fallback_layer: Layer) -> ValueResult {
        let p = self.policy.clone();
        self.layer_event(Layer::Local, &p.local);
        let run = {
            let x = self.clone();
            move || -> BoxFuture<'static, ValueResult> {
                Box::pin(async move { x.shared_run(fallback_layer).await })
            }
        };
        if p.local.enabled {
            if p.coalesce {
                return self
                    .single_flight(None, CoalescingScope::Process, run)
                    .await;
            }
            return run().await;
        }
        // Remote admission is decided before joining; traversal belongs to the leader.
        if p.remote.enabled && self.core.remote.is_some() && p.coalesce {
            return self
                .single_flight(None, CoalescingScope::Process, run)
                .await;
        }
        run().await
    }

    async fn shared_run(self: Arc<Self>, mut fallback_layer: Layer) -> ValueResult {
        let p = self.policy.clone();
        let mut local_miss = false;
        if p.local.enabled {
            let start = self.elapsed();
            match self.core.local_get(&self.keys.logical) {
                Err(error) => {
                    self.core.log(LogEvent::LocalReadFailed(error));
                    self.error_event(Layer::Local, ErrorKind::CacheRead, false);
                    self.emit(Event::Disabled {
                        labels: self.labels(Layer::Local),
                        reason: DisabledReason::ConfigError,
                    });
                }
                Ok(found) => {
                    self.emit(Event::Request {
                        labels: self.labels(Layer::Local),
                    });
                    self.emit(Event::Get {
                        labels: self.labels(Layer::Local),
                        seconds: self.seconds_since(start),
                    });
                    if let Some(value) = found {
                        return Ok(value);
                    }
                    local_miss = true;
                    self.emit(Event::Miss {
                        labels: self.labels(Layer::Local),
                        reason: MissReason::ValueAbsent,
                    });
                }
            }
            fallback_layer = Layer::Local;
        }
        if self.core.remote.is_none() {
            let result = self.source(fallback_layer).await;
            if let Ok(value) = &result {
                if local_miss {
                    self.put_local(value.clone());
                }
            }
            return result;
        }
        if p.stale_on_error_config_error {
            self.error_event(Layer::Remote, ErrorKind::ConfigResolution, false);
        }
        self.layer_event(Layer::Remote, &p.remote);
        if !p.remote.enabled {
            if p.remote.reason == Some(DisabledReason::RampedDown) {
                return self.dark_source(fallback_layer, local_miss).await;
            }
            let result = self.source(fallback_layer).await;
            if let Ok(value) = &result {
                if local_miss {
                    self.put_local(value.clone());
                }
            }
            return result;
        }
        let remote = self.read_serving().await;
        if let RemoteValue::Hit { value, frame } = remote {
            if local_miss {
                self.put_local(value.clone());
            }
            self.schedule_shadow(Some(frame), None, Duration::ZERO);
            return Ok(value);
        }
        let result = self.source(Layer::Remote).await;
        match result {
            Err(error) => {
                let recoverable = !matches!(remote, RemoteValue::Error | RemoteValue::DecodeError);
                if recoverable && p.stale_on_error_max_age_ms > 0 && self.can_recover(&error) {
                    let frame = match &remote {
                        RemoteValue::Retained { frame } => Some(frame),
                        _ => None,
                    };
                    if let Some(value) = self.recover(frame).await {
                        return Ok(value);
                    }
                }
                Err(error)
            }
            Ok(value) => {
                if !matches!(remote, RemoteValue::Error) {
                    let fence = match &remote {
                        RemoteValue::Miss { fence } => *fence,
                        _ => None,
                    };
                    if let Err(error) = self.put_remote(&value, fence, Layer::Remote, None).await {
                        self.core.log(LogEvent::RemoteWriteFailed(error));
                    }
                }
                if local_miss && !self.identity.tracked {
                    self.put_local(value.clone());
                }
                Ok(value)
            }
        }
    }

    pub(crate) fn put_local(&self, value: StoredValue) {
        if let Err(error) = self
            .core
            .local_put(&self.keys.logical, value, self.policy.local.ttl_ms)
        {
            self.core.log(LogEvent::LocalWriteFailed(error));
            self.error_event(Layer::Local, ErrorKind::CacheWrite, false);
        }
    }

    /// Start one adapter read under the read budget. Returns the bounded
    /// result and the raw work, which keeps running after a deadline.
    pub(crate) fn raw_read(&self) -> (BoxFuture<'static, RawRead>, Settled<RawRead>) {
        let remote = self
            .core
            .remote
            .clone()
            .expect("remote layer requires an adapter");
        let cancel = CancelToken::new();
        let timeout_ms = self.policy.remote_read_timeout_ms;
        let context = ReadContext {
            timeout_ms,
            cancel: cancel.clone(),
        };
        let request = ReadRequest {
            value_key: self.keys.value.clone(),
            watermark_key: if self.identity.tracked {
                self.keys.watermark.clone()
            } else {
                None
            },
        };
        let clock = self.core.clock.clone();
        let runtime = self.core.runtime.clone();
        let start = clock.elapsed();
        let raw: Settled<RawRead> = start_pending(
            self.core.runtime.as_ref(),
            async move {
                remote
                    .read(request, context)
                    .await
                    .map_err(|e| Arc::from(e) as SharedError)
            },
            |message| Err(Arc::new(PanicError(message)) as SharedError),
        );
        let tracked = self.identity.tracked;
        let use_case = self.labels.use_case.to_string();
        let waited = raw.clone();
        let bounded = Box::pin(async move {
            let result = await_deadline(
                clock.as_ref(),
                runtime.as_ref(),
                &waited,
                start,
                Some(timeout_ms),
                || {
                    cancel.cancel();
                    Err(Arc::new(RemoteReadTimeout {
                        use_case,
                        timeout_ms,
                    }) as SharedError)
                },
            )
            .await;
            result.map(|read| normalize_read_result(read, tracked))
        });
        (bounded, raw)
    }

    /// Age of a frame against the wall clock; `false` for invalid or future stamps.
    pub(crate) fn frame_age(&self, frame: &Frame, layer: Layer) -> (i64, bool) {
        if frame.created_at_ms > MAX_SAFE_INTEGER {
            return (0, false);
        }
        let age = self.wall_ms().saturating_sub(frame.created_at_ms as i64);
        if age < 0 {
            self.emit(Event::FutureTimestampOffset {
                labels: self.labels(layer),
                seconds: (-age) as f64 / 1000.0,
            });
            return (age, false);
        }
        (age, true)
    }

    async fn read_serving(&self) -> RemoteValue {
        let start = self.elapsed();
        self.emit(Event::Request {
            labels: self.labels(Layer::Remote),
        });
        let (bounded, _raw) = self.raw_read();
        let result = bounded.await;
        let value = match result {
            Err(error) => {
                let kind = if error.downcast_ref::<RemoteReadTimeout>().is_some() {
                    ErrorKind::CacheReadTimeout
                } else {
                    ErrorKind::CacheRead
                };
                self.core
                    .log(LogEvent::RemoteReadFailed(Box::new(SharedErrorWrapper(
                        error,
                    ))));
                self.error_event(Layer::Remote, kind, false);
                RemoteValue::Error
            }
            Ok(ReadResult::Miss {
                reason,
                observed_watermark_ms,
            }) => {
                self.emit(Event::Miss {
                    labels: self.labels(Layer::Remote),
                    reason,
                });
                RemoteValue::Miss {
                    fence: observed_watermark_ms,
                }
            }
            Ok(ReadResult::Hit(frame)) => {
                let (age, valid) = self.frame_age(&frame, Layer::Remote);
                if !valid {
                    self.emit(Event::Miss {
                        labels: self.labels(Layer::Remote),
                        reason: MissReason::Unclassified,
                    });
                    RemoteValue::Miss { fence: None }
                } else {
                    let max_age = if self.policy.stale_on_error_max_age_ms > 0 {
                        self.policy.stale_on_error_max_age_ms
                    } else {
                        self.policy.remote.ttl_ms
                    };
                    if age as u64 >= max_age {
                        self.emit(Event::Miss {
                            labels: self.labels(Layer::Remote),
                            reason: MissReason::Expired,
                        });
                        RemoteValue::Miss { fence: None }
                    } else if age as u64 >= self.policy.remote.ttl_ms {
                        self.emit(Event::Miss {
                            labels: self.labels(Layer::Remote),
                            reason: MissReason::Expired,
                        });
                        RemoteValue::Retained { frame }
                    } else {
                        match self.decode(&frame, Layer::Remote).await {
                            Ok(value) => RemoteValue::Hit { value, frame },
                            Err(_) => {
                                self.emit(Event::Miss {
                                    labels: self.labels(Layer::Remote),
                                    reason: MissReason::Unclassified,
                                });
                                RemoteValue::DecodeError
                            }
                        }
                    }
                }
            }
        };
        self.emit(Event::Get {
            labels: self.labels(Layer::Remote),
            seconds: self.seconds_since(start),
        });
        value
    }

    /// Decode a frame's payload: envelope, then codec, with diagnostics.
    pub(crate) async fn decode(
        &self,
        frame: &Frame,
        layer: Layer,
    ) -> Result<StoredValue, BoxError> {
        let decompress_started = self.elapsed();
        let expanded = decompress_payload(frame.payload.clone(), MAX_DECOMPRESSED_BYTES);
        if let Some(outcome) = expanded.outcome {
            self.emit(Event::Compression {
                labels: self.labels(layer),
                outcome,
            });
            self.emit(Event::CompressionDuration {
                labels: self.labels(layer),
                operation: CompressionOperation::Decompress,
                seconds: self.seconds_since(decompress_started),
            });
        }
        let start = self.elapsed();
        let codec = self.op.codec.clone();
        let decoded = match AssertUnwindSafe(codec.decode(expanded.payload))
            .catch_unwind()
            .await
        {
            Ok(result) => result,
            Err(payload) => Err(Box::new(PanicError(panic_message(payload))) as BoxError),
        };
        if decoded.is_err() {
            self.error_event(layer, ErrorKind::SerializationLoad, false);
        }
        self.emit(Event::Serialization {
            labels: self.labels(layer),
            operation: SerializationOperation::Load,
            seconds: self.seconds_since(start),
        });
        decoded
    }

    fn write_timestamp(&self, layer: Layer) -> Result<u64, BoxError> {
        let stamp = self.wall_ms();
        if stamp < 0 || stamp as u64 > MAX_SAFE_INTEGER {
            self.error_event(layer, ErrorKind::CacheWrite, false);
            return Err("DialCache write timestamp is outside the safe integer domain".into());
        }
        Ok(stamp as u64)
    }

    /// Prepare and dispatch one remote write. `Ok(false)` means the write was
    /// fenced or refused by `allowed`; `Ok(true)` means it was dispatched.
    pub(crate) async fn put_remote(
        &self,
        value: &StoredValue,
        fence: Option<u64>,
        layer: Layer,
        allowed: Option<&(dyn Fn() -> bool + Send + Sync)>,
    ) -> Result<bool, BoxError> {
        let fence = if self.identity.tracked { fence } else { None };
        if let Some(fence) = fence {
            let stamp = self.write_timestamp(layer)?;
            if stamp <= fence {
                return Ok(false);
            }
        }
        let start = self.elapsed();
        let codec = self.op.codec.clone();
        let encoded = match AssertUnwindSafe(codec.encode(value)).catch_unwind().await {
            Ok(result) => result,
            Err(payload) => Err(Box::new(PanicError(panic_message(payload))) as BoxError),
        };
        if encoded.is_err() {
            self.error_event(layer, ErrorKind::SerializationDump, false);
        }
        self.emit(Event::Serialization {
            labels: self.labels(layer),
            operation: SerializationOperation::Dump,
            seconds: self.seconds_since(start),
        });
        let mut payload = encoded?;
        self.emit(Event::Size {
            labels: self.labels(layer),
            bytes: payload.len() as u64,
        });
        match &self.core.compression {
            Some(config) => {
                let compress_started = self.elapsed();
                let compressed = match compress_payload(payload, config, MAX_DECOMPRESSED_BYTES) {
                    Ok(compressed) => compressed,
                    Err(error) => {
                        self.error_event(layer, ErrorKind::Compression, false);
                        return Err(Box::new(error));
                    }
                };
                payload = compressed.payload;
                self.emit(Event::Compression {
                    labels: self.labels(layer),
                    outcome: compressed.outcome,
                });
                if matches!(
                    compressed.outcome,
                    crate::observe::CompressionOutcome::Compressed
                        | crate::observe::CompressionOutcome::NotSmaller
                ) {
                    self.emit(Event::CompressionDuration {
                        labels: self.labels(layer),
                        operation: CompressionOperation::Compress,
                        seconds: self.seconds_since(compress_started),
                    });
                }
                if compressed.outcome == crate::observe::CompressionOutcome::Compressed {
                    self.emit(Event::CompressionRatio {
                        labels: self.labels(layer),
                        ratio: compressed.stored_bytes as f64 / compressed.original_bytes as f64,
                    });
                }
            }
            None => payload = escape_raw_payload(payload),
        }
        self.emit(Event::StoredSize {
            labels: self.labels(layer),
            bytes: payload.len() as u64,
        });
        if let Some(allowed) = allowed {
            if !allowed() {
                return Ok(false);
            }
        }
        let stamp = self.write_timestamp(layer)?;
        if let Some(fence) = fence {
            if stamp <= fence {
                return Ok(false);
            }
        }
        let mut ttl = if self.policy.stale_on_error_max_age_ms > 0 {
            self.policy.stale_on_error_max_age_ms
        } else {
            self.policy.remote.ttl_ms
        };
        if self.identity.tracked && ttl > MAX_TRACKED_VALUE_TTL_MS {
            ttl = MAX_TRACKED_VALUE_TTL_MS;
            self.error_event(layer, ErrorKind::TrackedTtlClamped, false);
        }
        let remote = self
            .core
            .remote
            .clone()
            .expect("remote layer requires an adapter");
        let request = WriteRequest {
            value_key: self.keys.value.clone(),
            frame: Frame {
                created_at_ms: stamp,
                payload,
            },
            ttl_ms: ttl,
        };
        let pending: Settled<Result<(), SharedError>> = start_pending(
            self.core.runtime.as_ref(),
            async move {
                remote
                    .write(request)
                    .await
                    .map_err(|e| Arc::from(e) as SharedError)
            },
            |message| Err(Arc::new(PanicError(message)) as SharedError),
        );
        match pending.wait().await {
            Ok(()) => Ok(true),
            Err(error) => {
                self.error_event(layer, ErrorKind::CacheWrite, false);
                Err(Box::new(SharedErrorWrapper(error)))
            }
        }
    }

    pub(crate) fn can_recover(&self, error: &Error) -> bool {
        let predicate = self
            .op
            .should_recover
            .clone()
            .or_else(|| self.core.should_recover.clone());
        match predicate {
            None => error.is_fallback_timeout(),
            Some(predicate) => match catch_unwind(AssertUnwindSafe(|| predicate(error))) {
                Ok(allowed) => allowed,
                Err(payload) => {
                    self.core
                        .log(LogEvent::RecoveryPredicateFailed(Box::new(PanicError(
                            panic_message(payload),
                        ))));
                    false
                }
            },
        }
    }

    fn recovery_event(&self, outcome: RecoveryOutcome, age_ms: Option<i64>) {
        self.emit(Event::StaleRecovery {
            labels: self.labels.clone(),
            outcome,
        });
        if let Some(age) = age_ms {
            self.emit(Event::StaleRecoveryValueAge {
                labels: self.labels.clone(),
                outcome,
                seconds: age.max(0) as f64 / 1000.0,
            });
        }
    }

    /// Serve the retained stale candidate after an authorized source failure.
    async fn recover(&self, frame: Option<&Frame>) -> Option<StoredValue> {
        let Some(frame) = frame else {
            self.recovery_event(RecoveryOutcome::Miss, None);
            return None;
        };
        let max_age = self.policy.stale_on_error_max_age_ms;
        let (age, valid) = self.frame_age(frame, Layer::Remote);
        if !valid || age as u64 >= max_age {
            self.recovery_event(RecoveryOutcome::Miss, None);
            return None;
        }
        let value = match self.decode(frame, Layer::Remote).await {
            Ok(value) => value,
            Err(error) => {
                self.core.log(LogEvent::RecoveryDecodeFailed(error));
                self.recovery_event(RecoveryOutcome::DeserializationError, None);
                return None;
            }
        };
        let (age, valid) = self.frame_age(frame, Layer::Remote);
        if !valid || age as u64 >= max_age {
            self.recovery_event(RecoveryOutcome::Miss, None);
            return None;
        }
        self.recovery_event(RecoveryOutcome::Served, Some(age));
        Some(value)
    }
}
