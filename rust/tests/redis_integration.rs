//! Real-server tests of the `redis` adapter, mirroring
//! `go/redis_integration_test.go`: Docker-started Redis 6.2, Redis 7 and
//! Valkey 8 standalone servers plus a single-node Redis 7 cluster, each
//! exercised for complete-frame round trips, watermark fencing, the
//! `EVALSHA` to `EVAL` recovery after `SCRIPT FLUSH`, and the full
//! invalidation vector corpus (`formal/invalidation_vectors.rs`).
//!
//! Every test returns early with a printed message unless
//! `DIALCACHE_RUST_INTEGRATION=1` is set; with it set, the `docker` CLI and
//! the images must be available. Containers are removed by a drop guard on
//! every exit path.
//!
//! Cluster coverage is a single primary with every slot assigned: the
//! adapter's explicit primary routing is exercised through a real
//! `ClusterConnection`, but with no replicas present the test cannot
//! distinguish primary from replica routing the way the Go six-node test
//! does (the `redis` crate exposes no dialer hook to remap the internal
//! container addresses a multi-node cluster announces).

#![cfg(feature = "redis")]

mod formal;
#[path = "formal/invalidation_vectors.rs"]
mod invalidation_vectors;

use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

use dialcache::protocol::encode_frame;
use dialcache::redis::{RedisAdapter, RedisConnection};
use dialcache::{
    CancelToken, Frame, InvalidateRequest, MissReason, Payload, ReadContext, ReadRequest,
    ReadResult, Remote, WriteRequest,
};
use formal::witness::sha256_hex;
use redis::aio::{ConnectionManager, ConnectionManagerConfig};
use redis::cluster::ClusterClientBuilder;
use redis::cluster_async::ClusterConnection;
use redis::{Client, Value};

const ENABLE_ENV: &str = "DIALCACHE_RUST_INTEGRATION";
const COMMAND_BUDGET: Duration = Duration::from_secs(2);
const READY_BUDGET: Duration = Duration::from_secs(15);

fn enabled(test: &str) -> bool {
    if std::env::var(ENABLE_ENV).as_deref() == Ok("1") {
        return true;
    }
    println!("skipping {test}: set {ENABLE_ENV}=1 to run Docker-backed Redis tests");
    false
}

fn repo_root() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("..")
}

/// Run one `docker` command and return its trimmed stdout. A cold `docker
/// run` writes pull progress to stderr and only the container id to stdout.
fn docker(args: &[&str]) -> Result<String, String> {
    let output = Command::new("docker")
        .args(args)
        .output()
        .map_err(|error| format!("docker {args:?}: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "docker {args:?}: {}\nstdout:\n{}\nstderr:\n{}",
            output.status,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        ));
    }
    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// A started container, force-removed when dropped.
struct Container {
    id: String,
}

impl Drop for Container {
    fn drop(&mut self) {
        let _ = Command::new("docker").args(["rm", "-f", &self.id]).output();
    }
}

/// A free loopback port; the listener is dropped so Docker can bind it.
fn free_port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .and_then(|listener| listener.local_addr())
        .expect("bind an ephemeral loopback port")
        .port()
}

/// `docker run` a Redis-compatible image with the Go test's server flags.
/// For a cluster node the host port is chosen first so the node can announce
/// the loopback address a host-side cluster client can reach.
fn start_server(image: &str, cluster: bool) -> (Container, String) {
    let server = if image.contains("valkey") {
        "valkey-server"
    } else {
        "redis-server"
    };
    let announce_port = cluster.then(free_port);
    let publish = match announce_port {
        Some(port) => format!("127.0.0.1:{port}:6379"),
        None => "127.0.0.1::6379".to_string(),
    };
    let announce = announce_port.map(|port| port.to_string());
    let mut args = vec![
        "run",
        "-d",
        "--rm",
        "-p",
        &publish,
        image,
        server,
        "--save",
        "",
        "--appendonly",
        "no",
        "--protected-mode",
        "no",
    ];
    if let Some(port) = &announce {
        args.extend([
            "--cluster-enabled",
            "yes",
            "--cluster-config-file",
            "/tmp/nodes.conf",
            "--cluster-node-timeout",
            "5000",
            "--cluster-announce-ip",
            "127.0.0.1",
            "--cluster-announce-port",
            port,
        ]);
    }
    let id = docker(&args).expect("start container");
    let container = Container { id };
    let endpoint = docker(&["port", &container.id, "6379/tcp"])
        .expect("published port")
        .lines()
        .next()
        .expect("one published endpoint")
        .to_string();
    (container, endpoint)
}

async fn wait_for_ping(endpoint: &str) {
    let client = Client::open(format!("redis://{endpoint}")).expect("client url");
    let deadline = Instant::now() + READY_BUDGET;
    loop {
        if let Ok(mut connection) = client.get_multiplexed_async_connection().await {
            if redis::cmd("PING")
                .query_async::<String>(&mut connection)
                .await
                .is_ok()
            {
                return;
            }
        }
        assert!(Instant::now() < deadline, "{endpoint} did not become ready");
        tokio::time::sleep(Duration::from_millis(25)).await;
    }
}

async fn standalone(image: &str) -> (Container, ConnectionManager) {
    let (container, endpoint) = start_server(image, false);
    wait_for_ping(&endpoint).await;
    let client = Client::open(format!("redis://{endpoint}")).expect("client url");
    let config = ConnectionManagerConfig::new()
        .set_connection_timeout(Some(COMMAND_BUDGET))
        .set_response_timeout(Some(COMMAND_BUDGET))
        .set_number_of_retries(1);
    let connection = client
        .get_connection_manager_with_config(config)
        .await
        .expect("connection manager");
    (container, connection)
}

/// One cluster-enabled node owning every slot; readiness waits for the
/// node's own slot view exactly as the Go test waits for six nodes.
async fn single_node_cluster(image: &str) -> (Container, ClusterConnection) {
    let (container, endpoint) = start_server(image, true);
    wait_for_ping(&endpoint).await;
    docker(&[
        "exec",
        &container.id,
        "redis-cli",
        "CLUSTER",
        "ADDSLOTSRANGE",
        "0",
        "16383",
    ])
    .expect("assign every slot");
    let deadline = Instant::now() + READY_BUDGET;
    loop {
        let info =
            docker(&["exec", &container.id, "redis-cli", "CLUSTER", "INFO"]).unwrap_or_default();
        let field = |name: &str| {
            info.lines()
                .find_map(|line| line.trim().strip_prefix(name)?.strip_prefix(':'))
                .unwrap_or("")
                .to_string()
        };
        if field("cluster_state") == "ok"
            && field("cluster_slots_assigned") == "16384"
            && field("cluster_slots_ok") == "16384"
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "cluster did not become ready:\n{info}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    let connection = ClusterClientBuilder::new([format!("redis://{endpoint}")])
        .connection_timeout(COMMAND_BUDGET)
        .response_timeout(COMMAND_BUDGET)
        .build()
        .expect("cluster client")
        .get_async_connection()
        .await
        .expect("cluster connection");
    (container, connection)
}

fn context() -> ReadContext {
    ReadContext {
        timeout_ms: 50,
        cancel: CancelToken::new(),
    }
}

fn tracked(value_key: &str, watermark_key: &str) -> ReadRequest {
    ReadRequest {
        value_key: value_key.to_string(),
        watermark_key: Some(watermark_key.to_string()),
    }
}

async fn primary_integer<C: RedisConnection>(connection: &C, key: &str, cmd: redis::Cmd) -> i64 {
    match connection
        .run_on_primary(key, cmd)
        .await
        .expect("fixture command")
    {
        Value::Int(value) => value,
        other => panic!("expected integer, got {other:?}"),
    }
}

/// `go/redis_integration_test.go` `testPrimaryRead` plus untracked reads:
/// stored bytes are the exact frame, a value write never extends the
/// watermark, the fence is observed on the primary, and `SCRIPT FLUSH`
/// forces the `EVALSHA` recovery through the real server.
async fn round_trip<C: RedisConnection>(adapter: &RedisAdapter<C>, connection: &C, label: &str) {
    let key = format!("{{primary-rust-{label}}}:value");
    let watermark = format!("{{primary-rust-{label}}}:watermark");
    let untracked = format!("{{primary-rust-{label}}}:untracked");

    let frame = Frame {
        created_at_ms: 2_000,
        payload: Payload::binary(vec![0, 1, 255]),
    };
    let text_frame = Frame {
        created_at_ms: 3_000,
        payload: Payload::text("DialCache é"),
    };
    adapter
        .write(WriteRequest {
            value_key: untracked.clone(),
            frame: text_frame.clone(),
            ttl_ms: 10_000,
        })
        .await
        .expect("untracked write");
    let got = adapter
        .read(
            ReadRequest {
                value_key: untracked.clone(),
                watermark_key: None,
            },
            context(),
        )
        .await
        .expect("untracked read");
    assert_eq!(
        got,
        ReadResult::Hit(text_frame),
        "{label}: untracked round trip"
    );
    let got = adapter
        .read(
            ReadRequest {
                value_key: format!("{untracked}:missing"),
                watermark_key: None,
            },
            context(),
        )
        .await
        .expect("absent read");
    assert_eq!(got, ReadResult::miss(MissReason::ValueAbsent), "{label}");

    // Tracked frame before any watermark: served.
    adapter
        .write(WriteRequest {
            value_key: key.clone(),
            frame: frame.clone(),
            ttl_ms: 10_000,
        })
        .await
        .expect("tracked write");
    let got = adapter
        .read(tracked(&key, &watermark), context())
        .await
        .expect("tracked read");
    assert_eq!(
        got,
        ReadResult::Hit(frame.clone()),
        "{label}: tracked round trip"
    );

    adapter
        .invalidate(InvalidateRequest {
            watermark_key: watermark.clone(),
            invalidated_at_ms: 2_000,
            future_buffer_ms: 0,
        })
        .await
        .expect("invalidate");
    let mut pttl = redis::cmd("PTTL");
    pttl.arg(&watermark);
    let before = primary_integer(connection, &key, pttl.clone()).await;
    adapter
        .write(WriteRequest {
            value_key: key.clone(),
            frame: frame.clone(),
            ttl_ms: 10_000,
        })
        .await
        .expect("tracked write");
    let mut get = redis::cmd("GET");
    get.arg(&key);
    let raw = connection.run_on_primary(&key, get).await.expect("GET");
    assert_eq!(
        raw,
        Value::BulkString(encode_frame(&frame).unwrap()),
        "{label}: stored frame differs"
    );
    let got = adapter
        .read(tracked(&key, &watermark), context())
        .await
        .expect("tracked read");
    assert_eq!(
        got,
        ReadResult::Miss {
            reason: MissReason::WatermarkFenced,
            observed_watermark_ms: Some(2_000),
        },
        "{label}: tracked read missed primary fence"
    );
    let after = primary_integer(connection, &key, pttl).await;
    assert!(
        after <= before,
        "{label}: value write extended watermark {before} -> {after}"
    );

    // A newer frame passes the fence.
    let newer = Frame {
        created_at_ms: 2_001,
        payload: Payload::text("1"),
    };
    adapter
        .write(WriteRequest {
            value_key: key.clone(),
            frame: newer.clone(),
            ttl_ms: 10_000,
        })
        .await
        .expect("newer write");
    let got = adapter
        .read(tracked(&key, &watermark), context())
        .await
        .expect("tracked read");
    assert_eq!(got, ReadResult::Hit(newer), "{label}: newer frame fenced");

    // SCRIPT FLUSH forces the adapter's EVALSHA recovery through the real server.
    let mut flush = redis::cmd("SCRIPT");
    flush.arg("FLUSH");
    connection
        .run_on_primary(&key, flush)
        .await
        .expect("SCRIPT FLUSH");
    let mut evalsha = redis::cmd("EVALSHA");
    evalsha
        .arg(dialcache::redis::invalidation_script_sha1())
        .arg(1)
        .arg(&watermark)
        .arg("0")
        .arg("3000");
    let noscript = connection
        .run_on_primary(&key, evalsha)
        .await
        .expect_err("flushed script cache rejects EVALSHA");
    assert_eq!(noscript.code(), Some("NOSCRIPT"), "{label}: {noscript}");
    adapter
        .invalidate(InvalidateRequest {
            watermark_key: watermark.clone(),
            invalidated_at_ms: 3_000,
            future_buffer_ms: 0,
        })
        .await
        .expect("NOSCRIPT recovery");
    let got = adapter
        .read(tracked(&key, &watermark), context())
        .await
        .expect("tracked read");
    assert_eq!(
        got,
        ReadResult::Miss {
            reason: MissReason::WatermarkFenced,
            observed_watermark_ms: Some(3_000),
        },
        "{label}: recovered invalidation did not fence"
    );
}

async fn exercise<C: RedisConnection>(connection: C, label: &str) {
    let adapter = RedisAdapter::new(connection);
    round_trip(&adapter, adapter.connection(), label).await;
    let vectors = invalidation_vectors::load_corpus(&repo_root(), sha256_hex);
    let prefix = format!("{{rust-invalidation-{label}}}:");
    match invalidation_vectors::replay_all(&adapter, adapter.connection(), &prefix, &vectors).await
    {
        Ok(count) => println!("{label}: replayed {count} invalidation vectors"),
        Err(failures) => panic!(
            "{label}: {} of {} invalidation vectors failed:\n{}",
            failures.len(),
            vectors.len(),
            failures.join("\n")
        ),
    }
}

fn run_standalone(test: &str, image: &str) {
    if !enabled(test) {
        return;
    }
    let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
    runtime.block_on(async {
        let (_container, connection) = standalone(image).await;
        exercise(connection, test).await;
    });
}

#[test]
fn redis_6_2_standalone() {
    run_standalone("redis6.2", "redis:6.2-alpine");
}

#[test]
fn redis_7_standalone() {
    run_standalone("redis7", "redis:7-alpine");
}

#[test]
fn valkey_8_standalone() {
    run_standalone("valkey8", "valkey/valkey:8-alpine");
}

#[test]
fn redis_7_single_node_cluster() {
    if !enabled("cluster") {
        return;
    }
    let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
    runtime.block_on(async {
        let (_container, connection) = single_node_cluster("redis:7-alpine").await;
        exercise(connection, "cluster").await;
    });
}
