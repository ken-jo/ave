// This suite mirrors the closure-local rate-limit algorithm; keep it aligned with production.
import { describe, it, expect, vi, afterEach } from "vitest";

const SET_API_KEY_MAX_CALLS = 5;
const SET_API_KEY_WINDOW_MS = 60_000;
const GC_THRESHOLD = 64;

function makeRateLimiter() {
  const bucket = new Map<string, { count: number; windowStart: number }>();

  function check(serverId: string): boolean {
    const now = Date.now();
    if (bucket.size > GC_THRESHOLD) {
      for (const [k, b] of bucket) {
        if (now - b.windowStart >= SET_API_KEY_WINDOW_MS) {
          bucket.delete(k);
        }
      }
    }
    const entry = bucket.get(serverId);
    if (!entry || now - entry.windowStart >= SET_API_KEY_WINDOW_MS) {
      bucket.set(serverId, { count: 1, windowStart: now });
      return true;
    }
    if (entry.count >= SET_API_KEY_MAX_CALLS) return false;
    entry.count += 1;
    return true;
  }

  return { bucket, check };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("checkSetApiKeyRateLimit — lazy GC (NEW-2 MEDIUM)", () => {
  it("GC evicts expired entries when Map exceeds 64 entries", () => {
    vi.useFakeTimers();
    const t0 = Date.now();
    const { bucket, check } = makeRateLimiter();

    for (let i = 0; i < 65; i++) {
      check(`server-${i}`);
    }
    expect(bucket.size).toBe(65);

    vi.advanceTimersByTime(SET_API_KEY_WINDOW_MS + 1);

    check("server-66");

    expect(bucket.size).toBe(1);
    expect(bucket.has("server-66")).toBe(true);
  });

  it("does NOT GC when Map size is exactly 64 (threshold is >64)", () => {
    vi.useFakeTimers();
    const { bucket, check } = makeRateLimiter();

    for (let i = 0; i < 64; i++) {
      check(`server-${i}`);
    }
    expect(bucket.size).toBe(64);

    vi.advanceTimersByTime(SET_API_KEY_WINDOW_MS + 1);

    check("server-0");
    expect(bucket.size).toBe(64);
  });

  it("preserves active (non-expired) entries during GC", () => {
    vi.useFakeTimers();
    const { bucket, check } = makeRateLimiter();

    for (let i = 0; i < 65; i++) {
      check(`server-${i}`);
    }

    vi.advanceTimersByTime(SET_API_KEY_WINDOW_MS / 2);

    check("server-99");
    expect(bucket.size).toBe(66);

    vi.advanceTimersByTime(SET_API_KEY_WINDOW_MS / 2 + 1);

    check("server-trigger");

    expect(bucket.has("server-99")).toBe(true);
    expect(bucket.has("server-trigger")).toBe(true);
    expect(bucket.size).toBeLessThan(10);
  });

  it("rate-limits at SET_API_KEY_MAX_CALLS within the window", () => {
    vi.useFakeTimers();
    const { check } = makeRateLimiter();
    const serverId = "test-server";

    for (let i = 0; i < SET_API_KEY_MAX_CALLS; i++) {
      expect(check(serverId)).toBe(true);
    }
    expect(check(serverId)).toBe(false);
  });

  it("resets after window expires", () => {
    vi.useFakeTimers();
    const { check } = makeRateLimiter();
    const serverId = "test-server";

    for (let i = 0; i < SET_API_KEY_MAX_CALLS; i++) check(serverId);
    expect(check(serverId)).toBe(false);

    vi.advanceTimersByTime(SET_API_KEY_WINDOW_MS + 1);
    expect(check(serverId)).toBe(true);
  });
});
