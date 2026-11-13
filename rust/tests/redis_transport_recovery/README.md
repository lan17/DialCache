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
