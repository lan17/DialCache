use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Instant;

use ::redis::aio::MultiplexedConnection;
use dialcache::{
    BoxError, Clock, DialCache, Frame, Identity, InvalidateRequest, KeySpec, Payload, Policy,
    ReadContext, ReadRequest, ReadResult, RedisAdapter, Remote, SystemClock, WriteRequest,
};
use futures::future::BoxFuture;

use crate::{elapsed_ns, empty_commands, Commands, Counters, Measurement, Request, Source};

struct CountedRemote {
    adapter: RedisAdapter<MultiplexedConnection>,
    reads: AtomicU64,
    writes: AtomicU64,
}

impl Remote for CountedRemote {
    fn read(
        &self,
        request: ReadRequest,
        context: ReadContext,
    ) -> BoxFuture<'_, Result<ReadResult, BoxError>> {
        self.reads.fetch_add(1, Ordering::Relaxed);
        self.adapter.read(request, context)
    }

    fn write(&self, request: WriteRequest) -> BoxFuture<'_, Result<(), BoxError>> {
        self.writes.fetch_add(1, Ordering::Relaxed);
        self.adapter.write(request)
    }

    fn invalidate(&self, request: InvalidateRequest) -> BoxFuture<'_, Result<(), BoxError>> {
        self.adapter.invalidate(request)
    }
}

async fn commandstats(connection: &mut MultiplexedConnection) -> Result<Commands, BoxError> {
    let info: String = ::redis::cmd("INFO")
        .arg("commandstats")
        .query_async(connection)
        .await?;
    let mut commands = empty_commands();
    for line in info.lines() {
        let Some((name, fields)) = line
            .strip_prefix("cmdstat_")
            .and_then(|line| line.split_once(':'))
        else {
            continue;
        };
        if let Some(count) = commands.get_mut(name) {
            *count = fields
                .split(',')
                .find_map(|field| field.strip_prefix("calls="))
                .ok_or("Redis commandstats is missing calls")?
                .parse()?;
        }
    }
    Ok(commands)
}

fn command_delta(before: Commands, mut after: Commands) -> Result<Commands, BoxError> {
    for (command, count) in &mut after {
        *count = count
            .checked_sub(before[command])
            .ok_or("Redis commandstats reset during the benchmark")?;
    }
    Ok(after)
}

pub async fn connect(url: &str) -> Result<MultiplexedConnection, BoxError> {
    Ok(::redis::Client::open(url)?
        .get_multiplexed_async_connection()
        .await?)
}

pub async fn phase(
    request: &Request,
    iterations: usize,
    phase_name: &str,
    mut connection: MultiplexedConnection,
) -> Result<Measurement, BoxError> {
    let namespace = format!("benchmark-{}-{phase_name}", request.id);
    let tracked = request.case.kind == "redis-tracked-hit";
    let keys = Identity::new("benchmark-key", "shared", "Benchmark")
        .namespace(&namespace)
        .tracked(tracked)
        .keys()?;
    let value_key = if request.case.kind == "redis-write" {
        format!("{namespace}:write")
    } else {
        keys.value
    };
    let remote = Arc::new(CountedRemote {
        adapter: RedisAdapter::new(connection.clone()),
        reads: AtomicU64::new(0),
        writes: AtomicU64::new(0),
    });
    let result = if request.case.kind == "redis-write" {
        write_phase(
            request,
            iterations,
            &value_key,
            remote.clone(),
            &mut connection,
        )
        .await
    } else {
        hit_phase(
            request,
            iterations,
            &namespace,
            remote.clone(),
            &mut connection,
        )
        .await
    };
    let mut cleanup = ::redis::cmd("DEL");
    cleanup.arg(&value_key);
    if let Some(watermark) = keys.watermark {
        cleanup.arg(watermark);
    }
    let cleanup_result: Result<u64, ::redis::RedisError> =
        cleanup.query_async(&mut connection).await;
    let measurement = result?;
    cleanup_result?;
    Ok(measurement)
}

async fn hit_phase(
    request: &Request,
    iterations: usize,
    namespace: &str,
    remote: Arc<CountedRemote>,
    connection: &mut MultiplexedConnection,
) -> Result<Measurement, BoxError> {
    let source = Arc::new(Source::new(&request.payload));
    let captured_source = source.clone();
    let cache = DialCache::builder()
        .namespace(namespace)
        .local_capacity(request.case.capacity)
        .remote_read_timeout_ms(60_000)
        .disable_compression()
        .remote_arc(remote.clone())
        .build()?;
    let operation = cache
        .use_case::<String, String>("benchmark-key", "Benchmark")
        .tracked(request.case.kind == "redis-tracked-hit")
        .policy(Policy::default().remote_ttl_sec(3600))
        .key(|key: &String| KeySpec::new(key))
        .source(move |_scope, _key| {
            let source = captured_source.clone();
            async move { Ok(source.load().await) }
        })
        .register()?;
    let key = "shared".to_owned();
    {
        let scope = cache.enable_guard();
        let value = operation.get(scope.scope(), key.clone()).await?;
        if value.as_str() != request.payload || remote.writes.load(Ordering::Relaxed) != 1 {
            return Err("Redis prime did not store the supplied value".into());
        }
    }
    source.reset();
    remote.reads.store(0, Ordering::Relaxed);
    remote.writes.store(0, Ordering::Relaxed);
    let mut values = Vec::with_capacity(iterations);
    let mut latency_ns = Vec::with_capacity(iterations);
    let before = commandstats(connection).await?;
    let mut checksum = 0;
    let started = Instant::now();
    for _ in 0..iterations {
        let operation_started = Instant::now();
        let value = {
            let scope = cache.enable_guard();
            operation.get(scope.scope(), key.clone()).await?
        };
        latency_ns.push(elapsed_ns(operation_started));
        checksum += value.len() as u64;
        values.push(value);
    }
    let elapsed_ns = elapsed_ns(started);
    let after = commandstats(connection).await?;
    Ok(Measurement {
        operations: iterations as u64,
        elapsed_ns,
        checksum,
        value_valid: values.iter().all(|value| value.as_str() == request.payload),
        counters: Counters {
            source_calls: source.calls(),
            redis_reads: remote.reads.load(Ordering::Relaxed),
            redis_writes: remote.writes.load(Ordering::Relaxed),
            coalesced_calls: 0,
        },
        redis_commands: command_delta(before, after)?,
        latency_ns,
    })
}

async fn write_phase(
    request: &Request,
    iterations: usize,
    key: &str,
    remote: Arc<CountedRemote>,
    connection: &mut MultiplexedConnection,
) -> Result<Measurement, BoxError> {
    let payload = Payload::binary(request.payload.as_bytes());
    let clock = SystemClock::new();
    let mut latency_ns = Vec::with_capacity(iterations);
    let mut checksum = 0;
    let before = commandstats(connection).await?;
    let started = Instant::now();
    for _ in 0..iterations {
        let operation_started = Instant::now();
        remote
            .write(WriteRequest {
                value_key: key.to_owned(),
                frame: Frame {
                    created_at_ms: u64::try_from(clock.wall_ms())?,
                    payload: payload.clone(),
                },
                ttl_ms: 3_600_000,
            })
            .await?;
        latency_ns.push(elapsed_ns(operation_started));
        checksum += payload.len() as u64;
    }
    let elapsed_ns = elapsed_ns(started);
    let after = commandstats(connection).await?;
    let raw: Vec<u8> = ::redis::cmd("GET").arg(key).query_async(connection).await?;
    let value_valid = matches!(
        dialcache::protocol::decode_frame(Some(&raw), false, None)?,
        ReadResult::Hit(Frame { payload: stored, .. }) if stored == payload
    );
    Ok(Measurement {
        operations: iterations as u64,
        elapsed_ns,
        checksum,
        value_valid,
        counters: Counters {
            redis_writes: remote.writes.load(Ordering::Relaxed),
            ..Counters::default()
        },
        redis_commands: command_delta(before, after)?,
        latency_ns,
    })
}
