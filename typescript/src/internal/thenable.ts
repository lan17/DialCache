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

/** Resolves to whether `value` fulfilled. Never rejects, so a rejection is never left unhandled. */
export async function fulfills(value: unknown): Promise<boolean> {
  try {
    await value;
    return true;
  } catch {
    return false;
  }
}
