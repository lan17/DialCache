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
    /// The stored payload, envelope included;
    /// [`decompress_payload`](crate::protocol::decompress_payload) unwraps it.
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
    /// The `snake_case` label value shared with the TypeScript and Go ports.
    pub fn as_str(self) -> &'static str {
        match self {
            MissReason::ValueAbsent => "value_absent",
            MissReason::Expired => "expired",
            MissReason::WatermarkFenced => "watermark_fenced",
            MissReason::Unclassified => "unclassified",
        }
    }

    /// The inverse of [`as_str`](Self::as_str). `None` for any other text,
    /// which callers treat as [`MissReason::Unclassified`].
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
        /// Why no servable frame was produced.
        reason: MissReason,
        /// The fence described on the variant; always `None` for untracked
        /// keys once normalized.
        observed_watermark_ms: Option<u64>,
    },
}

impl ReadResult {
    /// A miss that observed no watermark.
    pub fn miss(reason: MissReason) -> Self {
        ReadResult::Miss {
            reason,
            observed_watermark_ms: None,
        }
    }

    /// `true` for [`ReadResult::Miss`] of any reason.
    pub fn is_miss(&self) -> bool {
        matches!(self, ReadResult::Miss { .. })
    }
}

/// Keys of one read: the value key and, for tracked identities, the watermark key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReadRequest {
    /// The stored value key: the logical key plus the frame suffix.
    pub value_key: String,
    /// The entity watermark key, present only for tracked identities, whose
    /// value and watermark must be read atomically.
    pub watermark_key: Option<String>,
}

/// The effective read budget and a cooperative cancellation request.
///
/// The cache's own deadline remains authoritative; adapters may use the token
/// to stop waiting, but a dispatched command may still execute.
#[derive(Debug, Clone)]
pub struct ReadContext {
    /// The resolved read budget in milliseconds; the cache stops waiting and
    /// cancels the token once it elapses.
    pub timeout_ms: u64,
    /// Cancelled by the cache when the budget elapses; adapters may stop
    /// waiting on it.
    pub cancel: CancelToken,
}

/// One complete-frame write: a single native `SET value_key frame PX ttl_ms`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WriteRequest {
    /// The stored value key to `SET`.
    pub value_key: String,
    /// The complete frame, stamped by the cache; store it exactly.
    pub frame: Frame,
    /// Positive milliseconds no greater than 365 days.
    pub ttl_ms: u64,
}

/// One invalidation: advance the entity watermark monotonically.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct InvalidateRequest {
    /// The entity watermark key, `{namespace:keyType:id}#watermark`.
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
    /// Read one value, and for tracked requests its watermark atomically from
    /// a primary, then classify the result. An `Err` counts as a `cache_read`
    /// error and the call falls through to the source.
    fn read(
        &self,
        request: ReadRequest,
        context: ReadContext,
    ) -> BoxFuture<'_, Result<ReadResult, BoxError>>;
    /// Store the complete frame under `value_key` with `ttl_ms` retention as
    /// one native `SET ... PX`, without touching watermarks.
    fn write(&self, request: WriteRequest) -> BoxFuture<'_, Result<(), BoxError>>;
    /// Advance the entity watermark to at least
    /// `invalidated_at_ms + future_buffer_ms`, only ever widening its retention.
    fn invalidate(&self, request: InvalidateRequest) -> BoxFuture<'_, Result<(), BoxError>>;
}
