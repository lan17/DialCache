//! Executable source of the shared guides' code regions.

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::{Arc, RwLock};

use dialcache::{BoxError, DialCache, KeySpec, Policy, RuntimePolicy};

#[tokio::test]
async fn request_scope() -> Result<(), BoxError> {
    // #region request-scope
    let cache = DialCache::builder().build()?;
    let source_calls = Arc::new(AtomicUsize::new(0));
    let calls = source_calls.clone();
    let lookup = cache
        .use_case::<u64, usize>("user", "requestScope")
        // Only request-local storage is enabled: shared layers stay off.
        .policy(Policy::default().request_local(true))
        .key(|id: &u64| KeySpec::new(id))
        .source(move |_scope, _id| {
            let value = calls.fetch_add(1, Ordering::SeqCst) + 1;
            async move { Ok(value) }
        })
        .register()?;

    // Calls without an enabled scope go directly to the source.
    assert_eq!(*lookup.get_uncached(42).await?, 1);
    assert_eq!(*lookup.get_uncached(42).await?, 2);

    let request = cache.enable_guard();
    let first = lookup.get(request.scope(), 42).await?;
    let again = lookup.get(request.scope(), 42).await?;
    assert_eq!(*first, 3);
    assert!(Arc::ptr_eq(&first, &again));
    drop(request); // Drops the request cache; returned Arcs remain usable.

    let next = cache.enable_guard();
    assert_eq!(*lookup.get(next.scope(), 42).await?, 4);
    assert_eq!(source_calls.load(Ordering::SeqCst), 4);
    // #endregion request-scope
    Ok(())
}

#[tokio::test]
async fn runtime_policy() -> Result<(), BoxError> {
    // #region runtime-policy
    // In an application, update this snapshot from your configuration service.
    let overlay = Arc::new(RwLock::new(Policy::default().coalesce(false)));
    let current_overlay = overlay.clone();
    let cache = DialCache::builder()
        .policy_provider(move |_identity| {
            let snapshot = current_overlay.read().unwrap().clone();
            async move { Ok(Some(RuntimePolicy::from(snapshot))) }
        })
        .build()?;
    let source_calls = Arc::new(AtomicUsize::new(0));
    let calls = source_calls.clone();
    let lookup = cache
        .use_case::<u64, usize>("user", "runtimePolicy")
        .policy(Policy::default().request_local(true).local_ttl_sec(60))
        .key(|id: &u64| KeySpec::new(id))
        .source(move |_scope, _id| {
            let value = calls.fetch_add(1, Ordering::SeqCst) + 1;
            async move { Ok(value) }
        })
        .register()?;

    // The sparse overlay inherits the local TTL across separate requests.
    for _ in 0..2 {
        let request = cache.enable_guard();
        assert_eq!(*lookup.get(request.scope(), 42).await?, 1);
    }

    // Omitted fields inherit; explicit false and zero disable these paths.
    *overlay.write().unwrap() = Policy::default().request_local(false).local_ramp(0.0);
    let request = cache.enable_guard();
    assert_eq!(*lookup.get(request.scope(), 42).await?, 2);
    assert_eq!(*lookup.get(request.scope(), 42).await?, 3);
    assert_eq!(source_calls.load(Ordering::SeqCst), 3);
    // #endregion runtime-policy
    Ok(())
}

#[cfg(feature = "redis")]
#[tokio::test]
#[ignore = "requires DOCS_REDIS_URL; run cargo test --all-features --test docs_examples -- --ignored"]
async fn tracked_invalidation() -> Result<(), BoxError> {
    use std::time::{Duration, SystemTime, UNIX_EPOCH};

    use dialcache::{Identity, RedisAdapter};
    use redis::AsyncConnectionConfig;

    let url = std::env::var("DOCS_REDIS_URL")?;
    let connection = redis::Client::open(url)?
        .get_multiplexed_async_connection_with_config(
            &AsyncConnectionConfig::new()
                .set_connection_timeout(Some(Duration::from_secs(2)))
                .set_response_timeout(Some(Duration::from_secs(1))),
        )
        .await?;
    let namespace = format!(
        "docs-rust-{}-{}",
        std::process::id(),
        SystemTime::now().duration_since(UNIX_EPOCH)?.as_nanos()
    );
    let keys = Identity::new("user", 42_u64, "profileVersion")
        .namespace(&namespace)
        .tracked(true)
        .keys()?;
    let mut cleanup_connection = connection.clone();
    // #region tracked-invalidation
    // connection is a caller-owned Redis connection with finite command budgets.
    let cache = DialCache::builder()
        .namespace(&namespace)
        .remote(RedisAdapter::new(connection))
        .remote_read_timeout_ms(1_000)
        .build()?;
    let source_version = Arc::new(AtomicUsize::new(1));
    let source_calls = Arc::new(AtomicUsize::new(0));
    let version = source_version.clone();
    let calls = source_calls.clone();
    let profile_version = cache
        .use_case::<u64, usize>("user", "profileVersion")
        // Local layers stay off so every request observes the Redis watermark.
        .policy(Policy::default().remote_ttl_sec(60))
        .tracked(true)
        .key(|id: &u64| KeySpec::new(id))
        .source(move |_scope, _id| {
            calls.fetch_add(1, Ordering::SeqCst);
            let value = version.load(Ordering::SeqCst);
            async move { Ok(value) }
        })
        .register()?;

    {
        let request = cache.enable_guard();
        assert_eq!(*profile_version.get(request.scope(), 42).await?, 1);
    }
    source_version.store(2, Ordering::SeqCst); // Successfully committed source update.
    {
        let request = cache.enable_guard();
        assert_eq!(*profile_version.get(request.scope(), 42).await?, 1);
    }
    assert_eq!(source_calls.load(Ordering::SeqCst), 1); // A proven Redis hit.

    cache.invalidate("user", 42_u64, 0).await?;
    let request = cache.enable_guard();
    assert_eq!(*profile_version.get(request.scope(), 42).await?, 2);
    assert_eq!(source_calls.load(Ordering::SeqCst), 2);
    // #endregion tracked-invalidation

    // Remove only this example's uniquely namespaced keys.
    redis::cmd("DEL")
        .arg(keys.value)
        .arg(keys.watermark.unwrap())
        .query_async::<usize>(&mut cleanup_connection)
        .await?;
    Ok(())
}
