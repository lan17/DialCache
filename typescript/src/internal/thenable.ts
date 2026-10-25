// Application callbacks under a synchronous contract (comparators, the stale
// recovery predicate, the mismatch hook) and observers (loggers, metrics
// adapters) can still return a promise-like. These helpers observe its
// settlement so a rejection never goes unhandled.

/** Whether a value has a callable `then`, which `await` would adopt. */
export function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return value !== null
    && (typeof value === "object" || typeof value === "function")
    && typeof (value as { readonly then?: unknown }).then === "function";
}

/**
 * Resolves whether a value fulfilled, and never rejects. `await` adopts a
 * native promise whose `constructor` is the intrinsic Promise without reading
 * its `then`, so a replaced own `then` on such a promise, or a global
 * `Promise` replaced after load, cannot skip the handler. Every other
 * promise-like, a native promise whose own `constructor` is also replaced
 * included, is adopted through its own `then`, which can withhold settlement.
 */
export async function fulfills(value: unknown): Promise<boolean> {
  try {
    await value;
    return true;
  } catch {
    return false;
  }
}
