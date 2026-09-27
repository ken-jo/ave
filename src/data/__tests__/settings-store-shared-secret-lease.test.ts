import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";

import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { evaluateHostFetch, runHostFetchHops } from "../../main/host-fetch-guard.js";
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
    pluginId: "fixture", first, init: {}, transport: transport as typeof fetch,
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
  const oldValue = Buffer.from("synthetic-old-key").toString("base64");
  const newValue = Buffer.from("synthetic-new-key").toString("base64");
  expect(newValue).toHaveLength(oldValue.length);
  expect(original).toContain(oldValue);
  writeFileSync(path, original.replace(oldValue, newValue));
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
