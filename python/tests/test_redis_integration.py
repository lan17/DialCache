"""Real Redis/Valkey transition and Python/TypeScript interoperability evidence."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
from uuid import uuid4

import pytest
import redis.asyncio as redis
from redis.exceptions import ResponseError
from test_protocol_native import node_bridge

from dialcache.key import Key
from dialcache.protocol import Frame, Miss, RedisProtocolError, encode_frame
from dialcache.redis import (
    INVALIDATE_CACHE_SCRIPT,
    InvalidationRequest,
    ReadRequest,
    RedisAdapter,
    WriteRequest,
)

pytestmark = pytest.mark.integration
ROOT = Path(__file__).resolve().parents[2]
INVALIDATION_CORPORA = [
    json.loads((ROOT / "formal" / name).read_text())
    for name in ["invalidation-vectors.json", "quint-invalidation-vectors.json"]
]
INVALIDATIONS = [
    pytest.param(vector, id=vector["name"]) for corpus in INVALIDATION_CORPORA for vector in corpus["vectors"]
]


@pytest.fixture
async def server():
    url = os.environ.get("TEST_REDIS_URL")
    if not url:
        pytest.skip("Set TEST_REDIS_URL to run against a real Redis or Valkey server")
    client = redis.Redis.from_url(url, decode_responses=False, socket_timeout=5, socket_connect_timeout=5)
    await client.ping()
    try:
        yield client
    finally:
        await client.aclose()


@pytest.fixture
async def owned_key(server):
    key = "dialcache-python-test:" + uuid4().hex
    try:
        yield key
    finally:
        await server.delete(key)


def test_invalidation_corpus_inventory_and_provenance():
    assert [len(corpus["vectors"]) for corpus in INVALIDATION_CORPORA] == [49, 288]
    for corpus in INVALIDATION_CORPORA:
        assert corpus["schemaVersion"] == 2
        assert len({vector["name"] for vector in corpus["vectors"]}) == len(corpus["vectors"])
        for path, expected in corpus.get("provenance", {}).get("sourceSha256", {}).items():
            assert hashlib.sha256((ROOT / path).read_bytes()).hexdigest() == expected


@pytest.mark.parametrize("vector", INVALIDATIONS)
async def test_all_invalidation_transitions(server, owned_key, vector):
    existing, expected = vector["existing"], vector["expected"]["state"]
    commands = server.pipeline(transaction=True)
    commands.time()
    commands.delete(owned_key)
    if existing["kind"] == "string":
        commands.set(owned_key, existing["value"])
    elif existing["kind"] == "list":
        commands.rpush(owned_key, *existing["values"])
    if existing["ttlMs"] > 0:
        commands.pexpire(owned_key, existing["ttlMs"])
    result_index = len(commands.command_stack)
    commands.eval(INVALIDATE_CACHE_SCRIPT, 1, owned_key, vector["futureBufferMs"], vector["invalidatedAtMs"])
    commands.type(owned_key)
    content_index = len(commands.command_stack)
    if expected["kind"] == "string":
        commands.get(owned_key)
    elif expected["kind"] == "list":
        commands.lrange(owned_key, 0, -1)
    commands.pttl(owned_key)
    commands.time()
    results = await commands.execute(raise_on_error=False)
    result = results[result_index]
    if vector["expected"].get("error"):
        assert isinstance(result, ResponseError), result
    else:
        assert result == 1
    assert (
        results[result_index + 1]
        == {"absent": b"none", "string": b"string", "list": b"list"}[expected["kind"]]
    )
    if expected["kind"] == "string":
        assert results[content_index] == expected["value"].encode()
    elif expected["kind"] == "list":
        assert results[content_index] == [value.encode() for value in expected["values"]]
    actual_ttl = results[-2]
    expected_ttl = expected["ttlMs"]
    if expected_ttl < 0:
        assert actual_ttl == expected_ttl
    else:
        # Only the Redis clock measured around the atomic setup/transition/read
        # widens the bound; no arbitrary network tolerance hides TTL defects.
        before, after = results[0], results[-1]
        elapsed_ms = (after[0] * 1_000_000 + after[1]) // 1000 - (before[0] * 1_000_000 + before[1]) // 1000
        assert expected_ttl - elapsed_ms <= actual_ttl <= expected_ttl


async def test_adapter_real_frames_fencing_and_retention(server):
    key = Key("dialcache-python-test-" + uuid4().hex, "user", "1", "Get", tracked=True)
    adapter = RedisAdapter(server)
    try:
        assert await adapter.read(ReadRequest(key.value_key, key.watermark_key)) == Miss("value_absent")
        await adapter.write(WriteRequest(key.value_key, 60000, "value", 1000))
        assert await server.get(key.value_key) == encode_frame("value", 1000)
        assert await server.get(key.watermark_key) is None
        before = await server.time()
        await adapter.invalidate(InvalidationRequest(key.watermark_key, 200, 1000))
        assert await adapter.read(ReadRequest(key.value_key, key.watermark_key)) == Miss(
            "watermark_fenced", 1200
        )
        retention = await server.pttl(key.watermark_key)
        after = await server.time()
        elapsed = (after[0] * 1_000_000 + after[1]) // 1000 - (before[0] * 1_000_000 + before[1]) // 1000
        assert 7_200_000 - elapsed <= retention <= 7_200_000
        await adapter.write(WriteRequest(key.value_key, 60000, b"fresh", 1201))
        assert await adapter.read(ReadRequest(key.value_key, key.watermark_key)) == Frame(1201, b"fresh")
        assert await server.get(key.watermark_key) == b"1200"
        await server.delete(key.value_key)
        assert await adapter.read(ReadRequest(key.value_key, key.watermark_key)) == Miss("value_absent", 1200)
    finally:
        await server.delete(key.value_key, key.watermark_key)


@pytest.mark.parametrize("value", ["snow: 雪 😀", b"\x00\xff\x01\x02"])
async def test_bidirectional_typescript_protocol_through_real_redis(server, owned_key, value):
    adapter = RedisAdapter(server)
    await adapter.write(WriteRequest(owned_key, 60000, value, 1234))
    raw = await server.get(owned_key)
    result = node_bridge({"op": "decode", "hex": raw.hex(), "tracked": True, "watermark": "1233"})
    assert result == {
        "at": 1234,
        "binary": isinstance(value, bytes),
        "payload": value.hex() if isinstance(value, bytes) else value,
    }
    encoded = node_bridge(
        {
            "op": "encode",
            "at": 1235,
            "binary": isinstance(value, bytes),
            "payload": value.hex() if isinstance(value, bytes) else value,
        }
    )
    await server.set(owned_key, bytes.fromhex(encoded), px=60000)
    assert await adapter.read(ReadRequest(owned_key)) == Frame(1235, value)


async def test_cluster_atomic_primary_snapshot_and_native_writes():
    url = os.environ.get("TEST_REDIS_CLUSTER_URL")
    if not url:
        pytest.skip("Set TEST_REDIS_CLUSTER_URL to test an actual Redis Cluster")
    client = redis.RedisCluster.from_url(
        url, decode_responses=False, socket_timeout=5, socket_connect_timeout=5
    )
    key = Key("dialcache-python-cluster-" + uuid4().hex, "entity", "1", "Get", tracked=True)
    adapter = RedisAdapter(client)
    try:
        await client.initialize()
        await adapter.write(WriteRequest(key.value_key, 60000, "before", 1000))
        await adapter.invalidate(InvalidationRequest(key.watermark_key, 0, 1000))
        assert await adapter.read(ReadRequest(key.value_key, key.watermark_key)) == Miss(
            "watermark_fenced", 1000
        )
        await adapter.write(WriteRequest(key.value_key, 60000, "after", 1001))
        for _ in range(20):
            assert await adapter.read(ReadRequest(key.value_key, key.watermark_key)) == Frame(1001, "after")
        primary = client.get_node_from_key(key.value_key, replica=False)
        assert await client.execute_command("GET", key.value_key, target_nodes=primary) == encode_frame(
            "after", 1001
        )
        assert await client.execute_command("GET", key.watermark_key, target_nodes=primary) == b"1000"
        replica_client = redis.RedisCluster.from_url(
            url, read_from_replicas=True, decode_responses=False, socket_timeout=5, socket_connect_timeout=5
        )
        try:
            await replica_client.initialize()
            with pytest.raises(RedisProtocolError, match="primary-only RedisCluster"):
                await RedisAdapter(replica_client).read(ReadRequest(key.value_key, key.watermark_key))
        finally:
            await replica_client.aclose()
    finally:
        try:
            await client.delete(key.value_key, key.watermark_key)
        finally:
            await client.aclose()
