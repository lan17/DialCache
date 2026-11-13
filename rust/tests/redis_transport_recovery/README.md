# Local Redis transport tests

This separate, non-publishable crate tests a downstream configuration that enables
the `redis` crate's `tokio-rustls-comp`, `sentinel`, and `connection-manager`
features. It selects the rustls `ring` crypto provider. These features are unified
with DialCache's existing Redis dependency for this test process only. They are
not DialCache defaults, and this crate does not change the library's manifest.

## Run

Use the repository's Rust toolchain on Unix. Install `redis-server` with TLS
support, `openssl`, and `kill` on `PATH`. Missing tools or missing TLS support fail
the requested tests; no case is silently skipped.

From the repository root:

```sh
cargo test --locked \
  --manifest-path rust/tests/redis_transport_recovery/Cargo.toml \
  --test transport -- --test-threads=1
```

The suite starts only disposable loopback services. It does not read an external
Redis endpoint. Certificates and private keys are generated in a temporary
directory and removed after each test. Child processes are killed and reaped on
success, failure, and timeout.

Native connection and command waits use a 200 ms budget, except the explicit
50 ms mutation-timeout cases. The partial-read test disables the native response
timeout and requires the cache deadline to release the caller within 500 ms.
Each asynchronous test has a 30-second deadline;
each synchronous certificate-generation command has its own 10-second deadline.
The TCP reply gate is an owned Tokio task that closes its sockets when dropped.

## Coverage

- TLS with an explicit test CA: valid DNS identity succeeds; an untrusted CA and
  mismatched peer identity fail for the corresponding certificate reason.
- Mutual TLS: a valid client certificate succeeds; an absent certificate fails.
- TLS server restart: an address-bound `ConnectionManager` reconnects, while an
  old `MultiplexedConnection` remains disconnected.
- Plaintext Sentinel: one primary, one replica, and one Sentinel with quorum one.
  The test confirms replication of a value and watermark before killing the
  primary. It then discovers the promoted replica and creates a new manager.
  The old address-bound manager is not assumed to follow Sentinel.
- Post-promotion invalidation: an explicit script-cache flush exercises the
  `EVALSHA`/`EVAL` fallback. Watermark retention, monotonicity, old-frame fencing,
  and a later valid frame are checked through real Redis commands.
- Partial read replies: the cache read deadline falls back without a refill.
  Releasing the old response leaves the connection protocol aligned.
- Lost invalidation replies: a caller error does not prove the watermark was not
  committed. Retrying an older cutoff does not lower it.
- Late mutations: a paused server executes already-dispatched writes and
  invalidation after native response timeouts; the resulting watermark fences
  the older value.
- Transport shutdown: closing a connection with an incomplete reply releases the
  pending adapter read with an error.

This is not a load test or a high-availability certification. It does not test
multi-Sentinel quorum loss, split brain, lost replication, TLS Sentinel links,
TLS Cluster routing, certificate rotation, native-tls, or automatic application
connection replacement. Connection discovery and replacement remain application
responsibilities.

## Opt-in mixed load

The separate `mixed_load` target is ignored by default. On Linux, run its cleanup
controls once, then select a 10-second pilot or a 120-second observation:

```sh
cargo test --locked --manifest-path rust/tests/redis_transport_recovery/Cargo.toml \
  --test mixed_load cleanup_controls -- --ignored --nocapture
DIALCACHE_REDIS_LOAD_SECONDS=10 cargo test --locked \
  --manifest-path rust/tests/redis_transport_recovery/Cargo.toml \
  --test mixed_load mixed_load_with_one_outage -- --ignored --nocapture
```

Use `120` instead of `10` for the longer case. The workload is fixed at 200 planned
arrivals per second on four Tokio workers: 60% hot reads, 20% cold reads, 10%
cancellable reads, and 10% invalidations. Values are deterministic, compressible
64 KiB strings tied to their entity ID. The process-local cache is disabled.
There are at most 64 caller operations, eight raw source operations, 64 adapter
operations and 64 native command waits; the Redis client permits 16 concurrent
commands. Admission never waits for capacity. Arrivals over 20 ms late or after
the fixed window closes are counted and dropped.

Each run kills its disposable Redis at one third of the requested duration and
starts a fresh, empty server two seconds later. Planned and actual fault times,
child PIDs, post-restart Redis hits, terminal outcomes, and offered/admitted
ratios are printed. Failed invalidations are not successful fences. Values are
checked for identity and byte integrity, not for revocation of an acquired
snapshot. This case makes no quiescent freshness or durability claim.

The configured connection and response timeouts are 80 ms. This is not a
wall-clock limit on a whole native command future: shared reconnect waits and
client concurrency waits occur before the response timer. The cache read budget
is 30 ms, source work has a 60 ms native budget and an 80 ms cache budget, and the
whole caller operation has a 300 ms deadline from dispatch. Cancellation drops the caller
after two milliseconds, not its underlying source or native command task.
Native command tasks retain their permits and counters until the client future
settles, including its queue and reconnect waits. Independent client reconnect
tasks and server execution after a timeout remain outside those counters.
A final `PING` orders earlier replies on the surviving
connection. One absolute five-second drain deadline includes callers, raw work,
invalidations, server shutdown and cleanup; a run has a further overall deadline
of its requested duration plus 20 seconds.

Latency starts at the intended arrival and ends after value validation. Results
separate all terminals, successful lookups, cancellation, and actual fault
phases. Histograms use 32 power-of-two microsecond buckets with ceiling conversion,
nearest-rank upper bounds, maximum and overflow. Only terminals strictly before
the window end count in within-window rates. Raw work reports distinguish
submission, start, finish, drop and rejection; CPU submission includes rejected
jobs, while source and native submission counts begin after their capacity gate.

Memory output is process RSS and Redis `used_memory`, sampled about every 100 ms
plus the diagnostic query time. It is not allocator attribution or a continuous
peak. Server command totals include diagnostics and Lua commands; the old
server's pre-stop total is a lower bound. This workload is not a capacity target,
a production traffic model, or a general benchmark suite.
