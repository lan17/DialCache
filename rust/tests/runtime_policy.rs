//! Native typed-policy conversion preserves the portable sparse-overlay rules.

#![cfg(feature = "tokio")]

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use dialcache::{DialCache, Identity, Operation, Policy};

fn cache_with_ttl_overlay() -> DialCache {
    DialCache::builder()
        .local_capacity(0)
        .policy_provider(|_| async { Ok(Some(Policy::default().local_ttl_sec(9).into())) })
        .build()
        .unwrap()
}

#[tokio::test]
async fn typed_ttl_overlay_preserves_request_memoization() {
    let cache = cache_with_ttl_overlay();
    let request = cache.enable_guard();
    let calls = Arc::new(AtomicUsize::new(0));
    for _ in 0..2 {
        let calls = calls.clone();
        let value = cache
            .get_or_load(
                request.scope(),
                Operation::<usize>::new(Identity::new("item", "one", "lookup"))
                    .policy(Policy::default().request_local(true)),
                move |_| {
                    let value = calls.fetch_add(1, Ordering::SeqCst) + 1;
                    async move { Ok(value) }
                },
            )
            .await
            .unwrap();
        assert_eq!(*value, 1, "the second call must use the request memo");
    }
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}

#[tokio::test]
async fn typed_ttl_overlay_preserves_independent_sources() {
    let cache = cache_with_ttl_overlay();
    let request = cache.enable_guard();
    let calls = Arc::new(AtomicUsize::new(0));
    let barrier = Arc::new(tokio::sync::Barrier::new(2));
    let operation = Operation::<usize>::new(Identity::new("item", "one", "lookup"))
        .policy(Policy::default().coalesce(false));
    let load = {
        let calls = calls.clone();
        move |_| {
            let calls = calls.clone();
            let barrier = barrier.clone();
            async move {
                let value = calls.fetch_add(1, Ordering::SeqCst) + 1;
                barrier.wait().await;
                Ok(value)
            }
        }
    };
    let first = cache.get_or_load(request.scope(), operation.clone(), load.clone());
    let second = cache.get_or_load(request.scope(), operation, load);
    let (first, second) = tokio::time::timeout(Duration::from_secs(5), async {
        tokio::join!(first, second)
    })
    .await
    .expect("a TTL-only overlay must not coalesce independent sources");
    assert_ne!(*first.unwrap(), *second.unwrap());
    assert_eq!(calls.load(Ordering::SeqCst), 2);
}
