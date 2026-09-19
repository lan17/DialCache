//! The shared event-to-metric mapping of the bundled exporters.
//!
//! Every [`Event`] maps to exactly one [`MetricKind`]: a counter or an
//! observation (timer, age, size, ratio). The kind fixes the metric's label
//! set and value so the Prometheus and Datadog exporters, and the TypeScript
//! and Go ports, publish the same wire contract. Logical cache keys never
//! appear here: labels are bounded enumerations plus the namespace, use case
//! and key type.

use crate::observe::Event;

/// The metric an [`Event`] feeds. Variant names match the TypeScript adapter
/// method names and the Go `metricKinds` table.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum MetricKind {
    Request,
    Miss,
    Disabled,
    Error,
    Invalidation,
    Coalesced,
    ShadowValidation,
    ShadowValueAge,
    FutureTimestampOffset,
    StaleRecovery,
    StaleRecoveryValueAge,
    Compression,
    Get,
    Fallback,
    Serialization,
    Size,
    StoredSize,
    CompressionRatio,
    CompressionDuration,
}

/// The base label names every layer-scoped metric starts with.
const LABEL_CACHE_NAMESPACE: &str = "cache_namespace";
const LABEL_USE_CASE: &str = "use_case";
const LABEL_KEY_TYPE: &str = "key_type";

impl MetricKind {
    /// Every kind, in declaration order.
    pub const ALL: [MetricKind; 19] = [
        MetricKind::Request,
        MetricKind::Miss,
        MetricKind::Disabled,
        MetricKind::Error,
        MetricKind::Invalidation,
        MetricKind::Coalesced,
        MetricKind::ShadowValidation,
        MetricKind::ShadowValueAge,
        MetricKind::FutureTimestampOffset,
        MetricKind::StaleRecovery,
        MetricKind::StaleRecoveryValueAge,
        MetricKind::Compression,
        MetricKind::Get,
        MetricKind::Fallback,
        MetricKind::Serialization,
        MetricKind::Size,
        MetricKind::StoredSize,
        MetricKind::CompressionRatio,
        MetricKind::CompressionDuration,
    ];

    /// The metric an event feeds.
    pub fn of(event: &Event) -> MetricKind {
        match event {
            Event::Request { .. } => MetricKind::Request,
            Event::Miss { .. } => MetricKind::Miss,
            Event::Disabled { .. } => MetricKind::Disabled,
            Event::Error { .. } => MetricKind::Error,
            Event::Invalidation { .. } => MetricKind::Invalidation,
            Event::Coalesced { .. } => MetricKind::Coalesced,
            Event::ShadowValidation { .. } => MetricKind::ShadowValidation,
            Event::ShadowValueAge { .. } => MetricKind::ShadowValueAge,
            Event::FutureTimestampOffset { .. } => MetricKind::FutureTimestampOffset,
            Event::StaleRecovery { .. } => MetricKind::StaleRecovery,
            Event::StaleRecoveryValueAge { .. } => MetricKind::StaleRecoveryValueAge,
            Event::Compression { .. } => MetricKind::Compression,
            Event::Get { .. } => MetricKind::Get,
            Event::Fallback { .. } => MetricKind::Fallback,
            Event::Serialization { .. } => MetricKind::Serialization,
            Event::Size { .. } => MetricKind::Size,
            Event::StoredSize { .. } => MetricKind::StoredSize,
            Event::CompressionRatio { .. } => MetricKind::CompressionRatio,
            Event::CompressionDuration { .. } => MetricKind::CompressionDuration,
        }
    }

    /// The kind's name in the TypeScript adapter and the Go `metricKinds` table.
    pub fn as_str(self) -> &'static str {
        match self {
            MetricKind::Request => "request",
            MetricKind::Miss => "miss",
            MetricKind::Disabled => "disabled",
            MetricKind::Error => "error",
            MetricKind::Invalidation => "invalidation",
            MetricKind::Coalesced => "coalesced",
            MetricKind::ShadowValidation => "shadowValidation",
            MetricKind::ShadowValueAge => "shadowValueAge",
            MetricKind::FutureTimestampOffset => "futureTimestampOffset",
            MetricKind::StaleRecovery => "staleRecovery",
            MetricKind::StaleRecoveryValueAge => "staleRecoveryValueAge",
            MetricKind::Compression => "compression",
            MetricKind::Get => "get",
            MetricKind::Fallback => "fallback",
            MetricKind::Serialization => "serialization",
            MetricKind::Size => "size",
            MetricKind::StoredSize => "storedSize",
            MetricKind::CompressionRatio => "compressionRatio",
            MetricKind::CompressionDuration => "compressionDuration",
        }
    }

    /// Counters increment by one per event; every other kind records
    /// [`value`](Self::value).
    pub fn is_counter(self) -> bool {
        matches!(
            self,
            MetricKind::Request
                | MetricKind::Miss
                | MetricKind::Disabled
                | MetricKind::Error
                | MetricKind::Invalidation
                | MetricKind::Coalesced
                | MetricKind::ShadowValidation
                | MetricKind::StaleRecovery
                | MetricKind::Compression
        )
    }

    /// Position of the kind in [`ALL`](Self::ALL).
    pub fn index(self) -> usize {
        self as usize
    }

    /// The label names of this kind, in wire order: the Prometheus label
    /// schema and the Datadog tag set of the TypeScript adapters.
    pub fn label_names(self) -> &'static [&'static str] {
        const BASE: &[&str] = &[
            LABEL_CACHE_NAMESPACE,
            LABEL_USE_CASE,
            LABEL_KEY_TYPE,
            "layer",
        ];
        const OUTCOME: &[&str] = &[
            LABEL_CACHE_NAMESPACE,
            LABEL_USE_CASE,
            LABEL_KEY_TYPE,
            "outcome",
        ];
        match self {
            MetricKind::Request
            | MetricKind::FutureTimestampOffset
            | MetricKind::Get
            | MetricKind::Fallback
            | MetricKind::Size
            | MetricKind::StoredSize
            | MetricKind::CompressionRatio => BASE,
            MetricKind::Miss | MetricKind::Disabled => &[
                LABEL_CACHE_NAMESPACE,
                LABEL_USE_CASE,
                LABEL_KEY_TYPE,
                "layer",
                "reason",
            ],
            MetricKind::Error => &[
                LABEL_CACHE_NAMESPACE,
                LABEL_USE_CASE,
                LABEL_KEY_TYPE,
                "layer",
                "error",
                "in_fallback",
            ],
            MetricKind::Invalidation => &[LABEL_CACHE_NAMESPACE, LABEL_KEY_TYPE, "layer"],
            MetricKind::Coalesced => &[
                LABEL_CACHE_NAMESPACE,
                LABEL_USE_CASE,
                LABEL_KEY_TYPE,
                "scope",
            ],
            MetricKind::ShadowValidation
            | MetricKind::ShadowValueAge
            | MetricKind::StaleRecovery
            | MetricKind::StaleRecoveryValueAge => OUTCOME,
            MetricKind::Compression => &[
                LABEL_CACHE_NAMESPACE,
                LABEL_USE_CASE,
                LABEL_KEY_TYPE,
                "layer",
                "outcome",
            ],
            MetricKind::Serialization | MetricKind::CompressionDuration => &[
                LABEL_CACHE_NAMESPACE,
                LABEL_USE_CASE,
                LABEL_KEY_TYPE,
                "layer",
                "operation",
            ],
        }
    }

    /// The labels of an event, in the order of [`label_names`](Self::label_names)
    /// for [`of(event)`](Self::of). Values are bounded enumerations plus the
    /// namespace, use case and key type; the logical key is never one.
    pub fn labels(event: &Event) -> Vec<(&'static str, String)> {
        let mut labels: Vec<(&'static str, String)> = Vec::with_capacity(6);
        match event {
            Event::Invalidation {
                namespace,
                key_type,
                layer,
            } => {
                labels.push((LABEL_CACHE_NAMESPACE, namespace.to_string()));
                labels.push((LABEL_KEY_TYPE, key_type.to_string()));
                labels.push(("layer", layer.as_str().to_string()));
            }
            Event::Coalesced {
                labels: outcome,
                scope,
            } => {
                push_outcome_base(&mut labels, outcome);
                labels.push(("scope", scope.as_str().to_string()));
            }
            Event::ShadowValidation {
                labels: outcome,
                outcome: verdict,
            }
            | Event::ShadowValueAge {
                labels: outcome,
                outcome: verdict,
                ..
            } => {
                push_outcome_base(&mut labels, outcome);
                labels.push(("outcome", verdict.as_str().to_string()));
            }
            Event::StaleRecovery {
                labels: outcome,
                outcome: verdict,
            }
            | Event::StaleRecoveryValueAge {
                labels: outcome,
                outcome: verdict,
                ..
            } => {
                push_outcome_base(&mut labels, outcome);
                labels.push(("outcome", verdict.as_str().to_string()));
            }
            Event::Request { labels: base }
            | Event::FutureTimestampOffset { labels: base, .. }
            | Event::Get { labels: base, .. }
            | Event::Fallback { labels: base, .. }
            | Event::Size { labels: base, .. }
            | Event::StoredSize { labels: base, .. }
            | Event::CompressionRatio { labels: base, .. } => push_layer_base(&mut labels, base),
            Event::Miss {
                labels: base,
                reason,
            } => {
                push_layer_base(&mut labels, base);
                labels.push(("reason", reason.as_str().to_string()));
            }
            Event::Disabled {
                labels: base,
                reason,
            } => {
                push_layer_base(&mut labels, base);
                labels.push(("reason", reason.as_str().to_string()));
            }
            Event::Error {
                labels: base,
                error,
                in_fallback,
            } => {
                push_layer_base(&mut labels, base);
                labels.push(("error", error.as_str().to_string()));
                labels.push(("in_fallback", in_fallback.to_string()));
            }
            Event::Compression {
                labels: base,
                outcome,
            } => {
                push_layer_base(&mut labels, base);
                labels.push(("outcome", outcome.as_str().to_string()));
            }
            Event::Serialization {
                labels: base,
                operation,
                ..
            } => {
                push_layer_base(&mut labels, base);
                labels.push(("operation", operation.as_str().to_string()));
            }
            Event::CompressionDuration {
                labels: base,
                operation,
                ..
            } => {
                push_layer_base(&mut labels, base);
                labels.push(("operation", operation.as_str().to_string()));
            }
        }
        labels
    }

    /// The value an event records: seconds for timers, ages and offsets,
    /// bytes for sizes, the compressed-to-original ratio for
    /// [`CompressionRatio`](Self::CompressionRatio), and the increment `1`
    /// for counters.
    pub fn value(event: &Event) -> f64 {
        match event {
            Event::ShadowValueAge { seconds, .. }
            | Event::FutureTimestampOffset { seconds, .. }
            | Event::StaleRecoveryValueAge { seconds, .. }
            | Event::Get { seconds, .. }
            | Event::Fallback { seconds, .. }
            | Event::Serialization { seconds, .. }
            | Event::CompressionDuration { seconds, .. } => *seconds,
            Event::Size { bytes, .. } | Event::StoredSize { bytes, .. } => *bytes as f64,
            Event::CompressionRatio { ratio, .. } => *ratio,
            Event::Request { .. }
            | Event::Miss { .. }
            | Event::Disabled { .. }
            | Event::Error { .. }
            | Event::Invalidation { .. }
            | Event::Coalesced { .. }
            | Event::ShadowValidation { .. }
            | Event::StaleRecovery { .. }
            | Event::Compression { .. } => 1.0,
        }
    }
}

fn push_layer_base(labels: &mut Vec<(&'static str, String)>, base: &crate::observe::Labels) {
    labels.push((LABEL_CACHE_NAMESPACE, base.namespace.to_string()));
    labels.push((LABEL_USE_CASE, base.use_case.to_string()));
    labels.push((LABEL_KEY_TYPE, base.key_type.to_string()));
    labels.push(("layer", base.layer.as_str().to_string()));
}

fn push_outcome_base(
    labels: &mut Vec<(&'static str, String)>,
    base: &crate::observe::OutcomeLabels,
) {
    labels.push((LABEL_CACHE_NAMESPACE, base.namespace.to_string()));
    labels.push((LABEL_USE_CASE, base.use_case.to_string()));
    labels.push((LABEL_KEY_TYPE, base.key_type.to_string()));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::observe::{
        CoalescingScope, CompressionOperation, CompressionOutcome, DisabledReason, ErrorKind,
        Labels, Layer, MissReason, OutcomeLabels, RecoveryOutcome, SerializationOperation,
        ShadowOutcome,
    };
    use std::sync::Arc;

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

    /// One event per kind with fixed, recognizable field values.
    pub(crate) fn event_of(kind: MetricKind) -> Event {
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

    #[test]
    fn every_kind_round_trips_through_of_and_index() {
        for (index, kind) in MetricKind::ALL.iter().enumerate() {
            assert_eq!(MetricKind::of(&event_of(*kind)), *kind);
            assert_eq!(kind.index(), index);
        }
        let names: std::collections::HashSet<&str> =
            MetricKind::ALL.iter().map(|k| k.as_str()).collect();
        assert_eq!(names.len(), 19);
    }

    #[test]
    fn label_values_follow_the_declared_label_names() {
        for kind in MetricKind::ALL {
            let labels = MetricKind::labels(&event_of(kind));
            let names: Vec<&str> = labels.iter().map(|(name, _)| *name).collect();
            assert_eq!(names, kind.label_names(), "{}", kind.as_str());
        }
    }

    #[test]
    fn labels_derive_as_the_go_port_does() {
        let pairs = |kind: MetricKind| -> Vec<(String, String)> {
            MetricKind::labels(&event_of(kind))
                .into_iter()
                .map(|(k, v)| (k.to_string(), v))
                .collect()
        };
        let owned = |items: &[(&str, &str)]| -> Vec<(String, String)> {
            items
                .iter()
                .map(|(k, v)| (k.to_string(), v.to_string()))
                .collect()
        };
        assert_eq!(
            pairs(MetricKind::Error),
            owned(&[
                ("cache_namespace", "logical"),
                ("use_case", "lookup"),
                ("key_type", "item"),
                ("layer", "remote"),
                ("error", "fallback"),
                ("in_fallback", "true"),
            ])
        );
        assert_eq!(
            pairs(MetricKind::Invalidation),
            owned(&[
                ("cache_namespace", "logical"),
                ("key_type", "item"),
                ("layer", "remote"),
            ])
        );
        assert_eq!(
            pairs(MetricKind::Coalesced),
            owned(&[
                ("cache_namespace", "logical"),
                ("use_case", "lookup"),
                ("key_type", "item"),
                ("scope", "process"),
            ])
        );
        assert_eq!(
            pairs(MetricKind::ShadowValidation),
            owned(&[
                ("cache_namespace", "logical"),
                ("use_case", "lookup"),
                ("key_type", "item"),
                ("outcome", "mismatch"),
            ])
        );
        assert_eq!(
            pairs(MetricKind::Miss),
            owned(&[
                ("cache_namespace", "logical"),
                ("use_case", "lookup"),
                ("key_type", "item"),
                ("layer", "remote"),
                ("reason", "expired"),
            ])
        );
        assert_eq!(
            pairs(MetricKind::Disabled).last().unwrap(),
            &("reason".to_string(), "ramped_down".to_string())
        );
        assert_eq!(
            pairs(MetricKind::Compression).last().unwrap(),
            &("outcome".to_string(), "compressed".to_string())
        );
        assert_eq!(
            pairs(MetricKind::Serialization).last().unwrap(),
            &("operation".to_string(), "dump".to_string())
        );
        assert_eq!(
            pairs(MetricKind::CompressionDuration).last().unwrap(),
            &("operation".to_string(), "compress".to_string())
        );
        let in_fallback_false = Event::Error {
            labels: base(),
            error: ErrorKind::CacheRead,
            in_fallback: false,
        };
        assert_eq!(
            MetricKind::labels(&in_fallback_false).last().unwrap().1,
            "false"
        );
    }

    #[test]
    fn values_carry_the_documented_units() {
        for kind in MetricKind::ALL {
            let value = MetricKind::value(&event_of(kind));
            let expected = match kind {
                MetricKind::Size | MetricKind::StoredSize => 123.0,
                _ if kind.is_counter() => 1.0,
                _ => 0.25,
            };
            assert_eq!(value, expected, "{}", kind.as_str());
        }
        let counters: Vec<&str> = MetricKind::ALL
            .iter()
            .filter(|k| k.is_counter())
            .map(|k| k.as_str())
            .collect();
        assert_eq!(
            counters,
            [
                "request",
                "miss",
                "disabled",
                "error",
                "invalidation",
                "coalesced",
                "shadowValidation",
                "staleRecovery",
                "compression",
            ]
        );
    }
}
