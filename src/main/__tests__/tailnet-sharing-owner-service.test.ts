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

async function fixture(getOwnerLogin = () => "remote-owner@example.test" as string | null) {
  const directory = mkdtempSync(join(tmpdir(), "ave-tailnet-owner-"));
  directories.push(directory);
  const now = { value: 1_000_000 };
  const current = { id: "private-conversation-a" };
  const secrets = new MemorySecretStore();
  const runtime = await createTailnetPairedSharingRuntime({ getOwnerLogin, encryption: unavailableSecretEncryption,
    getCurrentConversationId: () => current.id,
    secretStore: secrets,
    storeOptions: {
      namespace: namespace(directory),
      now: () => now.value,
    },
  });
  return {
    secrets, now,
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
    expect(f.owner.snapshot()).toEqual({
      invitations: [{ id: invitation.id, expiresAt: invitation.expiresAt }],
      pairings: [],
      shares: [],
    });

    const actor = f.runtime.authorizer.actorIdFor("remote-owner@example.test");
    expect(actor).not.toBeNull();
    const claim = await f.runtime.store.claimInvitation(invitation.code, actor!);
    expect(claim).not.toBeNull();
    expect(JSON.stringify(f.owner.snapshot()))
      .not.toContain("remote-owner@example.test");
    expect(JSON.stringify(f.owner.snapshot()))
      .not.toContain(invitation.code);
    expect(JSON.stringify(f.owner.snapshot()))
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
    const authorization = f.runtime.authorizer.authorize(login!, f.current.id, "control")!;
    expect(authorization).not.toBeNull();
    const remoteControllerAuthority = bindRemoteControllerToSession({ kind: "tailnet-controller", actorId: authorization.actorId, pairedShare: authorization.pairedShare, pairedShareGuard: authorization.pairedShareGuard }, f.current.id);
    const manager = new PermissionManager(join(directories.at(-1)!, "permissions.json"));
    manager.setMode("strict");
    const request = manager.checkDetailed("owner_network", "builtin", "network", undefined, { sessionId: f.current.id, remoteControllerAuthority });
    expect(manager.resolveRememberedPermission(request, "Remembered owner grant")).toMatchObject({ decision: "allow", reasonCode: "remembered-approval" });
    manager.setMode("allow");
    expect(manager.checkDetailed("owner_network", "builtin", "network", undefined, { sessionId: f.current.id, remoteControllerAuthority }).decision).toBe("allow");
    login = "different-owner@example.test";
    expect(authorization.pairedShareGuard.isCurrent(authorization.pairedShare)).toBe(false);
    expect(manager.checkDetailed("owner_network", "builtin", "network", undefined, { sessionId: f.current.id, remoteControllerAuthority })).toMatchObject({ decision: "deny", reasonCode: "remote-controller-unbound" });
    expect(f.owner.snapshot()).toMatchObject({ ownerIdentityError: "tailnet-owner-identity-mismatch", pairings: [], shares: [] });
    login = "remote-owner@example.test";
    expect(authorization.pairedShareGuard.isCurrent(authorization.pairedShare)).toBe(false);
  });

  it("refuses non-owner pairing, and refuses activation and sharing when the local identity disappears", async () => {
    let login: string | null = "remote-owner@example.test";
    const f = await fixture(() => login);
    const invitation = await f.owner.createInvitation();
    const other = f.runtime.authorizer.actorIdFor("another-user@example.test")!;
    await expect(f.runtime.store.claimInvitation(invitation.code, other)).rejects.toThrow("tailnet-owner-identity-mismatch");
    expect(f.runtime.authorizer.ownerIdentityError("another-user@example.test")).toBe("tailnet-owner-identity-mismatch");
    expect(f.runtime.authorizer.authorize("another-user@example.test", f.current.id, "control")).toBeNull();
    const actor = f.runtime.authorizer.actorIdFor(login!)!;
    const pending = await f.runtime.store.claimInvitation(invitation.code, actor);
    login = null;
    await expect(f.owner.activatePairing(pending!.pairingId)).rejects.toThrow("tailnet-owner-identity-unavailable");
    expect(f.owner.snapshot()).toMatchObject({ ownerIdentityError: "tailnet-owner-identity-unavailable", pairings: [], shares: [] });
  });

  it("revokes existing persisted pairings and shares when restored under a different or unverifiable local owner", async () => {
    for (const login of ["another-owner@example.test", null]) {
      const f = await fixture();
      const invitation = await f.owner.createInvitation();
      const actor = f.runtime.authorizer.actorIdFor("remote-owner@example.test")!;
      const claim = await f.runtime.store.claimInvitation(invitation.code, actor);
      await f.owner.activatePairing(claim!.pairingId);
      await f.owner.createCurrentConversationShare(claim!.pairingId, "control");
      const directory = directories.at(-1)!;
      const restored = await createTailnetPairedSharingRuntime({ encryption: unavailableSecretEncryption, getCurrentConversationId: () => f.current.id, getOwnerLogin: () => login, secretStore: f.secrets, storeOptions: { namespace: namespace(directory), now: () => f.now.value } });
      expect(restored.store.ownerSnapshot()).toMatchObject({ ownerIdentityError: login === null ? "tailnet-owner-identity-unavailable" : "tailnet-owner-identity-mismatch", pairings: [], shares: [] });
      const persisted = JSON.parse(readFileSync(join(directory, "pairing-share.json"), "utf8"));
      expect(persisted.pairings.every((row: { state: string }) => row.state === "revoked")).toBe(true);
      expect(persisted.shares.every((row: { state: string }) => row.state === "revoked")).toBe(true);
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
  expect(f.owner.snapshot()).toMatchObject({ ownerIdentityError: "tailnet-owner-identity-unavailable", pairings: [], shares: [] });
});

it("refuses invitation creation when the local node owner cannot be verified", async () => {
  const f = await fixture(() => null);
  await expect(f.owner.createInvitation()).rejects.toThrow("tailnet-owner-identity-unavailable");
  expect(f.owner.snapshot()).toMatchObject({ ownerIdentityError: "tailnet-owner-identity-unavailable", invitations: [] });
});
