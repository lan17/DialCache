//! Detached shadow validation: dark reads and fills on ramped-down remote
//! serving, and served-hit re-validation against the source of truth.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures::future::{select, Either};
use futures::FutureExt;
use parking_lot::Mutex;

use crate::deadline::{await_deadline, since};
use crate::engine::Core;
use crate::error::Error;
use crate::execution::{Execution, RawRead};
use crate::flight::{panic_message, start_pending, yield_deferred, Settled, ValueResult};
use crate::limits::DEFAULT_FALLBACK_TIMEOUT_MS;
use crate::local::StoredValue;
use crate::observe::{
    ErrorKind, Event, Layer, LogEvent, MissReason, ShadowMismatchDetails, ShadowOutcome,
};
use crate::preview::{preview_key, preview_value};
use crate::remote::{Frame, ReadResult};

/// One admitted shadow job holding an instance slot.
/// One held entry of the instance-wide shadow table. Dropping it frees the
/// slot, so a job dropped unpolled at runtime shutdown cannot pin capacity.
pub(crate) struct ShadowSlot {
    core: Arc<Core>,
    key: String,
    flight: Arc<ShadowFlight>,
}

impl Drop for ShadowSlot {
    fn drop(&mut self) {
        let mut state = self.core.state.lock();
        if state
            .shadows
            .get(&self.key)
            .is_some_and(|f| Arc::ptr_eq(f, &self.flight))
        {
            state.shadows.remove(&self.key);
        }
    }
}

pub(crate) struct ShadowFlight {
    abandoned: AtomicBool,
    stop: Settled<()>,
}

impl ShadowFlight {
    fn new() -> Arc<Self> {
        Arc::new(ShadowFlight {
            abandoned: AtomicBool::new(false),
            stop: Settled::new(),
        })
    }

    fn abandon(&self) {
        self.abandoned.store(true, Ordering::SeqCst);
        self.stop.settle(());
    }

    fn is_abandoned(&self) -> bool {
        self.abandoned.load(Ordering::SeqCst)
    }
}

#[derive(Clone)]
struct Verdict {
    outcome: ShadowOutcome,
    age_ms: Option<i64>,
    compared: Option<(StoredValue, StoredValue)>,
}

impl Verdict {
    fn of(outcome: ShadowOutcome) -> Verdict {
        Verdict {
            outcome,
            age_ms: None,
            compared: None,
        }
    }
}

impl Execution {
    /// Run the caller's source while a dark shadow job reads and may fill the
    /// ramped-down remote layer without delaying the caller.
    pub(crate) async fn dark_source(
        self: &Arc<Self>,
        layer: Layer,
        local_miss: bool,
    ) -> ValueResult {
        let start = self.elapsed();
        let source: Settled<ValueResult> = start_pending(
            self.core.runtime.as_ref(),
            {
                let x = self.clone();
                async move { x.source(layer).await }
            },
            |message| Err(Error::Panic(message)),
        );
        self.schedule_shadow(None, Some(source.clone()), start);
        let result = source.wait().await;
        if let Ok(value) = &result {
            if local_miss {
                self.put_local(value.clone());
            }
        }
        result
    }

    /// Admit one shadow job for this key if policy, the outcome hook and
    /// instance capacity allow it.
    pub(crate) fn schedule_shadow(
        self: &Arc<Self>,
        frame: Option<Frame>,
        source: Option<Settled<ValueResult>>,
        started: Duration,
    ) {
        let p = self.policy.shadow;
        if p.config_error {
            self.error_event(Layer::Remote, ErrorKind::ConfigResolution, false);
            return;
        }
        if !p.enabled || !self.core.shadow_hook_enabled() {
            return;
        }
        let flight = {
            let mut state = self.core.state.lock();
            if state.shadows.contains_key(&self.keys.logical)
                || state.shadows.len() >= self.core.shadow_max_in_flight
            {
                drop(state);
                self.shadow_event(Verdict::of(ShadowOutcome::Dropped));
                return;
            }
            let flight = ShadowFlight::new();
            state
                .shadows
                .insert(self.keys.logical.clone(), flight.clone());
            flight
        };
        let slot = ShadowSlot {
            core: self.core.clone(),
            key: self.keys.logical.clone(),
            flight: flight.clone(),
        };
        if p.logging_config_error {
            self.error_event(Layer::Remote, ErrorKind::ConfigResolution, false);
        }
        let x = self.clone();
        self.core.runtime.defer(Box::pin(async move {
            x.run_shadow(flight, frame, source, started, slot).await
        }));
    }

    fn shadow_event(&self, verdict: Verdict) {
        self.emit(Event::ShadowValidation {
            labels: self.labels.clone(),
            outcome: verdict.outcome,
        });
        if let Some(age) = verdict.age_ms {
            self.emit(Event::ShadowValueAge {
                labels: self.labels.clone(),
                outcome: verdict.outcome,
                seconds: age.max(0) as f64 / 1000.0,
            });
        }
        if verdict.outcome == ShadowOutcome::Mismatch && self.policy.shadow.log_mismatches {
            let preview = |value: &StoredValue| -> Option<String> {
                let preview = self.op.preview.as_ref()?;
                catch_unwind(AssertUnwindSafe(|| preview(value)))
                    .ok()
                    .flatten()
                    .map(|json| preview_value(&json))
            };
            let (cached, source) = match &verdict.compared {
                Some((cached, source)) => (preview(cached), preview(source)),
                None => (None, None),
            };
            self.core
                .log(LogEvent::ShadowMismatch(ShadowMismatchDetails {
                    namespace: self.labels.namespace.clone(),
                    use_case: self.labels.use_case.clone(),
                    key_type: self.labels.key_type.clone(),
                    cache_key: preview_key(&self.keys.logical),
                    cached_value_json: cached,
                    source_value_json: source,
                }));
        }
    }

    async fn run_shadow(
        self: Arc<Self>,
        flight: Arc<ShadowFlight>,
        frame: Option<Frame>,
        source: Option<Settled<ValueResult>>,
        started: Duration,
        slot: ShadowSlot,
    ) {
        let clock = self.core.clock.clone();
        let started = if source.is_none() {
            clock.elapsed()
        } else {
            started
        };
        let budget_ms = self
            .op
            .budget
            .millis()
            .unwrap_or(DEFAULT_FALLBACK_TIMEOUT_MS);
        let reads: Arc<Mutex<Vec<Settled<RawRead>>>> = Arc::new(Mutex::new(Vec::new()));
        let validation: Settled<Verdict> = start_pending(
            self.core.runtime.as_ref(),
            {
                let x = self.clone();
                let flight = flight.clone();
                let reads = reads.clone();
                async move {
                    let verdict = match AssertUnwindSafe(x.clone().validate(
                        flight.clone(),
                        frame,
                        source,
                        started,
                        budget_ms,
                        reads.clone(),
                    ))
                    .catch_unwind()
                    .await
                    {
                        Ok(verdict) => verdict,
                        Err(_) => Verdict::of(ShadowOutcome::Timeout),
                    };
                    // Reads keep the slot after a read timeout; owned source, codec and
                    // write work already keeps this operation running until raw completion.
                    // Dropping the slot frees it, whether the reads settled or the
                    // runtime dropped this task first.
                    let pending = std::mem::take(&mut *reads.lock());
                    let runtime = x.core.runtime.clone();
                    runtime.spawn(Box::pin(async move {
                        for read in pending {
                            let _ = read.wait().await;
                        }
                        drop(slot);
                    }));
                    verdict
                }
            },
            |_| Verdict::of(ShadowOutcome::Timeout),
        );
        let verdict = await_deadline(
            clock.as_ref(),
            self.core.runtime.as_ref(),
            &validation,
            started,
            Some(budget_ms),
            || {
                flight.abandon();
                Verdict::of(ShadowOutcome::Timeout)
            },
        )
        .await;
        self.shadow_event(verdict);
    }

    async fn shadow_read(
        &self,
        reads: &Mutex<Vec<Settled<RawRead>>>,
        max_age: bool,
        retain_future: bool,
    ) -> RawRead {
        let begin = self.elapsed();
        self.emit(Event::Request {
            labels: self.labels(Layer::RemoteShadow),
        });
        let (bounded, raw) = self.raw_read();
        reads.lock().push(raw);
        let result = bounded.await;
        let result = match result {
            Err(error) => {
                let kind = if error
                    .downcast_ref::<crate::error::RemoteReadTimeout>()
                    .is_some()
                {
                    ErrorKind::CacheReadTimeout
                } else {
                    ErrorKind::CacheRead
                };
                self.error_event(Layer::RemoteShadow, kind, false);
                Err(error)
            }
            Ok(mut read) => {
                if let ReadResult::Hit(frame) = &read {
                    let (age, valid) = self.frame_age(frame, Layer::RemoteShadow);
                    if !valid && !(retain_future && age < 0) {
                        read = ReadResult::miss(MissReason::Unclassified);
                    } else if max_age && valid && age as u64 >= self.policy.remote.ttl_ms {
                        read = ReadResult::miss(MissReason::Expired);
                    }
                }
                if let ReadResult::Miss { reason, .. } = &read {
                    self.emit(Event::Miss {
                        labels: self.labels(Layer::RemoteShadow),
                        reason: *reason,
                    });
                }
                Ok(read)
            }
        };
        self.emit(Event::Get {
            labels: self.labels(Layer::RemoteShadow),
            seconds: self.seconds_since(begin),
        });
        result
    }

    async fn validate(
        self: Arc<Self>,
        flight: Arc<ShadowFlight>,
        mut frame: Option<Frame>,
        source: Option<Settled<ValueResult>>,
        started: Duration,
        budget_ms: u64,
        reads: Arc<Mutex<Vec<Settled<RawRead>>>>,
    ) -> Verdict {
        let clock = self.core.clock.clone();
        let budget = Duration::from_millis(budget_ms);
        let expired = || {
            if since(clock.as_ref(), started) >= budget {
                flight.abandon();
            }
            flight.is_abandoned()
        };
        if expired() {
            return Verdict::of(ShadowOutcome::Timeout);
        }
        let mut fill = false;
        let mut fence: Option<u64> = None;
        if source.is_some() {
            let read = match self.shadow_read(&reads, true, false).await {
                Ok(read) => read,
                Err(_) => return Verdict::of(ShadowOutcome::RedisError),
            };
            if expired() {
                return Verdict::of(ShadowOutcome::Timeout);
            }
            match read {
                ReadResult::Miss {
                    observed_watermark_ms,
                    ..
                } => {
                    fill = true;
                    fence = observed_watermark_ms;
                }
                ReadResult::Hit(read_frame) => frame = Some(read_frame),
            }
        }
        let value: ValueResult = match &source {
            Some(source) => {
                let result = match select(source.wait(), flight.stop.wait()).await {
                    Either::Left((result, _)) => result,
                    Either::Right(((), _)) => return Verdict::of(ShadowOutcome::Timeout),
                };
                if result.is_ok() {
                    // Let the caller finish its own continuation before any shadow
                    // decode, comparison or dump work.
                    yield_deferred(self.core.runtime.as_ref()).await;
                }
                result
            }
            None => {
                let disabled = self.scope.disabled_view();
                let future = (self.op.load)(disabled);
                match AssertUnwindSafe(future).catch_unwind().await {
                    Ok(Ok(value)) => Ok(value),
                    Ok(Err(error)) => Err(Error::Source(Arc::from(error))),
                    Err(payload) => Err(Error::Panic(panic_message(payload))),
                }
            }
        };
        let value = match value {
            Ok(value) => value,
            Err(_) => {
                if source.is_some() && self.timed_out.load(Ordering::SeqCst) {
                    return Verdict::of(ShadowOutcome::Timeout);
                }
                return Verdict::of(ShadowOutcome::SourceError);
            }
        };
        if expired() {
            return Verdict::of(ShadowOutcome::Timeout);
        }
        if fill {
            let allowed = || !expired();
            let filled = self
                .put_remote(&value, fence, Layer::RemoteShadow, Some(&allowed))
                .await;
            if expired() {
                return Verdict::of(ShadowOutcome::Timeout);
            }
            return match filled {
                Ok(true) => Verdict::of(ShadowOutcome::Filled),
                Ok(false) => Verdict::of(ShadowOutcome::FillFenced),
                Err(error) => {
                    self.core.log(LogEvent::ShadowFillFailed(error));
                    Verdict::of(ShadowOutcome::FillError)
                }
            };
        }
        let Some(frame) = frame else {
            return Verdict::of(ShadowOutcome::Timeout);
        };
        let cached = match self.decode(&frame, Layer::RemoteShadow).await {
            Ok(cached) => cached,
            Err(_) => return Verdict::of(ShadowOutcome::DeserializationError),
        };
        if expired() {
            return Verdict::of(ShadowOutcome::Timeout);
        }
        let compare = self.op.compare.clone();
        let matches = match catch_unwind(AssertUnwindSafe(|| compare(&cached, &value))) {
            Ok(Ok(matches)) => matches,
            _ => return Verdict::of(ShadowOutcome::ComparisonError),
        };
        if expired() {
            return Verdict::of(ShadowOutcome::Timeout);
        }
        let age = self
            .wall_ms()
            .saturating_sub(frame.created_at_ms.min(i64::MAX as u64) as i64);
        if matches {
            return Verdict {
                outcome: ShadowOutcome::Match,
                age_ms: Some(age),
                compared: None,
            };
        }
        let confirmation = match self.shadow_read(&reads, false, true).await {
            Ok(confirmation) => confirmation,
            Err(_) => return Verdict::of(ShadowOutcome::ConfirmationError),
        };
        if expired() {
            return Verdict::of(ShadowOutcome::Timeout);
        }
        match confirmation {
            ReadResult::Hit(confirmed) if confirmed.payload.bytes == frame.payload.bytes => {}
            _ => return Verdict::of(ShadowOutcome::Superseded),
        }
        let age = self
            .wall_ms()
            .saturating_sub(frame.created_at_ms.min(i64::MAX as u64) as i64);
        Verdict {
            outcome: ShadowOutcome::Mismatch,
            age_ms: Some(age),
            compared: Some((cached, value)),
        }
    }
}
