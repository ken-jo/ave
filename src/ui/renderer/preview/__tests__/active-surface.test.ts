import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearActiveSurface,
  forgetActiveSurface,
  getActiveSurface,
  knownSurfaceUsedAt,
  restoreSurfaceUsedAt,
  showActiveSurface,
  subscribeActiveSurface,
  surfaceUsedAt,
  updateActiveSurface,
} from "../active-surface.js";

const terminal = { kind: "terminal" as const, tabId: "terminal:1", label: "Terminal 1" };
const page = { kind: "browser" as const, tabId: "browser:2", label: "Browser 1" };

afterEach(() => clearActiveSurface());

describe("active surface", () => {
  it("follows what was shown last, and tells listeners only on a change", () => {
    const listener = vi.fn();
    const off = subscribeActiveSurface(listener);
    showActiveSurface(terminal);
    showActiveSurface({ ...terminal });
    expect(listener).toHaveBeenCalledTimes(1);
    showActiveSurface(page);
    expect(getActiveSurface()).toEqual(page);
    expect(listener).toHaveBeenCalledTimes(2);
    off();
  });

  it("updates only the current target, so a dropped target is not taken back by a later fact", () => {
    showActiveSurface(terminal);
    updateActiveSurface({ ...terminal, cwd: "/repo" });
    expect(getActiveSurface()?.cwd).toBe("/repo");
    updateActiveSurface({ ...page, label: "Browser 9" });
    expect(getActiveSurface()?.tabId).toBe("terminal:1");

    clearActiveSurface();
    updateActiveSurface({ ...terminal, cwd: "/repo/app" });
    expect(getActiveSurface()).toBeNull();
  });

  it("clears when the target is closed, and only then", () => {
    showActiveSurface(page);
    forgetActiveSurface("terminal:1");
    expect(getActiveSurface()).toEqual(page);
    forgetActiveSurface("browser:2");
    expect(getActiveSurface()).toBeNull();
  });

  it("brings back saved last-used times, and places a surface saved without one by restore order below every timed one, not at now", () => {
    restoreSurfaceUsedAt([{ tabId: "terminal:1" }, { tabId: "browser:2", usedAt: 1_000 }, { tabId: "terminal:3" }]);
    const now = 5_000;
    expect(surfaceUsedAt("browser:2", now)).toBe(1_000);
    expect(surfaceUsedAt("terminal:1", now)).toBeLessThan(0);
    expect(surfaceUsedAt("terminal:3", now)).toBeLessThan(surfaceUsedAt("terminal:1", now));
    expect(knownSurfaceUsedAt("browser:2")).toBe(1_000);
    expect(knownSurfaceUsedAt("browser:9")).toBeUndefined();
    forgetActiveSurface("browser:2");
    expect(knownSurfaceUsedAt("browser:2")).toBeUndefined();
  });
});
