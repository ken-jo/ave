type Cleanup = () => void | Promise<void>;

/** Close all owners before removing their fixtures, preserving failures from both stages. */
export async function cleanupAfterClosing(closes: readonly Cleanup[], cleanup: readonly Cleanup[]): Promise<void> {
  const failures: unknown[] = [];
  try {
    const results = await Promise.allSettled(closes.map(async (close) => close()));
    for (const result of results) {
      if (result.status === "rejected") failures.push(result.reason);
    }
  } finally {
    for (const action of cleanup) {
      try {
        await action();
      } catch (error) {
        failures.push(error);
      }
    }
  }
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "Fixture teardown failed");
}
