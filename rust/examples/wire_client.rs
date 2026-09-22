//! One public-cache operation against a real Redis server, driven by the
//! cross-language integration coordinator. Inputs contain logical identities
//! and source values; this process derives keys and writes its own frames.

use std::collections::BTreeMap;
use std::io::{self, Read};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use dialcache::protocol::CompressionConfig;
use dialcache::{
    normalize_args, ArgValue, BoxError, DialCache, FromSync, Identity, InvalidateRequest, LogEvent,
    Logger, Operation, Payload, Policy, ReadContext, ReadRequest, ReadResult, RedisAdapter,
    RedisConnection, Remote, SourceBudget, SyncCodec, SystemClock, WriteRequest,
};
use futures::future::BoxFuture;
use parking_lot::Mutex;
use redis::cluster::ClusterClientBuilder;
use redis::{AsyncConnectionConfig, Value as RedisValue};
use serde::{Deserialize, Serialize};
use serde_json::Value;

const COMMAND_BUDGET: Duration = Duration::from_secs(5);
const PROCESS_BUDGET: Duration = Duration::from_secs(25);

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "lowercase")]
enum TaggedValue {
    Json { value: Value },
    Undefined,
    Binary { hex: String },
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum CodecKind {
    Json,
    Binary,
}

#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Command {
    Get,
    Invalidate,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Request {
    url: String,
    #[serde(default)]
    cluster: bool,
    namespace: String,
    key_type: String,
    id: String,
    use_case: String,
    args: BTreeMap<String, Value>,
    tracked: bool,
    compression: bool,
    codec: CodecKind,
    wall_ms: u64,
    op: Command,
    source: Option<TaggedValue>,
    #[serde(default)]
    future_buffer_ms: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct Response {
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<TaggedValue>,
    source_calls: usize,
    value_key: String,
    watermark_key: Option<String>,
    frame_hex: Option<String>,
    watermark: Option<String>,
    ttl_ms: i64,
    write_calls: usize,
    write_skipped_by_fence: bool,
    warnings: Vec<String>,
}

#[derive(Debug, Default)]
struct Observations {
    source_calls: AtomicUsize,
    write_calls: AtomicUsize,
    writes_completed: AtomicUsize,
    observed_watermark_ms: Mutex<Option<u64>>,
    write_errors: Mutex<Vec<String>>,
    warnings: Mutex<Vec<String>>,
}

struct ObservedRemote<C> {
    native: RedisAdapter<C>,
    observations: Arc<Observations>,
}

impl<C: RedisConnection> Remote for ObservedRemote<C> {
    fn read(
        &self,
        request: ReadRequest,
        context: ReadContext,
    ) -> BoxFuture<'_, Result<ReadResult, BoxError>> {
        Box::pin(async move {
            let result = self.native.read(request, context).await?;
            if let ReadResult::Miss {
                observed_watermark_ms,
                ..
            } = &result
            {
                *self.observations.observed_watermark_ms.lock() = *observed_watermark_ms;
            }
            Ok(result)
        })
    }

    fn write(&self, request: WriteRequest) -> BoxFuture<'_, Result<(), BoxError>> {
        Box::pin(async move {
            self.observations.write_calls.fetch_add(1, Ordering::SeqCst);
            let result = self.native.write(request).await;
            if let Err(error) = &result {
                self.observations
                    .write_errors
                    .lock()
                    .push(error.to_string());
            }
            self.observations
                .writes_completed
                .fetch_add(1, Ordering::SeqCst);
            result
        })
    }

    fn invalidate(&self, request: InvalidateRequest) -> BoxFuture<'_, Result<(), BoxError>> {
        self.native.invalidate(request)
    }
}

struct CaptureWarnings(Arc<Observations>);

impl Logger for CaptureWarnings {
    fn log(&self, event: &LogEvent) {
        self.0.warnings.lock().push(event.to_string());
    }
}

struct BinaryCodec;

impl SyncCodec<Vec<u8>> for BinaryCodec {
    fn encode(&self, value: &Vec<u8>) -> Result<Payload, BoxError> {
        Ok(Payload::binary(value.clone()))
    }

    fn decode(&self, payload: Payload) -> Result<Vec<u8>, BoxError> {
        if !payload.binary {
            return Err("Binary frame must retain its payload type".into());
        }
        Ok(payload.bytes)
    }
}

fn identity(request: &Request) -> Result<Identity, BoxError> {
    let arguments = request
        .args
        .iter()
        .map(|(name, value)| {
            let scalar = match value {
                Value::Null => ArgValue::Null,
                Value::Bool(value) => ArgValue::Bool(*value),
                Value::String(value) => ArgValue::Str(value.clone()),
                Value::Number(value) => ArgValue::Number(
                    value
                        .as_f64()
                        .ok_or("Numeric key argument is outside the shared float domain")?,
                ),
                _ => return Err("Key arguments must be scalar values".into()),
            };
            Ok((name.clone(), scalar))
        })
        .collect::<Result<Vec<_>, BoxError>>()?;
    Ok(
        Identity::new(&request.key_type, request.id.as_str(), &request.use_case)
            .namespace(&request.namespace)
            .tracked(request.tracked)
            .args(normalize_args(arguments)?),
    )
}

async fn load<T: Clone + Send + Sync + 'static>(
    cache: &DialCache,
    operation: Operation<T>,
    source: Option<T>,
    observations: Arc<Observations>,
) -> Result<Arc<T>, BoxError> {
    let enabled = cache.enable_guard();
    Ok(cache
        .get_or_load(
            enabled.scope(),
            operation
                .policy(Policy::default().remote_ttl_sec(60))
                .budget(SourceBudget::Millis(5_000)),
            move |_scope| {
                observations.source_calls.fetch_add(1, Ordering::SeqCst);
                let source = source.clone();
                async move { source.ok_or_else(|| "Cache missed without a supplied source".into()) }
            },
        )
        .await?)
}

async fn get_value(
    cache: &DialCache,
    request: &Request,
    key: Identity,
    observations: Arc<Observations>,
) -> Result<TaggedValue, BoxError> {
    match request.codec {
        CodecKind::Json => {
            let source = match &request.source {
                Some(TaggedValue::Json { value }) => Some(value.clone()),
                Some(TaggedValue::Undefined) => {
                    return Err("Rust's default JsonCodec has no distinct undefined writer".into());
                }
                Some(TaggedValue::Binary { .. }) => {
                    return Err("JSON source requires a JSON value".into());
                }
                None => None,
            };
            // Keep the native codec's documented undefined-to-null adaptation
            // visible in the result; do not fabricate a distinct undefined value.
            let value = load(cache, Operation::<Value>::new(key), source, observations).await?;
            Ok(TaggedValue::Json {
                value: value.as_ref().clone(),
            })
        }
        CodecKind::Binary => {
            let source = match &request.source {
                Some(TaggedValue::Binary { hex }) => Some(hex::decode(hex)?),
                Some(_) => return Err("Binary source requires complete hexadecimal bytes".into()),
                None => None,
            };
            let operation =
                Operation::with_codec(key, Arc::new(FromSync(BinaryCodec)), |a, b| a == b);
            let value = load(cache, operation, source, observations).await?;
            Ok(TaggedValue::Binary {
                hex: hex::encode(value.as_ref()),
            })
        }
    }
}

async fn read_bytes<C: RedisConnection>(
    connection: &C,
    key: &str,
) -> Result<Option<Vec<u8>>, BoxError> {
    let mut command = redis::cmd("GET");
    command.arg(key);
    match connection.run_on_primary(key, command).await? {
        RedisValue::Nil => Ok(None),
        RedisValue::BulkString(bytes) => Ok(Some(bytes)),
        other => Err(format!("Unexpected Redis GET reply: {other:?}").into()),
    }
}

async fn execute<C: RedisConnection + Clone>(
    request: Request,
    connection: C,
) -> Result<Response, BoxError> {
    let key = identity(&request)?;
    let keys = key.keys()?;
    let observations = Arc::new(Observations::default());
    let remote = ObservedRemote {
        native: RedisAdapter::new(connection.clone()),
        observations: observations.clone(),
    };
    let started = Instant::now();
    let wall_ms = request.wall_ms as i64;
    let clock = SystemClock::with_sources(move || started.elapsed(), move || wall_ms);
    let mut builder = DialCache::builder()
        .namespace(&request.namespace)
        .local_capacity(0)
        .remote_read_timeout_ms(5_000)
        .clock(clock)
        .remote(remote)
        .logger(CaptureWarnings(observations.clone()));
    builder = if request.compression {
        builder.compression(CompressionConfig {
            threshold_bytes: 1,
            level: 3,
        })
    } else {
        builder.disable_compression()
    };
    let cache = builder.build()?;
    let value = match request.op {
        Command::Get => Some(get_value(&cache, &request, key, observations.clone()).await?),
        Command::Invalidate => {
            cache
                .invalidate(
                    &request.key_type,
                    request.id.as_str(),
                    request.future_buffer_ms,
                )
                .await?;
            None
        }
    };

    let source_calls = observations.source_calls.load(Ordering::SeqCst);
    let write_calls = observations.write_calls.load(Ordering::SeqCst);
    let write_skipped_by_fence = source_calls > 0
        && request.tracked
        && observations
            .observed_watermark_ms
            .lock()
            .is_some_and(|watermark| request.wall_ms <= watermark);
    let expected_writes = usize::from(source_calls > 0 && !write_skipped_by_fence);
    if write_calls != expected_writes
        || observations.writes_completed.load(Ordering::SeqCst) != write_calls
        || !observations.write_errors.lock().is_empty()
    {
        return Err(format!(
            "Redis publication did not complete: expected={expected_writes}, dispatched={write_calls}, errors={:?}",
            observations.write_errors.lock()
        )
        .into());
    }

    let frame = read_bytes(&connection, &keys.value).await?;
    let watermark = match &keys.watermark {
        Some(key) => read_bytes(&connection, key)
            .await?
            .map(String::from_utf8)
            .transpose()?,
        None => None,
    };
    let mut command = redis::cmd("PTTL");
    command.arg(&keys.value);
    let ttl_ms = match connection.run_on_primary(&keys.value, command).await? {
        RedisValue::Int(ttl) => ttl,
        other => return Err(format!("Unexpected Redis PTTL reply: {other:?}").into()),
    };
    let warnings = observations.warnings.lock().clone();
    // The helper owns every cloned connection handle. Returning drops the
    // cache and handles; runtime shutdown releases the connection tasks.
    Ok(Response {
        value,
        source_calls,
        value_key: keys.value,
        watermark_key: keys.watermark,
        frame_hex: frame.map(hex::encode),
        watermark,
        ttl_ms,
        write_calls,
        write_skipped_by_fence,
        warnings,
    })
}

async fn connect_and_execute(request: Request) -> Result<Response, BoxError> {
    if request.wall_ms > dialcache::limits::MAX_SAFE_INTEGER {
        return Err("wallMs must be a nonnegative safe integer".into());
    }
    if request.cluster {
        let connection = ClusterClientBuilder::new([request.url.clone()])
            .connection_timeout(COMMAND_BUDGET)
            .response_timeout(COMMAND_BUDGET)
            .retries(0)
            .build()?
            .get_async_connection()
            .await?;
        execute(request, connection).await
    } else {
        let configuration = AsyncConnectionConfig::new()
            .set_connection_timeout(Some(COMMAND_BUDGET))
            .set_response_timeout(Some(COMMAND_BUDGET))
            .set_concurrency_limit(32);
        let connection = redis::Client::open(request.url.as_str())?
            .get_multiplexed_async_connection_with_config(&configuration)
            .await?;
        execute(request, connection).await
    }
}

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), BoxError> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    let request = serde_json::from_str(&input)?;
    let response = tokio::time::timeout(PROCESS_BUDGET, connect_and_execute(request)).await??;
    serde_json::to_writer(io::stdout().lock(), &response)?;
    Ok(())
}
