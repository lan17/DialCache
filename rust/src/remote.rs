//! The remote (Redis) adapter boundary.

use futures::future::BoxFuture;

use crate::cancel::CancelToken;
use crate::codec::Payload;
use crate::error::BoxError;

/// One stored value: the writer's wall-clock stamp and the serialized payload.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Frame {
    /// Epoch milliseconds from the writer's clock; a nonnegative safe integer.
    pub created_at_ms: u64,
    pub payload: Payload,
}

/// Bounded cause of a semantic miss.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum MissReason {
    /// The layer had no retrievable value.
    ValueAbsent,
    /// A valid frame's logical age reached its ceiling.
    Expired,
    /// A tracked frame was rejected by an invalidation watermark.
    WatermarkFenced,
    /// A real miss with no decisive cause: malformed frames, unknown replies,
    /// invalid or future timestamps, decode failures.
    Unclassified,
}

impl MissReason {
    pub fn as_str(self) -> &'static str {
        match self {
            MissReason::ValueAbsent => "value_absent",
            MissReason::Expired => "expired",
            MissReason::WatermarkFenced => "watermark_fenced",
            MissReason::Unclassified => "unclassified",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        Some(match text {
            "value_absent" => MissReason::ValueAbsent,
            "expired" => MissReason::Expired,
            "watermark_fenced" => MissReason::WatermarkFenced,
            "unclassified" => MissReason::Unclassified,
            _ => return None,
        })
    }
}

/// Semantic result of one remote read.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadResult {
    /// A complete frame that passed decoding and, for tracked keys, the fence.
    Hit(Frame),
    /// A classified miss. `observed_watermark_ms` is the valid invalidation
    /// watermark read atomically with a tracked value, when one existed; a
    /// refill stamped at or before it is known to remain unreadable.
    Miss {
        reason: MissReason,
        observed_watermark_ms: Option<u64>,
    },
}

impl ReadResult {
    pub fn miss(reason: MissReason) -> Self {
        ReadResult::Miss { reason, observed_watermark_ms: None }
    }

    pub fn is_miss(&self) -> bool {
        matches!(self, ReadResult::Miss { .. })
    }
}

/// Keys of one read: the value key and, for tracked identities, the watermark key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadRequest {
    pub value_key: String,
    pub watermark_key: Option<String>,
}

/// The effective read budget and a cooperative cancellation request.
///
/// The cache's own deadline remains authoritative; adapters may use the token
/// to stop waiting, but a dispatched command may still execute.
#[derive(Debug, Clone)]
pub struct ReadContext {
    pub timeout_ms: u64,
    pub cancel: CancelToken,
}

/// One complete-frame write: a single native `SET value_key frame PX ttl_ms`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteRequest {
    pub value_key: String,
    pub frame: Frame,
    /// Positive milliseconds no greater than 365 days.
    pub ttl_ms: u64,
}

/// One invalidation: advance the entity watermark monotonically.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidateRequest {
    pub watermark_key: String,
    /// The invalidating process's wall clock sample; reused through retries.
    pub invalidated_at_ms: u64,
    /// Nonnegative milliseconds no greater than 365 days.
    pub future_buffer_ms: u64,
}

/// Caller-owned semantic Redis boundary.
///
/// The cache borrows the adapter and never connects, drains or closes it.
/// Tracked reads must observe the value and watermark atomically from an
/// authoritative primary. Writes are one native `SET` of a complete frame
/// stamped by the cache; they never create or extend watermarks.
/// Invalidation runs the shared Lua transition. Use
/// [`crate::protocol::decode_frame`] and [`crate::protocol::encode_frame`]
/// for the wire format.
pub trait Remote: Send + Sync + 'static {
    fn read(&self, request: ReadRequest, context: ReadContext) -> BoxFuture<'_, Result<ReadResult, BoxError>>;
    fn write(&self, request: WriteRequest) -> BoxFuture<'_, Result<(), BoxError>>;
    fn invalidate(&self, request: InvalidateRequest) -> BoxFuture<'_, Result<(), BoxError>>;
}
