import { performance } from "node:perf_hooks";

import type { Awaitable } from "../config.js";

export const MAX_TIMER_DELAY_MS = 2_147_483_647;

interface MonotonicDeadlineOptions<T> {
  readonly operation: () => Awaitable<T>;
  readonly timeoutMs: number;
  readonly timeoutError: () => Error;
  readonly onTimeout?: () => void;
}

/**
 * Bound how long a caller waits for an operation without claiming ownership of
 * the operation's underlying resources. Late fulfillment and rejection are
 * consumed after the returned promise settles.
 */
export function withMonotonicDeadline<T>({
  operation,
  timeoutMs,
  timeoutError,
  onTimeout,
}: MonotonicDeadlineOptions<T>): Promise<T> {
  const startedAtMs = performance.now();
  const pending = Promise.resolve(operation());

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let timer: NodeJS.Timeout | null = null;
    const elapsedMs = (): number => Math.max(performance.now() - startedAtMs, 0);
    const clearTimer = (): void => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };
    const rejectTimeout = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimer();
      try {
        onTimeout?.();
      } catch {
        // Cooperative cancellation must not replace the stable deadline error.
      }
      reject(timeoutError());
    };
    const onTimer = (): void => {
      timer = null;
      if (settled) {
        return;
      }

      const remainingMs = timeoutMs - elapsedMs();
      if (remainingMs > 0) {
        timer = setTimeout(onTimer, Math.ceil(remainingMs));
        return;
      }
      rejectTimeout();
    };
    const settleBeforeDeadline = (settle: () => void): void => {
      if (settled) {
        return;
      }
      if (elapsedMs() >= timeoutMs) {
        rejectTimeout();
        return;
      }
      settled = true;
      clearTimer();
      settle();
    };

    const remainingMs = timeoutMs - elapsedMs();
    if (remainingMs <= 0) {
      rejectTimeout();
    } else {
      // Keep the timer referenced so it can deliver the deadline as the only
      // remaining active handle.
      timer = setTimeout(onTimer, Math.ceil(remainingMs));
    }

    void pending.then(
      (value) => {
        settleBeforeDeadline(() => resolve(value));
      },
      (error: unknown) => {
        settleBeforeDeadline(() => reject(error));
      },
    );
  });
}

export function assertValidDeadlineMs(value: unknown, name: string): asserts value is number {
  if (
    typeof value !== "number"
    || !Number.isSafeInteger(value)
    || value <= 0
    || value > MAX_TIMER_DELAY_MS
  ) {
    throw new RangeError(`${name} must be a positive safe integer no greater than ${MAX_TIMER_DELAY_MS}`);
  }
}
