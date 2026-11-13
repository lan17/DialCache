//! Executable source of the shared guides' code regions.
//! Rust-only application recipes also feed the native integration guide.

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

struct SnapshotRemote(dialcache::Payload);

impl dialcache::Remote for SnapshotRemote {
    fn read(
        &self,
        _: dialcache::ReadRequest,
        _: dialcache::ReadContext,
    ) -> futures::future::BoxFuture<'_, Result<dialcache::ReadResult, BoxError>> {
        Box::pin(async {
            Ok(dialcache::ReadResult::Hit(dialcache::Frame {
                created_at_ms: 1_000,
                payload: self.0.clone(),
            }))
        })
    }

    fn write(
        &self,
        _: dialcache::WriteRequest,
    ) -> futures::future::BoxFuture<'_, Result<(), BoxError>> {
        Box::pin(async { Ok(()) })
    }

    fn invalidate(
        &self,
        _: dialcache::InvalidateRequest,
    ) -> futures::future::BoxFuture<'_, Result<(), BoxError>> {
        Box::pin(async { Ok(()) })
    }
}

mod application_budgets {
    use super::*;
    use std::time::Duration;

    use dialcache::{Error, SourceBudget};
    use tokio::sync::{Semaphore, TryAcquireError};
    use tokio::time::{error::Elapsed, timeout};

    #[tokio::test]
    async fn source_permit_outlives_the_cache_wait() -> Result<(), BoxError> {
        let dependency = Arc::new(Semaphore::new(0));
        let started = Arc::new(Semaphore::new(0));
        // #region rust-source-budget
        let source_slots = Arc::new(Semaphore::new(1));
        let cache = DialCache::builder().build()?;
        let reader = cache
            .use_case::<u64, u64>("item", "boundedSource")
            .policy(Policy::default().local_ttl_sec(60))
            .budget(SourceBudget::Millis(20))
            .key(|id: &u64| KeySpec::new(id))
            .source({
                let slots = source_slots.clone();
                let dependency = dependency.clone();
                let started = started.clone();
                move |_scope, id| {
                    let (slots, dependency, started) =
                        (slots.clone(), dependency.clone(), started.clone());
                    async move {
                        // This permit belongs to the raw source, not its caller's wait.
                        let _permit = slots.try_acquire_owned()?;
                        timeout(Duration::from_secs(1), async {
                            started.add_permits(1);
                            // A test dependency; replace with bounded native source I/O.
                            dependency.acquire().await?.forget();
                            Ok::<_, BoxError>(id)
                        })
                        .await?
                    }
                }
            })
            .register()?;
        // #endregion rust-source-budget

        let request = cache.enable_guard();
        let (first, follower) = tokio::join!(
            reader.get(request.scope(), 1),
            reader.get(request.scope(), 1)
        );
        assert!(matches!(first, Err(Error::FallbackTimeout(_))));
        assert!(matches!(follower, Err(Error::FallbackTimeout(_))));
        assert_eq!(started.available_permits(), 1);
        assert_eq!(source_slots.available_permits(), 0);
        for id in [1, 2] {
            let error = reader.get_uncached(id).await.unwrap_err();
            assert!(error.source_error().unwrap().is::<TryAcquireError>());
        }
        dependency.add_permits(1);
        drop(timeout(Duration::from_secs(2), source_slots.acquire()).await??);
        assert_eq!(source_slots.available_permits(), 1);

        // A caller drop also leaves the source permit attached to the raw work.
        started.acquire().await?.forget();
        let caller = tokio::spawn({
            let reader = reader.clone();
            async move { reader.get_uncached(3).await }
        });
        timeout(Duration::from_secs(2), started.acquire())
            .await??
            .forget();
        caller.abort();
        assert!(caller.await.unwrap_err().is_cancelled());
        assert_eq!(source_slots.available_permits(), 0);
        dependency.add_permits(1);
        drop(timeout(Duration::from_secs(2), source_slots.acquire()).await??);

        // Outside a cache scope, the application's own timeout still applies.
        let error = timeout(Duration::from_secs(2), reader.get_uncached(4))
            .await?
            .unwrap_err();
        assert!(error.source_error().unwrap().is::<Elapsed>());
        assert_eq!(source_slots.available_permits(), 1);
        dependency.add_permits(1);
        assert_eq!(*reader.get_uncached(5).await?, 5);
        Ok(())
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn native_work_keeps_its_permit_after_the_wait_ends() -> Result<(), BoxError> {
        use std::io::{ErrorKind, Read};
        use std::net::TcpStream;
        use tokio::io::AsyncWriteExt;
        use tokio::net::TcpListener;

        let listener = TcpListener::bind("127.0.0.1:0").await?;
        let address = listener.local_addr()?;
        let slots = Arc::new(Semaphore::new(1));
        let started = Arc::new(Semaphore::new(0));
        let finished = Arc::new(Semaphore::new(0));
        let active = Arc::new(AtomicUsize::new(0));
        let peak = Arc::new(AtomicUsize::new(0));
        let native_timeouts = Arc::new(AtomicUsize::new(0));
        let cache = DialCache::builder().build()?;
        let reader = cache
            .use_case::<u64, u64>("item", "nativeSource")
            .key(|id: &u64| KeySpec::new(id))
            .source({
                let (slots, started, finished) = (slots.clone(), started.clone(), finished.clone());
                let (active, peak, native_timeouts) =
                    (active.clone(), peak.clone(), native_timeouts.clone());
                move |_, _| {
                    let (slots, started, finished) =
                        (slots.clone(), started.clone(), finished.clone());
                    let (active, peak, native_timeouts) =
                        (active.clone(), peak.clone(), native_timeouts.clone());
                    async move {
                        let permit = slots.try_acquire_owned()?;
                        // Dropping the join handle cannot stop blocking I/O.
                        let work = tokio::task::spawn_blocking(move || {
                            let mut stream =
                                TcpStream::connect_timeout(&address, Duration::from_secs(1))?;
                            stream.set_read_timeout(Some(Duration::from_secs(2)))?;
                            let running = active.fetch_add(1, Ordering::SeqCst) + 1;
                            peak.fetch_max(running, Ordering::SeqCst);
                            started.add_permits(1);
                            let mut reply = [0];
                            let result = stream.read_exact(&mut reply);
                            if result.as_ref().is_err_and(|error| {
                                matches!(error.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock)
                            }) {
                                native_timeouts.fetch_add(1, Ordering::SeqCst);
                            }
                            drop(stream);
                            active.fetch_sub(1, Ordering::SeqCst);
                            drop(permit);
                            finished.add_permits(1);
                            result?;
                            Ok::<_, BoxError>(u64::from(reply[0]))
                        });
                        timeout(Duration::from_millis(200), work).await??
                    }
                }
            })
            .register()?;

        let caller = tokio::spawn({
            let reader = reader.clone();
            async move { reader.get_uncached(1).await }
        });
        let (mut server, _) = timeout(Duration::from_secs(3), listener.accept()).await??;
        timeout(Duration::from_secs(3), started.acquire())
            .await??
            .forget();
        let error = timeout(Duration::from_secs(3), caller).await??.unwrap_err();
        assert!(error.source_error().unwrap().is::<Elapsed>());
        assert_eq!(active.load(Ordering::SeqCst), 1);
        let rejected = reader.get_uncached(2).await.unwrap_err();
        assert_eq!(peak.load(Ordering::SeqCst), 1);
        assert_eq!(active.load(Ordering::SeqCst), 1);
        assert_eq!(slots.available_permits(), 0);
        assert!(rejected.source_error().unwrap().is::<TryAcquireError>());
        assert_eq!(native_timeouts.load(Ordering::SeqCst), 0);
        server.write_all(&[1]).await?;
        timeout(Duration::from_secs(3), finished.acquire())
            .await??
            .forget();
        drop(server);
        assert_eq!(active.load(Ordering::SeqCst), 0);
        assert_eq!(slots.available_permits(), 1);

        let caller = tokio::spawn({
            let reader = reader.clone();
            async move { reader.get_uncached(2).await }
        });
        let (stalled_server, _) = timeout(Duration::from_secs(3), listener.accept()).await??;
        timeout(Duration::from_secs(3), started.acquire())
            .await??
            .forget();
        caller.abort();
        assert!(caller.await.unwrap_err().is_cancelled());
        assert_eq!(active.load(Ordering::SeqCst), 1);
        assert_eq!(slots.available_permits(), 0);
        timeout(Duration::from_secs(4), finished.acquire())
            .await??
            .forget();
        drop(stalled_server);
        assert_eq!(native_timeouts.load(Ordering::SeqCst), 1);
        assert_eq!(active.load(Ordering::SeqCst), 0);
        assert_eq!(slots.available_permits(), 1);

        let caller = tokio::spawn({
            let reader = reader.clone();
            async move { reader.get_uncached(3).await }
        });
        let (mut server, _) = timeout(Duration::from_secs(3), listener.accept()).await??;
        server.write_all(&[3]).await?;
        assert_eq!(*timeout(Duration::from_secs(3), caller).await???, 3);
        timeout(Duration::from_secs(3), finished.acquire())
            .await??
            .forget();
        drop(server);
        assert_eq!(active.load(Ordering::SeqCst), 0);
        assert_eq!(peak.load(Ordering::SeqCst), 1);
        assert_eq!(slots.available_permits(), 1);
        Ok(())
    }

    #[tokio::test]
    async fn provider_failure_never_activates_baseline_caching() -> Result<(), BoxError> {
        let configuration = Arc::new(Semaphore::new(0));
        let provider_started = Arc::new(Semaphore::new(0));
        let source_calls = Arc::new(AtomicUsize::new(0));
        let source_slots = Arc::new(Semaphore::new(1));
        // #region rust-provider-budget
        let provider_slots = Arc::new(Semaphore::new(1));
        let cache = DialCache::builder()
            .policy_provider({
                let slots = provider_slots.clone();
                let configuration = configuration.clone();
                let started = provider_started.clone();
                move |_identity| {
                    let (slots, configuration, started) =
                        (slots.clone(), configuration.clone(), started.clone());
                    async move {
                        let _permit = slots.try_acquire_owned()?;
                        timeout(Duration::from_millis(200), async {
                            started.add_permits(1);
                            // Replace with a bounded config read, or use a local snapshot.
                            configuration.acquire().await?.forget();
                            Ok::<_, BoxError>(None::<RuntimePolicy>)
                        })
                        .await?
                    }
                }
            })
            .build()?;
        // An error stays an error: Ok(None) would activate the baseline policy.
        // #endregion rust-provider-budget
        let reader = cache
            .use_case::<u64, usize>("item", "boundedPolicy")
            .policy(Policy::default().request_local(true).local_ttl_sec(60))
            .key(|id: &u64| KeySpec::new(id))
            .source({
                let slots = source_slots.clone();
                let calls = source_calls.clone();
                move |_, _| {
                    let (slots, calls) = (slots.clone(), calls.clone());
                    async move {
                        let _permit = slots.try_acquire_owned()?;
                        Ok(calls.fetch_add(1, Ordering::SeqCst) + 1)
                    }
                }
            })
            .register()?;
        let request = cache.enable_guard();
        let first = tokio::spawn({
            let (reader, scope) = (reader.clone(), request.scope().clone());
            async move { reader.get(&scope, 1).await }
        });
        timeout(Duration::from_secs(2), provider_started.acquire())
            .await??
            .forget();
        assert_eq!(provider_slots.available_permits(), 0);
        // Both same-key and distinct-key invocations resolve policy before sharing.
        for id in [1, 2, 1] {
            reader.get(request.scope(), id).await?;
        }
        assert_eq!(source_calls.load(Ordering::SeqCst), 3);
        assert_eq!(provider_started.available_permits(), 0);
        let occupied = source_slots.acquire().await?;
        let error = reader.get(request.scope(), 1).await.unwrap_err();
        assert!(error.source_error().unwrap().is::<TryAcquireError>());
        drop(occupied);
        assert_eq!(*timeout(Duration::from_secs(2), first).await???, 4);
        assert_eq!(provider_slots.available_permits(), 1);
        // No result from the failed provider entered the request or local cache.
        assert_eq!(*reader.get(request.scope(), 1).await?, 5);
        assert_eq!(*reader.get_uncached(1).await?, 6);
        Ok(())
    }

    #[tokio::test]
    async fn source_guard_also_applies_to_disabled_shadow_calls() -> Result<(), BoxError> {
        use dialcache::observe::ShadowOutcome;
        use dialcache::{Event, Observer, Payload, ShadowPolicy, SystemClock};

        struct Shadows(Arc<Semaphore>);
        impl Observer for Shadows {
            fn observe(&self, event: &Event) {
                if let Event::ShadowValidation { outcome, .. } = event {
                    assert_eq!(*outcome, ShadowOutcome::SourceError);
                    self.0.add_permits(1);
                }
            }
            fn observes_shadow_outcomes(&self) -> bool {
                true
            }
        }
        let outcomes = Arc::new(Semaphore::new(0));
        let slots = Arc::new(Semaphore::new(1));
        let occupied = slots.acquire().await?;
        let calls = Arc::new(AtomicUsize::new(0));
        let enabled_calls = Arc::new(AtomicUsize::new(0));
        let cache = DialCache::builder()
            .remote(SnapshotRemote(Payload::text("7")))
            .clock(SystemClock::with_sources(|| Duration::ZERO, || 1_000))
            .observer(Shadows(outcomes.clone()))
            .build()?;
        let reader = cache
            .use_case::<u64, u64>("item", "shadowAdmission")
            .policy(Policy::default().remote_ttl_sec(60).shadow(ShadowPolicy {
                ramp: Some(100.0),
                ..Default::default()
            }))
            .key(|id: &u64| KeySpec::new(id))
            .source({
                let (slots, calls) = (slots.clone(), calls.clone());
                let enabled_calls = enabled_calls.clone();
                move |scope, _| {
                    if scope.is_enabled() {
                        enabled_calls.fetch_add(1, Ordering::SeqCst);
                    }
                    let (slots, calls) = (slots.clone(), calls.clone());
                    async move {
                        let _permit = slots.try_acquire_owned()?;
                        calls.fetch_add(1, Ordering::SeqCst);
                        Ok(7)
                    }
                }
            })
            .register()?;
        let request = cache.enable_guard();
        assert_eq!(*reader.get(request.scope(), 1).await?, 7);
        timeout(Duration::from_secs(2), outcomes.acquire())
            .await??
            .forget();
        assert!(reader
            .get_uncached(1)
            .await
            .unwrap_err()
            .source_error()
            .unwrap()
            .is::<TryAcquireError>());
        assert_eq!(calls.load(Ordering::SeqCst), 0);
        drop(occupied);
        assert_eq!(*reader.get_uncached(1).await?, 7);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        assert_eq!(enabled_calls.load(Ordering::SeqCst), 0);
        Ok(())
    }
}

mod mutation_budgets {
    use super::*;
    use std::sync::Mutex;
    use std::time::Duration;

    use dialcache::{
        CancelToken, InvalidateRequest, MissReason, ReadContext, ReadRequest, ReadResult, Remote,
        SourceBudget, WriteRequest,
    };
    use futures::future::BoxFuture;
    use tokio::sync::{oneshot, Semaphore};
    use tokio::time::timeout;

    // #region rust-mutation-budget
    struct MutationBudget {
        remote: Arc<dyn Remote>,
    }

    impl Remote for MutationBudget {
        fn read(
            &self,
            request: ReadRequest,
            context: ReadContext,
        ) -> BoxFuture<'_, Result<ReadResult, BoxError>> {
            self.remote.read(request, context)
        }

        fn write(&self, request: WriteRequest) -> BoxFuture<'_, Result<(), BoxError>> {
            Box::pin(async move {
                timeout(Duration::from_millis(200), async {
                    self.remote.write(request).await
                })
                .await?
            })
        }

        fn invalidate(&self, request: InvalidateRequest) -> BoxFuture<'_, Result<(), BoxError>> {
            Box::pin(async move {
                // One timer covers the complete adapter call, including its retry.
                timeout(Duration::from_millis(200), async {
                    self.remote.invalidate(request).await
                })
                .await?
            })
        }
    }
    // #endregion rust-mutation-budget

    struct AcceptedCommands {
        reads: Mutex<Vec<(ReadRequest, ReadContext)>>,
        started: Semaphore,
        release: Arc<Semaphore>,
        finished: Arc<Semaphore>,
    }

    impl AcceptedCommands {
        async fn dispatch(&self) -> Result<(), BoxError> {
            let (reply, response) = oneshot::channel();
            let (release, finished) = (self.release.clone(), self.finished.clone());
            // A fake server keeps an accepted command even if its response is dropped.
            tokio::spawn(async move {
                release.acquire().await.unwrap().forget();
                finished.add_permits(1);
                let _ = reply.send(());
            });
            self.started.add_permits(1);
            response.await?;
            Ok(())
        }
    }

    impl Remote for AcceptedCommands {
        fn read(
            &self,
            request: ReadRequest,
            context: ReadContext,
        ) -> BoxFuture<'_, Result<ReadResult, BoxError>> {
            self.reads.lock().unwrap().push((request, context));
            Box::pin(async { Ok(ReadResult::miss(MissReason::ValueAbsent)) })
        }

        fn write(&self, _: WriteRequest) -> BoxFuture<'_, Result<(), BoxError>> {
            Box::pin(self.dispatch())
        }

        fn invalidate(&self, _: InvalidateRequest) -> BoxFuture<'_, Result<(), BoxError>> {
            Box::pin(self.dispatch())
        }
    }

    #[tokio::test]
    async fn mutation_timeout_ends_the_wait_not_the_accepted_command() -> Result<(), BoxError> {
        let remote = Arc::new(AcceptedCommands {
            reads: Mutex::new(Vec::new()),
            started: Semaphore::new(0),
            release: Arc::new(Semaphore::new(0)),
            finished: Arc::new(Semaphore::new(0)),
        });
        let bounded = MutationBudget {
            remote: remote.clone(),
        };
        let cancel = CancelToken::new();
        let read = ReadRequest {
            value_key: "value".into(),
            watermark_key: Some("mark".into()),
        };
        bounded
            .read(
                read.clone(),
                ReadContext {
                    timeout_ms: 17,
                    cancel: cancel.clone(),
                },
            )
            .await?;
        cancel.cancel();
        {
            let reads = remote.reads.lock().unwrap();
            assert_eq!(reads[0].0, read);
            assert_eq!(reads[0].1.timeout_ms, 17);
            assert!(reads[0].1.cancel.is_cancelled());
        }
        let cache = DialCache::builder().remote(bounded).build()?;
        let reader = cache
            .use_case::<u64, u64>("item", "boundedMutation")
            .policy(Policy::default().remote_ttl_sec(60))
            .budget(SourceBudget::Millis(5))
            .key(|id: &u64| KeySpec::new(id))
            .source(|_, id| async move { Ok(id) })
            .register()?;
        let request = cache.enable_guard();
        let (first, follower) = timeout(Duration::from_secs(2), async {
            tokio::join!(
                reader.get(request.scope(), 1),
                reader.get(request.scope(), 1)
            )
        })
        .await?;
        assert_eq!(*first?, 1);
        assert_eq!(*follower?, 1);
        assert_eq!(remote.started.available_permits(), 1);
        assert_eq!(cache.coalescing_state().process.active_leaders, 0);
        assert!(cache.invalidate("item", 1_u64, 0).await.is_err());
        assert_eq!(remote.started.available_permits(), 2);
        assert_eq!(remote.finished.available_permits(), 0);
        remote.release.add_permits(2);
        timeout(Duration::from_secs(2), remote.finished.acquire_many(2))
            .await??
            .forget();
        Ok(())
    }

    #[cfg(feature = "redis")]
    #[tokio::test]
    async fn invalidation_retry_shares_one_mutation_deadline() -> Result<(), BoxError> {
        use dialcache::{RedisAdapter, RedisConnection};

        #[derive(Clone, Default)]
        struct Scripts(Arc<Mutex<Vec<Vec<u8>>>>);

        impl RedisConnection for Scripts {
            fn run(&self, command: redis::Cmd) -> BoxFuture<'_, redis::RedisResult<redis::Value>> {
                Box::pin(async move {
                    self.0.lock().unwrap().push(command.get_packed_command());
                    tokio::time::sleep(Duration::from_millis(125)).await;
                    if self.0.lock().unwrap().len() == 1 {
                        Err(std::io::Error::other("first script response failed").into())
                    } else {
                        Ok(redis::Value::Int(1))
                    }
                })
            }

            fn run_on_primary(
                &self,
                _: &str,
                command: redis::Cmd,
            ) -> BoxFuture<'_, redis::RedisResult<redis::Value>> {
                self.run(command)
            }
        }
        let connection = Scripts::default();
        let bounded = MutationBudget {
            remote: Arc::new(RedisAdapter::new(connection.clone())),
        };
        let error = bounded
            .invalidate(InvalidateRequest {
                watermark_key: "{example:item:1}#watermark".into(),
                invalidated_at_ms: 1_000,
                future_buffer_ms: 25,
            })
            .await
            .unwrap_err();
        assert!(error.is::<tokio::time::error::Elapsed>());
        let commands = connection.0.lock().unwrap();
        assert_eq!(commands.len(), 2);
        assert!(commands[0].windows(7).any(|s| s == b"EVALSHA"));
        assert!(commands[1].windows(4).any(|s| s == b"EVAL"));
        let arguments =
            b"$1\r\n1\r\n$26\r\n{example:item:1}#watermark\r\n$2\r\n25\r\n$4\r\n1000\r\n";
        assert!(commands.iter().all(|command| command.ends_with(arguments)));
        Ok(())
    }
}

mod bounded_values {
    use super::*;
    use dialcache::{Codec, JsonCodec, Payload};
    use futures::future::BoxFuture;
    use std::time::Duration;
    use tokio::sync::Semaphore;

    // #region rust-bounded-values
    #[derive(Debug, PartialEq, serde::Serialize, serde::Deserialize)]
    struct Digest([u8; 32]);

    struct DigestCodec;

    impl Codec<Digest> for DigestCodec {
        fn encode<'a>(&'a self, value: &'a Digest) -> BoxFuture<'a, Result<Payload, BoxError>> {
            Box::pin(async move { JsonCodec::encode_value(value) })
        }

        fn decode(&self, payload: Payload) -> BoxFuture<'_, Result<Digest, BoxError>> {
            Box::pin(async move {
                if payload.len() > 129 {
                    return Err("digest JSON is too large".into());
                }
                JsonCodec::decode_value(&payload)
            })
        }
    }
    // #endregion rust-bounded-values

    #[tokio::test]
    async fn fixed_values_and_short_scopes_bound_retained_entries() -> Result<(), BoxError> {
        use dialcache::SystemClock;
        let payload = JsonCodec::encode_value(&Digest([255; 32]))?;
        assert_eq!(payload.len(), 129);
        let remote = SnapshotRemote(payload);
        let clock = SystemClock::with_sources(|| Duration::ZERO, || 1_000);
        // #region rust-bounded-scopes
        let cache = DialCache::builder()
            .local_capacity(1)
            .remote(remote)
            .clock(clock)
            .build()?;
        // #endregion rust-bounded-scopes
        let source_calls = Arc::new(AtomicUsize::new(0));
        let reader = cache
            .use_case::<u8, Digest>("digest", "byId")
            .policy(
                Policy::default()
                    .request_local(true)
                    .local_ttl_sec(60)
                    .remote_ttl_sec(60),
            )
            .key(|id: &u8| KeySpec::new(*id as u64))
            .codec(Arc::new(DigestCodec))
            .source({
                let calls = source_calls.clone();
                move |_, id| {
                    calls.fetch_add(1, Ordering::SeqCst);
                    async move { Ok(Digest([id; 32])) }
                }
            })
            .register()?;
        let request = cache.enable_guard();
        let first = reader.get(request.scope(), 1).await?;
        let first_weak = Arc::downgrade(&first);
        drop(first);
        let second = reader.get(request.scope(), 2).await?;
        let second_weak = Arc::downgrade(&second);
        drop(second);
        assert_eq!(source_calls.load(Ordering::SeqCst), 0);
        assert!(first_weak.upgrade().is_some());
        drop(request);
        assert!(first_weak.upgrade().is_none());
        assert!(second_weak.upgrade().is_some());
        let next = cache.enable_guard();
        reader.get(next.scope(), 3).await?;
        assert!(second_weak.upgrade().is_none());
        drop(next);
        // #region rust-bounded-request
        // Keep this semaphore with the application's request handler.
        let requests = Semaphore::new(1);
        let _request_permit = requests.try_acquire()?;
        let request = cache.enable_guard();
        // This handler accepts at most two fixed-size IDs per request.
        for id in [1_u8, 2] {
            let digest = reader.get(request.scope(), id).await?;
            assert_eq!(digest.0, [255; 32]);
        }
        drop(request);
        // #endregion rust-bounded-request
        assert!(requests.try_acquire().is_err());
        Ok(())
    }

    #[tokio::test]
    async fn invalid_remote_values_use_the_bounded_source_type() -> Result<(), BoxError> {
        use dialcache::SystemClock;
        for payload in [Payload::text("[0]"), Payload::text(" ".repeat(130))] {
            let cache = DialCache::builder()
                .remote(SnapshotRemote(payload))
                .clock(SystemClock::with_sources(|| Duration::ZERO, || 1_000))
                .build()?;
            let calls = Arc::new(AtomicUsize::new(0));
            let reader = cache
                .use_case::<u8, Digest>("digest", "fallback")
                .policy(Policy::default().remote_ttl_sec(60))
                .key(|id: &u8| KeySpec::new(*id as u64))
                .codec(Arc::new(DigestCodec))
                .source({
                    let calls = calls.clone();
                    move |_, id| {
                        calls.fetch_add(1, Ordering::SeqCst);
                        async move { Ok(Digest([id; 32])) }
                    }
                })
                .register()?;
            let request = cache.enable_guard();
            assert_eq!(reader.get(request.scope(), 3).await?.0, [3; 32]);
            assert_eq!(calls.load(Ordering::SeqCst), 1);
        }
        Ok(())
    }
}

mod metric_transport {
    use super::*;
    use std::sync::mpsc::{sync_channel, SyncSender};

    use dialcache::{DatadogObserver, DatadogOptions, DogStatsdClient, ObservationMetricType};

    // #region rust-metric-queue
    struct QueuedMetrics {
        packets: SyncSender<String>,
        dropped: Arc<AtomicUsize>,
    }

    impl QueuedMetrics {
        fn send(&self, name: &str, value: f64, kind: &str, tags: &[(String, String)]) {
            let value = value.to_string();
            let size = name.len()
                + value.len()
                + kind.len()
                + 4
                + tags
                    .iter()
                    .map(|(key, value)| key.len() + value.len() + 1)
                    .sum::<usize>()
                + tags.len().saturating_sub(1);
            let unsafe_tag = tags.iter().any(|(key, value)| {
                key.contains([':', '|', ',', '\n', '\r']) || value.contains(['|', ',', '\n', '\r'])
            });
            if size > 512 || name.contains([':', '|', ',', '\n', '\r']) || unsafe_tag {
                self.dropped.fetch_add(1, Ordering::Relaxed);
                return;
            }
            let tags = tags
                .iter()
                .map(|(key, value)| format!("{key}:{value}"))
                .collect::<Vec<_>>()
                .join(",");
            let packet = format!("{name}:{value}|{kind}|#{tags}");
            if self.packets.try_send(packet).is_err() {
                self.dropped.fetch_add(1, Ordering::Relaxed);
            }
        }
    }

    impl DogStatsdClient for QueuedMetrics {
        fn increment(&self, name: &str, value: f64, tags: &[(String, String)]) {
            self.send(name, value, "c", tags);
        }
        fn histogram(&self, name: &str, value: f64, tags: &[(String, String)]) {
            self.send(name, value, "h", tags);
        }
        fn distribution(&self, name: &str, value: f64, tags: &[(String, String)]) {
            self.send(name, value, "d", tags);
        }
    }
    // #endregion rust-metric-queue

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn full_or_closed_metric_queue_does_not_wait() -> Result<(), BoxError> {
        let (packets, receiver) = sync_channel(1);
        let (finished, completion) = sync_channel(1);
        let watchdog = std::thread::spawn(move || {
            let completed = completion
                .recv_timeout(std::time::Duration::from_secs(2))
                .is_ok();
            drop(receiver);
            completed
        });
        let dropped = Arc::new(AtomicUsize::new(0));
        let client = QueuedMetrics {
            packets,
            dropped: dropped.clone(),
        };
        client.increment("test", 1.0, &[]);
        client.increment("test", 1.0, &[]);
        assert_eq!(dropped.load(Ordering::Relaxed), 1);
        let observer = DatadogObserver::new(
            client,
            DatadogOptions::new(ObservationMetricType::Distribution),
        )?;
        let cache = DialCache::builder().observer(observer).build()?;
        let reader = cache
            .use_case::<u64, u64>("item", "metricsQueue")
            .policy(Policy::default().local_ttl_sec(60))
            .key(|id: &u64| KeySpec::new(id))
            .source(|_, id| async move {
                if id == 0 {
                    Err("source failed".into())
                } else {
                    Ok(id)
                }
            })
            .register()?;
        let request = cache.enable_guard();
        let result = tokio::time::timeout(
            std::time::Duration::from_secs(2),
            reader.get(request.scope(), 1),
        )
        .await;
        let _ = finished.send(());
        assert!(
            watchdog.join().unwrap(),
            "metric export waited for its sink"
        );
        assert_eq!(*result??, 1);
        assert!(dropped.load(Ordering::Relaxed) > 0);
        let before = dropped.load(Ordering::Relaxed);
        assert_eq!(*reader.get(request.scope(), 1).await?, 1);
        assert_eq!(dropped.load(Ordering::Relaxed), before + 2);
        let error = reader.get(request.scope(), 0).await.unwrap_err();
        assert_eq!(error.source_error().unwrap().to_string(), "source failed");
        Ok(())
    }

    #[test]
    fn bounded_packets_reach_only_the_local_test_socket() -> Result<(), BoxError> {
        use dialcache::observe::Layer;
        use dialcache::{Event, Labels, Observer};
        use std::net::UdpSocket;
        use std::time::Duration;

        let receiver = UdpSocket::bind("127.0.0.1:0")?;
        receiver.set_read_timeout(Some(Duration::from_secs(2)))?;
        let socket = UdpSocket::bind("127.0.0.1:0")?;
        socket.connect(receiver.local_addr()?)?;
        socket.set_write_timeout(Some(Duration::from_millis(50)))?;
        let (packets, queue) = sync_channel::<String>(4);
        let errors = Arc::new(AtomicUsize::new(0));
        let send_errors = errors.clone();
        let sender = std::thread::spawn(move || {
            for packet in queue {
                if socket.send(packet.as_bytes()).is_err() {
                    send_errors.fetch_add(1, Ordering::Relaxed);
                }
            }
        });
        let dropped = Arc::new(AtomicUsize::new(0));
        let client = QueuedMetrics {
            packets,
            dropped: dropped.clone(),
        };
        client.increment("test", 1.0, &[("bad".into(), "newline\n".into())]);
        client.increment("test", 1.0, &[("large".into(), "x".repeat(513))]);
        assert_eq!(dropped.load(Ordering::Relaxed), 2);
        let observer = DatadogObserver::new(
            client,
            DatadogOptions::new(ObservationMetricType::Distribution),
        )?;
        let labels = Labels {
            namespace: "example".into(),
            use_case: "item:byId".into(),
            key_type: "item".into(),
            layer: Layer::Local,
        };
        observer.observe(&Event::Request {
            labels: labels.clone(),
        });
        observer.observe(&Event::Get {
            labels,
            seconds: 0.25,
        });
        drop(observer);
        sender.join().unwrap();
        assert_eq!(errors.load(Ordering::Relaxed), 0);
        let mut buffer = [0; 512];
        let count = receiver.recv(&mut buffer)?;
        assert_eq!(std::str::from_utf8(&buffer[..count])?, "dialcache.request.count:1|c|#cache_namespace:example,use_case:item:byId,key_type:item,layer:local");
        let count = receiver.recv(&mut buffer)?;
        assert_eq!(std::str::from_utf8(&buffer[..count])?, "dialcache.get.duration:0.25|d|#cache_namespace:example,use_case:item:byId,key_type:item,layer:local");
        Ok(())
    }
}
