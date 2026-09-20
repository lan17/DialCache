//! Real-server tests of the `redis` adapter, mirroring
//! `go/redis_integration_test.go`: Docker-started Redis 6.2, Redis 7 and
//! Valkey 8 standalone servers plus a single-node Redis 7 cluster, each
//! exercised for complete-frame round trips, watermark fencing, the
//! `EVALSHA` to `EVAL` recovery after `SCRIPT FLUSH`, and the full
//! invalidation vector corpus (`formal/invalidation_vectors.rs`), plus actual
//! TypeScript/Rust key, payload and invalidation interoperability; and a
//! replicated Redis 7 cluster that pins tracked reads to the slot primary.
//!
//! Every test here is `#[ignore]`d: `cargo test` reports it as ignored, and
//! `make integration-rust` runs the file with `--ignored` where Docker exists.
//! The `docker` CLI and the images must be available. Containers and the
//! cluster network are removed by drop guards on every exit path.
//!
//! Cluster coverage has two shapes. `redis_7_single_node_cluster` is one
//! primary owning every slot, announced on loopback, and runs the whole
//! corpus through a real `ClusterConnection`. With no replica present it
//! cannot tell primary routing from replica routing, so
//! `redis_7_replicated_cluster_primary_read` adds one primary plus one
//! replica of the same slots on a dedicated Docker bridge network. The
//! nodes gossip their container addresses, which Docker Desktop does not
//! route from the host; `ClusterClientBuilder::node_address_map` remaps
//! each announced address to the node's published loopback port at connect
//! time (the slot map keeps the announced addresses, so `MOVED` redirects
//! still resolve). With replica reads enabled on the client
//! (`read_routing_strategy(RandomReplicaStrategy)`, the successor of
//! `read_from_replicas`), each node's `INFO commandstats` proves every
//! tracked `MGET` executed on the primary and none on the replica: the
//! property `testPrimaryRead` in the Go test checks with per-node route
//! hooks on a six-node cluster.

#![cfg(feature = "redis")]

mod formal;
#[path = "formal/invalidation_vectors.rs"]
mod invalidation_vectors;
mod redis_interop;

use std::collections::HashMap;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use dialcache::protocol::encode_frame;
use dialcache::redis::{RedisAdapter, RedisConnection};
use dialcache::{
    CancelToken, Frame, InvalidateRequest, MissReason, Payload, ReadContext, ReadRequest,
    ReadResult, Remote, WriteRequest,
};
use formal::witness::sha256_hex;
use redis::aio::{ConnectionManager, ConnectionManagerConfig, MultiplexedConnection};
use redis::cluster::{ClusterClientBuilder, NodeAddress};
use redis::cluster_async::ClusterConnection;
use redis::cluster_read_routing::RandomReplicaStrategy;
use redis::cluster_routing::{Route, RoutingInfo, SingleNodeRoutingInfo, Slot, SlotAddr};
use redis::{Client, Value};

const COMMAND_BUDGET: Duration = Duration::from_secs(2);
const READY_BUDGET: Duration = Duration::from_secs(15);

/// The Go test's server flags: no persistence, no protected mode.
const SERVER_FLAGS: [&str; 6] = ["--save", "", "--appendonly", "no", "--protected-mode", "no"];
/// Cluster mode without announce overrides: a node announces the address
/// its peers see it from.
const CLUSTER_FLAGS: [&str; 6] = [
    "--cluster-enabled",
    "yes",
    "--cluster-config-file",
    "/tmp/nodes.conf",
    "--cluster-node-timeout",
    "5000",
];

fn server_binary(image: &str) -> &'static str {
    if image.contains("valkey") {
        "valkey-server"
    } else {
        "redis-server"
    }
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
        server_binary(image),
    ];
    args.extend(SERVER_FLAGS);
    if let Some(port) = &announce {
        args.extend(CLUSTER_FLAGS);
        args.extend([
            "--cluster-announce-ip",
            "127.0.0.1",
            "--cluster-announce-port",
            port,
        ]);
    }
    let id = docker(&args).expect("start container");
    let container = Container { id };
    let endpoint = published_endpoint(&container);
    (container, endpoint)
}

/// The `host:port` Docker published for the container's Redis port.
fn published_endpoint(container: &Container) -> String {
    docker(&["port", &container.id, "6379/tcp"])
        .expect("published port")
        .lines()
        .next()
        .expect("one published endpoint")
        .to_string()
}

/// The value of `name` in an `INFO` or `CLUSTER INFO` reply, or empty when
/// the field is absent. Lines keep their `\r`, which `trim` removes.
fn info_field(info: &str, name: &str) -> String {
    info.lines()
        .find_map(|line| line.trim().strip_prefix(name)?.strip_prefix(':'))
        .unwrap_or("")
        .to_string()
}

/// A node's `CLUSTER INFO` reports a healthy cluster with every slot served.
fn cluster_ready(info: &str) -> bool {
    info_field(info, "cluster_state") == "ok"
        && info_field(info, "cluster_slots_assigned") == "16384"
        && info_field(info, "cluster_slots_ok") == "16384"
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
        if cluster_ready(&info) {
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

async fn exercise<C: RedisConnection>(connection: C, label: &str, endpoint: &str, cluster: bool) {
    let adapter = RedisAdapter::new(connection);
    round_trip(&adapter, adapter.connection(), label).await;
    redis_interop::exercise(&adapter, endpoint, cluster, label).await;
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
    let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
    runtime.block_on(async {
        let (container, connection) = standalone(image).await;
        exercise(connection, test, &published_endpoint(&container), false).await;
    });
}

#[test]
#[ignore = "Docker-backed; run through make integration-rust"]
fn redis_6_2_standalone() {
    run_standalone("redis6.2", "redis:6.2-alpine");
}

#[test]
#[ignore = "Docker-backed; run through make integration-rust"]
fn redis_7_standalone() {
    run_standalone("redis7", "redis:7-alpine");
}

#[test]
#[ignore = "Docker-backed; run through make integration-rust"]
fn valkey_8_standalone() {
    run_standalone("valkey8", "valkey/valkey:8-alpine");
}

#[test]
#[ignore = "Docker-backed; run through make integration-rust"]
fn redis_7_single_node_cluster() {
    let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
    runtime.block_on(async {
        let (container, connection) = single_node_cluster("redis:7-alpine").await;
        exercise(connection, "cluster", &published_endpoint(&container), true).await;
    });
}

/// A Docker bridge network, removed when dropped. The daemon detaches a
/// force-removed container's endpoint asynchronously, so removal retries
/// while the network still reports active endpoints.
struct Network {
    name: String,
}

impl Drop for Network {
    fn drop(&mut self) {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            let output = Command::new("docker")
                .args(["network", "rm", &self.name])
                .output();
            let retry = match &output {
                Ok(output) if output.status.success() => false,
                Ok(output) => String::from_utf8_lossy(&output.stderr).contains("active endpoints"),
                Err(_) => false,
            };
            if !retry || Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

/// One node of the replicated cluster: its container, the loopback
/// endpoint Docker published for host clients, and the bridge address the
/// node announces to its peers (and therefore in `CLUSTER SLOTS`).
struct ClusterNode {
    container: Container,
    endpoint: String,
    bridge_ip: String,
}

impl ClusterNode {
    fn host_port(&self) -> u16 {
        self.endpoint
            .rsplit(':')
            .next()
            .and_then(|port| port.parse().ok())
            .expect("published endpoint has a port")
    }

    /// Run `redis-cli` inside the container for cluster setup commands.
    fn redis_cli(&self, args: &[&str]) -> Result<String, String> {
        let mut command = vec!["exec", self.container.id.as_str(), "redis-cli"];
        command.extend(args);
        docker(&command)
    }
}

/// One primary owning every slot and one replica of it, gossiping over a
/// dedicated bridge network. Field order removes the containers before the
/// network they are attached to.
struct ReplicatedCluster {
    primary: ClusterNode,
    replica: ClusterNode,
    _network: Network,
}

/// `docker run` a cluster node on `network`, publishing its port on a free
/// loopback port and letting it announce its bridge address to peers.
fn start_cluster_node(image: &str, network: &str) -> ClusterNode {
    let mut args = vec![
        "run",
        "-d",
        "--rm",
        "--network",
        network,
        "-p",
        "127.0.0.1::6379",
        image,
        server_binary(image),
    ];
    args.extend(SERVER_FLAGS);
    args.extend(CLUSTER_FLAGS);
    let id = docker(&args).expect("start cluster node");
    let container = Container { id };
    let endpoint = published_endpoint(&container);
    let bridge_ip = docker(&[
        "inspect",
        "--format",
        "{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}",
        &container.id,
    ])
    .expect("bridge address");
    assert!(
        !bridge_ip.is_empty(),
        "container {} has no bridge address",
        container.id
    );
    ClusterNode {
        container,
        endpoint,
        bridge_ip,
    }
}

/// Bring up the replicated cluster: assign every slot to the primary, have
/// it `MEET` the replica, wait for gossip to teach the replica the primary's
/// id, `REPLICATE`, then wait until both nodes report `cluster_state:ok` and
/// the replica's link to its primary is up.
async fn replicated_cluster(image: &str) -> ReplicatedCluster {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|since| since.as_nanos())
        .unwrap_or_default();
    let name = format!("dialcache-rust-{}-{nanos}", std::process::id());
    docker(&["network", "create", &name]).expect("create network");
    let network = Network { name: name.clone() };
    let primary = start_cluster_node(image, &name);
    let replica = start_cluster_node(image, &name);
    let cluster = ReplicatedCluster {
        primary,
        replica,
        _network: network,
    };
    wait_for_ping(&cluster.primary.endpoint).await;
    wait_for_ping(&cluster.replica.endpoint).await;
    cluster
        .primary
        .redis_cli(&["CLUSTER", "ADDSLOTSRANGE", "0", "16383"])
        .expect("assign every slot");
    cluster
        .primary
        .redis_cli(&["CLUSTER", "MEET", &cluster.replica.bridge_ip, "6379"])
        .expect("meet the replica");
    let primary_id = cluster
        .primary
        .redis_cli(&["CLUSTER", "MYID"])
        .expect("primary id");

    // CLUSTER REPLICATE rejects an id the replica has not yet learned.
    let deadline = Instant::now() + READY_BUDGET;
    loop {
        let nodes = cluster
            .replica
            .redis_cli(&["CLUSTER", "NODES"])
            .unwrap_or_default();
        if nodes.lines().any(|line| line.starts_with(&primary_id)) {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "replica never learned the primary {primary_id}:\n{nodes}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    cluster
        .replica
        .redis_cli(&["CLUSTER", "REPLICATE", &primary_id])
        .expect("replicate the primary");

    // The client seeds its slot map from the primary's CLUSTER SLOTS, which
    // omits a replica until gossip has reported a non-zero replication
    // offset for it; wait for that too, or the client would never learn the
    // replica exists.
    let deadline = Instant::now() + READY_BUDGET;
    loop {
        let primary_info = cluster
            .primary
            .redis_cli(&["CLUSTER", "INFO"])
            .unwrap_or_default();
        let replica_info = cluster
            .replica
            .redis_cli(&["CLUSTER", "INFO"])
            .unwrap_or_default();
        let replication = cluster
            .replica
            .redis_cli(&["INFO", "replication"])
            .unwrap_or_default();
        let slots = cluster
            .primary
            .redis_cli(&["CLUSTER", "SLOTS"])
            .unwrap_or_default();
        if cluster_ready(&primary_info)
            && cluster_ready(&replica_info)
            && info_field(&replication, "role") == "slave"
            && info_field(&replication, "master_link_status") == "up"
            && slots
                .lines()
                .any(|line| line.trim() == cluster.replica.bridge_ip)
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "replicated cluster did not become ready:\nprimary:\n{primary_info}\nreplica:\n{replica_info}\nreplication:\n{replication}\nslots:\n{slots}"
        );
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    cluster
}

/// A cluster connection that prefers replicas for reads
/// (`RandomReplicaStrategy`, what the deprecated `read_from_replicas`
/// installs). The nodes announce their bridge addresses, which the host
/// cannot route to under Docker Desktop; `node_address_map` redirects each
/// to the node's published loopback port when the client connects.
async fn replica_reading_connection(cluster: &ReplicatedCluster) -> ClusterConnection {
    let mut addresses = HashMap::new();
    for node in [&cluster.primary, &cluster.replica] {
        addresses.insert(
            NodeAddress::new(node.bridge_ip.as_str(), 6379),
            NodeAddress::new("127.0.0.1", node.host_port()),
        );
    }
    ClusterClientBuilder::new([format!("redis://{}", cluster.primary.endpoint)])
        .connection_timeout(COMMAND_BUDGET)
        .response_timeout(COMMAND_BUDGET)
        .read_routing_strategy(RandomReplicaStrategy)
        .node_address_map(addresses)
        .build()
        .expect("cluster client")
        .get_async_connection()
        .await
        .expect("cluster connection")
}

/// A plain connection to one node's published endpoint, bypassing cluster
/// routing, for per-node observation.
async fn direct_connection(endpoint: &str) -> MultiplexedConnection {
    Client::open(format!("redis://{endpoint}"))
        .expect("client url")
        .get_multiplexed_async_connection()
        .await
        .expect("direct connection")
}

/// How many times the node executed `command`, from `INFO commandstats`
/// (`cmdstat_<command>:calls=N,...`). Commands the node refused with
/// `MOVED` count under `rejected_calls`, not `calls`; a command the node
/// never ran has no line at all.
async fn executed_calls(connection: &mut MultiplexedConnection, command: &str) -> u64 {
    let info: String = redis::cmd("INFO")
        .arg("commandstats")
        .query_async(connection)
        .await
        .expect("INFO commandstats");
    info_field(&info, &format!("cmdstat_{command}"))
        .split(',')
        .find_map(|field| field.strip_prefix("calls="))
        .and_then(|calls| calls.parse().ok())
        .unwrap_or(0)
}

/// Route one `GET key` to a replica of the key's slot through the cluster
/// connection. `ReplicaRequired` can only choose a replica when the client's
/// slot map lists one and otherwise falls back to the primary, so this
/// executing on the replica proves the client knows the replica and reached
/// it through the address map: a `ReplicaOptional` route would have had a
/// replica to pick, which makes the tracked-read assertion decisive.
async fn replica_routed_get(connection: &ClusterConnection, key: &str) {
    let route = Route::with_slot(Slot::for_key(key), SlotAddr::ReplicaRequired);
    let routing = RoutingInfo::SingleNode(SingleNodeRoutingInfo::SpecificNode(route));
    let mut get = redis::cmd("GET");
    get.arg(key);
    connection
        .clone()
        .route_command(get, routing)
        .await
        .expect("replica-routed GET");
}

/// Poll the replica directly (after `READONLY`, so it serves rather than
/// redirects) until the exact frame bytes have replicated.
async fn wait_for_replica_frame(replica: &mut MultiplexedConnection, key: &str, frame: &Frame) {
    redis::cmd("READONLY")
        .query_async::<()>(replica)
        .await
        .expect("READONLY");
    let encoded = encode_frame(frame).expect("encode frame");
    let deadline = Instant::now() + READY_BUDGET;
    loop {
        let stored: Option<Vec<u8>> = redis::cmd("GET")
            .arg(key)
            .query_async(replica)
            .await
            .expect("GET on the replica");
        if stored.as_deref() == Some(encoded.as_slice()) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "replica never received {key}: {stored:?}"
        );
        tokio::time::sleep(Duration::from_millis(10)).await;
    }
}

/// `go/redis_integration_test.go` `testPrimaryRead`'s routing assertion on
/// a cluster that has a replica: with replica reads enabled on the client,
/// every tracked `MGET` still executes on the slot primary and none on the
/// replica, so a lagging replica can never hide a watermark. Each node's own
/// `INFO commandstats` is the witness.
///
/// The `redis` crate's `RandomReplicaStrategy` picks uniformly among
/// replicas only, so a `ReplicaOptional` route would send every one of these
/// reads to the replica and fail on the first. Twelve reads keep the check
/// decisive even against a strategy that chose uniformly between both
/// nodes, where all twelve landing on the primary by chance would be 2^-12,
/// about 0.02%.
#[test]
#[ignore = "Docker-backed; run through make integration-rust"]
fn redis_7_replicated_cluster_primary_read() {
    const TRACKED_READS: u64 = 12;
    const UNTRACKED_READS: u64 = 3;
    let runtime = tokio::runtime::Runtime::new().expect("tokio runtime");
    runtime.block_on(async {
        let cluster = replicated_cluster("redis:7-alpine").await;
        let adapter = RedisAdapter::new(replica_reading_connection(&cluster).await);
        let mut primary = direct_connection(&cluster.primary.endpoint).await;
        let mut replica = direct_connection(&cluster.replica.endpoint).await;

        let key = "{primary-rust-replicated}:value";
        let watermark = "{primary-rust-replicated}:watermark";
        let frame = Frame {
            created_at_ms: 2_000,
            payload: Payload::binary(vec![0, 1, 255]),
        };
        adapter
            .write(WriteRequest {
                value_key: key.to_string(),
                frame: frame.clone(),
                ttl_ms: 60_000,
            })
            .await
            .expect("tracked write");
        wait_for_replica_frame(&mut replica, key, &frame).await;

        // Precondition: the client's slot map holds the replica, so replica
        // routing is a real choice the adapter is declining.
        let primary_gets = executed_calls(&mut primary, "get").await;
        let replica_gets = executed_calls(&mut replica, "get").await;
        replica_routed_get(adapter.connection(), key).await;
        assert_eq!(
            (
                executed_calls(&mut primary, "get").await - primary_gets,
                executed_calls(&mut replica, "get").await - replica_gets
            ),
            (0, 1),
            "replica-routed GET executions (primary, replica): the client does not know the replica"
        );

        let primary_before = executed_calls(&mut primary, "mget").await;
        let replica_before = executed_calls(&mut replica, "mget").await;
        for read in 0..TRACKED_READS {
            let got = adapter
                .read(tracked(key, watermark), context())
                .await
                .expect("tracked read");
            assert_eq!(got, ReadResult::Hit(frame.clone()), "tracked read {read}");
        }
        let primary_after = executed_calls(&mut primary, "mget").await;
        let replica_after = executed_calls(&mut replica, "mget").await;
        assert_eq!(
            (
                primary_after - primary_before,
                replica_after - replica_before
            ),
            (TRACKED_READS, 0),
            "tracked MGET executions (primary, replica): primary {primary_before} -> \
             {primary_after}, replica {replica_before} -> {replica_after}"
        );

        // Untracked reads keep the client's own routing and may execute on
        // either node with replica reads enabled; only the total is pinned
        // and the split is reported.
        let primary_gets = executed_calls(&mut primary, "get").await;
        let replica_gets = executed_calls(&mut replica, "get").await;
        for read in 0..UNTRACKED_READS {
            let got = adapter
                .read(
                    ReadRequest {
                        value_key: key.to_string(),
                        watermark_key: None,
                    },
                    context(),
                )
                .await
                .expect("untracked read");
            assert_eq!(got, ReadResult::Hit(frame.clone()), "untracked read {read}");
        }
        let primary_delta = executed_calls(&mut primary, "get").await - primary_gets;
        let replica_delta = executed_calls(&mut replica, "get").await - replica_gets;
        assert_eq!(
            primary_delta + replica_delta,
            UNTRACKED_READS,
            "untracked GET executions: primary {primary_delta}, replica {replica_delta}"
        );
        println!("replicated: untracked GETs executed on primary={primary_delta} replica={replica_delta}");
    });
}
