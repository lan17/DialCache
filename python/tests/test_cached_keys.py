"""Public explicit-selector semantics, including Python invocation conventions."""

import pytest

from dialcache import UNDEFINED, DialCache, Key, Policy


async def test_selector_receives_original_positional_and_keyword_arguments():
    cache = DialCache()
    seen = []

    def select(*args, **kwargs):
        seen.append((args, kwargs))
        return args[0] if args else kwargs["user_id"]

    @cache.cached(key_type="user", cache_key=select, default_config=Policy(request_local=True))
    async def load(user_id, locale="en"):
        return user_id

    # Disabled calls do not invoke the selector, even for defaulted parameters.
    assert await load("42") == "42"
    assert seen == []
    with cache.enable():
        assert await load("42") == "42"
        assert await load(user_id="42") == "42"
    assert seen == [(("42",), {}), ((), {"user_id": "42"})]


async def test_explicit_selector_positional_only_keyword_only_and_variadic_arguments():
    cache = DialCache()
    calls = 0

    def select(user_id, /, *roles, locale="en", **context):
        return {"id": user_id, "args": {"roles": ",".join(roles), "locale": locale}}

    @cache.cached(key_type="user", cache_key=select, default_config=Policy(request_local=True))
    async def load(user_id, /, *roles, locale="en", **context):
        nonlocal calls
        calls += 1
        return calls

    with cache.enable():
        assert await load("42", "reader", trace_id="first") == 1
        assert await load("42", "reader", locale="en", trace_id="second") == 1
        assert await load("42", "admin") == 2
        assert await load("42", "reader", locale="fr") == 3
    assert calls == 3


async def test_method_selector_can_include_instance_identity():
    cache = DialCache()
    calls = []

    class Users:
        def __init__(self, tenant):
            self.tenant = tenant

        @cache.cached(
            key_type="user",
            cache_key=lambda self, user_id: {"id": user_id, "args": {"tenant": self.tenant}},
            default_config=Policy(request_local=True),
        )
        async def load(self, user_id):
            calls.append((self.tenant, user_id))
            return self.tenant

    first, second = Users("a"), Users("b")
    with cache.enable():
        assert await first.load("42") == "a"
        assert await first.load(user_id="42") == "a"
        assert await second.load("42") == "b"
    assert calls == [("a", "42"), ("b", "42")]


async def test_selector_missing_default_fails_open(caplog):
    cache = DialCache()
    calls = 0

    @cache.cached(
        key_type="user",
        cache_key=lambda user_id, locale: {"id": user_id, "args": {"locale": locale}},
        default_config=Policy(request_local=True),
    )
    async def load(user_id, locale="en"):
        nonlocal calls
        calls += 1
        return calls

    with cache.enable():
        assert await load("42") == 1
        assert await load("42") == 2
        assert await load("42", "en") == 3
        assert await load("42", "en") == 3
    assert "Could not construct DialCache key" in caplog.text


@pytest.mark.parametrize(
    "selected",
    [
        "42",
        {"id": "42", "args": {"locale": UNDEFINED}},
        Key("urn", "user", "42", "GetUser"),
    ],
)
async def test_existing_scalar_mapping_and_structured_key_selectors(selected):
    cache = DialCache()
    calls = 0

    @cache.cached(
        key_type="user",
        use_case="GetUser",
        cache_key=lambda user_id: selected,
        default_config=Policy(request_local=True),
    )
    async def load(user_id):
        nonlocal calls
        calls += 1
        return calls

    with cache.enable():
        assert await load("42") == 1
        assert await load("42") == 1
    assert calls == 1
