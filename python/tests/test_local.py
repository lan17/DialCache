import pytest

from dialcache.errors import ConfigError
from dialcache.local import LocalCache


class Clock:
    now = 0.0

    def monotonic_ms(self):
        return self.now


def test_fractional_insertion_and_read_use_whole_millisecond_grid():
    clock = Clock()
    cache = LocalCache(clock=clock)
    clock.now = 0.7
    cache.put("key", None, 1)
    clock.now = 999.999
    assert cache.read("key") == (True, None)
    clock.now = 1000.0
    assert cache.read("key") == (False, None)


def test_hit_promotes_lru_without_renewing_expiry():
    clock = Clock()
    cache = LocalCache(max_size=2, clock=clock)
    cache.put("a", 1, 1)
    cache.put("b", 2, 2)
    clock.now = 900
    assert cache.read("a") == (True, 1)
    cache.put("c", 3, 3)
    assert cache.read("b") == (False, None)
    clock.now = 1000
    assert cache.read("a") == (False, None)
    assert cache.read("c") == (True, 3)


def test_new_publication_replaces_value_and_expiration():
    clock = Clock()
    cache = LocalCache(clock=clock)
    cache.put("key", "first", 1)
    clock.now = 900.8
    cache.put("key", "second", 2)
    clock.now = 2899.9
    assert cache.read("key") == (True, "second")
    clock.now = 2900
    assert cache.read("key") == (False, None)


def test_zero_capacity_and_large_sparse_capacity():
    cache = LocalCache(max_size=0)
    cache.put("key", 1, 1)
    assert cache.read("key") == (False, None)
    assert len(cache) == 0
    large = LocalCache(max_size=9_007_199_254_740_991)
    large.put("key", 1, 1)
    assert len(large) == 1


@pytest.mark.parametrize("capacity", [True, None, -1, 1.5, 9_007_199_254_740_992])
def test_invalid_capacity_fails_at_construction(capacity):
    with pytest.raises(ConfigError):
        LocalCache(max_size=capacity)
