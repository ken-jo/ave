// Use the real store and ApprovalGate to distinguish share changes from poll-offset-only document changes.
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createTelegramConnectionStore,
  type TelegramConnectionStore,
} from "../telegram-connection-store.js";
import { createTelegramShareChangeWatcher } from "../telegram-share-identity.js";
import { ApprovalGate } from "../../permissions/approval-gate.js";
import { conversationDigestFor, namespaceAt } from "./telegram-connection-namespace.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

const RAW_CONVERSATION_ID = "sentinel-share-identity-conversation-7c19";
const AWAY_SCOPE = "/srv/away-share-scope";

// Distinct SHA-256-shaped literals suffice here; digest derivation belongs to the store tests.
const BOT = "b0".repeat(32);
const OTHER_BOT = "b1".repeat(32);
const ACTOR = "ac".repeat(32);
const OTHER_ACTOR = "ad".repeat(32);
const CODE = "c0".repeat(32);
const CODE_AGAIN = "c1".repeat(32);

let scratchDirectories: string[] = [];

afterEach(async () => {
  for (const directory of scratchDirectories) {
    await cleanupTmpDir(directory);
  }
  scratchDirectories = [];
});

// A store, a gate with a grant armed for the shared conversation, and the watcher wired between them exactly as `main.ts` wires it.
async function armedShare(): Promise<{
  readonly store: TelegramConnectionStore;
  readonly gate: ApprovalGate;
  // Every listener call the store made, share-identity change or not.
  readonly emits: () => number;
}> {
  const directory = mkdtempSync(join(tmpdir(), "ave-share-identity-"));
  scratchDirectories.push(directory);
  const store = createTelegramConnectionStore({
    namespace: namespaceAt(directory),
    now: () => 1_700_000_000_000,
    conversationDigestFor,
  });
  await store.open();
  await store.setConnected(BOT);
  await store.createPendingCode({ codeDigest: CODE });
  await store.completePairing({
    codeDigest: CODE,
    actorDigest: ACTOR,
  });
  await store.createApproval({
    conversationId: RAW_CONVERSATION_ID,
    conversationDigest: conversationDigestFor(BOT, RAW_CONVERSATION_ID),
  });

  const gate = new ApprovalGate(
    { send: () => {}, isDestroyed: () => false } as never,
  );
  expect(
    gate.armAwayAuthority({
      conversationId: RAW_CONVERSATION_ID,
      categories: ["read", "write"],
      directories: [AWAY_SCOPE],
      ttlMs: 60 * 60 * 1000,
      budget: 5,
    }),
  ).toBe(true);

  // The watcher is built AFTER the share exists and the grant is armed, which is the real order: nothing is armed at boot.
  let emitCount = 0;
  const watcher = createTelegramShareChangeWatcher({
    readOwnerSnapshot: () => store.ownerSnapshot(),
    onShareChanged: () => {
      gate.retireAwayAuthority("share-lifecycle");
    },
  });
  store.subscribe(() => {
    emitCount += 1;
    watcher();
  });

  return { store, gate, emits: () => emitCount };
}

describe("Away Authority share-lifecycle retirement", () => {
  it("keeps the grant across an inbound message's poll-offset advance", async () => {
    const { store, gate, emits } = await armedShare();

    await store.recordPollOffset(4242);

    // Assert the store emitted for the poll-offset write; grants must survive that signal before the admitted turn reaches its first approval.
    expect(emits()).toBe(1);
    expect(gate.awayAuthoritySnapshot()).not.toBeNull();
    expect(gate.awayAuthoritySnapshot()?.remaining).toBe(5);
  });

  it("keeps the grant across a provider error note and its clearing", async () => {
    const { store, gate, emits } = await armedShare();

    await store.setLastError("telegram-provider-unreachable");
    await store.setLastError(null);

    // Two real notifications, no share change. The service's derived `TelegramConnectionState` would have read `"error"` and back here, which is why the
    // identity is built from the owner snapshot instead.
    expect(emits()).toBe(2);
    expect(gate.awayAuthoritySnapshot()).not.toBeNull();
  });

  it("keeps the grant when a pairing code is minted but not redeemed", async () => {
    const { store, gate, emits } = await armedShare();

    await store.createPendingCode({ codeDigest: CODE_AGAIN });

    expect(emits()).toBe(1);
    expect(gate.awayAuthoritySnapshot()).not.toBeNull();
  });

  it("retires the grant when the share is revoked", async () => {
    const { store, gate } = await armedShare();
    const approvalId = store.ownerSnapshot().approval?.id;
    expect(approvalId).toBeDefined();

    expect(await store.revokeApproval(approvalId as string)).toBe(true);

    expect(gate.awayAuthoritySnapshot()).toBeNull();
  });

  it("retires the grant when the pairing is revoked", async () => {
    const { store, gate } = await armedShare();
    const pairingId = store.ownerSnapshot().pairing?.id;
    expect(pairingId).toBeDefined();

    expect(await store.revokePairing(pairingId as string)).toBe(true);

    expect(gate.awayAuthoritySnapshot()).toBeNull();
  });

  it("retires the grant on a re-pair, whose fresh authority would look current", async () => {
    const { store, gate } = await armedShare();
    const before = store.ownerSnapshot().pairing?.id;

    // Revoke and pair a different account. The turn that follows carries a brand-new authority whose guard answers `isCurrent` perfectly well, so the
    // per-call re-check inside the gate cannot see anything wrong. This is the asymmetry `retireAll` exists for.
    expect(await store.revokePairing(before as string)).toBe(true);
    await store.createPendingCode({ codeDigest: CODE_AGAIN });
    await store.completePairing({
      codeDigest: CODE_AGAIN,
      actorDigest: OTHER_ACTOR,
    });

    const after = store.ownerSnapshot().pairing?.id;
    expect(after).toBeDefined();
    expect(after).not.toBe(before);
    expect(gate.awayAuthoritySnapshot()).toBeNull();
  });

  it("retires the grant when the owner pauses", async () => {
    const { store, gate } = await armedShare();

    expect(await store.setPaused()).toBe(true);

    expect(gate.awayAuthoritySnapshot()).toBeNull();
  });

  it("retires the grant when the owner disconnects", async () => {
    const { store, gate } = await armedShare();

    await store.setDisconnected();

    expect(gate.awayAuthoritySnapshot()).toBeNull();
  });

  it("retires the grant when the bot itself is replaced", async () => {
    const { store, gate } = await armedShare();

    await store.setConnected(OTHER_BOT);

    expect(gate.awayAuthoritySnapshot()).toBeNull();
  });
});

describe("createTelegramShareChangeWatcher", () => {
  // A snapshot shaped like the owner projection, with one field steerable.
  function ownerSnapshotWith(
    overrides: Partial<ReturnType<TelegramConnectionStore["ownerSnapshot"]>> = {},
  ): ReturnType<TelegramConnectionStore["ownerSnapshot"]> {
    return {
      desiredState: "connected",
      activationEpoch: 2,
      botFingerprint: BOT,
      pairing: { id: "pairing-1", accountFingerprint: ACTOR.slice(0, 12) },
      pairingUnrecognized: false,
      approval: {
        id: "approval-1",
        expiresAt: 1_700_003_600_000,
        conversationDigest: conversationDigestFor(BOT, RAW_CONVERSATION_ID),
      },
      pendingCode: null,
      lastErrorCode: null,
      ...overrides,
    } as ReturnType<TelegramConnectionStore["ownerSnapshot"]>;
  }

  it("does not report the first observation as a change", () => {
    let changes = 0;
    const watcher = createTelegramShareChangeWatcher({
      readOwnerSnapshot: () => ownerSnapshotWith(),
      onShareChanged: () => {
        changes += 1;
      },
    });

    watcher();
    watcher();

    expect(changes).toBe(0);
  });

  it("reports a change once, not on every notification after it", () => {
    let state: "connected" | "paused" = "connected";
    let changes = 0;
    const watcher = createTelegramShareChangeWatcher({
      readOwnerSnapshot: () => ownerSnapshotWith({ desiredState: state }),
      onShareChanged: () => {
        changes += 1;
      },
    });

    state = "paused";
    watcher();
    watcher();
    watcher();

    // A grant is already retired after the first report; re-reporting would turn one lifecycle event into an audit row per subsequent store write.
    expect(changes).toBe(1);
  });

  it("treats a store it cannot read as a share it cannot vouch for", () => {
    let readable = true;
    let changes = 0;
    const watcher = createTelegramShareChangeWatcher({
      readOwnerSnapshot: () => {
        if (!readable) throw new Error("telegram-connection-store-not-open");
        return ownerSnapshotWith();
      },
      onShareChanged: () => {
        changes += 1;
      },
    });

    readable = false;
    watcher();

    expect(changes).toBe(1);
  });
});
