import { describe, expect, it } from "vitest";

import { DataKeySession, type A2AOsEncryption } from "../a2a-data-key-session.js";
import { A2AExactReplayStore } from "../a2a-exact-replay-store.js";

// Electron's removed synchronous methods throw, so any use of them fails the test.
function encryption(prefix: string, staleOn: string | null): A2AOsEncryption & { encryptCalls: number } {
  const fake = {
    encryptCalls: 0,
    isEncryptionAvailable: () => { throw new Error("deprecated isEncryptionAvailable called"); },
    encryptString: () => { throw new Error("deprecated encryptString called"); },
    decryptString: () => { throw new Error("deprecated decryptString called"); },
    isAsyncEncryptionAvailable: async () => true,
    encryptStringAsync: async (value: string) => {
      fake.encryptCalls += 1;
      return Buffer.from(`${prefix}${value}`, "utf8");
    },
    decryptStringAsync: async (value: Buffer) => {
      const decoded = value.toString("utf8");
      return {
        shouldReEncrypt: staleOn !== null && decoded.startsWith(staleOn),
        result: decoded.slice(decoded.indexOf(":") + 1),
      };
    },
  };
  return fake;
}

const codec = {
  unavailable: "unavailable",
  invalid: "invalid",
  decodeWrapped: (value: string) => Buffer.from(value, "base64"),
  decodeKey: (value: string) => Buffer.from(value, "base64"),
};

const unwrapped = (wrapped: string) => Buffer.from(wrapped, "base64").toString("utf8");

describe("DataKeySession", () => {
  it("rewraps the data key in memory when safeStorage asks for re-encryption", async () => {
    const minting = new DataKeySession(encryption("old:", null), (size) => Buffer.alloc(size, 9), codec);
    const state: { encryptedDataKey?: string } = {};
    await expect(minting.open(state)).resolves.toBe(false);
    const minted = minting.take(state);
    minting.close();
    expect(unwrapped(state.encryptedDataKey!).startsWith("old:")).toBe(true);

    const rotated = new DataKeySession(encryption("new:", "old:"), () => { throw new Error("must not mint"); }, codec);
    await expect(rotated.open(state)).resolves.toBe(true);
    expect(unwrapped(state.encryptedDataKey!).startsWith("new:")).toBe(true);
    expect(rotated.take(state).equals(minted)).toBe(true);
  });

  it("zeroes the key on close and refuses to hand it out afterwards", async () => {
    const session = new DataKeySession(encryption("old:", null), (size) => Buffer.alloc(size, 9), codec);
    const state: { encryptedDataKey?: string } = {};
    await session.open(state);
    session.take(state);
    session.close();
    expect(() => session.take(state)).toThrow("invalid");
  });

  it("surfaces an unavailable backend when the key is taken", async () => {
    const unavailable = { ...encryption("old:", null), isAsyncEncryptionAvailable: async () => false };
    const session = new DataKeySession(unavailable, (size) => Buffer.alloc(size, 9), codec);
    const state: { encryptedDataKey?: string } = {};
    await expect(session.open(state)).resolves.toBe(false);
    expect(() => session.take(state)).toThrow("unavailable");
  });

  it("persists the rewrapped key through the exact-replay store", async () => {
    let persisted: { encryptedDataKey?: string } | undefined;
    const namespace = {
      readJson: async <T>(_name: string, fallback: T): Promise<T> => structuredClone((persisted ?? fallback) as T),
      writeJson: async (_name: string, value: unknown): Promise<void> => { persisted = structuredClone(value) as typeof persisted; },
    };
    const input = { callerGenerationId: "caller", messageId: "message", bodySha256: "a".repeat(64), intentSha256: "b".repeat(64) };
    const first = new A2AExactReplayStore({ namespace, encryption: encryption("old:", null), maxKeysPerGeneration: 2, makeOwnerToken: () => "owner", random: (size) => Buffer.alloc(size, 7) });
    await first.begin(input);
    await first.complete("owner", { message: { messageId: "reply", role: "ROLE_AGENT", parts: [{ text: "result" }] } });
    expect(unwrapped(persisted!.encryptedDataKey!).startsWith("old:")).toBe(true);

    const rotated = encryption("new:", "old:");
    const restarted = new A2AExactReplayStore({ namespace, encryption: rotated, maxKeysPerGeneration: 2, makeOwnerToken: () => "owner", random: (size) => Buffer.alloc(size, 7) });
    await expect(restarted.begin(input)).resolves.toMatchObject({ kind: "completed", result: { message: { messageId: "reply" } } });
    expect(unwrapped(persisted!.encryptedDataKey!).startsWith("new:")).toBe(true);
    expect(rotated.encryptCalls).toBe(1);
  });
});
