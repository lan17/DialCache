"""Tracked snapshots must stay authoritative across actual redis-py retries."""

import asyncio

import pytest
import redis.cluster as cluster_module
from redis.asyncio.cluster import ClusterNode, RedisCluster
from redis.crc import key_slot
from redis.exceptions import AskError, MovedError

from dialcache import DialCache, Policy
from dialcache.protocol import Frame, Miss, RedisProtocolError, encode_frame
from dialcache.redis import InvalidationRequest, ReadRequest, RedisAdapter, WriteRequest

slot = key_slot(b"{entity}#value")
strategies = getattr(cluster_module, "LoadBalancingStrategy", None)
replica_modes = [("read_from_replicas", {"read_from_replicas": True})]
if strategies is not None:
    replica_modes += [(s.name, {"load_balancing_strategy": s}) for s in strategies]


def make_client(options=None, redirect="MOVED", initialize_flip=False):
    calls = []

    class Node(ClusterNode):
        def __init__(self, port, kind, current):
            super().__init__("127.0.0.1", port, server_type=kind)
            self.current = current
            self.redirect = None

        async def execute_command(self, *args, **kwargs):
            calls.append((self.port, args[0]))
            if args[0] == "ASKING":
                return b"OK"
            if args[0] == "SET":
                return True
            if args[0] in ("EVAL", "EVALSHA"):
                return 1
            if self.redirect is not None:
                error, self.redirect = self.redirect, None
                raise error
            raw = encode_frame("primary" if self.current else "stale", 1000)
            return [raw, b"2000" if self.current else None] if args[0] == "MGET" else raw

    old = Node(7000, "primary", False)
    primary = Node(7001, "replica", True)
    replica = Node(7002, "replica", False)
    old.redirect = (MovedError if redirect == "MOVED" else AskError)(f"{slot} 127.0.0.1:7001")

    class Client(RedisCluster):
        def __init__(self):
            super().__init__(host="127.0.0.1", port=7000, reinitialize_steps=5, **(options or {}))
            self.nodes_manager.nodes_cache = {n.name: n for n in (old, primary, replica)}
            self.nodes_manager.slots_cache = {slot: [old, primary, replica]}
            self.nodes_manager.default_node = old
            self.nodes_manager.read_load_balancer.primary_to_idx[primary.name] = 1
            self.initialize_calls = 0

        async def initialize(self):
            self.initialize_calls += 1
            self._initialize = False
            if initialize_flip:
                await asyncio.sleep(0)
                self.read_from_replicas = True
            return self

        async def _determine_slot(self, *args):
            return slot

        def __del__(self):
            pass

    return Client(), calls


@pytest.mark.parametrize("redirect", ["MOVED", "ASK"])
async def test_primary_only_redirects_preserve_authoritative_fence(redirect):
    client, calls = make_client(redirect=redirect)
    result = await RedisAdapter(client).read(ReadRequest("{entity}#value", "{entity}#watermark"))
    assert result == Miss("watermark_fenced", 2000)
    expected = [(7000, "MGET"), (7001, "MGET")]
    if redirect == "ASK":
        expected.insert(1, (7001, "ASKING"))
    assert calls == expected


@pytest.mark.parametrize("mode,options", replica_modes)
@pytest.mark.parametrize("reset_flags", [False, True])
async def test_replica_connections_cannot_supply_tracked_snapshots(mode, options, reset_flags):
    client, calls = make_client(options)
    adapter = RedisAdapter(client)
    if reset_flags:
        client.read_from_replicas = False
        if hasattr(client, "load_balancing_strategy"):
            client.load_balancing_strategy = None
    configuration = dict(client.get_connection_kwargs())
    flags = (client.read_from_replicas, getattr(client, "load_balancing_strategy", None))
    with pytest.raises(RedisProtocolError, match="primary-only RedisCluster"):
        await adapter.read(ReadRequest("{entity}#value", "{entity}#watermark"))
    assert calls == []
    assert client.initialize_calls == 0
    assert client.get_connection_kwargs() == configuration
    assert (client.read_from_replicas, getattr(client, "load_balancing_strategy", None)) == flags
    # Only tracked reads require the stronger acquisition guarantee.
    assert isinstance(await adapter.read(ReadRequest("{entity}#value")), Frame)
    await adapter.write(WriteRequest("{entity}#value", 1000, "value", 1000))
    await adapter.invalidate(InvalidationRequest("{entity}#watermark", 0, 1000))
    assert {command for _, command in calls} >= {"GET", "SET", "EVALSHA"}
    assert client.get_connection_kwargs() == configuration


@pytest.mark.parametrize("mode,options", replica_modes)
async def test_tracked_policy_is_checked_after_adapter_construction(mode, options):
    client, calls = make_client()
    adapter = RedisAdapter(client)
    for name, value in options.items():
        setattr(client, name, value)
    with pytest.raises(RedisProtocolError, match="primary-only RedisCluster"):
        await adapter.read(ReadRequest("{entity}#value", "{entity}#watermark"))
    assert calls == []


async def test_tracked_policy_is_rechecked_after_awaited_initialization():
    client, calls = make_client(initialize_flip=True)
    with pytest.raises(RedisProtocolError, match="primary-only RedisCluster"):
        await RedisAdapter(client).read(ReadRequest("{entity}#value", "{entity}#watermark"))
    assert client.initialize_calls == 1
    assert calls == []


@pytest.mark.parametrize("configuration", [None, {"redis_connect_func": object()}])
async def test_uninspectable_or_custom_connection_configuration_fails_closed(configuration):
    client, calls = make_client()
    client.connection_kwargs = configuration
    with pytest.raises(RedisProtocolError, match="primary-only RedisCluster"):
        await RedisAdapter(client).read(ReadRequest("{entity}#value", "{entity}#watermark"))
    assert calls == []


async def test_missing_cluster_configuration_accessor_fails_closed():
    class Client:
        read_from_replicas = False

        def get_node_from_key(self, *args, **kwargs):
            raise AssertionError("must reject before node lookup")

    with pytest.raises(RedisProtocolError, match="primary-only RedisCluster"):
        await RedisAdapter(Client()).read(ReadRequest("value", "watermark"))


async def test_denied_tracked_cluster_read_fails_open_without_refill_or_local_warming():
    client, calls = make_client({"read_from_replicas": True})
    cache = DialCache(redis=RedisAdapter(client))
    source_calls = []

    def source():
        source_calls.append(1)
        return len(source_calls)

    with cache.enable():
        for expected in [1, 2]:
            assert (
                await cache.get_or_load(
                    source,
                    key="a",
                    key_type="entity",
                    use_case="guard",
                    track_for_invalidation=True,
                    default_config=Policy(ttl_sec={"local": 60, "remote": 60}),
                )
                == expected
            )
    assert len(source_calls) == 2
    assert calls == []
