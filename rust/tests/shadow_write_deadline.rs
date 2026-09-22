//! A prepared shadow fill may wait in the runtime before its adapter is invoked.
use std::future::ready;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use dialcache::observe::{Layer, ShadowOutcome};
use dialcache::testing::{StepRuntime, TestExecutor, VirtualClock, WALL_EPOCH_MS};
use dialcache::{
    BoxError, Clock, DialCache, Event, Identity, InvalidateRequest, MissReason, Observer,
    Operation, Policy, ReadContext, ReadRequest, ReadResult, Remote, Runtime, ShadowPolicy,
    SourceBudget, WriteRequest,
};
use futures::future::BoxFuture;
use parking_lot::Mutex;

struct GatedRuntime {
    step: Arc<StepRuntime>,
    hold: AtomicBool,
    pending: Mutex<Vec<BoxFuture<'static, ()>>>,
}

impl Runtime for GatedRuntime {
    fn spawn(&self, task: BoxFuture<'static, ()>) {
        if self.hold.load(Ordering::SeqCst) {
            self.pending.lock().push(task);
        } else {
            self.step.spawn(task);
        }
    }

    fn defer(&self, task: BoxFuture<'static, ()>) {
        self.step.defer(task);
    }

    fn sleep(&self, delay: Duration) -> BoxFuture<'static, ()> {
        self.step.sleep(delay)
    }
}

impl GatedRuntime {
    fn release(&self) {
        self.hold.store(false, Ordering::SeqCst);
        for task in std::mem::take(&mut *self.pending.lock()) {
            self.step.spawn(task);
        }
    }
}

struct RecordingRemote {
    clock: Arc<VirtualClock>,
    writes: Mutex<Vec<Duration>>,
}

impl Remote for RecordingRemote {
    fn read(&self, _: ReadRequest, _: ReadContext) -> BoxFuture<'_, Result<ReadResult, BoxError>> {
        Box::pin(ready(Ok(ReadResult::miss(MissReason::ValueAbsent))))
    }

    fn write(&self, _: WriteRequest) -> BoxFuture<'_, Result<(), BoxError>> {
        self.writes.lock().push(self.clock.elapsed());
        Box::pin(ready(Ok(())))
    }

    fn invalidate(&self, _: InvalidateRequest) -> BoxFuture<'_, Result<(), BoxError>> {
        Box::pin(ready(Ok(())))
    }
}

struct Events {
    runtime: Arc<GatedRuntime>,
    outcomes: Mutex<Vec<ShadowOutcome>>,
}

impl Observer for Events {
    fn observes_shadow_outcomes(&self) -> bool {
        true
    }

    fn observe(&self, event: &Event) {
        match event {
            Event::StoredSize { labels, .. } if labels.layer == Layer::RemoteShadow => {
                self.runtime.hold.store(true, Ordering::SeqCst);
            }
            Event::ShadowValidation { outcome, .. } => self.outcomes.lock().push(*outcome),
            _ => {}
        }
    }
}

fn invoke(executor: &mut TestExecutor, cache: &DialCache) {
    let cache = cache.clone();
    let value = executor.block_on(async move {
        let request = cache.enable_guard();
        cache
            .get_or_load(
                request.scope(),
                Operation::<u64>::new(Identity::new("thing", "one", "QueuedWrite"))
                    .policy(
                        Policy::default()
                            .remote_ttl_sec(60)
                            .remote_ramp(0.0)
                            .shadow(ShadowPolicy {
                                ramp: Some(100.0),
                                log_mismatches: None,
                            }),
                    )
                    .budget(SourceBudget::Millis(5)),
                |_| ready(Ok(7)),
            )
            .await
            .expect("shadow scheduling must preserve source success")
    });
    assert_eq!(*value, 7);
}

#[test]
fn shadow_writes_start_only_before_the_deadline_even_when_task_starts_are_delayed() {
    for (delay, deliver) in [(0, false), (5, false), (5, true), (10, true)] {
        let mut executor = TestExecutor::new(WALL_EPOCH_MS);
        let runtime = Arc::new(GatedRuntime {
            step: executor.runtime.clone(),
            hold: AtomicBool::new(false),
            pending: Mutex::new(Vec::new()),
        });
        let remote = Arc::new(RecordingRemote {
            clock: executor.clock.clone(),
            writes: Mutex::new(Vec::new()),
        });
        let events = Arc::new(Events {
            runtime: runtime.clone(),
            outcomes: Mutex::new(Vec::new()),
        });
        let cache = DialCache::builder()
            .clock_arc(executor.clock.clone())
            .runtime_arc(runtime.clone())
            .remote_arc(remote.clone())
            .observer_arc(events.clone())
            .shadow_max_in_flight(1)
            .build()
            .unwrap();
        invoke(&mut executor, &cache);
        executor.advance(delay, deliver);
        runtime.release();
        executor.drain();

        let writes = remote.writes.lock().clone();
        assert!(
            writes.iter().all(|at| *at < Duration::from_millis(5)),
            "adapter called after shadow deadline: {writes:?}, delay={delay}, timers={deliver}"
        );
        if delay == 0 {
            assert_eq!(writes.len(), 1, "control must actually fill");
        }
        assert_eq!(
            *events.outcomes.lock(),
            vec![if writes.is_empty() {
                ShadowOutcome::Timeout
            } else {
                ShadowOutcome::Filled
            }]
        );

        // The completed/skipped raw write must release the only shadow slot.
        let before = writes.len();
        invoke(&mut executor, &cache);
        runtime.release();
        executor.drain();
        assert_eq!(remote.writes.lock().len(), before + 1);
        assert_eq!(events.outcomes.lock().last(), Some(&ShadowOutcome::Filled));
    }
}
