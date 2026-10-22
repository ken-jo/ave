import { describe, expect, it } from "vitest";
import { CHANNELS, PUBLIC_CHANNELS, EXTERNAL_MUTATION_CHANNELS, CHANNEL_GESTURE, isPublicChannel } from "../app-contract.js";

describe("browser chrome remains host-private", () => {
  it("exposes neither control nor workspace capabilities to external callers", () => {
    const publicChannels: ReadonlySet<string> = new Set(PUBLIC_CHANNELS);
    const mutations: ReadonlySet<string> = new Set(EXTERNAL_MUTATION_CHANNELS);
    for (const channel of [...Object.values(CHANNELS.browser), ...Object.values(CHANNELS.browserWorkspace)]) {
      expect(isPublicChannel(channel), channel).toBe(false);
      expect(publicChannels.has(channel), channel).toBe(false);
      expect(mutations.has(channel), channel).toBe(false);
      expect(CHANNEL_GESTURE[channel], channel).toBeUndefined();
    }
  });
});
