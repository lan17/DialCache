//! Native callback boundaries: a callback may panic while constructing its
//! future, before the asynchronous effects exercised by the portable replay.

use std::future::{ready, Ready};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use dialcache::observe::{ErrorKind, Layer, RecoveryOutcome, ShadowOutcome};
use dialcache::testing::{TestExecutor, WALL_EPOCH_MS};
use dialcache::{
    BoxError, DialCache, Event, Frame, FromSync, Identity, InvalidateRequest, JsonCodec,
    MissReason, Observer, Operation, Payload, Policy, ReadContext, ReadRequest, ReadResult, Remote,
    ShadowPolicy, SyncCodec, WriteRequest,
};
use futures::future::BoxFuture;
use parking_lot::Mutex;

struct SnapshotRemote {
    result: ReadResult,
    writes: AtomicUsize,
}

impl Remote for SnapshotRemote {
    fn read(&self, _: ReadRequest, _: ReadContext) -> BoxFuture<'_, Result<ReadResult, BoxError>> {
        Box::pin(ready(Ok(self.result.clone())))
    }

    fn write(&self, _: WriteRequest) -> BoxFuture<'_, Result<(), BoxError>> {
        self.writes.fetch_add(1, Ordering::SeqCst);
        Box::pin(ready(Ok(())))
    }

    fn invalidate(&self, _: InvalidateRequest) -> BoxFuture<'_, Result<(), BoxError>> {
        Box::pin(ready(Ok(())))
    }
}

#[derive(Default)]
struct Events(Mutex<Vec<Event>>);

impl Observer for Events {
    fn observe(&self, event: &Event) {
        self.0.lock().push(event.clone());
    }

    fn observes_shadow_outcomes(&self) -> bool {
        true
    }
}

fn setup(result: ReadResult) -> (TestExecutor, DialCache, Arc<SnapshotRemote>, Arc<Events>) {
    let executor = TestExecutor::new(WALL_EPOCH_MS);
    let remote = Arc::new(SnapshotRemote {
        result,
        writes: AtomicUsize::new(0),
    });
    let events = Arc::new(Events::default());
    let cache = DialCache::builder()
        .clock_arc(executor.clock.clone())
        .runtime_arc(executor.runtime.clone())
        .remote_arc(remote.clone())
        .observer_arc(events.clone())
        .build()
        .expect("valid configuration");
    (executor, cache, remote, events)
}

fn hit(age_ms: u64) -> ReadResult {
    ReadResult::Hit(Frame {
        created_at_ms: WALL_EPOCH_MS as u64 - age_ms,
        payload: Payload::text("1"),
    })
}

enum PanickingCodec {
    Encode,
    Decode,
}

impl SyncCodec<u64> for PanickingCodec {
    fn encode(&self, value: &u64) -> Result<Payload, BoxError> {
        if matches!(self, Self::Encode) {
            panic!("synchronous encode failure");
        }
        JsonCodec::encode_value(value)
    }

    fn decode(&self, payload: Payload) -> Result<u64, BoxError> {
        if matches!(self, Self::Decode) {
            panic!("synchronous decode failure");
        }
        JsonCodec::decode_value(&payload)
    }
}

fn operation(codec: PanickingCodec) -> Operation<u64> {
    Operation::with_codec(
        Identity::new("thing", "one", "CallbackBoundary"),
        Arc::new(FromSync(codec)),
        |a, b| a == b,
    )
    .policy(Policy::default().remote_ttl_sec(60))
}

#[test]
fn synchronous_encode_panic_preserves_source_success_and_local_publication() {
    let (mut executor, cache, remote, events) = setup(ReadResult::miss(MissReason::ValueAbsent));
    let result = executor.block_on(async move {
        let request = cache.enable_guard();
        let operation = operation(PanickingCodec::Encode).policy(Policy::enabled(60));
        let first = cache
            .get_or_load(request.scope(), operation.clone(), |_| ready(Ok(7)))
            .await?;
        let second = cache
            .get_or_load(
                request.scope(),
                operation,
                |_| -> Ready<Result<u64, BoxError>> {
                    panic!("the source must not run after local publication")
                },
            )
            .await?;
        Ok::<_, dialcache::Error>((first, second))
    });
    let (first, second) = result.expect("a codec panic must fail open");
    assert_eq!((*first, *second), (7, 7));
    assert_eq!(remote.writes.load(Ordering::SeqCst), 0);
    assert!(events.0.lock().iter().any(|event| matches!(
        event,
        Event::Error {
            error: ErrorKind::SerializationDump,
            ..
        }
    )));
}

#[test]
fn synchronous_decode_panic_falls_through_to_source_and_refills() {
    let (mut executor, cache, remote, events) = setup(hit(0));
    let result = executor.block_on(async move {
        let request = cache.enable_guard();
        cache
            .get_or_load(request.scope(), operation(PanickingCodec::Decode), |_| {
                ready(Ok(7))
            })
            .await
    });
    assert_eq!(*result.expect("decode panic must reach the source"), 7);
    assert_eq!(remote.writes.load(Ordering::SeqCst), 1);
    assert!(events.0.lock().iter().any(|event| matches!(
        event,
        Event::Error {
            error: ErrorKind::SerializationLoad,
            ..
        }
    )));
}

#[test]
fn synchronous_recovery_decode_panic_preserves_the_source_error() {
    let (mut executor, cache, remote, events) = setup(hit(2_000));
    let result = executor.block_on(async move {
        let request = cache.enable_guard();
        let operation = operation(PanickingCodec::Decode)
            .policy(
                Policy::default()
                    .remote_ttl_sec(1)
                    .stale_on_error_max_age_sec(3),
            )
            .should_recover(|_| true);
        cache
            .get_or_load(request.scope(), operation, |_| {
                ready(Err("source failed".into()))
            })
            .await
    });
    let error = result.expect_err("recovery cannot decode the retained frame");
    assert_eq!(
        error
            .source_error()
            .expect("original source error")
            .to_string(),
        "source failed"
    );
    assert_eq!(remote.writes.load(Ordering::SeqCst), 0);
    assert!(events.0.lock().iter().any(|event| matches!(
        event,
        Event::StaleRecovery {
            outcome: RecoveryOutcome::DeserializationError,
            ..
        }
    )));
}

#[test]
fn synchronous_shadow_source_panic_is_a_source_error_and_releases_capacity() {
    let (mut executor, cache, _, events) = setup(hit(0));
    let request = cache.enable_guard();
    let source_enabled = Arc::new(AtomicBool::new(true));
    for _ in 0..2 {
        let cache = cache.clone();
        let scope = request.scope().clone();
        let source_enabled = source_enabled.clone();
        let result = executor.block_on(async move {
            let operation = Operation::<u64>::new(Identity::new("thing", "one", "ShadowBoundary"))
                .policy(Policy::default().remote_ttl_sec(60).shadow(ShadowPolicy {
                    ramp: Some(100.0),
                    log_mismatches: None,
                }));
            cache
                .get_or_load(
                    &scope,
                    operation,
                    move |scope| -> Ready<Result<u64, BoxError>> {
                        source_enabled.store(scope.is_enabled(), Ordering::SeqCst);
                        panic!("synchronous source failure");
                    },
                )
                .await
        });
        assert_eq!(*result.expect("served hit survives shadow failure"), 1);
    }
    assert!(
        !source_enabled.load(Ordering::SeqCst),
        "shadow source must run disabled"
    );
    let outcomes: Vec<_> = events
        .0
        .lock()
        .iter()
        .filter_map(|event| match event {
            Event::ShadowValidation { outcome, .. } => Some(*outcome),
            _ => None,
        })
        .collect();
    assert_eq!(
        outcomes,
        vec![ShadowOutcome::SourceError, ShadowOutcome::SourceError]
    );
}

#[test]
fn dark_shadow_distinguishes_its_deadline_from_application_timeout_errors() {
    for error_kind in ["own deadline", "nested deadline", "source error"] {
        let (mut executor, cache, _, events) = setup(hit(0));
        let result = Arc::new(Mutex::new(None));
        let sink = result.clone();
        executor.spawn(async move {
            let request = cache.enable_guard();
            let operation = Operation::<u64>::new(Identity::new("thing", "one", "DarkDeadline"))
                .policy(
                    Policy::default()
                        .remote_ttl_sec(60)
                        .remote_ramp(0.0)
                        .shadow(ShadowPolicy {
                            ramp: Some(100.0),
                            log_mismatches: None,
                        }),
                )
                .budget(dialcache::SourceBudget::Millis(5));
            *sink.lock() = Some(
                cache
                    .get_or_load(request.scope(), operation, move |_| async move {
                        match error_kind {
                            "own deadline" => std::future::pending::<Result<u64, BoxError>>().await,
                            "nested deadline" => Err(Box::new(dialcache::Error::FallbackTimeout(
                                Arc::new(dialcache::FallbackTimeout {
                                    use_case: "nested".to_owned(),
                                    timeout_ms: 1,
                                }),
                            )) as BoxError),
                            _ => Err("source failed".into()),
                        }
                    })
                    .await,
            );
        });
        executor.drain();
        if error_kind == "own deadline" {
            assert!(result.lock().is_none());
            executor.advance(5, true);
            assert!(matches!(
                result.lock().as_ref().unwrap(),
                Err(dialcache::Error::FallbackTimeout(_))
            ));
        } else {
            assert!(matches!(
                result.lock().as_ref().unwrap(),
                Err(dialcache::Error::Source(_))
            ));
        }
        let outcomes: Vec<_> = events
            .0
            .lock()
            .iter()
            .filter_map(|event| {
                if let Event::ShadowValidation { outcome, .. } = event {
                    Some(*outcome)
                } else {
                    None
                }
            })
            .collect();
        assert_eq!(
            outcomes,
            vec![if error_kind == "own deadline" {
                ShadowOutcome::Timeout
            } else {
                ShadowOutcome::SourceError
            }],
            "{error_kind}"
        );
    }
}

#[test]
fn provider_construction_poll_and_returned_failures_preserve_source_results() {
    for failure in ["construct", "poll", "error"] {
        let mut executor = TestExecutor::new(WALL_EPOCH_MS);
        let events = Arc::new(Events::default());
        let cache = DialCache::builder()
            .clock_arc(executor.clock.clone())
            .runtime_arc(executor.runtime.clone())
            .observer_arc(events.clone())
            .policy_provider(
                move |_| -> BoxFuture<'static, Result<Option<dialcache::RuntimePolicy>, BoxError>> {
                    if failure == "construct" {
                        panic!("provider future construction");
                    }
                    Box::pin(async move {
                        if failure == "poll" {
                            panic!("provider future poll");
                        }
                        Err("provider failed".into())
                    })
                },
            )
            .build()
            .unwrap();
        let calls = Arc::new(AtomicUsize::new(0));
        let request = cache.enable_guard();
        for expected in 1..=2 {
            let (cache, scope, calls) = (cache.clone(), request.scope().clone(), calls.clone());
            let value = executor.block_on(async move {
                cache
                    .get_or_load(
                        &scope,
                        Operation::<usize>::new(Identity::new("thing", "one", "ProviderFailure"))
                            .policy(Policy::default().local_ttl_sec(60)),
                        move |_| {
                            let value = calls.fetch_add(1, Ordering::SeqCst) + 1;
                            async move { Ok(value) }
                        },
                    )
                    .await
                    .unwrap()
            });
            assert_eq!(
                *value, expected,
                "provider failure must bypass cache publication"
            );
        }
        let policy_errors = events.0.lock().iter().filter(|event| matches!(event,
            Event::Error { labels, error: ErrorKind::ConfigResolution, .. } if labels.layer == Layer::Noop
        )).count();
        assert_eq!(policy_errors, 2, "{failure}");
    }
}

#[test]
fn held_policy_survives_caller_cancellation_and_rechecks_scope_closure() {
    for close_scope in [false, true] {
        let mut executor = TestExecutor::new(WALL_EPOCH_MS);
        let (release, held) = futures::channel::oneshot::channel::<()>();
        let held = Arc::new(Mutex::new(Some(held)));
        let provider_calls = Arc::new(AtomicUsize::new(0));
        let events = Arc::new(Events::default());
        let cache = DialCache::builder()
            .clock_arc(executor.clock.clone())
            .runtime_arc(executor.runtime.clone())
            .observer_arc(events.clone())
            .policy_provider({
                let provider_calls = provider_calls.clone();
                move |_| {
                    provider_calls.fetch_add(1, Ordering::SeqCst);
                    let held = held.lock().take();
                    async move {
                        if let Some(held) = held {
                            held.await.unwrap();
                        }
                        Ok(None)
                    }
                }
            })
            .build()
            .unwrap();
        let mut request = Some(cache.enable_guard());
        let scope = request.as_ref().unwrap().scope().clone();
        let operation = Operation::<u64>::new(Identity::new("thing", "one", "HeldProvider"))
            .policy(Policy::default().local_ttl_sec(60));
        let calls = Arc::new(AtomicUsize::new(0));
        let source_enabled = Arc::new(Mutex::new(Vec::new()));
        let caller_finished = Arc::new(AtomicBool::new(false));
        let (cancel, registration) = futures::future::AbortHandle::new_pair();
        executor.spawn({
            let (cache, operation, calls) = (cache.clone(), operation.clone(), calls.clone());
            let (source_enabled, caller_finished) =
                (source_enabled.clone(), caller_finished.clone());
            async move {
                let pending = cache.get_or_load(&scope, operation, move |scope| {
                    calls.fetch_add(1, Ordering::SeqCst);
                    source_enabled.lock().push(scope.is_enabled());
                    async { Ok(7) }
                });
                let result = futures::future::Abortable::new(pending, registration).await;
                assert_eq!(result.is_err(), !close_scope);
                if let Ok(value) = result {
                    assert_eq!(*value.unwrap(), 7);
                }
                caller_finished.store(true, Ordering::SeqCst);
            }
        });
        executor.drain();
        assert_eq!(provider_calls.load(Ordering::SeqCst), 1);
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        assert!(!caller_finished.load(Ordering::SeqCst));
        if close_scope {
            drop(request.take());
        } else {
            cancel.abort();
        }
        executor.drain();
        assert_eq!(caller_finished.load(Ordering::SeqCst), !close_scope);
        release.send(()).unwrap();
        executor.drain();
        assert!(caller_finished.load(Ordering::SeqCst));
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(*source_enabled.lock(), vec![!close_scope]);
        let source_layers: Vec<_> = events
            .0
            .lock()
            .iter()
            .filter_map(|event| match event {
                Event::Fallback { labels, .. } => Some(labels.layer),
                _ => None,
            })
            .collect();
        assert_eq!(
            source_layers,
            vec![if close_scope {
                Layer::Noop
            } else {
                Layer::Local
            }]
        );
        let calls_for_next = calls.clone();
        let value = executor.block_on(async move {
            let request = cache.enable_guard();
            cache
                .get_or_load(request.scope(), operation, move |_| {
                    calls_for_next.fetch_add(1, Ordering::SeqCst);
                    async { Ok(8) }
                })
                .await
                .unwrap()
        });
        assert_eq!(*value, if close_scope { 8 } else { 7 });
        assert_eq!(
            calls.load(Ordering::SeqCst),
            if close_scope { 2 } else { 1 }
        );
    }
}
