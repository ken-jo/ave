import { bindRemoteControllerToSession } from "../../shared/chat-origin.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { refuseNamespaceFileCreation } from "../../__tests__/support/feature-namespace.js";
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySecretStore } from "../../audit/hmac-chain.js";
import type { FeatureNamespaceHandle } from "../storage/feature-namespace.js";
import { createTailnetPairedSharingRuntime } from "../tailnet-paired-sharing-runtime.js";
import { createTailnetSharingOwnerService } from "../tailnet-sharing-owner-service.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { unavailableSecretEncryption } from "../../__tests__/support/host-runtime.js";

let directories: string[] = [];

afterEach(async () => {
  for (const directory of directories) await cleanupTmpDir(directory);
  directories = [];
});

function namespace(directory: string): FeatureNamespaceHandle {
  return {
    get dir(): string {
      return directory;
    },
    createFile: refuseNamespaceFileCreation,
    async readJson<T>(_name: string, fallback: T): Promise<T> {
      return fallback;
    },
    async writeJson<T>(name: string, value: T): Promise<void> {
      mkdirSync(directory, { recursive: true, mode: 0o700 });
      writeFileSync(join(directory, name), JSON.stringify(value), "utf8");
    },
    async childDir(name: string): Promise<string> {
      const child = join(directory, name);
      mkdirSync(child, { recursive: true, mode: 0o700 });
      return child;
    },
  };
}

async function fixture(getOwnerLogin: () => string | null | Promise<string | null> = () => "remote-owner@example.test") {
  const directory = mkdtempSync(join(tmpdir(), "ave-tailnet-owner-"));
  directories.push(directory);
  const now = { value: 1_000_000 };
  const current = { id: "private-conversation-a" };
  const secrets = new MemorySecretStore();
  const storage = namespace(directory);
  const runtime = await createTailnetPairedSharingRuntime({ getOwnerLogin, encryption: unavailableSecretEncryption,
    getCurrentConversationId: () => current.id,
    secretStore: secrets,
    storeOptions: {
      namespace: storage,
      now: () => now.value,
    },
  });
  return {
    secrets, now, storage,
    current,
    runtime,
    owner: createTailnetSharingOwnerService({
      runtime,
      getCurrentConversationId: () => current.id,
    }),
  };
}

describe("TailnetSharingOwnerService", () => {
  it("shows only a safe owner projection and creates a share for the live conversation", async () => {
    const f = await fixture();
    const invitation = await f.owner.createInvitation("10m");
    expect(invitation.expiresAt).toBe(1_600_000);
    expect(await f.owner.snapshot()).toEqual({
      invitations: [{ id: invitation.id, expiresAt: invitation.expiresAt }],
      pairings: [],
      shares: [],
    });

    const actor = f.runtime.authorizer.actorIdFor("remote-owner@example.test");
    expect(actor).not.toBeNull();
    const claim = await f.runtime.store.claimInvitation(invitation.code, actor!);
    expect(claim).not.toBeNull();
    expect(JSON.stringify(await f.owner.snapshot()))
      .not.toContain("remote-owner@example.test");
    expect(JSON.stringify(await f.owner.snapshot()))
      .not.toContain(invitation.code);
    expect(JSON.stringify(await f.owner.snapshot()))
      .not.toContain("private-conversation-a");

    expect(await f.owner.activatePairing(claim!.pairingId)).toBe(true);
    expect(await f.owner.createCurrentConversationShare(claim!.pairingId, "control", "1h")).toBe(true);
    expect(f.runtime.store.resolveActiveShare(actor!, "private-conversation-a", "control"))
      .not.toBeNull();

    f.current.id = "private-conversation-b";
    expect(await f.owner.createCurrentConversationShare(claim!.pairingId, "observe", "8h")).toBe(true);
    expect(f.runtime.store.resolveActiveShare(actor!, "private-conversation-b", "observe"))
      .not.toBeNull();
    expect(f.runtime.store.resolveActiveShare(actor!, "private-conversation-b", "control"))
      .toBeNull();
  });

  it("fails closed for malformed owner inputs and emits store change hints after durable mutations", async () => {
    const f = await fixture();
    let changes = 0;
    const unsubscribe = f.owner.subscribe(() => {
      changes += 1;
    });

    await expect(f.owner.createInvitation("bad" as never))
      .rejects.toThrow("tailnet-sharing-owner-input-invalid");
    expect(await f.owner.activatePairing("not-a-uuid")).toBe(false);
    expect(await f.owner.createCurrentConversationShare("not-a-uuid", "observe")).toBe(false);
    expect(await f.owner.revokeShare("not-a-uuid")).toBe(false);
    expect(await f.owner.revokePairing("not-a-uuid")).toBe(false);

    const invitation = await f.owner.createInvitation();
    expect(changes).toBe(1);
    const actor = f.runtime.authorizer.actorIdFor("remote-owner@example.test")!;
    const claim = await f.runtime.store.claimInvitation(invitation.code, actor);
    expect(claim).not.toBeNull();
    expect(await f.owner.activatePairing(claim!.pairingId)).toBe(true);
    expect(await f.owner.createCurrentConversationShare(claim!.pairingId, "observe")).toBe(true);
    expect(await f.owner.revokePairing(claim!.pairingId)).toBe(true);
    unsubscribe();

    expect(changes).toBe(5);
    expect(f.runtime.store.resolveActiveShare(actor, "private-conversation-a", "observe")).toBeNull();
  });
});


describe("owner identity admission and migration", () => {
  it("binds the matching owner to the ordinary permission tree and invalidates a changed local owner", async () => {
    let login: string | null = "remote-owner@example.test";
    const f = await fixture(() => login);
    const invitation = await f.owner.createInvitation();
    const actor = f.runtime.authorizer.actorIdFor(login!)!;
    const claim = await f.runtime.store.claimInvitation(invitation.code, actor);
    expect(await f.owner.activatePairing(claim!.pairingId)).toBe(true);
    expect(await f.owner.createCurrentConversationShare(claim!.pairingId, "control")).toBe(true);
    const authorization = f.runtime.authorizer.authorize(login!, f.current.id, "control", await f.runtime.authorizer.probeOwnerIdentity())!;
    expect(authorization).not.toBeNull();
    const remoteControllerAuthority = bindRemoteControllerToSession({ kind: "tailnet-controller", actorId: authorization.actorId, pairedShare: authorization.pairedShare, pairedShareGuard: authorization.pairedShareGuard }, f.current.id);
    const manager = new PermissionManager(join(directories.at(-1)!, "permissions.json"));
    manager.setMode("strict");
    const request = manager.checkDetailed("owner_network", "builtin", "network", undefined, { sessionId: f.current.id, remoteControllerAuthority });
    expect(manager.resolveRememberedPermission(request, "Remembered owner grant")).toMatchObject({ decision: "allow", reasonCode: "remembered-approval" });
    manager.setMode("allow");
    expect(manager.checkDetailed("owner_network", "builtin", "network", undefined, { sessionId: f.current.id, remoteControllerAuthority }).decision).toBe("allow");
    login = "different-owner@example.test";
    await f.runtime.authorizer.probeOwnerIdentity();
    expect(authorization.pairedShareGuard.isCurrent(authorization.pairedShare)).toBe(false);
    expect(manager.checkDetailed("owner_network", "builtin", "network", undefined, { sessionId: f.current.id, remoteControllerAuthority })).toMatchObject({ decision: "deny", reasonCode: "remote-controller-unbound" });
    expect(await f.owner.snapshot()).toMatchObject({ pairings: [], shares: [] });
    login = "remote-owner@example.test";
    expect(authorization.pairedShareGuard.isCurrent(authorization.pairedShare)).toBe(false);
  });

  it("refuses non-owner pairing, and refuses activation and sharing when the local identity disappears", async () => {
    let login: string | null = "remote-owner@example.test";
    const f = await fixture(() => login);
    const invitation = await f.owner.createInvitation();
    const other = f.runtime.authorizer.actorIdFor("another-user@example.test")!;
    await expect(f.runtime.store.claimInvitation(invitation.code, other)).rejects.toThrow("tailnet-owner-identity-mismatch");
    expect(f.runtime.authorizer.ownerIdentityError("another-user@example.test", await f.runtime.authorizer.probeOwnerIdentity())).toBe("tailnet-owner-identity-mismatch");
    expect(f.runtime.authorizer.authorize("another-user@example.test", f.current.id, "control", await f.runtime.authorizer.probeOwnerIdentity())).toBeNull();
    const actor = f.runtime.authorizer.actorIdFor(login!)!;
    const pending = await f.runtime.store.claimInvitation(invitation.code, actor);
    login = null;
    await expect(f.owner.activatePairing(pending!.pairingId)).rejects.toThrow("tailnet-owner-identity-unavailable");
    expect(await f.owner.snapshot()).toMatchObject({ ownerIdentityError: "tailnet-owner-identity-unavailable", pairings: [], shares: [] });
  });

  it("suspends an unverifiable local owner and revokes grants only for a confirmed different owner", async () => {
    for (const login of ["another-owner@example.test", null]) {
      const f = await fixture();
      const invitation = await f.owner.createInvitation();
      const actor = f.runtime.authorizer.actorIdFor("remote-owner@example.test")!;
      const claim = await f.runtime.store.claimInvitation(invitation.code, actor);
      await f.owner.activatePairing(claim!.pairingId);
      await f.owner.createCurrentConversationShare(claim!.pairingId, "control");
      const directory = directories.at(-1)!;
      const restored = await createTailnetPairedSharingRuntime({ encryption: unavailableSecretEncryption, getCurrentConversationId: () => f.current.id, getOwnerLogin: () => login, secretStore: f.secrets, storeOptions: { namespace: namespace(directory), now: () => f.now.value } });
      expect(restored.store.ownerSnapshot()).toMatchObject({ ...(login === null ? { ownerIdentityError: "tailnet-owner-identity-unavailable" } : {}), pairings: [], shares: [] });
      const persisted = JSON.parse(readFileSync(join(directory, "pairing-share.json"), "utf8"));
      expect(persisted.pairings.every((row: { state: string }) => row.state === (login === null ? "active" : "revoked"))).toBe(true);
      expect(persisted.shares.every((row: { state: string }) => row.state === (login === null ? "active" : "revoked"))).toBe(true);
    }
  });
});

it("rechecks the local owner before activating a share for an already active pairing", async () => {
  let login: string | null = "remote-owner@example.test";
  const f = await fixture(() => login);
  const invitation = await f.owner.createInvitation();
  const actor = f.runtime.authorizer.actorIdFor(login!)!;
  const claim = await f.runtime.store.claimInvitation(invitation.code, actor);
  await f.owner.activatePairing(claim!.pairingId);
  login = null;
  await expect(f.owner.createCurrentConversationShare(claim!.pairingId, "control")).rejects.toThrow("tailnet-owner-identity-unavailable");
  expect(await f.owner.snapshot()).toMatchObject({ ownerIdentityError: "tailnet-owner-identity-unavailable", pairings: [], shares: [] });
});

it("refuses invitation creation when the local node owner cannot be verified", async () => {
  const f = await fixture(() => null);
  await expect(f.owner.createInvitation()).rejects.toThrow("tailnet-owner-identity-unavailable");
  expect(await f.owner.snapshot()).toMatchObject({ ownerIdentityError: "tailnet-owner-identity-unavailable", invitations: [] });
});

it("preserves durable pairings and shares through unavailable identity and resumes only with fresh same-owner evidence", async () => {
  let login: string | null = "remote-owner@example.test";
  const f = await fixture(() => login);
  const invitation = await f.owner.createInvitation();
  const actor = f.runtime.authorizer.actorIdFor(login!)!;
  const claim = await f.runtime.store.claimInvitation(invitation.code, actor);
  await f.owner.activatePairing(claim!.pairingId);
  await f.owner.createCurrentConversationShare(claim!.pairingId, "control");
  const oldEvidence = await f.runtime.authorizer.probeOwnerIdentity();
  const oldAuthority = f.runtime.authorizer.authorize(login!, f.current.id, "control", oldEvidence)!;
  const file = join(directories.at(-1)!, "pairing-share.json");
  const before = readFileSync(file, "utf8");
  login = null;
  await f.runtime.authorizer.probeOwnerIdentity();
  expect(await f.owner.snapshot()).toMatchObject({ ownerIdentityError: "tailnet-owner-identity-unavailable", pairings: [], shares: [] });
  expect(oldAuthority.pairedShareGuard.isCurrent(oldAuthority.pairedShare)).toBe(false);
  expect(readFileSync(file, "utf8")).toBe(before);
  login = "remote-owner@example.test";
  const freshEvidence = await f.runtime.authorizer.probeOwnerIdentity();
  expect(f.runtime.authorizer.authorize(login, f.current.id, "control", oldEvidence)).toBeNull();
  expect(f.runtime.authorizer.authorize(login, f.current.id, "control", freshEvidence)).not.toBeNull();
  expect(oldAuthority.pairedShareGuard.isCurrent(oldAuthority.pairedShare)).toBe(false);
  expect((await f.owner.snapshot()).ownerIdentityError).toBeUndefined();
  expect(readFileSync(file, "utf8")).toBe(before);
});

it("rolls back a mutation persisted while its own request evidence was suspended and replaced", async () => {
  let login: string | null = "remote-owner@example.test";
  const f = await fixture(() => login);
  let release!: () => void;
  let entered!: () => void;
  const enteredWrite = new Promise<void>(resolve => { entered = resolve; });
  const heldWrite = new Promise<void>(resolve => { release = resolve; });
  const write = f.storage.writeJson.bind(f.storage);
  let first = true;
  f.storage.writeJson = async (name, value) => {
    if (first) { first = false; entered(); await heldWrite; }
    return write(name, value);
  };
  const mutation = f.owner.createInvitation();
  const refused = expect(mutation).rejects.toThrow("tailnet-owner-identity-unavailable");
  await enteredWrite;
  login = null;
  await f.runtime.authorizer.probeOwnerIdentity();
  login = "remote-owner@example.test";
  await f.runtime.authorizer.probeOwnerIdentity();
  release();
  await refused;
  expect((await f.owner.snapshot()).invitations).toEqual([]);
  const persisted = JSON.parse(readFileSync(join(directories.at(-1)!, "pairing-share.json"), "utf8"));
  expect(persisted.invitations).toEqual([]);
});

it.each(["changed", "logged-out"] as const)("refuses the next tool in an idle controller turn when the owner is %s without an event stream", async state => {
  let login: string | null = "remote-owner@example.test";
  const f = await fixture(() => login);
  const invitation = await f.owner.createInvitation();
  const actor = f.runtime.authorizer.actorIdFor(login!)!;
  const claim = await f.runtime.store.claimInvitation(invitation.code, actor);
  await f.owner.activatePairing(claim!.pairingId);
  await f.owner.createCurrentConversationShare(claim!.pairingId, "control");
  const authorization = f.runtime.authorizer.authorize(login!, f.current.id, "control", await f.runtime.authorizer.probeOwnerIdentity())!;
  const remoteControllerAuthority = bindRemoteControllerToSession({ kind: "tailnet-controller", actorId: actor, pairedShare: authorization.pairedShare, pairedShareGuard: authorization.pairedShareGuard }, f.current.id);
  const manager = new PermissionManager(join(directories.at(-1)!, "permissions.json"));
  const { ToolExecutor } = await import("../../tools/executor.js");
  const { ToolRegistry } = await import("../../tools/registry.js");
  const { createDynamicTool } = await import("../../tools/base.js");
  let effects = 0;
  const registry = new ToolRegistry();
  registry.register(createDynamicTool({ name: "owner_read", description: "Read session state.", source: "builtin", category: "read", isReadOnly: () => true, jsonSchema: { type: "object" }, execute: async () => { effects += 1; return { output: "read", isError: false }; } }));
  const executor = new ToolExecutor(registry, undefined, manager);
  const run = () => executor.executeAll([{ id: "next-read", name: "owner_read", input: {} }], { sessionId: f.current.id, executionCwd: directories.at(-1)!, permissionContext: { trustOrigin: "user-keyboard", remoteControllerAuthority } });
  expect((await run())[0].is_error).toBeUndefined();
  login = state === "changed" ? "different-owner@example.test" : null;
  expect((await run())[0].is_error).toBe(true);
  expect(effects).toBe(1);
  const snapshot = f.runtime.store.ownerSnapshot();
  expect(snapshot.pairings).toEqual([]);
  expect(snapshot.shares).toEqual([]);
  expect(snapshot.ownerIdentityError).toBe(state === "logged-out" ? "tailnet-owner-identity-unavailable" : undefined);
  await f.owner.snapshot();
  const persisted = JSON.parse(readFileSync(join(directories.at(-1)!, "pairing-share.json"), "utf8"));
  expect(persisted.pairings[0].state).toBe(state === "changed" ? "revoked" : "active");
});

it("serializes concurrent tool-call identity probes so no effect reuses an observation that started before it asked", async () => {
  let calls = 0;
  let release: (() => void) | undefined;
  let pending: Promise<void> | undefined;
  const f = await fixture(async () => { calls += 1; await pending; return "remote-owner@example.test"; });
  const invitation = await f.owner.createInvitation();
  const actor = f.runtime.authorizer.actorIdFor("remote-owner@example.test")!;
  const claim = await f.runtime.store.claimInvitation(invitation.code, actor);
  await f.owner.activatePairing(claim!.pairingId);
  await f.owner.createCurrentConversationShare(claim!.pairingId, "control");
  const authorization = f.runtime.authorizer.authorize("remote-owner@example.test", f.current.id, "control", await f.runtime.authorizer.probeOwnerIdentity())!;
  let requested = 0;
  let allRequested!: () => void;
  const allEffectsWaiting = new Promise<void>(resolve => { allRequested = resolve; });
  const pairedShareGuard = {
    isCurrent: authorization.pairedShareGuard.isCurrent,
    refreshCurrent(binding: typeof authorization.pairedShare) {
      const observation = authorization.pairedShareGuard.refreshCurrent(binding);
      requested += 1;
      if (requested === 3) allRequested();
      return observation;
    },
  };
  const authority = bindRemoteControllerToSession({ kind: "tailnet-controller", actorId: actor, pairedShare: authorization.pairedShare, pairedShareGuard }, f.current.id);
  const { ToolExecutor } = await import("../../tools/executor.js");
  const { ToolRegistry } = await import("../../tools/registry.js");
  const { createDynamicTool } = await import("../../tools/base.js");
  const registry = new ToolRegistry();
  registry.register(createDynamicTool({ name: "owner_read", description: "Read session state.", source: "builtin", category: "read", isReadOnly: () => true, jsonSchema: { type: "object" }, execute: async () => ({ output: "read", isError: false }) }));
  const executor = new ToolExecutor(registry, undefined, new PermissionManager(join(directories.at(-1)!, "permissions.json")));
  const run = () => executor.executeAll([{ id: "concurrent-read", name: "owner_read", input: {} }], { sessionId: f.current.id, executionCwd: directories.at(-1)!, permissionContext: { trustOrigin: "user-keyboard", remoteControllerAuthority: authority } });
  const before = calls;
  pending = new Promise<void>(resolve => { release = resolve; });
  const simultaneous = [run(), run(), run()];
  try {
    await allEffectsWaiting;
    // The first effect starts an observation; the two that ask while it is pending wait for, and share, the next one.
    expect(calls - before).toBe(1);
  } finally {
    release!();
    await Promise.allSettled(simultaneous);
  }
  for (const result of await Promise.all(simultaneous)) expect(result[0].is_error).toBeUndefined();
  expect(calls - before).toBe(2);
  pending = undefined;
  expect((await run())[0].is_error).toBeUndefined();
  expect(calls - before).toBe(3);
});
