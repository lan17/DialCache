"""Core and process-clock bindings through the public Python cache API."""

from __future__ import annotations

from unittest.mock import patch

from dialcache import DialCache
from dialcache.clock import SystemClock

from .driver import FakeRedis, empty_observation, json_value
from .executor import Executor


class CoreDriver:
    def __init__(self):
        self.executor = Executor()
        self.clock = self.executor.clock
        self.redis = FakeRedis(self.clock)
        self.cache = DialCache(redis=self.redis, clock=self.clock)
        self.version = 1
        self.last = 0
        self.counters = {
            name: 0
            for name in (
                "outsideLoaderCalls",
                "requestLoaderCalls",
                "localLoaderCalls",
                "coalescedLoaderCalls",
                "remoteLoaderCalls",
            )
        }

    def apply(self, command):
        op = command["op"]
        if op == "advanceWall":
            self.clock.consume(command["ms"])
            return
        if op == "bumpSource":
            self.version += 1
            return
        if op == "invalidate":
            identity = command["identity"]
            self.executor.finish(self.cache.invalidate_remote(identity["keyType"], identity["id"]))
            return
        if op != "call":
            raise RuntimeError(f"Unknown core command {op}")
        identity = command["identity"]
        options = {
            "key_type": identity["keyType"],
            "key": identity["id"],
            "use_case": identity["useCase"],
            "track_for_invalidation": identity["tracked"],
            "default_config": command["policy"],
        }

        async def call(gate=None):
            async def source():
                self.counters[command["counter"]] += 1
                if gate is not None:
                    await gate
                return self.version

            return await self.cache.get_or_load(source, **options)

        async def sequential():
            with self.cache.enable():
                first = await call()
                second = await call()
                if first != second:
                    raise AssertionError(f"Pair returned unequal values: {first}, {second}")
                return second

        async def enabled():
            with self.cache.enable():
                return await call()

        self.redis.fail_read = command["readFailure"]
        try:
            mode = command["mode"]
            if mode == "coalesced-pair":
                # Establish both callers while holding the real first source.
                gate = self.executor.future()
                with self.cache.enable():
                    first = self.executor.task(call(gate))
                    second = self.executor.task(call())
                    self.executor.drain()
                    gate.set_result(None)
                    self.executor.drain()
                    if not first.done() or not second.done():
                        raise RuntimeError("Core pair remains blocked")
                    if first.result() != second.result():
                        raise AssertionError("Core pair returned unequal values")
                    self.last = second.result()
            else:
                self.last = self.executor.finish(
                    call() if mode == "outside" else enabled() if mode == "single" else sequential()
                )
        finally:
            self.redis.fail_read = False

    def observe(self):
        return {
            "sourceVersion": self.version,
            "lastResult": json_value(self.last),
            **self.counters,
            "redisReads": self.redis.reads,
            "redisWrites": self.redis.writes,
        }

    def receipt(self):
        return None

    def close(self):
        self.executor.close()


class LocalClockDriver:
    def __init__(self):
        self.executor = Executor()
        self.clock = self.executor.clock
        self.ticks = 0
        self.actual = empty_observation()
        self.caches = {}
        # This profile constructs real default caches. Patch the native process
        # clock itself, preserving fractional milliseconds at construction.
        owner = self
        self.patch = patch.object(SystemClock, "monotonic_ms", lambda _clock: owner.ticks / 1000)
        self.patch.start()

    def apply(self, command):
        op = command["op"]
        if op == "constructInstance":
            index = command["instance"]
            if index in self.caches:
                raise RuntimeError("Instance already constructed")
            self.caches[index] = DialCache()
        elif op == "advanceTicks":
            self.ticks += command["ticks"]
        elif op == "call":
            cache = self.caches[command["instance"]]

            async def call():
                async def source():
                    self.actual["loaders"] += 1
                    return command["offered"]

                with cache.enable():
                    return await cache.get_or_load(
                        source,
                        key_type="clock",
                        key="one",
                        use_case="QuintLocalGrid",
                        default_config={"ttlSec": {"local": 1}},
                    )

            self.actual["calls"].append(self.executor.finish(call()))
        else:
            raise RuntimeError(f"Unknown local-clock command {op}")

    def observe(self):
        return self.actual

    def receipt(self):
        return None

    def close(self):
        try:
            self.executor.close()
        finally:
            self.patch.stop()
