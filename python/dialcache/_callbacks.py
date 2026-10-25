"""Isolation for application callbacks whose contract is synchronous."""

from __future__ import annotations

import asyncio
import contextvars
import inspect
from typing import Any


def discard_awaitable(value: Any) -> None:
    """Fail closed on an awaitable a synchronous callback returned.

    A rejected result must not start work or take ownership of an
    application's existing task: a coroutine that has not started is closed,
    and a future's exception is consumed without awaiting it.
    """
    if inspect.iscoroutine(value):
        if inspect.getcoroutinestate(value) == inspect.CORO_CREATED:
            value.close()
    elif asyncio.isfuture(value):

        def consume(done: asyncio.Future[Any]) -> None:
            if not done.cancelled():
                done.exception()

        value.add_done_callback(consume, context=contextvars.Context())
