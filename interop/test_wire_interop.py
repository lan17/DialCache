"""All six language pairs exchanging entries through full public cache clients.

W01/W02 cover independently derived identity; W04 and W06-W08 cover frames
and compression; W09 covers entity fences. These are native adapter/value
boundaries (E01/B03), using the existing portable contract, not a new model.
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import subprocess
from itertools import permutations
from pathlib import Path
from uuid import uuid4

import pytest
import redis.asyncio as redis
from dialcache import UNDEFINED, DialCache, Key, Policy
from dialcache.clock import SystemClock
from dialcache.key import normalize_args
from dialcache.protocol import Miss
from dialcache.redis import RedisAdapter

pytestmark = pytest.mark.integration
ROOT = Path(__file__).resolve().parents[1]
STAMP = 1_000_000
LANGUAGES = ("python", "typescript", "go", "rust")
DIRECTIONS = list(permutations(LANGUAGES, 2))

# Inputs, not expected protocol bytes. Each native cache serializes its source
# result, builds its own key, and publishes through its real Redis adapter.
VALUES = [
    pytest.param(
        {
            "kind": "json",
            "value": {
                "text": "雪 😀",
                "values": [None, False, True, 0, "", 42, 1.5],
                "wide": "9007199254740993",
                "sentinel": "__dialcache_json_undefined_v1__",
            },
        },
        False,
        None,
        id="json-raw",
    ),
    pytest.param({"kind": "json", "value": {"text": "雪 😀 " * 2048}}, True, 1, id="json-zstd"),
    pytest.param({"kind": "json", "value": None}, False, None, id="null"),
    pytest.param({"kind": "undefined"}, False, None, id="undefined"),
    pytest.param({"kind": "binary", "hex": "00ff010203"}, False, 0, id="binary-escaped"),
    pytest.param({"kind": "binary", "hex": (b"\x02\x00\xffabc" * 2048).hex()}, True, 2, id="binary-zstd"),
]

# Rust's native JSON codec reads the undefined sentinel as null and has no
# distinct undefined source value. Exercise all supported readers explicitly,
# without skipping cases or disguising null as an undefined write.
VALUE_CASES = [
    pytest.param(writer, reader, *case.values, id=f"{writer}-to-{reader}-{case.id}")
    for writer, reader in DIRECTIONS
    for case in VALUES
    if not (writer == "rust" and case.values[0]["kind"] == "undefined")
]


def assert_value(actual, expected):
    """JSON equality preserves booleans while accepting equivalent numbers."""
    if isinstance(expected, dict):
        assert isinstance(actual, dict) and actual.keys() == expected.keys()
        for key in expected:
            assert_value(actual[key], expected[key])
    elif isinstance(expected, list):
        assert isinstance(actual, list) and len(actual) == len(expected)
        for left, right in zip(actual, expected, strict=True):
            assert_value(left, right)
    else:
        assert isinstance(actual, bool) == isinstance(expected, bool)
        assert actual == expected


class WallClock(SystemClock):
    """Fixed application timestamp; deadlines still use real monotonic timers."""

    def __init__(self, wall_ms):
        self.wall = wall_ms

    def wall_ms(self):
        return self.wall


class BytesSerializer:
    def dump(self, value):
        assert isinstance(value, bytes)
        return value

    def load(self, payload):
        assert isinstance(payload, bytes)
        return payload


class ObservedRedisAdapter(RedisAdapter):
    """Count real writes without replacing serialization or Redis commands."""

    def __init__(self, client):
        super().__init__(client)
        self.writes = 0
        self.completed_writes = 0
        self.observed_watermark = None

    async def read(self, request, context=None):
        result = await super().read(request, context)
        if isinstance(result, Miss):
            self.observed_watermark = result.observed_watermark_ms
        return result

    async def write(self, request):
        self.writes += 1
        await super().write(request)
        self.completed_writes += 1


def descriptor(value):
    if value is UNDEFINED:
        return {"kind": "undefined"}
    if isinstance(value, bytes):
        return {"kind": "binary", "hex": value.hex()}
    return {"kind": "json", "value": value}


def native_value(source):
    if source["kind"] == "undefined":
        return UNDEFINED
    if source["kind"] == "binary":
        return bytes.fromhex(source["hex"])
    return source["value"]


def key_for(identity):
    return Key(
        identity["namespace"],
        identity["keyType"],
        identity["id"],
        identity["useCase"],
        normalize_args(identity["args"]),
        identity["tracked"],
    )


@pytest.fixture(scope="session")
def clients(tmp_path_factory):
    node = os.environ.get("NODE") or shutil.which("node")
    assert node, "Node 24 is required for full-client interoperability"
    directory = tmp_path_factory.mktemp("wire-clients")
    bundle = directory / "client.cjs"
    # Match the Go/Rust integration bundler: production source and declared
    # dependencies only, without relying on an old dist/ or registry release.
    build = """
const {createRequire} = require('node:module');
const {buildSync} = createRequire(require.resolve('tsup'))('esbuild');
buildSync({entryPoints:[process.argv[1]],outfile:process.argv[2],bundle:true,
  platform:'node',format:'cjs',nodePaths:[require('node:path').resolve('node_modules')]});
"""
    result = subprocess.run(
        [node, "-e", build, str(ROOT / "typescript/test/python-interop-client.ts"), str(bundle)],
        cwd=ROOT / "typescript",
        capture_output=True,
        text=True,
        timeout=30,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    go = directory / "go-client"
    result = subprocess.run(
        ["go", "build", "-o", str(go), "../interop/go-client.go"],
        cwd=ROOT / "go",
        capture_output=True,
        text=True,
        timeout=300,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    target = Path(os.environ.get("CARGO_TARGET_DIR", ROOT / "rust/target"))
    if not target.is_absolute():
        target = ROOT / "rust" / target
    result = subprocess.run(
        [
            "cargo",
            "build",
            "--locked",
            "--all-features",
            "--example",
            "wire_client",
            "--target-dir",
            str(target),
        ],
        cwd=ROOT / "rust",
        capture_output=True,
        text=True,
        timeout=300,
    )
    assert result.returncode == 0, result.stdout + result.stderr
    return {
        "typescript": [node, str(bundle)],
        "go": [str(go)],
        "rust": [str(target / "debug/examples/wire_client")],
    }


@pytest.fixture(params=["standalone", "cluster"])
async def backend(request):
    cluster = request.param == "cluster"
    variable = "TEST_REDIS_CLUSTER_URL" if cluster else "TEST_REDIS_URL"
    url = os.environ.get(variable)
    if not url:
        pytest.skip(f"Set {variable} for full-client interoperability")
    client_type = redis.RedisCluster if cluster else redis.Redis
    client = client_type.from_url(url, decode_responses=False, socket_timeout=5, socket_connect_timeout=5)
    try:
        await client.ping()
        yield {"url": url, "cluster": cluster, "client": client}
    finally:
        await client.aclose()


@pytest.fixture
async def identities(backend):
    identity = {
        "namespace": "dialcache-wire-" + uuid4().hex,
        "keyType": "entity:/é",
        "id": "9007199254740993:/ 雪",
        "useCase": "get/profile?雪",
        # Deliberately unsorted, with distinct Unicode scalar / UTF-16 orders.
        "args": {
            "z": "雪:/?&=#",
            "\ue000": 1,
            "\U00010000": 2,
            "bool": True,
            "none": None,
            "number": 1e-7,
            "wide": "9007199254740993",
        },
        "tracked": True,
    }
    owned = []

    def register(**changes):
        selected = {**identity, **changes}
        owned.append(key_for(selected))
        return selected

    try:
        yield register
    finally:
        # Individual commands also work when the owned entities occupy different
        # Cluster slots. Never flush shared data or scan unrelated namespaces.
        for key in owned:
            await backend["client"].delete(key.value_key)
            if key.watermark_key:
                await backend["client"].delete(key.watermark_key)


async def snapshot(client, key):
    raw = await client.get(key.value_key)
    watermark = await client.get(key.watermark_key) if key.watermark_key else None
    return {
        "valueKey": key.value_key,
        "watermarkKey": key.watermark_key,
        "frameHex": None if raw is None else raw.hex(),
        "watermark": None if watermark is None else watermark.decode(),
        "ttlMs": await client.pttl(key.value_key),
    }


async def invoke(
    language,
    backend,
    clients,
    identity,
    *,
    wall=STAMP,
    source=None,
    compression=False,
    op="get",
    future_buffer=0,
):
    codec = "binary" if source is not None and source["kind"] == "binary" else "json"
    if language != "python":
        message = {
            **identity,
            "url": backend["url"],
            "cluster": backend["cluster"],
            "wallMs": wall,
            "op": op,
            "codec": codec,
            "compression": compression,
            "futureBufferMs": future_buffer,
        }
        if source is not None:
            message["source"] = source
        process = await asyncio.create_subprocess_exec(
            *clients[language],
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        try:
            async with asyncio.timeout(30):
                stdout, stderr = await process.communicate(json.dumps(message).encode())
        except BaseException:
            if process.returncode is None:
                process.kill()
            await process.communicate()
            raise
        assert process.returncode == 0, stdout.decode() + stderr.decode()
        result = json.loads(stdout)
        assert result.get("warnings", []) == [], result.get("warnings")
        return result

    events = []
    adapter = ObservedRedisAdapter(backend["client"])
    cache = DialCache(
        namespace=identity["namespace"],
        redis=adapter,
        read_timeout_ms=5_000,
        clock=WallClock(wall),
        metrics=events.append,
        compression=compression,
        serializer=BytesSerializer() if codec == "binary" else None,
    )
    source_calls = 0

    async def load():
        nonlocal source_calls
        source_calls += 1
        return native_value(source)

    if op == "invalidate":
        await cache.invalidate_remote(identity["keyType"], identity["id"], future_buffer)
        result = {}
    else:
        async with cache.enable():
            value = await cache.get_or_load(
                load,
                key={"id": identity["id"], "args": identity["args"]},
                key_type=identity["keyType"],
                use_case=identity["useCase"],
                track_for_invalidation=identity["tracked"],
                default_config=Policy(ttl_sec={"remote": 60}),
            )
        result = {"value": descriptor(value), "sourceCalls": source_calls}
    assert not [event for event in events if event["event"] == "error"], events
    fenced = (
        identity["tracked"] and adapter.observed_watermark is not None and wall <= adapter.observed_watermark
    )
    expected_writes = 1 if source_calls and not fenced else 0
    assert adapter.writes == adapter.completed_writes == expected_writes
    return {**result, **await snapshot(backend["client"], key_for(identity))}


@pytest.mark.parametrize("tracked", [False, True], ids=["untracked", "tracked"])
@pytest.mark.parametrize("writer,reader,source,compress,marker", VALUE_CASES)
async def test_bidirectional_cache_values(
    backend, clients, identities, writer, reader, tracked, source, compress, marker
):
    identity = identities(tracked=tracked)
    written = await invoke(writer, backend, clients, identity, source=source, compression=compress)
    assert_value(written["value"], source)
    assert written["sourceCalls"] == 1
    assert written["watermark"] is None  # Fills never create invalidation fences.
    assert 0 < written["ttlMs"] <= 60_000
    raw = bytes.fromhex(written["frameHex"])
    assert raw[0] == 1 and int.from_bytes(raw[1:9], "big") == STAMP
    assert raw[9] == (1 if marker is not None else 0)
    if marker is not None:
        assert raw[10] == marker
    if compress:
        assert raw[11:15] == bytes.fromhex("28b52ffd")  # A real Zstandard frame.

    wrong = (
        {"kind": "binary", "hex": "ff"}
        if source["kind"] == "binary"
        else {
            "kind": "json",
            "value": "unexpected reader source",
        }
    )
    # Disabling new compression must still decode another language's compressed
    # entries. A distinct source value plus its call count rules out fail-open.
    read = await invoke(reader, backend, clients, identity, wall=STAMP + 1, source=wrong)
    expected = (
        {"kind": "json", "value": None} if reader == "rust" and source["kind"] == "undefined" else source
    )
    assert_value(read["value"], expected)
    assert read["sourceCalls"] == 0
    for field in ["valueKey", "watermarkKey", "frameHex", "watermark"]:
        assert read[field] == written[field]


@pytest.mark.parametrize("writer,invalidator", DIRECTIONS)
async def test_bidirectional_tracked_invalidation(backend, clients, identities, writer, invalidator):
    primary = identities()
    variant = identities(useCase="other/use-case", args={"locale": "fr"})
    unrelated = identities(id="other-entity")
    initial = {"kind": "json", "value": {"version": 1, "text": "old 雪" * 2048}}
    fresh = {"kind": "json", "value": {"version": 2, "text": "new 😀" * 2048}}
    wrong = {"kind": "json", "value": "unexpected source"}
    before = {}
    for identity in [primary, variant, unrelated]:
        filled = await invoke(writer, backend, clients, identity, source=initial, compression=True)
        assert filled["sourceCalls"] == 1
        assert_value(filled["value"], initial)
        assert filled["watermark"] is None
        assert bytes.fromhex(filled["frameHex"])[9:11] == b"\x01\x01"
        before[filled["valueKey"]] = filled["frameHex"]
        hit = await invoke(invalidator, backend, clients, identity, wall=STAMP + 1, source=wrong)
        assert hit["sourceCalls"] == 0
        assert_value(hit["value"], initial)

    cutoff = STAMP + 100 + 50
    invalidated = await invoke(
        invalidator, backend, clients, primary, wall=STAMP + 100, op="invalidate", future_buffer=50
    )
    assert invalidated["watermark"] == str(cutoff)
    # Invalidation preserves value bytes; subsequent misses must come from the
    # entity watermark, not DEL, expiry, mismatched identity, or local storage.
    for identity in [primary, variant]:
        key = key_for(identity)
        state = await snapshot(backend["client"], key)
        assert state["frameHex"] == before[key.value_key]
        assert state["watermark"] == str(cutoff)
        fenced = await invoke(writer, backend, clients, identity, wall=cutoff, source=fresh)
        assert fenced["sourceCalls"] == 1
        assert_value(fenced["value"], fresh)
        assert fenced["frameHex"] == before[key.value_key]  # Equality cannot refill.

        refilled = await invoke(
            writer, backend, clients, identity, wall=cutoff + 1, source=fresh, compression=True
        )
        assert refilled["sourceCalls"] == 1
        assert_value(refilled["value"], fresh)
        assert int.from_bytes(bytes.fromhex(refilled["frameHex"])[1:9], "big") == cutoff + 1
        assert refilled["watermark"] == str(cutoff)  # Fills do not change the fence.
        hit = await invoke(invalidator, backend, clients, identity, wall=cutoff + 2, source=wrong)
        assert hit["sourceCalls"] == 0
        assert_value(hit["value"], fresh)
        assert hit["frameHex"] == refilled["frameHex"]

    untouched = await invoke(invalidator, backend, clients, unrelated, wall=cutoff + 2, source=wrong)
    assert untouched["sourceCalls"] == 0
    assert_value(untouched["value"], initial)
    assert untouched["watermark"] is None
    assert untouched["frameHex"] == before[key_for(unrelated).value_key]
