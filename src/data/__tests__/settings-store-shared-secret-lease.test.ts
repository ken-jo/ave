import { useConfigurationOwner } from "../../__tests__/support/configuration-owner.js";

useConfigurationOwner();

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";

import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { directHostFetchTransport } from "../../__tests__/support/host-fetch-transport.js";
import { evaluateHostFetch, runHostFetchHops } from "../../main/host-fetch-guard.js";
import type { HostFetchTransport } from "../../main/host-fetch-guard.js";
import { CredentialLeaseRegistry } from "../../plugins/secret-access/credential-lease-registry.js";
import { SettingsService } from "../settings-store.js";

const roots: string[] = [];
const testDir = dirname(fileURLToPath(import.meta.url));
const childFixture = resolve(testDir, "fixtures/secret-store-process-child.ts");
const repoRoot = resolve(testDir, "../../..");
const nodeCommand = process.env.AVE_TEST_NODE_EXEC_PATH ?? process.execPath;
const secretKey = "llm.apiKey.openai";
const encryption = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => "external_key" as const,
  encryptString: (value: string) => Buffer.from(value),
  decryptString: (value: Buffer) => value.toString(),
};

afterEach(async () => {
  for (const root of roots.splice(0)) await cleanupTmpDir(root);
});

async function fixture(): Promise<{ root: string; store: SettingsService }> {
  const root = mkdtempSync(join(tmpdir(), "ave-shared-secret-lease-"));
  roots.push(root);
  const store = new SettingsService({ userDataPath: root, encryption });
  await store.setSecret(secretKey, "synthetic-old-key");
  return { root, store };
}

function issue(store: SettingsService) {
  const registry = new CredentialLeaseRegistry(store);
  const incarnation = {};
  const signal = new AbortController().signal;
  const reservation = registry.reserve("fixture", incarnation, [secretKey], signal, "lease");
  if (!reservation) throw new Error("reservation missing");
  const lease = registry.register(reservation, {
    key: secretKey, vendor: "openai", secret: store.getSecret(secretKey)!, scheme: "bearer",
    audience: (url) => url.origin === "https://api.example.test", permissionSignal: signal,
  });
  if (!lease || lease.exposure !== "lease") throw new Error("lease missing");
  return registry.beginUse(lease.leaseId, "fixture", incarnation);
}

async function expectNoSend(use: ReturnType<CredentialLeaseRegistry["beginUse"]>): Promise<void> {
  const first = await evaluateHostFetch({
    pluginId: "fixture", rawUrl: "https://api.example.test/v1", allowedDomains: ["api.example.test"],
    ensurePublicUrl: async (rawUrl) => new URL(rawUrl),
  });
  if (!first.ok) throw new Error(first.message);
  const transport = vi.fn(async () => new Response(null));
  await expect(runHostFetchHops({
    pluginId: "fixture", first, init: {}, transport: directHostFetchTransport(transport as typeof fetch),
    allowedDomains: ["api.example.test"], allowPrivateNetworks: false, credentialUse: use,
  })).rejects.toMatchObject({ code: "lease-unavailable" });
  expect(transport).not.toHaveBeenCalled();
}

async function writeFromAnotherProcess(root: string, operation: "rotate" | "delete"): Promise<void> {
  const child = spawn(nodeCommand, ["--import=tsx", childFixture, `settings-${operation}`, root, secretKey], {
    cwd: repoRoot,
    env: process.env,
    stdio: ["ignore", "ignore", "pipe"],
    windowsHide: true,
    timeout: 15_000,
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  await new Promise<void>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => {
      if (code === 0) resolveExit();
      else reject(new Error(`secret writer exited ${code}: ${stderr}`));
    });
  });
}

it.each(["rotate", "delete"] as const)("rejects an old lease after another process completes a %s", async (operation) => {
  const { root, store } = await fixture();
  const use = issue(store);
  await writeFromAnotherProcess(root, operation);
  expect(store.getSecret(secretKey)).toBe(operation === "rotate" ? "child-rotated-key" : null);
  await expectNoSend(use);
});

it("rejects an old lease after a second live settings instance rotates its secret", async () => {
  const { root, store } = await fixture();
  const use = issue(store);
  const other = new SettingsService({ userDataPath: root, encryption });
  await other.setSecret(secretKey, "second-instance-key");
  expect(store.getSecret(secretKey)).toBe("second-instance-key");
  await expectNoSend(use);
});

it("rejects an old lease after a direct same-size edit of the secret document", async () => {
  const { root, store } = await fixture();
  const use = issue(store);
  const path = join(root, "ave-secrets.json");
  const original = readFileSync(path, "utf8");
  const priorTime = statSync(path);
  const oldValue = Buffer.from("synthetic-old-key").toString("base64");
  const newValue = Buffer.from("synthetic-new-key").toString("base64");
  expect(newValue).toHaveLength(oldValue.length);
  expect(original).toContain(oldValue);
  writeFileSync(path, original.replace(oldValue, newValue));
  utimesSync(path, priorTime.atime, priorTime.mtime);
  expect(store.getSecret(secretKey)).toBe("synthetic-new-key");
  await expectNoSend(use);
});

it("rejects an old lease when the shared secret document becomes unreadable", async () => {
  const { root, store } = await fixture();
  const use = issue(store);
  writeFileSync(join(root, "ave-secrets.json"), Buffer.from([0xff]));
  await expectNoSend(use);
});

it("advances every bulk-deleted key before notifying synchronous listeners", async () => {
  const { store } = await fixture();
  const firstKey = "plugin.fixture.first";
  const secondKey = "plugin.fixture.second";
  await store.setSecret(firstKey, "first-key");
  await store.setSecret(secondKey, "second-key");
  const beforeFirst = store.getSecretGeneration(firstKey);
  const beforeSecond = store.getSecretGeneration(secondKey);
  const observations: Array<{ first: string | null; second: string | null; firstGeneration: number; secondGeneration: number }> = [];
  const unsubscribe = store.onLeaseStateChanged(() => {
    observations.push({
      first: store.getSecret(firstKey), second: store.getSecret(secondKey),
      firstGeneration: store.getSecretGeneration(firstKey), secondGeneration: store.getSecretGeneration(secondKey),
    });
  });
  try {
    await store.deletePluginSecrets("fixture", ["first", "second"]);
  } finally {
    unsubscribe();
  }
  expect(observations.some((entry) => entry.first === null && entry.second === null)).toBe(true);
  for (const entry of observations.filter((item) => item.first === null && item.second === null)) {
    expect(entry.firstGeneration).toBeGreaterThan(beforeFirst);
    expect(entry.secondGeneration).toBeGreaterThan(beforeSecond);
  }
});

it("checks an external rotation at the transport handoff after an asynchronous wait", async () => {
  const { root, store } = await fixture();
  const use = issue(store);
  const first = await evaluateHostFetch({
    pluginId: "fixture", rawUrl: "https://api.example.test/v1", allowedDomains: ["api.example.test"],
    ensurePublicUrl: async (rawUrl) => new URL(rawUrl),
  });
  if (!first.ok) throw new Error(first.message);
  const sends = vi.fn();
  const transport = (async () => { throw new Error("handoff contract bypassed"); }) as unknown as HostFetchTransport;
  transport.sendWithHandoff = async (_url, _init, beforeSend) => {
    await writeFromAnotherProcess(root, "rotate");
    beforeSend();
    sends();
    return new Response(null);
  };
  await expect(runHostFetchHops({
    pluginId: "fixture", first, init: {}, transport,
    allowedDomains: ["api.example.test"], allowPrivateNetworks: false, credentialUse: use,
  })).rejects.toMatchObject({ code: "lease-unavailable" });
  expect(sends).not.toHaveBeenCalled();
});

it("checks each redirect hop again at its own transport handoff", async () => {
  const { root, store } = await fixture();
  const use = issue(store);
  const first = await evaluateHostFetch({
    pluginId: "fixture", rawUrl: "https://api.example.test/v1", allowedDomains: ["api.example.test"],
    ensurePublicUrl: async (rawUrl) => new URL(rawUrl),
  });
  if (!first.ok) throw new Error(first.message);
  let hops = 0;
  let sent = 0;
  const transport = (async () => { throw new Error("handoff contract bypassed"); }) as unknown as HostFetchTransport;
  transport.sendWithHandoff = async (_url, _init, beforeSend) => {
    hops += 1;
    if (hops === 2) await writeFromAnotherProcess(root, "rotate");
    beforeSend();
    sent += 1;
    return new Response(null, { status: 302, headers: { location: "https://api.example.test/v2" } });
  };
  await expect(runHostFetchHops({
    pluginId: "fixture", first, init: { redirect: "follow" }, transport,
    allowedDomains: ["api.example.test"], allowPrivateNetworks: false, credentialUse: use,
    ensurePublicUrl: async (rawUrl) => new URL(rawUrl),
  })).rejects.toMatchObject({ code: "lease-unavailable" });
  expect(hops).toBe(2);
  expect(sent).toBe(1);
});

it("revokes an old lease after another instance writes the same secret value", async () => {
  const { root, store } = await fixture();
  const use = issue(store);
  const path = join(root, "ave-secrets.json");
  const before = JSON.parse(readFileSync(path, "utf8")) as { mutation: number };
  const other = new SettingsService({ userDataPath: root, encryption });
  await other.setSecret(secretKey, "synthetic-old-key");
  const after = JSON.parse(readFileSync(path, "utf8")) as { mutation: number };
  expect(after.mutation).toBe(before.mutation + 1);
  await expectNoSend(use);
});

it("revokes an old lease after an unseen external A to B to A sequence", async () => {
  const { root, store } = await fixture();
  const use = issue(store);
  const other = new SettingsService({ userDataPath: root, encryption });
  await other.setSecret(secretKey, "synthetic-new-key");
  expect(store.getSecret(secretKey)).toBe("synthetic-new-key");
  await other.setSecret(secretKey, "synthetic-old-key");
  expect(store.getSecret(secretKey)).toBe("synthetic-old-key");
  await expectNoSend(use);
});

it.each(["missing", "backwards"] as const)("fails closed when the observed mutation counter goes %s", async (change) => {
  const { root, store } = await fixture();
  await store.setSecret(secretKey, "synthetic-old-key");
  const use = issue(store);
  const path = join(root, "ave-secrets.json");
  const document = JSON.parse(readFileSync(path, "utf8")) as { mutation?: number };
  if (change === "missing") delete document.mutation;
  else document.mutation = document.mutation! - 1;
  writeFileSync(path, `${JSON.stringify(document)}\n`);
  await expectNoSend(use);
  const registry = new CredentialLeaseRegistry(store);
  const signal = new AbortController().signal;
  const reservation = registry.reserve("fixture", {}, [secretKey], signal, "lease");
  expect(reservation).not.toBeNull();
  expect(registry.current(reservation!, secretKey, signal)).toBe(false);
  reservation?.finish();
});

it("does not reread the secret document for every response chunk", async () => {
  const { store } = await fixture();
  const use = issue(store);
  const secretStore = (store as unknown as { secretStore: { readIdentity(): unknown } }).secretStore;
  const readIdentity = vi.spyOn(secretStore, "readIdentity");
  const first = await evaluateHostFetch({
    pluginId: "fixture", rawUrl: "https://api.example.test/v1", allowedDomains: ["api.example.test"],
    ensurePublicUrl: async (rawUrl) => new URL(rawUrl),
  });
  if (!first.ok) throw new Error(first.message);
  let remaining = 128;
  const response = await runHostFetchHops({
    pluginId: "fixture", first, init: {},
    transport: directHostFetchTransport((async () => new Response(new ReadableStream({
      pull(controller) {
        if (remaining-- > 0) controller.enqueue(new Uint8Array([65]));
        else controller.close();
      },
    }))) as typeof fetch),
    allowedDomains: ["api.example.test"], allowPrivateNetworks: false, credentialUse: use,
  });
  expect((await response.arrayBuffer()).byteLength).toBe(128);
  expect(readIdentity.mock.calls.length).toBeLessThanOrEqual(1);
});
