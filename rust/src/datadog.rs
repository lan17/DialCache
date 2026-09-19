//! Datadog (DogStatsD) metric exporter.
//!
//! [`DatadogObserver`] publishes every [`Event`] to a caller-supplied
//! [`DogStatsdClient`] under the metric names, units and tags of the
//! TypeScript and Go adapters. Transport, buffering, flushing and ownership of
//! the client stay with the caller.

use std::fmt;

use crate::metrics::MetricKind;
use crate::observe::{Event, Observer};

/// The subset of the DogStatsD client API the exporter uses.
///
/// `tags` are `(name, value)` pairs in wire order. Implementations format
/// them as `name:value` for their transport.
pub trait DogStatsdClient: Send + Sync + 'static {
    /// Add `value` to the counter `name`.
    fn increment(&self, name: &str, value: f64, tags: &[(String, String)]);
    /// Record `value` in the histogram `name`.
    fn histogram(&self, name: &str, value: f64, tags: &[(String, String)]);
    /// Record `value` in the distribution `name`.
    fn distribution(&self, name: &str, value: f64, tags: &[(String, String)]);
}

/// How observations (timers, ages, sizes and ratios) are published.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ObservationMetricType {
    /// Agent-side percentiles per host.
    Histogram,
    /// Server-side global percentiles.
    Distribution,
}

/// Construction options of a [`DatadogObserver`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DatadogOptions {
    /// Whether observations go to DogStatsD histograms or distributions.
    pub observation_metric_type: ObservationMetricType,
    /// Metric-name namespace; unrelated to the cache namespace label.
    /// `None` selects [`DEFAULT_NAMESPACE`]; an explicit empty string is an error.
    pub namespace: Option<String>,
}

impl DatadogOptions {
    /// Options under the default metric-name namespace, [`DEFAULT_NAMESPACE`].
    pub fn new(observation_metric_type: ObservationMetricType) -> Self {
        DatadogOptions {
            observation_metric_type,
            namespace: None,
        }
    }

    /// Set the metric-name namespace; it must satisfy [`is_valid_namespace`].
    pub fn namespace(mut self, namespace: impl Into<String>) -> Self {
        self.namespace = Some(namespace.into());
        self
    }
}

/// The namespace used when [`DatadogOptions::namespace`] is `None`.
pub const DEFAULT_NAMESPACE: &str = "dialcache";
/// Datadog's metric name length limit.
pub const METRIC_NAME_MAX_LENGTH: usize = 200;

/// Construction failures of a [`DatadogObserver`].
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DatadogError {
    /// The namespace does not match `^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$`.
    InvalidNamespace(String),
    /// A metric name would exceed [`METRIC_NAME_MAX_LENGTH`] characters.
    MetricNameTooLong(String),
}

impl fmt::Display for DatadogError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            DatadogError::InvalidNamespace(namespace) => write!(
                f,
                "Datadog namespace {namespace:?} must start with a letter and contain only \
                 letters, numbers, underscores, and dot-separated non-empty segments"
            ),
            DatadogError::MetricNameTooLong(name) => write!(
                f,
                "Datadog metric name {name:?} exceeds the {METRIC_NAME_MAX_LENGTH}-character limit"
            ),
        }
    }
}

impl std::error::Error for DatadogError {}

/// The metric-name suffix of each kind, appended to the namespace.
pub fn metric_suffix(kind: MetricKind) -> &'static str {
    match kind {
        MetricKind::Request => "request.count",
        MetricKind::Miss => "miss.count",
        MetricKind::Disabled => "disabled.count",
        MetricKind::Error => "error.count",
        MetricKind::Invalidation => "invalidation.count",
        MetricKind::Coalesced => "coalesced.count",
        MetricKind::ShadowValidation => "shadow.count",
        MetricKind::ShadowValueAge => "shadow.value_age",
        MetricKind::FutureTimestampOffset => "future_timestamp_offset",
        MetricKind::StaleRecovery => "stale_recovery.count",
        MetricKind::StaleRecoveryValueAge => "stale_recovery.value_age",
        MetricKind::Compression => "compression.count",
        MetricKind::Get => "get.duration",
        MetricKind::Fallback => "fallback.duration",
        MetricKind::Serialization => "serialization.duration",
        MetricKind::Size => "serialization.size",
        MetricKind::StoredSize => "stored.size",
        MetricKind::CompressionRatio => "compression.ratio",
        MetricKind::CompressionDuration => "compression.duration",
    }
}

/// Whether `namespace` matches `^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z0-9_]+)*$`.
pub fn is_valid_namespace(namespace: &str) -> bool {
    let mut segments = namespace.split('.');
    let Some(first) = segments.next() else {
        return false;
    };
    if !first
        .chars()
        .next()
        .is_some_and(|c| c.is_ascii_alphabetic())
    {
        return false;
    }
    let segment_ok = |segment: &str| {
        !segment.is_empty()
            && segment
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '_')
    };
    segment_ok(first) && segments.all(segment_ok)
}

/// Publishes DialCache diagnostics to DogStatsD. Counters increment by one
/// per event; observations use the configured metric type.
pub struct DatadogObserver {
    client: Box<dyn DogStatsdClient>,
    names: Vec<String>,
    distribution: bool,
}

impl fmt::Debug for DatadogObserver {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DatadogObserver")
            .field("distribution", &self.distribution)
            .field("names", &self.names)
            .finish_non_exhaustive()
    }
}

impl DatadogObserver {
    /// Validate the namespace and precompute every metric name. Fails when
    /// the namespace is invalid or a name would exceed
    /// [`METRIC_NAME_MAX_LENGTH`].
    pub fn new(
        client: impl DogStatsdClient,
        options: DatadogOptions,
    ) -> Result<DatadogObserver, DatadogError> {
        let namespace = options.namespace.as_deref().unwrap_or(DEFAULT_NAMESPACE);
        if !is_valid_namespace(namespace) {
            return Err(DatadogError::InvalidNamespace(namespace.to_string()));
        }
        let mut names = Vec::with_capacity(MetricKind::ALL.len());
        for kind in MetricKind::ALL {
            let name = format!("{namespace}.{}", metric_suffix(kind));
            if name.chars().count() > METRIC_NAME_MAX_LENGTH {
                return Err(DatadogError::MetricNameTooLong(name));
            }
            names.push(name);
        }
        Ok(DatadogObserver {
            client: Box::new(client),
            names,
            distribution: options.observation_metric_type == ObservationMetricType::Distribution,
        })
    }

    /// The full metric name of `kind` under this observer's namespace.
    pub fn metric_name(&self, kind: MetricKind) -> &str {
        &self.names[kind.index()]
    }
}

impl Observer for DatadogObserver {
    fn observe(&self, event: &Event) {
        let kind = MetricKind::of(event);
        let name = self.metric_name(kind);
        let tags: Vec<(String, String)> = MetricKind::labels(event)
            .into_iter()
            .map(|(label, value)| (label.to_string(), value))
            .collect();
        if kind.is_counter() {
            self.client.increment(name, 1.0, &tags);
        } else if self.distribution {
            self.client
                .distribution(name, MetricKind::value(event), &tags);
        } else {
            self.client.histogram(name, MetricKind::value(event), &tags);
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
    fn namespace_pattern_matches_the_reference_regex() {
        for valid in ["dialcache", "app.cache", "A1_.b_2", "a", "x.y.z"] {
            assert!(is_valid_namespace(valid), "{valid}");
        }
        for invalid in [
            "",
            "1bad",
            "has-dash",
            "two..dots",
            ".lead",
            "trail.",
            "_under",
            "sp ace",
            "ünï",
        ] {
            assert!(!is_valid_namespace(invalid), "{invalid}");
        }
    }

    #[test]
    fn every_kind_has_a_distinct_suffix() {
        let suffixes: std::collections::HashSet<&str> =
            MetricKind::ALL.iter().map(|k| metric_suffix(*k)).collect();
        assert_eq!(suffixes.len(), MetricKind::ALL.len());
    }
}
