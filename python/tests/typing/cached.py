"""Consumer type checks: unused ignores turn unexpectedly accepted bad calls into failures."""

import asyncio
from collections.abc import Awaitable, Coroutine
from typing import Any, assert_type

from dialcache import UNDEFINED, CacheKeySpec, DialCache, Key, KeyScalar

cache = DialCache()


def select_user(user_id: str, *, locale: str = "en") -> CacheKeySpec:
    return {"id": user_id, "args": {"locale": locale, "omitted": UNDEFINED}}


@cache.cached(key_type="user", cache_key=select_user)
async def get_user(user_id: str, *, locale: str = "en") -> str:
    return user_id + locale


@cache.cached(
    key_type="number",
    cache_key=lambda value, multiplier=2: {"id": value, "args": {"multiplier": multiplier}},
)
def get_number(value: int, /, multiplier: int = 2) -> int:
    return value * multiplier


@cache.cached(key_type="awaitable", cache_key=lambda value: value)
def get_awaitable(value: str) -> Awaitable[str]:
    return asyncio.sleep(0, result=value)


@cache.cached(key_type="user", id_arg="user_id")
async def inferred_user(user_id: str) -> str:
    return user_id


@cache.cached(key_type="user", id_arg="user_id")
def inferred_sync_user(user_id: str) -> str:
    return user_id


class Users:
    @cache.cached(key_type="user", cache_key=lambda self, user_id: user_id)
    async def get(self, user_id: str) -> str:
        return user_id


def select_key(user_id: str) -> Key:
    return Key("urn", "user", user_id, "GetUser")


def select_scalar(user_id: str) -> KeyScalar:
    return user_id


cache.cached(key_type="user", cache_key=select_key)
cache.cached(key_type="user", cache_key=select_scalar)
cache.cached(key_type="user", cache_key=lambda user_id: {"id": user_id})
cache.cached(key_type="user", cache_key=lambda user_id: {"id": user_id, "args": {"locale": "en"}})

assert_type(get_user("42"), Coroutine[Any, Any, str]).close()
assert_type(get_user(user_id="42", locale="fr"), Coroutine[Any, Any, str]).close()
assert_type(get_number(2), Coroutine[Any, Any, int]).close()
assert_type(get_number(2, multiplier=3), Coroutine[Any, Any, int]).close()
assert_type(get_awaitable("42"), Coroutine[Any, Any, str]).close()
assert_type(inferred_user("42"), Coroutine[Any, Any, str]).close()
assert_type(inferred_sync_user("42"), Coroutine[Any, Any, str]).close()
assert_type(Users().get("42"), Coroutine[Any, Any, str]).close()


async def check_awaited_results() -> None:
    assert_type(await get_user("42"), str)
    assert_type(await get_number(2), int)
    assert_type(await get_awaitable("42"), str)
    assert_type(asyncio.create_task(get_user("42")), asyncio.Task[str])
    assert_type(asyncio.create_task(get_number(2)), asyncio.Task[int])

# These errors must remain errors: Any leaking from the decorator would hide them.
get_user(42).close()  # type: ignore[arg-type]
get_user("42", "fr").close()  # type: ignore[misc]
get_user("42", unknown=True).close()  # type: ignore[call-arg]
get_user().close()  # type: ignore[call-arg]
get_number(value=2).close()  # type: ignore[call-arg]
inferred_user(42).close()  # type: ignore[arg-type]
inferred_sync_user(42).close()  # type: ignore[arg-type]
Users().get(42).close()  # type: ignore[arg-type]
wrong_result: Awaitable[int] = get_user("42")  # type: ignore[assignment]
cache.cached(key_type="user", cache_key=lambda user_id: object())  # type: ignore[arg-type,return-value]
cache.cached(
    key_type="user",
    cache_key=lambda user_id: {"id": user_id, "args": {"nested": []}},  # type: ignore[arg-type,return-value]
)

missing_id: CacheKeySpec = {"args": {"locale": "en"}}  # type: ignore[typeddict-item]
nested_args: CacheKeySpec = {"id": "42", "args": {"nested": []}}  # type: ignore[dict-item]
invalid_id: CacheKeySpec = {"id": object()}  # type: ignore[typeddict-item]
