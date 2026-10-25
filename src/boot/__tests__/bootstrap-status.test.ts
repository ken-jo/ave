/** Bootstrap status delivery must tolerate destroyed or disconnected webContents. */
import { describe, it, expect, vi } from "vitest";
import { latestBootstrapStatus, notifyBootstrapStatus } from "../bootstrap-status.js";
import { CHANNELS } from "../../contract/app-contract.js";

function makeFakeWindow(opts: {
  destroyed?: boolean;
  sendThrows?: boolean;
} = {}): { send: ReturnType<typeof vi.fn>; isDestroyed: () => boolean } {
  const send = vi.fn(() => {
    if (opts.sendThrows) throw new Error("webContents disconnected");
  });
  return {
    send,
    isDestroyed: () => opts.destroyed === true,
  };
}

function asWindow(fake: ReturnType<typeof makeFakeWindow>): never {
  // Only send and isDestroyed are required; avoid loading desktop types.
  return {
    isDestroyed: fake.isDestroyed,
    webContents: { send: fake.send },
  } as unknown as never;
}

describe("notifyBootstrapStatus", () => {
  it("sends start payload over the contract's bootstrap status channel", () => {
    const fake = makeFakeWindow();
    notifyBootstrapStatus(asWindow(fake), { phase: "start" });
    expect(fake.send).toHaveBeenCalledWith(CHANNELS.bootstrap.status, { phase: "start" });
  });

  it("sends complete payload with installed/failed lists", () => {
    const fake = makeFakeWindow();
    notifyBootstrapStatus(asWindow(fake), {
      phase: "complete",
      installed: ["calendar"],
      failed: [{ id: "meeting", error: "tarball unreachable" }],
    });
    expect(fake.send).toHaveBeenCalledWith(CHANNELS.bootstrap.status, {
      phase: "complete",
      installed: ["calendar"],
      failed: [{ id: "meeting", error: "tarball unreachable" }],
    });
  });

  it("is a no-op when the window is null", () => {
    expect(() => notifyBootstrapStatus(null, { phase: "start" })).not.toThrow();
  });

  it("is a no-op when the window is destroyed", () => {
    const fake = makeFakeWindow({ destroyed: true });
    notifyBootstrapStatus(asWindow(fake), { phase: "start" });
    expect(fake.send).not.toHaveBeenCalled();
  });

  it("swallows webContents.send errors so boot is never bricked", () => {
    const fake = makeFakeWindow({ sendThrows: true });
    expect(() =>
      notifyBootstrapStatus(asWindow(fake), { phase: "error", message: "catalog fetch failed" }),
    ).not.toThrow();
  });
});

describe("latestBootstrapStatus", () => {
  it("records the snapshot the helper just sent", () => {
    notifyBootstrapStatus(asWindow(makeFakeWindow()), {
      phase: "complete",
      installed: ["calendar"],
      failed: [],
    });
    expect(latestBootstrapStatus()).toEqual({
      phase: "complete",
      installed: ["calendar"],
      failed: [],
    });
  });

  it("records a status emitted before any window exists", () => {
    // Cold boot records the outcome before the renderer starts listening.
    notifyBootstrapStatus(null, { phase: "error", message: "catalog fetch failed" });
    expect(latestBootstrapStatus()).toEqual({
      phase: "error",
      message: "catalog fetch failed",
    });
  });

  it("keeps the newest snapshot across a lifecycle sequence", () => {
    const fake = makeFakeWindow();
    notifyBootstrapStatus(asWindow(fake), { phase: "start" });
    expect(latestBootstrapStatus()).toEqual({ phase: "start" });
    notifyBootstrapStatus(asWindow(fake), { phase: "complete", installed: [], failed: [] });
    expect(latestBootstrapStatus()).toEqual({ phase: "complete", installed: [], failed: [] });
  });
});
