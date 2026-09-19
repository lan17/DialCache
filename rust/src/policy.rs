//! Static operation policy, sparse runtime overlays and per-invocation resolution.

use crate::limits::{DEFAULT_REMOTE_READ_TIMEOUT_MS, MAX_CACHE_TTL_SEC, MAX_DEADLINE_MS};

/// Per-use-case shadow validation policy.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct ShadowPolicy {
    /// Independent stable cohort percentage in `[0, 100]`. Omitted and zero disable shadow work.
    pub ramp: Option<f64>,
    /// Emit one warning per confirmed mismatch. Defaults to false.
    pub log_mismatches: Option<bool>,
}

/// Static caching policy of one operation. Omitted leaves use library
/// defaults or are overridden by a runtime overlay.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct Policy {
    /// Memoize values for the outermost enabled scope. Defaults to false.
    pub request_local: Option<bool>,
    /// Share one execution across concurrent same-key callers. Defaults to true.
    pub coalesce: Option<bool>,
    /// Process-local TTL in whole seconds, `1..=MAX_CACHE_TTL_SEC`. Omitted disables the layer.
    pub local_ttl_sec: Option<u64>,
    /// Remote TTL in whole seconds. Omitted disables the layer.
    pub remote_ttl_sec: Option<u64>,
    /// Local serving cohort percentage; a configured TTL implies 100.
    pub local_ramp: Option<f64>,
    /// Remote serving cohort percentage; a configured TTL implies 100.
    pub remote_ramp: Option<f64>,
    /// Exclusive stale-recovery age ceiling in seconds; must exceed the remote TTL. Zero disables.
    pub stale_on_error_max_age_sec: Option<u64>,
    /// Remote read budget in milliseconds, `1..=MAX_DEADLINE_MS`.
    pub remote_read_timeout_ms: Option<u64>,
    pub shadow: Option<ShadowPolicy>,
}

impl Policy {
    /// Both serving layers enabled with the same TTL and full ramps.
    pub fn enabled(ttl_sec: u64) -> Self {
        Policy {
            local_ttl_sec: Some(ttl_sec),
            remote_ttl_sec: Some(ttl_sec),
            local_ramp: Some(100.0),
            remote_ramp: Some(100.0),
            ..Policy::default()
        }
    }

    /// The explicit kill switch: request memoization, recovery and shadow
    /// work off, both serving layers ramped to zero. As an overlay it disables
    /// every inherited path instead of relying on omission.
    pub fn disabled() -> Self {
        Policy {
            request_local: Some(false),
            stale_on_error_max_age_sec: Some(0),
            local_ramp: Some(0.0),
            remote_ramp: Some(0.0),
            shadow: Some(ShadowPolicy { ramp: Some(0.0), log_mismatches: Some(false) }),
            ..Policy::default()
        }
    }

    pub fn request_local(mut self, enabled: bool) -> Self {
        self.request_local = Some(enabled);
        self
    }

    pub fn coalesce(mut self, enabled: bool) -> Self {
        self.coalesce = Some(enabled);
        self
    }

    pub fn local_ttl_sec(mut self, ttl_sec: u64) -> Self {
        self.local_ttl_sec = Some(ttl_sec);
        self
    }

    pub fn remote_ttl_sec(mut self, ttl_sec: u64) -> Self {
        self.remote_ttl_sec = Some(ttl_sec);
        self
    }

    pub fn local_ramp(mut self, ramp: f64) -> Self {
        self.local_ramp = Some(ramp);
        self
    }

    pub fn remote_ramp(mut self, ramp: f64) -> Self {
        self.remote_ramp = Some(ramp);
        self
    }

    pub fn stale_on_error_max_age_sec(mut self, seconds: u64) -> Self {
        self.stale_on_error_max_age_sec = Some(seconds);
        self
    }

    pub fn remote_read_timeout_ms(mut self, ms: u64) -> Self {
        self.remote_read_timeout_ms = Some(ms);
        self
    }

    pub fn shadow(mut self, shadow: ShadowPolicy) -> Self {
        self.shadow = Some(shadow);
        self
    }

    /// Parse the JSON-shaped TypeScript configuration
    /// (`ttlSec`, `ramp`, `shadow`, `requestLocal`, `coalesce`,
    /// `staleOnErrorMaxAgeSec`, `remoteReadTimeoutMs`). `null` or absent means an empty policy.
    pub fn from_json(value: &serde_json::Value) -> Result<Policy, PolicyError> {
        let _ = value;
        todo!("Policy::from_json")
    }

    /// The JSON-shaped form of this policy, with omitted leaves absent.
    pub fn to_json(&self) -> serde_json::Value {
        todo!("Policy::to_json")
    }

    /// Reject statically invalid leaves.
    pub fn validate(&self) -> Result<(), PolicyError> {
        todo!("Policy::validate")
    }
}

/// A sparse runtime overlay returned by a [`PolicyProvider`](crate::PolicyProvider).
///
/// Each present leaf replaces the operation leaf; omitted leaves inherit.
/// Leaves may hold invalid values on purpose: their consequences are defined
/// by the portable contract (an invalid TTL or ramp disables only that
/// layer, an invalid flag or read deadline bypasses caching for the call).
#[derive(Debug, Clone, PartialEq)]
pub struct RuntimePolicy(pub serde_json::Value);

impl RuntimePolicy {
    pub fn from_json(value: serde_json::Value) -> Self {
        RuntimePolicy(value)
    }
}

impl From<Policy> for RuntimePolicy {
    fn from(policy: Policy) -> Self {
        RuntimePolicy(policy.to_json())
    }
}

impl From<serde_json::Value> for RuntimePolicy {
    fn from(value: serde_json::Value) -> Self {
        RuntimePolicy(value)
    }
}

/// Instance defaults consulted during resolution.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PolicyDefaults {
    pub remote_read_timeout_ms: u64,
}

impl Default for PolicyDefaults {
    fn default() -> Self {
        PolicyDefaults { remote_read_timeout_ms: DEFAULT_REMOTE_READ_TIMEOUT_MS }
    }
}

/// Why a whole invocation's policy could not be resolved.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
#[error("{0}")]
pub struct PolicyError(pub String);

/// One serving layer after resolution.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct ResolvedLayer {
    pub enabled: bool,
    /// Why the layer is disabled, when it is.
    pub reason: Option<crate::observe::DisabledReason>,
    /// A valid TTL and ramp remain available when the ramp excluded this key.
    pub configured: bool,
    pub ttl_ms: u64,
    pub ramp: f64,
}

/// Shadow policy after resolution.
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct ResolvedShadow {
    /// Cohort selection only; admission still needs an eligible path, hook and capacity.
    pub enabled: bool,
    pub ramp: f64,
    pub log_mismatches: bool,
    pub config_error: bool,
    /// Recorded only if a job is admitted.
    pub logging_config_error: bool,
}

/// The captured policy of one enabled invocation.
#[derive(Debug, Clone, PartialEq)]
pub struct ResolvedPolicy {
    pub request_local: bool,
    pub coalesce: bool,
    pub local: ResolvedLayer,
    pub remote: ResolvedLayer,
    pub remote_read_timeout_ms: u64,
    /// Zero when recovery is off.
    pub stale_on_error_max_age_ms: u64,
    pub stale_on_error_config_error: bool,
    pub shadow: ResolvedShadow,
}

/// Merge a static policy with a sparse overlay once, for one logical key.
///
/// A malformed container, boolean or read deadline fails the whole
/// invocation; TTL or ramp errors disable only that layer; an invalid
/// recovery or shadow option preserves ordinary serving.
pub fn resolve_policy(
    base: &Policy,
    overlay: Option<&RuntimePolicy>,
    logical_key: &str,
    defaults: PolicyDefaults,
) -> Result<ResolvedPolicy, PolicyError> {
    let _ = (base, overlay, logical_key, defaults, MAX_CACHE_TTL_SEC, MAX_DEADLINE_MS);
    todo!("resolve_policy")
}
