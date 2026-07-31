/** Wait for every launched operation, preserving one error or aggregating many. */
export async function awaitAll<T>(
  operations: readonly Promise<T>[],
  aggregateMessage: string,
): Promise<T[]> {
  const results = await Promise.allSettled(operations);
  const errors: unknown[] = [];
  const values: T[] = [];

  for (const result of results) {
    if (result.status === "rejected") {
      errors.push(result.reason);
    } else {
      values.push(result.value);
    }
  }

  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, aggregateMessage);
  }
  return values;
}
