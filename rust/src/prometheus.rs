//! Prometheus metric exporter (feature `prometheus`).
//!
//! [`PrometheusObserver`] registers the nineteen DialCache collectors on a
//! [`Registry`] under the names, help text, label sets and histogram buckets
//! of the TypeScript adapter, and feeds every [`Event`] to them.
//!
//! # Reuse
//!
//! Collectors are process-wide state: constructing a second observer for the
//! same registry and prefix reuses the collectors the first one created, so
//! observations from both accumulate in one series set. The `prometheus`
//! crate reports a duplicate registration without a handle to the existing
//! collector, so reuse is keyed by the registry's address and the prefix in a
//! process-wide table. Pass the same [`Registry`] value each time, not a
//! clone: a clone shares the registered collectors but has another address,
//! and its construction fails as an externally owned duplicate.
//!
//! An externally registered collector with one of the DialCache names is
//! reported as [`PrometheusError::Conflict`]; the constructor then leaves the
//! registry as it found it.

use std::collections::HashMap;
use std::fmt;
use std::sync::{Arc, LazyLock};

use ::prometheus::core::Collector;
use ::prometheus::{HistogramOpts, HistogramVec, IntCounterVec, Opts, Registry};
use parking_lot::Mutex;

use crate::metrics::MetricKind;
use crate::observe::{Event, Observer};

const TIMER_BUCKETS: &[f64] = &[
    0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0,
];
const SIZE_BUCKETS: &[f64] = &[
    100.0,
    1_000.0,
    10_000.0,
    100_000.0,
    1_000_000.0,
    10_000_000.0,
];
const RATIO_BUCKETS: &[f64] = &[0.05, 0.1, 0.2, 0.3, 0.5, 0.7, 0.9, 1.0];
/// Value ages span seconds to the 365-day TTL ceiling: 1s..15m, then 1h, 3h, 12h, 1d, 3d, 7d.
const VALUE_AGE_BUCKETS: &[f64] = &[
    1.0, 5.0, 15.0, 60.0, 300.0, 900.0, 3_600.0, 10_800.0, 43_200.0, 86_400.0, 259_200.0, 604_800.0,
];
const FUTURE_TIMESTAMP_OFFSET_BUCKETS: &[f64] = &[
    0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 5.0, 15.0, 60.0, 300.0, 900.0, 3_600.0,
    10_800.0, 43_200.0,
];

/// The wire schema of one collector: what a scrape exposes.
#[derive(Debug, Clone, PartialEq)]
pub struct CollectorSchema {
    /// The event kind the collector receives.
    pub kind: MetricKind,
    /// The fully qualified metric name, prefix included.
    pub name: String,
    /// The Prometheus help text, spelled as in the TypeScript adapter.
    pub help: &'static str,
    /// Label names in wire order.
    pub labels: &'static [&'static str],
    /// Histogram bucket upper bounds; empty for counters.
    pub buckets: &'static [f64],
}

impl CollectorSchema {
    /// `true` for the counter vectors; every other collector is a histogram.
    pub fn is_counter(&self) -> bool {
        self.kind.is_counter()
    }
}

/// The nineteen collectors DialCache registers, in registration order, with
/// their names under `prefix`.
pub fn schemas(prefix: &str) -> Vec<CollectorSchema> {
    let schema = |kind: MetricKind,
                  suffix: &str,
                  help: &'static str,
                  buckets: &'static [f64]|
     -> CollectorSchema {
        CollectorSchema {
            kind,
            name: format!("{prefix}dialcache_{suffix}"),
            help,
            labels: kind.label_names(),
            buckets,
        }
    };
    vec![
        schema(
            MetricKind::Disabled,
            "disabled_counter",
            "Requests where DialCache skipped a cache layer.",
            &[],
        ),
        schema(
            MetricKind::Miss,
            "miss_counter",
            "DialCache cache misses.",
            &[],
        ),
        schema(
            MetricKind::Request,
            "request_counter",
            "Total DialCache cache-layer requests.",
            &[],
        ),
        schema(
            MetricKind::Error,
            "error_counter",
            "Errors during DialCache cache operations or fallback execution.",
            &[],
        ),
        schema(
            MetricKind::Invalidation,
            "invalidation_counter",
            "DialCache invalidation calls by key type and layer.",
            &[],
        ),
        schema(
            MetricKind::Coalesced,
            "coalesced_counter",
            "DialCache requests coalesced onto in-flight work by sharing scope.",
            &[],
        ),
        schema(
            MetricKind::ShadowValidation,
            "shadow_validation_counter",
            "Sampled DialCache Redis shadow-validation outcomes.",
            &[],
        ),
        schema(
            MetricKind::ShadowValueAge,
            "shadow_value_age_histogram",
            "Age in seconds of the validated Redis value at DialCache shadow verdict time.",
            VALUE_AGE_BUCKETS,
        ),
        schema(
            MetricKind::FutureTimestampOffset,
            "future_timestamp_offset_histogram",
            "Positive offset in seconds of Redis frames dated after the observing DialCache process clock.",
            FUTURE_TIMESTAMP_OFFSET_BUCKETS,
        ),
        schema(
            MetricKind::StaleRecovery,
            "stale_recovery_counter",
            "DialCache stale-on-error Redis recovery outcomes.",
            &[],
        ),
        schema(
            MetricKind::StaleRecoveryValueAge,
            "stale_recovery_value_age_histogram",
            "Age in seconds of Redis values served by DialCache stale-on-error recovery.",
            VALUE_AGE_BUCKETS,
        ),
        schema(
            MetricKind::Compression,
            "compression_counter",
            "DialCache Redis payload compression and decompression outcomes.",
            &[],
        ),
        schema(
            MetricKind::Get,
            "get_timer",
            "DialCache cache get latency in seconds.",
            TIMER_BUCKETS,
        ),
        schema(
            MetricKind::Fallback,
            "fallback_timer",
            "Time DialCache waited for the fallback function in seconds.",
            TIMER_BUCKETS,
        ),
        schema(
            MetricKind::Serialization,
            "serialization_timer",
            "DialCache serialization latency in seconds.",
            TIMER_BUCKETS,
        ),
        schema(
            MetricKind::Size,
            "size_histogram",
            "Serialized DialCache value sizes in bytes.",
            SIZE_BUCKETS,
        ),
        schema(
            MetricKind::StoredSize,
            "stored_size_histogram",
            "Stored DialCache payload sizes in bytes, after compression and escaping.",
            SIZE_BUCKETS,
        ),
        schema(
            MetricKind::CompressionRatio,
            "compression_ratio_histogram",
            "Compressed-to-original DialCache payload size ratio for compressed writes.",
            RATIO_BUCKETS,
        ),
        schema(
            MetricKind::CompressionDuration,
            "compression_timer",
            "DialCache payload compression and decompression latency in seconds.",
            TIMER_BUCKETS,
        ),
    ]
}

/// Construction failures of a [`PrometheusObserver`].
#[derive(Debug)]
pub enum PrometheusError {
    /// A collector with this name is already registered by someone else, or
    /// with another schema. Use a unique prefix or another registry.
    Conflict {
        /// The fully qualified collector name that collided.
        name: String,
        /// The registry's rejection.
        source: ::prometheus::Error,
    },
    /// The `prometheus` crate rejected a collector definition, which only a
    /// prefix that is not a valid metric name fragment can cause.
    InvalidCollector {
        /// The fully qualified collector name that was rejected.
        name: String,
        /// The crate's rejection.
        source: ::prometheus::Error,
    },
}

impl fmt::Display for PrometheusError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            PrometheusError::Conflict { name, source } => write!(
                f,
                "Prometheus collector {name:?} already exists with an incompatible or externally \
                 owned schema; use a unique prefix or registry: {source}"
            ),
            PrometheusError::InvalidCollector { name, source } => {
                write!(f, "invalid Prometheus collector {name:?}: {source}")
            }
        }
    }
}

impl std::error::Error for PrometheusError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            PrometheusError::Conflict { source, .. }
            | PrometheusError::InvalidCollector { source, .. } => Some(source),
        }
    }
}

#[derive(Clone)]
enum Vector {
    Counter(IntCounterVec),
    Histogram(HistogramVec),
}

impl Vector {
    fn boxed(&self) -> Box<dyn Collector> {
        match self {
            Vector::Counter(vector) => Box::new(vector.clone()),
            Vector::Histogram(vector) => Box::new(vector.clone()),
        }
    }
}

/// The collectors of one (registry, prefix) pair, indexed by [`MetricKind::index`].
struct Group {
    vectors: Vec<Vector>,
}

impl Group {
    fn build(prefix: &str) -> Result<Group, PrometheusError> {
        let mut vectors: Vec<Option<Vector>> = vec![None; MetricKind::ALL.len()];
        for schema in schemas(prefix) {
            let vector = if schema.is_counter() {
                IntCounterVec::new(Opts::new(&schema.name, schema.help), schema.labels)
                    .map(Vector::Counter)
            } else {
                HistogramVec::new(
                    HistogramOpts::new(&schema.name, schema.help).buckets(schema.buckets.to_vec()),
                    schema.labels,
                )
                .map(Vector::Histogram)
            }
            .map_err(|source| PrometheusError::InvalidCollector {
                name: schema.name.clone(),
                source,
            })?;
            vectors[schema.kind.index()] = Some(vector);
        }
        Ok(Group {
            vectors: vectors
                .into_iter()
                .map(|vector| vector.expect("every kind has a schema"))
                .collect(),
        })
    }

    /// Register every collector on `registry`; roll back on the first failure.
    fn register(&self, registry: &Registry, prefix: &str) -> Result<(), PrometheusError> {
        let mut registered: Vec<&Vector> = Vec::new();
        for schema in schemas(prefix) {
            let vector = &self.vectors[schema.kind.index()];
            if let Err(source) = registry.register(vector.boxed()) {
                for done in registered {
                    let _ = registry.unregister(done.boxed());
                }
                return Err(PrometheusError::Conflict {
                    name: schema.name,
                    source,
                });
            }
            registered.push(vector);
        }
        Ok(())
    }

    /// Make sure every collector is registered on `registry`, accepting the
    /// ones already there.
    fn ensure_registered(&self, registry: &Registry, prefix: &str) -> Result<(), PrometheusError> {
        for schema in schemas(prefix) {
            match registry.register(self.vectors[schema.kind.index()].boxed()) {
                Ok(()) | Err(::prometheus::Error::AlreadyReg) => {}
                Err(source) => {
                    return Err(PrometheusError::Conflict {
                        name: schema.name,
                        source,
                    })
                }
            }
        }
        Ok(())
    }
}

type GroupKey = (usize, String);

/// Collector groups by registry address and prefix. Groups are retained for
/// the process lifetime so a later observer for the same registry finds the
/// collectors even after every earlier observer was dropped.
static GROUPS: LazyLock<Mutex<HashMap<GroupKey, Arc<Group>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));

/// Publishes DialCache diagnostics to Prometheus collectors.
pub struct PrometheusObserver {
    group: Arc<Group>,
    prefix: String,
}

impl fmt::Debug for PrometheusObserver {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("PrometheusObserver")
            .field("prefix", &self.prefix)
            .finish_non_exhaustive()
    }
}

impl PrometheusObserver {
    /// Create or reuse the DialCache collectors named `<prefix>dialcache_*`
    /// on `registry`. See the module documentation for the reuse rule.
    pub fn new(registry: &Registry, prefix: &str) -> Result<PrometheusObserver, PrometheusError> {
        let key: GroupKey = (registry as *const Registry as usize, prefix.to_string());
        let mut groups = GROUPS.lock();
        let group = match groups.get(&key) {
            Some(group) => {
                group.ensure_registered(registry, prefix)?;
                group.clone()
            }
            None => {
                let group = Arc::new(Group::build(prefix)?);
                group.register(registry, prefix)?;
                groups.insert(key, group.clone());
                group
            }
        };
        Ok(PrometheusObserver {
            group,
            prefix: prefix.to_string(),
        })
    }

    /// The wire schemas of this observer's collectors.
    pub fn schemas(&self) -> Vec<CollectorSchema> {
        schemas(&self.prefix)
    }
}

impl Observer for PrometheusObserver {
    fn observe(&self, event: &Event) {
        let kind = MetricKind::of(event);
        let labels = MetricKind::labels(event);
        let values: Vec<&str> = labels.iter().map(|(_, value)| value.as_str()).collect();
        let result = match &self.group.vectors[kind.index()] {
            Vector::Counter(vector) => vector
                .get_metric_with_label_values(&values)
                .map(|metric| metric.inc()),
            Vector::Histogram(vector) => vector
                .get_metric_with_label_values(&values)
                .map(|metric| metric.observe(MetricKind::value(event))),
        };
        if let Err(error) = result {
            log::warn!(
                target: "dialcache",
                "Dropped DialCache {} metric with labels {:?}: {error}",
                kind.as_str(),
                labels
            );
        }
    }

    fn observes_shadow_outcomes(&self) -> bool {
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schemas_cover_every_kind_once_with_matching_label_names() {
        let all = schemas("p_");
        assert_eq!(all.len(), MetricKind::ALL.len());
        let mut seen = std::collections::HashSet::new();
        for schema in &all {
            assert!(seen.insert(schema.kind), "{:?} twice", schema.kind);
            assert!(schema.name.starts_with("p_dialcache_"));
            assert_eq!(schema.labels, schema.kind.label_names());
            assert_eq!(schema.buckets.is_empty(), schema.is_counter());
        }
    }

    #[test]
    fn invalid_prefix_is_an_error_not_a_panic() {
        let registry = Registry::new();
        let error = PrometheusObserver::new(&registry, "bad prefix ").unwrap_err();
        assert!(
            matches!(error, PrometheusError::InvalidCollector { .. }),
            "{error}"
        );
        assert!(registry.gather().is_empty());
    }
}
