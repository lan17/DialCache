mod core;
mod redis;

use std::collections::BTreeMap;
use std::io::{self, Read};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Instant;

use dialcache::BoxError;
use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Request {
    version: u32,
    id: String,
    case: Case,
    payload: String,
    redis_url: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Case {
    id: String,
    kind: String,
    suite: String,
    scope: String,
    iterations: usize,
    warmup: usize,
    fanout: usize,
    capacity: usize,
    payload_bytes: usize,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Counters {
    source_calls: u64,
    redis_reads: u64,
    redis_writes: u64,
    coalesced_calls: u64,
}

pub type Commands = BTreeMap<String, u64>;

pub fn empty_commands() -> Commands {
    ["get", "mget", "set", "eval", "evalsha", "time"]
        .into_iter()
        .map(|command| (command.to_owned(), 0))
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Measurement {
    operations: u64,
    elapsed_ns: u64,
    checksum: u64,
    value_valid: bool,
    counters: Counters,
    redis_commands: Commands,
    latency_ns: Vec<u64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct ResultRecord {
    version: u32,
    id: String,
    port: &'static str,
    case_id: String,
    #[serde(flatten)]
    measurement: Measurement,
    runtime: RuntimeRecord,
}

#[derive(Serialize)]
struct RuntimeRecord {
    version: String,
    workers: u32,
}

pub struct Source {
    payload: String,
    calls: AtomicU64,
}

impl Source {
    pub fn new(payload: &str) -> Self {
        Self {
            payload: payload.to_owned(),
            calls: AtomicU64::new(0),
        }
    }

    pub async fn load(&self) -> String {
        self.calls.fetch_add(1, Ordering::Relaxed);
        self.payload.clone()
    }

    pub fn reset(&self) {
        self.calls.store(0, Ordering::Relaxed);
    }

    pub fn calls(&self) -> u64 {
        self.calls.load(Ordering::Relaxed)
    }
}

pub fn elapsed_ns(start: Instant) -> u64 {
    u64::try_from(start.elapsed().as_nanos()).expect("benchmark duration exceeds u64 nanoseconds")
}

fn validate_request(request: &Request) -> Result<(), BoxError> {
    let case = &request.case;
    let expected_scope = match case.kind.as_str() {
        "source-baseline" | "disabled" | "redis-write" => "none",
        "enabled-uncached" | "request-local-hit" => "single",
        "process-local-hit" | "local-eviction" | "process-coalescing" | "redis-hit"
        | "redis-tracked-hit" => "per-operation",
        "request-coalescing" => "per-burst",
        other => return Err(format!("unknown benchmark kind: {other}").into()),
    };
    let expected_suite = if case.kind.starts_with("redis-") {
        "redis"
    } else {
        "core"
    };
    let coalescing = case.kind.ends_with("-coalescing");
    if request.version != 1
        || request.id.is_empty()
        || case.id.is_empty()
        || case.scope != expected_scope
        || case.suite != expected_suite
        || case.iterations == 0
        || case.warmup == 0
        || case.capacity == 0
        || case.payload_bytes == 0
        || request.payload.len() != case.payload_bytes
        || !request.payload.bytes().all(|byte| byte == b'x')
        || (coalescing && case.fanout < 2)
        || (!coalescing && case.fanout != 1)
        || (expected_suite == "redis" && request.redis_url.as_deref().is_none_or(str::is_empty))
    {
        return Err("invalid benchmark request or workload parameters".into());
    }
    for iterations in [case.warmup, case.iterations] {
        iterations
            .checked_mul(case.fanout)
            .and_then(|operations| operations.checked_mul(case.payload_bytes))
            .ok_or("benchmark result exceeds integer range")?;
        iterations
            .checked_add(case.capacity)
            .and_then(|count| count.checked_add(1))
            .ok_or("benchmark key count exceeds integer range")?;
    }
    Ok(())
}

fn validate_measurement(
    request: &Request,
    iterations: usize,
    result: &Measurement,
) -> Result<(), BoxError> {
    let kind = request.case.kind.as_str();
    let operations = (iterations * request.case.fanout) as u64;
    let source_calls = match kind {
        "request-local-hit" | "process-local-hit" | "redis-hit" | "redis-tracked-hit"
        | "redis-write" => 0,
        _ => iterations as u64,
    };
    let coalesced_calls = if kind.ends_with("-coalescing") {
        (iterations * (request.case.fanout - 1)) as u64
    } else {
        0
    };
    let redis_reads = if matches!(kind, "redis-hit" | "redis-tracked-hit") {
        operations
    } else {
        0
    };
    let redis_writes = if kind == "redis-write" { operations } else { 0 };
    if result.operations != operations
        || result.checksum != operations * request.case.payload_bytes as u64
        || !result.value_valid
        || result.elapsed_ns == 0
        || result.counters.source_calls != source_calls
        || result.counters.coalesced_calls != coalesced_calls
        || result.counters.redis_reads != redis_reads
        || result.counters.redis_writes != redis_writes
        || result.latency_ns.len()
            != if request.case.suite == "redis" {
                iterations
            } else {
                0
            }
    {
        return Err(format!(
            "benchmark behavior validation failed: {}",
            serde_json::to_string(result)?
        )
        .into());
    }
    if kind == "redis-write"
        && (result.redis_commands["set"] != operations
            || ["eval", "evalsha", "time"]
                .iter()
                .any(|command| result.redis_commands[*command] != 0))
    {
        return Err("adapter writes must issue one SET and no scripts or TIME".into());
    }
    Ok(())
}

async fn run(request: &Request) -> Result<Measurement, BoxError> {
    let connection = if request.case.suite == "redis" {
        Some(redis::connect(request.redis_url.as_deref().unwrap()).await?)
    } else {
        None
    };
    let warmup = if let Some(connection) = &connection {
        redis::phase(request, request.case.warmup, "warmup", connection.clone()).await?
    } else {
        core::phase(request, request.case.warmup).await?
    };
    validate_measurement(request, request.case.warmup, &warmup)?;
    let result = if let Some(connection) = &connection {
        redis::phase(
            request,
            request.case.iterations,
            "measured",
            connection.clone(),
        )
        .await?
    } else {
        core::phase(request, request.case.iterations).await?
    };
    validate_measurement(request, request.case.iterations, &result)?;
    Ok(result)
}

fn main() -> Result<(), BoxError> {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input)?;
    let request: Request = serde_json::from_str(&input)?;
    validate_request(&request)?;
    let version = Command::new("rustc")
        .arg("--version")
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .output()?;
    if !version.status.success() {
        return Err("could not determine Rust toolchain version".into());
    }
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()?;
    let measurement = runtime.block_on(run(&request))?;
    let result = ResultRecord {
        version: 1,
        id: request.id,
        port: "rust",
        case_id: request.case.id,
        measurement,
        runtime: RuntimeRecord {
            version: String::from_utf8(version.stdout)?.trim().to_owned(),
            workers: 1,
        },
    };
    println!("{}", serde_json::to_string(&result)?);
    Ok(())
}
