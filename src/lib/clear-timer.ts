/** Clear and null timers together so disposal remains idempotent. */

export function clearTimeoutSafe(handle: NodeJS.Timeout | null): null {
  if (handle != null) clearTimeout(handle);
  return null;
}

export function clearIntervalSafe(handle: NodeJS.Timeout | null): null {
  if (handle != null) clearInterval(handle);
  return null;
}
