//! Real-server replay of the invalidation transition vectors
//! (`formal/PROTOCOL.md`, "Invalidation vector schema 2").
//!
//! Mirrors `go/redis_integration_test.go` `testInvalidationVectors`: the 49
//! fixed vectors of `formal/invalidation-vectors.json` are merged with the
//! 288 Quint-generated vectors of `formal/quint-invalidation-vectors.json`
//! after the generated corpus's provenance fingerprints are verified. Each
//! vector installs `existing` atomically, runs the adapter's raw decimal
//! invalidation, then observes type, content and retention atomically and
//! compares them with `expected.state`. TTL comparison subtracts only the
//! server time measured between setup and observation; persistence (`-1`)
//! and absence (`-2`) are exact.
//!
//! Every function takes the adapter and a connection so the including test
//! binary owns Docker orchestration and stays small. Include with
//! `#[path = "formal/invalidation_vectors.rs"] mod invalidation_vectors;`.

#![allow(dead_code)]

use std::fs;
use std::path::Path;

use dialcache::redis::{RedisAdapter, RedisConnection};
use redis::Value;
use serde::Deserialize;

/// Fixed corpus size pinned by every port.
pub const FIXED_VECTORS: usize = 49;
/// Generated corpus size pinned by every port.
pub const GENERATED_VECTORS: usize = 288;
const SCHEMA_VERSION: u64 = 2;
const MODEL: &str = "formal/dialcache-invalidation-transition.qnt";
const GENERATOR: &str = "formal/generate-invalidation-vectors.mjs";

/// One tagged Redis key state: `absent`, `string` with `value`, or `list`
/// with ordered `values`; `ttl_ms` is `-2` absent, `-1` persistent or positive.
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct State {
    pub kind: String,
    #[serde(default)]
    pub value: Option<String>,
    #[serde(default)]
    pub values: Option<Vec<String>>,
    pub ttl_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Expected {
    #[serde(default)]
    pub error: bool,
    pub state: State,
}

#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct Vector {
    pub name: String,
    pub existing: State,
    /// Raw decimal argument text, passed to the script unparsed.
    pub future_buffer_ms: String,
    /// Raw decimal argument text, passed to the script unparsed.
    pub invalidated_at_ms: String,
    pub expected: Expected,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Corpus {
    schema_version: u64,
    #[serde(default)]
    provenance: Option<Provenance>,
    vectors: Vec<Vector>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Provenance {
    model: String,
    source_sha256: std::collections::BTreeMap<String, String>,
}

fn read(repo_root: &Path, relative: &str) -> Vec<u8> {
    let path = repo_root.join(relative);
    fs::read(&path).unwrap_or_else(|error| panic!("read {}: {error}", path.display()))
}

/// Load and merge both corpora exactly as Go does. `sha256_hex` fingerprints
/// the generator's model and script sources so stale generated vectors are
/// rejected rather than replayed.
pub fn load_corpus(repo_root: &Path, sha256_hex: impl Fn(&[u8]) -> String) -> Vec<Vector> {
    let fixed: Corpus =
        serde_json::from_slice(&read(repo_root, "formal/invalidation-vectors.json"))
            .expect("parse fixed invalidation corpus");
    assert_eq!(
        fixed.schema_version, SCHEMA_VERSION,
        "unsupported fixed corpus schema"
    );
    assert_eq!(
        fixed.vectors.len(),
        FIXED_VECTORS,
        "unsupported fixed corpus size"
    );

    let generated: Corpus =
        serde_json::from_slice(&read(repo_root, "formal/quint-invalidation-vectors.json"))
            .expect("parse Quint invalidation corpus");
    assert_eq!(
        generated.schema_version, SCHEMA_VERSION,
        "unsupported Quint corpus schema"
    );
    assert_eq!(
        generated.vectors.len(),
        GENERATED_VECTORS,
        "unsupported Quint corpus size"
    );
    let provenance = generated
        .provenance
        .expect("Quint corpus records provenance");
    assert_eq!(
        provenance.model, MODEL,
        "invalid Quint invalidation provenance"
    );
    assert_eq!(
        provenance.source_sha256.len(),
        2,
        "invalid Quint invalidation provenance"
    );
    for source in [MODEL, GENERATOR] {
        let actual = sha256_hex(&read(repo_root, source));
        assert_eq!(
            provenance.source_sha256.get(source),
            Some(&actual),
            "stale Quint invalidation vectors for {source}; regenerate and review"
        );
    }
    for (index, vector) in generated.vectors.iter().enumerate() {
        assert!(
            vector.name.starts_with(&format!("Quint {index:03}: ")),
            "incomplete or reordered Quint invalidation combinations at {index}: {}",
            vector.name
        );
    }

    let mut vectors = fixed.vectors;
    vectors.extend(generated.vectors);
    vectors
}

/// Install `existing` atomically and return the server clock in epoch ms.
const SETUP: &str = r#"redis.replicate_commands()
local now=redis.call("TIME")
redis.call("DEL",KEYS[1])
if ARGV[1]=="string" then redis.call("SET",KEYS[1],ARGV[2]) end
if ARGV[1]=="list" then for _,value in ipairs(cjson.decode(ARGV[2])) do redis.call("RPUSH",KEYS[1],value) end end
if tonumber(ARGV[3])>0 then redis.call("PEXPIRE",KEYS[1],ARGV[3]) end
return tonumber(now[1])*1000+math.floor(tonumber(now[2])/1000)"#;

/// Observe type, content, retention and the server clock atomically.
const OBSERVE: &str = r#"local kind=redis.call("TYPE",KEYS[1]).ok
local content={}
if kind=="string" then content=redis.call("GET",KEYS[1]) end
if kind=="list" then content=redis.call("LRANGE",KEYS[1],0,-1) end
if kind=="none" then kind="absent" end
local ttl=redis.call("PTTL",KEYS[1]);local now=redis.call("TIME")
return {kind,content,ttl,tonumber(now[1])*1000+math.floor(tonumber(now[2])/1000)}"#;

fn text(value: &Value) -> Result<String, String> {
    match value {
        Value::BulkString(bytes) => {
            String::from_utf8(bytes.clone()).map_err(|error| format!("non-UTF-8 reply: {error}"))
        }
        Value::SimpleString(text) => Ok(text.clone()),
        other => Err(format!("expected a string reply, got {other:?}")),
    }
}

fn integer(value: &Value) -> Result<i64, String> {
    match value {
        Value::Int(integer) => Ok(*integer),
        other => Err(format!("expected an integer reply, got {other:?}")),
    }
}

/// What the server holds after the transition.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Observed {
    pub kind: String,
    pub value: Option<String>,
    pub values: Option<Vec<String>>,
    pub ttl_ms: i64,
    pub now_ms: i64,
}

fn observed(reply: Value) -> Result<Observed, String> {
    let Value::Array(items) = reply else {
        return Err(format!("observe returned {reply:?}"));
    };
    let [kind, content, ttl, now]: [Value; 4] = items
        .try_into()
        .map_err(|items| format!("observe returned {items:?}"))?;
    let kind = text(&kind)?;
    let (value, values) = match kind.as_str() {
        "string" => (Some(text(&content)?), None),
        "list" => {
            let Value::Array(entries) = content else {
                return Err(format!("list content {content:?}"));
            };
            let entries = entries.iter().map(text).collect::<Result<Vec<_>, _>>()?;
            (None, Some(entries))
        }
        _ => (None, None),
    };
    Ok(Observed {
        kind,
        value,
        values,
        ttl_ms: integer(&ttl)?,
        now_ms: integer(&now)?,
    })
}

/// Compare an observed state with `want` under the PROTOCOL.md TTL rule.
pub fn compare(want: &State, got: &Observed, elapsed_ms: i64) -> Result<(), String> {
    if elapsed_ms < 0 {
        return Err("server time moved backwards".to_string());
    }
    if got.kind != want.kind {
        return Err(format!("kind {} want {}", got.kind, want.kind));
    }
    match want.kind.as_str() {
        "string" if got.value != want.value => {
            return Err(format!("content {:?} want {:?}", got.value, want.value));
        }
        "list" if got.values != want.values => {
            return Err(format!("list {:?} want {:?}", got.values, want.values));
        }
        _ => {}
    }
    if want.ttl_ms < 0 {
        if got.ttl_ms != want.ttl_ms {
            return Err(format!("TTL {} want {}", got.ttl_ms, want.ttl_ms));
        }
    } else {
        let minimum = (want.ttl_ms - elapsed_ms).max(0);
        if got.ttl_ms < minimum || got.ttl_ms > want.ttl_ms {
            return Err(format!(
                "TTL {} outside [{minimum},{}], measured elapsed={elapsed_ms}",
                got.ttl_ms, want.ttl_ms
            ));
        }
    }
    Ok(())
}

/// Replay one vector against `key` through `adapter`; fixture commands run on
/// the key's primary through `connection`.
pub async fn replay<C: RedisConnection>(
    adapter: &RedisAdapter<C>,
    connection: &C,
    key: &str,
    vector: &Vector,
) -> Result<(), String> {
    let content = match vector.existing.kind.as_str() {
        "list" => serde_json::to_string(vector.existing.values.as_deref().unwrap_or_default())
            .map_err(|error| error.to_string())?,
        _ => vector.existing.value.clone().unwrap_or_default(),
    };
    let mut setup = redis::cmd("EVAL");
    setup
        .arg(SETUP)
        .arg(1)
        .arg(key)
        .arg(&vector.existing.kind)
        .arg(content)
        .arg(vector.existing.ttl_ms);
    let start_ms = integer(
        &connection
            .run_on_primary(key, setup)
            .await
            .map_err(|error| format!("setup: {error}"))?,
    )?;

    let result = adapter
        .invalidate_decimal(key, &vector.future_buffer_ms, &vector.invalidated_at_ms)
        .await;
    if result.is_err() != vector.expected.error {
        return Err(format!(
            "error={:?} expected rejection={}",
            result.err().map(|error| error.to_string()),
            vector.expected.error
        ));
    }

    let mut observe = redis::cmd("EVAL");
    observe.arg(OBSERVE).arg(1).arg(key);
    let got = observed(
        connection
            .run_on_primary(key, observe)
            .await
            .map_err(|error| format!("observe: {error}"))?,
    )?;
    compare(&vector.expected.state, &got, got.now_ms - start_ms)
}

/// Replay every vector under `key_prefix`. Returns the number replayed, or
/// every failure as `name: reason`.
pub async fn replay_all<C: RedisConnection>(
    adapter: &RedisAdapter<C>,
    connection: &C,
    key_prefix: &str,
    vectors: &[Vector],
) -> Result<usize, Vec<String>> {
    let mut failures = Vec::new();
    for vector in vectors {
        let key = format!("{key_prefix}{}", vector.name);
        if let Err(reason) = replay(adapter, connection, &key, vector).await {
            failures.push(format!("{}: {reason}", vector.name));
        }
    }
    if failures.is_empty() {
        Ok(vectors.len())
    } else {
        Err(failures)
    }
}
