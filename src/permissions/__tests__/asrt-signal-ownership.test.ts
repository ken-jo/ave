import { describe, expect, it } from "vitest";
import { claimAsrtSignalRelease, readAsrtSignalReleaseClaim } from "../asrt-signal-ownership.js";

describe("host claim on the sandbox runtime's signal release", () => {
  it("reaches the runtime only when made before initialize, and refuses a claim after it", () => {
    claimAsrtSignalRelease();
    expect(readAsrtSignalReleaseClaim()).toBe(true);
    // The runtime registered its signal handlers at initialize; a later claim would not reach it.
    expect(() => claimAsrtSignalRelease()).toThrow("already initialized");
  });
});
