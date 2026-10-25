import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { relaunchDesktopHost } from "../desktop-relaunch.js";
import policy from "../../shared/app-relaunch-policy.json" with { type: "json" };
import { shouldRelaunchDevChild } from "../../../scripts/lib/dev-relaunch-policy.mjs";

function lifecycle() {
  return Object.assign(new EventEmitter(), { relaunch: vi.fn(), quit: vi.fn() });
}

describe("desktop relaunch lifecycle", () => {
  it("schedules only one relaunch for repeated host requests", () => {
    const app = lifecycle();
    relaunchDesktopHost(app, false);
    expect(() => relaunchDesktopHost(app, false)).toThrow("relaunch-in-progress");
    expect(app.relaunch).toHaveBeenCalledExactlyOnceWith();
    expect(app.quit).toHaveBeenCalledExactlyOnceWith();
  });

  it("schedules a relaunch before entering the normal quit lifecycle", () => {
    const app = lifecycle();
    relaunchDesktopHost(app, false);
    expect(app.relaunch).toHaveBeenCalledExactlyOnceWith();
    expect(app.quit).toHaveBeenCalledExactlyOnceWith();
    expect(app.relaunch.mock.invocationCallOrder[0]).toBeLessThan(app.quit.mock.invocationCallOrder[0]);
  });

  it("allows a retry when scheduling fails before a relaunch is accepted", () => {
    const app = lifecycle();
    app.relaunch.mockImplementationOnce(() => { throw new Error("schedule-failed"); });
    expect(() => relaunchDesktopHost(app, false)).toThrow("schedule-failed");
    expect(app.quit).not.toHaveBeenCalled();
    relaunchDesktopHost(app, false);
    expect(app.relaunch).toHaveBeenCalledTimes(2);
    expect(app.quit).toHaveBeenCalledExactlyOnceWith();
  });

  it("retains the reservation when quitting fails after scheduling", () => {
    const app = lifecycle();
    app.quit.mockImplementationOnce(() => { throw new Error("quit-failed"); });
    expect(() => relaunchDesktopHost(app, false)).toThrow("relaunch-in-progress");
    expect(() => relaunchDesktopHost(app, false)).toThrow("relaunch-in-progress");
    expect(app.relaunch).toHaveBeenCalledExactlyOnceWith();
    expect(app.quit).toHaveBeenCalledExactlyOnceWith();
  });

  it("registers one launcher exit for repeated development requests", () => {
    const app = lifecycle();
    const exit = vi.fn();
    relaunchDesktopHost(app, true, exit);
    expect(() => relaunchDesktopHost(app, true, exit)).toThrow("relaunch-in-progress");
    expect(app.listenerCount("quit")).toBe(1);
    app.emit("quit", {}, 0);
    expect(exit).toHaveBeenCalledExactlyOnceWith(policy.devExitCode);
    expect(app.quit).toHaveBeenCalledExactlyOnceWith();
  });

  it("returns the reserved launcher code only after quit cleanup completes", () => {
    const app = lifecycle();
    const exit = vi.fn();
    relaunchDesktopHost(app, true, exit);
    expect(app.relaunch).not.toHaveBeenCalled();
    expect(app.quit).toHaveBeenCalledExactlyOnceWith();
    expect(exit).not.toHaveBeenCalled();
    app.emit("quit", {}, 0);
    expect(exit).toHaveBeenCalledExactlyOnceWith(policy.devExitCode);
    expect(shouldRelaunchDevChild(policy.devExitCode, null)).toBe(true);
  });

  it("keeps normal exits and terminated children out of the relaunch path", () => {
    expect(shouldRelaunchDevChild(0, null)).toBe(false);
    expect(shouldRelaunchDevChild(1, null)).toBe(false);
    expect(shouldRelaunchDevChild(null, "SIGTERM")).toBe(false);
    expect(shouldRelaunchDevChild(policy.devExitCode, "SIGKILL")).toBe(false);
  });
});
