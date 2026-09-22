//! Inline operations remain reusable when the cached value cannot be cloned.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;

use dialcache::testing::{TestExecutor, WALL_EPOCH_MS};
use dialcache::{DialCache, Identity, Operation, Policy};
use serde::{Deserialize, Serialize};

#[derive(Debug, PartialEq, Serialize, Deserialize)]
struct NonCloneValue {
    value: usize,
}

#[test]
fn cloned_operation_reuses_non_clone_cached_values() {
    let mut executor = TestExecutor::new(WALL_EPOCH_MS);
    let cache = DialCache::builder()
        .clock_arc(executor.clock.clone())
        .runtime_arc(executor.runtime.clone())
        .build()
        .unwrap();
    let sources = Arc::new(AtomicUsize::new(0));
    let calls = sources.clone();
    let operation = Operation::<NonCloneValue>::new(Identity::new("thing", "one", "NonClone"))
        .policy(Policy::default().local_ttl_sec(60));
    let (first, second) = executor.block_on(async move {
        let request = cache.enable_guard();
        let load = move |_| {
            let value = calls.fetch_add(1, Ordering::SeqCst) + 1;
            async move { Ok(NonCloneValue { value }) }
        };
        let first = cache
            .get_or_load(request.scope(), operation.clone(), load.clone())
            .await
            .unwrap();
        let second = cache
            .get_or_load(request.scope(), operation, load)
            .await
            .unwrap();
        (first, second)
    });

    assert_eq!(first.value, 1);
    assert!(Arc::ptr_eq(&first, &second));
    assert_eq!(sources.load(Ordering::SeqCst), 1);
}

#[test]
fn incompatible_settled_memory_values_miss_and_are_replaced() {
    use dialcache::observe::Layer;
    use dialcache::{Event, MissReason, Observer};
    use parking_lot::Mutex;
    #[derive(Default)]
    struct Events(Mutex<Vec<Event>>);
    impl Observer for Events {
        fn observe(&self, event: &Event) {
            self.0.lock().push(event.clone());
        }
    }
    for policy in [
        Policy::default().request_local(true),
        Policy::default().local_ttl_sec(60),
    ] {
        let mut executor = TestExecutor::new(WALL_EPOCH_MS);
        let events = Arc::new(Events::default());
        let cache = DialCache::builder()
            .clock_arc(executor.clock.clone())
            .runtime_arc(executor.runtime.clone())
            .observer_arc(events.clone())
            .build()
            .unwrap();
        executor.block_on(async move {
            let request = cache.enable_guard();
            let id = Identity::new("thing", "one", "MixedTypes");
            cache
                .get_or_load(
                    request.scope(),
                    Operation::<String>::new(id.clone()).policy(policy.clone()),
                    |_| async { Ok("old".to_owned()) },
                )
                .await
                .unwrap();
            let op = Operation::<serde_json::Value>::new(id).policy(policy);
            let value = cache
                .get_or_load(request.scope(), op.clone(), |_| async {
                    Ok(serde_json::json!("new"))
                })
                .await
                .unwrap();
            assert_eq!(*value, serde_json::json!("new"));
            let hit = cache
                .get_or_load(request.scope(), op, |_| async {
                    panic!("typed entry should hit")
                })
                .await
                .unwrap();
            assert!(Arc::ptr_eq(&value, &hit));
        });
        assert!(events.0.lock().iter().any(|event| matches!(event,
            Event::Miss { labels, reason: MissReason::Unclassified }
                if matches!(labels.layer, Layer::Local | Layer::RequestLocal))));
    }
}

#[test]
fn incompatible_memory_hit_can_decode_compatible_remote_json() {
    use dialcache::{
        BoxError, Frame, InvalidateRequest, MissReason, ReadContext, ReadRequest, ReadResult,
        Remote, WriteRequest,
    };
    use futures::future::BoxFuture;
    use parking_lot::Mutex;
    #[derive(Default)]
    struct MemoryRemote(Mutex<Option<Frame>>);
    impl Remote for MemoryRemote {
        fn read(
            &self,
            _: ReadRequest,
            _: ReadContext,
        ) -> BoxFuture<'_, Result<ReadResult, BoxError>> {
            Box::pin(std::future::ready(Ok(self
                .0
                .lock()
                .clone()
                .map(ReadResult::Hit)
                .unwrap_or(ReadResult::miss(MissReason::ValueAbsent)))))
        }
        fn write(&self, value: WriteRequest) -> BoxFuture<'_, Result<(), BoxError>> {
            *self.0.lock() = Some(value.frame);
            Box::pin(std::future::ready(Ok(())))
        }
        fn invalidate(&self, _: InvalidateRequest) -> BoxFuture<'_, Result<(), BoxError>> {
            Box::pin(std::future::ready(Ok(())))
        }
    }
    let mut executor = TestExecutor::new(WALL_EPOCH_MS);
    let cache = DialCache::builder()
        .clock_arc(executor.clock.clone())
        .runtime_arc(executor.runtime.clone())
        .remote(MemoryRemote::default())
        .build()
        .unwrap();
    executor.block_on(async move {
        let request = cache.enable_guard();
        let id = Identity::new("thing", "one", "CompatibleJson");
        let policy = Policy::enabled(60).request_local(true);
        cache
            .get_or_load(
                request.scope(),
                Operation::<String>::new(id.clone()).policy(policy.clone()),
                |_| async { Ok("stored".to_owned()) },
            )
            .await
            .unwrap();
        let value = cache
            .get_or_load(
                request.scope(),
                Operation::<serde_json::Value>::new(id).policy(policy),
                |_| async { panic!("compatible remote representation must be decoded") },
            )
            .await
            .unwrap();
        assert_eq!(*value, serde_json::json!("stored"));
    });
}

#[test]
fn registration_and_disabled_calls_do_not_evaluate_keys_or_runtime_policy() {
    let mut executor = TestExecutor::new(WALL_EPOCH_MS);
    let cache = DialCache::builder()
        .clock_arc(executor.clock.clone())
        .runtime_arc(executor.runtime.clone())
        .policy_provider(|_| async { panic!("disabled policy resolution") })
        .build()
        .unwrap();
    let lookup = cache
        .use_case::<(), String>("thing", "LazyRegistration")
        .key(|_| panic!("disabled key construction"))
        .source(|_, _| async { Ok("source".to_owned()) })
        .register()
        .unwrap();
    executor.block_on(async move {
        assert_eq!(*lookup.get_uncached(()).await.unwrap(), "source");
    });
}

#[test]
fn incompatible_coalesced_follower_errors_without_retrying_the_source() {
    use futures::channel::oneshot;
    use parking_lot::Mutex;
    let mut executor = TestExecutor::new(WALL_EPOCH_MS);
    let cache = DialCache::builder()
        .clock_arc(executor.clock.clone())
        .runtime_arc(executor.runtime.clone())
        .build()
        .unwrap();
    let guard = cache.enable_guard();
    let (send, receive) = oneshot::channel();
    let receive = Arc::new(Mutex::new(Some(receive)));
    let first = cache.clone();
    let scope = guard.scope().clone();
    executor.spawn(async move {
        first
            .get_or_load(
                &scope,
                Operation::<String>::new(Identity::new("thing", "one", "MixedFlight"))
                    .policy(Policy::default().local_ttl_sec(60)),
                move |_| {
                    let receive = receive.lock().take().unwrap();
                    async move {
                        receive.await.unwrap();
                        Ok("first".to_owned())
                    }
                },
            )
            .await
            .unwrap();
    });
    executor.drain();
    let result = Arc::new(Mutex::new(None));
    let sink = result.clone();
    let scope = guard.scope().clone();
    executor.spawn(async move {
        *sink.lock() = Some(
            cache
                .get_or_load(
                    &scope,
                    Operation::<serde_json::Value>::new(Identity::new(
                        "thing",
                        "one",
                        "MixedFlight",
                    ))
                    .policy(Policy::default().local_ttl_sec(60)),
                    |_| async { panic!("follower retried source") },
                )
                .await,
        );
    });
    executor.drain();
    assert!(result.lock().is_none());
    send.send(()).unwrap();
    executor.drain();
    assert!(matches!(
        result.lock().take().unwrap(),
        Err(dialcache::Error::Config(_))
    ));
}
