"""Causally ready asyncio execution, without wall sleeps or fixed turn counts.

Each history owns a SelectorEventLoop. Only callbacks already on its runnable
queue are drained; timers are explicit driver gates and are delivered solely by
the history's advance command. This module intentionally uses CPython's event
loop seam, not any cache internals or expected model state.
"""

from __future__ import annotations

import asyncio
import contextvars
import heapq
import threading
from dataclasses import dataclass, field
from typing import Callable

WALL_EPOCH_MS = 1788868800000


@dataclass(order=True)
class Timer:
    due: float
    sequence: int
    callback: Callable = field(compare=False)
    context: contextvars.Context = field(compare=False)
    cancelled: bool = field(default=False, compare=False)

    def cancel(self):
        self.cancelled = True
        # Match asyncio.TimerHandle.cancel(): cancelled timer storage must not
        # retain callback closure/context values until the original due time.
        self.callback = None
        self.context = None


class ControlledClock:
    def __init__(self, executor):
        self.executor = executor
        self.elapsed = 0.0
        self.wall = float(WALL_EPOCH_MS)
        self.timer_time = 0.0
        self.timers = []
        self.sequence = 0

    def wall_ms(self):
        return self.wall

    def monotonic_ms(self):
        return self.elapsed

    def call_later(self, ms, callback):
        self.sequence += 1
        timer = Timer(self.timer_time + max(0, ms), self.sequence, callback, contextvars.copy_context())
        heapq.heappush(self.timers, timer)
        return timer

    async def sleep_ms(self, ms):
        gate = asyncio.get_running_loop().create_future()
        timer = self.call_later(ms, lambda: None if gate.done() else gate.set_result(None))
        try:
            await gate
        finally:
            timer.cancel()

    def consume(self, ms):
        # Synchronous external work and silent shifts consume elapsed time but
        # cannot deliver timer callbacks while the callback is still running.
        self.elapsed += ms
        self.wall += ms

    def advance(self, ms, deliver=True):
        if not deliver:
            self.consume(ms)
            return
        target = self.timer_time + ms
        while self.timers and self.timers[0].due <= target:
            timer = heapq.heappop(self.timers)
            if timer.cancelled:
                continue
            delta = max(0, timer.due - self.timer_time)
            self.timer_time += delta
            self.consume(delta)
            self.executor.loop.call_soon(timer.callback, context=timer.context)
            self.executor.drain()
        delta = target - self.timer_time
        self.timer_time = target
        self.consume(delta)


class Executor:
    def __init__(self):
        self.loop = asyncio.SelectorEventLoop()
        self.clock = ControlledClock(self)
        self.errors = []
        self.loop.set_exception_handler(lambda loop, context: self.errors.append(context))

    def task(self, coroutine, context=None):
        if context is None:
            return self.loop.create_task(coroutine)
        return context.run(self.loop.create_task, coroutine)

    def future(self):
        return self.loop.create_future()

    def drain(self):
        """Run the complete causal closure of ready callbacks at zero time."""
        previous = asyncio.events._get_running_loop()
        previous_thread = self.loop._thread_id
        asyncio.events._set_running_loop(self.loop)
        self.loop._thread_id = threading.get_ident()
        callbacks = 0
        try:
            while self.loop._ready:
                callbacks += sum(not item._cancelled for item in self.loop._ready)
                self.loop._run_once()
                if callbacks > 1_000_000:
                    raise RuntimeError("Native executor did not reach quiescence")
        finally:
            self.loop._thread_id = previous_thread
            asyncio.events._set_running_loop(previous)
        if self.errors:
            context = self.errors.pop(0)
            raise RuntimeError(f"Unhandled native task: {context.get('message')}") from context.get(
                "exception"
            )
        return callbacks

    def finish(self, coroutine, context=None):
        task = self.task(coroutine, context)
        self.drain()
        if not task.done():
            raise RuntimeError("Synchronous replay command remains blocked")
        return task.result()

    def close(self):
        for task in asyncio.all_tasks(self.loop):
            task.cancel()
        self.drain()
        self.loop.close()
