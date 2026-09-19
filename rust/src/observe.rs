//! Backend-neutral diagnostics: metric events and structured log events.

use std::fmt;
use std::sync::Arc;

use crate::error::BoxError;
pub use crate::remote::MissReason;

macro_rules! str_enum {
    ($(#[$meta:meta])* $name:ident { $($variant:ident => $text:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub enum $name { $($variant),+ }
        impl $name {
            pub fn as_str(self) -> &'static str {
                match self { $($name::$variant => $text),+ }
            }
        }
        impl fmt::Display for $name {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result { f.write_str(self.as_str()) }
        }
    };
}

str_enum! {
    /// The cache layer a diagnostic refers to.
    Layer {
        Noop => "noop",
        RequestLocal => "request_local",
        Local => "local",
        Remote => "remote",
        RemoteShadow => "remote_shadow",
    }
}

str_enum! {
    /// Where an in-flight execution was shared.
    CoalescingScope { RequestLocal => "request_local", Process => "process" }
}

str_enum! {
    /// Why a cache layer was skipped.
    DisabledReason {
        Context => "context",
        PolicyDisabled => "policy_disabled",
        InvalidTtl => "invalid_ttl",
        InvalidRamp => "invalid_ramp",
        RampedDown => "ramped_down",
        ConfigError => "config_error",
    }
}

str_enum! {
    /// Stable failure sites.
    ErrorKind {
        KeyConstruction => "key_construction",
        ConfigResolution => "config_resolution",
        CacheRead => "cache_read",
        CacheReadTimeout => "cache_read_timeout",
        CacheWrite => "cache_write",
        TrackedTtlClamped => "tracked_ttl_clamped",
        SerializationLoad => "serialization_load",
        SerializationDump => "serialization_dump",
        Compression => "compression",
        Invalidation => "invalidation",
        Fallback => "fallback",
    }
}

str_enum! {
    /// Terminal outcomes of sampled shadow validation.
    ShadowOutcome {
        Match => "match",
        Mismatch => "mismatch",
        Superseded => "superseded",
        Filled => "filled",
        FillFenced => "fill_fenced",
        FillError => "fill_error",
        RedisError => "redis_error",
        SourceError => "source_error",
        DeserializationError => "deserialization_error",
        ComparisonError => "comparison_error",
        ConfirmationError => "confirmation_error",
        Timeout => "timeout",
        Dropped => "dropped",
    }
}

str_enum! {
    /// Terminal outcomes of stale-on-error recovery.
    RecoveryOutcome {
        Served => "served",
        Miss => "miss",
        DeserializationError => "deserialization_error",
    }
}

str_enum! {
    /// Compression outcomes for writes and reads.
    CompressionOutcome {
        Compressed => "compressed",
        BelowThreshold => "below_threshold",
        NotSmaller => "not_smaller",
        WriteOverLimit => "write_over_limit",
        Decompressed => "decompressed",
        FallbackRaw => "fallback_raw",
        ReadOverLimit => "read_over_limit",
    }
}

str_enum! {
    SerializationOperation { Dump => "dump", Load => "load" }
}

str_enum! {
    CompressionOperation { Compress => "compress", Decompress => "decompress" }
}

/// Labels shared by layer-scoped events. Logical keys are never labels.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Labels {
    pub namespace: Arc<str>,
    pub use_case: Arc<str>,
    pub key_type: Arc<str>,
    pub layer: Layer,
}

/// Labels of outcome-scoped events (shadow validation and recovery).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutcomeLabels {
    pub namespace: Arc<str>,
    pub use_case: Arc<str>,
    pub key_type: Arc<str>,
}

/// One public diagnostic. Counters carry no value; timers report seconds;
/// sizes report bytes.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    Request { labels: Labels },
    Miss { labels: Labels, reason: MissReason },
    Disabled { labels: Labels, reason: DisabledReason },
    Error { labels: Labels, error: ErrorKind, in_fallback: bool },
    Invalidation { namespace: Arc<str>, key_type: Arc<str>, layer: Layer },
    Coalesced { labels: OutcomeLabels, scope: CoalescingScope },
    ShadowValidation { labels: OutcomeLabels, outcome: ShadowOutcome },
    /// Age in seconds of the validated value at a match or confirmed mismatch, clamped at zero.
    ShadowValueAge { labels: OutcomeLabels, outcome: ShadowOutcome, seconds: f64 },
    /// Positive offset in seconds of a frame dated after the observing clock.
    FutureTimestampOffset { labels: Labels, seconds: f64 },
    StaleRecovery { labels: OutcomeLabels, outcome: RecoveryOutcome },
    StaleRecoveryValueAge { labels: OutcomeLabels, outcome: RecoveryOutcome, seconds: f64 },
    Compression { labels: Labels, outcome: CompressionOutcome },
    Get { labels: Labels, seconds: f64 },
    Fallback { labels: Labels, seconds: f64 },
    Serialization { labels: Labels, operation: SerializationOperation, seconds: f64 },
    Size { labels: Labels, bytes: u64 },
    StoredSize { labels: Labels, bytes: u64 },
    CompressionRatio { labels: Labels, ratio: f64 },
    CompressionDuration { labels: Labels, operation: CompressionOperation, seconds: f64 },
}

/// Receives every public diagnostic. Failures (returned errors or panics)
/// never change a cache, source or maintenance result.
pub trait Observer: Send + Sync + 'static {
    fn observe(&self, event: &Event);

    /// Whether this observer consumes shadow validation outcomes.
    ///
    /// Shadow validation is diagnostic work that exists only to be observed,
    /// so the cache admits a shadow job only when an observer reports `true`.
    fn observes_shadow_outcomes(&self) -> bool {
        true
    }
}

/// Bounded details of one confirmed shadow mismatch warning.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShadowMismatchDetails {
    pub namespace: Arc<str>,
    pub use_case: Arc<str>,
    pub key_type: Arc<str>,
    /// The logical key, bounded to 2 KiB of UTF-8.
    pub cache_key: String,
    /// JSON preview of the cached value, bounded to 8 KiB; absent when unavailable.
    pub cached_value_json: Option<String>,
    /// JSON preview of the source value, bounded to 8 KiB; absent when unavailable.
    pub source_value_json: Option<String>,
}

/// Severity of a [`LogEvent`].
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum LogLevel {
    Debug,
    Warn,
    Error,
}

/// Structured log events. All are fail-open diagnostics except the
/// invalidation failure, which is also returned to the caller.
#[derive(Debug)]
pub enum LogEvent {
    KeyConstructionFailed(BoxError),
    PolicyResolutionFailed(BoxError),
    LocalReadFailed(BoxError),
    LocalWriteFailed(BoxError),
    RemoteReadFailed(BoxError),
    RemoteWriteFailed(BoxError),
    RecoveryPredicateFailed(BoxError),
    RecoveryDecodeFailed(BoxError),
    ShadowFillFailed(BoxError),
    ShadowMismatch(ShadowMismatchDetails),
    InvalidationFailed(BoxError),
}

impl LogEvent {
    pub fn level(&self) -> LogLevel {
        match self {
            LogEvent::KeyConstructionFailed(_) | LogEvent::LocalReadFailed(_) => LogLevel::Error,
            _ => LogLevel::Warn,
        }
    }
}

impl fmt::Display for LogEvent {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LogEvent::KeyConstructionFailed(e) => write!(f, "Could not construct DialCache key: {e}"),
            LogEvent::PolicyResolutionFailed(e) => write!(f, "Could not resolve DialCache key config: {e}"),
            LogEvent::LocalReadFailed(e) => write!(f, "Error getting value from local cache: {e}"),
            LogEvent::LocalWriteFailed(e) => write!(f, "Error putting value in local cache: {e}"),
            LogEvent::RemoteReadFailed(e) => write!(f, "Error getting value from Redis cache: {e}"),
            LogEvent::RemoteWriteFailed(e) => write!(f, "Error putting value in Redis cache: {e}"),
            LogEvent::RecoveryPredicateFailed(e) => {
                write!(f, "DialCache stale recovery predicate failed; recovery was denied: {e}")
            }
            LogEvent::RecoveryDecodeFailed(e) => write!(f, "Error using retained Redis value during stale recovery: {e}"),
            LogEvent::ShadowFillFailed(e) => write!(f, "Error populating Redis from DialCache shadow work: {e}"),
            LogEvent::ShadowMismatch(d) => write!(
                f,
                "DialCache shadow validation mismatch: namespace={} useCase={} keyType={} cacheKey={}",
                d.namespace, d.use_case, d.key_type, d.cache_key
            ),
            LogEvent::InvalidationFailed(e) => write!(f, "Error writing DialCache invalidation watermark: {e}"),
        }
    }
}

/// Receives structured log events. Panics are isolated from cache results.
pub trait Logger: Send + Sync + 'static {
    fn log(&self, event: &LogEvent);
}

/// The default logger: the `log` crate facade.
#[derive(Debug, Clone, Copy, Default)]
pub struct LogFacadeLogger;

impl Logger for LogFacadeLogger {
    fn log(&self, event: &LogEvent) {
        match event.level() {
            LogLevel::Debug => log::debug!(target: "dialcache", "{event}"),
            LogLevel::Warn => log::warn!(target: "dialcache", "{event}"),
            LogLevel::Error => log::error!(target: "dialcache", "{event}"),
        }
    }
}
