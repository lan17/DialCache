"""DialCache: explicit scopes, layered caching, and portable Redis frames."""

from .cache import DialCache
from .config import UNSET, CacheLayer, DialCacheKeyConfig, KeyConfig, Policy
from .errors import (
    ConfigError,
    DialCacheError,
    FallbackTimeoutError,
    MissingRemoteError,
    RedisReadTimeoutError,
    RemoteReadTimeoutError,
    UseCaseIsAlreadyRegisteredError,
    UseCaseNameIsReservedError,
)
from .key import Key, normalize_args
from .serializer import UNDEFINED, JsonSerializer, Serializer

__all__ = [
    "DialCache",
    "Policy",
    "KeyConfig",
    "DialCacheKeyConfig",
    "CacheLayer",
    "Key",
    "normalize_args",
    "Serializer",
    "JsonSerializer",
    "UNDEFINED",
    "UNSET",
    "DialCacheError",
    "ConfigError",
    "FallbackTimeoutError",
    "RemoteReadTimeoutError",
    "RedisReadTimeoutError",
    "MissingRemoteError",
    "UseCaseIsAlreadyRegisteredError",
    "UseCaseNameIsReservedError",
]
