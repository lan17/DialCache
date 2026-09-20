//! Native allocation and eviction guarantees of the default local store.

use std::num::NonZeroUsize;
use std::sync::Arc;

use dialcache::limits::MAX_SAFE_INTEGER;
use dialcache::testing::{TestExecutor, WALL_EPOCH_MS};
use dialcache::{
    DialCache, Identity, LocalEntry, LocalRead, LocalStore, LruLocalStore, Operation, Policy,
};

#[test]
fn maximum_supported_capacity_allocates_only_as_entries_arrive() {
    let mut executor = TestExecutor::new(WALL_EPOCH_MS);
    let capacity = usize::try_from(MAX_SAFE_INTEGER).unwrap_or(usize::MAX);
    let cache = DialCache::builder()
        .clock_arc(executor.clock.clone())
        .runtime_arc(executor.runtime.clone())
        .local_capacity(capacity)
        .build()
        .expect("the maximum supported capacity must remain constructible");
    let (first, second) = executor.block_on(async move {
        let request = cache.enable_guard();
        let operation = Operation::<u64>::new(Identity::new("thing", "one", "LargeCapacity"))
            .policy(Policy::default().local_ttl_sec(60));
        let first = cache
            .get_or_load(request.scope(), operation.clone(), |_| async { Ok(7) })
            .await
            .expect("source success");
        let second = cache
            .get_or_load(request.scope(), operation, |_| async { Ok(8) })
            .await
            .expect("local hit");
        (first, second)
    });
    assert_eq!((*first, *second), (7, 7));
}

fn entry(value: u64) -> LocalEntry {
    LocalEntry {
        value: Arc::new(value),
        inserted_ms: 0,
        ttl_ms: 1_000,
    }
}

#[test]
fn sparse_storage_preserves_capacity_and_lru_eviction() {
    let mut store = LruLocalStore::new(NonZeroUsize::new(2).unwrap());
    assert!(store.put("a".into(), entry(1)).unwrap().is_none());
    assert!(store.put("b".into(), entry(2)).unwrap().is_none());
    assert!(matches!(store.get("a", 0).unwrap(), LocalRead::Live(_)));

    let evicted = store
        .put("c".into(), entry(3))
        .unwrap()
        .expect("at capacity");
    assert_eq!(evicted.value.downcast_ref::<u64>(), Some(&2));
    assert_eq!(store.len(), 2);
    assert!(matches!(store.get("b", 0).unwrap(), LocalRead::Absent));

    let replaced = store
        .put("a".into(), entry(4))
        .unwrap()
        .expect("replacement");
    assert_eq!(replaced.value.downcast_ref::<u64>(), Some(&1));
    let evicted = store
        .put("d".into(), entry(5))
        .unwrap()
        .expect("at capacity");
    assert_eq!(evicted.value.downcast_ref::<u64>(), Some(&3));
    assert_eq!(store.len(), 2);
}
