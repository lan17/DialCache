"""Native ownership check: abandoned shadow work releases retained raw bytes."""

import gc
import weakref

from formal.executor import Executor

from dialcache import DialCache
from dialcache.protocol import Frame


def test_timed_out_shadow_releases_frame_while_source_is_still_held():
    executor = Executor()
    retained = []
    events = []
    source = executor.future()

    class EphemeralRedis:
        async def read(self, request, context=None):
            # Unlike a storage fake, this adapter retains no strong reference
            # after returning its frame, so only native cache ownership remains.
            frame = Frame(int(executor.clock.wall_ms()), "1")
            retained.append(weakref.ref(frame))
            return frame

    cache = DialCache(redis=EphemeralRedis(), clock=executor.clock, metrics=events.append)

    async def call():
        with cache.enable():
            return await cache.get_or_load(
                lambda: source,
                key_type="id",
                key="1",
                use_case="Retention",
                fallback_timeout_ms=10,
                default_config={"ttlSec": {"remote": 60}, "shadow": {"ramp": 100}},
            )

    try:
        assert executor.finish(call()) == 1
        assert len(retained) == 1
        assert retained[0]() is not None
        assert not source.done()
        executor.clock.advance(10)
        executor.drain()
        assert [event["outcome"] for event in events if event["event"] == "shadowValidation"] == ["timeout"]
        assert not source.done()
        gc.collect()
        assert retained[0]() is None
    finally:
        executor.close()
