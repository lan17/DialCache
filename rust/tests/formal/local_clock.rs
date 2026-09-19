//! The local-clock profile driver: default-aligned instances over a shared
//! virtual grid, fractional environment ticks, immediate healthy sources.

use std::sync::Arc;

use dialcache::testing::{TestExecutor, VirtualGridClock};
use dialcache::{DialCache, Identity, Operation, Policy};
use parking_lot::Mutex;
use serde_json::{json, Map, Value};

use super::driver::WALL_EPOCH_MS;

pub struct LocalClockDriver {
    pub exec: TestExecutor,
    caches: [Option<DialCache>; 2],
    sources: Arc<Mutex<u64>>,
    calls: Vec<i64>,
}

impl std::fmt::Debug for LocalClockDriver {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LocalClockDriver").finish()
    }
}

impl LocalClockDriver {
    pub fn new() -> LocalClockDriver {
        LocalClockDriver {
            exec: TestExecutor::new(WALL_EPOCH_MS),
            caches: [None, None],
            sources: Arc::new(Mutex::new(0)),
            calls: Vec::new(),
        }
    }

    pub fn apply(&mut self, input: &Value) -> Result<(), String> {
        let instance = input.get("instance").and_then(Value::as_i64).unwrap_or(0);
        match input.get("op").and_then(Value::as_str).unwrap_or("") {
            "constructInstance" => {
                if !(0..2).contains(&instance) || self.caches[instance as usize].is_some() {
                    return Err("invalid/duplicate instance".to_string());
                }
                let cache = DialCache::builder()
                    .clock(VirtualGridClock::new(self.exec.clock.clone()))
                    .runtime_arc(self.exec.runtime.clone())
                    .build()
                    .map_err(|e| e.to_string())?;
                self.caches[instance as usize] = Some(cache);
                Ok(())
            }
            "advanceTicks" => {
                let ticks = input.get("ticks").and_then(Value::as_i64).unwrap_or(0);
                if ticks <= 0 {
                    return Err("invalid clock advance".to_string());
                }
                self.exec.advance_micros(ticks);
                Ok(())
            }
            "call" => {
                if !(0..2).contains(&instance) {
                    return Err("call before instance construction".to_string());
                }
                let Some(cache) = self.caches[instance as usize].clone() else {
                    return Err("call before instance construction".to_string());
                };
                let offered = input.get("offered").and_then(Value::as_i64).unwrap_or(0);
                let sources = self.sources.clone();
                let operation =
                    Operation::<i64>::new(Identity::new("clock", "one", "QuintLocalGrid"))
                        .policy(Policy::default().local_ttl_sec(1));
                let value = self.exec.block_on(async move {
                    let inner = cache.clone();
                    cache
                        .enable(|scope| async move {
                            inner
                                .get_or_load(&scope, operation, move |_| {
                                    let sources = sources.clone();
                                    async move {
                                        *sources.lock() += 1;
                                        Ok(offered)
                                    }
                                })
                                .await
                        })
                        .await
                });
                let value = value.map_err(|e| e.to_string())?;
                self.calls.push(*value);
                Ok(())
            }
            other => Err(format!("unknown local-clock command {other}")),
        }
    }

    pub fn observation(&self) -> Value {
        let mut o = Map::new();
        o.insert("calls".to_string(), json!(self.calls));
        o.insert("loaders".to_string(), json!(*self.sources.lock()));
        for key in [
            "reads",
            "writes",
            "invalidations",
            "loads",
            "dumps",
            "policyCalls",
            "classifications",
            "comparisons",
        ] {
            o.insert(key.to_string(), json!(0));
        }
        for key in [
            "maintenance",
            "sourceScopes",
            "writeTtls",
            "shadow",
            "recovery",
        ] {
            o.insert(key.to_string(), json!([]));
        }
        Value::Object(o)
    }
}
