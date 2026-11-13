#[cfg(not(unix))]
compile_error!("The local transport fixture requires Unix process signals.");

mod support;

use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use dialcache::{
    CancelToken, DialCache, Frame, Identity, InvalidateRequest, MissReason, Operation, Payload,
    Policy, ReadContext, ReadRequest, ReadResult, RedisAdapter, Remote, SourceBudget, WriteRequest,
};
use redis::sentinel::{SentinelClient, SentinelServerType};
use support::*;

const VALUE_KEY: &str = "{transport:thing:1}:value#frame";
const WATERMARK_KEY: &str = "{transport:thing:1}#watermark";

fn write(stamp: u64) -> WriteRequest {
    WriteRequest {
        value_key: VALUE_KEY.into(),
        frame: Frame {
            created_at_ms: stamp,
            payload: Payload::text("7"),
        },
        ttl_ms: 60_000,
    }
}

async fn read(remote: &impl Remote) -> ReadResult {
    remote
        .read(
            ReadRequest {
                value_key: VALUE_KEY.into(),
                watermark_key: Some(WATERMARK_KEY.into()),
            },
            ReadContext {
                timeout_ms: 200,
                cancel: CancelToken::new(),
            },
        )
        .await
        .unwrap()
}

fn invalidate(stamp: u64) -> InvalidateRequest {
    InvalidateRequest {
        watermark_key: WATERMARK_KEY.into(),
        invalidated_at_ms: stamp,
        future_buffer_ms: 0,
    }
}

async fn round_trip(remote: &impl Remote) {
    remote.write(write(1_000)).await.unwrap();
    assert_eq!(read(remote).await, ReadResult::Hit(write(1_000).frame));
    remote.invalidate(invalidate(1_500)).await.unwrap();
    assert!(matches!(
        read(remote).await,
        ReadResult::Miss {
            reason: MissReason::WatermarkFenced,
            ..
        }
    ));
    remote.write(write(1_501)).await.unwrap();
    assert_eq!(read(remote).await, ReadResult::Hit(write(1_501).frame));
}

#[tokio::test]
async fn tls_checks_trust_and_hostname_then_reconnects() {
    bounded(async {
        let certs = Certificates::new();
        let port = free_port();
        let mut server = certs.start(port, false);
        let client = certs.client("localhost", port, "ca", false);
        let mut plain = ready(&client).await;
        let untrusted = connect(&certs.client("localhost", port, "other-ca", false))
            .await
            .expect_err("untrusted CA accepted")
            .to_string();
        assert!(
            untrusted.contains("UnknownIssuer") || untrusted.contains("unknown issuer"),
            "expected a trust failure, got {untrusted}"
        );
        let wrong_name = connect(&certs.client("127.0.0.1", port, "ca", false))
            .await
            .expect_err("wrong identity accepted")
            .to_string();
        assert!(
            wrong_name.contains("NotValidForName") || wrong_name.contains("not valid for name"),
            "expected a peer identity failure, got {wrong_name}"
        );
        let mut reconnecting = manager(&client).await;
        round_trip(&RedisAdapter::new(reconnecting.clone())).await;
        server.stop();
        assert!(redis::cmd("PING")
            .query_async::<String>(&mut plain)
            .await
            .is_err());
        assert!(redis::cmd("PING")
            .query_async::<String>(&mut reconnecting)
            .await
            .is_err());
        let _replacement = certs.start(port, false);
        ready(&client).await;
        manager_ready(&mut reconnecting).await;
        assert!(
            redis::cmd("PING")
                .query_async::<String>(&mut plain)
                .await
                .is_err(),
            "plain connection reconnected"
        );
        round_trip(&RedisAdapter::new(reconnecting)).await;
    })
    .await;
}

#[tokio::test]
async fn tls_requires_a_valid_client_certificate_when_configured() {
    bounded(async {
        let certs = Certificates::new();
        let port = free_port();
        let _server = certs.start(port, true);
        let client = certs.client("localhost", port, "ca", true);
        let connection = ready(&client).await;
        assert!(
            connect(&certs.client("localhost", port, "ca", false))
                .await
                .is_err(),
            "missing client certificate accepted"
        );
        round_trip(&RedisAdapter::new(connection)).await;
    })
    .await;
}

#[tokio::test]
async fn sentinel_rediscovery_preserves_replicated_watermark_after_promotion() {
    bounded(async {
        let directory = Directory::new();
        let mut primary = Server::start(&directory.0, "primary", free_port(), "", false);
        ready(&primary.client()).await;
        let replica = Server::start(&directory.0, "replica", free_port(),
            &format!("replicaof 127.0.0.1 {}\nrepl-diskless-sync-delay 0", primary.port), false);
        let mut replica_connection = ready(&replica.client()).await;
        let sentinel = Server::start(&directory.0, "sentinel", free_port(),
            &format!("sentinel monitor fixture 127.0.0.1 {} 1\nsentinel down-after-milliseconds fixture 300\nsentinel failover-timeout fixture 2000", primary.port), true);
        let mut sentinel_connection = ready(&sentinel.client()).await;
        let until = Instant::now() + Duration::from_secs(10);
        loop {
            let replicas: Vec<redis::Value> = redis::cmd("SENTINEL").arg("REPLICAS").arg("fixture")
                .query_async(&mut sentinel_connection).await.unwrap();
            let info: String = redis::cmd("INFO").arg("replication").query_async(&mut replica_connection).await.unwrap();
            if !replicas.is_empty() && info.contains("master_link_status:up") {
                break;
            }
            assert!(Instant::now() < until, "Sentinel did not discover a synchronized replica");
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
        let mut discovery = SentinelClient::build(
            vec![format!("redis://127.0.0.1:{}", sentinel.port)],
            "fixture", None, SentinelServerType::Master,
        ).unwrap();
        let initial_client = discovery.async_get_client().await.unwrap();
        let mut old_manager = manager(&initial_client).await;
        let old_remote = RedisAdapter::new(old_manager.clone());
        old_remote.write(write(1_000)).await.unwrap();
        old_remote.invalidate(invalidate(1_500)).await.unwrap();
        let replicated: u64 = redis::cmd("WAIT").arg(1).arg(2_000).query_async(&mut old_manager).await.unwrap();
        assert_eq!(replicated, 1);
        let marker: String = redis::cmd("GET").arg(WATERMARK_KEY).query_async(&mut replica_connection).await.unwrap();
        assert_eq!(marker, "1500");
        primary.stop();
        assert!(redis::cmd("PING").query_async::<String>(&mut old_manager).await.is_err());
        let until = Instant::now() + Duration::from_secs(15);
        let promoted = loop {
            if let Ok(client) = discovery.async_get_client().await {
                if client.get_connection_info().addr() == replica.client().get_connection_info().addr() {
                    break client;
                }
            }
            assert!(Instant::now() < until, "Sentinel did not promote the replica");
            tokio::time::sleep(Duration::from_millis(100)).await;
        };
        assert!(redis::cmd("PING").query_async::<String>(&mut old_manager).await.is_err(),
            "address-bound manager unexpectedly followed Sentinel");
        let mut recovered = manager(&promoted).await;
        let remote = RedisAdapter::new(recovered.clone());
        assert!(matches!(read(&remote).await, ReadResult::Miss { reason: MissReason::WatermarkFenced, .. }));
        redis::cmd("SCRIPT").arg("FLUSH").query_async::<()>(&mut recovered).await.unwrap();
        remote.invalidate(invalidate(2_000)).await.unwrap();
        let marker: String = redis::cmd("GET").arg(WATERMARK_KEY).query_async(&mut recovered).await.unwrap();
        assert_eq!(marker, "2000");
        let retention: i64 = redis::cmd("PTTL").arg(WATERMARK_KEY).query_async(&mut recovered).await.unwrap();
        assert!(retention > 7_190_000, "watermark retention was shortened");
        remote.write(write(1_999)).await.unwrap();
        assert!(matches!(read(&remote).await, ReadResult::Miss { reason: MissReason::WatermarkFenced, .. }));
        remote.write(write(2_001)).await.unwrap();
        assert_eq!(read(&remote).await, ReadResult::Hit(write(2_001).frame));
    }).await;
}

#[tokio::test]
async fn partial_read_reply_times_out_without_refill_and_connection_remains_aligned() {
    bounded(async {
        let directory = Directory::new();
        let server = Server::start(&directory.0, "partial", free_port(), "", false);
        let direct = ready(&server.client()).await;
        let gate = ResponseGate::start(server.port).await;
        let mut through = gate
            .client()
            .get_multiplexed_async_connection_with_config(&config().set_response_timeout(None))
            .await
            .unwrap();
        let identity = Identity::new("thing", "partial", "value")
            .namespace("transport")
            .tracked(true);
        let keys = identity.keys().unwrap();
        let original = WriteRequest {
            value_key: keys.value.clone(),
            frame: Frame {
                created_at_ms: std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_millis() as u64,
                payload: Payload::text("7"),
            },
            ttl_ms: 60_000,
        };
        RedisAdapter::new(direct.clone())
            .write(original.clone())
            .await
            .unwrap();
        let cache = DialCache::builder()
            .remote(RedisAdapter::new(through.clone()))
            .build()
            .unwrap();
        let request = cache.enable_guard();
        let calls = Arc::new(AtomicUsize::new(0));
        let counted = calls.clone();
        gate.hold_next();
        let value = tokio::time::timeout(
            Duration::from_millis(500),
            cache.get_or_load(
                request.scope(),
                Operation::<u64>::new(identity)
                    .policy(
                        Policy::default()
                            .remote_ttl_sec(60)
                            .remote_read_timeout_ms(30),
                    )
                    .budget(SourceBudget::Millis(200)),
                move |_| {
                    counted.fetch_add(1, Ordering::SeqCst);
                    async { Ok(9) }
                },
            ),
        )
        .await
        .expect("the cache read deadline did not release the caller")
        .unwrap();
        assert_eq!(*value, 9);
        assert_eq!(calls.load(Ordering::SeqCst), 1);
        gate.held.notified().await;
        gate.release();
        assert_eq!(
            redis::cmd("PING")
                .query_async::<String>(&mut through)
                .await
                .unwrap(),
            "PONG"
        );
        let observed = RedisAdapter::new(direct)
            .read(
                ReadRequest {
                    value_key: keys.value,
                    watermark_key: keys.watermark,
                },
                ReadContext {
                    timeout_ms: 200,
                    cancel: CancelToken::new(),
                },
            )
            .await
            .unwrap();
        assert_eq!(
            observed,
            ReadResult::Hit(original.frame),
            "fallback replaced the timed-out frame"
        );
    })
    .await;
}

#[tokio::test]
async fn lost_invalidation_reply_can_report_failure_after_the_watermark_committed() {
    bounded(async {
        let directory = Directory::new();
        let server = Server::start(&directory.0, "lost-reply", free_port(), "", false);
        let mut direct = ready(&server.client()).await;
        let gate = ResponseGate::start(server.port).await;
        let mut through = gate
            .client()
            .get_multiplexed_async_connection_with_config(
                &config().set_response_timeout(Some(Duration::from_millis(50))),
            )
            .await
            .unwrap();
        let remote = RedisAdapter::new(through.clone());
        remote.invalidate(invalidate(1_000)).await.unwrap();
        gate.hold_next();
        assert!(
            remote.invalidate(invalidate(2_000)).await.is_err(),
            "lost replies must not report success"
        );
        gate.held.notified().await;
        let marker: String = redis::cmd("GET")
            .arg(WATERMARK_KEY)
            .query_async(&mut direct)
            .await
            .unwrap();
        assert_eq!(
            marker, "2000",
            "caller timeout does not prove mutation failure"
        );
        gate.release();
        assert_eq!(
            redis::cmd("PING")
                .query_async::<String>(&mut through)
                .await
                .unwrap(),
            "PONG"
        );
        remote.invalidate(invalidate(1_500)).await.unwrap();
        let marker: String = redis::cmd("GET")
            .arg(WATERMARK_KEY)
            .query_async(&mut direct)
            .await
            .unwrap();
        assert_eq!(marker, "2000", "retry regressed the watermark");
    })
    .await;
}

#[tokio::test]
async fn timed_out_mutations_can_execute_after_the_server_resumes() {
    bounded(async {
        let directory = Directory::new();
        let server = Server::start(&directory.0, "late-mutation", free_port(), "", false);
        let direct = ready(&server.client()).await;
        let connection = server
            .client()
            .get_multiplexed_async_connection_with_config(
                &config().set_response_timeout(Some(Duration::from_millis(50))),
            )
            .await
            .unwrap();
        let remote = RedisAdapter::new(connection);
        server.signal("-STOP");
        assert!(remote.write(write(1_000)).await.is_err());
        assert!(remote.invalidate(invalidate(1_500)).await.is_err());
        server.signal("-CONT");
        let recovered = RedisAdapter::new(direct);
        let until = Instant::now() + Duration::from_secs(2);
        loop {
            if matches!(
                read(&recovered).await,
                ReadResult::Miss {
                    reason: MissReason::WatermarkFenced,
                    ..
                }
            ) {
                break;
            }
            assert!(Instant::now() < until, "late invalidation did not execute");
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await;
}

#[tokio::test]
async fn transport_shutdown_releases_an_incomplete_reply() {
    bounded(async {
        let directory = Directory::new();
        let server = Server::start(&directory.0, "shutdown", free_port(), "", false);
        let direct = ready(&server.client()).await;
        RedisAdapter::new(direct).write(write(1_000)).await.unwrap();
        let gate = ResponseGate::start(server.port).await;
        let connection = connect(&gate.client()).await.unwrap();
        let remote = RedisAdapter::new(connection);
        gate.hold_next();
        let pending = tokio::spawn(async move {
            remote
                .read(
                    ReadRequest {
                        value_key: VALUE_KEY.into(),
                        watermark_key: Some(WATERMARK_KEY.into()),
                    },
                    ReadContext {
                        timeout_ms: 200,
                        cancel: CancelToken::new(),
                    },
                )
                .await
        });
        gate.held.notified().await;
        drop(gate);
        assert!(pending.await.unwrap().is_err());
    })
    .await;
}
