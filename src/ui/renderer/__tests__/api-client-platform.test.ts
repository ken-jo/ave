import { afterEach, describe, expect, it } from "vitest";
import { getPlatformBridge, isDarwin } from "../api-client.js";

function plant(bridge: unknown): void {
  (window as unknown as { avePlatform?: unknown }).avePlatform = bridge;
}

afterEach(() => {
  delete (window as unknown as { avePlatform?: unknown }).avePlatform;
});

describe("getPlatformBridge", () => {
  it("is null outside Electron", () => {
    expect(getPlatformBridge()).toBeNull();
    expect(isDarwin()).toBe(false);
  });

  it.each([
    [true, "native"],
    [false, "trailing"],
    [false, "leading"],
  ] as const)("returns a consistent bridge (isDarwin=%s, %s)", (darwin, windowControls) => {
    plant({ isDarwin: darwin, windowControls });
    expect(getPlatformBridge()).toEqual({ isDarwin: darwin, windowControls });
    expect(isDarwin()).toBe(darwin);
  });

  it.each([
    ["missing", { isDarwin: false }],
    ["unknown", { isDarwin: false, windowControls: "left" }],
    ["not a string", { isDarwin: false, windowControls: 1 }],
    ["isDarwin missing", { windowControls: "trailing" }],
  ])("throws on a %s windowControls / isDarwin", (_name, bridge) => {
    plant(bridge);
    expect(() => getPlatformBridge()).toThrow("invalid avePlatform bridge");
  });

  it.each([
    [true, "trailing"],
    [true, "leading"],
    [false, "native"],
  ] as const)("throws when isDarwin=%s disagrees with %s", (darwin, windowControls) => {
    plant({ isDarwin: darwin, windowControls });
    expect(() => getPlatformBridge()).toThrow("avePlatform disagrees with itself");
  });
});
