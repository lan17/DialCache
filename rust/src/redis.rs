//! Production [`Remote`] adapter over the [`redis`] crate.
//!
//! [`RedisAdapter`] borrows a connected, caller-owned connection handle: a
//! [`ConnectionManager`] for standalone or Sentinel-managed servers, a
//! [`ClusterConnection`] for Redis Cluster, or a plain
//! [`MultiplexedConnection`]. It never connects, reconnects, drains or closes
//! the handle and never changes its options. The caller remains responsible
//! for:
//!
//! - **Finite budgets.** Configure connection, response and retry limits on
//!   the handle (`ConnectionManagerConfig::set_response_timeout`,
//!   `ClusterClientBuilder::response_timeout`, ...). The cache bounds its own
//!   wait for reads and honors cooperative cancellation, but cancellation
//!   after dispatch cannot prove a command did not execute.
//! - **Primaries for tracked reads.** On a cluster handle the adapter routes
//!   every tracked `MGET` explicitly to the slot primary, so replica lag can
//!   never hide an invalidation watermark even when the caller enabled
//!   `read_from_replicas`. A standalone or Sentinel-managed handle must point
//!   at the primary itself; the adapter cannot tell a replica apart.
//! - **Watermark retention.** Invalidation stores watermarks with a
//!   retention of at least two hours that only widens. Configure eviction so
//!   watermark keys are not evicted before tracked values age out; an
//!   evicted watermark resurrects fenced values.
//!
//! Wire behavior matches the TypeScript and Go adapters exactly: an
//! untracked read is one `GET`; a tracked read is one `MGET value watermark`
//! on the primary; a write is exactly one native `SET key frame PX ttl`; an
//! invalidation is `EVALSHA` of [`INVALIDATION_SCRIPT`] with one `EVAL`
//! retry carrying identical arguments after any `EVALSHA` failure. Accepted
//! but invalid replies are [`RedisProtocolError`]s and are never retried.

use std::fmt;

use futures::future::{self, BoxFuture, Either, FutureExt};
use redis::aio::{ConnectionLike, ConnectionManager, MultiplexedConnection};
use redis::cluster_async::ClusterConnection;
use redis::cluster_routing::{Route, RoutingInfo, SingleNodeRoutingInfo, Slot, SlotAddr};
use redis::{Cmd, RedisResult, Value};
use sha1::{Digest, Sha1};

use crate::error::BoxError;
use crate::limits::{MAX_SAFE_INTEGER, MAX_SUPPORTED_DURATION_MS};
use crate::protocol::{decode_frame, encode_frame, ProtocolError};
use crate::remote::{
    InvalidateRequest, ReadContext, ReadRequest, ReadResult, Remote, WriteRequest,
};

/// The version-1 wire invalidation transition, byte-identical to the Go
/// `InvalidationScript` (a unit test pins this against `go/redis_adapter.go`).
/// TypeScript's `INVALIDATE_CACHE_SCRIPT` is the same Lua with different
/// whitespace and a comment, so its `EVALSHA` digest differs; every port
/// self-heals through the `EVAL` fallback, so mixed-language clusters need no
/// shared script cache.
///
/// Redis Lua numbers exactly represent the accepted safe-integer domain.
/// Invalid arguments return before `GET`/repair; wrong-type keys alone are
/// repairable read failures.
pub const INVALIDATION_SCRIPT: &str = r#"local function parse_safe_integer(raw)
  if not string.match(raw, "^%d+$") then return nil end
  local value = tonumber(raw)
  if not value or value > 9007199254740991 then return nil end
  return value
end
local future_buffer_ms = parse_safe_integer(ARGV[1])
if not future_buffer_ms or future_buffer_ms < 0 or future_buffer_ms > 31536000000 then
  return redis.error_reply("ERR invalid DialCache future buffer")
end
local invalidated_at_ms = parse_safe_integer(ARGV[2])
if not invalidated_at_ms or invalidated_at_ms > 9007199254740991 - future_buffer_ms then
  return redis.error_reply("ERR invalid DialCache invalidatedAtMs")
end
local proposed_watermark = invalidated_at_ms + future_buffer_ms
local raw_watermark = redis.pcall("GET", KEYS[1])
if type(raw_watermark) == "table" and raw_watermark.err then
  if not string.match(raw_watermark.err, "^WRONGTYPE ") then return raw_watermark end
  raw_watermark = false
end
local current_watermark = 0
if raw_watermark then
  local parsed_watermark = parse_safe_integer(raw_watermark)
  if parsed_watermark then current_watermark = parsed_watermark end
end
local watermark = math.max(current_watermark, proposed_watermark)
local current_ttl_ms = -2
if raw_watermark then current_ttl_ms = redis.call("PTTL", KEYS[1]) end
local desired_ttl_ms = math.max(7200000, watermark - invalidated_at_ms + 3600000 + 60000)
if current_ttl_ms > desired_ttl_ms then desired_ttl_ms = current_ttl_ms end
local encoded_watermark = string.format("%.0f", watermark)
if current_ttl_ms == -1 then
  redis.call("SET", KEYS[1], encoded_watermark)
else
  redis.call("SET", KEYS[1], encoded_watermark, "PX", desired_ttl_ms)
end
return 1"#;

/// Lowercase hex SHA-1 of [`INVALIDATION_SCRIPT`], the `EVALSHA` argument.
pub fn invalidation_script_sha1() -> String {
    hex::encode(Sha1::digest(INVALIDATION_SCRIPT.as_bytes()))
}

/// A reply the server accepted but that violates the DialCache wire protocol.
///
/// Such replies are never retried: the command executed and the adapter has
/// no way to tell what state the server holds.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("Invalid DialCache Redis reply: {message}")]
pub struct RedisProtocolError {
    pub message: String,
}

impl RedisProtocolError {
    fn new(message: impl Into<String>) -> Self {
        RedisProtocolError {
            message: message.into(),
        }
    }
}

/// A read stopped waiting because its [`ReadContext`] was cancelled.
///
/// The command may still execute on the server; the cache's own deadline is
/// authoritative and this error only ends the adapter's wait.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("DialCache Redis read cancelled before a reply arrived")]
pub struct RedisReadCancelled;

/// A cloneable, task-shareable handle that runs one Redis command.
///
/// Implemented for [`ConnectionManager`], [`MultiplexedConnection`] and
/// [`ClusterConnection`]. Test doubles implement it to observe dispatched
/// arguments without a server. Every method borrows `&self`; implementations
/// clone the underlying handle per command, which the `redis` crate's handles
/// make cheap.
pub trait RedisConnection: Send + Sync + 'static {
    /// Run one command with the handle's default routing.
    fn run(&self, cmd: Cmd) -> BoxFuture<'_, RedisResult<Value>>;

    /// Run one command that reads `key`, on the node that owns the key's
    /// slot as a primary. Non-cluster handles have exactly one node and use
    /// their default routing.
    fn run_on_primary(&self, key: &str, cmd: Cmd) -> BoxFuture<'_, RedisResult<Value>>;
}

/// Lift a RESP3 error reply carried as a value into the error channel so
/// every caller sees one failure shape.
fn settle(reply: RedisResult<Value>) -> RedisResult<Value> {
    match reply {
        Ok(Value::ServerError(error)) => Err(error.into()),
        other => other,
    }
}

fn run_cloned<C>(connection: &C, cmd: Cmd) -> BoxFuture<'_, RedisResult<Value>>
where
    C: ConnectionLike + Clone + Send + Sync,
{
    let mut connection = connection.clone();
    async move { settle(connection.req_packed_command(&cmd).await) }.boxed()
}

impl RedisConnection for ConnectionManager {
    fn run(&self, cmd: Cmd) -> BoxFuture<'_, RedisResult<Value>> {
        run_cloned(self, cmd)
    }

    fn run_on_primary(&self, _key: &str, cmd: Cmd) -> BoxFuture<'_, RedisResult<Value>> {
        run_cloned(self, cmd)
    }
}

impl RedisConnection for MultiplexedConnection {
    fn run(&self, cmd: Cmd) -> BoxFuture<'_, RedisResult<Value>> {
        run_cloned(self, cmd)
    }

    fn run_on_primary(&self, _key: &str, cmd: Cmd) -> BoxFuture<'_, RedisResult<Value>> {
        run_cloned(self, cmd)
    }
}

impl RedisConnection for ClusterConnection {
    fn run(&self, cmd: Cmd) -> BoxFuture<'_, RedisResult<Value>> {
        run_cloned(self, cmd)
    }

    /// Selecting the slot primary is explicit here because a stale replica
    /// could hide an invalidation fence when the client enabled replica reads.
    fn run_on_primary(&self, key: &str, cmd: Cmd) -> BoxFuture<'_, RedisResult<Value>> {
        let route = Route::with_slot(Slot::for_key(key), SlotAddr::Master);
        let routing = RoutingInfo::SingleNode(SingleNodeRoutingInfo::SpecificNode(route));
        let mut connection = self.clone();
        async move { settle(connection.route_command(cmd, routing).await) }.boxed()
    }
}

/// [`Remote`] over a caller-owned `redis` crate connection handle.
///
/// See the [module documentation](self) for the caller's responsibilities.
#[derive(Clone)]
pub struct RedisAdapter<C> {
    connection: C,
}

impl<C> fmt::Debug for RedisAdapter<C> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("RedisAdapter").finish_non_exhaustive()
    }
}

impl<C: RedisConnection> RedisAdapter<C> {
    /// Borrow `connection`. The adapter never connects or closes it.
    pub fn new(connection: C) -> Self {
        RedisAdapter { connection }
    }

    /// The borrowed connection handle.
    pub fn connection(&self) -> &C {
        &self.connection
    }

    /// The script's raw decimal boundary for out-of-band tooling and
    /// conformance replay. Validation inside Lua precedes every mutation.
    ///
    /// `EVALSHA` runs first; any failure is retried exactly once as `EVAL`
    /// with identical arguments, and a failed retry surfaces unmodified. The
    /// transition is idempotent (the watermark only advances and its
    /// retention only widens), so a duplicate run after an ambiguous failure
    /// is harmless. A successful reply must be the integer `1`.
    pub fn invalidate_decimal<'a>(
        &'a self,
        watermark_key: &'a str,
        future_buffer_ms: &'a str,
        invalidated_at_ms: &'a str,
    ) -> BoxFuture<'a, Result<(), BoxError>> {
        async move {
            let script_command = |program: &str, script: &str| {
                let mut cmd = redis::cmd(program);
                cmd.arg(script)
                    .arg(1)
                    .arg(watermark_key)
                    .arg(future_buffer_ms)
                    .arg(invalidated_at_ms);
                cmd
            };
            let evalsha = script_command("EVALSHA", &invalidation_script_sha1());
            let reply = match self.connection.run(evalsha).await {
                Ok(reply) => reply,
                Err(_) => {
                    let eval = script_command("EVAL", INVALIDATION_SCRIPT);
                    self.connection.run(eval).await?
                }
            };
            validate_invalidation_reply(&reply)?;
            Ok(())
        }
        .boxed()
    }
}

/// One bulk-string reply position: `None` is absent.
type Bulk = Option<Vec<u8>>;

/// One bulk-string reply position: `Nil` is absent, string replies are
/// content, anything else is a protocol violation.
fn bulk(reply: Value) -> Result<Bulk, RedisProtocolError> {
    match reply {
        Value::Nil => Ok(None),
        Value::BulkString(bytes) => Ok(Some(bytes)),
        Value::SimpleString(text) => Ok(Some(text.into_bytes())),
        other => Err(RedisProtocolError::new(format!(
            "expected Redis bulk string, got {}",
            value_kind(&other)
        ))),
    }
}

/// A tracked read must return exactly two bulk values.
fn tracked_reply(reply: Value) -> Result<(Bulk, Bulk), RedisProtocolError> {
    let Value::Array(items) = reply else {
        return Err(RedisProtocolError::new(
            "tracked read must return exactly two bulk values",
        ));
    };
    let [value, watermark]: [Value; 2] = items
        .try_into()
        .map_err(|_| RedisProtocolError::new("tracked read must return exactly two bulk values"))?;
    Ok((bulk(value)?, bulk(watermark)?))
}

/// `SET` must answer `OK`.
pub fn validate_set_reply(reply: &Value) -> Result<(), RedisProtocolError> {
    let ok = match reply {
        Value::Okay => true,
        Value::SimpleString(text) => text == "OK",
        Value::BulkString(bytes) => bytes == b"OK",
        _ => false,
    };
    if ok {
        Ok(())
    } else {
        Err(RedisProtocolError::new(
            "invalid Redis SET reply; expected OK",
        ))
    }
}

/// The invalidation script must answer the integer `1`.
pub fn validate_invalidation_reply(reply: &Value) -> Result<(), RedisProtocolError> {
    if matches!(reply, Value::Int(1)) {
        Ok(())
    } else {
        Err(RedisProtocolError::new(
            "invalid Redis invalidation reply; expected integer 1",
        ))
    }
}

fn value_kind(value: &Value) -> &'static str {
    match value {
        Value::Nil => "nil",
        Value::Int(_) => "integer",
        Value::BulkString(_) => "bulk string",
        Value::Array(_) => "array",
        Value::SimpleString(_) => "simple string",
        Value::Okay => "OK",
        Value::Map(_) => "map",
        Value::Attribute { .. } => "attribute",
        Value::Set(_) => "set",
        Value::Double(_) => "double",
        Value::Boolean(_) => "boolean",
        Value::VerbatimString { .. } => "verbatim string",
        Value::BigNumber(_) => "big number",
        Value::Push { .. } => "push",
        Value::ServerError(_) => "server error",
        _ => "unknown",
    }
}

impl<C: RedisConnection> Remote for RedisAdapter<C> {
    fn read(
        &self,
        request: ReadRequest,
        context: ReadContext,
    ) -> BoxFuture<'_, Result<ReadResult, BoxError>> {
        async move {
            if context.cancel.is_cancelled() {
                return Err(Box::new(RedisReadCancelled) as BoxError);
            }
            let tracked = request.watermark_key.is_some();
            let command = match &request.watermark_key {
                None => {
                    let mut cmd = redis::cmd("GET");
                    cmd.arg(&request.value_key);
                    self.connection.run(cmd)
                }
                Some(watermark_key) => {
                    let mut cmd = redis::cmd("MGET");
                    cmd.arg(&request.value_key).arg(watermark_key);
                    self.connection.run_on_primary(&request.value_key, cmd)
                }
            };
            let reply = match future::select(command, context.cancel.cancelled()).await {
                Either::Left((reply, _)) => reply?,
                Either::Right(((), _)) => return Err(Box::new(RedisReadCancelled) as BoxError),
            };
            let (value, watermark) = if tracked {
                tracked_reply(reply)?
            } else {
                (bulk(reply)?, None)
            };
            Ok(decode_frame(
                value.as_deref(),
                tracked,
                watermark.as_deref(),
            )?)
        }
        .boxed()
    }

    /// Exactly one native `SET` of the complete frame. It neither reads nor
    /// modifies the entity watermark; the frame's stamp is stored exactly.
    fn write(&self, request: WriteRequest) -> BoxFuture<'_, Result<(), BoxError>> {
        async move {
            if request.ttl_ms == 0 || request.ttl_ms > MAX_SUPPORTED_DURATION_MS {
                return Err(ProtocolError::InvalidDuration.into());
            }
            let raw = encode_frame(&request.frame)?;
            let mut cmd = redis::cmd("SET");
            cmd.arg(&request.value_key)
                .arg(raw)
                .arg("PX")
                .arg(request.ttl_ms.to_string());
            let reply = self.connection.run(cmd).await?;
            validate_set_reply(&reply)?;
            Ok(())
        }
        .boxed()
    }

    /// The caller's clock sample stays stable through the `EVAL` retry, so
    /// one logical invalidation proposes one watermark.
    fn invalidate(&self, request: InvalidateRequest) -> BoxFuture<'_, Result<(), BoxError>> {
        async move {
            if request.future_buffer_ms > MAX_SUPPORTED_DURATION_MS {
                return Err(ProtocolError::InvalidDuration.into());
            }
            if request.invalidated_at_ms > MAX_SAFE_INTEGER - request.future_buffer_ms {
                return Err(ProtocolError::InvalidTimestamp.into());
            }
            self.invalidate_decimal(
                &request.watermark_key,
                &request.future_buffer_ms.to_string(),
                &request.invalidated_at_ms.to_string(),
            )
            .await
        }
        .boxed()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::cancel::CancelToken;
    use crate::codec::Payload;
    use crate::remote::{Frame, MissReason};
    use parking_lot::Mutex;
    use std::collections::VecDeque;
    use std::path::Path;
    use std::sync::Arc;
    use std::time::Duration;

    /// One recorded dispatch: whether it was pinned to a primary, and its
    /// arguments including the command name.
    #[derive(Debug, Clone, PartialEq, Eq)]
    struct Call {
        primary: bool,
        args: Vec<Vec<u8>>,
    }

    /// Replays scripted replies in order; a missing reply means "hang".
    #[derive(Default)]
    struct Scripted {
        calls: Mutex<Vec<Call>>,
        replies: Mutex<VecDeque<RedisResult<Value>>>,
    }

    impl Scripted {
        fn with(replies: Vec<RedisResult<Value>>) -> Arc<Self> {
            Arc::new(Scripted {
                calls: Mutex::new(Vec::new()),
                replies: Mutex::new(replies.into_iter().collect()),
            })
        }

        fn calls(&self) -> Vec<Call> {
            self.calls.lock().clone()
        }

        fn dispatch(&self, primary: bool, cmd: &Cmd) -> BoxFuture<'static, RedisResult<Value>> {
            let args = cmd
                .args_iter()
                .map(|arg| match arg {
                    redis::Arg::Simple(bytes) => bytes.to_vec(),
                    _ => b"<cursor>".to_vec(),
                })
                .collect();
            self.calls.lock().push(Call { primary, args });
            match self.replies.lock().pop_front() {
                Some(reply) => future::ready(reply).boxed(),
                None => future::pending().boxed(),
            }
        }
    }

    impl RedisConnection for Arc<Scripted> {
        fn run(&self, cmd: Cmd) -> BoxFuture<'_, RedisResult<Value>> {
            self.dispatch(false, &cmd)
        }

        fn run_on_primary(&self, _key: &str, cmd: Cmd) -> BoxFuture<'_, RedisResult<Value>> {
            self.dispatch(true, &cmd)
        }
    }

    fn failure() -> RedisResult<Value> {
        Err(redis::RedisError::from((
            redis::ErrorKind::Io,
            "ambiguous response loss",
        )))
    }

    fn strings(args: &[Vec<u8>]) -> Vec<String> {
        args.iter()
            .map(|arg| String::from_utf8_lossy(arg).into_owned())
            .collect()
    }

    fn block_on<T>(future: impl std::future::Future<Output = T>) -> T {
        futures::executor::block_on(future)
    }

    fn tracked(value_key: &str, watermark_key: &str) -> ReadRequest {
        ReadRequest {
            value_key: value_key.to_string(),
            watermark_key: Some(watermark_key.to_string()),
        }
    }

    fn context() -> ReadContext {
        ReadContext {
            timeout_ms: 50,
            cancel: CancelToken::new(),
        }
    }

    fn go_invalidation_script() -> String {
        let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../go/redis_adapter.go");
        let source = std::fs::read_to_string(&path)
            .unwrap_or_else(|error| panic!("read {}: {error}", path.display()));
        let start = source
            .find("const InvalidationScript = `")
            .expect("Go declares InvalidationScript")
            + "const InvalidationScript = `".len();
        let end = source[start..]
            .find('`')
            .expect("Go raw string literal closes");
        source[start..start + end].to_string()
    }

    #[test]
    fn invalidation_script_matches_go_byte_for_byte() {
        assert_eq!(INVALIDATION_SCRIPT, go_invalidation_script());
    }

    #[test]
    fn invalidation_script_sha1_matches_independent_digests() {
        let sha = invalidation_script_sha1();
        // Pinned from `shasum -a 1` over the Go constant. TypeScript's
        // INVALIDATE_CACHE_SCRIPT_SHA1 (e90603d37a1a3d7a49ae5417bea0d595b94ddec6)
        // hashes the same Lua with different formatting.
        assert_eq!(sha, "a6c1c661884bd7f535a13c79135a40b1edd2e216");
        assert_eq!(sha, redis::Script::new(INVALIDATION_SCRIPT).get_hash());
    }

    #[test]
    fn write_is_one_set_with_px_and_validates_ok() {
        let frame = Frame {
            created_at_ms: 1_700_000_000_000,
            payload: Payload::binary(vec![0, 1, 255]),
        };
        let connection = Scripted::with(vec![Ok(Value::Okay)]);
        let adapter = RedisAdapter::new(connection.clone());
        block_on(adapter.write(WriteRequest {
            value_key: "value".into(),
            frame: frame.clone(),
            ttl_ms: 2,
        }))
        .expect("SET succeeds");
        let calls = connection.calls();
        assert_eq!(calls.len(), 1);
        assert!(!calls[0].primary);
        assert_eq!(
            calls[0].args,
            vec![
                b"SET".to_vec(),
                b"value".to_vec(),
                encode_frame(&frame).unwrap(),
                b"PX".to_vec(),
                b"2".to_vec(),
            ]
        );

        for ttl_ms in [0, MAX_SUPPORTED_DURATION_MS + 1] {
            let error = block_on(adapter.write(WriteRequest {
                value_key: "value".into(),
                frame: frame.clone(),
                ttl_ms,
            }))
            .expect_err("invalid TTL rejected");
            assert!(error.is::<ProtocolError>(), "{error}");
        }
        assert_eq!(connection.calls().len(), 1, "invalid input dispatched");

        for reply in [
            Value::Nil,
            Value::SimpleString("ok".into()),
            Value::Boolean(true),
            Value::Int(1),
        ] {
            assert!(validate_set_reply(&reply).is_err(), "{reply:?}");
        }
        for reply in [
            Value::Okay,
            Value::SimpleString("OK".into()),
            Value::BulkString(b"OK".to_vec()),
        ] {
            assert!(validate_set_reply(&reply).is_ok(), "{reply:?}");
        }
    }

    #[test]
    fn write_reports_protocol_error_on_bad_reply() {
        let connection = Scripted::with(vec![Ok(Value::Int(1))]);
        let adapter = RedisAdapter::new(connection);
        let error = block_on(adapter.write(WriteRequest {
            value_key: "value".into(),
            frame: Frame {
                created_at_ms: 1,
                payload: Payload::text("1"),
            },
            ttl_ms: 1,
        }))
        .expect_err("bad reply rejected");
        assert!(error.is::<RedisProtocolError>(), "{error}");
    }

    #[test]
    fn invalidate_retries_evalsha_once_as_eval_with_identical_arguments() {
        let connection = Scripted::with(vec![failure(), Ok(Value::Int(1))]);
        let adapter = RedisAdapter::new(connection.clone());
        block_on(adapter.invalidate(InvalidateRequest {
            watermark_key: "watermark".into(),
            invalidated_at_ms: 1_700_000_000_000,
            future_buffer_ms: 100,
        }))
        .expect("EVAL retry succeeds");
        let calls = connection.calls();
        assert_eq!(calls.len(), 2, "{calls:?}");
        let first = strings(&calls[0].args);
        let second = strings(&calls[1].args);
        assert_eq!(first[0], "EVALSHA");
        assert_eq!(first[1], invalidation_script_sha1());
        assert_eq!(second[0], "EVAL");
        assert_eq!(second[1], INVALIDATION_SCRIPT);
        assert_eq!(first[2..], second[2..], "retry changed logical arguments");
        assert_eq!(
            first[2..],
            ["1", "watermark", "100", "1700000000000"].map(str::to_string)
        );
    }

    #[test]
    fn invalidate_failed_retry_surfaces_and_stops() {
        let connection = Scripted::with(vec![failure(), failure()]);
        let adapter = RedisAdapter::new(connection.clone());
        let error = block_on(adapter.invalidate_decimal("watermark", "0", "1"))
            .expect_err("second failure surfaces");
        assert!(error.is::<redis::RedisError>(), "{error}");
        assert_eq!(connection.calls().len(), 2);
    }

    #[test]
    fn invalidate_accepted_invalid_reply_is_not_retried() {
        let connection = Scripted::with(vec![Ok(Value::BulkString(b"1".to_vec()))]);
        let adapter = RedisAdapter::new(connection.clone());
        let error = block_on(adapter.invalidate(InvalidateRequest {
            watermark_key: "watermark".into(),
            invalidated_at_ms: 1,
            future_buffer_ms: 0,
        }))
        .expect_err("string reply rejected");
        assert!(error.is::<RedisProtocolError>(), "{error}");
        assert_eq!(
            connection.calls().len(),
            1,
            "invalid accepted reply retried"
        );

        for reply in [
            Value::Nil,
            Value::BulkString(Vec::new()),
            Value::Int(0),
            Value::Double(1.0),
            Value::BulkString(b"1".to_vec()),
            Value::SimpleString("1".into()),
            Value::Boolean(true),
            Value::Okay,
        ] {
            assert!(validate_invalidation_reply(&reply).is_err(), "{reply:?}");
        }
        assert!(validate_invalidation_reply(&Value::Int(1)).is_ok());
    }

    #[test]
    fn invalidate_rejects_out_of_domain_arguments_before_dispatch() {
        let connection = Scripted::with(vec![]);
        let adapter = RedisAdapter::new(connection.clone());
        for (invalidated_at_ms, future_buffer_ms) in [
            (0, MAX_SUPPORTED_DURATION_MS + 1),
            (MAX_SAFE_INTEGER, 1),
            (MAX_SAFE_INTEGER + 1, 0),
        ] {
            let error = block_on(adapter.invalidate(InvalidateRequest {
                watermark_key: "watermark".into(),
                invalidated_at_ms,
                future_buffer_ms,
            }))
            .expect_err("invalid domain rejected");
            assert!(error.is::<ProtocolError>(), "{error}");
        }
        assert!(connection.calls().is_empty());
    }

    #[test]
    fn tracked_read_is_one_primary_mget_classified_by_the_protocol() {
        let raw = encode_frame(&Frame {
            created_at_ms: 2,
            payload: Payload::text("1"),
        })
        .unwrap();
        let bulk = |bytes: &[u8]| Value::BulkString(bytes.to_vec());
        struct Case {
            reply: Value,
            expected: Result<ReadResult, ()>,
        }
        let hit = || {
            Ok(ReadResult::Hit(Frame {
                created_at_ms: 2,
                payload: Payload::text("1"),
            }))
        };
        let miss = |reason, observed| {
            Ok(ReadResult::Miss {
                reason,
                observed_watermark_ms: observed,
            })
        };
        let cases = [
            Case {
                reply: Value::Array(vec![bulk(&raw), bulk(b"1")]),
                expected: hit(),
            },
            Case {
                reply: Value::Array(vec![bulk(&raw), bulk(b"2")]),
                expected: miss(MissReason::WatermarkFenced, Some(2)),
            },
            Case {
                reply: Value::Array(vec![Value::Nil, bulk(b"5")]),
                expected: miss(MissReason::ValueAbsent, Some(5)),
            },
            Case {
                reply: Value::Array(vec![bulk(&raw), Value::Nil]),
                expected: hit(),
            },
            Case {
                reply: Value::Array(vec![bulk(&raw), bulk(b"bad")]),
                expected: miss(MissReason::Unclassified, None),
            },
            Case {
                reply: Value::Array(vec![bulk(&raw)]),
                expected: Err(()),
            },
            Case {
                reply: Value::Array(vec![Value::Int(12), Value::Nil]),
                expected: Err(()),
            },
            Case {
                reply: Value::Array(vec![bulk(&raw), Value::Boolean(false)]),
                expected: Err(()),
            },
            Case {
                reply: bulk(&raw),
                expected: Err(()),
            },
        ];
        for case in cases {
            let connection = Scripted::with(vec![Ok(case.reply.clone())]);
            let adapter = RedisAdapter::new(connection.clone());
            let got = block_on(adapter.read(tracked("value", "watermark"), context()));
            match (&case.expected, &got) {
                (Ok(expected), Ok(got)) => assert_eq!(got, expected, "{:?}", case.reply),
                (Err(()), Err(error)) => {
                    assert!(
                        error.is::<RedisProtocolError>(),
                        "{:?}: {error}",
                        case.reply
                    )
                }
                _ => panic!("reply {:?}: {got:?}", case.reply),
            }
            assert_eq!(
                connection.calls(),
                vec![Call {
                    primary: true,
                    args: vec![b"MGET".to_vec(), b"value".to_vec(), b"watermark".to_vec()],
                }]
            );
        }
    }

    #[test]
    fn untracked_read_is_one_get() {
        let raw = encode_frame(&Frame {
            created_at_ms: 7,
            payload: Payload::binary(vec![0, 255]),
        })
        .unwrap();
        let connection = Scripted::with(vec![Ok(Value::Nil), Ok(Value::BulkString(raw))]);
        let adapter = RedisAdapter::new(connection.clone());
        let request = ReadRequest {
            value_key: "value".into(),
            watermark_key: None,
        };
        assert_eq!(
            block_on(adapter.read(request.clone(), context())).unwrap(),
            ReadResult::miss(MissReason::ValueAbsent)
        );
        assert_eq!(
            block_on(adapter.read(request, context())).unwrap(),
            ReadResult::Hit(Frame {
                created_at_ms: 7,
                payload: Payload::binary(vec![0, 255]),
            })
        );
        let calls = connection.calls();
        assert_eq!(calls.len(), 2);
        for call in calls {
            assert_eq!(
                call,
                Call {
                    primary: false,
                    args: vec![b"GET".to_vec(), b"value".to_vec()],
                }
            );
        }
    }

    #[test]
    fn read_payload_encoding_error_is_an_error_not_a_miss() {
        let mut raw = encode_frame(&Frame {
            created_at_ms: 2,
            payload: Payload::text("1"),
        })
        .unwrap();
        raw[9] = 7;
        let connection = Scripted::with(vec![Ok(Value::BulkString(raw))]);
        let adapter = RedisAdapter::new(connection);
        let error = block_on(adapter.read(
            ReadRequest {
                value_key: "value".into(),
                watermark_key: None,
            },
            context(),
        ))
        .expect_err("unknown encoding tag is an error");
        assert_eq!(
            error.downcast_ref::<ProtocolError>(),
            Some(&ProtocolError::PayloadEncoding)
        );
    }

    #[test]
    fn read_honors_cancellation_before_and_during_the_wait() {
        let connection = Scripted::with(vec![]);
        let adapter = RedisAdapter::new(connection.clone());
        let cancelled = ReadContext {
            timeout_ms: 50,
            cancel: CancelToken::new(),
        };
        cancelled.cancel.cancel();
        let error = block_on(adapter.read(tracked("value", "watermark"), cancelled))
            .expect_err("pre-cancelled read never dispatches");
        assert!(error.is::<RedisReadCancelled>(), "{error}");
        assert!(connection.calls().is_empty());

        let context = context();
        let token = context.cancel.clone();
        let canceller = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(20));
            token.cancel();
        });
        let error = block_on(adapter.read(tracked("value", "watermark"), context))
            .expect_err("hung command is abandoned on cancel");
        canceller.join().unwrap();
        assert!(error.is::<RedisReadCancelled>(), "{error}");
        assert_eq!(
            connection.calls().len(),
            1,
            "the command was dispatched once"
        );
    }
}
