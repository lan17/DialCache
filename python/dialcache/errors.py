"""Public errors raised by DialCache operations and configuration."""


class DialCacheError(Exception):
    """Base class for errors owned by DialCache."""


class ConfigError(DialCacheError, ValueError):
    """Invalid static configuration or malformed runtime policy."""


class FallbackTimeoutError(DialCacheError, TimeoutError):
    """The enabled source invocation exceeded its DialCache deadline."""

    def __init__(self, use_case: str, timeout_ms: int) -> None:
        self.use_case = use_case
        self.timeout_ms = timeout_ms
        super().__init__(f'DialCache fallback for use case "{use_case}" timed out after {timeout_ms} ms')


class RemoteReadTimeoutError(DialCacheError, TimeoutError):
    """DialCache stopped waiting for a remote read."""

    def __init__(self, use_case: str, timeout_ms: int) -> None:
        self.use_case = use_case
        self.timeout_ms = timeout_ms
        super().__init__(f'DialCache Redis read for use case "{use_case}" timed out after {timeout_ms} ms')


RedisReadTimeoutError = RemoteReadTimeoutError


class UseCaseIsAlreadyRegisteredError(DialCacheError):
    def __init__(self, use_case: str) -> None:
        self.use_case = use_case
        super().__init__(f"Use case already registered: {use_case}")


class UseCaseNameIsReservedError(DialCacheError):
    def __init__(self, use_case: str) -> None:
        self.use_case = use_case
        super().__init__(f"Use case name is reserved: {use_case}")


class MissingRemoteError(DialCacheError):
    """An explicit remote maintenance operation has no remote adapter."""
