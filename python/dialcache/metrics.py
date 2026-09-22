"""Backend-neutral metrics observer contract."""

from __future__ import annotations

import asyncio
import inspect
from collections.abc import Callable, Mapping
from typing import Any, Protocol, TypeAlias

MetricEvent: TypeAlias = dict[str, Any]


class MetricsObserver(Protocol):
    """Receive bounded events with the shared DialCache diagnostic labels.

    Events use the cross-port names, including ``cacheNamespace``, ``useCase``
    and ``keyType``. Observers are synchronous. Their failures never change a
    cache call's outcome.
    """

    def observe(self, event: MetricEvent) -> None: ...


Metrics: TypeAlias = MetricsObserver | Callable[[MetricEvent], None]


def emit_metric(metrics: Metrics | None, event: str | Mapping[str, Any], **labels: Any) -> None:
    if metrics is None:
        return
    payload = {"event": event, **labels} if isinstance(event, str) else dict(event)
    try:
        callback = metrics if callable(metrics) else metrics.observe
        result = callback(payload)
        # An async observer violates the synchronous contract. Do not schedule
        # it, and avoid leaving an un-awaited coroutine warning behind.
        if inspect.iscoroutine(result):
            result.close()
    except (Exception, asyncio.CancelledError):
        pass
