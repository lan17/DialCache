"""Effects observed through the actual Python API, never expected model state."""

from __future__ import annotations

import asyncio
import contextvars
import copy
import json
import math
from dataclasses import dataclass

from dialcache import DialCache
from dialcache.errors import FallbackTimeoutError, MissingRemoteError
from dialcache.key import Key
from dialcache.local import LocalCache
from dialcache.protocol import Frame, Miss, decode_read, decode_tracked_read, encode_frame

from .executor import WALL_EPOCH_MS, Executor

ABSENT = object()


def empty_observation(fixture=None):
    result = {
        "calls": [],
        "loaders": 0,
        "reads": 0,
        "writes": 0,
        "invalidations": 0,
        "maintenance": [],
        "loads": 0,
        "dumps": 0,
        "policyCalls": 0,
        "classifications": 0,
        "comparisons": 0,
        "sourceScopes": [],
        "writeTtls": [],
        "shadow": [],
        "recovery": [],
    }
    if fixture is not None and "observe" in fixture:
        result["events"] = []
    return result


def json_value(value):
    return {"absent": True} if value is ABSENT else value


def dump_value(value):
    return "undefined" if value is ABSENT else json.dumps(value, ensure_ascii=False, separators=(",", ":"))


class FakeRedis:
    """Controlled atomic adapter using the real frame codec and elapsed TTLs."""

    def __init__(self, clock, owner=None):
        self.clock = clock
        self.owner = owner
        self.values = {}
        self.reads = 0
        self.writes = 0
        self.fail_read = False

    def raw(self, key):
        entry = self.values.get(key)
        if entry is None:
            return None
        if entry[1] <= self.clock.monotonic_ms():
            del self.values[key]
            return None
        return entry[0]

    def seed(self, key, value, ttl=60_000):
        self.values[key] = (value, self.clock.monotonic_ms() + ttl)

    async def read(self, request, context=None):
        self.reads += 1
        if self.owner:
            owner = self.owner
            index = owner.count("reads")
            if context is not None:
                signal = context.signal
                aborted = (
                    (signal.aborted if hasattr(signal, "aborted") else signal.is_set())
                    if signal is not None
                    else False
                )
                owner.record("readContext", index=index, timeoutMs=context.timeout_ms, aborted=aborted)
                if hasattr(signal, "add_callback"):
                    signal.add_callback(lambda: owner.record("readAbort", index=index))
                elif signal is not None:

                    async def abort():
                        await signal.wait()
                        owner.record("readAbort", index=index)

                    owner.executor.task(abort())
            if owner.faults.get("holdReads"):
                await owner.hold("read", index)
            if owner.faults.get("read"):
                raise RuntimeError("Controlled read failure")
            if owner.adapter_reply is not ABSENT:
                result, owner.adapter_reply = owner.adapter_reply, ABSENT
                # Bind the coordinator's JSON record to the native adapter
                # variants. Keep malformed reason/timestamp leaves intact so
                # the production trust boundary, not the driver, validates them.
                if isinstance(result, dict) and result.get("kind") == "miss":
                    return Miss(result.get("reason"), result.get("observedWatermarkMs"))
                if isinstance(result, dict) and "createdAtMs" in result and "payload" in result:
                    return Frame(result["createdAtMs"], result["payload"])
                return copy.deepcopy(result)
        if self.fail_read:
            raise RuntimeError("Controlled read failure")
        value = self.raw(request.value_key)
        return (
            decode_read(value)
            if request.watermark_key is None
            else decode_tracked_read(value, self.raw(request.watermark_key))
        )

    async def write(self, request):
        # The writer stamps before the adapter gate, even if SET happens later.
        stamped = encode_frame(request.value, request.created_at_ms)
        self.writes += 1
        if self.owner:
            owner = self.owner
            index = owner.count("writes")
            owner.record("writeDispatch", index=index)
            owner.observed["writeTtls"].append(request.cache_ttl_ms)
            if owner.faults.get("holdWrites"):
                await owner.hold("write", index)
            if owner.faults.get("write"):
                raise owner.maintenance_error
        self.seed(request.value_key, stamped, math.ceil(request.cache_ttl_ms))

    async def invalidate(self, request):
        self.writes += 1
        if self.owner:
            self.owner.count("invalidations")
            if self.owner.faults.get("write"):
                raise self.owner.maintenance_error
        raw = self.raw(request.watermark_key)
        try:
            old = int(raw) if raw is not None else 0
        except (TypeError, ValueError):
            old = 0
        watermark = max(old, request.invalidated_at_ms + request.future_buffer_ms)
        ttl = max(
            self.ttl(request.watermark_key),
            7_200_000,
            watermark - request.invalidated_at_ms + 3_600_000 + 60_000,
        )
        self.seed(request.watermark_key, str(math.ceil(watermark)).encode(), ttl)

    def ttl(self, key):
        entry = self.values.get(key)
        return -2 if entry is None else max(0, entry[1] - self.clock.monotonic_ms())


class Metrics:
    def __init__(self, owner):
        self.owner = owner

    def supports(self, event):
        return event != "shadowValidation" or self.owner.fixture.get("shadowHook", True)

    def __call__(self, event):
        owner = self.owner
        event = dict(event)
        kind = event.pop("event")
        if kind == "shadowValidation" and self.supports(kind):
            owner.observed["shadow"].append(event["outcome"])
        elif kind == "staleRecovery":
            owner.observed["recovery"].append(event["outcome"])
        else:
            owner.record(kind, **event)
        if owner.fixture.get("observerFailure") or owner.faults.get("observer"):
            raise RuntimeError("Controlled observer failure")


class Logger:
    def __init__(self, owner):
        self.owner = owner

    def warning(self, *args, **kwargs):
        if (
            len(args) == 2
            and args[0] == "DialCache shadow validation mismatch: %s"
            and isinstance(args[1], dict)
        ):
            self.owner.record("mismatchWarning", **args[1])
        if self.owner.fixture.get("observerFailure") or self.owner.faults.get("observer"):
            raise RuntimeError("Controlled observer failure")

    debug = error = warning


class Serializer:
    def __init__(self, owner):
        self.owner = owner

    async def dump(self, value):
        index = self.owner.count("dumps")
        if self.owner.faults.get("holdDumps"):
            await self.owner.hold("dump", index)
        if self.owner.faults.get("dump"):
            raise RuntimeError("Controlled serialization failure")
        return dump_value(value)

    async def load(self, raw):
        index = self.owner.count("loads")
        if self.owner.faults.get("holdLoads"):
            await self.owner.hold("load", index)
        if self.owner.faults.get("load"):
            raise RuntimeError("Controlled deserialization failure")
        text = raw.decode() if isinstance(raw, bytes) else raw
        return ABSENT if text == "undefined" else json.loads(text)


class FaultingLocal:
    def __init__(self, owner, max_size):
        self.owner = owner
        self.store = LocalCache(max_size=max_size, clock=owner.clock)

    def read(self, key):
        if self.owner.faults.get("localStorage"):
            raise RuntimeError("Controlled local storage failure")
        return self.store.read(key)

    def put(self, key, value, ttl_sec):
        if self.owner.faults.get("localStorage"):
            raise RuntimeError("Controlled local storage failure")
        self.store.put(key, value, ttl_sec)


@dataclass
class Scope:
    instance: str
    gate: asyncio.Future
    lifetime: asyncio.Task | None = None
    context: contextvars.Context | None = None


class BehaviorDriver:
    def __init__(self, fixture, *, settle=True):
        self.fixture = fixture
        self.should_settle = settle
        self.executor = Executor()
        self.clock = self.executor.clock
        self.observed = empty_observation(fixture)
        self.reported = copy.deepcopy(self.observed)
        self.faults = {}
        self.effects = {name: {} for name in ("read", "write", "dump", "load", "policy")}
        self.loaders = []
        self.source_errors = []
        self.timeout_errors = []
        self.scopes = {}
        self.instances = {}
        self.runtime_policy = {}
        self.adapter_reply = ABSENT
        self.maintenance_error = RuntimeError("Controlled mutation failure")
        self.redis = FakeRedis(self.clock, self)
        self.cache = self.instance("default")
        self.serializer = Serializer(self)
        self.settlement = self._receipt(0)

    def count(self, name):
        value = self.observed[name]
        self.observed[name] += 1
        return value

    def record(self, event, **fields):
        if event in self.fixture.get("observe", []):
            self.observed["events"].append({"event": event, **fields})

    def classifier(self, outcome):
        def classify(*args, **kwargs):
            self.count("classifications")
            if outcome == "error":
                raise RuntimeError("Controlled classification failure")
            return outcome == "allow"

        return classify

    def instance(self, name):
        if name in self.instances:
            return self.instances[name]
        fixture = self.fixture
        options = {
            "redis": None if fixture.get("remote") is False else self.redis,
            "policy_provider": self.policy_provider,
            "clock": self.clock,
            "metrics": Metrics(self),
            "logger": Logger(self),
            "compression": False,
        }
        for source, target in (
            ("localMaxSize", "local_max_size"),
            ("shadowMaxInFlight", "shadow_max_in_flight"),
        ):
            if source in fixture:
                options[target] = fixture[source]
        if fixture.get("readTimeoutMs") != "default":
            options["read_timeout_ms"] = fixture.get("readTimeoutMs", 50)
        if fixture.get("recovery", "default") != "default":
            options["should_attempt_stale_recovery"] = self.classifier(fixture["recovery"])
        if fixture.get("localFaultInjection"):
            options["local_store"] = FaultingLocal(self, fixture.get("localMaxSize", 10000))
        cache = DialCache(**options)
        self.instances[name] = cache
        return cache

    async def policy_provider(self, *args, **kwargs):
        index = self.count("policyCalls")
        if self.faults.get("holdPolicies"):
            await self.hold("policy", index)
        if self.faults.get("policy"):
            raise RuntimeError("Controlled policy failure")
        return copy.deepcopy(self.runtime_policy)

    def hold(self, kind, index):
        gate = self.executor.future()
        self.effects[kind][index] = gate
        return gate

    def begin(self, command):
        index = len(self.observed["calls"])
        self.observed["calls"].append({"status": "pending"})
        scope = self.scopes.get(command.get("scope"))
        cache = self.instance(command.get("instance", scope.instance if scope else "default"))

        def source():
            if self.fixture.get("probeSourceScope"):
                self.observed["sourceScopes"].append(cache.is_enabled())
            gate = self.executor.future()
            self.loaders.append(gate)
            self.source_errors.append(RuntimeError(f"Source failure {len(self.source_errors)}"))
            self.count("loaders")
            self.clock.consume(self.fixture.get("sourceWorkMs", 0))
            return gate

        def compare(*args, **kwargs):
            self.count("comparisons")
            self.clock.consume(self.fixture.get("comparisonMs", 0))
            if self.fixture["comparator"] == "error":
                raise RuntimeError("Controlled comparison failure")
            return self.fixture["comparator"] == "equal"

        options = {
            "key_type": "id",
            "key": command.get("key", "1"),
            "use_case": command.get("useCase", "Behavior"),
            "serializer": self.serializer,
            "track_for_invalidation": self.fixture.get("tracked", False),
            "default_config": self.fixture["policy"],
        }
        if "recovery" in command:
            options["should_attempt_stale_recovery"] = self.classifier(command["recovery"])
        if "comparator" in self.fixture:
            options["shadow_comparator"] = compare
        if self.fixture.get("fallbackTimeoutMs") != "default":
            options["fallback_timeout_ms"] = self.fixture.get("fallbackTimeoutMs", 10)

        async def execute():
            if command.get("disabled"):
                with cache.disable():
                    return await cache.get_or_load(source, **options)
            return await cache.get_or_load(source, **options)

        async def call():
            try:
                if scope is not None or command.get("outside"):
                    value = await execute()
                else:
                    with cache.enable():
                        value = await execute()
                self.observed["calls"][index] = {"status": "value", "value": json_value(value)}
            except Exception as error:
                self.observed["calls"][index] = {"status": "error", "error": self.classify(error)}

        self.executor.task(call(), scope.context if scope else None)

    def classify(self, error):
        for index, source in enumerate(self.source_errors):
            if error is source:
                return f"source:{index}"
        if isinstance(error, FallbackTimeoutError):
            index = next((i for i, item in enumerate(self.timeout_errors) if item is error), None)
            if index is None:
                index = len(self.timeout_errors)
                self.timeout_errors.append(error)
            return f"timeout:{index}"
        return f"unexpected:{error}"

    def value_key(self, command, *, tracked=None):
        return Key(
            namespace="urn",
            key_type="id",
            id=command.get("key", "1"),
            use_case=command.get("useCase", "Behavior"),
            tracked=self.fixture.get("tracked", False) if tracked is None else tracked,
        )

    def apply(self, command):
        op = command["op"]
        if op == "begin":
            self.begin(command)
        elif op == "resolve":
            self.loaders[command["loader"]].set_result(command.get("value", ABSENT))
        elif op == "reject":
            index = command["loader"]
            if command.get("error") == "timeout":
                self.source_errors[index] = FallbackTimeoutError("NestedSource", 10)
            self.loaders[index].set_exception(self.source_errors[index])
        elif op == "advance":
            self.clock.advance(command["ms"], command.get("deliverTimers", True))
        elif op == "shiftWall":
            self.clock.wall += command["ms"]
        elif op == "policy":
            self.runtime_policy = command["value"]
        elif op == "faults":
            self.faults.update(command["value"])
        elif op == "adapterReply":
            if self.adapter_reply is not ABSENT:
                raise RuntimeError("Unconsumed adapter reply")
            self.adapter_reply = command["value"]
        elif op == "release":
            gate = self.effects[command["effect"]].pop(command["index"])
            if command.get("fail"):
                gate.set_exception(RuntimeError(f"Controlled {command['effect']} failure"))
            else:
                gate.set_result(None)
        elif op == "seed":
            if "frameHex" in command:
                frame = bytes.fromhex(command["frameHex"])
            else:
                payload = (
                    bytes.fromhex(command["payloadHex"])
                    if "payloadHex" in command
                    else command.get("payloadText", dump_value(command.get("value", ABSENT)))
                )
                frame = encode_frame(payload, self.clock.wall_ms() - command.get("ageMs", 0))
            self.redis.seed(self.value_key(command).value_key, frame, command.get("ttlMs", 60_000))
        elif op == "invalidate":

            async def invalidate():
                try:
                    await self.cache.invalidate_remote(
                        "id", command.get("key", "1"), command.get("futureBufferMs", 0)
                    )
                    self.observed["maintenance"].append("ok")
                except Exception as error:
                    if error is self.maintenance_error:
                        self.observed["maintenance"].append("mutation_error")
                    elif self.fixture.get("remote") is False and isinstance(
                        error, (TypeError, ValueError, MissingRemoteError)
                    ):
                        self.observed["maintenance"].append("missing_remote")
                    else:
                        raise

            self.executor.finish(invalidate())
        elif op == "observeMarker":
            key = self.value_key(command, tracked=True).watermark_key
            raw = self.redis.raw(key)
            self.record(
                "marker", cutoffMs=-1 if raw is None else int(raw) - WALL_EPOCH_MS, ttlMs=self.redis.ttl(key)
            )
        elif op == "inspectCoalescing":
            name = command.get("instance", "default")
            state = self.instance(name).get_coalescing_state()["process"]
            self.record(
                "coalescingState",
                instance=name,
                activeLeaders=state["active_leaders"],
                activeFollowers=state["active_followers"],
                oldestLeaderAgeMs=state["oldest_leader_age_ms"],
            )
        elif op == "openScope":
            name = command["id"]
            if name in self.scopes:
                raise RuntimeError(f"Duplicate scope {name}")
            parent = self.scopes.get(command.get("parent"))
            instance = command.get("instance", parent.instance if parent else "default")
            cache = self.instance(instance)
            scope = Scope(instance, self.executor.future())

            async def lifetime():
                with cache.disable() if command.get("disabled") else cache.enable():
                    scope.context = contextvars.copy_context()
                    await scope.gate

            scope.lifetime = self.executor.task(lifetime(), parent.context if parent else None)
            self.scopes[name] = scope
        elif op == "closeScope":
            self.scopes[command["id"]].gate.set_result(None)
        else:
            raise RuntimeError(f"Unknown behavior command: {op}")
        self.settle()

    def _receipt(self, runnable):
        return {
            "elapsedMs": self.clock.monotonic_ms(),
            "runnable": runnable,
            "held": {
                "loaders": sum(not gate.done() for gate in self.loaders),
                **{
                    plural: len(self.effects[kind])
                    for kind, plural in (
                        ("read", "reads"),
                        ("write", "writes"),
                        ("dump", "dumps"),
                        ("load", "loads"),
                        ("policy", "policies"),
                    )
                },
                "scopes": sum(not scope.gate.done() for scope in self.scopes.values()),
            },
        }

    def settle(self):
        if self.should_settle:
            self.executor.drain()
        self.reported = copy.deepcopy(self.observed)
        self.settlement = self._receipt(0)
        # An additional drain directly counts work, including internal callbacks
        # which produce no user-visible event. No guessed sleep/turn count.
        self.settlement["runnable"] = self.executor.drain()

    def observe(self):
        return copy.deepcopy(self.reported)

    def receipt(self):
        return copy.deepcopy(self.settlement)

    def close(self):
        # Teardown happens after assertions. Cancel held work and drain callback
        # cleanup; no pending task is allowed to enter the next isolated loop.
        self.executor.close()
