//! Bidirectional production TypeScript/Rust reads, writes and invalidation on
//! the same server. Neither language receives the other's derived key/bytes.

use std::fs::{self, File};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use dialcache::identity::{normalize_args, ArgValue, Identity, Keys};
use dialcache::protocol::{
    compress_payload, decompress_payload, escape_raw_payload, CompressionConfig,
};
use dialcache::redis::{RedisAdapter, RedisConnection};
use dialcache::{
    Frame, InvalidateRequest, JsonCodec, MissReason, Payload, ReadRequest, ReadResult, Remote,
    WriteRequest,
};
use serde_json::{json, Value};

const STAMP: u64 = 1_700_000_000_000;
const MAX_DECOMPRESSED_BYTES: usize = 512 * 1024 * 1024;

struct TypeScript {
    directory: PathBuf,
    root: PathBuf,
}

impl TypeScript {
    fn new() -> Self {
        let root = std::env::var_os("DIALCACHE_TS_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| Path::new(env!("CARGO_MANIFEST_DIR")).join(".."));
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let directory = std::env::temp_dir().join(format!(
            "dialcache-rust-interop-{}-{nonce}",
            std::process::id()
        ));
        fs::create_dir(&directory).expect("create TypeScript bundle directory");
        let script = Self { directory, root };
        // Use tsup's declared esbuild dependency, exactly as the Go integration
        // does, and import current production TypeScript rather than a fixture codec.
        let build = "const {createRequire}=require('node:module');const {buildSync}=createRequire(require.resolve('tsup'))('esbuild');buildSync({entryPoints:[process.argv[1]],outfile:process.argv[2],bundle:true,platform:'node',format:'cjs',nodePaths:[require('node:path').resolve('node_modules')]});";
        let output = Command::new("node")
            .arg("-e")
            .arg(build)
            .arg(script.root.join("go/redis_interop.ts"))
            .arg(script.directory.join("interop.cjs"))
            .current_dir(script.root.join("typescript"))
            .output()
            .expect("bundle TypeScript interop");
        assert!(
            output.status.success(),
            "TypeScript bundle failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        script
    }

    fn run(&self, endpoint: &str, cluster: bool, actions: &[Value]) -> Vec<Value> {
        let input = self.directory.join("input.json");
        let output = self.directory.join("output.json");
        let error = self.directory.join("stderr.txt");
        fs::write(
            &input,
            serde_json::to_vec(
                &json!({ "endpoint": endpoint, "cluster": cluster, "actions": actions }),
            )
            .unwrap(),
        )
        .unwrap();
        // Files keep large key-probe output from filling an unread pipe while
        // the parent waits, and let the timeout kill and reap a stuck Node child.
        let mut child = Command::new("node")
            .arg(self.directory.join("interop.cjs"))
            .current_dir(&self.root)
            .stdin(Stdio::from(File::open(input).unwrap()))
            .stdout(Stdio::from(File::create(&output).unwrap()))
            .stderr(Stdio::from(File::create(&error).unwrap()))
            .spawn()
            .expect("start TypeScript interop");
        let deadline = Instant::now() + Duration::from_secs(30);
        let status = loop {
            if let Some(status) = child.try_wait().expect("poll TypeScript interop") {
                break status;
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                let _ = child.wait();
                panic!(
                    "TypeScript interop exceeded 30 seconds: {}",
                    fs::read_to_string(&error).unwrap_or_default()
                );
            }
            std::thread::sleep(Duration::from_millis(10));
        };
        assert!(
            status.success(),
            "TypeScript interop failed: {}",
            fs::read_to_string(error).unwrap_or_default()
        );
        let results: Vec<Value> =
            serde_json::from_slice(&fs::read(output).unwrap()).expect("TypeScript JSON results");
        assert_eq!(
            results.len(),
            actions.len(),
            "every interop operation must return an observation"
        );
        results
    }
}

impl Drop for TypeScript {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.directory);
    }
}

/// Both ports receive the same scalar inputs and independently normalize them.
/// The exact double is transported as bits, not either port's decimal spelling.
fn identity(label: &str, name: &str, tracked: bool, number_bits: u64) -> (Value, Keys) {
    let namespace = format!("rust-ts-{label}");
    let args = normalize_args([
        ("case", ArgValue::Str(name.to_string())),
        ("number", ArgValue::Number(f64::from_bits(number_bits))),
        ("\u{e000}", ArgValue::Bool(false)),
        ("😀", ArgValue::Null),
    ])
    .unwrap();
    let keys = Identity::new("entity é", "shared/id", "lookup?#")
        .namespace(&namespace)
        .tracked(tracked)
        .args(args)
        .keys()
        .unwrap();
    let input = json!({
        "namespace": namespace, "keyType": "entity é", "id": "shared/id", "useCase": "lookup?#",
        "trackForInvalidation": tracked,
        "args": { "case": name, "\u{e000}": false, "😀": null },
        "numberBits": { "number": format!("{number_bits:016x}") },
    });
    (input, keys)
}

fn key_json(keys: &Keys) -> Value {
    json!({ "logical": keys.logical, "value": keys.value, "watermark": keys.watermark })
}

fn read_request(keys: &Keys) -> ReadRequest {
    ReadRequest {
        value_key: keys.value.clone(),
        watermark_key: keys.watermark.clone(),
    }
}

fn prepare(payload: Payload, compressed: bool) -> Payload {
    if compressed {
        compress_payload(
            payload,
            &CompressionConfig {
                threshold_bytes: 1,
                level: 3,
            },
            MAX_DECOMPRESSED_BYTES,
        )
        .unwrap()
        .payload
    } else {
        escape_raw_payload(payload)
    }
}

struct Case {
    identity: Value,
    keys: Keys,
    payload: Payload,
    value: Option<Value>,
    compressed: bool,
}

pub async fn exercise<C: RedisConnection>(
    adapter: &RedisAdapter<C>,
    endpoint: &str,
    cluster: bool,
    label: &str,
) {
    let script = TypeScript::new();
    // Native Number::toString is explicitly outside Quint's integer model.
    // Probe the real TS key builder with regression ties, exponent boundaries,
    // special values and deterministic whole-domain IEEE754 samples.
    let mut bits: Vec<u64> = [
        0.0_f64,
        -0.0,
        f64::from_bits(0x430c6bf526340002),
        f64::from_bits(0xc30c6bf526340002),
        f64::from_bits(0x430c6bf526340006),
        f64::from_bits(0xc30c6bf526340006),
        f64::from_bits(0x42d6bcc41e900008),
        f64::from_bits(0x42d6bcc41e900018),
        1e-6,
        1e-7,
        1e20,
        1e21,
        f64::MIN_POSITIVE,
        f64::MAX,
        f64::INFINITY,
        f64::NEG_INFINITY,
        f64::NAN,
    ]
    .into_iter()
    .map(f64::to_bits)
    .collect();
    bits.push(1); // Smallest positive subnormal.
    let mut sample = 88_172_645_463_325_252_u64;
    for _ in 0..512 {
        sample ^= sample << 13;
        sample ^= sample >> 7;
        sample ^= sample << 17;
        bits.push(sample);
    }
    let probes: Vec<_> = bits
        .into_iter()
        .enumerate()
        .map(|(index, bits)| identity(label, "number-probe", index % 2 == 0, bits))
        .collect();
    let actions: Vec<_> = probes
        .iter()
        .map(|(identity, _)| json!({ "op": "key", "identity": identity }))
        .collect();
    for ((_, expected), actual) in probes.iter().zip(script.run(endpoint, cluster, &actions)) {
        assert_eq!(
            actual["keys"],
            key_json(expected),
            "{label}: independently constructed numeric keys"
        );
    }

    let values = [
        Value::Null,
        json!(false),
        json!(0),
        json!(""),
        json!({"id": "cross-language", "nested": [1, null, false, "é😀"]}),
        json!("DialCache é😀".repeat(1000)),
    ];
    let binaries = [
        vec![],
        vec![0, 1, 2, 255, 0xe2, 0x82],
        vec![1, 0xff],
        vec![2, 0xff],
        vec![3, 0xff],
        [0, 1, 2, 255, 0xe2, 0x82].repeat(1000),
    ];
    let mut cases = Vec::new();
    for tracked in [false, true] {
        for (index, value) in values.iter().enumerate() {
            let (identity, keys) =
                identity(label, &format!("json-{index}"), tracked, 0x430c6bf526340002);
            cases.push(Case {
                identity,
                keys,
                payload: JsonCodec::encode_value(value).unwrap(),
                value: Some(value.clone()),
                compressed: index == values.len() - 1,
            });
        }
        for (index, bytes) in binaries.iter().enumerate() {
            let (identity, keys) = identity(
                label,
                &format!("binary-{index}"),
                tracked,
                0xc30c6bf526340002,
            );
            cases.push(Case {
                identity,
                keys,
                payload: Payload::binary(bytes.clone()),
                value: None,
                compressed: index == binaries.len() - 1,
            });
        }
    }
    for case in &cases {
        adapter
            .write(WriteRequest {
                value_key: case.keys.value.clone(),
                frame: Frame {
                    created_at_ms: STAMP,
                    payload: prepare(case.payload.clone(), case.compressed),
                },
                ttl_ms: 60_000,
            })
            .await
            .expect("Rust writes interop frame");
    }
    let reads: Vec<_> = cases.iter().map(|case| json!({ "op": "read", "identity": case.identity, "binary": case.value.is_none() })).collect();
    let results = script.run(endpoint, cluster, &reads);
    for (case, result) in cases.iter().zip(results) {
        assert_eq!(result["kind"], "hit", "{label}: TS reads Rust frame");
        assert_eq!(
            result["stamp"], STAMP,
            "{label}: TS preserves Rust timestamp"
        );
        assert_eq!(
            result["keys"],
            key_json(&case.keys),
            "{label}: TS derived the same keys"
        );
        if let Some(value) = &case.value {
            assert_eq!(&result["value"], value, "{label}: TS decodes Rust JSON");
        } else {
            assert_eq!(
                result["binaryHex"],
                hex::encode(&case.payload.bytes),
                "{label}: TS decodes Rust binary"
            );
        }
    }
    let writes: Vec<_> = cases.iter().map(|case| {
        let mut action = json!({ "op": "write", "identity": case.identity, "stamp": STAMP + 1, "compress": case.compressed });
        if let Some(value) = &case.value { action["value"] = value.clone(); }
        else { action["binaryHex"] = json!(hex::encode(&case.payload.bytes)); }
        action
    }).collect();
    for (case, result) in cases.iter().zip(script.run(endpoint, cluster, &writes)) {
        assert_eq!(result["kind"], "written");
        assert_eq!(result["keys"], key_json(&case.keys));
    }
    for case in &cases {
        let result = adapter
            .read(read_request(&case.keys), super::context())
            .await
            .expect("Rust reads TypeScript frame");
        let ReadResult::Hit(frame) = result else {
            panic!("{label}: Rust missed TypeScript frame: {result:?}");
        };
        assert_eq!(
            frame.created_at_ms,
            STAMP + 1,
            "{label}: must read the TypeScript overwrite"
        );
        let payload = decompress_payload(frame.payload, MAX_DECOMPRESSED_BYTES).payload;
        if let Some(expected) = &case.value {
            assert_eq!(
                &JsonCodec::decode_value::<Value>(&payload).unwrap(),
                expected,
                "{label}: Rust decodes TypeScript JSON"
            );
        } else {
            assert_eq!(
                payload, case.payload,
                "{label}: Rust decodes TypeScript binary"
            );
        }
    }

    // Rust's documented undefined adaptation is Option::None, distinct from
    // writing its own null above (which TypeScript must continue to read as null).
    let (undefined, undefined_keys) = identity(label, "undefined", true, 0);
    script.run(
        endpoint,
        cluster,
        &[json!({ "op": "write", "identity": undefined, "stamp": STAMP, "absent": true })],
    );
    let ReadResult::Hit(frame) = adapter
        .read(read_request(&undefined_keys), super::context())
        .await
        .unwrap()
    else {
        panic!("Rust must read the TypeScript undefined sentinel");
    };
    assert_eq!(
        JsonCodec::decode_value::<Option<Value>>(&frame.payload).unwrap(),
        None
    );

    let tracked = cases
        .iter()
        .find(|case| case.keys.watermark.is_some())
        .unwrap();
    script.run(endpoint, cluster, &[json!({ "op": "invalidate", "identity": tracked.identity, "stamp": STAMP + 1, "futureMs": 100 })]);
    assert_eq!(
        adapter
            .read(read_request(&tracked.keys), super::context())
            .await
            .unwrap(),
        ReadResult::Miss {
            reason: MissReason::WatermarkFenced,
            observed_watermark_ms: Some(STAMP + 101)
        },
        "{label}: TypeScript invalidation fences Rust reads"
    );
    adapter
        .write(WriteRequest {
            value_key: tracked.keys.value.clone(),
            frame: Frame {
                created_at_ms: STAMP + 102,
                payload: JsonCodec::encode_value(&json!("after invalidation")).unwrap(),
            },
            ttl_ms: 60_000,
        })
        .await
        .unwrap();
    let read = json!({ "op": "read", "identity": tracked.identity });
    let result = script.run(endpoint, cluster, std::slice::from_ref(&read));
    assert_eq!(
        result[0]["kind"], "hit",
        "{label}: TypeScript reads Rust's newer frame"
    );
    assert_eq!(result[0]["value"], "after invalidation");
    adapter
        .invalidate(InvalidateRequest {
            watermark_key: tracked.keys.watermark.clone().unwrap(),
            invalidated_at_ms: STAMP + 1,
            future_buffer_ms: 200,
        })
        .await
        .unwrap();
    let result = script.run(endpoint, cluster, &[read]);
    assert_eq!(
        result[0]["kind"], "miss",
        "{label}: Rust invalidation fences TypeScript reads"
    );
    assert_eq!(result[0]["reason"], "watermark_fenced");
    assert_eq!(result[0]["observedWatermarkMs"], STAMP + 201);
    println!("{label}: {} independent key probes and {} payloads read in both languages, plus both invalidation directions", probes.len(), cases.len());
}
