import { describe, expect, it } from "vitest";

import {
  bindRemoteControllerToSession,
  hasUserKeyboardIntentPayload,
  refreshRemoteControllerBoundToSession,
  RemoteControllerContractError,
  USER_KEYBOARD_REQUIRED,
} from "../chat-origin.js";

describe("USER_KEYBOARD_REQUIRED", () => {
  it("is the one frozen refusal every mutation domain returns", () => {
    expect(USER_KEYBOARD_REQUIRED).toEqual({ ok: false, error: "user-keyboard-required" });
    expect(Object.isFrozen(USER_KEYBOARD_REQUIRED)).toBe(true);
  });
});

describe("hasUserKeyboardIntentPayload", () => {
  it("accepts a payload whose intent is a user-keyboard activation", () => {
    expect(hasUserKeyboardIntentPayload({ intent: { inputOrigin: "user-keyboard", userActivation: true } })).toBe(true);
  });

  it("rejects non-objects, missing intent, and non-keyboard intent", () => {
    expect(hasUserKeyboardIntentPayload(null)).toBe(false);
    expect(hasUserKeyboardIntentPayload("intent")).toBe(false);
    expect(hasUserKeyboardIntentPayload({})).toBe(false);
    expect(hasUserKeyboardIntentPayload({ intent: { inputOrigin: "user-keyboard", userActivation: false } })).toBe(false);
    expect(hasUserKeyboardIntentPayload({ intent: { inputOrigin: "programmatic", userActivation: true } })).toBe(false);
  });
});

describe("refreshRemoteControllerBoundToSession", () => {
  const pairedShare = { pairingId: "pair", pairingEpoch: 1, shareId: "share", shareEpoch: 1, scope: "scope" };

  it("fails clearly, instead of reading as revoked, for a Tailnet controller the host never pairs", async () => {
    const unpaired = bindRemoteControllerToSession({ kind: "tailnet-controller", actorId: "tailnet:unpaired" }, "session");
    await expect(refreshRemoteControllerBoundToSession(unpaired, "session")).rejects.toThrow(RemoteControllerContractError);
  });

  it("answers from the fresh guard probe for a paired controller", async () => {
    let fresh = true;
    const paired = bindRemoteControllerToSession({ kind: "tailnet-controller", actorId: "tailnet:paired", pairedShare,
      pairedShareGuard: { isCurrent: () => true, refreshCurrent: async () => fresh } }, "session");
    await expect(refreshRemoteControllerBoundToSession(paired, "session")).resolves.toBe(true);
    fresh = false;
    await expect(refreshRemoteControllerBoundToSession(paired, "session")).resolves.toBe(false);
    await expect(refreshRemoteControllerBoundToSession(paired, "other-session")).resolves.toBe(false);
  });
});
