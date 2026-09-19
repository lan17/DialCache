//! The production tokio path: the default runtime captured at build time,
//! coalescing under a multi-thread scheduler, source deadlines on tokio
//! timers, and the cancellation contracts the deterministic harness cannot
//! exercise (dropped `enable` futures, dropped callers).

#![cfg(feature = "tokio")]

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;

use dialcache::{DialCache, Identity, Operation, Policy, Scope, SourceBudget, TokioRuntime};

fn operation(id: &str) -> Operation<u64> {
    Operation::<u64>::new(Identity::new("thing", id, "TokioSmoke"))
        .policy(Policy::default().local_ttl_sec(60))
}

fn source(
    calls: &Arc<AtomicUsize>,
    delay: Duration,
    value: u64,
) -> impl Fn(Scope) -> futures::future::BoxFuture<'static, Result<u64, dialcache::BoxError>>
       + Send
       + Sync
       + 'static {
    let calls = calls.clone();
    move |_| {
        let calls = calls.clone();
        Box::pin(async move {
            tokio::time::sleep(delay).await;
            calls.fetch_add(1, Ordering::SeqCst);
            Ok(value)
        })
    }
}

#[test]
fn building_outside_a_tokio_context_is_a_configuration_error() {
    let error = match DialCache::builder().build() {
        Err(error) => error,
        Ok(_) => panic!("built a default runtime without a tokio context"),
    };
    assert!(
        error.to_string().contains("tokio runtime"),
        "unexpected error: {error}"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn concurrent_callers_coalesce_and_later_callers_hit() {
    let cache = DialCache::builder().build().expect("built inside tokio");
    let calls = Arc::new(AtomicUsize::new(0));
    let request = cache.enable_guard();
    let mut pending = Vec::new();
    for _ in 0..8 {
        let cache = cache.clone();
        let scope = request.scope().clone();
        let load = source(&calls, Duration::from_millis(20), 7);
        pending.push(tokio::spawn(async move {
            cache.get_or_load(&scope, operation("one"), load).await
        }));
    }
    for handle in pending {
        let value = handle.await.expect("task").expect("value");
        assert_eq!(*value, 7);
    }
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "callers were not coalesced"
    );
    let again = cache
        .get_or_load(
            request.scope(),
            operation("one"),
            source(&calls, Duration::ZERO, 8),
        )
        .await
        .expect("hit");
    assert_eq!(*again, 7);
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "a local hit called the source"
    );
}

#[tokio::test]
async fn a_source_deadline_returns_a_timeout_and_leaves_the_source_running() {
    let cache = DialCache::builder()
        .runtime(TokioRuntime::from_handle(tokio::runtime::Handle::current()))
        .build()
        .expect("explicit handle");
    let calls = Arc::new(AtomicUsize::new(0));
    let request = cache.enable_guard();
    let error = cache
        .get_or_load(
            request.scope(),
            operation("slow").budget(SourceBudget::Millis(20)),
            source(&calls, Duration::from_millis(150), 1),
        )
        .await
        .expect_err("deadline");
    assert!(error.is_fallback_timeout(), "unexpected error: {error}");
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    tokio::time::sleep(Duration::from_millis(300)).await;
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "the deadline cancelled the source"
    );
}

#[tokio::test]
async fn dropping_the_enable_future_closes_its_scope() {
    let cache = DialCache::builder().build().expect("built inside tokio");
    let (send, receive) = tokio::sync::oneshot::channel::<Scope>();
    let inner = cache.clone();
    let outcome = tokio::time::timeout(
        Duration::from_millis(10),
        cache.enable(|scope| async move {
            assert!(inner.is_enabled(&scope));
            let _ = send.send(scope);
            std::future::pending::<()>().await;
        }),
    )
    .await;
    assert!(outcome.is_err(), "the callback completed");
    let retained = receive.await.expect("scope handed out");
    assert!(
        !cache.is_enabled(&retained),
        "a dropped enable future left its scope live"
    );
}

#[tokio::test]
async fn dropping_the_caller_future_does_not_cancel_the_execution() {
    let cache = DialCache::builder().build().expect("built inside tokio");
    let calls = Arc::new(AtomicUsize::new(0));
    let request = cache.enable_guard();
    let abandoned = tokio::time::timeout(
        Duration::from_millis(5),
        cache.get_or_load(
            request.scope(),
            operation("kept"),
            source(&calls, Duration::from_millis(50), 3),
        ),
    )
    .await;
    assert!(abandoned.is_err(), "the source finished within 5 ms");
    tokio::time::sleep(Duration::from_millis(150)).await;
    assert_eq!(
        calls.load(Ordering::SeqCst),
        1,
        "the source did not complete"
    );
    let value = cache
        .get_or_load(
            request.scope(),
            operation("kept"),
            source(&calls, Duration::ZERO, 4),
        )
        .await
        .expect("published value");
    assert_eq!(*value, 3, "the abandoned execution did not publish");
    assert_eq!(calls.load(Ordering::SeqCst), 1);
}
