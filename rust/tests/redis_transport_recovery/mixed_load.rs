#[cfg(not(target_os = "linux"))]
compile_error!("The opt-in load fixture uses Linux process memory measurements.");

#[allow(dead_code)]
mod support;

use std::future::Future;
use std::pin::Pin;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering::SeqCst};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

use dialcache::observe::CompressionOutcome;
use dialcache::redis::RedisAdapter;
use dialcache::{
    BoxError, DialCache, Event, Identity, InvalidateRequest, Observer, Operation, Policy,
    ReadContext, ReadRequest, ReadResult, RedisConnection, Remote, Runtime, SourceBudget,
    TokioRuntime, WriteRequest,
};
use redis::aio::{ConnectionManager, ConnectionManagerConfig};
use tokio::sync::{oneshot, Notify, Semaphore};
use tokio::task::JoinSet;
use tokio::time::Instant;

use support::{free_port, ready, Directory, Server};

type WorkFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;
const RATE: usize = 200;
const CALLERS: usize = 64;
const SOURCES: usize = 8;
const REMOTES: usize = 64;
const VALUE_BYTES: usize = 65_536;
const PERIOD: Duration = Duration::from_micros(1_000_000 / RATE as u64);
const TOTAL_BUDGET: Duration = Duration::from_millis(300);
const RAW_BUDGET: Duration = Duration::from_millis(80);

#[derive(Default)]
struct Work {
    submitted: AtomicUsize,
    started: AtomicUsize,
    finished: AtomicUsize,
    dropped: AtomicUsize,
    never_started: AtomicUsize,
    pending: AtomicUsize,
    active: AtomicUsize,
    peak: AtomicUsize,
    rejected: AtomicUsize,
}

struct Ticket {
    work: Arc<Work>,
    started: bool,
    finished: bool,
}

impl Work {
    fn submit(self: &Arc<Self>) -> Ticket {
        self.submitted.fetch_add(1, SeqCst);
        self.pending.fetch_add(1, SeqCst);
        Ticket {
            work: self.clone(),
            started: false,
            finished: false,
        }
    }

    fn report(&self, kind: &str) {
        assert_eq!(self.pending.load(SeqCst), 0, "{kind} did not drain");
        assert_eq!(self.active.load(SeqCst), 0);
        assert_eq!(
            self.submitted.load(SeqCst),
            self.finished.load(SeqCst)
                + self.dropped.load(SeqCst)
                + self.never_started.load(SeqCst)
        );
        println!(
            "raw kind={kind} submitted={} started={} finished={} dropped={} never_started={} rejected={} peak_active={} pending=0",
            self.submitted.load(SeqCst), self.started.load(SeqCst), self.finished.load(SeqCst),
            self.dropped.load(SeqCst), self.never_started.load(SeqCst),
            self.rejected.load(SeqCst), self.peak.load(SeqCst)
        );
    }
}

impl Ticket {
    fn start(&mut self) {
        self.started = true;
        self.work.started.fetch_add(1, SeqCst);
        let active = self.work.active.fetch_add(1, SeqCst) + 1;
        self.work.peak.fetch_max(active, SeqCst);
    }

    fn finish(&mut self) {
        self.finished = true;
        self.work.finished.fetch_add(1, SeqCst);
    }
}

impl Drop for Ticket {
    fn drop(&mut self) {
        if self.started {
            self.work.active.fetch_sub(1, SeqCst);
            if !self.finished {
                self.work.dropped.fetch_add(1, SeqCst);
            }
        } else {
            self.work.never_started.fetch_add(1, SeqCst);
        }
        self.work.pending.fetch_sub(1, SeqCst);
    }
}

struct MeasuredRuntime {
    inner: TokioRuntime,
    asynchronous: Arc<Work>,
    cpu: Arc<Work>,
}

impl Runtime for MeasuredRuntime {
    fn spawn(&self, task: WorkFuture<'static, ()>) {
        let mut ticket = self.asynchronous.submit();
        self.inner.spawn(Box::pin(async move {
            ticket.start();
            task.await;
            ticket.finish();
        }));
    }

    fn spawn_blocking(&self, task: Box<dyn FnOnce() + Send>) -> Result<(), BoxError> {
        let mut ticket = self.cpu.submit();
        let result = self.inner.spawn_blocking(Box::new(move || {
            ticket.start();
            task();
            ticket.finish();
        }));
        if result.is_err() {
            self.cpu.rejected.fetch_add(1, SeqCst);
        }
        result
    }

    fn sleep(&self, duration: Duration) -> WorkFuture<'static, ()> {
        self.inner.sleep(duration)
    }
}

#[derive(Clone)]
struct NativeConnection {
    inner: ConnectionManager,
    work: Arc<Work>,
    permits: Arc<Semaphore>,
    tasks: Arc<Mutex<JoinSet<()>>>,
}

impl RedisConnection for NativeConnection {
    fn run(&self, cmd: redis::Cmd) -> WorkFuture<'_, redis::RedisResult<redis::Value>> {
        Box::pin(async move {
            let permit = self.permits.clone().try_acquire_owned().map_err(|_| {
                self.work.rejected.fetch_add(1, SeqCst);
                redis::RedisError::from((redis::ErrorKind::Io, "native admission full"))
            })?;
            let mut ticket = self.work.submit();
            let connection = self.inner.clone();
            let (sender, receiver) = oneshot::channel();
            {
                let mut tasks = self.tasks.lock().unwrap();
                while let Some(result) = tasks.try_join_next() {
                    result.unwrap();
                }
                tasks.spawn(async move {
                    let _permit = permit;
                    ticket.start();
                    let result = connection.run(cmd).await;
                    ticket.finish();
                    let _ = sender.send(result);
                });
            }
            receiver.await.map_err(|_| {
                redis::RedisError::from((redis::ErrorKind::Io, "native command task failed"))
            })?
        })
    }

    fn run_on_primary(
        &self,
        _key: &str,
        cmd: redis::Cmd,
    ) -> WorkFuture<'_, redis::RedisResult<redis::Value>> {
        self.run(cmd)
    }
}

struct MeasuredRemote {
    inner: RedisAdapter<NativeConnection>,
    work: Arc<Work>,
    permits: Arc<Semaphore>,
    reads: AtomicUsize,
    writes: AtomicUsize,
    invalidations: AtomicUsize,
    errors: AtomicUsize,
    phase: Arc<AtomicUsize>,
    recovered_hits: AtomicUsize,
    first_recovered_hit: OnceLock<Instant>,
}

impl MeasuredRemote {
    async fn measure<T>(
        &self,
        future: impl Future<Output = Result<T, BoxError>>,
    ) -> Result<T, BoxError> {
        let _permit = self.permits.clone().try_acquire_owned().map_err(|error| {
            self.work.rejected.fetch_add(1, SeqCst);
            Box::new(error) as BoxError
        })?;
        let mut ticket = self.work.submit();
        ticket.start();
        let result = future.await;
        self.errors.fetch_add(usize::from(result.is_err()), SeqCst);
        ticket.finish();
        result
    }
}

impl Remote for MeasuredRemote {
    fn read(
        &self,
        request: ReadRequest,
        context: ReadContext,
    ) -> WorkFuture<'_, Result<ReadResult, BoxError>> {
        Box::pin(async move {
            self.reads.fetch_add(1, SeqCst);
            let result = self.measure(self.inner.read(request, context)).await;
            if matches!(&result, Ok(ReadResult::Hit(_))) && self.phase.load(SeqCst) == 2 {
                self.recovered_hits.fetch_add(1, SeqCst);
                self.first_recovered_hit.get_or_init(Instant::now);
            }
            result
        })
    }

    fn write(&self, request: WriteRequest) -> WorkFuture<'_, Result<(), BoxError>> {
        Box::pin(async move {
            self.writes.fetch_add(1, SeqCst);
            self.measure(self.inner.write(request)).await
        })
    }

    fn invalidate(&self, request: InvalidateRequest) -> WorkFuture<'_, Result<(), BoxError>> {
        Box::pin(async move {
            self.invalidations.fetch_add(1, SeqCst);
            self.measure(self.inner.invalidate(request)).await
        })
    }
}

#[derive(Default)]
struct Events {
    compressed: AtomicUsize,
    decompressed: AtomicUsize,
    misses: AtomicUsize,
}

impl Observer for Events {
    fn observe(&self, event: &Event) {
        match event {
            Event::Compression {
                outcome: CompressionOutcome::Compressed,
                ..
            } => {
                self.compressed.fetch_add(1, SeqCst);
            }
            Event::Compression {
                outcome: CompressionOutcome::Decompressed,
                ..
            } => {
                self.decompressed.fetch_add(1, SeqCst);
            }
            Event::Miss { .. } => {
                self.misses.fetch_add(1, SeqCst);
            }
            _ => {}
        }
    }
}

#[derive(Default)]
struct Histogram {
    buckets: [AtomicU64; 32],
    max: AtomicU64,
    overflow: AtomicU64,
}

impl Histogram {
    fn record(&self, duration: Duration) {
        let micros = duration.as_nanos().div_ceil(1_000).min(u64::MAX as u128) as u64;
        let bucket = u64::BITS - micros.saturating_sub(1).leading_zeros();
        self.buckets[(bucket as usize).min(31)].fetch_add(1, SeqCst);
        self.overflow.fetch_add(u64::from(bucket > 31), SeqCst);
        self.max.fetch_max(micros, SeqCst);
    }

    fn report(&self, name: &str) {
        let counts = self.buckets.each_ref().map(|bucket| bucket.load(SeqCst));
        let count: u64 = counts.iter().sum();
        let percentile = |percent: u64| {
            if count == 0 {
                return 0;
            }
            let rank = (count * percent).div_ceil(100);
            let mut seen = 0;
            for (index, value) in counts.iter().enumerate() {
                seen += value;
                if seen >= rank {
                    return 1u64 << index;
                }
            }
            unreachable!()
        };
        println!(
            "latency scope={name} unit=us count={count} p50_upper={} p95_upper={} p99_upper={} max={} overflow={}",
            percentile(50), percentile(95), percentile(99), self.max.load(SeqCst),
            self.overflow.load(SeqCst)
        );
    }
}

const OUTCOMES: [&str; 6] = [
    "lookup_ok",
    "invalidate_ok",
    "lookup_error",
    "invalidate_error",
    "caller_cancelled",
    "total_deadline",
];

#[derive(Default)]
struct Results {
    terminal: [AtomicUsize; 6],
    within_window: [AtomicUsize; 6],
    by_phase: [[AtomicUsize; 6]; 3],
    arrivals: Histogram,
    successful: Histogram,
    service: Histogram,
    scheduler: Histogram,
    cancelled: Histogram,
    phase_arrivals: [Histogram; 3],
    phase_successful: [Histogram; 3],
    rss_peak_kib: AtomicU64,
    redis_peak_bytes: AtomicU64,
    old_commands_lower_bound: AtomicU64,
    new_commands: AtomicU64,
    diagnostic_errors: AtomicUsize,
    initial_pid: AtomicU64,
    replacement_pid: AtomicU64,
}

fn value(key: usize) -> String {
    let mut value = format!("entity:{key:08}|");
    value.extend(std::iter::repeat_n('x', VALUE_BYTES - value.len()));
    value
}

fn rss_kib() -> u64 {
    std::fs::read_to_string("/proc/self/status")
        .unwrap()
        .lines()
        .find_map(|line| line.strip_prefix("VmRSS:"))
        .unwrap()
        .split_whitespace()
        .next()
        .unwrap()
        .parse()
        .unwrap()
}

fn info_number(info: &str, field: &str) -> u64 {
    info.lines()
        .find_map(|line| line.strip_prefix(&format!("{field}:")))
        .unwrap()
        .trim()
        .parse()
        .unwrap()
}

async fn info(connection: &mut ConnectionManager, section: &str) -> redis::RedisResult<String> {
    redis::cmd("INFO")
        .arg(section)
        .query_async(connection)
        .await
}

fn assert_closed(port: u16, pids: &[u64]) {
    assert!(
        std::net::TcpStream::connect_timeout(
            &std::net::SocketAddr::from(([127, 0, 0, 1], port)),
            Duration::from_millis(50),
        )
        .is_err(),
        "fixture listener remained open"
    );
    for pid in pids {
        assert!(*pid > 0);
        assert!(
            !std::path::Path::new(&format!("/proc/{pid}")).exists(),
            "fixture child {pid} was not reaped"
        );
    }
}

#[tokio::test]
#[ignore = "local child-process cleanup controls"]
async fn cleanup_controls() {
    let histogram = Histogram::default();
    histogram.record(Duration::from_nanos(1_001));
    assert_eq!(histogram.buckets[1].load(SeqCst), 1);
    tokio::time::timeout(Duration::from_secs(15), async {
        for mode in 0..3 {
            let directory = Directory::new();
            let port = free_port();
            let server = Server::start(&directory.0, "cleanup", port, "", false);
            let mut connection = ready(&server.client()).await;
            let info: String = redis::cmd("INFO")
                .arg("server")
                .query_async(&mut connection)
                .await
                .unwrap();
            let pid = info_number(&info, "process_id");
            let mut supervisor = JoinSet::new();
            supervisor.spawn(async move {
                let _server = server;
                match mode {
                    0 => panic!("intentional fixture-owner panic"),
                    1 => std::future::pending::<()>().await,
                    _ => {
                        let mut nested = JoinSet::new();
                        nested.spawn(async { panic!("intentional supervised failure") });
                        nested.join_next().await.unwrap().unwrap();
                    }
                }
            });
            if mode == 1 {
                assert!(
                    tokio::time::timeout(Duration::from_millis(10), supervisor.join_next())
                        .await
                        .is_err()
                );
                supervisor.abort_all();
            }
            assert!(supervisor.join_next().await.unwrap().is_err());
            assert_closed(port, &[pid]);
            println!("cleanup mode={mode} pid={pid} port={port} reaped=1 listener_closed=1");
        }
    })
    .await
    .expect("cleanup controls exceeded their deadline");
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
#[ignore = "explicit local Redis load run; set DIALCACHE_REDIS_LOAD_SECONDS to 10 or 120"]
async fn mixed_load_with_one_outage() {
    let seconds: u64 = std::env::var("DIALCACHE_REDIS_LOAD_SECONDS")
        .expect("set DIALCACHE_REDIS_LOAD_SECONDS to 10 (pilot) or 120")
        .parse()
        .unwrap();
    assert!(matches!(seconds, 10 | 120));
    tokio::time::timeout(Duration::from_secs(seconds + 20), run(seconds))
        .await
        .expect("load run exceeded its hard overall deadline");
}

async fn run(seconds: u64) {
    let directory = Arc::new(Directory::new());
    let port = free_port();
    let server = Server::start(&directory.0, "mixed", port, "", false);
    ready(&server.client()).await;
    let mut connection = server
        .client()
        .get_connection_manager_with_config(
            ConnectionManagerConfig::new()
                .set_connection_timeout(Some(RAW_BUDGET))
                .set_response_timeout(Some(RAW_BUDGET))
                .set_concurrency_limit(16)
                .set_number_of_retries(1)
                .set_min_delay(Duration::from_millis(10))
                .set_max_delay(Duration::from_millis(20)),
        )
        .await
        .unwrap();
    let asynchronous = Arc::new(Work::default());
    let cpu = Arc::new(Work::default());
    let sources = Arc::new(Work::default());
    let remote_work = Arc::new(Work::default());
    let native_work = Arc::new(Work::default());
    let native = NativeConnection {
        inner: connection.clone(),
        work: native_work.clone(),
        permits: Arc::new(Semaphore::new(REMOTES)),
        tasks: Arc::new(Mutex::new(JoinSet::new())),
    };
    let phase = Arc::new(AtomicUsize::new(0));
    let source_permits = Arc::new(Semaphore::new(SOURCES));
    let callers = Arc::new(Semaphore::new(CALLERS));
    let remote = Arc::new(MeasuredRemote {
        inner: RedisAdapter::new(native.clone()),
        work: remote_work.clone(),
        permits: Arc::new(Semaphore::new(REMOTES)),
        reads: AtomicUsize::new(0),
        writes: AtomicUsize::new(0),
        invalidations: AtomicUsize::new(0),
        errors: AtomicUsize::new(0),
        phase: phase.clone(),
        recovered_hits: AtomicUsize::new(0),
        first_recovered_hit: OnceLock::new(),
    });
    let events = Arc::new(Events::default());
    let cache = Arc::new(
        DialCache::builder()
            .namespace("mixed-load")
            .local_capacity(0)
            .remote_arc(remote.clone())
            .observer_arc(events.clone())
            .runtime(MeasuredRuntime {
                inner: TokioRuntime::current().unwrap(),
                asynchronous: asynchronous.clone(),
                cpu: cpu.clone(),
            })
            .build()
            .unwrap(),
    );
    let results = Arc::new(Results::default());
    let server_info = info(&mut connection, "server").await.unwrap();
    let initial_pid = info_number(&server_info, "process_id");
    results.initial_pid.store(initial_pid, SeqCst);
    println!("server phase=initial pid={initial_pid} port={port} bind=127.0.0.1 persistence=disabled client_concurrency=16 native_ms=80");
    let stop = Arc::new(Notify::new());
    let rss_before = rss_kib();
    results.rss_peak_kib.store(rss_before, SeqCst);
    let redis_before = info_number(
        &info(&mut connection, "memory").await.unwrap(),
        "used_memory",
    );
    let begin = Instant::now() + Duration::from_millis(20);
    let end = begin + Duration::from_secs(seconds);
    let outage_at = begin + Duration::from_secs(seconds / 3);
    let restart_at = outage_at + Duration::from_secs(2);
    println!(
        "fault planned_stop_ms={} planned_restart_ms={}",
        outage_at.duration_since(begin).as_millis(),
        restart_at.duration_since(begin).as_millis()
    );
    let mut control = JoinSet::new();
    let control_results = results.clone();
    let control_phase = phase.clone();
    let control_stop = stop.clone();
    let control_directory = directory.clone();
    let mut control_connection = connection.clone();
    control.spawn(async move {
        let mut server = Some(server);
        let mut stopped = false;
        let mut restarted = false;
        loop {
            tokio::select! {
                _ = control_stop.notified() => break,
                _ = tokio::time::sleep(Duration::from_millis(100)) => {}
            }
            let now = Instant::now();
            if !stopped && now >= outage_at {
                let stats = info(&mut control_connection, "stats").await.unwrap();
                control_results
                    .old_commands_lower_bound
                    .store(info_number(&stats, "total_commands_processed"), SeqCst);
                control_phase.store(1, SeqCst);
                server.as_mut().unwrap().stop();
                server = None;
                stopped = true;
                println!("fault event=stopped at_ms={}", begin.elapsed().as_millis());
            }
            if stopped && !restarted && now >= restart_at {
                let replacement = Server::start(&control_directory.0, "mixed", port, "", false);
                ready(&replacement.client()).await;
                server = Some(replacement);
                restarted = true;
                support::manager_ready(&mut control_connection).await;
                let server_info = info(&mut control_connection, "server").await.unwrap();
                let pid = info_number(&server_info, "process_id");
                control_results.replacement_pid.store(pid, SeqCst);
                control_phase.store(2, SeqCst);
                println!(
                    "fault event=restart_ready pid={pid} port={port} at_ms={}",
                    begin.elapsed().as_millis()
                );
            }
            control_results.rss_peak_kib.fetch_max(rss_kib(), SeqCst);
            match info(&mut control_connection, "memory").await {
                Ok(memory) => {
                    control_results
                        .redis_peak_bytes
                        .fetch_max(info_number(&memory, "used_memory"), SeqCst);
                }
                Err(_) => {
                    control_results.diagnostic_errors.fetch_add(1, SeqCst);
                }
            }
        }
        assert!(stopped && restarted);
        let stats = info(&mut control_connection, "stats").await.unwrap();
        control_results
            .new_commands
            .store(info_number(&stats, "total_commands_processed"), SeqCst);
    });

    let mut requests = JoinSet::new();
    let scheduled = seconds as usize * RATE;
    let mut admitted = 0;
    let mut cap_rejected = 0;
    let mut scheduler_late = 0;
    let mut window_closed = 0;
    let mut caller_peak = 0;
    for index in 0..scheduled {
        let intended = begin + PERIOD * index as u32;
        tokio::time::sleep_until(intended).await;
        if let Some(result) = control.try_join_next() {
            result.expect("Redis controller failed");
            panic!("Redis controller ended before drain");
        }
        while let Some(result) = requests.try_join_next() {
            result.unwrap();
        }
        let dispatched = Instant::now();
        if dispatched >= end {
            window_closed += 1;
            continue;
        }
        let lag = dispatched.saturating_duration_since(intended);
        results.scheduler.record(lag);
        if lag > Duration::from_millis(20) {
            scheduler_late += 1;
            continue;
        }
        let Ok(permit) = callers.clone().try_acquire_owned() else {
            cap_rejected += 1;
            continue;
        };
        admitted += 1;
        caller_peak = caller_peak.max(CALLERS - callers.available_permits());
        let cache = cache.clone();
        let results = results.clone();
        let phase = phase.clone();
        let sources = sources.clone();
        let source_permits = source_permits.clone();
        requests.spawn(async move {
            let _permit = permit;
            let invalidation = index % 10 == 9;
            let cancellation = index % 10 == 8;
            let key = if invalidation || index % 10 < 6 { (index / 10) % 16 } else { 16 + index % 512 };
            let operation = async {
                if invalidation {
                    return if cache.invalidate("entity", key, 0).await.is_ok() { 1 } else { 3 };
                }
                let scope = cache.enable_guard();
                let result = cache.get_or_load(
                    scope.scope(),
                    Operation::<String>::new(Identity::new("entity", key, "value").tracked(true))
                        .policy(Policy::default().remote_ttl_sec(1).remote_read_timeout_ms(30))
                        .budget(SourceBudget::Millis(80)),
                    move |_| {
                        let source_permits = source_permits.clone();
                        let sources = sources.clone();
                        async move {
                        let _source_permit = source_permits.try_acquire_owned().map_err(|error| {
                            sources.rejected.fetch_add(1, SeqCst);
                            Box::new(error) as BoxError
                        })?;
                        let mut ticket = sources.submit();
                        ticket.start();
                        let result = tokio::time::timeout(Duration::from_millis(60), async {
                            tokio::time::sleep(Duration::from_millis(if cancellation { 40 } else { 5 })).await;
                            value(key)
                        }).await.map_err(|error| Box::new(error) as BoxError);
                        ticket.finish();
                        result
                        }
                    },
                ).await;
                match result {
                    Ok(actual) => { assert_eq!(*actual, value(key), "corrupt or cross-key value"); 0 }
                    Err(_) => 2,
                }
            };
            let outcome = if cancellation {
                tokio::select! {
                    result = tokio::time::timeout_at(dispatched + TOTAL_BUDGET, operation) => result.unwrap_or(5),
                    _ = tokio::time::sleep_until(dispatched + Duration::from_millis(2)) => 4,
                }
            } else {
                tokio::time::timeout_at(dispatched + TOTAL_BUDGET, operation).await.unwrap_or(5)
            };
            let terminal = Instant::now();
            results.terminal[outcome].fetch_add(1, SeqCst);
            let terminal_phase = phase.load(SeqCst);
            results.by_phase[terminal_phase][outcome].fetch_add(1, SeqCst);
            results.phase_arrivals[terminal_phase].record(terminal.saturating_duration_since(intended));
            if terminal < end { results.within_window[outcome].fetch_add(1, SeqCst); }
            results.arrivals.record(terminal.saturating_duration_since(intended));
            results.service.record(terminal.duration_since(dispatched));
            if outcome == 0 {
                results.successful.record(terminal.saturating_duration_since(intended));
                results.phase_successful[terminal_phase].record(terminal.saturating_duration_since(intended));
            }
            if outcome == 4 { results.cancelled.record(terminal.saturating_duration_since(intended)); }
        });
    }
    tokio::time::sleep_until(end).await;
    let drain_start = Instant::now();
    let redis_after = tokio::time::timeout_at(end + Duration::from_secs(5), async {
        while let Some(result) = requests.join_next().await {
            result.unwrap();
        }
        loop {
            while let Some(result) = native.tasks.lock().unwrap().try_join_next() {
                result.unwrap();
            }
            if [&sources, &remote_work, &native_work, &asynchronous, &cpu]
                .iter()
                .all(|work| work.pending.load(SeqCst) == 0)
                && cache.coalescing_state().process.active_leaders == 0
                && native.tasks.lock().unwrap().is_empty()
            {
                break;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        assert_eq!(callers.available_permits(), CALLERS);
        assert_eq!(source_permits.available_permits(), SOURCES);
        assert_eq!(remote.permits.available_permits(), REMOTES);
        assert_eq!(native.permits.available_permits(), REMOTES);
        assert_eq!(cache.coalescing_state().process.active_followers, 0);
        // This orders older replies on the surviving connection, not work on a dead server.
        assert_eq!(
            redis::cmd("PING")
                .query_async::<String>(&mut connection)
                .await
                .unwrap(),
            "PONG"
        );
        let redis_after = info_number(
            &info(&mut connection, "memory").await.unwrap(),
            "used_memory",
        );
        stop.notify_one();
        while let Some(result) = control.join_next().await {
            result.unwrap();
        }
        assert_closed(port, &[initial_pid, results.replacement_pid.load(SeqCst)]);
        redis_after
    })
    .await
    .expect("caller, raw-work, server or cleanup drain exceeded five seconds");
    let terminal: usize = results
        .terminal
        .iter()
        .map(|count| count.load(SeqCst))
        .sum();
    assert_eq!(
        scheduled,
        admitted + cap_rejected + scheduler_late + window_closed
    );
    assert_eq!(terminal, admitted);
    assert!(events.compressed.load(SeqCst) > 0 && events.decompressed.load(SeqCst) > 0);
    assert!(events.misses.load(SeqCst) > 0 && results.terminal[4].load(SeqCst) > 0);
    assert!(remote.errors.load(SeqCst) > 0 && results.by_phase[2][0].load(SeqCst) > 0);
    assert!(
        results.by_phase[1][3].load(SeqCst) > 0,
        "outage invalidation failure was not reached"
    );
    assert!(
        remote.recovered_hits.load(SeqCst) > 0,
        "post-restart results were only source fallbacks"
    );
    assert!(sources.peak.load(SeqCst) <= SOURCES && remote_work.peak.load(SeqCst) <= REMOTES);
    assert!(cpu.peak.load(SeqCst) <= 2);
    assert!(native_work.peak.load(SeqCst) <= REMOTES);
    println!("load seconds={seconds} rate={RATE} workers=4 scheduled={scheduled} admitted={admitted} cap_rejected={cap_rejected} scheduler_late={scheduler_late} window_closed={window_closed} terminal={terminal} caller_peak={caller_peak} drain_ms={}", drain_start.elapsed().as_millis());
    for (index, name) in OUTCOMES.iter().enumerate() {
        println!(
            "outcome name={name} terminal={} within_window={} pre={} outage={} recovery={}",
            results.terminal[index].load(SeqCst),
            results.within_window[index].load(SeqCst),
            results.by_phase[0][index].load(SeqCst),
            results.by_phase[1][index].load(SeqCst),
            results.by_phase[2][index].load(SeqCst)
        );
    }
    for (name, work) in [
        ("source", sources),
        ("adapter_future", remote_work),
        ("native_command_future", native_work),
        ("library_async", asynchronous),
        ("library_cpu", cpu),
    ] {
        work.report(name);
    }
    results.arrivals.report("intended_arrival_to_any_terminal");
    results
        .successful
        .report("intended_arrival_to_lookup_success");
    results.service.report("dispatch_to_any_terminal");
    results
        .scheduler
        .report("scheduler_lag_before_window_close");
    results.cancelled.report("intended_arrival_to_cancellation");
    for (index, name) in ["pre", "outage", "recovery"].iter().enumerate() {
        results.phase_arrivals[index].report(&format!("{name}_intended_to_terminal"));
        results.phase_successful[index].report(&format!("{name}_intended_to_lookup_success"));
    }
    let within: usize = results
        .within_window
        .iter()
        .map(|count| count.load(SeqCst))
        .sum();
    let within_success =
        results.within_window[0].load(SeqCst) + results.within_window[1].load(SeqCst);
    let all_success = results.terminal[0].load(SeqCst) + results.terminal[1].load(SeqCst);
    println!("ratios admitted_offered={:.6} within_success_offered={:.6} eventual_success_admitted={:.6} within_terminal={within} late_terminal={} within_success_per_second={:.3}",
        admitted as f64 / scheduled as f64, within_success as f64 / scheduled as f64,
        all_success as f64 / admitted as f64, terminal - within, within_success as f64 / seconds as f64);
    println!(
        "recovery redis_hits={} first_hit_ms={}",
        remote.recovered_hits.load(SeqCst),
        remote
            .first_recovered_hit
            .get()
            .unwrap()
            .duration_since(begin)
            .as_millis()
    );
    println!("coverage misses={} compressed={} decompressed={} adapter_reads={} adapter_writes={} adapter_invalidations={} adapter_errors={}",
        events.misses.load(SeqCst), events.compressed.load(SeqCst), events.decompressed.load(SeqCst),
        remote.reads.load(SeqCst), remote.writes.load(SeqCst), remote.invalidations.load(SeqCst), remote.errors.load(SeqCst));
    println!("memory process_rss_before_kib={rss_before} process_rss_sampled_peak_kib={} process_rss_after_kib={} redis_before_bytes={redis_before} redis_sampled_peak_bytes={} redis_after_bytes={redis_after} value_bytes={VALUE_BYTES} local_capacity=0",
        results.rss_peak_kib.load(SeqCst), rss_kib(), results.redis_peak_bytes.load(SeqCst));
    println!("server old_commands_lower_bound={} new_commands={} diagnostic_errors={} command_counts_include_diagnostics_and_lua=1",
        results.old_commands_lower_bound.load(SeqCst), results.new_commands.load(SeqCst), results.diagnostic_errors.load(SeqCst));
}
