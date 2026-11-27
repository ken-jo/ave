/**
 * The one boundary an admitted effect crosses. The liveness check and the effect run in the same synchronous step, so
 * nothing can supersede the receipt between them. Work that yields re-enters through another call for its next effect.
 */
export function commitUnderAdmission<T>(assertLive: () => void, effect: () => T): T {
  assertLive();
  const result = effect();
  if (typeof (result as { then?: unknown } | null | undefined)?.then === "function") {
    void Promise.resolve(result).catch(() => {});
    throw new Error("An admitted effect must be synchronous");
  }
  return result;
}
