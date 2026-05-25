import "../setup.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalDebugStreamEnv = process.env.VITE_DEBUG_STREAM;
const originalAveDebugStreamEnv = process.env.AVE_DEBUG_STREAM;

function setRendererDebugFlag(value: boolean, overrides?: { isDev?: boolean; enableDevConsole?: boolean }) {
  const current = window.ave;
  window.ave = {
    ...(current ?? {}),
    env: {
      isDev: overrides?.isDev ?? current?.env?.isDev ?? false,
      enableDevConsole: overrides?.enableDevConsole ?? current?.env?.enableDevConsole ?? false,
      debugStream: value,
    },
  } as typeof window.ave;
}

describe("debug-stream", () => {
  beforeEach(() => {
    setRendererDebugFlag(false);
    delete process.env.VITE_DEBUG_STREAM;
    delete process.env.AVE_DEBUG_STREAM;
  });

  afterEach(() => {
    if (originalDebugStreamEnv === undefined) {
      delete process.env.VITE_DEBUG_STREAM;
    } else {
      process.env.VITE_DEBUG_STREAM = originalDebugStreamEnv;
    }
    if (originalAveDebugStreamEnv === undefined) {
      delete process.env.AVE_DEBUG_STREAM;
    } else {
      process.env.AVE_DEBUG_STREAM = originalAveDebugStreamEnv;
    }
  });

  it("enables renderer logging from the preload bridge", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { debugLog, isDebugStreamEnabled } = await import("../../../src/lib/debug-stream.js");

    setRendererDebugFlag(true);

    expect(isDebugStreamEnabled()).toBe(true);
    debugLog("stream", "hello");
    expect(spy).toHaveBeenCalledWith("[ave-debug:stream]", "hello");

    spy.mockRestore();
  });

  it("keeps logging disabled when neither preload nor env enables it", async () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => {});
    const { debugLog, isDebugStreamEnabled } = await import("../../../src/lib/debug-stream.js");

    expect(isDebugStreamEnabled()).toBe(false);
    debugLog("stream", "hello");
    expect(spy).not.toHaveBeenCalled();

    spy.mockRestore();
  });

  it("honors AVE_DEBUG_STREAM in non-renderer fallback paths", async () => {
    const current = window.ave;
    delete (window as unknown as { ave?: unknown }).ave;
    process.env.AVE_DEBUG_STREAM = "1";
    const { isDebugStreamEnabled } = await import("../../../src/lib/debug-stream.js");

    try {
      expect(isDebugStreamEnabled()).toBe(true);
    } finally {
      window.ave = current;
    }
  });
});
