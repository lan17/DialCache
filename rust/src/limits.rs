//! Numeric domains shared by every DialCache implementation.

/// Largest integer JavaScript represents exactly; timestamps and counters
/// beyond it are rejected rather than rounded.
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
/// Fixed 365-day ceiling shared by cache TTLs and invalidation buffers, in milliseconds.
pub const MAX_SUPPORTED_DURATION_MS: u64 = 365 * 24 * 60 * 60 * 1_000;
/// Cache TTL ceiling in whole seconds.
pub const MAX_CACHE_TTL_SEC: u64 = MAX_SUPPORTED_DURATION_MS / 1_000;
/// Tracked Redis values are physically retained for at most one hour so
/// invalidation markers can safely age out.
pub const MAX_TRACKED_VALUE_TTL_MS: u64 = 60 * 60 * 1_000;
/// Largest source or read deadline, in milliseconds.
pub const MAX_DEADLINE_MS: u64 = 2_147_483_647;
/// Library default remote read budget.
pub const DEFAULT_REMOTE_READ_TIMEOUT_MS: u64 = 50;
/// Library default source budget.
pub const DEFAULT_FALLBACK_TIMEOUT_MS: u64 = 60_000;
/// Default process-local capacity per instance.
pub const DEFAULT_LOCAL_CAPACITY: usize = 10_000;
/// Default concurrent shadow jobs per instance.
pub const DEFAULT_SHADOW_MAX_IN_FLIGHT: usize = 1;
/// Ceiling on one decompressed payload (Redis's own value limit).
pub const MAX_DECOMPRESSED_BYTES: usize = 512 * 1024 * 1024;
/// Default compression threshold in serialized bytes.
pub const DEFAULT_COMPRESSION_THRESHOLD_BYTES: usize = 4096;
/// Default zstd level.
pub const DEFAULT_ZSTD_LEVEL: i32 = 3;
/// Reserved use case name owned by invalidation watermarks.
pub const WATERMARK_USE_CASE: &str = "watermark";
/// Key suffix of every stored value frame.
pub const FRAME_KEY_SUFFIX: &str = ":dialcache-frame-v1";
/// Minimum watermark retention: twice the tracked value cap.
pub const MIN_WATERMARK_TTL_MS: u64 = 2 * MAX_TRACKED_VALUE_TTL_MS;
/// Slack added to derived watermark retention.
pub const WATERMARK_TTL_MARGIN_MS: u64 = 60_000;
