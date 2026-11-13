//! Opt-in, bounded load checks over a synthetic remote, not a Redis capacity benchmark.
//! Run one case per process with `cargo test --release --test scale_soak -- --ignored --nocapture`.

use std::collections::{HashMap, VecDeque};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::SeqCst};
use std::sync::{Arc, Weak};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use dialcache::observe::{CompressionOutcome, RecoveryOutcome};
use dialcache::protocol::{compress_payload, CompressionConfig};
use dialcache::{
    BoxError, DialCache, Error, Event, Frame, Identity, InvalidateRequest, MissReason, Observer,
    Operation, Payload, Policy, ReadContext, ReadRequest, ReadResult, Remote, Runtime,
    SourceBudget, TokioRuntime, WriteRequest,
};
use futures::future::BoxFuture;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::json;
use tokio::sync::Semaphore;
use tokio::task::JoinSet;
use tokio::time::{sleep, sleep_until, timeout};

const SEED: u64 = 0x5eed1234;
const SOURCE_CAPACITY: usize = 8;
const PROVIDER_CAPACITY: usize = 8;
const REMOTE_CAPACITY: usize = 64;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Case {
    HotHit,
    SpreadHit,
    HotMiss,
    SpreadMiss,
    Compressed,
    Tracked,
    Cancellation,
    Recovery,
    MalformedSmall,
    MalformedLarge,
}

impl Case {
    fn remote(self) -> bool {
        matches!(
            self,
            Self::Compressed
                | Self::Tracked
                | Self::Recovery
                | Self::MalformedSmall
                | Self::MalformedLarge
        )
    }

    fn malformed(self) -> bool {
        matches!(self, Self::MalformedSmall | Self::MalformedLarge)
    }

    fn key(self, random: u64) -> u64 {
        match self {
            Self::HotHit | Self::HotMiss | Self::Recovery => 0,
            Self::SpreadMiss | Self::Cancellation => random % 4096,
            Self::Tracked => random % 16,
            _ => random % 64,
        }
    }
}

struct Settings {
    case: Case,
    workers: usize,
    seconds: u64,
    rate: u64,
    bytes: usize,
}

fn number(name: &str, default: u64, low: u64, high: u64) -> u64 {
    let value = std::env::var(name)
        .map(|text| text.parse().expect("integer setting"))
        .unwrap_or(default);
    assert!(
        (low..=high).contains(&value),
        "{name} outside {low}..={high}"
    );
    value
}

impl Settings {
    fn read() -> Self {
        let case = match std::env::var("DIALCACHE_SOAK_CASE")
            .as_deref()
            .unwrap_or("hot-hit")
        {
            "hot-hit" => Case::HotHit,
            "spread-hit" => Case::SpreadHit,
            "hot-miss" => Case::HotMiss,
            "spread-miss" => Case::SpreadMiss,
            "compressed" => Case::Compressed,
            "tracked" => Case::Tracked,
            "cancellation" => Case::Cancellation,
            "recovery" => Case::Recovery,
            "malformed-small" => Case::MalformedSmall,
            "malformed-large" => Case::MalformedLarge,
            other => panic!("unknown case: {other}"),
        };
        let workers = number("DIALCACHE_SOAK_WORKERS", 4, 1, 4) as usize;
        assert!([1, 2, 4].contains(&workers));
        Self {
            case,
            workers,
            seconds: number("DIALCACHE_SOAK_SECONDS", 10, 6, 1800),
            rate: number(
                "DIALCACHE_SOAK_RATE",
                if case.malformed() { 1 } else { 1000 },
                1,
                if case.malformed() { 2 } else { 20_000 },
            ),
            bytes: number(
                "DIALCACHE_SOAK_BYTES",
                if case == Case::Compressed {
                    256 * 1024
                } else {
                    128
                },
                128,
                1024 * 1024,
            ) as usize,
        }
    }
}

#[derive(Default)]
struct Work {
    started: AtomicU64,
    active: AtomicU64,
    peak: AtomicU64,
    ended: AtomicU64,
}

impl Work {
    fn enter(self: &Arc<Self>) -> Active {
        self.started.fetch_add(1, SeqCst);
        let current = self.active.fetch_add(1, SeqCst) + 1;
        self.peak.fetch_max(current, SeqCst);
        Active(self.clone())
    }

    fn snapshot(&self) -> serde_json::Value {
        json!({
            "started": self.started.load(SeqCst), "active": self.active.load(SeqCst),
            "peak": self.peak.load(SeqCst), "ended": self.ended.load(SeqCst)
        })
    }
}

struct Active(Arc<Work>);

impl Drop for Active {
    fn drop(&mut self) {
        self.0.active.fetch_sub(1, SeqCst);
        self.0.ended.fetch_add(1, SeqCst);
    }
}

#[derive(Default)]
struct Histogram {
    buckets: [u64; 32],
    count: u64,
    max_us: u64,
    overflow: u64,
}

impl Histogram {
    fn record(&mut self, elapsed: Duration) {
        let micros = elapsed.as_micros().min(u64::MAX as u128) as u64;
        let bucket = (64 - micros.saturating_sub(1).leading_zeros()) as usize;
        self.buckets[bucket.min(31)] += 1;
        self.count += 1;
        self.max_us = self.max_us.max(micros);
        self.overflow += u64::from(micros > 1 << 31);
    }

    fn percentile(&self, percent: u64) -> u64 {
        if self.count == 0 {
            return 0;
        }
        let target = (self.count * percent).div_ceil(100);
        let mut found = 0;
        for (index, count) in self.buckets.iter().enumerate() {
            found += count;
            if found >= target {
                return if index == 31 {
                    self.max_us.max(1 << 31)
                } else {
                    1u64 << index
                };
            }
        }
        unreachable!()
    }

    fn snapshot(&self) -> serde_json::Value {
        json!({
            "count": self.count, "p50_upper_us": self.percentile(50),
            "p95_upper_us": self.percentile(95), "p99_upper_us": self.percentile(99),
            "max_us": self.max_us, "buckets_power_of_two_us": self.buckets, "overflow": self.overflow
        })
    }
}

#[derive(Default)]
struct Metrics {
    offered: AtomicU64,
    late: AtomicU64,
    window_closed: AtomicU64,
    rejected: AtomicU64,
    admitted: AtomicU64,
    completed: AtomicU64,
    completed_within_window: AtomicU64,
    successful_within_window: AtomicU64,
    logical_ok: AtomicU64,
    logical_error: AtomicU64,
    logical_deadline: AtomicU64,
    attempts: AtomicU64,
    ok: AtomicU64,
    source_error: AtomicU64,
    cache_timeout: AtomicU64,
    caller_timeout: AtomicU64,
    source_rejected: AtomicU64,
    provider_rejected: AtomicU64,
    source_native_timeout: AtomicU64,
    provider_native_timeout: AtomicU64,
    reads: AtomicU64,
    writes: AtomicU64,
    invalidations: AtomicU64,
    fenced: AtomicU64,
    recovered: AtomicU64,
    decompressed: AtomicU64,
    over_limit: AtomicU64,
    cpu_rejected: AtomicU64,
    source: Arc<Work>,
    provider: Arc<Work>,
    callers: Arc<Work>,
    detached: Arc<Work>,
    cpu: Arc<Work>,
    cpu_running: Arc<Work>,
    remote: Arc<Work>,
    latency: Mutex<Histogram>,
    success_latency: Mutex<Histogram>,
    scheduler_lag: Mutex<Histogram>,
    values: Mutex<VecDeque<Weak<Value>>>,
}

impl Observer for Metrics {
    fn observe(&self, event: &Event) {
        match event {
            Event::StaleRecovery {
                outcome: RecoveryOutcome::Served,
                ..
            } => {
                self.recovered.fetch_add(1, SeqCst);
            }
            Event::Compression {
                outcome: CompressionOutcome::Decompressed,
                ..
            } => {
                self.decompressed.fetch_add(1, SeqCst);
            }
            Event::Compression {
                outcome: CompressionOutcome::ReadOverLimit,
                ..
            } => {
                self.over_limit.fetch_add(1, SeqCst);
            }
            _ => {}
        }
    }
}

impl Metrics {
    fn remember(&self, value: &Arc<Value>) {
        let mut values = self.values.lock();
        if values.len() == 256 {
            values.pop_front();
        }
        values.push_back(Arc::downgrade(value));
    }

    fn snapshot(&self) -> serde_json::Value {
        json!({
            "offered": self.offered.load(SeqCst), "scheduler_late": self.late.load(SeqCst),
            "window_closed": self.window_closed.load(SeqCst),
            "admission_rejected": self.rejected.load(SeqCst), "admitted": self.admitted.load(SeqCst),
            "completed_callers": self.completed.load(SeqCst), "attempts": self.attempts.load(SeqCst),
            "completed_within_window": self.completed_within_window.load(SeqCst),
            "successful_within_window": self.successful_within_window.load(SeqCst),
            "logical_ok": self.logical_ok.load(SeqCst), "logical_error": self.logical_error.load(SeqCst),
            "logical_deadline": self.logical_deadline.load(SeqCst),
            "ok": self.ok.load(SeqCst), "source_error": self.source_error.load(SeqCst),
            "cache_timeout": self.cache_timeout.load(SeqCst), "caller_timeout": self.caller_timeout.load(SeqCst),
            "source_rejected": self.source_rejected.load(SeqCst), "provider_rejected": self.provider_rejected.load(SeqCst),
            "source_native_timeout": self.source_native_timeout.load(SeqCst),
            "provider_native_timeout": self.provider_native_timeout.load(SeqCst),
            "reads": self.reads.load(SeqCst), "writes": self.writes.load(SeqCst),
            "invalidations": self.invalidations.load(SeqCst), "fenced": self.fenced.load(SeqCst),
            "recovered": self.recovered.load(SeqCst), "decompressed": self.decompressed.load(SeqCst),
            "read_over_limit": self.over_limit.load(SeqCst), "cpu_rejected": self.cpu_rejected.load(SeqCst),
            "source": self.source.snapshot(), "provider": self.provider.snapshot(),
            "callers": self.callers.snapshot(), "detached": self.detached.snapshot(),
            "cpu_outstanding": self.cpu.snapshot(), "cpu_running": self.cpu_running.snapshot(),
            "remote": self.remote.snapshot(), "latency": self.latency.lock().snapshot(),
            "success_latency": self.success_latency.lock().snapshot(),
            "scheduler_lag": self.scheduler_lag.lock().snapshot(),
            "sampled_values_live": self.values.lock().iter().filter(|value| value.strong_count() != 0).count(),
            "rss_kib": rss_kib()
        })
    }

    fn drained(&self) -> bool {
        [
            &self.source,
            &self.provider,
            &self.callers,
            &self.detached,
            &self.cpu,
            &self.remote,
        ]
        .iter()
        .all(|work| work.active.load(SeqCst) == 0)
    }
}

struct CountedRuntime {
    inner: TokioRuntime,
    metrics: Arc<Metrics>,
}

impl Runtime for CountedRuntime {
    fn spawn(&self, task: BoxFuture<'static, ()>) {
        let active = self.metrics.detached.enter();
        self.inner.spawn(Box::pin(async move {
            let _active = active;
            task.await;
        }));
    }

    fn spawn_blocking(&self, task: Box<dyn FnOnce() + Send + 'static>) -> Result<(), BoxError> {
        let pending = self.metrics.cpu.enter();
        let running = self.metrics.cpu_running.clone();
        let result = self.inner.spawn_blocking(Box::new(move || {
            let _pending = pending;
            let _running = running.enter();
            task();
        }));
        if result.is_err() {
            self.metrics.cpu_rejected.fetch_add(1, SeqCst);
        }
        result
    }

    fn sleep(&self, duration: Duration) -> BoxFuture<'static, ()> {
        self.inner.sleep(duration)
    }
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
struct Value {
    key: u64,
    version: u64,
    data: String,
}

#[derive(Default)]
struct Storage {
    frames: HashMap<String, Frame>,
    watermarks: HashMap<String, u64>,
}

impl Storage {
    fn put(&mut self, key: String, frame: Frame) {
        assert!(self.frames.len() < REMOTE_CAPACITY || self.frames.contains_key(&key));
        assert!(frame.payload.len() <= 1024 * 1024 + 256);
        self.frames.insert(key, frame);
    }
}

struct SyntheticRemote {
    state: Mutex<Storage>,
    metrics: Arc<Metrics>,
}

impl Remote for SyntheticRemote {
    fn read(
        &self,
        request: ReadRequest,
        _: ReadContext,
    ) -> BoxFuture<'_, Result<ReadResult, BoxError>> {
        Box::pin(async move {
            let _active = self.metrics.remote.enter();
            self.metrics.reads.fetch_add(1, SeqCst);
            sleep(Duration::from_millis(1)).await;
            let state = self.state.lock();
            let watermark = request
                .watermark_key
                .as_ref()
                .map(|key| state.watermarks.get(key).copied().unwrap_or(0));
            let frame = state.frames.get(&request.value_key);
            if let Some(frame) = frame {
                if watermark.is_none_or(|mark| frame.created_at_ms > mark) {
                    return Ok(ReadResult::Hit(frame.clone()));
                }
                self.metrics.fenced.fetch_add(1, SeqCst);
            }
            Ok(ReadResult::Miss {
                reason: if frame.is_some() {
                    MissReason::WatermarkFenced
                } else {
                    MissReason::ValueAbsent
                },
                observed_watermark_ms: watermark,
            })
        })
    }

    fn write(&self, request: WriteRequest) -> BoxFuture<'_, Result<(), BoxError>> {
        Box::pin(async move {
            let _active = self.metrics.remote.enter();
            self.metrics.writes.fetch_add(1, SeqCst);
            self.state.lock().put(request.value_key, request.frame);
            Ok(())
        })
    }

    fn invalidate(&self, request: InvalidateRequest) -> BoxFuture<'_, Result<(), BoxError>> {
        Box::pin(async move {
            let _active = self.metrics.remote.enter();
            self.metrics.invalidations.fetch_add(1, SeqCst);
            let mut state = self.state.lock();
            assert!(
                state.watermarks.len() < 16
                    || state.watermarks.contains_key(&request.watermark_key)
            );
            let watermark = state.watermarks.entry(request.watermark_key).or_default();
            *watermark = (*watermark).max(request.invalidated_at_ms + request.future_buffer_ms);
            Ok(())
        })
    }
}

#[derive(Debug, thiserror::Error)]
enum DependencyError {
    #[error("source capacity exhausted")]
    Busy,
    #[error("source deadline elapsed")]
    Timeout,
    #[error("source unavailable")]
    Offline,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
}

fn rss_kib() -> Option<u64> {
    std::fs::read_to_string("/proc/self/status")
        .ok()?
        .lines()
        .find_map(|line| {
            line.strip_prefix("VmRSS:")?
                .split_whitespace()
                .next()?
                .parse()
                .ok()
        })
}

fn identity(key: u64, case: Case) -> Identity {
    Identity::new("item", key, "load")
        .namespace("scale")
        .tracked(case == Case::Tracked || case.malformed())
}

fn operation(key: u64, case: Case) -> Operation<Value> {
    let policy = if case.remote() {
        Policy::default()
            .remote_ttl_sec(if case == Case::Recovery { 1 } else { 3600 })
            .stale_on_error_max_age_sec(if case == Case::Recovery { 3600 } else { 0 })
            .coalesce(!case.malformed())
    } else {
        Policy::default().local_ttl_sec(3600)
    };
    Operation::new(identity(key, case))
        .policy(policy)
        .budget(SourceBudget::Millis(20))
        .should_recover(|error| {
            matches!(
                error
                    .source_error()
                    .and_then(|error| error.downcast_ref::<DependencyError>()),
                Some(DependencyError::Offline)
            )
        })
}

fn malformed(blocks: u32) -> Payload {
    let mut bytes = vec![1, 0x28, 0xb5, 0x2f, 0xfd, 0, 0x38];
    for block in 0..blocks {
        let header = 2u32 | ((128 << 10) << 3) | u32::from(block == blocks - 1);
        bytes.extend_from_slice(&header.to_le_bytes()[..3]);
        bytes.push(0xff);
    }
    Payload::binary(bytes)
}

struct Application {
    cache: DialCache,
    remote: Arc<SyntheticRemote>,
    metrics: Arc<Metrics>,
    source_slots: Arc<Semaphore>,
    provider_slots: Arc<Semaphore>,
    fault: Arc<AtomicBool>,
    versions: Arc<Vec<AtomicU64>>,
    data: Arc<str>,
    case: Case,
}

impl Application {
    async fn get(&self, key: u64) -> Result<Arc<Value>, Error> {
        let request = self.cache.enable_guard();
        let slots = self.source_slots.clone();
        let metrics = self.metrics.clone();
        let fault = self.fault.clone();
        let versions = self.versions.clone();
        let data = self.data.clone();
        let case = self.case;
        self.cache
            .get_or_load(request.scope(), operation(key, case), move |_| {
                let (slots, metrics, fault, versions, data) = (
                    slots.clone(),
                    metrics.clone(),
                    fault.clone(),
                    versions.clone(),
                    data.clone(),
                );
                async move {
                    let Ok(_permit) = slots.try_acquire_owned() else {
                        metrics.source_rejected.fetch_add(1, SeqCst);
                        return Err(Box::new(DependencyError::Busy) as BoxError);
                    };
                    let _active = metrics.source.enter();
                    let failed = fault.load(SeqCst);
                    let value = Value {
                        key,
                        version: if case == Case::Tracked {
                            versions[key as usize].load(SeqCst)
                        } else if case == Case::Recovery {
                            1
                        } else {
                            0
                        },
                        data: data.to_string(),
                    };
                    let result = timeout(Duration::from_millis(60), async {
                        sleep(Duration::from_millis(
                            if case == Case::Cancellation && failed {
                                200
                            } else {
                                2
                            },
                        ))
                        .await;
                        if case == Case::Recovery && failed {
                            return Err(Box::new(DependencyError::Offline) as BoxError);
                        }
                        Ok(value)
                    })
                    .await;
                    result.unwrap_or_else(|_| {
                        metrics.source_native_timeout.fetch_add(1, SeqCst);
                        Err(Box::new(DependencyError::Timeout))
                    })
                }
            })
            .await
    }

    fn check(&self, key: u64, value: &Arc<Value>) {
        assert_eq!(value.key, key);
        assert_eq!(value.data.as_str(), self.data.as_ref());
        let maximum = if self.case == Case::Tracked {
            self.versions[key as usize].load(SeqCst)
        } else {
            u64::from(self.case == Case::Recovery)
        };
        assert!(value.version <= maximum, "future source version");
        self.metrics.remember(value);
    }
}

fn sample(phase: &str, start: Instant, metrics: &Metrics) {
    println!(
        "{}",
        json!({"phase": phase, "elapsed_ms": start.elapsed().as_millis(), "metrics": metrics.snapshot()})
    );
}

async fn drain(metrics: &Metrics) {
    timeout(Duration::from_secs(5), async {
        while !metrics.drained() {
            sleep(Duration::from_millis(2)).await;
        }
    })
    .await
    .expect("raw work did not drain");
}

async fn run(settings: &Settings, metrics: Arc<Metrics>) {
    let fault = Arc::new(AtomicBool::new(false));
    let provider_slots = Arc::new(Semaphore::new(PROVIDER_CAPACITY));
    let remote = Arc::new(SyntheticRemote {
        state: Mutex::new(Storage::default()),
        metrics: metrics.clone(),
    });
    let mut builder = DialCache::builder()
        .namespace("scale")
        .local_capacity(if matches!(settings.case, Case::HotHit | Case::SpreadHit) {
            64
        } else {
            0
        })
        .observer_arc(metrics.clone())
        .runtime(CountedRuntime {
            inner: TokioRuntime::current().unwrap(),
            metrics: metrics.clone(),
        })
        .policy_provider({
            let (slots, metrics, fault) = (provider_slots.clone(), metrics.clone(), fault.clone());
            let case = settings.case;
            move |_| {
                let (slots, metrics, fault) = (slots.clone(), metrics.clone(), fault.clone());
                async move {
                    let Ok(_permit) = slots.try_acquire_owned() else {
                        metrics.provider_rejected.fetch_add(1, SeqCst);
                        return Err("policy capacity exhausted".into());
                    };
                    let _active = metrics.provider.enter();
                    if case == Case::Cancellation
                        && fault.load(SeqCst)
                        && timeout(Duration::from_millis(30), sleep(Duration::from_millis(100)))
                            .await
                            .is_err()
                    {
                        metrics.provider_native_timeout.fetch_add(1, SeqCst);
                        return Err("policy deadline elapsed".into());
                    }
                    Ok(None)
                }
            }
        });
    if settings.case.remote() {
        builder = builder.remote_arc(remote.clone());
    }
    if settings.case.malformed() {
        builder = builder.disable_compression();
    }
    let app = Arc::new(Application {
        cache: builder.build().unwrap(),
        remote,
        metrics: metrics.clone(),
        source_slots: Arc::new(Semaphore::new(SOURCE_CAPACITY)),
        provider_slots,
        fault,
        versions: Arc::new((0..16).map(|_| AtomicU64::new(0)).collect()),
        data: Arc::from("x".repeat(settings.bytes)),
        case: settings.case,
    });
    let start = Instant::now();
    sample("pre_warmup", start, &metrics);
    if matches!(settings.case, Case::HotHit | Case::SpreadHit) {
        for key in 0..if settings.case == Case::HotHit { 1 } else { 64 } {
            app.get(key).await.unwrap();
        }
    }
    if matches!(settings.case, Case::Compressed | Case::Recovery) {
        for key in 0..if settings.case == Case::Recovery {
            1
        } else {
            64
        } {
            let value = Value {
                key,
                version: 0,
                data: app.data.to_string(),
            };
            let payload = Payload::text(serde_json::to_string(&value).unwrap());
            let payload = if settings.case == Case::Compressed {
                compress_payload(payload, &CompressionConfig::default(), 512 * 1024 * 1024)
                    .unwrap()
                    .payload
            } else {
                payload
            };
            app.remote.state.lock().put(
                identity(key, settings.case).keys().unwrap().value,
                Frame {
                    created_at_ms: now_ms()
                        - if settings.case == Case::Recovery {
                            2000
                        } else {
                            0
                        },
                    payload,
                },
            );
        }
    }
    drain(&metrics).await;
    sample("warmup_drained", start, &metrics);
    let measurement = Instant::now();
    let begin = tokio::time::Instant::now();
    let duration = Duration::from_secs(settings.seconds);
    let finished = Arc::new(AtomicBool::new(false));
    let sampler = tokio::spawn({
        let metrics = metrics.clone();
        let finished = finished.clone();
        async move {
            while !finished.load(SeqCst) {
                sleep(Duration::from_secs(1)).await;
                sample("interval", measurement, &metrics);
            }
        }
    });
    let capacity = if settings.case.malformed() { 4 } else { 64 };
    let slots = Arc::new(Semaphore::new(capacity));
    let mut callers = JoinSet::new();
    let mut invalidations = JoinSet::new();
    let mut random = SEED;
    for index in 0..settings.rate * settings.seconds {
        let intended = begin + Duration::from_nanos(index * 1_000_000_000 / settings.rate);
        sleep_until(intended).await;
        while let Some(result) = callers.try_join_next() {
            result.unwrap();
        }
        while let Some(result) = invalidations.try_join_next() {
            result.unwrap();
        }
        metrics.offered.fetch_add(1, SeqCst);
        let failed = match settings.case {
            Case::Cancellation => {
                index >= settings.rate * settings.seconds / 3
                    && index < settings.rate * settings.seconds * 2 / 3
            }
            Case::Recovery => index < settings.rate * settings.seconds / 2,
            _ => false,
        };
        if app.fault.swap(failed, SeqCst) != failed {
            println!(
                "{}",
                json!({"phase": "fault_transition", "arrival_index": index,
                "fault": failed, "elapsed_ms": measurement.elapsed().as_millis()})
            );
        }
        if settings.case == Case::Tracked && index % (settings.rate / 10).max(1) == 0 {
            let app = app.clone();
            let key = ((index / (settings.rate / 10).max(1)) % 16) as usize;
            invalidations.spawn(async move {
                app.versions[key].fetch_add(1, SeqCst);
                app.cache.invalidate("item", key, 0).await.unwrap();
            });
        }
        random ^= random << 13;
        random ^= random >> 7;
        random ^= random << 17;
        let lag = tokio::time::Instant::now().saturating_duration_since(intended);
        metrics.scheduler_lag.lock().record(lag);
        if tokio::time::Instant::now() >= begin + duration {
            metrics.window_closed.fetch_add(1, SeqCst);
            continue;
        }
        if lag > Duration::from_millis(20) {
            metrics.late.fetch_add(1, SeqCst);
            continue;
        }
        let Ok(permit) = slots.clone().try_acquire_owned() else {
            metrics.rejected.fetch_add(1, SeqCst);
            continue;
        };
        let key = settings.case.key(random);
        if settings.case.malformed() {
            app.remote.state.lock().put(
                identity(key, settings.case).keys().unwrap().value,
                Frame {
                    created_at_ms: now_ms(),
                    payload: malformed(if settings.case == Case::MalformedLarge {
                        1536
                    } else {
                        64
                    }),
                },
            );
        }
        metrics.admitted.fetch_add(1, SeqCst);
        let app = app.clone();
        let active = metrics.callers.enter();
        let window_end = begin + duration;
        callers.spawn(async move {
            let (_permit, _active) = (permit, active);
            let mut succeeded = false;
            let mut error = false;
            for retry in 0..=usize::from(app.case == Case::Cancellation) {
                app.metrics.attempts.fetch_add(1, SeqCst);
                let wait = if app.case == Case::Cancellation {
                    8
                } else if app.case.malformed() {
                    3000
                } else {
                    250
                };
                match timeout(Duration::from_millis(wait), app.get(key)).await {
                    Ok(Ok(value)) => {
                        app.check(key, &value);
                        app.metrics.ok.fetch_add(1, SeqCst);
                        succeeded = true;
                        break;
                    }
                    Ok(Err(Error::Source(_))) => {
                        app.metrics.source_error.fetch_add(1, SeqCst);
                        error = true;
                        break;
                    }
                    Ok(Err(Error::FallbackTimeout(_))) => {
                        app.metrics.cache_timeout.fetch_add(1, SeqCst);
                        break;
                    }
                    Ok(Err(error)) => panic!("unexpected cache error: {error}"),
                    Err(_) => {
                        app.metrics.caller_timeout.fetch_add(1, SeqCst);
                        if retry == 0 && app.case == Case::Cancellation {
                            sleep(Duration::from_millis(2)).await;
                        }
                    }
                }
            }
            let completed_at = tokio::time::Instant::now();
            let elapsed = completed_at.duration_since(intended);
            if completed_at <= window_end {
                app.metrics.completed_within_window.fetch_add(1, SeqCst);
                if succeeded {
                    app.metrics.successful_within_window.fetch_add(1, SeqCst);
                }
            }
            app.metrics.latency.lock().record(elapsed);
            if succeeded {
                app.metrics.logical_ok.fetch_add(1, SeqCst);
                app.metrics.success_latency.lock().record(elapsed);
            } else if error {
                app.metrics.logical_error.fetch_add(1, SeqCst);
            } else {
                app.metrics.logical_deadline.fetch_add(1, SeqCst);
            }
            app.metrics.completed.fetch_add(1, SeqCst);
        });
        if settings.case.malformed() && index % 4 == 3 {
            sample("cycle_loaded", measurement, &metrics);
            timeout(Duration::from_secs(5), async {
                while let Some(result) = callers.join_next().await {
                    result.unwrap();
                }
            })
            .await
            .expect("malformed cycle callers did not drain");
            drain(&metrics).await;
            assert!(metrics
                .values
                .lock()
                .iter()
                .all(|value| value.strong_count() == 0));
            sample("cycle_drained", measurement, &metrics);
        }
    }
    sleep_until(begin + duration).await;
    sample("admission_closed", measurement, &metrics);
    finished.store(true, SeqCst);
    app.fault.store(false, SeqCst);
    while let Some(result) = invalidations.join_next().await {
        result.unwrap();
    }
    timeout(Duration::from_secs(5), async {
        while let Some(result) = callers.join_next().await {
            result.unwrap();
        }
    })
    .await
    .expect("callers did not drain");
    drain(&metrics).await;
    sample("drained", measurement, &metrics);
    assert_eq!(
        metrics.admitted.load(SeqCst),
        metrics.completed.load(SeqCst)
    );
    assert_eq!(
        metrics.completed.load(SeqCst),
        metrics.logical_ok.load(SeqCst)
            + metrics.logical_error.load(SeqCst)
            + metrics.logical_deadline.load(SeqCst)
    );
    assert_eq!(
        metrics.offered.load(SeqCst),
        metrics.admitted.load(SeqCst)
            + metrics.rejected.load(SeqCst)
            + metrics.late.load(SeqCst)
            + metrics.window_closed.load(SeqCst)
    );
    assert_eq!(
        metrics.attempts.load(SeqCst),
        metrics.ok.load(SeqCst)
            + metrics.source_error.load(SeqCst)
            + metrics.cache_timeout.load(SeqCst)
            + metrics.caller_timeout.load(SeqCst)
    );
    assert!(metrics.source.peak.load(SeqCst) <= SOURCE_CAPACITY as u64);
    assert!(metrics.provider.peak.load(SeqCst) <= PROVIDER_CAPACITY as u64);
    assert!(metrics.cpu_running.peak.load(SeqCst) <= 2);
    assert_eq!(app.source_slots.available_permits(), SOURCE_CAPACITY);
    assert_eq!(app.provider_slots.available_permits(), PROVIDER_CAPACITY);
    assert!(metrics.ok.load(SeqCst) > 0, "no successful load sample");
    if settings.case == Case::Tracked {
        let version = app.versions[0].fetch_add(1, SeqCst) + 1;
        app.cache.invalidate("item", 0, 0).await.unwrap();
        sleep(Duration::from_millis(2)).await;
        assert_eq!(app.get(0).await.unwrap().version, version);
        assert_eq!(app.get(0).await.unwrap().version, version);
        assert!(metrics.fenced.load(SeqCst) > 0);
    }
    if settings.case == Case::Recovery {
        assert!(metrics.recovered.load(SeqCst) > 0);
        assert_eq!(app.get(0).await.unwrap().version, 1);
    }
    if settings.case == Case::Cancellation {
        assert!(metrics.caller_timeout.load(SeqCst) > 0);
        assert!(metrics.source_native_timeout.load(SeqCst) > 0);
        assert!(metrics.provider_native_timeout.load(SeqCst) > 0);
        let value = app.get(1).await.unwrap();
        app.check(1, &value);
    }
    drain(&metrics).await;
    sampler.await.unwrap();
    drop(app);
    assert!(metrics
        .values
        .lock()
        .iter()
        .all(|value| value.strong_count() == 0));
    sample("cache_dropped", measurement, &metrics);
}

#[test]
#[ignore = "bounded opt-in load test; select case, rate, duration and worker count"]
fn bounded_offered_load_drains_all_work() {
    let settings = Settings::read();
    println!(
        "{}",
        json!({
            "phase": "settings", "case": format!("{:?}", settings.case), "seed": SEED,
            "workers": settings.workers, "seconds": settings.seconds, "offered_per_second": settings.rate,
            "payload_bytes": settings.bytes, "caller_cap": if settings.case.malformed() { 4 } else { 64 },
            "source_cap": SOURCE_CAPACITY, "provider_cap": PROVIDER_CAPACITY,
            "source_native_timeout_ms": 60, "provider_native_timeout_ms": 30,
            "arrival_lateness_limit_ms": 20, "drain_timeout_seconds": 5,
            "local_capacity": if matches!(settings.case, Case::HotHit | Case::SpreadHit) { 64 } else { 0 },
            "remote_capacity": REMOTE_CAPACITY, "remote_read_delay_ms": 1,
            "source_delay_ms": 2, "source_fault_delay_ms": 200, "provider_fault_delay_ms": 100,
            "source_cache_budget_ms": 20, "caller_wait_ms": if settings.case == Case::Cancellation { 8 } else if settings.case.malformed() { 3000 } else { 250 },
            "max_retry_per_logical_request": usize::from(settings.case == Case::Cancellation),
            "request_local": false, "coalesce": !settings.case.malformed(),
            "local_ttl_seconds": 3600, "remote_ttl_seconds": if settings.case == Case::Recovery { 1 } else { 3600 },
            "recovery_age_seconds": if settings.case == Case::Recovery { 3600 } else { 0 },
            "observer": "inline_atomic_counters", "sampled_weak_values_capacity": 256,
            "histogram_last_bucket_upper_us": 2147483648u64, "histogram_overflow": "included_in_last_bucket_and_max"
        })
    );
    let metrics = Arc::new(Metrics::default());
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(settings.workers)
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(run(&settings, metrics.clone()));
    drop(runtime);
    assert!(metrics.drained());
    println!(
        "{}",
        json!({"phase": "runtime_dropped", "metrics": metrics.snapshot()})
    );
}

#[test]
fn histogram_upper_bounds_use_nearest_rank() {
    let mut histogram = Histogram::default();
    for micros in [0, 1, 2, 3, 16, 17] {
        histogram.record(Duration::from_micros(micros));
    }
    assert_eq!(histogram.percentile(50), 2);
    assert_eq!(histogram.percentile(95), 32);
    assert_eq!(histogram.buckets.iter().sum::<u64>(), 6);
    histogram.record(Duration::from_secs(2200));
    assert_eq!(histogram.percentile(100), 2_200_000_000);
    assert_eq!(histogram.overflow, 1);
}
