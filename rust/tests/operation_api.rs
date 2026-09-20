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
