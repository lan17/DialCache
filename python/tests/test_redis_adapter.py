from __future__ import annotations

import asyncio

import pytest
from test_protocol_native import node_bridge

from dialcache.protocol import Frame, Miss, RedisProtocolError, encode_frame
from dialcache.redis import (
    INVALIDATE_CACHE_SCRIPT,
    INVALIDATE_CACHE_SCRIPT_SHA1,
    InvalidationRequest,
    ReadContext,
    ReadRequest,
    RedisAdapter,
    WriteRequest,
)


class Client:
    def __init__(self, replies):
        self.replies = iter(replies)
        self.calls = []

    async def execute_command(self, *args, **kwargs):
        self.calls.append((args, kwargs))
        value = next(self.replies)
        if isinstance(value, BaseException):
            raise value
        return value


async def test_semantic_reads_and_single_complete_frame_set():
    client = Client([None, [encode_frame("old", 1000), b"1000"], [encode_frame(b"new", 1001), b"1000"], True])
    adapter = RedisAdapter(client)
    assert await adapter.read(ReadRequest("value")) == Miss("value_absent")
    assert await adapter.read(ReadRequest("value", "watermark")) == Miss("watermark_fenced", 1000)
    assert await adapter.read(ReadRequest("value", "watermark")) == Frame(1001, b"new")
    await adapter.write(WriteRequest("value", 1.25, b"data", 17))
    assert client.calls == [
        (("GET", "value"), {}),
        (("MGET", "value", "watermark"), {}),
        (("MGET", "value", "watermark"), {}),
        (("SET", "value", encode_frame(b"data", 17), "PX", "2"), {}),
    ]


async def test_invalidation_retry_preserves_exact_arguments_and_error():
    client = Client([ConnectionError("ambiguous"), 1])
    await RedisAdapter(client).invalidate(InvalidationRequest("watermark", 200, 1000))
    assert client.calls == [
        (("EVALSHA", INVALIDATE_CACHE_SCRIPT_SHA1, "1", "watermark", "200", "1000"), {}),
        (("EVAL", INVALIDATE_CACHE_SCRIPT, "1", "watermark", "200", "1000"), {}),
    ]
    error = RuntimeError("second rejection")
    client = Client([ConnectionError(), error])
    with pytest.raises(RuntimeError) as raised:
        await RedisAdapter(client).invalidate(InvalidationRequest("watermark", 0, 1000))
    assert raised.value is error


async def test_accepted_bad_mutation_replies_are_never_retried():
    for reply in [None, "1", True, 1.0]:
        client = Client([reply])
        with pytest.raises(RedisProtocolError):
            await RedisAdapter(client).invalidate(InvalidationRequest("watermark", 0, 1000))
        assert len(client.calls) == 1


async def test_mutation_input_validation_precedes_dispatch():
    client = Client([])
    adapter = RedisAdapter(client)
    for timestamp in [-1, True, 1.5, float("inf"), 9007199254740992]:
        with pytest.raises(ValueError):
            await adapter.write(WriteRequest("value", 10, "x", timestamp))
        with pytest.raises(ValueError):
            await adapter.invalidate(InvalidationRequest("watermark", 0, timestamp))
    for ttl in [0, -1, True, float("inf"), 31536000001]:
        with pytest.raises(ValueError):
            await adapter.write(WriteRequest("value", ttl, "x", 1))
    assert client.calls == []


async def test_cluster_primary_routing_with_primary_only_connections():
    class Cluster(Client):
        read_from_replicas = False

        def get_connection_kwargs(self):
            return {}

        async def initialize(self):
            self.initialized = True

        def get_node_from_key(self, key, replica=False):
            assert self.initialized
            assert replica is False
            return ("primary", key)

    client = Cluster([[encode_frame("value", 2), b"1"]])
    assert await RedisAdapter(client).read(ReadRequest("{entity}#value", "{entity}#watermark")) == Frame(
        2, "value"
    )
    assert client.calls[0][1] == {"target_nodes": ("primary", "{entity}#value")}


async def test_preaborted_read_does_not_dispatch():
    class Signal:
        aborted = True

    client = Client([])
    with pytest.raises(asyncio.CancelledError):
        await RedisAdapter(client).read(ReadRequest("key"), ReadContext(10, Signal()))
    assert client.calls == []


@pytest.mark.parametrize("reply", [None, [], [b"a"], [b"a", b"b", b"c"], "ab"])
async def test_invalid_atomic_snapshot_shape(reply):
    with pytest.raises(RedisProtocolError):
        await RedisAdapter(Client([reply])).read(ReadRequest("value", "watermark"))


def test_lua_source_is_identical_to_current_typescript():
    assert INVALIDATE_CACHE_SCRIPT == node_bridge({"op": "script"})
