"""Separate wall timestamps, monotonic elapsed time, and timer delivery."""

from __future__ import annotations

import asyncio
import time
from collections.abc import Callable
from typing import Protocol


class TimerHandle(Protocol):
    def cancel(self) -> None: ...


class Clock(Protocol):
    """Injectable clocks and timers for deterministic application tests.

    Wall time stamps Redis frames. Monotonic time governs local expiry and
    deadlines. A controlled clock may advance elapsed time without delivering
    timers, so callers also check elapsed time when operations settle.
    """

    def wall_ms(self) -> int | float: ...

    def monotonic_ms(self) -> int | float: ...

    def call_later(self, milliseconds: float, callback: Callable[[], None]) -> TimerHandle: ...


class SystemClock:
    """System wall time and the process-wide monotonic millisecond grid."""

    def wall_ms(self) -> int:
        return time.time_ns() // 1_000_000

    def monotonic_ms(self) -> float:
        return time.monotonic_ns() / 1_000_000

    def call_later(self, milliseconds: float, callback: Callable[[], None]) -> TimerHandle:
        return asyncio.get_running_loop().call_later(milliseconds / 1_000, callback)

    async def sleep_ms(self, milliseconds: float) -> None:
        future: asyncio.Future[None] = asyncio.get_running_loop().create_future()

        def wake() -> None:
            if not future.done():
                future.set_result(None)

        timer = self.call_later(milliseconds, wake)
        try:
            await future
        finally:
            timer.cancel()
