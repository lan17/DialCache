use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use dialcache::{BoxError, DialCache, Event, KeySpec, Observer, Policy, Scope};
use futures::future::try_join_all;
use tokio::sync::Notify;

use crate::{elapsed_ns, empty_commands, Counters, Measurement, Request, Source};

#[derive(Default)]
struct Followers {
    joined: AtomicU64,
    target: AtomicU64,
    changed: Notify,
}

impl Observer for Followers {
    fn observe(&self, event: &Event) {
        if matches!(event, Event::Coalesced { .. }) {
            self.joined.fetch_add(1, Ordering::Relaxed);
            self.changed.notify_one();
        }
    }
}

impl Followers {
    async fn wait(&self) -> Result<(), BoxError> {
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                let notified = self.changed.notified();
                if self.joined.load(Ordering::Relaxed) >= self.target.load(Ordering::Relaxed) {
                    break;
                }
                notified.await;
            }
        })
        .await
        .map_err(|_| "coalescing source did not observe every follower joining".into())
    }
}

pub async fn phase(request: &Request, iterations: usize) -> Result<Measurement, BoxError> {
    let case = &request.case;
    let kind = case.kind.as_str();
    let source = Arc::new(Source::new(&request.payload));
    if kind == "source-baseline" {
        let mut values = Vec::with_capacity(iterations);
        let mut checksum = 0;
        let started = Instant::now();
        for _ in 0..iterations {
            let value = source.load().await;
            checksum += value.len() as u64;
            values.push(value);
        }
        let elapsed_ns = elapsed_ns(started);
        return Ok(Measurement {
            operations: iterations as u64,
            elapsed_ns,
            checksum,
            value_valid: values.iter().all(|value| value == &request.payload),
            counters: Counters {
                source_calls: source.calls(),
                ..Counters::default()
            },
            redis_commands: empty_commands(),
            latency_ns: Vec::new(),
        });
    }

    let gate = kind
        .ends_with("-coalescing")
        .then(|| Arc::new(Followers::default()));
    let mut builder = DialCache::builder()
        .namespace("urn")
        .local_capacity(case.capacity)
        .disable_compression();
    if let Some(gate) = &gate {
        builder = builder.observer_arc(gate.clone());
    }
    let cache = builder.build()?;
    let policy = match kind {
        "disabled" | "request-local-hit" | "request-coalescing" => {
            Policy::default().request_local(true)
        }
        "process-local-hit" | "local-eviction" | "process-coalescing" => {
            Policy::default().local_ttl_sec(3600)
        }
        "enabled-uncached" => Policy::default(),
        _ => return Err(format!("unknown core case: {kind}").into()),
    };
    let captured_source = source.clone();
    let captured_gate = gate.clone();
    let operation = cache
        .use_case::<String, String>("benchmark-key", "Benchmark")
        .policy(policy)
        .key(|key: &String| KeySpec::new(key))
        .source(move |_scope, _key| {
            let source = captured_source.clone();
            let gate = captured_gate.clone();
            async move {
                let value = source.load().await;
                if let Some(gate) = gate {
                    gate.wait().await?;
                }
                Ok(value)
            }
        })
        .register()?;
    let keys: Vec<String> = (0..iterations)
        .map(|index| format!("key-{index}"))
        .collect();
    let prefill_keys: Vec<String> = (0..case.capacity)
        .map(|index| format!("prefill-{index}"))
        .collect();
    let shared_key = "shared".to_owned();
    let single_scope = (case.scope == "single").then(|| cache.enable_guard());
    if kind == "request-local-hit" {
        let value = operation
            .get(single_scope.as_ref().unwrap().scope(), shared_key.clone())
            .await?;
        if value.as_str() != request.payload {
            return Err("request-local prime returned an invalid value".into());
        }
    } else if kind == "process-local-hit" || kind == "local-eviction" {
        let prime_keys = if kind == "local-eviction" {
            &prefill_keys[..]
        } else {
            std::slice::from_ref(&shared_key)
        };
        for key in prime_keys {
            let scope = cache.enable_guard();
            let value = operation.get(scope.scope(), key.clone()).await?;
            if value.as_str() != request.payload {
                return Err("local prefill returned an invalid value".into());
            }
        }
    }
    if kind == "local-eviction" {
        let calls = source.calls();
        let scope = cache.enable_guard();
        let value = operation
            .get(scope.scope(), prefill_keys.last().unwrap().clone())
            .await?;
        if value.as_str() != request.payload || source.calls() != calls {
            return Err("local prefill was not cached".into());
        }
    }
    source.reset();
    let operations = iterations * case.fanout;
    let mut values = Vec::with_capacity(operations);
    let mut checksum = 0;
    let outside = Scope::outside();
    let started = Instant::now();
    for (index, measured_key) in keys.iter().enumerate() {
        if let Some(gate) = &gate {
            gate.target
                .store(((index + 1) * (case.fanout - 1)) as u64, Ordering::Relaxed);
            let scope = (kind == "request-coalescing").then(|| cache.enable_guard());
            let callers = (0..case.fanout).map(|_| async {
                let individual = (kind == "process-coalescing").then(|| cache.enable_guard());
                let caller_scope = scope.as_ref().or(individual.as_ref()).unwrap();
                operation
                    .get(caller_scope.scope(), measured_key.clone())
                    .await
            });
            let burst = try_join_all(callers).await?;
            for value in burst {
                checksum += value.len() as u64;
                values.push(value);
            }
        } else {
            let individual = (case.scope == "per-operation").then(|| cache.enable_guard());
            let scope = single_scope
                .as_ref()
                .or(individual.as_ref())
                .map_or(&outside, |guard| guard.scope());
            let key = if kind == "local-eviction" {
                measured_key
            } else {
                &shared_key
            };
            let value = operation.get(scope, key.clone()).await?;
            checksum += value.len() as u64;
            values.push(value);
        }
    }
    let elapsed_ns = elapsed_ns(started);
    let source_calls = source.calls();
    if kind == "local-eviction" {
        {
            let scope = cache.enable_guard();
            let value = operation
                .get(scope.scope(), keys.last().unwrap().clone())
                .await?;
            if value.as_str() != request.payload || source.calls() != source_calls {
                return Err("newest measured local entry was not cached".into());
            }
        }
        let scope = cache.enable_guard();
        let value = operation
            .get(scope.scope(), prefill_keys[0].clone())
            .await?;
        if value.as_str() != request.payload || source.calls() != source_calls + 1 {
            return Err("local churn did not evict the oldest prefilled entry".into());
        }
    }
    Ok(Measurement {
        operations: operations as u64,
        elapsed_ns,
        checksum,
        value_valid: values.iter().all(|value| value.as_str() == request.payload),
        counters: Counters {
            source_calls,
            coalesced_calls: gate.map_or(0, |gate| gate.joined.load(Ordering::Relaxed)),
            ..Counters::default()
        },
        redis_commands: empty_commands(),
        latency_ns: Vec::new(),
    })
}
