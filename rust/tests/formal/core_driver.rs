//! The core profile driver: integer values, an in-memory remote and a wall
//! clock that moves only through `advanceWall`.

use std::collections::HashMap;
use std::sync::Arc;

use dialcache::protocol::{decode_frame, encode_frame};
use dialcache::testing::{TestExecutor, VirtualClock};
use dialcache::{
    BoxError, Clock, DialCache, Error, Identity, InvalidateRequest, Operation, Policy, ReadContext,
    ReadRequest, ReadResult, Remote, Scope, WriteRequest,
};
use futures::future::BoxFuture;
use parking_lot::Mutex;
use serde_json::{json, Map, Value};

use super::driver::WALL_EPOCH_MS;
use super::gate::Gate;

struct Entry {
    raw: Vec<u8>,
    expires: i64,
}

#[derive(Default)]
struct RemoteState {
    values: HashMap<String, Entry>,
    watermarks: HashMap<String, String>,
    reads: u64,
    writes: u64,
    read_failure: bool,
    pub discard_writes: bool,
}

struct MemoryRemote {
    state: Arc<Mutex<RemoteState>>,
    clock: Arc<VirtualClock>,
}

impl Remote for MemoryRemote {
    fn read(
        &self,
        request: ReadRequest,
        _context: ReadContext,
    ) -> BoxFuture<'_, Result<ReadResult, BoxError>> {
        let state = self.state.clone();
        let clock = self.clock.clone();
        Box::pin(async move {
            let mut s = state.lock();
            s.reads += 1;
            if s.read_failure {
                return Err("controlled read failure".into());
            }
            let elapsed = clock.elapsed_ms();
            let raw = s
                .values
                .get(&request.value_key)
                .filter(|entry| elapsed < entry.expires)
                .map(|entry| entry.raw.clone());
            let watermark = request
                .watermark_key
                .as_ref()
                .and_then(|key| s.watermarks.get(key).cloned());
            let tracked = request.watermark_key.is_some();
            Ok(decode_frame(
                raw.as_deref(),
                tracked,
                watermark.as_deref().map(str::as_bytes),
            )?)
        })
    }

    fn write(&self, request: WriteRequest) -> BoxFuture<'_, Result<(), BoxError>> {
        let state = self.state.clone();
        let clock = self.clock.clone();
        Box::pin(async move {
            let mut s = state.lock();
            s.writes += 1;
            if s.discard_writes {
                return Ok(());
            }
            let raw = encode_frame(&request.frame)?;
            let expires = clock.elapsed_ms() + request.ttl_ms as i64;
            s.values.insert(request.value_key, Entry { raw, expires });
            Ok(())
        })
    }

    fn invalidate(&self, request: InvalidateRequest) -> BoxFuture<'_, Result<(), BoxError>> {
        let state = self.state.clone();
        Box::pin(async move {
            let mut s = state.lock();
            s.writes += 1;
            let mut cutoff = request.invalidated_at_ms + request.future_buffer_ms;
            let old: u64 = s
                .watermarks
                .get(&request.watermark_key)
                .and_then(|w| w.parse().ok())
                .unwrap_or(0);
            if cutoff < old {
                cutoff = old;
            }
            s.watermarks
                .insert(request.watermark_key, cutoff.to_string());
            Ok(())
        })
    }
}

/// The core driver over one cache instance.
pub struct CoreDriver {
    pub exec: TestExecutor,
    cache: DialCache,
    remote: Arc<Mutex<RemoteState>>,
    clock: Arc<VirtualClock>,
    source: Arc<Mutex<i64>>,
    last: i64,
    loaders: Arc<Mutex<HashMap<String, u64>>>,
}

impl std::fmt::Debug for CoreDriver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CoreDriver").finish()
    }
}

fn text(value: Option<&Value>) -> String {
    value.and_then(Value::as_str).unwrap_or("").to_string()
}

impl CoreDriver {
    pub fn new() -> CoreDriver {
        Self::with_discarded_writes(false)
    }

    /// A broken driver whose remote acknowledges writes it never stores.
    pub fn with_discarded_writes(discard: bool) -> CoreDriver {
        let exec = TestExecutor::new(WALL_EPOCH_MS);
        let clock = exec.clock.clone();
        let remote = Arc::new(Mutex::new(RemoteState {
            discard_writes: discard,
            ..RemoteState::default()
        }));
        let cache = DialCache::builder()
            .clock_arc(clock.clone())
            .runtime_arc(exec.runtime.clone())
            .remote_arc(Arc::new(MemoryRemote {
                state: remote.clone(),
                clock: clock.clone(),
            }))
            .local_capacity(10_000)
            .build()
            .expect("core driver configuration");
        CoreDriver {
            exec,
            cache,
            remote,
            clock,
            source: Arc::new(Mutex::new(1)),
            last: 0,
            loaders: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub fn wall_ms(&self) -> i64 {
        self.clock.wall_ms()
    }

    fn operation(identity: Identity, policy: &Value) -> Result<Operation<i64>, String> {
        let policy = Policy::from_json(policy).map_err(|e| e.to_string())?;
        Ok(Operation::<i64>::new(identity).policy(policy))
    }

    fn loader(
        &self,
        counter: &str,
        gate: Option<Gate<()>>,
        started: Option<Arc<Mutex<u64>>>,
    ) -> impl Fn(Scope) -> BoxFuture<'static, Result<i64, BoxError>> + Send + Sync + Clone + 'static
    {
        let loaders = self.loaders.clone();
        let source = self.source.clone();
        let counter = counter.to_string();
        move |_scope: Scope| {
            let loaders = loaders.clone();
            let source = source.clone();
            let counter = counter.clone();
            let gate = gate.clone();
            let started = started.clone();
            Box::pin(async move {
                let value = {
                    *loaders.lock().entry(counter).or_insert(0) += 1;
                    *source.lock()
                };
                if let Some(started) = started {
                    *started.lock() += 1;
                }
                if let Some(gate) = gate {
                    gate.wait().await;
                }
                Ok(value)
            })
        }
    }

    /// Apply one core command. Only the selected public action reaches the
    /// driver; publication is observed through later actual calls.
    pub fn apply(&mut self, input: &Value) -> Result<(), String> {
        match text(input.get("op")).as_str() {
            "advanceWall" => {
                let ms = input.get("ms").and_then(Value::as_i64).unwrap_or(0);
                self.clock.shift(ms, true);
                Ok(())
            }
            "bumpSource" => {
                *self.source.lock() += 1;
                Ok(())
            }
            "invalidate" => {
                let identity = input.get("identity").cloned().unwrap_or(Value::Null);
                let cache = self.cache.clone();
                let key_type = text(identity.get("keyType"));
                let id = text(identity.get("id"));
                self.exec
                    .block_on(async move { cache.invalidate(&key_type, &id, 0).await })
                    .map_err(|e| e.to_string())
            }
            "call" => self.call(input),
            other => Err(format!("unknown core driver command {other}")),
        }
    }

    fn call(&mut self, input: &Value) -> Result<(), String> {
        let identity_json = input.get("identity").cloned().unwrap_or(Value::Null);
        let identity = Identity::new(
            text(identity_json.get("keyType")),
            text(identity_json.get("id")),
            text(identity_json.get("useCase")),
        )
        .namespace("urn")
        .tracked(identity_json.get("tracked") == Some(&Value::Bool(true)));
        let operation = Self::operation(identity, input.get("policy").unwrap_or(&Value::Null))?;
        let counter = text(input.get("counter"));
        let read_failure = input.get("readFailure") == Some(&Value::Bool(true));
        self.remote.lock().read_failure = read_failure;
        let outcome: Result<i64, Error> = match text(input.get("mode")).as_str() {
            "outside" => {
                let cache = self.cache.clone();
                let load = self.loader(&counter, None, None);
                self.exec.block_on(async move {
                    cache
                        .get_or_load(&Scope::outside(), operation, load)
                        .await
                        .map(|v| *v)
                })
            }
            "single" => {
                let cache = self.cache.clone();
                let load = self.loader(&counter, None, None);
                self.exec.block_on(async move {
                    let inner = cache.clone();
                    cache
                        .enable(|scope| async move {
                            inner.get_or_load(&scope, operation, load).await.map(|v| *v)
                        })
                        .await
                })
            }
            "request-pair" => {
                let cache = self.cache.clone();
                let load = self.loader(&counter, None, None);
                self.exec.block_on(async move {
                    let inner = cache.clone();
                    cache
                        .enable(|scope| async move {
                            let first = inner
                                .get_or_load(&scope, operation.clone(), load.clone())
                                .await?;
                            let second = inner.get_or_load(&scope, operation, load).await?;
                            if *first != *second {
                                return Err(Error::Config(dialcache::ConfigError::Invalid(
                                    "request pair differs".to_string(),
                                )));
                            }
                            Ok(*first)
                        })
                        .await
                })
            }
            "coalesced-pair" => self.pair(operation, &counter),
            other => Err(Error::Config(dialcache::ConfigError::Invalid(format!(
                "unknown core call mode {other}"
            )))),
        };
        self.remote.lock().read_failure = false;
        match outcome {
            Ok(value) => {
                self.last = value;
                Ok(())
            }
            Err(error) => Err(error.to_string()),
        }
    }

    /// Two enabled callers whose leader source stays open until both have
    /// started, so overlap is real. A warm cache completes the first call
    /// before the second starts; lost sharing stays observable in loader counts.
    fn pair(&mut self, operation: Operation<i64>, counter: &str) -> Result<i64, Error> {
        let gate: Gate<()> = Gate::new();
        let started = Arc::new(Mutex::new(0u64));
        let results: Arc<Mutex<Vec<Result<i64, Error>>>> = Arc::new(Mutex::new(Vec::new()));
        let results_handle = results.clone();
        let load = self.loader(counter, Some(gate.clone()), Some(started.clone()));
        let cache = self.cache.clone();
        let make_call = move || {
            let cache = cache.clone();
            let operation = operation.clone();
            let load = load.clone();
            let results = results.clone();
            async move {
                let inner = cache.clone();
                let result = cache
                    .enable(|scope| async move {
                        inner.get_or_load(&scope, operation, load).await.map(|v| *v)
                    })
                    .await;
                results.lock().push(result);
            }
        };
        self.exec.spawn(make_call());
        self.exec.drain();
        self.exec.spawn(make_call());
        self.exec.drain();
        gate.settle(());
        self.exec.drain();
        let results = std::mem::take(&mut *results_handle.lock());
        if results.len() != 2 {
            return Err(Error::Config(dialcache::ConfigError::Invalid(
                "coalesced pair did not complete".to_string(),
            )));
        }
        let mut values = Vec::new();
        for result in results {
            values.push(result?);
        }
        if values[0] != values[1] {
            return Err(Error::Config(dialcache::ConfigError::Invalid(
                "pair returned different values".to_string(),
            )));
        }
        Ok(values[0])
    }

    pub fn observation(&self) -> Value {
        let remote = self.remote.lock();
        let loaders = self.loaders.lock();
        let mut out = Map::new();
        out.insert("sourceVersion".to_string(), json!(*self.source.lock()));
        out.insert("lastResult".to_string(), json!(self.last));
        out.insert("redisReads".to_string(), json!(remote.reads));
        out.insert("redisWrites".to_string(), json!(remote.writes));
        for field in [
            "outsideLoaderCalls",
            "requestLoaderCalls",
            "localLoaderCalls",
            "coalescedLoaderCalls",
            "remoteLoaderCalls",
        ] {
            out.insert(
                field.to_string(),
                json!(loaders.get(field).copied().unwrap_or(0)),
            );
        }
        Value::Object(out)
    }
}
