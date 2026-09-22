//! Backend-neutral diagnostics: metric events and structured log events.

use std::fmt;
use std::sync::Arc;

use crate::error::BoxError;
pub use crate::remote::MissReason;

macro_rules! str_enum {
    ($(#[$meta:meta])* $name:ident { $($(#[$vmeta:meta])* $variant:ident => $text:literal),+ $(,)? }) => {
        $(#[$meta])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub enum $name { $($(#[$vmeta])* $variant),+ }
        impl $name {
            /// The `snake_case` label value shared with the TypeScript and Go
            /// ports and published by the bundled metric exporters.
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
        /// No layer was reached: caching was disabled for the scope, key
        /// construction failed, or the policy could not be resolved.
        Noop => "noop",
        /// The outermost enabled scope's request memo.
        RequestLocal => "request_local",
        /// The process-local store.
        Local => "local",
        /// The remote adapter on the caller-serving path.
        Remote => "remote",
        /// The remote adapter inside detached shadow work: its reads, fills,
        /// serialization, compression and payload sizes.
        RemoteShadow => "remote_shadow",
    }
}

str_enum! {
    /// Where an in-flight execution was shared.
    CoalescingScope {
        /// The flight was registered on the outermost enabled scope of the
        /// same request.
        RequestLocal => "request_local",
        /// The flight was registered on the cache instance; separate
        /// instances in one process do not share flights.
        Process => "process",
    }
}

str_enum! {
    /// Why a cache layer was skipped.
    DisabledReason {
        /// Caching is not enabled for the call's scope; the source runs directly.
        Context => "context",
        /// The layer has no effective TTL after the runtime overlay, which
        /// includes the default of an omitted policy.
        PolicyDisabled => "policy_disabled",
        /// The merged TTL leaf is not a whole number of seconds within 365
        /// days; only this layer is skipped, with a `config_resolution` error.
        InvalidTtl => "invalid_ttl",
        /// The merged ramp leaf is not a finite number in `[0, 100]`; only
        /// this layer is skipped, with a `config_resolution` error.
        InvalidRamp => "invalid_ramp",
        /// The layer is configured but this key's stable cohort sample falls
        /// outside its ramp.
        RampedDown => "ramped_down",
        /// The whole invocation's policy could not be resolved (`noop`
        /// layer), or the process-local read failed (`local` layer).
        ConfigError => "config_error",
    }
}

str_enum! {
    /// Stable failure sites.
    ErrorKind {
        /// The key selector failed or panicked, or the identity could not
        /// form a key.
        KeyConstruction => "key_construction",
        /// The policy provider or resolution failed for the invocation, a
        /// layer leaf was invalid, or a recovery or shadow option was rejected.
        ConfigResolution => "config_resolution",
        /// A process-local read failed, or a remote read failed for a reason
        /// other than its deadline.
        CacheRead => "cache_read",
        /// A remote read did not answer within its read budget.
        CacheReadTimeout => "cache_read_timeout",
        /// A process-local or remote write failed, or the write stamp left
        /// the safe-integer domain.
        CacheWrite => "cache_write",
        /// A tracked write asked for retention above the one-hour physical
        /// cap and was clamped: a configuration signal, not a failure.
        TrackedTtlClamped => "tracked_ttl_clamped",
        /// The codec failed or panicked while decoding a stored payload.
        SerializationLoad => "serialization_load",
        /// The codec failed or panicked while encoding a value for the remote layer.
        SerializationDump => "serialization_dump",
        /// zstd compression failed while preparing a remote write.
        Compression => "compression",
        /// An explicit invalidation failed, including one made without a
        /// remote adapter.
        Invalidation => "invalidation",
        /// The source failed, panicked or exceeded its deadline; reported
        /// with `in_fallback` set.
        Fallback => "fallback",
    }
}

str_enum! {
    /// Terminal outcomes of sampled shadow validation.
    ShadowOutcome {
        /// The cached and source values compared equal.
        Match => "match",
        /// They differed, and a confirmation read found the stored payload
        /// unchanged.
        Mismatch => "mismatch",
        /// They differed, but the stored payload changed or disappeared
        /// before confirmation.
        Superseded => "superseded",
        /// A clean shadow miss was populated.
        Filled => "filled",
        /// A tracked fill was withheld because its stamp did not exceed the
        /// watermark observed by the initial read.
        FillFenced => "fill_fenced",
        /// Preparing (encoding, compression) or writing a clean-miss fill failed.
        FillError => "fill_error",
        /// The initial detached remote read failed, including by deadline.
        RedisError => "redis_error",
        /// The source-of-truth read failed.
        SourceError => "source_error",
        /// The retained payload could not be decoded for comparison.
        DeserializationError => "deserialization_error",
        /// The comparator returned an error or panicked.
        ComparisonError => "comparison_error",
        /// The confirmation remote read failed.
        ConfirmationError => "confirmation_error",
        /// The shadow deadline expired before a verdict.
        Timeout => "timeout",
        /// Per-key deduplication or the instance's in-flight cap rejected
        /// the job before it started.
        Dropped => "dropped",
    }
}

str_enum! {
    /// Terminal outcomes of stale-on-error recovery.
    RecoveryOutcome {
        /// A retained stale frame passed the return-time age check and
        /// supplied the result.
        Served => "served",
        /// No retained frame remained eligible: none was kept, or its age
        /// reached the ceiling.
        Miss => "miss",
        /// Decoding the retained frame failed.
        DeserializationError => "deserialization_error",
    }
}

str_enum! {
    /// Compression outcomes for writes and reads.
    CompressionOutcome {
        /// Write: the payload met the threshold and the marked zstd frame was
        /// smaller than the escaped raw form.
        Compressed => "compressed",
        /// Write: the payload was below the threshold and was stored raw.
        BelowThreshold => "below_threshold",
        /// Write: compression ran but did not shrink the payload; stored raw.
        NotSmaller => "not_smaller",
        /// Write: the payload exceeds the decompression cap and was stored raw
        /// so a read could still accept it; a capacity signal.
        WriteOverLimit => "write_over_limit",
        /// Read: a marked zstd frame decoded successfully.
        Decompressed => "decompressed",
        /// Read: zstd rejected a marked payload as malformed or truncated; the
        /// stored bytes were handed through untouched.
        FallbackRaw => "fallback_raw",
        /// Read: decompressing would exceed the cap; the stored bytes were
        /// handed through untouched. An integrity signal.
        ReadOverLimit => "read_over_limit",
    }
}

str_enum! {
    /// Which codec direction a serialization timing measures.
    SerializationOperation {
        /// Encoding a value for the remote layer.
        Dump => "dump",
        /// Decoding a stored payload.
        Load => "load",
    }
}

str_enum! {
    /// Which envelope direction a compression timing measures.
    CompressionOperation {
        /// zstd compression during a write.
        Compress => "compress",
        /// zstd decompression during a read.
        Decompress => "decompress",
    }
}

/// Labels shared by layer-scoped events. Logical keys are never labels.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Labels {
    /// The instance namespace (default `urn`); unrelated to any exporter's
    /// metric-name namespace.
    pub namespace: Arc<str>,
    /// The operation name; `watermark` on invalidation error events.
    pub use_case: Arc<str>,
    /// The entity type of the identity.
    pub key_type: Arc<str>,
    /// The layer the event refers to, or [`Layer::Noop`] when none was reached.
    pub layer: Layer,
}

/// Labels of outcome-scoped events (shadow validation and recovery).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OutcomeLabels {
    /// The instance namespace (default `urn`); unrelated to any exporter's
    /// metric-name namespace.
    pub namespace: Arc<str>,
    /// The operation name.
    pub use_case: Arc<str>,
    /// The entity type of the identity.
    pub key_type: Arc<str>,
}

/// One public diagnostic. Counters carry no value; timers report seconds;
/// sizes report bytes.
#[derive(Debug, Clone, PartialEq)]
pub enum Event {
    /// One lookup of an enabled cache layer, hit or miss. Emitted before the
    /// result for the remote layer and after it for the request-local and
    /// process-local layers; a layer whose read failed emits `Error` and
    /// `Disabled` instead.
    Request {
        /// The layer that was looked up.
        labels: Labels,
    },
    /// A layer lookup found no servable value.
    Miss {
        /// The layer that missed.
        labels: Labels,
        /// The bounded cause; request-local and process-local misses are
        /// always [`MissReason::ValueAbsent`].
        reason: MissReason,
    },
    /// A layer, or the whole call (`noop`), was skipped.
    Disabled {
        /// The skipped layer, or [`Layer::Noop`] when no layer was reached.
        labels: Labels,
        /// Why it was skipped.
        reason: DisabledReason,
    },
    /// A bounded failure site fired. Cache plumbing failures fail open; only
    /// source failures reach the caller.
    Error {
        /// The layer whose work failed.
        labels: Labels,
        /// The failure site.
        error: ErrorKind,
        /// `true` when the source (fallback) failed or timed out rather than
        /// cache plumbing.
        in_fallback: bool,
    },
    /// One explicit invalidation attempt, emitted before the remote call and
    /// even when no remote adapter is configured.
    Invalidation {
        /// The namespace whose entity watermark is advanced.
        namespace: Arc<str>,
        /// The entity type being invalidated.
        key_type: Arc<str>,
        /// Always [`Layer::Remote`]: watermarks live only in the remote layer.
        layer: Layer,
    },
    /// A caller joined an execution already in flight for the same logical
    /// key instead of starting its own.
    Coalesced {
        /// The identity of the joined execution.
        labels: OutcomeLabels,
        /// Whether the flight was registered on the request scope or the instance.
        scope: CoalescingScope,
    },
    /// One terminal outcome of an admitted or explicitly dropped shadow job.
    ShadowValidation {
        /// The identity the job validated.
        labels: OutcomeLabels,
        /// The terminal verdict.
        outcome: ShadowOutcome,
    },
    /// Age in seconds of the validated value at a match or confirmed mismatch, clamped at zero.
    ShadowValueAge {
        /// The identity the job validated.
        labels: OutcomeLabels,
        /// [`ShadowOutcome::Match`] or [`ShadowOutcome::Mismatch`]; no other
        /// outcome carries an age.
        outcome: ShadowOutcome,
        /// Observing wall clock minus the frame's `created_at_ms`, never negative.
        seconds: f64,
    },
    /// Positive offset in seconds of a frame dated after the observing clock.
    FutureTimestampOffset {
        /// The layer whose read decoded the frame.
        labels: Labels,
        /// How far the frame's `created_at_ms` lies ahead of the observing wall clock.
        seconds: f64,
    },
    /// One classifier-authorized stale-on-error recovery check after a
    /// source failure.
    StaleRecovery {
        /// The identity being recovered.
        labels: OutcomeLabels,
        /// Whether a retained frame was served.
        outcome: RecoveryOutcome,
    },
    /// Age of the retained frame at the moment recovery served it; emitted
    /// only alongside [`RecoveryOutcome::Served`].
    StaleRecoveryValueAge {
        /// The identity being recovered.
        labels: OutcomeLabels,
        /// Always [`RecoveryOutcome::Served`].
        outcome: RecoveryOutcome,
        /// Observing wall clock minus the frame's `created_at_ms`, clamped at zero.
        seconds: f64,
    },
    /// One envelope decision: on every write while compression is enabled,
    /// and on reads whose payload carried a zstd marker.
    Compression {
        /// The layer performing the write or read.
        labels: Labels,
        /// Write and read outcomes are disjoint sets; see [`CompressionOutcome`].
        outcome: CompressionOutcome,
    },
    /// Lookup latency of one layer, hit or miss; a remote read's value
    /// includes any wait up to its deadline.
    Get {
        /// The layer looked up.
        labels: Labels,
        /// Elapsed time of the lookup.
        seconds: f64,
    },
    /// Time until the source settled or its deadline elapsed, once per
    /// source invocation that served the caller (shadow re-validation runs
    /// the source without it).
    Fallback {
        /// [`Layer::RequestLocal`] when the request memo was consulted,
        /// [`Layer::Remote`] when the remote layer was consulted, otherwise
        /// [`Layer::Local`] (even with the local layer disabled), and
        /// [`Layer::Noop`] only when the call bypassed caching.
        labels: Labels,
        /// Elapsed time from invoking the source until it settled or its
        /// deadline fired.
        seconds: f64,
    },
    /// Codec latency of one encode or decode, emitted whether or not the
    /// codec succeeded.
    Serialization {
        /// The layer the payload was written to or read from.
        labels: Labels,
        /// Encode (`dump`) or decode (`load`).
        operation: SerializationOperation,
        /// Elapsed time inside the codec.
        seconds: f64,
    },
    /// Serializer output size of one remote write, before compression and escaping.
    Size {
        /// The layer being written.
        labels: Labels,
        /// Length of the codec output.
        bytes: u64,
    },
    /// Prepared payload size of one remote write, after compression and
    /// escaping, before dispatch.
    StoredSize {
        /// The layer being written.
        labels: Labels,
        /// Length of the payload handed to the adapter, excluding the
        /// ten-byte frame header.
        bytes: u64,
    },
    /// Size ratio of one write that chose the compressed form.
    CompressionRatio {
        /// The layer being written.
        labels: Labels,
        /// Marked compressed bytes divided by serializer output bytes.
        ratio: f64,
    },
    /// zstd latency: on writes when compression ran (compressed or not
    /// smaller), on reads when a marked frame was decoded or rejected.
    CompressionDuration {
        /// The layer performing the write or read.
        labels: Labels,
        /// Compress (write) or decompress (read).
        operation: CompressionOperation,
        /// Elapsed time of the envelope step.
        seconds: f64,
    },
}

/// Receives every public diagnostic. Failures (returned errors or panics)
/// never change a cache, source or maintenance result.
pub trait Observer: Send + Sync + 'static {
    /// Receive one event. Called inline on the cache's own path under panic
    /// isolation, so it should return quickly and never block.
    fn observe(&self, event: &Event);

    /// Whether this observer consumes shadow validation outcomes.
    ///
    /// Shadow validation is diagnostic work that exists only to be observed,
    /// so the cache admits a shadow job only when the observer opts in by
    /// returning `true`. The bundled metric exporters opt in.
    fn observes_shadow_outcomes(&self) -> bool {
        false
    }
}

/// Bounded details of one confirmed shadow mismatch warning.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ShadowMismatchDetails {
    /// The instance namespace of the mismatching identity.
    pub namespace: Arc<str>,
    /// The operation name of the mismatching identity.
    pub use_case: Arc<str>,
    /// The entity type of the mismatching identity.
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
    /// Verbose diagnostics; no [`LogEvent`] maps here today.
    Debug,
    /// A diagnostic on a path where the cache itself added no failure: a
    /// layer failed open and the call went on to another layer or the
    /// source, or an explicit invalidation or a recovery decode failed and
    /// the operation reports that failure.
    Warn,
    /// A whole path is broken: key construction or the process-local store.
    Error,
}

/// Structured log events. All are fail-open diagnostics except the
/// invalidation failure, which is also returned to the caller.
#[derive(Debug)]
pub enum LogEvent {
    /// The key selector failed or panicked, or the identity could not form a
    /// key; the source ran uncached. [`LogLevel::Error`].
    KeyConstructionFailed(BoxError),
    /// The policy provider failed or panicked, or the merged policy was
    /// malformed; the source ran uncached.
    PolicyResolutionFailed(BoxError),
    /// The [`LocalStore`](crate::LocalStore) read failed or panicked; the
    /// local layer was skipped for the call. [`LogLevel::Error`].
    LocalReadFailed(BoxError),
    /// The [`LocalStore`](crate::LocalStore) write failed or panicked; the
    /// value was still returned.
    LocalWriteFailed(BoxError),
    /// The caller-serving remote read failed or exceeded its read budget.
    /// Detached shadow reads do not log.
    RemoteReadFailed(BoxError),
    /// Preparing or dispatching a caller-serving remote write failed:
    /// encoding, compression, the write stamp or the adapter.
    RemoteWriteFailed(BoxError),
    /// The stale-recovery classifier panicked; recovery was denied.
    RecoveryPredicateFailed(BoxError),
    /// Decoding the retained stale frame failed during recovery; the source
    /// error was returned.
    RecoveryDecodeFailed(BoxError),
    /// A shadow job's clean-miss fill failed while preparing or writing the payload.
    ShadowFillFailed(BoxError),
    /// A confirmed shadow mismatch, logged only when the resolved policy's
    /// `log_mismatches` is true.
    ShadowMismatch(ShadowMismatchDetails),
    /// An explicit invalidation failed; the same error is returned to the caller.
    InvalidationFailed(BoxError),
}

impl LogEvent {
    /// [`LogLevel::Error`] for key construction and process-local read
    /// failures, [`LogLevel::Warn`] for everything else.
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
            LogEvent::KeyConstructionFailed(e) => {
                write!(f, "Could not construct DialCache key: {e}")
            }
            LogEvent::PolicyResolutionFailed(e) => {
                write!(f, "Could not resolve DialCache key config: {e}")
            }
            LogEvent::LocalReadFailed(e) => write!(f, "Error getting value from local cache: {e}"),
            LogEvent::LocalWriteFailed(e) => write!(f, "Error putting value in local cache: {e}"),
            LogEvent::RemoteReadFailed(e) => write!(f, "Error getting value from Redis cache: {e}"),
            LogEvent::RemoteWriteFailed(e) => write!(f, "Error putting value in Redis cache: {e}"),
            LogEvent::RecoveryPredicateFailed(e) => {
                write!(
                    f,
                    "DialCache stale recovery predicate failed; recovery was denied: {e}"
                )
            }
            LogEvent::RecoveryDecodeFailed(e) => write!(
                f,
                "Error using retained Redis value during stale recovery: {e}"
            ),
            LogEvent::ShadowFillFailed(e) => {
                write!(f, "Error populating Redis from DialCache shadow work: {e}")
            }
            LogEvent::ShadowMismatch(d) => {
                write!(f, "DialCache shadow validation mismatch: namespace={} useCase={} keyType={} cacheKey={}",
                    d.namespace, d.use_case, d.key_type, d.cache_key)?;
                if let Some(value) = &d.cached_value_json {
                    write!(f, " cachedValue={value}")?;
                }
                if let Some(value) = &d.source_value_json {
                    write!(f, " sourceValue={value}")?;
                }
                Ok(())
            }
            LogEvent::InvalidationFailed(e) => {
                write!(f, "Error writing DialCache invalidation watermark: {e}")
            }
        }
    }
}

/// Receives structured log events. Panics are isolated from cache results.
pub trait Logger: Send + Sync + 'static {
    /// Receive one event. Called inline under panic isolation; a panic here
    /// is swallowed and the cache result is unaffected.
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
