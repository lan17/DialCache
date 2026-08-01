/** Wait for every launched operation, preserving one error or aggregating many. */
export async function awaitAll(
  operations: readonly Promise<unknown>[],
  aggregateMessage: string,
): Promise<void> {
  const results = await Promise.allSettled(operations);
  const errors: unknown[] = [];

  for (const result of results) {
    if (result.status === "rejected") {
      errors.push(result.reason);
    }
  }

  if (errors.length === 1) {
    throw errors[0];
  }
  if (errors.length > 1) {
    throw new AggregateError(errors, aggregateMessage);
  }
}
