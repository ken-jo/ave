import { vi } from "vitest";
import type { LocalApi } from "../local-api.js";

export function makeStubLocalApi(): LocalApi {
  return { dispatch: vi.fn(async () => ({ ok: true, data: {} })) };
}

// Freeze time so persisted timestamps compare exactly across suites.
const A2A_FIXED_NOW_ISO = "2026-07-16T00:00:00.000Z";

export function fixedNow(): Date {
  return new Date(A2A_FIXED_NOW_ISO);
}

export function a2aRpcRequestJson(
  method: string,
  params: unknown,
  id: string | number | null = 1,
): string {
  return JSON.stringify({ jsonrpc: "2.0", id, method, params });
}

// Advance one second per read so lifecycle ordering never depends on same-millisecond wall-clock events.
export function monotonicIsoClock(): () => string {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 6, 14, 0, 0, tick++)).toISOString();
}
