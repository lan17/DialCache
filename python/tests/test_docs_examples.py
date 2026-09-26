"""Executed teaching scenarios imported by the shared documentation site."""

import os
from uuid import uuid4

import pytest

from dialcache import DialCache, Policy
from dialcache.redis import RedisAdapter


async def test_explicit_key_identity():
    cache = DialCache(namespace="users-api")
    source_calls = []

    @cache.cached(
        key_type="user_id",
        use_case="GetUser",
        # Repeat the loader default so omitted and explicit locales agree.
        cache_key=lambda user_id, locale="en", *, trace_id=None: {
            "id": user_id,
            "args": {"locale": locale},
        },
        default_config=Policy(request_local=True),
    )
    async def get_user(user_id: str, locale: str = "en", *, trace_id=None):
        source_calls.append((user_id, locale, trace_id))
        return {"id": user_id, "locale": locale}

    async with cache.enable():
        assert await get_user("123", trace_id="first") == {"id": "123", "locale": "en"}
        assert await get_user(user_id="123", locale="en", trace_id="second") == {
            "id": "123",
            "locale": "en",
        }
        assert await get_user("123", "fr") == {"id": "123", "locale": "fr"}
        assert await get_user("456") == {"id": "456", "locale": "en"}

    # Trace metadata does not alter the result, so it is omitted from identity.
    assert source_calls == [("123", "en", "first"), ("123", "fr", None), ("456", "en", None)]


async def test_request_scope():
    # region request-scope
    cache = DialCache()
    source_calls = 0

    @cache.cached(
        key_type="user",
        use_case="requestScope",
        cache_key=lambda id: id,
        # Only request-local storage is enabled; shared layers stay off.
        default_config=Policy(request_local=True),
    )
    async def lookup(id):
        nonlocal source_calls
        source_calls += 1
        return source_calls

    # Outside an enabled scope, every call reaches the source.
    assert await lookup("42") == 1
    assert await lookup("42") == 2
    async with cache.enable():
        assert await lookup("42") == 3
        assert await lookup("42") == 3
    # A new request starts with an empty memo.
    async with cache.enable():
        assert await lookup("42") == 4
    assert source_calls == 4
    # endregion request-scope


async def test_runtime_policy():
    # region runtime-policy
    # An application may fetch this overlay from its runtime config service.
    overlay = Policy(coalesce=False)
    cache = DialCache(policy_provider=lambda key: overlay)
    source_calls = 0

    @cache.cached(
        key_type="user",
        use_case="runtimePolicy",
        cache_key=lambda id: id,
        default_config=Policy(request_local=True, ttl_sec={"local": 60}, ramp={"local": 100}),
    )
    async def lookup(id):
        nonlocal source_calls
        source_calls += 1
        return source_calls

    # The sparse overlay inherits the local TTL across separate requests.
    async with cache.enable():
        assert await lookup("42") == 1
    async with cache.enable():
        assert await lookup("42") == 1

    # False and zero explicitly disable the two configured cache paths.
    overlay = Policy(request_local=False, ramp={"local": 0})
    async with cache.enable():
        assert await lookup("42") == 2
        assert await lookup("42") == 3
    assert source_calls == 3
    # endregion runtime-policy


@pytest.mark.integration
async def test_tracked_invalidation():
    from redis.asyncio import Redis

    url = os.environ.get("DOCS_REDIS_URL") or os.environ.get("TEST_REDIS_URL")
    if not url:
        pytest.skip("Set DOCS_REDIS_URL or TEST_REDIS_URL for the documented Redis scenario")
    namespace = f"docs-python-{uuid4().hex}"
    client = Redis.from_url(url, decode_responses=False, socket_timeout=2, socket_connect_timeout=2)
    await client.ping()
    try:
        # region tracked-invalidation
        # client is a connected, caller-owned redis.asyncio client.
        cache = DialCache(namespace=namespace, redis=RedisAdapter(client), read_timeout_ms=1_000)
        source_version = 1
        source_calls = 0

        @cache.cached(
            key_type="user",
            use_case="profileVersion",
            cache_key=lambda id: id,
            track_for_invalidation=True,
            # Keep local layers off so each request observes the watermark.
            default_config=Policy(ttl_sec={"remote": 60}, ramp={"remote": 100}),
        )
        async def profile_version(id):
            nonlocal source_calls
            source_calls += 1
            return source_version

        async with cache.enable():
            assert await profile_version("42") == 1
        source_version = 2  # Represents a successfully committed source update.
        async with cache.enable():
            assert await profile_version("42") == 1
        assert source_calls == 1  # The previous value really was cached.

        await cache.invalidate_remote("user", "42")
        async with cache.enable():
            assert await profile_version("42") == 2
        assert source_calls == 2
        # endregion tracked-invalidation
    finally:
        prefix = f"{{{namespace}:user:42}}"
        try:
            await client.delete(f"{prefix}#profileVersion:dialcache-frame-v1", f"{prefix}#watermark")
        finally:
            await client.aclose()
