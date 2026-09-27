//! Exact-key maintenance at the native API, adapter, and local-store boundaries.

use std::collections::HashMap;
use std::num::NonZeroUsize;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::Arc;

use dialcache::observe::{ErrorKind, Layer};
use dialcache::{
    BoxError, ConfigError, DeleteRequest, DialCache, Error, Event, Frame, Identity,
    InvalidateRequest, LocalEntry, LocalRead, LocalStore, LogEvent, LogLevel, Logger,
    LruLocalStore, MissReason, Observer, Operation, Policy, ReadContext, ReadRequest, ReadResult,
    Remote, Scope, WriteRequest,
};
use futures::future::BoxFuture;
use parking_lot::Mutex;

#[derive(Default)]
struct MemoryRemote {
    values: Mutex<HashMap<String, Frame>>,
    deletes: Mutex<Vec<String>>,
    fail: AtomicBool,
    remove_before_error: AtomicBool,
}
impl Remote for MemoryRemote {
    fn read(
        &self,
        request: ReadRequest,
        _: ReadContext,
    ) -> BoxFuture<'_, Result<ReadResult, BoxError>> {
        Box::pin(async move {
            Ok(self
                .values
                .lock()
                .get(&request.value_key)
                .cloned()
                .map(ReadResult::Hit)
                .unwrap_or_else(|| ReadResult::miss(MissReason::ValueAbsent)))
        })
    }
    fn write(&self, request: WriteRequest) -> BoxFuture<'_, Result<(), BoxError>> {
        Box::pin(async move {
            self.values.lock().insert(request.value_key, request.frame);
            Ok(())
        })
    }
    fn invalidate(&self, _: InvalidateRequest) -> BoxFuture<'_, Result<(), BoxError>> {
        Box::pin(async { Ok(()) })
    }
    fn supports_delete(&self) -> bool {
        true
    }
    fn delete(&self, request: DeleteRequest) -> BoxFuture<'_, Result<(), BoxError>> {
        Box::pin(async move {
            self.deletes.lock().push(request.value_key.clone());
            if self.fail.load(Ordering::SeqCst) {
                if self.remove_before_error.load(Ordering::SeqCst) {
                    self.values.lock().remove(&request.value_key);
                }
                return Err("delete failed".into());
            }
            self.values.lock().remove(&request.value_key);
            Ok(())
        })
    }
}
// Old adapters need not implement either new default method.
struct OldRemote(MemoryRemote);
impl Remote for OldRemote {
    fn read(&self, r: ReadRequest, c: ReadContext) -> BoxFuture<'_, Result<ReadResult, BoxError>> {
        self.0.read(r, c)
    }
    fn write(&self, r: WriteRequest) -> BoxFuture<'_, Result<(), BoxError>> {
        self.0.write(r)
    }
    fn invalidate(&self, r: InvalidateRequest) -> BoxFuture<'_, Result<(), BoxError>> {
        self.0.invalidate(r)
    }
}
#[derive(Default)]
struct Diagnostics {
    events: Mutex<Vec<Event>>,
    warnings: Mutex<Vec<String>>,
}
impl Observer for Diagnostics {
    fn observe(&self, event: &Event) {
        self.events.lock().push(event.clone());
    }
}
impl Logger for Diagnostics {
    fn log(&self, event: &LogEvent) {
        if let LogEvent::DeletionFailed(_) = event {
            assert_eq!(event.level(), LogLevel::Warn);
            self.warnings.lock().push(event.to_string());
        }
    }
}
fn operation(identity: Identity) -> Operation<u64> {
    Operation::new(identity).policy(
        Policy::default()
            .request_local(true)
            .local_ttl_sec(60)
            .remote_ttl_sec(60),
    )
}
async fn read(cache: &DialCache, scope: &Scope, identity: Identity, value: u64) -> u64 {
    *cache
        .get_or_load(
            scope,
            operation(identity),
            move |_| async move { Ok(value) },
        )
        .await
        .unwrap()
}

#[tokio::test]
async fn delete_in_disabled_scope_removes_exact_memo_local_and_remote_without_policy() {
    for tracked in [false, true] {
        let remote = Arc::new(MemoryRemote::default());
        let lookups = Arc::new(AtomicUsize::new(0));
        let counts = lookups.clone();
        let cache = DialCache::builder()
            .namespace("exact")
            .remote_arc(remote.clone())
            .policy_provider(move |_| {
                counts.fetch_add(1, Ordering::SeqCst);
                async { Ok(None) }
            })
            .build()
            .unwrap();
        let identity = Identity::new("item", "1", "Read")
            .tracked(tracked)
            .args(vec![("locale".into(), "en".into())]);
        let sibling = Identity::new("item", "1", "Read")
            .tracked(tracked)
            .args(vec![("locale".into(), "fr".into())]);
        let request = cache.enable_guard();
        assert_eq!(read(&cache, request.scope(), identity.clone(), 1).await, 1);
        assert_eq!(read(&cache, request.scope(), sibling.clone(), 2).await, 2);
        let before = lookups.load(Ordering::SeqCst);
        let cache_ref = &cache;
        let identity_ref = &identity;
        cache
            .disable_in(request.scope(), |disabled| async move {
                assert!(!disabled.is_enabled());
                cache_ref
                    .delete(&disabled, identity_ref.clone())
                    .await
                    .unwrap();
            })
            .await;
        assert_eq!(
            lookups.load(Ordering::SeqCst),
            before,
            "delete resolved policy"
        );
        assert_eq!(
            *remote.deletes.lock(),
            vec![identity.clone().namespace("exact").keys().unwrap().value]
        );
        assert_eq!(read(&cache, request.scope(), identity, 3).await, 3);
        assert_eq!(read(&cache, request.scope(), sibling, 4).await, 2);
    }
}

#[tokio::test]
async fn outside_delete_leaves_other_requests_and_instances_memos_alone() {
    let cache = DialCache::builder().build().unwrap();
    let identity = Identity::new("item", "1", "Read");
    let request = cache.enable_guard();
    assert_eq!(read(&cache, request.scope(), identity.clone(), 1).await, 1);
    cache
        .delete(&Scope::outside(), identity.clone())
        .await
        .unwrap();
    assert_eq!(read(&cache, request.scope(), identity.clone(), 2).await, 1);
    let next = cache.enable_guard();
    assert_eq!(read(&cache, next.scope(), identity.clone(), 3).await, 3);
    let other = DialCache::builder().build().unwrap();
    other
        .delete(request.scope(), identity.clone())
        .await
        .unwrap();
    assert_eq!(read(&cache, request.scope(), identity, 4).await, 1);
}

#[tokio::test]
async fn remote_failure_preserves_local_and_memo_and_reports_failure_then_retry_removes() {
    let remote = Arc::new(MemoryRemote::default());
    let diagnostics = Arc::new(Diagnostics::default());
    let cache = DialCache::builder()
        .remote_arc(remote.clone())
        .observer_arc(diagnostics.clone())
        .logger_arc(diagnostics.clone())
        .build()
        .unwrap();
    let identity = Identity::new("item", "1", "Read");
    let request = cache.enable_guard();
    assert_eq!(read(&cache, request.scope(), identity.clone(), 1).await, 1);
    remote.fail.store(true, Ordering::SeqCst);
    assert!(matches!(
        cache.delete(request.scope(), identity.clone()).await,
        Err(Error::Remote(_))
    ));
    assert_eq!(
        read(&cache, request.scope(), identity.clone(), 2).await,
        1,
        "memo changed after failure"
    );
    let next = cache.enable_guard();
    assert_eq!(
        read(&cache, next.scope(), identity.clone(), 3).await,
        1,
        "local changed after failure"
    );
    assert_eq!(diagnostics.warnings.lock().len(), 1);
    assert!(diagnostics.events.lock().iter().any(|e| matches!(e, Event::Error { error: ErrorKind::Deletion, labels, in_fallback: false } if labels.layer == Layer::Remote)));
    remote.fail.store(false, Ordering::SeqCst);
    cache
        .delete(request.scope(), identity.clone())
        .await
        .unwrap();
    assert_eq!(read(&cache, request.scope(), identity.clone(), 4).await, 4);
    assert_eq!(
        read(&cache, next.scope(), identity, 5).await,
        1,
        "another memo changed"
    );
}

#[tokio::test]
async fn invalid_identity_and_unsupported_adapter_do_not_touch_stores_or_count_attempts() {
    let diagnostics = Arc::new(Diagnostics::default());
    let cache = DialCache::builder()
        .remote(OldRemote(MemoryRemote::default()))
        .observer_arc(diagnostics.clone())
        .build()
        .unwrap();
    let identity = Identity::new("item", "1", "Read");
    let request = cache.enable_guard();
    assert_eq!(read(&cache, request.scope(), identity.clone(), 1).await, 1);
    assert!(matches!(
        cache
            .delete(request.scope(), Identity::new("item", "1", "watermark"))
            .await,
        Err(Error::Config(ConfigError::ReservedUseCase(_)))
    ));
    assert!(matches!(
        cache
            .delete(request.scope(), identity.clone().namespace("bad{namespace"))
            .await,
        Err(Error::Config(_))
    ));
    assert!(matches!(
        cache.delete(request.scope(), identity.clone()).await,
        Err(Error::RemoteDeleteUnsupported)
    ));
    assert_eq!(read(&cache, request.scope(), identity.clone(), 2).await, 1);
    let next = cache.enable_guard();
    assert_eq!(read(&cache, next.scope(), identity, 3).await, 1);
    assert!(!diagnostics
        .events
        .lock()
        .iter()
        .any(|e| matches!(e, Event::Deletion { .. })));
}

#[tokio::test]
async fn absent_local_only_and_zero_capacity_delete_succeed() {
    let diagnostics = Arc::new(Diagnostics::default());
    let cache = DialCache::builder()
        .local_capacity(0)
        .observer_arc(diagnostics.clone())
        .build()
        .unwrap();
    cache
        .delete(&Scope::outside(), Identity::new("item", "1", "Read"))
        .await
        .unwrap();
    assert!(diagnostics.events.lock().iter().any(|e| matches!(
        e,
        Event::Deletion {
            layer: Layer::Local,
            ..
        }
    )));
}

struct BrokenRemoval(LruLocalStore);
impl LocalStore for BrokenRemoval {
    fn get(&mut self, key: &str, now: i64) -> Result<LocalRead, BoxError> {
        self.0.get(key, now)
    }
    fn put(&mut self, key: String, entry: LocalEntry) -> Result<Option<LocalEntry>, BoxError> {
        self.0.put(key, entry)
    }
    fn remove(&mut self, _: &str) -> Result<Option<LocalEntry>, BoxError> {
        Err("local removal failed".into())
    }
}
#[tokio::test]
async fn local_failure_surfaces_after_remote_step_and_preserves_memo() {
    let remote = Arc::new(MemoryRemote::default());
    let diagnostics = Arc::new(Diagnostics::default());
    let cache = DialCache::builder()
        .remote_arc(remote.clone())
        .observer_arc(diagnostics.clone())
        .logger_arc(diagnostics.clone())
        .local_store(Box::new(BrokenRemoval(LruLocalStore::new(
            NonZeroUsize::new(2).unwrap(),
        ))))
        .build()
        .unwrap();
    let request = cache.enable_guard();
    let identity = Identity::new("item", "1", "Read");
    assert_eq!(read(&cache, request.scope(), identity.clone(), 1).await, 1);
    assert!(matches!(
        cache.delete(request.scope(), identity.clone()).await,
        Err(Error::Local(_))
    ));
    assert!(
        remote.values.lock().is_empty(),
        "remote deletion did not run first"
    );
    assert_eq!(read(&cache, request.scope(), identity, 2).await, 1);
    assert!(diagnostics.events.lock().iter().any(|e| matches!(e, Event::Error { error: ErrorKind::Deletion, labels, .. } if labels.layer == Layer::Local)));
    assert_eq!(diagnostics.warnings.lock().len(), 1);
}

#[tokio::test]
async fn ambiguous_remote_error_preserves_memory_even_after_remote_removed() {
    let remote = Arc::new(MemoryRemote::default());
    let cache = DialCache::builder()
        .remote_arc(remote.clone())
        .build()
        .unwrap();
    let identity = Identity::new("item", "1", "Read");
    let request = cache.enable_guard();
    assert_eq!(read(&cache, request.scope(), identity.clone(), 1).await, 1);
    remote.fail.store(true, Ordering::SeqCst);
    remote.remove_before_error.store(true, Ordering::SeqCst);
    assert!(matches!(
        cache.delete(request.scope(), identity.clone()).await,
        Err(Error::Remote(_))
    ));
    assert!(remote.values.lock().is_empty());
    assert_eq!(read(&cache, request.scope(), identity.clone(), 2).await, 1);
    let next = cache.enable_guard();
    assert_eq!(read(&cache, next.scope(), identity, 3).await, 1);
}

#[tokio::test]
async fn deletion_preserves_other_namespaces_entities_use_cases_and_tracking_modes() {
    let remote = Arc::new(MemoryRemote::default());
    let cache = DialCache::builder()
        .namespace("primary")
        .remote_arc(remote.clone())
        .build()
        .unwrap();
    let target = Identity::new("item", "1", "Read");
    let siblings = [
        target.clone().namespace("other"),
        Identity::new("item", "2", "Read"),
        Identity::new("different", "1", "Read"),
        Identity::new("item", "1", "Other"),
        target.clone().tracked(true),
        target.clone().args(vec![("locale".into(), "en".into())]),
    ];
    let request = cache.enable_guard();
    assert_eq!(read(&cache, request.scope(), target.clone(), 1).await, 1);
    for (index, identity) in siblings.iter().enumerate() {
        assert_eq!(
            read(&cache, request.scope(), identity.clone(), index as u64 + 10).await,
            index as u64 + 10
        );
    }
    let mut before = remote.values.lock().clone();
    cache.delete(request.scope(), target.clone()).await.unwrap();
    before.remove(&target.clone().namespace("primary").keys().unwrap().value);
    assert_eq!(*remote.values.lock(), before);
    for (index, identity) in siblings.into_iter().enumerate() {
        assert_eq!(
            read(&cache, request.scope(), identity, 99).await,
            index as u64 + 10
        );
    }
    assert_eq!(read(&cache, request.scope(), target, 2).await, 2);
}

struct HeldDecode {
    started: Arc<tokio::sync::Notify>,
    release: Arc<tokio::sync::Notify>,
}
impl dialcache::Codec<u64> for HeldDecode {
    fn encode<'a>(&'a self, value: &'a u64) -> BoxFuture<'a, Result<dialcache::Payload, BoxError>> {
        Box::pin(async move { Ok(dialcache::Payload::text(value.to_string())) })
    }
    fn decode(&self, payload: dialcache::Payload) -> BoxFuture<'_, Result<u64, BoxError>> {
        Box::pin(async move {
            self.started.notify_one();
            self.release.notified().await;
            Ok(serde_json::from_slice(&payload.bytes)?)
        })
    }
}
#[tokio::test]
async fn acquired_remote_snapshot_returns_after_deletion() {
    let remote = Arc::new(MemoryRemote::default());
    let cache = DialCache::builder()
        .namespace("snapshot")
        .remote_arc(remote.clone())
        .build()
        .unwrap();
    let identity = Identity::new("item", "1", "Read");
    let request = cache.enable_guard();
    // Fill remote first; this source call creates no local entry.
    cache
        .get_or_load(
            request.scope(),
            Operation::<u64>::new(identity.clone()).policy(Policy::default().remote_ttl_sec(60)),
            |_| async { Ok(7) },
        )
        .await
        .unwrap();
    let started = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let op = Operation::with_codec(
        identity.clone(),
        Arc::new(HeldDecode {
            started: started.clone(),
            release: release.clone(),
        }),
        |a, b| a == b,
    )
    .policy(Policy::default().remote_ttl_sec(60));
    let worker = cache.clone();
    let scope = request.scope().clone();
    let pending = tokio::spawn(async move {
        worker
            .get_or_load(&scope, op, |_| async { Err("snapshot should hit".into()) })
            .await
            .unwrap()
    });
    started.notified().await;
    cache.delete(request.scope(), identity).await.unwrap();
    assert!(remote.values.lock().is_empty());
    release.notify_one();
    assert_eq!(*pending.await.unwrap(), 7);
}

#[tokio::test]
async fn existing_flight_and_late_source_publication_survive_deletion() {
    let cache = DialCache::builder().build().unwrap();
    let identity = Identity::new("item", "1", "Read");
    let started = Arc::new(tokio::sync::Notify::new());
    let release = Arc::new(tokio::sync::Notify::new());
    let worker = cache.clone();
    let key = identity.clone();
    let signal = started.clone();
    let gate = release.clone();
    let pending = tokio::spawn(async move {
        let request = worker.enable_guard();
        worker
            .get_or_load(request.scope(), operation(key), move |_| {
                let signal = signal.clone();
                let gate = gate.clone();
                async move {
                    signal.notify_one();
                    gate.notified().await;
                    Ok(7)
                }
            })
            .await
            .unwrap()
    });
    started.notified().await;
    assert_eq!(cache.coalescing_state().process.active_leaders, 1);
    cache
        .delete(&Scope::outside(), identity.clone())
        .await
        .unwrap();
    assert_eq!(cache.coalescing_state().process.active_leaders, 1);
    release.notify_one();
    assert_eq!(*pending.await.unwrap(), 7);
    let next = cache.enable_guard();
    assert_eq!(read(&cache, next.scope(), identity, 8).await, 7);
}
