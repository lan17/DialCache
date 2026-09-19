//! Static operation policy, sparse runtime overlays and per-invocation resolution.

use serde_json::{Map, Value};

use crate::limits::{DEFAULT_REMOTE_READ_TIMEOUT_MS, MAX_CACHE_TTL_SEC, MAX_DEADLINE_MS};
use crate::observe::DisabledReason;

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
            shadow: Some(ShadowPolicy {
                ramp: Some(0.0),
                log_mismatches: Some(false),
            }),
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
    ///
    /// A present leaf holding `null` is an invalid supplied value, not an
    /// omission: JSON has no way to spell JavaScript's `undefined`, so every
    /// member of an object counts as present.
    pub fn from_json(value: &Value) -> Result<Policy, PolicyError> {
        let mut policy = Policy::default();
        if value.is_null() {
            return Ok(policy);
        }
        let config = policy_object(value, "defaultConfig")?;
        reject_shadow_ramp(config)?;
        if let Some(layers) = config.get("ttlSec") {
            let layers = policy_object(layers, "ttlSec")?;
            for (layer, slot) in [
                ("local", &mut policy.local_ttl_sec),
                ("remote", &mut policy.remote_ttl_sec),
            ] {
                if let Some(leaf) = layers.get(layer) {
                    let seconds = ttl_sec(leaf)
                        .ok_or_else(|| PolicyError(format!("invalid static ttlSec.{layer}")))?;
                    *slot = Some(seconds);
                }
            }
        }
        if let Some(layers) = config.get("ramp") {
            let layers = policy_object(layers, "ramp")?;
            for (layer, slot) in [
                ("local", &mut policy.local_ramp),
                ("remote", &mut policy.remote_ramp),
            ] {
                if let Some(leaf) = layers.get(layer) {
                    let ramp = finite_range(leaf, 0.0, 100.0, false)
                        .ok_or_else(|| PolicyError(format!("invalid static ramp.{layer}")))?;
                    *slot = Some(ramp);
                }
            }
        }
        for (field, slot) in [
            ("requestLocal", &mut policy.request_local),
            ("coalesce", &mut policy.coalesce),
        ] {
            if let Some(leaf) = config.get(field) {
                let flag = leaf
                    .as_bool()
                    .ok_or_else(|| PolicyError(format!("{field} must be boolean")))?;
                *slot = Some(flag);
            }
        }
        if let Some(leaf) = config.get("staleOnErrorMaxAgeSec") {
            let seconds = finite_range(leaf, 0.0, MAX_CACHE_TTL_SEC as f64, true)
                .ok_or_else(|| PolicyError("invalid static staleOnErrorMaxAgeSec".to_string()))?;
            policy.stale_on_error_max_age_sec = Some(seconds as u64);
        }
        if let Some(leaf) = config.get("remoteReadTimeoutMs") {
            let ms = finite_range(leaf, 1.0, MAX_DEADLINE_MS as f64, true)
                .ok_or_else(|| PolicyError("invalid remoteReadTimeoutMs".to_string()))?;
            policy.remote_read_timeout_ms = Some(ms as u64);
        }
        if let Some(shadow) = config.get("shadow") {
            let shadow = policy_object(shadow, "shadow")?;
            let mut parsed = ShadowPolicy::default();
            if let Some(leaf) = shadow.get("ramp") {
                let ramp = finite_range(leaf, 0.0, 100.0, false)
                    .ok_or_else(|| PolicyError("invalid static shadow.ramp".to_string()))?;
                parsed.ramp = Some(ramp);
            }
            if let Some(leaf) = shadow.get("logMismatches") {
                let flag = leaf.as_bool().ok_or_else(|| {
                    PolicyError("shadow.logMismatches must be boolean".to_string())
                })?;
                parsed.log_mismatches = Some(flag);
            }
            policy.shadow = Some(parsed);
        }
        policy.validate()?;
        Ok(policy)
    }

    /// The JSON-shaped form of this policy, with omitted leaves absent.
    ///
    /// `ttlSec` and `ramp` are always objects (possibly empty); `requestLocal`
    /// (default false) and `coalesce` (default true) are always present;
    /// the optional scalars and the `shadow` object appear only when set.
    pub fn to_json(&self) -> Value {
        let mut ttl = Map::new();
        if let Some(seconds) = self.local_ttl_sec {
            ttl.insert("local".to_string(), Value::from(seconds));
        }
        if let Some(seconds) = self.remote_ttl_sec {
            ttl.insert("remote".to_string(), Value::from(seconds));
        }
        let mut ramp = Map::new();
        if let Some(value) = self.local_ramp {
            ramp.insert("local".to_string(), ramp_json(value));
        }
        if let Some(value) = self.remote_ramp {
            ramp.insert("remote".to_string(), ramp_json(value));
        }
        let mut object = Map::new();
        object.insert("ttlSec".to_string(), Value::Object(ttl));
        object.insert("ramp".to_string(), Value::Object(ramp));
        object.insert(
            "requestLocal".to_string(),
            Value::Bool(self.request_local.unwrap_or(false)),
        );
        object.insert(
            "coalesce".to_string(),
            Value::Bool(self.coalesce.unwrap_or(true)),
        );
        if let Some(seconds) = self.stale_on_error_max_age_sec {
            object.insert("staleOnErrorMaxAgeSec".to_string(), Value::from(seconds));
        }
        if let Some(ms) = self.remote_read_timeout_ms {
            object.insert("remoteReadTimeoutMs".to_string(), Value::from(ms));
        }
        if let Some(shadow) = &self.shadow {
            let mut leaves = Map::new();
            if let Some(value) = shadow.ramp {
                leaves.insert("ramp".to_string(), ramp_json(value));
            }
            if let Some(flag) = shadow.log_mismatches {
                leaves.insert("logMismatches".to_string(), Value::Bool(flag));
            }
            object.insert("shadow".to_string(), Value::Object(leaves));
        }
        Value::Object(object)
    }

    /// Reject statically invalid leaves.
    pub fn validate(&self) -> Result<(), PolicyError> {
        for ttl in [self.local_ttl_sec, self.remote_ttl_sec]
            .into_iter()
            .flatten()
        {
            if !(1..=MAX_CACHE_TTL_SEC).contains(&ttl) {
                return Err(PolicyError(
                    "static TTL must be whole seconds within 365 days".to_string(),
                ));
            }
        }
        for ramp in [self.local_ramp, self.remote_ramp].into_iter().flatten() {
            if !ramp_in_domain(ramp) {
                return Err(PolicyError(
                    "static ramp must be between zero and 100".to_string(),
                ));
            }
        }
        if let Some(age) = self.stale_on_error_max_age_sec {
            let exceeds_remote = match self.remote_ttl_sec {
                Some(remote) if remote > 0 => age > remote,
                _ => false,
            };
            if age > MAX_CACHE_TTL_SEC || (age > 0 && !exceeds_remote) {
                return Err(PolicyError(
                    "static recovery age must exceed a positive remote TTL".to_string(),
                ));
            }
        }
        if let Some(ms) = self.remote_read_timeout_ms {
            if !(1..=MAX_DEADLINE_MS).contains(&ms) {
                return Err(PolicyError("invalid remote read deadline".to_string()));
            }
        }
        if let Some(ramp) = self.shadow.as_ref().and_then(|shadow| shadow.ramp) {
            if !ramp_in_domain(ramp) {
                return Err(PolicyError(
                    "static shadow ramp must be between zero and 100".to_string(),
                ));
            }
        }
        Ok(())
    }
}

/// A sparse runtime overlay returned by a [`PolicyProvider`](crate::PolicyProvider).
///
/// Each present leaf replaces the operation leaf; omitted leaves inherit.
/// Leaves may hold invalid values on purpose: their consequences are defined
/// by the portable contract (an invalid TTL or ramp disables only that
/// layer, an invalid flag or read deadline bypasses caching for the call).
#[derive(Debug, Clone, PartialEq)]
pub struct RuntimePolicy(pub Value);

impl RuntimePolicy {
    pub fn from_json(value: Value) -> Self {
        RuntimePolicy(value)
    }
}

impl From<Policy> for RuntimePolicy {
    fn from(policy: Policy) -> Self {
        RuntimePolicy(policy.to_json())
    }
}

impl From<Value> for RuntimePolicy {
    fn from(value: Value) -> Self {
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
        PolicyDefaults {
            remote_read_timeout_ms: DEFAULT_REMOTE_READ_TIMEOUT_MS,
        }
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
    pub reason: Option<DisabledReason>,
    /// A valid TTL and ramp remain available when the ramp excluded this key.
    pub configured: bool,
    pub ttl_ms: u64,
    pub ramp: f64,
}

impl ResolvedLayer {
    fn disabled(reason: DisabledReason) -> Self {
        ResolvedLayer {
            enabled: false,
            reason: Some(reason),
            configured: false,
            ttl_ms: 0,
            ramp: 0.0,
        }
    }
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
    let mut remote_read_timeout_ms = defaults.remote_read_timeout_ms;
    if remote_read_timeout_ms == 0 {
        remote_read_timeout_ms = DEFAULT_REMOTE_READ_TIMEOUT_MS;
    }
    if remote_read_timeout_ms > MAX_DEADLINE_MS {
        return Err(PolicyError("invalid instance read deadline".to_string()));
    }
    base.validate()?;
    let mut merged = match base.to_json() {
        Value::Object(object) => object,
        _ => unreachable!("Policy::to_json always produces an object"),
    };
    if let Some(RuntimePolicy(overlay)) = overlay {
        if !overlay.is_null() {
            merge_overlay(&mut merged, overlay)?;
        }
    }

    let request_local = merged
        .get("requestLocal")
        .and_then(Value::as_bool)
        .ok_or_else(|| PolicyError("runtime requestLocal must be boolean".to_string()))?;
    let coalesce = merged
        .get("coalesce")
        .and_then(Value::as_bool)
        .ok_or_else(|| PolicyError("runtime coalesce must be boolean".to_string()))?;
    if let Some(leaf) = merged.get("remoteReadTimeoutMs") {
        let ms = finite_range(leaf, 1.0, MAX_DEADLINE_MS as f64, true)
            .ok_or_else(|| PolicyError("invalid runtime remoteReadTimeoutMs".to_string()))?;
        remote_read_timeout_ms = ms as u64;
    }

    let empty = Map::new();
    let ttls = merged
        .get("ttlSec")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let ramps = merged
        .get("ramp")
        .and_then(Value::as_object)
        .unwrap_or(&empty);
    let local = resolve_layer(ttls, ramps, logical_key, "local");
    let remote = resolve_layer(ttls, ramps, logical_key, "remote");

    let mut stale_on_error_max_age_ms = 0;
    let mut stale_on_error_config_error = false;
    if let Some(age) = merged.get("staleOnErrorMaxAgeSec") {
        let numeric_zero = policy_number(age) == Some(0.0);
        if !remote.configured {
            stale_on_error_config_error =
                remote.reason == Some(DisabledReason::PolicyDisabled) && !numeric_zero;
        } else if !numeric_zero {
            match ttl_sec(age).map(|seconds| seconds * 1_000) {
                Some(ms) if ms > remote.ttl_ms => stale_on_error_max_age_ms = ms,
                _ => stale_on_error_config_error = true,
            }
        }
    }

    let mut shadow = ResolvedShadow::default();
    if let Some(leaves) = merged.get("shadow").and_then(Value::as_object) {
        if let Some(leaf) = leaves.get("ramp") {
            match finite_range(leaf, 0.0, 100.0, false) {
                Some(ramp) => {
                    shadow.ramp = ramp;
                    shadow.enabled = admits(ramp, logical_key, "shadow");
                }
                None => shadow.config_error = true,
            }
        }
        if let Some(leaf) = leaves.get("logMismatches") {
            match leaf.as_bool() {
                Some(flag) => shadow.log_mismatches = flag,
                None => {
                    shadow.log_mismatches = false;
                    shadow.logging_config_error = true;
                }
            }
        }
    }

    Ok(ResolvedPolicy {
        request_local,
        coalesce,
        local,
        remote,
        remote_read_timeout_ms,
        stale_on_error_max_age_ms,
        stale_on_error_config_error,
        shadow,
    })
}

/// Apply a sparse runtime overlay to the static policy's JSON form. Every
/// present member counts, including `null`, so an explicit null leaf replaces
/// the operation leaf and is then judged as an invalid supplied value.
fn merge_overlay(merged: &mut Map<String, Value>, overlay: &Value) -> Result<(), PolicyError> {
    let overlay = policy_object(overlay, "runtime config")?;
    reject_shadow_ramp(overlay)?;
    for (name, leaves) in [
        ("ttlSec", &["local", "remote"][..]),
        ("ramp", &["local", "remote"][..]),
        ("shadow", &["ramp", "logMismatches"][..]),
    ] {
        let Some(incoming) = overlay.get(name) else {
            continue;
        };
        let incoming = policy_object(incoming, name)?;
        let mut output = match merged.get(name) {
            Some(Value::Object(existing)) => existing.clone(),
            _ => Map::new(),
        };
        for leaf in leaves {
            if let Some(value) = incoming.get(*leaf) {
                output.insert((*leaf).to_string(), value.clone());
            }
        }
        merged.insert(name.to_string(), Value::Object(output));
    }
    for name in [
        "requestLocal",
        "coalesce",
        "staleOnErrorMaxAgeSec",
        "remoteReadTimeoutMs",
    ] {
        if let Some(value) = overlay.get(name) {
            merged.insert(name.to_string(), value.clone());
        }
    }
    Ok(())
}

fn resolve_layer(
    ttls: &Map<String, Value>,
    ramps: &Map<String, Value>,
    logical_key: &str,
    layer: &str,
) -> ResolvedLayer {
    let Some(ttl) = ttls.get(layer) else {
        return ResolvedLayer::disabled(DisabledReason::PolicyDisabled);
    };
    let Some(ttl_ms) = ttl_sec(ttl).map(|seconds| seconds * 1_000) else {
        return ResolvedLayer::disabled(DisabledReason::InvalidTtl);
    };
    let ramp = match ramps.get(layer) {
        None => 100.0,
        Some(leaf) => match finite_range(leaf, 0.0, 100.0, false) {
            Some(ramp) => ramp,
            None => return ResolvedLayer::disabled(DisabledReason::InvalidRamp),
        },
    };
    let enabled = admits(ramp, logical_key, layer);
    ResolvedLayer {
        enabled,
        reason: if enabled {
            None
        } else {
            Some(DisabledReason::RampedDown)
        },
        configured: true,
        ttl_ms,
        ramp,
    }
}

/// Cohort admission: a full ramp admits every key, a zero ramp none, and a
/// partial ramp admits keys whose stable sample is strictly below it.
fn admits(ramp: f64, logical_key: &str, discriminator: &str) -> bool {
    ramp >= 100.0 || (ramp > 0.0 && crate::identity::cohort(logical_key, discriminator) < ramp)
}

fn ramp_in_domain(ramp: f64) -> bool {
    ramp.is_finite() && (0.0..=100.0).contains(&ramp)
}

/// Spell a ramp the way JavaScript and Go's `encoding/json` do: an integral
/// value has no fraction (`100`, not `100.0`), so a static policy's JSON form
/// compares equal to the same policy parsed from text.
fn ramp_json(ramp: f64) -> Value {
    if ramp_in_domain(ramp) && ramp.trunc() == ramp {
        Value::from(ramp as u64)
    } else {
        Value::from(ramp)
    }
}

/// The numeric domain: JSON numbers only. Strings and booleans never count.
fn policy_number(value: &Value) -> Option<f64> {
    value.as_number().and_then(serde_json::Number::as_f64)
}

fn finite_range(value: &Value, min: f64, max: f64, integer: bool) -> Option<f64> {
    let n = policy_number(value)?;
    (n.is_finite() && n >= min && n <= max && (!integer || n.trunc() == n)).then_some(n)
}

/// A TTL-domain leaf in whole seconds.
fn ttl_sec(value: &Value) -> Option<u64> {
    finite_range(value, 1.0, MAX_CACHE_TTL_SEC as f64, true).map(|n| n as u64)
}

fn policy_object<'a>(value: &'a Value, name: &str) -> Result<&'a Map<String, Value>, PolicyError> {
    value
        .as_object()
        .ok_or_else(|| PolicyError(format!("DialCache {name} must be an object")))
}

fn reject_shadow_ramp(object: &Map<String, Value>) -> Result<(), PolicyError> {
    if object.contains_key("shadowRamp") {
        return Err(PolicyError(
            "shadowRamp was replaced by shadow.ramp".to_string(),
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const KEY: &str = "policy:item:one#lookup";
    const MAX_TTL: u64 = MAX_CACHE_TTL_SEC;

    fn resolve(base: &Policy, overlay: Option<Value>) -> Result<ResolvedPolicy, PolicyError> {
        let overlay = overlay.map(RuntimePolicy);
        resolve_policy(base, overlay.as_ref(), KEY, PolicyDefaults::default())
    }

    fn resolved(base: &Policy, overlay: Option<Value>) -> ResolvedPolicy {
        resolve(base, overlay).expect("policy resolves")
    }

    // Port of TestPolicySparseResolutionAndSnapshots.
    #[test]
    fn sparse_resolution_and_inheritance() {
        let base = Policy::from_json(&json!({
            "requestLocal": true, "coalesce": false,
            "ttlSec": {"local": 1.0, "remote": 2.0},
            "staleOnErrorMaxAgeSec": 5.0, "remoteReadTimeoutMs": 30.0,
            "shadow": {"ramp": 100.0, "logMismatches": true},
        }))
        .unwrap();
        let overlay = RuntimePolicy(json!({
            "ttlSec": {"remote": 4.0},
            "ramp": {"local": 0.0},
            "shadow": {"logMismatches": false},
        }));
        let r = resolve_policy(
            &base,
            Some(&overlay),
            KEY,
            PolicyDefaults {
                remote_read_timeout_ms: 20,
            },
        )
        .unwrap();
        assert!(r.request_local);
        assert!(!r.coalesce);
        assert!(!r.local.enabled);
        assert_eq!(r.local.reason, Some(DisabledReason::RampedDown));
        assert!(r.local.configured);
        assert_eq!(r.local.ttl_ms, 1_000);
        assert_eq!(r.local.ramp, 0.0);
        assert!(r.remote.enabled);
        assert_eq!(r.remote.reason, None);
        assert_eq!(r.remote.ttl_ms, 4_000);
        assert_eq!(r.remote.ramp, 100.0);
        assert_eq!(r.stale_on_error_max_age_ms, 5_000);
        assert!(!r.stale_on_error_config_error);
        assert_eq!(r.remote_read_timeout_ms, 30);
        assert!(r.shadow.enabled);
        assert_eq!(r.shadow.ramp, 100.0);
        assert!(!r.shadow.log_mismatches);
        assert!(!r.shadow.config_error);
        assert!(!r.shadow.logging_config_error);

        // A clone is an independent snapshot of every leaf.
        let snapshot = base.clone();
        let mut mutated = base.clone();
        mutated.remote_read_timeout_ms = Some(99);
        mutated.shadow.as_mut().unwrap().ramp = Some(0.0);
        assert_eq!(snapshot.remote_read_timeout_ms, Some(30));
        assert_eq!(snapshot.shadow.as_ref().unwrap().ramp, Some(100.0));

        // A null provider reply inherits the whole operation policy.
        for overlay in [None, Some(Value::Null)] {
            let inherit = resolve_policy(
                &snapshot,
                overlay.map(RuntimePolicy).as_ref(),
                KEY,
                PolicyDefaults::default(),
            )
            .unwrap();
            assert!(inherit.local.enabled);
            assert!(inherit.remote.enabled);
            assert_eq!(inherit.remote_read_timeout_ms, 30);
            assert!(inherit.shadow.enabled);
            assert!(inherit.shadow.log_mismatches);
        }
    }

    // Port of TestPolicyStaticValidation.
    #[test]
    fn static_validation_rejects_malformed_configs() {
        let invalid = [
            json!(true),
            json!([]),
            json!("policy"),
            json!(1),
            json!({"shadowRamp": 1}),
            json!({"ttlSec": null}),
            json!({"ramp": null}),
            json!({"shadow": null}),
            json!({"ttlSec": []}),
            json!({"ttlSec": 60}),
            json!({"shadow": true}),
            json!({"requestLocal": null}),
            json!({"coalesce": null}),
            json!({"coalesce": "false"}),
            json!({"requestLocal": 1}),
            json!({"ttlSec": {"local": null}}),
            json!({"ttlSec": {"local": 0}}),
            json!({"ttlSec": {"local": -1}}),
            json!({"ttlSec": {"local": 1.5}}),
            json!({"ttlSec": {"local": "60"}}),
            json!({"ttlSec": {"remote": 31_536_001}}),
            json!({"ramp": {"remote": null}}),
            json!({"ramp": {"remote": "nan"}}),
            json!({"ramp": {"remote": -0.5}}),
            json!({"ramp": {"local": 100.5}}),
            json!({"ramp": {"local": true}}),
            json!({"remoteReadTimeoutMs": null}),
            json!({"remoteReadTimeoutMs": 0}),
            json!({"remoteReadTimeoutMs": 1.5}),
            json!({"remoteReadTimeoutMs": 2_147_483_648u64}),
            json!({"staleOnErrorMaxAgeSec": null}),
            json!({"staleOnErrorMaxAgeSec": -1}),
            json!({"staleOnErrorMaxAgeSec": 2.5}),
            json!({"staleOnErrorMaxAgeSec": 2}),
            json!({"ttlSec": {"remote": 2}, "staleOnErrorMaxAgeSec": 2}),
            json!({"ttlSec": {"remote": 2}, "staleOnErrorMaxAgeSec": 1}),
            json!({"ttlSec": {"local": 2}, "staleOnErrorMaxAgeSec": 3}),
            json!({"ttlSec": {"remote": 2}, "staleOnErrorMaxAgeSec": 31_536_001}),
            json!({"shadow": {"ramp": null}}),
            json!({"shadow": {"ramp": 101}}),
            json!({"shadow": {"ramp": "50"}}),
            json!({"shadow": {"logMismatches": null}}),
            json!({"shadow": {"logMismatches": 1}}),
        ];
        for config in invalid {
            assert!(
                Policy::from_json(&config).is_err(),
                "accepted invalid static config: {config}"
            );
        }

        let accepted = Policy::from_json(&json!({
            "ttlSec": {"remote": 31_536_000},
            "remoteReadTimeoutMs": 2_147_483_647u64,
        }))
        .unwrap();
        assert_eq!(accepted.remote_ttl_sec, Some(MAX_TTL));
        assert_eq!(accepted.remote_read_timeout_ms, Some(MAX_DEADLINE_MS));
        assert_eq!(accepted.local_ttl_sec, None);

        // Zero recovery age is valid without a remote TTL; a positive one needs to exceed it.
        assert!(Policy::from_json(&json!({"staleOnErrorMaxAgeSec": 0})).is_ok());
        assert!(
            Policy::from_json(&json!({"ttlSec": {"remote": 2}, "staleOnErrorMaxAgeSec": 3}))
                .is_ok()
        );
        // Integer-valued floats and unsigned integers share one numeric domain.
        let floats =
            Policy::from_json(&json!({"ttlSec": {"local": 60.0}, "ramp": {"local": 50}})).unwrap();
        assert_eq!(floats.local_ttl_sec, Some(60));
        assert_eq!(floats.local_ramp, Some(50.0));
        // Ramp boundaries are inclusive.
        assert!(Policy::from_json(
            &json!({"ramp": {"local": 0, "remote": 100}, "shadow": {"ramp": 0}})
        )
        .is_ok());

        // Direct validation mirrors the same domains without the parser.
        assert!(Policy::default().local_ttl_sec(0).validate().is_err());
        assert!(Policy::default()
            .local_ttl_sec(MAX_TTL + 1)
            .validate()
            .is_err());
        assert!(Policy::default().remote_ttl_sec(MAX_TTL).validate().is_ok());
        assert!(Policy::default().local_ramp(f64::NAN).validate().is_err());
        assert!(Policy::default()
            .remote_ramp(f64::INFINITY)
            .validate()
            .is_err());
        assert!(Policy::default().remote_ramp(100.0001).validate().is_err());
        assert!(Policy::default().local_ramp(-0.1).validate().is_err());
        assert!(Policy::default()
            .remote_read_timeout_ms(0)
            .validate()
            .is_err());
        assert!(Policy::default()
            .remote_read_timeout_ms(MAX_DEADLINE_MS + 1)
            .validate()
            .is_err());
        assert!(Policy::default()
            .remote_read_timeout_ms(MAX_DEADLINE_MS)
            .validate()
            .is_ok());
        assert!(Policy::default()
            .stale_on_error_max_age_sec(1)
            .validate()
            .is_err());
        assert!(Policy::default()
            .stale_on_error_max_age_sec(0)
            .validate()
            .is_ok());
        assert!(Policy::default()
            .remote_ttl_sec(2)
            .stale_on_error_max_age_sec(2)
            .validate()
            .is_err());
        assert!(Policy::default()
            .remote_ttl_sec(2)
            .stale_on_error_max_age_sec(3)
            .validate()
            .is_ok());
        assert!(Policy::default()
            .remote_ttl_sec(2)
            .stale_on_error_max_age_sec(MAX_TTL + 1)
            .validate()
            .is_err());
        let nan_shadow = ShadowPolicy {
            ramp: Some(f64::NAN),
            log_mismatches: None,
        };
        assert!(Policy::default().shadow(nan_shadow).validate().is_err());
        let high_shadow = ShadowPolicy {
            ramp: Some(100.5),
            log_mismatches: None,
        };
        assert!(Policy::default().shadow(high_shadow).validate().is_err());
        let flag_only = ShadowPolicy {
            ramp: None,
            log_mismatches: Some(true),
        };
        assert!(Policy::default().shadow(flag_only).validate().is_ok());
        assert!(Policy::enabled(60).validate().is_ok());
        assert!(Policy::disabled().validate().is_ok());
    }

    #[test]
    fn from_json_treats_absent_and_null_wholes_as_empty() {
        assert_eq!(Policy::from_json(&Value::Null).unwrap(), Policy::default());
        assert_eq!(Policy::from_json(&json!({})).unwrap(), Policy::default());
        // Unknown members are ignored, as in the TypeScript constructor.
        assert_eq!(
            Policy::from_json(&json!({"unknown": 1})).unwrap(),
            Policy::default()
        );
        // Empty containers are valid and leave every leaf omitted.
        let empty = Policy::from_json(&json!({"ttlSec": {}, "ramp": {}, "shadow": {}})).unwrap();
        assert_eq!(empty.local_ttl_sec, None);
        assert_eq!(empty.shadow, Some(ShadowPolicy::default()));
    }

    #[test]
    fn from_json_round_trips_through_to_json() {
        let source = json!({
            "ttlSec": {"local": 5, "remote": 60},
            "ramp": {"local": 12.5, "remote": 100},
            "requestLocal": true,
            "coalesce": false,
            "staleOnErrorMaxAgeSec": 120,
            "remoteReadTimeoutMs": 25,
            "shadow": {"ramp": 3.5, "logMismatches": true},
        });
        let policy = Policy::from_json(&source).unwrap();
        assert_eq!(
            policy,
            Policy {
                request_local: Some(true),
                coalesce: Some(false),
                local_ttl_sec: Some(5),
                remote_ttl_sec: Some(60),
                local_ramp: Some(12.5),
                remote_ramp: Some(100.0),
                stale_on_error_max_age_sec: Some(120),
                remote_read_timeout_ms: Some(25),
                shadow: Some(ShadowPolicy {
                    ramp: Some(3.5),
                    log_mismatches: Some(true)
                }),
            }
        );
        assert_eq!(policy.to_json(), source);
        assert_eq!(Policy::from_json(&policy.to_json()).unwrap(), policy);
    }

    #[test]
    fn to_json_matches_the_static_policy_map_shape() {
        // Empty policy: layer maps present but empty, flags at their defaults, optionals absent.
        assert_eq!(
            Policy::default().to_json(),
            json!({"ttlSec": {}, "ramp": {}, "requestLocal": false, "coalesce": true})
        );
        // Only present leaves appear inside the layer maps; integral ramps spell without a fraction.
        assert_eq!(
            Policy::default()
                .local_ttl_sec(7)
                .remote_ramp(40.0)
                .to_json(),
            json!({"ttlSec": {"local": 7}, "ramp": {"remote": 40}, "requestLocal": false, "coalesce": true})
        );
        assert_eq!(
            Policy::default().local_ramp(12.5).to_json(),
            json!({"ttlSec": {}, "ramp": {"local": 12.5}, "requestLocal": false, "coalesce": true})
        );
        // An explicit flag value is emitted even when it equals the default.
        assert_eq!(
            Policy::default()
                .request_local(false)
                .coalesce(true)
                .to_json(),
            json!({"ttlSec": {}, "ramp": {}, "requestLocal": false, "coalesce": true})
        );
        // A present but empty shadow policy is an empty object.
        assert_eq!(
            Policy::default().shadow(ShadowPolicy::default()).to_json(),
            json!({"ttlSec": {}, "ramp": {}, "requestLocal": false, "coalesce": true, "shadow": {}})
        );
        assert_eq!(
            Policy::default()
                .shadow(ShadowPolicy {
                    ramp: None,
                    log_mismatches: Some(false)
                })
                .to_json(),
            json!({
                "ttlSec": {}, "ramp": {}, "requestLocal": false, "coalesce": true,
                "shadow": {"logMismatches": false},
            })
        );
        // Zero recovery age is a present leaf, not an omission.
        assert_eq!(
            Policy::default()
                .stale_on_error_max_age_sec(0)
                .remote_read_timeout_ms(75)
                .to_json(),
            json!({
                "ttlSec": {}, "ramp": {}, "requestLocal": false, "coalesce": true,
                "staleOnErrorMaxAgeSec": 0, "remoteReadTimeoutMs": 75,
            })
        );
        assert_eq!(
            Policy::enabled(60).to_json(),
            json!({
                "ttlSec": {"local": 60, "remote": 60},
                "ramp": {"local": 100, "remote": 100},
                "requestLocal": false, "coalesce": true,
            })
        );
        assert_eq!(
            Policy::disabled().to_json(),
            json!({
                "ttlSec": {},
                "ramp": {"local": 0, "remote": 0},
                "requestLocal": false, "coalesce": true,
                "staleOnErrorMaxAgeSec": 0,
                "shadow": {"ramp": 0, "logMismatches": false},
            })
        );
    }

    #[test]
    fn enabled_and_disabled_presets_resolve_as_documented() {
        let enabled = resolved(&Policy::enabled(60), None);
        assert!(!enabled.request_local);
        assert!(enabled.coalesce);
        assert!(enabled.local.enabled && enabled.remote.enabled);
        assert_eq!(
            (enabled.local.ttl_ms, enabled.remote.ttl_ms),
            (60_000, 60_000)
        );
        assert_eq!((enabled.local.ramp, enabled.remote.ramp), (100.0, 100.0));
        assert_eq!(
            enabled.remote_read_timeout_ms,
            DEFAULT_REMOTE_READ_TIMEOUT_MS
        );
        assert_eq!(enabled.stale_on_error_max_age_ms, 0);
        assert!(!enabled.stale_on_error_config_error);
        assert_eq!(enabled.shadow, ResolvedShadow::default());

        // Standing alone, the kill switch has no TTLs: both layers are simply not configured,
        // and its zero recovery age is not a configuration error.
        let alone = resolved(&Policy::disabled(), None);
        assert_eq!(alone.local.reason, Some(DisabledReason::PolicyDisabled));
        assert_eq!(alone.remote.reason, Some(DisabledReason::PolicyDisabled));
        assert!(!alone.stale_on_error_config_error);
        assert!(!alone.shadow.enabled && !alone.shadow.config_error);
        assert!(!alone.shadow.log_mismatches && !alone.shadow.logging_config_error);

        // As an overlay it ramps every inherited path to zero instead of relying on omission.
        let base = Policy::enabled(60)
            .request_local(true)
            .stale_on_error_max_age_sec(120)
            .shadow(ShadowPolicy {
                ramp: Some(100.0),
                log_mismatches: Some(true),
            });
        let killed = resolved(&base, Some(RuntimePolicy::from(Policy::disabled()).0));
        assert!(!killed.request_local);
        assert!(killed.coalesce);
        for layer in [killed.local, killed.remote] {
            assert!(!layer.enabled);
            assert_eq!(layer.reason, Some(DisabledReason::RampedDown));
            assert!(layer.configured);
            assert_eq!(layer.ttl_ms, 60_000);
            assert_eq!(layer.ramp, 0.0);
        }
        assert_eq!(killed.stale_on_error_max_age_ms, 0);
        assert!(!killed.stale_on_error_config_error);
        assert_eq!(killed.shadow, ResolvedShadow::default());
    }

    // Port of TestRuntimePolicyFailureScopes.
    #[test]
    fn runtime_failure_scopes() {
        let base = Policy::default()
            .request_local(true)
            .local_ttl_sec(1)
            .remote_ttl_sec(2);
        for overlay in [
            json!(false),
            json!([]),
            json!("config"),
            json!(0),
            json!({"shadowRamp": 5}),
            json!({"ttlSec": null}),
            json!({"ttlSec": []}),
            json!({"ttlSec": 5}),
            json!({"ramp": null}),
            json!({"shadow": null}),
            json!({"shadow": "off"}),
            json!({"requestLocal": null}),
            json!({"requestLocal": "true"}),
            json!({"coalesce": 1}),
            json!({"coalesce": null}),
            json!({"remoteReadTimeoutMs": 0}),
            json!({"remoteReadTimeoutMs": null}),
            json!({"remoteReadTimeoutMs": 1.5}),
            json!({"remoteReadTimeoutMs": "30"}),
            json!({"remoteReadTimeoutMs": 2_147_483_648u64}),
        ] {
            assert!(
                resolve(&base, Some(overlay.clone())).is_err(),
                "accepted invalid invocation policy: {overlay}"
            );
        }

        struct Case {
            overlay: Value,
            local: Option<DisabledReason>,
            remote: Option<DisabledReason>,
            recovery_error: bool,
        }
        let invalid_ttl = Some(DisabledReason::InvalidTtl);
        let invalid_ramp = Some(DisabledReason::InvalidRamp);
        let cases = [
            Case {
                overlay: json!({"ttlSec": {"local": null}}),
                local: invalid_ttl,
                remote: None,
                recovery_error: false,
            },
            Case {
                overlay: json!({"ttlSec": {"local": "1"}}),
                local: invalid_ttl,
                remote: None,
                recovery_error: false,
            },
            Case {
                overlay: json!({"ttlSec": {"local": 0}}),
                local: invalid_ttl,
                remote: None,
                recovery_error: false,
            },
            Case {
                overlay: json!({"ttlSec": {"local": 1.5}}),
                local: invalid_ttl,
                remote: None,
                recovery_error: false,
            },
            Case {
                overlay: json!({"ttlSec": {"local": 31_536_001}}),
                local: invalid_ttl,
                remote: None,
                recovery_error: false,
            },
            Case {
                overlay: json!({"ramp": {"remote": true}}),
                local: None,
                remote: invalid_ramp,
                recovery_error: false,
            },
            Case {
                overlay: json!({"ramp": {"remote": null}}),
                local: None,
                remote: invalid_ramp,
                recovery_error: false,
            },
            Case {
                overlay: json!({"ramp": {"remote": 100.1}}),
                local: None,
                remote: invalid_ramp,
                recovery_error: false,
            },
            Case {
                overlay: json!({"ramp": {"local": -1}}),
                local: invalid_ramp,
                remote: None,
                recovery_error: false,
            },
            Case {
                overlay: json!({"staleOnErrorMaxAgeSec": null}),
                local: None,
                remote: None,
                recovery_error: true,
            },
            Case {
                overlay: json!({"staleOnErrorMaxAgeSec": 1}),
                local: None,
                remote: None,
                recovery_error: true,
            },
            Case {
                overlay: json!({"staleOnErrorMaxAgeSec": 2}),
                local: None,
                remote: None,
                recovery_error: true,
            },
            Case {
                overlay: json!({"staleOnErrorMaxAgeSec": "3"}),
                local: None,
                remote: None,
                recovery_error: true,
            },
            Case {
                overlay: json!({"staleOnErrorMaxAgeSec": 2.5}),
                local: None,
                remote: None,
                recovery_error: true,
            },
            Case {
                overlay: json!({"staleOnErrorMaxAgeSec": 0}),
                local: None,
                remote: None,
                recovery_error: false,
            },
            Case {
                overlay: json!({"staleOnErrorMaxAgeSec": 0.0}),
                local: None,
                remote: None,
                recovery_error: false,
            },
            Case {
                overlay: json!({"staleOnErrorMaxAgeSec": 3}),
                local: None,
                remote: None,
                recovery_error: false,
            },
            Case {
                overlay: json!({"ttlSec": {"remote": -1}, "staleOnErrorMaxAgeSec": -1}),
                local: None,
                remote: invalid_ttl,
                recovery_error: false,
            },
            Case {
                overlay: json!({"ramp": {"remote": "bad"}, "staleOnErrorMaxAgeSec": 5}),
                local: None,
                remote: invalid_ramp,
                recovery_error: false,
            },
        ];
        for case in cases {
            let r = resolved(&base, Some(case.overlay.clone()));
            assert!(r.request_local, "{}", case.overlay);
            assert!(r.coalesce, "{}", case.overlay);
            assert_eq!(
                r.local.reason, case.local,
                "local reason for {}",
                case.overlay
            );
            assert_eq!(
                r.remote.reason, case.remote,
                "remote reason for {}",
                case.overlay
            );
            assert_eq!(r.local.enabled, case.local.is_none(), "{}", case.overlay);
            assert_eq!(r.remote.enabled, case.remote.is_none(), "{}", case.overlay);
            assert_eq!(
                r.stale_on_error_config_error, case.recovery_error,
                "recovery for {}",
                case.overlay
            );
            if case.recovery_error {
                assert_eq!(r.stale_on_error_max_age_ms, 0, "{}", case.overlay);
            }
        }
        // A valid runtime age above the remote TTL enables recovery.
        assert_eq!(
            resolved(&base, Some(json!({"staleOnErrorMaxAgeSec": 3}))).stale_on_error_max_age_ms,
            3_000
        );

        // Recovery configured without any remote TTL is a diagnostic error on a disabled layer.
        let missing = resolved(
            &Policy::default(),
            Some(json!({"staleOnErrorMaxAgeSec": 3})),
        );
        assert!(missing.stale_on_error_config_error);
        assert_eq!(missing.remote.reason, Some(DisabledReason::PolicyDisabled));
        assert!(!missing.remote.configured);
        assert_eq!(missing.stale_on_error_max_age_ms, 0);
        // ... unless it is numeric zero.
        let zero = resolved(
            &Policy::default(),
            Some(json!({"staleOnErrorMaxAgeSec": 0})),
        );
        assert!(!zero.stale_on_error_config_error);
        // A non-numeric leaf on a disabled remote layer is still an error.
        let text = resolved(
            &Policy::default(),
            Some(json!({"staleOnErrorMaxAgeSec": "0"})),
        );
        assert!(text.stale_on_error_config_error);
    }

    // Port of TestRecoveryRetentionAndShadowDiagnosticsRemainIndependent.
    #[test]
    fn recovery_retention_and_shadow_diagnostics_remain_independent() {
        let base = Policy::default()
            .remote_ttl_sec(1)
            .remote_ramp(0.0)
            .stale_on_error_max_age_sec(86_400);
        let r = resolved(
            &base,
            Some(json!({"shadow": {"ramp": 100, "logMismatches": "invalid"}})),
        );
        assert!(!r.remote.enabled);
        assert!(r.remote.configured);
        assert_eq!(r.remote.reason, Some(DisabledReason::RampedDown));
        assert_eq!(r.stale_on_error_max_age_ms, 86_400_000);
        assert!(!r.stale_on_error_config_error);
        assert!(r.shadow.enabled);
        assert_eq!(r.shadow.ramp, 100.0);
        assert!(!r.shadow.config_error);
        assert!(r.shadow.logging_config_error);
        assert!(!r.shadow.log_mismatches);

        let r = resolved(&base, Some(json!({"shadow": {"ramp": null}})));
        assert!(r.shadow.config_error);
        assert!(!r.shadow.enabled);
        assert_eq!(r.shadow.ramp, 0.0);
        assert!(r.remote.configured);
        assert_eq!(r.stale_on_error_max_age_ms, 86_400_000);

        for invalid in [json!("50"), json!(-1), json!(100.5), json!(true)] {
            let r = resolved(&base, Some(json!({"shadow": {"ramp": invalid}})));
            assert!(r.shadow.config_error, "{invalid}");
            assert!(!r.shadow.enabled, "{invalid}");
        }
        // Zero shadow ramp is valid and silently off.
        let off = resolved(&base, Some(json!({"shadow": {"ramp": 0}})));
        assert!(!off.shadow.enabled && !off.shadow.config_error);
        // A null logging flag is malformed and disables warnings without touching the cohort.
        let logging = resolved(
            &base,
            Some(json!({"shadow": {"ramp": 100, "logMismatches": null}})),
        );
        assert!(
            logging.shadow.enabled
                && logging.shadow.logging_config_error
                && !logging.shadow.log_mismatches
        );
    }

    #[test]
    fn overlay_semantics_follow_the_portable_table() {
        let base = Policy::enabled(10)
            .request_local(true)
            .coalesce(false)
            .stale_on_error_max_age_sec(30)
            .remote_read_timeout_ms(40)
            .shadow(ShadowPolicy {
                ramp: Some(100.0),
                log_mismatches: Some(true),
            });

        // Omitted leaves inherit the operation leaf; an empty overlay changes nothing.
        let inherited = resolved(&base, None);
        assert_eq!(resolved(&base, Some(json!({}))), inherited);
        assert_eq!(
            resolved(&base, Some(json!({"ttlSec": {}, "ramp": {}, "shadow": {}}))),
            inherited
        );
        assert_eq!(resolved(&base, Some(Value::Null)), inherited);
        assert!(inherited.request_local && !inherited.coalesce);
        assert_eq!(inherited.remote_read_timeout_ms, 40);
        assert_eq!(inherited.stale_on_error_max_age_ms, 30_000);
        assert!(inherited.shadow.enabled && inherited.shadow.log_mismatches);

        // A present leaf replaces the operation leaf, sparsely.
        let patched = resolved(
            &base,
            Some(json!({"ttlSec": {"local": 3}, "ramp": {"remote": 0}})),
        );
        assert_eq!(patched.local.ttl_ms, 3_000);
        assert!(patched.local.enabled);
        assert_eq!(patched.remote.ttl_ms, 10_000);
        assert_eq!(patched.remote.reason, Some(DisabledReason::RampedDown));
        assert!(patched.remote.configured);
        // Recovery still measures against the merged remote TTL.
        assert_eq!(patched.stale_on_error_max_age_ms, 30_000);

        // An explicit null leaf is an invalid supplied value that disables only that layer.
        let nulled = resolved(&base, Some(json!({"ttlSec": {"remote": null}})));
        assert!(nulled.local.enabled);
        assert_eq!(nulled.remote.reason, Some(DisabledReason::InvalidTtl));
        assert!(!nulled.remote.configured);
        // The pre-existing recovery age on a layer disabled by an invalid TTL is not a config error.
        assert!(!nulled.stale_on_error_config_error);
        assert_eq!(nulled.stale_on_error_max_age_ms, 0);

        // An invalid flag fails the whole invocation.
        assert!(resolve(&base, Some(json!({"coalesce": "yes"}))).is_err());
        assert!(resolve(&base, Some(json!({"coalesce": null}))).is_err());
        assert!(resolve(&base, Some(json!({"requestLocal": 0}))).is_err());
        // ... as does an invalid runtime read deadline.
        assert!(resolve(&base, Some(json!({"remoteReadTimeoutMs": -5}))).is_err());
        // A valid runtime flag or deadline wins over the operation.
        let flipped = resolved(
            &base,
            Some(json!({"coalesce": true, "requestLocal": false, "remoteReadTimeoutMs": 7})),
        );
        assert!(flipped.coalesce && !flipped.request_local);
        assert_eq!(flipped.remote_read_timeout_ms, 7);

        // An invalid optional recovery age preserves remote serving with a diagnostic error.
        let recovery = resolved(&base, Some(json!({"staleOnErrorMaxAgeSec": 10})));
        assert!(recovery.remote.enabled);
        assert_eq!(recovery.stale_on_error_max_age_ms, 0);
        assert!(recovery.stale_on_error_config_error);
        let recovery = resolved(&base, Some(json!({"staleOnErrorMaxAgeSec": "30"})));
        assert!(recovery.remote.enabled && recovery.stale_on_error_config_error);
        // Zero disables inherited recovery silently.
        let off = resolved(&base, Some(json!({"staleOnErrorMaxAgeSec": 0})));
        assert!(off.remote.enabled);
        assert_eq!(off.stale_on_error_max_age_ms, 0);
        assert!(!off.stale_on_error_config_error);
        // Raising the remote TTL above the inherited age invalidates the inherited recovery.
        let raised = resolved(&base, Some(json!({"ttlSec": {"remote": 30}})));
        assert!(raised.remote.enabled && raised.stale_on_error_config_error);
        assert_eq!(raised.stale_on_error_max_age_ms, 0);

        // Shadow leaves merge independently of serving leaves.
        let shadow = resolved(&base, Some(json!({"shadow": {"logMismatches": false}})));
        assert!(shadow.shadow.enabled && !shadow.shadow.log_mismatches);
        let shadow = resolved(&base, Some(json!({"shadow": {"ramp": 0}})));
        assert!(
            !shadow.shadow.enabled && shadow.shadow.log_mismatches && !shadow.shadow.config_error
        );
        assert!(shadow.local.enabled && shadow.remote.enabled);
    }

    #[test]
    fn runtime_leaves_can_configure_paths_the_operation_omitted() {
        // Runtime TTLs enable layers the operation left off, with an implied full ramp.
        let r = resolved(
            &Policy::default(),
            Some(json!({"ttlSec": {"local": 5, "remote": 6}})),
        );
        assert!(r.local.enabled && r.remote.enabled);
        assert_eq!((r.local.ramp, r.remote.ramp), (100.0, 100.0));
        assert_eq!((r.local.ttl_ms, r.remote.ttl_ms), (5_000, 6_000));
        // A ramp without a TTL leaves the layer policy-disabled.
        let r = resolved(&Policy::default(), Some(json!({"ramp": {"local": 100}})));
        assert_eq!(r.local.reason, Some(DisabledReason::PolicyDisabled));
        assert!(!r.local.configured);
        // Runtime shadow and recovery leaves attach to a runtime remote layer.
        let r = resolved(
            &Policy::default(),
            Some(
                json!({"ttlSec": {"remote": 6}, "staleOnErrorMaxAgeSec": 7, "shadow": {"ramp": 100}}),
            ),
        );
        assert_eq!(r.stale_on_error_max_age_ms, 7_000);
        assert!(r.shadow.enabled && !r.shadow.log_mismatches);
        // A runtime static-policy overlay (via From<Policy>) behaves like its JSON form.
        let overlay = RuntimePolicy::from(Policy::default().local_ttl_sec(9));
        let r = resolve_policy(
            &Policy::default(),
            Some(&overlay),
            KEY,
            PolicyDefaults::default(),
        )
        .unwrap();
        assert!(r.local.enabled);
        assert_eq!(r.local.ttl_ms, 9_000);
        assert_eq!(r.remote.reason, Some(DisabledReason::PolicyDisabled));
    }

    #[test]
    fn instance_defaults_and_deadline_precedence() {
        let base = Policy::enabled(1);
        // Zero instance default means the library default.
        let r = resolve_policy(
            &base,
            None,
            KEY,
            PolicyDefaults {
                remote_read_timeout_ms: 0,
            },
        )
        .unwrap();
        assert_eq!(r.remote_read_timeout_ms, DEFAULT_REMOTE_READ_TIMEOUT_MS);
        // The instance default applies when neither operation nor runtime supplies a budget.
        let r = resolve_policy(
            &base,
            None,
            KEY,
            PolicyDefaults {
                remote_read_timeout_ms: 20,
            },
        )
        .unwrap();
        assert_eq!(r.remote_read_timeout_ms, 20);
        // Operation beats instance; runtime beats operation.
        let op = base.clone().remote_read_timeout_ms(30);
        let r = resolve_policy(
            &op,
            None,
            KEY,
            PolicyDefaults {
                remote_read_timeout_ms: 20,
            },
        )
        .unwrap();
        assert_eq!(r.remote_read_timeout_ms, 30);
        let overlay = RuntimePolicy(json!({"remoteReadTimeoutMs": 40}));
        let r = resolve_policy(
            &op,
            Some(&overlay),
            KEY,
            PolicyDefaults {
                remote_read_timeout_ms: 20,
            },
        )
        .unwrap();
        assert_eq!(r.remote_read_timeout_ms, 40);
        // An out-of-domain instance default fails resolution before anything else.
        let err = resolve_policy(
            &base,
            None,
            KEY,
            PolicyDefaults {
                remote_read_timeout_ms: MAX_DEADLINE_MS + 1,
            },
        );
        assert_eq!(
            err.unwrap_err(),
            PolicyError("invalid instance read deadline".to_string())
        );
        assert!(resolve_policy(
            &base,
            None,
            KEY,
            PolicyDefaults {
                remote_read_timeout_ms: MAX_DEADLINE_MS
            }
        )
        .is_ok());
        // A statically invalid base fails resolution even with a valid overlay.
        let invalid = Policy::default().local_ttl_sec(0);
        assert!(resolve(&invalid, Some(json!({"ttlSec": {"local": 5}}))).is_err());
    }

    #[test]
    fn error_messages_name_the_offending_container() {
        assert_eq!(
            Policy::from_json(&json!([])).unwrap_err(),
            PolicyError("DialCache defaultConfig must be an object".to_string())
        );
        assert_eq!(
            Policy::from_json(&json!({"ttlSec": null})).unwrap_err(),
            PolicyError("DialCache ttlSec must be an object".to_string())
        );
        assert_eq!(
            Policy::from_json(&json!({"shadowRamp": 1})).unwrap_err(),
            PolicyError("shadowRamp was replaced by shadow.ramp".to_string())
        );
        assert_eq!(
            resolve(&Policy::default(), Some(json!(1))).unwrap_err(),
            PolicyError("DialCache runtime config must be an object".to_string())
        );
        assert_eq!(
            resolve(&Policy::default(), Some(json!({"shadow": 1}))).unwrap_err(),
            PolicyError("DialCache shadow must be an object".to_string())
        );
        assert_eq!(
            resolve(&Policy::default(), Some(json!({"shadowRamp": null}))).unwrap_err(),
            PolicyError("shadowRamp was replaced by shadow.ramp".to_string())
        );
        assert_eq!(
            resolve(&Policy::default(), Some(json!({"coalesce": null}))).unwrap_err(),
            PolicyError("runtime coalesce must be boolean".to_string())
        );
        assert_eq!(
            resolve(&Policy::default(), Some(json!({"requestLocal": "x"}))).unwrap_err(),
            PolicyError("runtime requestLocal must be boolean".to_string())
        );
        assert_eq!(
            resolve(&Policy::default(), Some(json!({"remoteReadTimeoutMs": 0}))).unwrap_err(),
            PolicyError("invalid runtime remoteReadTimeoutMs".to_string())
        );
    }
}
