//! Native scheduling and ownership tests for built-in CPU work.
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use futures::future::BoxFuture;
use parking_lot::Mutex;

use crate::observe::ShadowOutcome;
use crate::protocol::{compress_payload, CompressionConfig};
use crate::testing::{StepRuntime, TestExecutor, WALL_EPOCH_MS};
use crate::*;

type Job = Box<dyn FnOnce() + Send>;
struct CpuRuntime {
    step: Arc<StepRuntime>,
    jobs: Mutex<VecDeque<Job>>,
    reject: AtomicBool,
}
impl Runtime for CpuRuntime {
    fn spawn(&self, task: BoxFuture<'static, ()>) {
        self.step.spawn(task);
    }
    fn defer(&self, task: BoxFuture<'static, ()>) {
        self.step.defer(task);
    }
    fn sleep(&self, delay: Duration) -> BoxFuture<'static, ()> {
        self.step.sleep(delay)
    }
    fn spawn_blocking(&self, task: Job) -> Result<(), BoxError> {
        if self.reject.load(Ordering::SeqCst) {
            return Err("test CPU rejection".into());
        }
        self.jobs.lock().push_back(task);
        Ok(())
    }
}
impl CpuRuntime {
    fn take(&self) -> Job {
        self.jobs.lock().pop_front().expect("CPU work admitted")
    }
}
struct SnapshotRemote {
    result: ReadResult,
    writes: AtomicUsize,
}
impl Remote for SnapshotRemote {
    fn read(&self, _: ReadRequest, _: ReadContext) -> BoxFuture<'_, Result<ReadResult, BoxError>> {
        Box::pin(std::future::ready(Ok(self.result.clone())))
    }
    fn write(&self, _: WriteRequest) -> BoxFuture<'_, Result<(), BoxError>> {
        self.writes.fetch_add(1, Ordering::SeqCst);
        Box::pin(std::future::ready(Ok(())))
    }
    fn invalidate(&self, _: InvalidateRequest) -> BoxFuture<'_, Result<(), BoxError>> {
        Box::pin(std::future::ready(Ok(())))
    }
}
#[derive(Default)]
struct Events(Mutex<Vec<ShadowOutcome>>);
impl Observer for Events {
    fn observes_shadow_outcomes(&self) -> bool {
        true
    }
    fn observe(&self, event: &Event) {
        if let Event::ShadowValidation { outcome, .. } = event {
            self.0.lock().push(*outcome);
        }
    }
}
struct TextCodec(Arc<AtomicUsize>);
impl SyncCodec<String> for TextCodec {
    fn encode(&self, text: &String) -> Result<Payload, BoxError> {
        Ok(Payload::text(text.clone()))
    }
    fn decode(&self, payload: Payload) -> Result<String, BoxError> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Ok(payload.as_text().into_owned())
    }
}
fn text() -> String {
    "a".repeat(128 * 1024)
}
fn snapshot(decode: bool) -> ReadResult {
    if decode {
        ReadResult::Hit(Frame {
            created_at_ms: WALL_EPOCH_MS as u64,
            payload: compress_payload(
                Payload::text(text()),
                &CompressionConfig::default(),
                limits::MAX_DECOMPRESSED_BYTES,
            )
            .unwrap()
            .payload,
        })
    } else {
        ReadResult::miss(MissReason::ValueAbsent)
    }
}
fn operation(decodes: &Arc<AtomicUsize>, shadow: bool) -> Operation<String> {
    let mut policy = Policy::default().remote_ttl_sec(60);
    if shadow {
        policy = policy.remote_ramp(0.0).shadow(ShadowPolicy {
            ramp: Some(100.0),
            log_mismatches: None,
        });
    }
    Operation::with_codec(
        Identity::new("thing", "one", "CPU"),
        Arc::new(FromSync(TextCodec(decodes.clone()))),
        |a, b| a == b,
    )
    .policy(policy)
    .budget(SourceBudget::Millis(5))
}
fn setup(
    decode: bool,
) -> (
    TestExecutor,
    DialCache,
    Arc<CpuRuntime>,
    Arc<SnapshotRemote>,
    Arc<Events>,
) {
    let executor = TestExecutor::new(WALL_EPOCH_MS);
    let runtime = Arc::new(CpuRuntime {
        step: executor.runtime.clone(),
        jobs: Mutex::new(VecDeque::new()),
        reject: AtomicBool::new(false),
    });
    let remote = Arc::new(SnapshotRemote {
        result: snapshot(decode),
        writes: AtomicUsize::new(0),
    });
    let events = Arc::new(Events::default());
    let cache = DialCache::builder()
        .clock_arc(executor.clock.clone())
        .runtime_arc(runtime.clone())
        .remote_arc(remote.clone())
        .observer_arc(events.clone())
        .build()
        .unwrap();
    (executor, cache, runtime, remote, events)
}
fn invoke(executor: &mut TestExecutor, cache: &DialCache, op: Operation<String>) -> Arc<String> {
    let cache = cache.clone();
    executor.block_on(async move {
        let scope = cache.enable_guard();
        cache
            .get_or_load(scope.scope(), op, |_| async { Ok(text()) })
            .await
            .unwrap()
    })
}

#[test]
fn rejected_cpu_work_fails_open_through_the_cache_api() {
    for decode in [false, true] {
        let (mut executor, cache, runtime, remote, events) = setup(decode);
        runtime.reject.store(true, Ordering::SeqCst);
        let decodes = Arc::new(AtomicUsize::new(0));
        for shadow in [false, true] {
            for _ in 0..2 {
                assert_eq!(
                    *invoke(&mut executor, &cache, operation(&decodes, shadow)),
                    text()
                );
            }
            assert!(cache.core.state.lock().flights.is_empty());
            assert!(cache.core.state.lock().shadows.is_empty());
        }
        assert_eq!(remote.writes.load(Ordering::SeqCst), 0);
        assert_eq!(decodes.load(Ordering::SeqCst), 0);
        assert_eq!(
            *events.0.lock(),
            vec![
                if decode {
                    ShadowOutcome::DeserializationError
                } else {
                    ShadowOutcome::FillError
                };
                2
            ]
        );
    }
}

#[test]
fn shadow_deadline_keeps_cpu_ownership_and_prevents_subsequent_phases() {
    for decode in [false, true] {
        for deliver in [false, true] {
            let (mut executor, cache, runtime, remote, events) = setup(decode);
            let decodes = Arc::new(AtomicUsize::new(0));
            invoke(&mut executor, &cache, operation(&decodes, true));
            assert_eq!(cache.core.state.lock().shadows.len(), 1);
            assert_eq!(runtime.jobs.lock().len(), 1);
            executor.advance(5, deliver);
            assert_eq!(
                cache.core.state.lock().shadows.len(),
                1,
                "timeout released raw CPU ownership"
            );
            runtime.take()();
            executor.drain();
            assert_eq!(*events.0.lock(), vec![ShadowOutcome::Timeout]);
            assert_eq!(
                decodes.load(Ordering::SeqCst),
                0,
                "codec ran after decode deadline"
            );
            assert_eq!(
                remote.writes.load(Ordering::SeqCst),
                0,
                "write ran after compression deadline"
            );
            assert!(cache.core.state.lock().shadows.is_empty());
        }
    }
}

#[test]
fn queued_cpu_job_keeps_shadow_slot_after_executor_shutdown() {
    for discard in [false, true] {
        let (mut executor, cache, runtime, _, _) = setup(false);
        invoke(
            &mut executor,
            &cache,
            operation(&Arc::new(AtomicUsize::new(0)), true),
        );
        drop(executor);
        assert_eq!(cache.core.state.lock().shadows.len(), 1);
        let job = runtime.take();
        if discard {
            drop(job);
        } else {
            job();
        }
        assert!(cache.core.state.lock().shadows.is_empty());
    }
}

#[test]
fn running_cpu_job_keeps_shadow_slot_after_executor_shutdown() {
    let (mut executor, cache, runtime, _, _) = setup(false);
    invoke(
        &mut executor,
        &cache,
        operation(&Arc::new(AtomicUsize::new(0)), true),
    );
    let job = runtime.take();
    let (started, running) = std::sync::mpsc::channel();
    let (release, gate) = std::sync::mpsc::channel();
    let worker = std::thread::spawn(move || {
        started.send(()).unwrap();
        gate.recv_timeout(Duration::from_secs(5)).unwrap();
        job();
    });
    running.recv_timeout(Duration::from_secs(5)).unwrap();
    drop(executor);
    assert_eq!(cache.core.state.lock().shadows.len(), 1);
    release.send(()).unwrap();
    worker.join().unwrap();
    assert!(cache.core.state.lock().shadows.is_empty());
}

#[cfg(feature = "tokio")]
#[tokio::test(flavor = "current_thread")]
async fn large_codec_phases_allow_an_independent_short_timer_to_progress() {
    struct GatedRuntime {
        inner: TokioRuntime,
        started: tokio::sync::mpsc::UnboundedSender<std::thread::ThreadId>,
        release: Arc<Mutex<std::sync::mpsc::Receiver<()>>>,
    }
    impl Runtime for GatedRuntime {
        fn spawn(&self, task: BoxFuture<'static, ()>) {
            self.inner.spawn(task);
        }
        fn sleep(&self, delay: Duration) -> BoxFuture<'static, ()> {
            self.inner.sleep(delay)
        }
        fn spawn_blocking(&self, task: Job) -> Result<(), BoxError> {
            let started = self.started.clone();
            let release = self.release.clone();
            self.inner.spawn_blocking(Box::new(move || {
                started.send(std::thread::current().id()).unwrap();
                release.lock().recv_timeout(Duration::from_secs(5)).unwrap();
                task();
            }))
        }
    }
    for decode in [false, true] {
        let (started, mut started_rx) = tokio::sync::mpsc::unbounded_channel();
        let (release, gate) = std::sync::mpsc::channel();
        let runtime = GatedRuntime {
            inner: TokioRuntime::current().unwrap(),
            started,
            release: Arc::new(Mutex::new(gate)),
        };
        let remote = Arc::new(SnapshotRemote {
            result: snapshot(decode),
            writes: AtomicUsize::new(0),
        });
        let cache = DialCache::builder()
            .clock_arc(crate::testing::VirtualClock::new(WALL_EPOCH_MS))
            .runtime(runtime)
            .remote_arc(remote)
            .build()
            .unwrap();
        let decodes = Arc::new(AtomicUsize::new(0));
        let op = operation(&decodes, false);
        let pending = tokio::spawn(async move {
            let guard = cache.enable_guard();
            cache
                .get_or_load(guard.scope(), op, |_| async { Ok(text()) })
                .await
                .unwrap()
        });
        let worker = tokio::time::timeout(Duration::from_secs(5), started_rx.recv())
            .await
            .unwrap()
            .unwrap();
        assert_ne!(worker, std::thread::current().id());
        tokio::time::sleep(Duration::from_millis(2)).await;
        assert!(!pending.is_finished(), "the CPU gate should still be held");
        release.send(()).unwrap();
        assert_eq!(
            *tokio::time::timeout(Duration::from_secs(5), pending)
                .await
                .unwrap()
                .unwrap(),
            text()
        );
        assert_eq!(decodes.load(Ordering::SeqCst), usize::from(decode));
    }
}

#[derive(Default)]
struct Logs(Mutex<Vec<ShadowMismatchDetails>>);
impl Logger for Logs {
    fn log(&self, event: &LogEvent) {
        if let LogEvent::ShadowMismatch(details) = event {
            self.0.lock().push(details.clone());
        }
    }
}
fn preview_setup() -> (
    TestExecutor,
    DialCache,
    Arc<CpuRuntime>,
    Arc<Events>,
    Arc<Logs>,
) {
    let executor = TestExecutor::new(WALL_EPOCH_MS);
    let runtime = Arc::new(CpuRuntime {
        step: executor.runtime.clone(),
        jobs: Mutex::new(VecDeque::new()),
        reject: AtomicBool::new(false),
    });
    let events = Arc::new(Events::default());
    let logs = Arc::new(Logs::default());
    let cache = DialCache::builder()
        .clock_arc(executor.clock.clone())
        .runtime_arc(runtime.clone())
        .observer_arc(events.clone())
        .logger_arc(logs.clone())
        .remote(SnapshotRemote {
            result: ReadResult::Hit(Frame {
                created_at_ms: WALL_EPOCH_MS as u64,
                payload: Payload::text(serde_json::to_string(&"é".repeat(10_000)).unwrap()),
            }),
            writes: AtomicUsize::new(0),
        })
        .build()
        .unwrap();
    (executor, cache, runtime, events, logs)
}
fn preview_call(
    executor: &mut TestExecutor,
    cache: &DialCache,
    registered: bool,
    preview: Option<crate::operation::Preview<String>>,
) {
    let cache = cache.clone();
    executor.block_on(async move {
        let guard = cache.enable_guard();
        let policy = Policy::default().remote_ttl_sec(60).shadow(ShadowPolicy {
            ramp: Some(100.0),
            log_mismatches: Some(true),
        });
        let result = if registered {
            let use_case = cache
                .use_case::<(), String>("thing", "Preview")
                .policy(policy)
                .key(|_| KeySpec::new("one"))
                .source(|_, ()| async { Ok("source".to_owned()) })
                .register()
                .unwrap();
            use_case.get(guard.scope(), ()).await
        } else {
            let mut operation =
                Operation::<String>::new(Identity::new("thing", "one", "Preview")).policy(policy);
            if let Some(preview) = preview {
                operation.preview = Some(preview);
            }
            cache
                .get_or_load(guard.scope(), operation, |_| async {
                    Ok("source".to_owned())
                })
                .await
        };
        assert_eq!(*result.unwrap(), "é".repeat(10_000));
    });
}

#[test]
fn both_default_apis_prepare_bounded_previews_without_holding_the_caller() {
    for registered in [false, true] {
        let (mut executor, cache, runtime, events, logs) = preview_setup();
        preview_call(&mut executor, &cache, registered, None);
        assert_eq!(*events.0.lock(), vec![ShadowOutcome::Mismatch]);
        assert!(logs.0.lock().is_empty());
        assert_eq!(runtime.jobs.lock().len(), 1);
        assert_eq!(cache.core.state.lock().shadows.len(), 1);
        // An inline call uses the same identity as the registered handle.
        preview_call(&mut executor, &cache, false, None);
        assert_eq!(
            *events.0.lock(),
            vec![ShadowOutcome::Mismatch, ShadowOutcome::Dropped]
        );
        executor.advance(10_000, true);
        runtime.take()();
        executor.drain();
        assert!(cache.core.state.lock().shadows.is_empty());
        let messages = logs.0.lock();
        assert_eq!(messages.len(), 1);
        assert_eq!(
            messages[0].cached_value_json,
            crate::preview::json_preview(&"é".repeat(10_000))
        );
        assert_eq!(messages[0].source_value_json.as_deref(), Some("\"source\""));
        assert_eq!(
            *events.0.lock(),
            vec![ShadowOutcome::Mismatch, ShadowOutcome::Dropped]
        );
    }
}

#[test]
fn rejected_preview_cpu_work_still_logs_the_confirmed_mismatch() {
    let (mut executor, cache, runtime, events, logs) = preview_setup();
    runtime.reject.store(true, Ordering::SeqCst);
    preview_call(&mut executor, &cache, false, None);
    assert_eq!(*events.0.lock(), vec![ShadowOutcome::Mismatch]);
    assert!(runtime.jobs.lock().is_empty());
    assert!(cache.core.state.lock().shadows.is_empty());
    let messages = logs.0.lock();
    assert_eq!(messages.len(), 1);
    assert!(messages[0].cached_value_json.is_none());
    assert!(messages[0].source_value_json.is_none());
}

#[test]
fn custom_preview_failures_are_isolated_per_value_and_success_is_clamped() {
    for panic in [false, true] {
        let (mut executor, cache, runtime, _, logs) = preview_setup();
        preview_call(
            &mut executor,
            &cache,
            false,
            Some(Arc::new(move |value| {
                if value == "source" {
                    Some("🙂".repeat(10_000))
                } else if panic {
                    panic!("bad cached preview");
                } else {
                    None
                }
            })),
        );
        runtime.take()();
        executor.drain();
        let messages = logs.0.lock();
        assert_eq!(messages.len(), 1);
        assert!(messages[0].cached_value_json.is_none());
        assert_eq!(
            messages[0].source_value_json,
            Some(crate::preview::preview_value(&"🙂".repeat(10_000)))
        );
        assert!(cache.core.state.lock().shadows.is_empty());
    }
}

#[test]
fn queued_preview_keeps_capacity_after_executor_shutdown_until_run_or_discarded() {
    for discard in [false, true] {
        let (mut executor, cache, runtime, _, _) = preview_setup();
        preview_call(&mut executor, &cache, false, None);
        drop(executor);
        assert_eq!(cache.core.state.lock().shadows.len(), 1);
        let job = runtime.take();
        if discard {
            drop(job);
        } else {
            job();
        }
        assert!(cache.core.state.lock().shadows.is_empty());
    }
}

#[test]
fn running_preview_keeps_capacity_after_executor_shutdown() {
    let (mut executor, cache, runtime, _, _) = preview_setup();
    let (started, running) = std::sync::mpsc::channel();
    let (release, gate) = std::sync::mpsc::channel();
    let gate = Mutex::new(gate);
    preview_call(
        &mut executor,
        &cache,
        false,
        Some(Arc::new(move |value| {
            if value != "source" {
                started.send(std::thread::current().id()).unwrap();
                gate.lock().recv_timeout(Duration::from_secs(5)).unwrap();
            }
            Some(value.clone())
        })),
    );
    let job = runtime.take();
    let worker = std::thread::spawn(job);
    assert_ne!(
        running.recv_timeout(Duration::from_secs(5)).unwrap(),
        std::thread::current().id()
    );
    drop(executor);
    assert_eq!(cache.core.state.lock().shadows.len(), 1);
    release.send(()).unwrap();
    worker.join().unwrap();
    assert!(cache.core.state.lock().shadows.is_empty());
}
