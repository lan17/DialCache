//! The metric exporters' wire contract: Datadog names, units and tags;
//! Prometheus schemas, reuse and conflict isolation; and observer failure
//! isolation from cache results.

use std::sync::Arc;

use dialcache::datadog::{metric_suffix, DatadogError};
use dialcache::observe::{
    CoalescingScope, CompressionOperation, CompressionOutcome, DisabledReason, ErrorKind, Labels,
    Layer, MissReason, OutcomeLabels, RecoveryOutcome, SerializationOperation, ShadowOutcome,
};
use dialcache::{
    DatadogObserver, DatadogOptions, DogStatsdClient, Event, MetricKind, ObservationMetricType,
    Observer,
};
use parking_lot::Mutex;

fn base() -> Labels {
    Labels {
        namespace: Arc::from("logical"),
        use_case: Arc::from("lookup"),
        key_type: Arc::from("item"),
        layer: Layer::Remote,
    }
}

fn outcome() -> OutcomeLabels {
    OutcomeLabels {
        namespace: Arc::from("logical"),
        use_case: Arc::from("lookup"),
        key_type: Arc::from("item"),
    }
}

/// One event per kind, mirroring Go's `metricTestEvent`: 0.25 s timers and
/// ages, 123-byte sizes, a 0.25 ratio.
fn metric_test_event(kind: MetricKind) -> Event {
    match kind {
        MetricKind::Request => Event::Request { labels: base() },
        MetricKind::Miss => Event::Miss {
            labels: base(),
            reason: MissReason::Expired,
        },
        MetricKind::Disabled => Event::Disabled {
            labels: base(),
            reason: DisabledReason::RampedDown,
        },
        MetricKind::Error => Event::Error {
            labels: base(),
            error: ErrorKind::Fallback,
            in_fallback: true,
        },
        MetricKind::Invalidation => Event::Invalidation {
            namespace: Arc::from("logical"),
            key_type: Arc::from("item"),
            layer: Layer::Remote,
        },
        MetricKind::Coalesced => Event::Coalesced {
            labels: outcome(),
            scope: CoalescingScope::Process,
        },
        MetricKind::ShadowValidation => Event::ShadowValidation {
            labels: outcome(),
            outcome: ShadowOutcome::Mismatch,
        },
        MetricKind::ShadowValueAge => Event::ShadowValueAge {
            labels: outcome(),
            outcome: ShadowOutcome::Mismatch,
            seconds: 0.25,
        },
        MetricKind::FutureTimestampOffset => Event::FutureTimestampOffset {
            labels: base(),
            seconds: 0.25,
        },
        MetricKind::StaleRecovery => Event::StaleRecovery {
            labels: outcome(),
            outcome: RecoveryOutcome::Served,
        },
        MetricKind::StaleRecoveryValueAge => Event::StaleRecoveryValueAge {
            labels: outcome(),
            outcome: RecoveryOutcome::Served,
            seconds: 0.25,
        },
        MetricKind::Compression => Event::Compression {
            labels: base(),
            outcome: CompressionOutcome::Compressed,
        },
        MetricKind::Get => Event::Get {
            labels: base(),
            seconds: 0.25,
        },
        MetricKind::Fallback => Event::Fallback {
            labels: base(),
            seconds: 0.25,
        },
        MetricKind::Serialization => Event::Serialization {
            labels: base(),
            operation: SerializationOperation::Dump,
            seconds: 0.25,
        },
        MetricKind::Size => Event::Size {
            labels: base(),
            bytes: 123,
        },
        MetricKind::StoredSize => Event::StoredSize {
            labels: base(),
            bytes: 123,
        },
        MetricKind::CompressionRatio => Event::CompressionRatio {
            labels: base(),
            ratio: 0.25,
        },
        MetricKind::CompressionDuration => Event::CompressionDuration {
            labels: base(),
            operation: CompressionOperation::Compress,
            seconds: 0.25,
        },
    }
}

fn tags(items: &[(&str, &str)]) -> Vec<(String, String)> {
    items
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_string()))
        .collect()
}

#[derive(Debug, Clone, PartialEq)]
struct Recorded {
    method: &'static str,
    name: String,
    value: f64,
    tags: Vec<(String, String)>,
}

#[derive(Default)]
struct RecordingClient {
    events: Arc<Mutex<Vec<Recorded>>>,
}

impl RecordingClient {
    fn record(&self, method: &'static str, name: &str, value: f64, tags: &[(String, String)]) {
        self.events.lock().push(Recorded {
            method,
            name: name.to_string(),
            value,
            tags: tags.to_vec(),
        });
    }
}

impl DogStatsdClient for RecordingClient {
    fn increment(&self, name: &str, value: f64, tags: &[(String, String)]) {
        self.record("increment", name, value, tags);
    }
    fn histogram(&self, name: &str, value: f64, tags: &[(String, String)]) {
        self.record("histogram", name, value, tags);
    }
    fn distribution(&self, name: &str, value: f64, tags: &[(String, String)]) {
        self.record("distribution", name, value, tags);
    }
}

fn recording() -> (RecordingClient, Arc<Mutex<Vec<Recorded>>>) {
    let client = RecordingClient::default();
    let events = client.events.clone();
    (client, events)
}

/// Port of TestDatadogMetricNamesUnitsAndLabels.
#[test]
fn datadog_metric_names_units_and_labels() {
    let (client, events) = recording();
    let observer = DatadogObserver::new(
        client,
        DatadogOptions::new(ObservationMetricType::Distribution).namespace("app.cache"),
    )
    .expect("valid options");
    assert!(observer.observes_shadow_outcomes());

    // (kind, suffix, method, value), copied from go/metrics_test.go.
    let cases: [(MetricKind, &str, &str, f64); 19] = [
        (MetricKind::Request, "request.count", "increment", 1.0),
        (MetricKind::Miss, "miss.count", "increment", 1.0),
        (MetricKind::Disabled, "disabled.count", "increment", 1.0),
        (MetricKind::Error, "error.count", "increment", 1.0),
        (
            MetricKind::Invalidation,
            "invalidation.count",
            "increment",
            1.0,
        ),
        (MetricKind::Coalesced, "coalesced.count", "increment", 1.0),
        (
            MetricKind::ShadowValidation,
            "shadow.count",
            "increment",
            1.0,
        ),
        (
            MetricKind::ShadowValueAge,
            "shadow.value_age",
            "distribution",
            0.25,
        ),
        (
            MetricKind::FutureTimestampOffset,
            "future_timestamp_offset",
            "distribution",
            0.25,
        ),
        (
            MetricKind::StaleRecovery,
            "stale_recovery.count",
            "increment",
            1.0,
        ),
        (
            MetricKind::StaleRecoveryValueAge,
            "stale_recovery.value_age",
            "distribution",
            0.25,
        ),
        (
            MetricKind::Compression,
            "compression.count",
            "increment",
            1.0,
        ),
        (MetricKind::Get, "get.duration", "distribution", 0.25),
        (
            MetricKind::Fallback,
            "fallback.duration",
            "distribution",
            0.25,
        ),
        (
            MetricKind::Serialization,
            "serialization.duration",
            "distribution",
            0.25,
        ),
        (
            MetricKind::Size,
            "serialization.size",
            "distribution",
            123.0,
        ),
        (MetricKind::StoredSize, "stored.size", "distribution", 123.0),
        (
            MetricKind::CompressionRatio,
            "compression.ratio",
            "distribution",
            0.25,
        ),
        (
            MetricKind::CompressionDuration,
            "compression.duration",
            "distribution",
            0.25,
        ),
    ];
    for (kind, suffix, method, value) in cases {
        observer.observe(&metric_test_event(kind));
        let got = events.lock().last().cloned().expect("recorded");
        assert_eq!(got.name, format!("app.cache.{suffix}"), "{kind:?}");
        assert_eq!(got.method, method, "{kind:?}");
        assert_eq!(got.value, value, "{kind:?}");
        assert_eq!(metric_suffix(kind), suffix);
        assert_eq!(observer.metric_name(kind), got.name);
        // Every tag is one of the kind's declared labels: no logical key or
        // identity ever reaches a metric.
        let names: Vec<&str> = got.tags.iter().map(|(name, _)| name.as_str()).collect();
        assert_eq!(names, kind.label_names(), "{kind:?}");
    }
    let recorded = events.lock().clone();
    assert_eq!(
        recorded[3].tags,
        tags(&[
            ("cache_namespace", "logical"),
            ("use_case", "lookup"),
            ("key_type", "item"),
            ("layer", "remote"),
            ("error", "fallback"),
            ("in_fallback", "true"),
        ]),
        "error tags"
    );
    assert_eq!(
        recorded[4].tags,
        tags(&[
            ("cache_namespace", "logical"),
            ("key_type", "item"),
            ("layer", "remote"),
        ]),
        "invalidation acquired use_case"
    );
    assert_eq!(
        recorded[5].tags,
        tags(&[
            ("cache_namespace", "logical"),
            ("use_case", "lookup"),
            ("key_type", "item"),
            ("scope", "process"),
        ]),
        "coalescing labels changed"
    );
    assert!(
        !recorded[6].tags.iter().any(|(name, _)| name == "layer"),
        "shadow acquired layer"
    );
    assert_eq!(
        recorded[6]
            .tags
            .last()
            .map(|(k, v)| (k.as_str(), v.as_str())),
        Some(("outcome", "mismatch"))
    );

    let (client, events) = recording();
    let histogram = DatadogObserver::new(
        client,
        DatadogOptions::new(ObservationMetricType::Histogram),
    )
    .expect("default namespace");
    histogram.observe(&metric_test_event(MetricKind::Get));
    let got = events.lock().last().cloned().expect("recorded");
    assert_eq!(got.method, "histogram", "histogram option ignored");
    assert_eq!(got.name, "dialcache.get.duration", "default namespace");
}

#[test]
fn datadog_rejects_invalid_namespaces_and_long_names() {
    for namespace in ["1bad", "has-dash", "two..dots", ".lead", "trail."] {
        let error = DatadogObserver::new(
            RecordingClient::default(),
            DatadogOptions::new(ObservationMetricType::Distribution).namespace(namespace),
        )
        .err()
        .unwrap_or_else(|| panic!("accepted namespace {namespace:?}"));
        assert_eq!(error, DatadogError::InvalidNamespace(namespace.to_string()));
    }
    let explicitly_empty = DatadogObserver::new(
        RecordingClient::default(),
        DatadogOptions::new(ObservationMetricType::Distribution).namespace(""),
    );
    assert_eq!(
        explicitly_empty.err(),
        Some(DatadogError::InvalidNamespace(String::new())),
        "accepted explicitly empty namespace"
    );
    // The longest suffix, "stale_recovery.value_age", is 24 characters; with
    // the dot a 175-character namespace reaches exactly 200 and 176 exceeds it.
    let longest = "stale_recovery.value_age";
    assert_eq!(longest.len(), 24);
    let fits = "a".repeat(175);
    DatadogObserver::new(
        RecordingClient::default(),
        DatadogOptions::new(ObservationMetricType::Distribution).namespace(fits.clone()),
    )
    .expect("200-character name fits");
    let overflow = "a".repeat(176);
    let error = DatadogObserver::new(
        RecordingClient::default(),
        DatadogOptions::new(ObservationMetricType::Distribution).namespace(overflow.clone()),
    )
    .expect_err("201-character name rejected");
    assert_eq!(
        error,
        DatadogError::MetricNameTooLong(format!("{overflow}.{longest}"))
    );
    let huge = "a".repeat(201);
    assert!(DatadogObserver::new(
        RecordingClient::default(),
        DatadogOptions::new(ObservationMetricType::Distribution).namespace(huge),
    )
    .is_err());
}

#[cfg(feature = "prometheus")]
mod prometheus_exporter {
    use super::*;
    use dialcache::prometheus::{schemas, CollectorSchema};
    use dialcache::{PrometheusError, PrometheusObserver};
    use prometheus::proto::MetricType;
    use prometheus::{Gauge, IntCounterVec, Opts, Registry};

    struct Expected {
        kind: &'static str,
        name: &'static str,
        help: &'static str,
        labels: &'static [&'static str],
        buckets: &'static [f64],
    }

    const TIMER: &[f64] = &[
        0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 2.5, 5.0, 10.0,
    ];
    const SIZE: &[f64] = &[100.0, 1000.0, 10000.0, 100000.0, 1000000.0, 10000000.0];
    const AGE: &[f64] = &[
        1.0, 5.0, 15.0, 60.0, 300.0, 900.0, 3600.0, 10800.0, 43200.0, 86400.0, 259200.0, 604800.0,
    ];
    const LAYER: &[&str] = &["cache_namespace", "use_case", "key_type", "layer"];
    const OUTCOME: &[&str] = &["cache_namespace", "use_case", "key_type", "outcome"];

    /// Copied from go/metrics_prometheus.go PrometheusCollectorSchemas, in order.
    const EXPECTED: [Expected; 19] = [
        Expected {
            kind: "disabled",
            name: "dialcache_disabled_counter",
            help: "Requests where DialCache skipped a cache layer.",
            labels: &["cache_namespace", "use_case", "key_type", "layer", "reason"],
            buckets: &[],
        },
        Expected {
            kind: "miss",
            name: "dialcache_miss_counter",
            help: "DialCache cache misses.",
            labels: &["cache_namespace", "use_case", "key_type", "layer", "reason"],
            buckets: &[],
        },
        Expected {
            kind: "request",
            name: "dialcache_request_counter",
            help: "Total DialCache cache-layer requests.",
            labels: LAYER,
            buckets: &[],
        },
        Expected {
            kind: "error",
            name: "dialcache_error_counter",
            help: "Errors during DialCache cache operations or fallback execution.",
            labels: &[
                "cache_namespace",
                "use_case",
                "key_type",
                "layer",
                "error",
                "in_fallback",
            ],
            buckets: &[],
        },
        Expected {
            kind: "invalidation",
            name: "dialcache_invalidation_counter",
            help: "DialCache invalidation calls by key type and layer.",
            labels: &["cache_namespace", "key_type", "layer"],
            buckets: &[],
        },
        Expected {
            kind: "coalesced",
            name: "dialcache_coalesced_counter",
            help: "DialCache requests coalesced onto in-flight work by sharing scope.",
            labels: &["cache_namespace", "use_case", "key_type", "scope"],
            buckets: &[],
        },
        Expected {
            kind: "shadowValidation",
            name: "dialcache_shadow_validation_counter",
            help: "Sampled DialCache Redis shadow-validation outcomes.",
            labels: OUTCOME,
            buckets: &[],
        },
        Expected {
            kind: "shadowValueAge",
            name: "dialcache_shadow_value_age_histogram",
            help: "Age in seconds of the validated Redis value at DialCache shadow verdict time.",
            labels: OUTCOME,
            buckets: AGE,
        },
        Expected {
            kind: "futureTimestampOffset",
            name: "dialcache_future_timestamp_offset_histogram",
            help: "Positive offset in seconds of Redis frames dated after the observing DialCache process clock.",
            labels: LAYER,
            buckets: &[
                0.001, 0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1.0, 5.0, 15.0, 60.0, 300.0,
                900.0, 3600.0, 10800.0, 43200.0,
            ],
        },
        Expected {
            kind: "staleRecovery",
            name: "dialcache_stale_recovery_counter",
            help: "DialCache stale-on-error Redis recovery outcomes.",
            labels: OUTCOME,
            buckets: &[],
        },
        Expected {
            kind: "staleRecoveryValueAge",
            name: "dialcache_stale_recovery_value_age_histogram",
            help: "Age in seconds of Redis values served by DialCache stale-on-error recovery.",
            labels: OUTCOME,
            buckets: AGE,
        },
        Expected {
            kind: "compression",
            name: "dialcache_compression_counter",
            help: "DialCache Redis payload compression and decompression outcomes.",
            labels: &["cache_namespace", "use_case", "key_type", "layer", "outcome"],
            buckets: &[],
        },
        Expected {
            kind: "get",
            name: "dialcache_get_timer",
            help: "DialCache cache get latency in seconds.",
            labels: LAYER,
            buckets: TIMER,
        },
        Expected {
            kind: "fallback",
            name: "dialcache_fallback_timer",
            help: "Time DialCache waited for the fallback function in seconds.",
            labels: LAYER,
            buckets: TIMER,
        },
        Expected {
            kind: "serialization",
            name: "dialcache_serialization_timer",
            help: "DialCache serialization latency in seconds.",
            labels: &["cache_namespace", "use_case", "key_type", "layer", "operation"],
            buckets: TIMER,
        },
        Expected {
            kind: "size",
            name: "dialcache_size_histogram",
            help: "Serialized DialCache value sizes in bytes.",
            labels: LAYER,
            buckets: SIZE,
        },
        Expected {
            kind: "storedSize",
            name: "dialcache_stored_size_histogram",
            help: "Stored DialCache payload sizes in bytes, after compression and escaping.",
            labels: LAYER,
            buckets: SIZE,
        },
        Expected {
            kind: "compressionRatio",
            name: "dialcache_compression_ratio_histogram",
            help: "Compressed-to-original DialCache payload size ratio for compressed writes.",
            labels: LAYER,
            buckets: &[0.05, 0.1, 0.2, 0.3, 0.5, 0.7, 0.9, 1.0],
        },
        Expected {
            kind: "compressionDuration",
            name: "dialcache_compression_timer",
            help: "DialCache payload compression and decompression latency in seconds.",
            labels: &["cache_namespace", "use_case", "key_type", "layer", "operation"],
            buckets: TIMER,
        },
    ];

    /// Port of TestPrometheusWireSchemaMatchesTypeScriptBinding against the
    /// Go table, which that Go test pins to src/prometheus.ts.
    #[test]
    fn wire_schema_matches_the_reference_table() {
        for prefix in ["", "svc_"] {
            let actual: Vec<CollectorSchema> = schemas(prefix);
            assert_eq!(actual.len(), 19);
            for (schema, expected) in actual.iter().zip(EXPECTED.iter()) {
                assert_eq!(schema.kind.as_str(), expected.kind);
                assert_eq!(schema.name, format!("{prefix}{}", expected.name));
                assert_eq!(schema.help, expected.help, "{} help drift", expected.name);
                assert_eq!(
                    schema.labels, expected.labels,
                    "{} label order drift",
                    expected.name
                );
                assert_eq!(
                    schema.buckets, expected.buckets,
                    "{} buckets drift",
                    expected.name
                );
                assert_eq!(schema.is_counter(), expected.buckets.is_empty());
            }
        }
        let registry = Registry::new();
        let observer = PrometheusObserver::new(&registry, "svc_").expect("fresh registry");
        assert!(observer.observes_shadow_outcomes());
        assert_eq!(observer.schemas(), schemas("svc_"));
    }

    /// The registered collectors expose the schema on a scrape: every kind
    /// produces one family with the schema's name, help, type, label names
    /// and bucket bounds.
    #[test]
    fn scrape_exposes_names_help_labels_and_buckets() {
        let registry = Registry::new();
        let observer = PrometheusObserver::new(&registry, "scrape_").expect("fresh registry");
        for kind in MetricKind::ALL {
            observer.observe(&metric_test_event(kind));
        }
        let families = registry.gather();
        assert_eq!(families.len(), 19);
        for expected in EXPECTED.iter() {
            let name = format!("scrape_{}", expected.name);
            let family = families
                .iter()
                .find(|f| f.name() == name)
                .unwrap_or_else(|| panic!("{name} not scraped"));
            assert_eq!(family.help(), expected.help);
            let metric = &family.get_metric()[0];
            // The exposition sorts label pairs by name; wire order is pinned
            // by the schema test above.
            let mut label_names: Vec<&str> = metric.get_label().iter().map(|l| l.name()).collect();
            label_names.sort_unstable();
            let mut expected_labels = expected.labels.to_vec();
            expected_labels.sort_unstable();
            assert_eq!(label_names, expected_labels, "{name}");
            if expected.buckets.is_empty() {
                assert_eq!(family.type_(), MetricType::COUNTER, "{name}");
                assert_eq!(metric.get_counter().value(), 1.0, "{name}");
            } else {
                assert_eq!(family.type_(), MetricType::HISTOGRAM, "{name}");
                let histogram = metric.get_histogram();
                let bounds: Vec<f64> = histogram
                    .get_bucket()
                    .iter()
                    .map(|b| b.upper_bound())
                    .collect();
                assert_eq!(bounds, expected.buckets, "{name}");
                assert_eq!(histogram.sample_count(), 1);
            }
        }
    }

    /// Port of TestPrometheusReuseAndConflictIsolation. Rust shares one
    /// observer by cloning it rather than by re-registering the same names.
    #[test]
    fn reuse_and_conflict_isolation() {
        let registry = Registry::new();
        let first = PrometheusObserver::new(&registry, "test_").expect("first");
        let second = first.clone();
        first.observe(&metric_test_event(MetricKind::Request));
        second.observe(&metric_test_event(MetricKind::Request));
        first.observe(&metric_test_event(MetricKind::Get));
        let (mut saw_counter, mut saw_histogram) = (false, false);
        for family in registry.gather() {
            match family.name() {
                "test_dialcache_request_counter" => {
                    saw_counter = true;
                    assert_eq!(
                        family.get_metric()[0].get_counter().value(),
                        2.0,
                        "compatible observer did not reuse counter"
                    );
                }
                "test_dialcache_get_timer" => {
                    saw_histogram = true;
                    let histogram = family.get_metric()[0].get_histogram();
                    assert_eq!(histogram.sample_count(), 1);
                    assert_eq!(histogram.sample_sum(), 0.25);
                    assert_eq!(histogram.get_bucket().len(), 12);
                }
                _ => {}
            }
        }
        assert!(saw_counter && saw_histogram, "metrics not exported");

        // Clones survive dropping the original observer.
        let third = second.clone();
        drop(first);
        drop(second);
        third.observe(&metric_test_event(MetricKind::Request));
        let requests = registry
            .gather()
            .into_iter()
            .find(|f| f.name() == "test_dialcache_request_counter")
            .expect("request family");
        assert_eq!(requests.get_metric()[0].get_counter().value(), 3.0);

        // A second registration of the same names is a conflict that leaves
        // the registry, and the shared series, untouched.
        let duplicate = PrometheusObserver::new(&registry, "test_")
            .expect_err("re-registered the same collectors");
        match &duplicate {
            PrometheusError::Conflict { name, .. } => {
                assert_eq!(name, "test_dialcache_disabled_counter")
            }
            other => panic!("unexpected error {other}"),
        }
        third.observe(&metric_test_event(MetricKind::Request));
        let requests = registry
            .gather()
            .into_iter()
            .find(|f| f.name() == "test_dialcache_request_counter")
            .expect("request family");
        assert_eq!(requests.get_metric()[0].get_counter().value(), 4.0);

        // Another prefix on the same registry is an independent group.
        let other = PrometheusObserver::new(&registry, "other_").expect("other prefix");
        other.observe(&metric_test_event(MetricKind::Request));
        let names: Vec<String> = registry
            .gather()
            .iter()
            .map(|f| f.name().to_string())
            .collect();
        assert!(names.contains(&"other_dialcache_request_counter".to_string()));
        assert!(names.contains(&"test_dialcache_request_counter".to_string()));

        let conflict = Registry::new();
        conflict
            .register(Box::new(
                Gauge::new("dialcache_request_counter", "incompatible").expect("gauge"),
            ))
            .expect("gauge registered");
        let error =
            PrometheusObserver::new(&conflict, "").expect_err("accepted conflicting collector");
        match &error {
            PrometheusError::Conflict { name, .. } => {
                assert_eq!(name, "dialcache_request_counter")
            }
            other => panic!("unexpected error {other}"),
        }
        assert!(error.to_string().contains("unique prefix or registry"));
        // Only the gauge has an observed series...
        assert_eq!(
            conflict.gather().len(),
            1,
            "failed observer partially registered collectors"
        );
        // ...and the collectors registered before the conflict were rolled
        // back (the name stays bound to the DialCache schema, so only that
        // schema can reuse it)
        // back, so their names are free again.
        let disabled = schemas("")
            .into_iter()
            .find(|s| s.kind == MetricKind::Disabled)
            .expect("disabled schema");
        conflict
            .register(Box::new(
                IntCounterVec::new(Opts::new(disabled.name, disabled.help), disabled.labels)
                    .expect("counter"),
            ))
            .expect("rolled-back collector name is free");
    }
}

mod isolation {
    use super::*;
    use dialcache::testing::{TestExecutor, WALL_EPOCH_MS};
    use dialcache::{DialCache, KeySpec, Policy};
    use std::sync::atomic::{AtomicUsize, Ordering};

    struct PanickingObserver {
        calls: Arc<AtomicUsize>,
    }

    impl Observer for PanickingObserver {
        fn observe(&self, _event: &Event) {
            self.calls.fetch_add(1, Ordering::SeqCst);
            panic!("exporter failure");
        }
        fn observes_shadow_outcomes(&self) -> bool {
            panic!("exporter failure");
        }
    }

    /// A panicking observer never changes the result of a cached call.
    #[test]
    fn panicking_observer_does_not_change_cached_results() {
        let calls = Arc::new(AtomicUsize::new(0));
        let mut exec = TestExecutor::new(WALL_EPOCH_MS);
        let cache = DialCache::builder()
            .clock_arc(exec.clock.clone())
            .runtime_arc(exec.runtime.clone())
            .observer(PanickingObserver {
                calls: calls.clone(),
            })
            .build()
            .expect("configuration");
        let source_calls = Arc::new(AtomicUsize::new(0));
        let counting = source_calls.clone();
        let lookup = cache
            .use_case::<i64, i64>("item", "lookup")
            .policy(Policy::default().local_ttl_sec(60))
            .key(|id: &i64| KeySpec::new(id.to_string()))
            .source(move |_scope, id: i64| {
                let counting = counting.clone();
                async move {
                    counting.fetch_add(1, Ordering::SeqCst);
                    Ok(id * 10)
                }
            })
            .register()
            .expect("use case");

        let first = {
            let cache = cache.clone();
            let lookup = lookup.clone();
            exec.block_on(async move {
                cache
                    .enable(|scope| async move { lookup.get(&scope, 7).await })
                    .await
            })
        };
        assert_eq!(*first.expect("source value survives observer panic"), 70);
        let second = {
            let cache = cache.clone();
            let lookup = lookup.clone();
            exec.block_on(async move {
                cache
                    .enable(|scope| async move { lookup.get(&scope, 7).await })
                    .await
            })
        };
        assert_eq!(*second.expect("cached value survives observer panic"), 70);
        assert_eq!(
            source_calls.load(Ordering::SeqCst),
            1,
            "second call was served from the local layer"
        );
        assert!(
            calls.load(Ordering::SeqCst) >= 2,
            "the observer received the request events"
        );
    }
}
