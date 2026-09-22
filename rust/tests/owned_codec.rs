//! Shared ownership at the public codec boundary, without Clone or Serde bounds.

use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use dialcache::observe::{ErrorKind, SerializationOperation};
use dialcache::testing::{StepRuntime, TestExecutor, WALL_EPOCH_MS};
use dialcache::{
    BoxError, Codec, DialCache, Event, Frame, Identity, InvalidateRequest, KeySpec, MissReason,
    Observer, Operation, Payload, Policy, ReadContext, ReadRequest, ReadResult, Remote, Runtime,
    Scope, UseCase, WriteRequest,
};
use futures::future::BoxFuture;
use parking_lot::Mutex;

#[derive(Debug, PartialEq)]
struct Value(u64);

fn payload(value: &Value) -> Payload {
    Payload::text(format!("custom:{}", value.0))
}

#[derive(Default)]
struct RecordingRemote(Mutex<Vec<Frame>>);
impl Remote for RecordingRemote {
    fn read(&self, _: ReadRequest, _: ReadContext) -> BoxFuture<'_, Result<ReadResult, BoxError>> {
        Box::pin(async { Ok(ReadResult::miss(MissReason::ValueAbsent)) })
    }
    fn write(&self, request: WriteRequest) -> BoxFuture<'_, Result<(), BoxError>> {
        self.0.lock().push(request.frame);
        Box::pin(async { Ok(()) })
    }
    fn invalidate(&self, _: InvalidateRequest) -> BoxFuture<'_, Result<(), BoxError>> {
        Box::pin(async { Ok(()) })
    }
}

enum Lookup {
    Inline(DialCache, Box<Operation<Value>>, Arc<AtomicUsize>),
    Registered(UseCase<(), Value>),
}
impl Lookup {
    fn new(
        cache: &DialCache,
        codec: Arc<dyn Codec<Value>>,
        registered: bool,
        calls: Arc<AtomicUsize>,
    ) -> Self {
        let policy = Policy::enabled(60).request_local(false);
        if registered {
            Self::Registered(
                cache
                    .use_case("thing", "OwnedCodec")
                    .policy(policy)
                    .key(|_: &()| KeySpec::new("one"))
                    .codec(codec)
                    .comparator(|a, b| a == b)
                    .source(move |_, _| {
                        calls.fetch_add(1, Ordering::SeqCst);
                        async { Ok(Value(7)) }
                    })
                    .register_custom()
                    .unwrap(),
            )
        } else {
            Self::Inline(
                cache.clone(),
                Box::new(
                    Operation::with_codec(
                        Identity::new("thing", "one", "OwnedCodec"),
                        codec,
                        |a, b| a == b,
                    )
                    .policy(policy),
                ),
                calls,
            )
        }
    }

    async fn get(&self, scope: &Scope) -> Arc<Value> {
        match self {
            Self::Inline(cache, operation, calls) => {
                let calls = calls.clone();
                cache
                    .get_or_load(scope, operation.as_ref().clone(), move |_| {
                        calls.fetch_add(1, Ordering::SeqCst);
                        async { Ok(Value(7)) }
                    })
                    .await
            }
            Self::Registered(lookup) => lookup.get(scope, ()).await,
        }
        .expect("cache plumbing preserves the source result")
    }
}

struct BorrowedCodec(Arc<AtomicUsize>);
impl Codec<Value> for BorrowedCodec {
    fn encode<'a>(&'a self, value: &'a Value) -> BoxFuture<'a, Result<Payload, BoxError>> {
        self.0.fetch_add(1, Ordering::SeqCst);
        Box::pin(async move { Ok(payload(value)) })
    }
    fn decode(&self, _: Payload) -> BoxFuture<'_, Result<Value, BoxError>> {
        panic!("remote always misses")
    }
}

#[test]
fn borrowed_only_codecs_keep_working_through_both_apis() {
    for registered in [false, true] {
        let mut executor = TestExecutor::new(WALL_EPOCH_MS);
        let remote = Arc::new(RecordingRemote::default());
        let cache = DialCache::builder()
            .clock_arc(executor.clock.clone())
            .runtime_arc(executor.runtime.clone())
            .remote_arc(remote.clone())
            .build()
            .unwrap();
        let encoded = Arc::new(AtomicUsize::new(0));
        let lookup = Lookup::new(
            &cache,
            Arc::new(BorrowedCodec(encoded.clone())),
            registered,
            Arc::new(AtomicUsize::new(0)),
        );
        executor.block_on(async move {
            let request = cache.enable_guard();
            assert_eq!(*lookup.get(request.scope()).await, Value(7));
        });
        assert_eq!(encoded.load(Ordering::SeqCst), 1);
        let writes = remote.0.lock();
        assert_eq!(writes.len(), 1);
        assert_eq!(writes[0].payload, payload(&Value(7)));
    }
}

#[cfg(feature = "tokio")]
#[tokio::test(flavor = "current_thread")]
async fn owned_encoders_move_non_clone_values_off_thread_through_both_apis() {
    struct BackgroundCodec {
        started: tokio::sync::mpsc::UnboundedSender<(std::thread::ThreadId, Arc<Value>)>,
        release: Arc<Mutex<std::sync::mpsc::Receiver<()>>>,
    }
    impl Codec<Value> for BackgroundCodec {
        fn encode<'a>(&'a self, _: &'a Value) -> BoxFuture<'a, Result<Payload, BoxError>> {
            panic!("the engine must select the owned hook")
        }
        fn encode_owned(&self, value: Arc<Value>) -> BoxFuture<'_, Result<Payload, BoxError>> {
            let (started, release) = (self.started.clone(), self.release.clone());
            let job = tokio::task::spawn_blocking(move || -> Result<Payload, BoxError> {
                started.send((std::thread::current().id(), value.clone()))?;
                release.lock().recv_timeout(Duration::from_secs(5))?;
                Ok(payload(&value))
            });
            Box::pin(async move { job.await? })
        }
        fn decode(&self, _: Payload) -> BoxFuture<'_, Result<Value, BoxError>> {
            panic!("remote always misses")
        }
    }

    for registered in [false, true] {
        let remote = Arc::new(RecordingRemote::default());
        let cache = DialCache::builder()
            .remote_arc(remote.clone())
            .build()
            .unwrap();
        let request = cache.enable_guard();
        let (started, mut started_rx) = tokio::sync::mpsc::unbounded_channel();
        let (release, gate) = std::sync::mpsc::channel();
        let lookup = Lookup::new(
            &cache,
            Arc::new(BackgroundCodec {
                started,
                release: Arc::new(Mutex::new(gate)),
            }),
            registered,
            Arc::new(AtomicUsize::new(0)),
        );
        let scope = request.scope().clone();
        let pending = tokio::spawn(async move { lookup.get(&scope).await });
        let (worker, observed) = tokio::time::timeout(Duration::from_secs(2), started_rx.recv())
            .await
            .unwrap()
            .expect("owned encoder started");
        assert_ne!(worker, std::thread::current().id());
        tokio::time::sleep(Duration::from_millis(1)).await;
        assert!(
            !pending.is_finished(),
            "encoding remains gated while the timer progresses"
        );
        release.send(()).unwrap();
        let value = pending.await.unwrap();
        assert_eq!(*value, Value(7));
        assert!(Arc::ptr_eq(&value, &observed));
        let writes = remote.0.lock();
        assert_eq!(writes.len(), 1);
        assert_eq!(writes[0].payload, payload(&value));
    }
}

#[derive(Default)]
struct Events(Mutex<Vec<Event>>);
impl Observer for Events {
    fn observe(&self, event: &Event) {
        self.0.lock().push(event.clone());
    }
}

struct RejectCpu {
    step: Arc<StepRuntime>,
    attempts: AtomicUsize,
    ran: Arc<AtomicBool>,
}
impl Runtime for RejectCpu {
    fn spawn(&self, task: BoxFuture<'static, ()>) {
        self.step.spawn(task);
    }
    fn sleep(&self, delay: Duration) -> BoxFuture<'static, ()> {
        self.step.sleep(delay)
    }
    fn spawn_blocking(&self, _: Box<dyn FnOnce() + Send>) -> Result<(), BoxError> {
        self.attempts.fetch_add(1, Ordering::SeqCst);
        Err("custom CPU admission rejected".into())
    }
}

#[derive(Clone, Copy)]
enum Failure {
    Construction,
    Poll,
    Error,
    Rejection,
}
struct FailingCodec {
    mode: Failure,
    cpu: Arc<RejectCpu>,
    calls: Arc<AtomicUsize>,
}
impl Codec<Value> for FailingCodec {
    fn encode<'a>(&'a self, _: &'a Value) -> BoxFuture<'a, Result<Payload, BoxError>> {
        panic!("borrowed encode must not be selected")
    }
    fn encode_owned(&self, _: Arc<Value>) -> BoxFuture<'_, Result<Payload, BoxError>> {
        self.calls.fetch_add(1, Ordering::SeqCst);
        if matches!(self.mode, Failure::Construction) {
            panic!("owned hook construction");
        }
        Box::pin(async move {
            match self.mode {
                Failure::Construction => unreachable!(),
                Failure::Poll => panic!("owned hook polling"),
                Failure::Error => Err("owned hook error".into()),
                Failure::Rejection => {
                    let ran = self.cpu.ran.clone();
                    self.cpu.spawn_blocking(Box::new(move || {
                        ran.store(true, Ordering::SeqCst);
                    }))?;
                    Ok(Payload::text("unexpected admission"))
                }
            }
        })
    }
    fn decode(&self, _: Payload) -> BoxFuture<'_, Result<Value, BoxError>> {
        panic!("remote always misses")
    }
}

#[test]
fn owned_hook_failures_preserve_source_and_local_publication() {
    for registered in [false, true] {
        for mode in [
            Failure::Construction,
            Failure::Poll,
            Failure::Error,
            Failure::Rejection,
        ] {
            let mut executor = TestExecutor::new(WALL_EPOCH_MS);
            let remote = Arc::new(RecordingRemote::default());
            let events = Arc::new(Events::default());
            let cpu = Arc::new(RejectCpu {
                step: executor.runtime.clone(),
                attempts: AtomicUsize::new(0),
                ran: Arc::new(AtomicBool::new(false)),
            });
            let cache = DialCache::builder()
                .clock_arc(executor.clock.clone())
                .runtime_arc(executor.runtime.clone())
                .remote_arc(remote.clone())
                .observer_arc(events.clone())
                .build()
                .unwrap();
            let calls = Arc::new(AtomicUsize::new(0));
            let encoded = Arc::new(AtomicUsize::new(0));
            let lookup = Lookup::new(
                &cache,
                Arc::new(FailingCodec {
                    mode,
                    cpu: cpu.clone(),
                    calls: encoded.clone(),
                }),
                registered,
                calls.clone(),
            );
            executor.block_on(async move {
                let request = cache.enable_guard();
                let first = lookup.get(request.scope()).await;
                assert_eq!(*first, Value(7));
                assert!(Arc::ptr_eq(&first, &lookup.get(request.scope()).await));
            });
            assert_eq!(calls.load(Ordering::SeqCst), 1);
            assert_eq!(encoded.load(Ordering::SeqCst), 1);
            assert!(remote.0.lock().is_empty());
            assert_eq!(
                cpu.attempts.load(Ordering::SeqCst),
                usize::from(matches!(mode, Failure::Rejection))
            );
            assert!(!cpu.ran.load(Ordering::SeqCst));
            let events = events.0.lock();
            assert!(events.iter().any(|e| matches!(
                e,
                Event::Error {
                    error: ErrorKind::SerializationDump,
                    ..
                }
            )));
            assert!(events.iter().any(|e| matches!(
                e,
                Event::Serialization {
                    operation: SerializationOperation::Dump,
                    ..
                }
            )));
        }
    }
}
