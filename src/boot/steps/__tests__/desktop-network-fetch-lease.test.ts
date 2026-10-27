import { useConfigurationOwner } from "../../../__tests__/support/configuration-owner.js";

useConfigurationOwner();

import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it, vi } from "vitest";

import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { SettingsService } from "../../../data/settings-store.js";
import { evaluateHostFetch, runHostFetchHops } from "../../../main/host-fetch-guard.js";
import { CredentialLeaseRegistry } from "../../../plugins/secret-access/credential-lease-registry.js";
import { createDesktopNetworkFetch } from "../desktop-network-fetch.js";

const netState = vi.hoisted(() => ({ requests: [] as Array<{
  headers: Headers; writes: number; ends: number; aborted: boolean;
}>, onRequest: () => {} }));
vi.mock("electron", () => ({ net: {
  fetch: vi.fn(),
  request: vi.fn(() => {
    const request = new EventEmitter() as EventEmitter & {
      headers: Headers; writes: number; ends: number; aborted: boolean;
      setHeader(key: string, value: string): void;
      abort(): void; write(chunk: Buffer): void; end(chunk?: Buffer): void;
    };
    request.headers = new Headers();
    request.writes = 0;
    request.ends = 0;
    request.aborted = false;
    request.setHeader = (key, value) => request.headers.set(key, value);
    request.abort = () => { request.aborted = true; };
    request.write = () => { request.writes += 1; };
    request.end = () => {
      request.ends += 1;
      request.emit("response", { headers: {}, statusCode: 204, statusMessage: "No Content" });
    };
    netState.requests.push(request);
    netState.onRequest();
    return request;
  }),
} }));

const roots: string[] = [];
const testDir = dirname(fileURLToPath(import.meta.url));
const childFixture = resolve(testDir, "../../../data/__tests__/fixtures/secret-store-process-child.ts");
const repoRoot = resolve(testDir, "../../../..");
const secretKey = "llm.apiKey.openai";
const encryption = {
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => "external_key" as const,
  encryptString: (value: string) => Buffer.from(value),
  decryptString: (value: Buffer) => value.toString(),
};

afterEach(async () => {
  netState.requests.length = 0;
  netState.onRequest = () => {};
  for (const root of roots.splice(0)) await cleanupTmpDir(root);
});

it.each([
  ["empty", (): null => null],
  ["text", (): string => "body"],
  ["bytes", (): Uint8Array => new Uint8Array([65])],
  ["array buffer", (): ArrayBuffer => new Uint8Array([65]).buffer],
  ["form encoding", (): URLSearchParams => new URLSearchParams("key=value")],
  ["stream", (): ReadableStream<Uint8Array> => new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array([65])); controller.close(); } })],
  ["empty stream", (): ReadableStream<Uint8Array> => new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } })],
] as const)("calls the handoff before the first %s send operation", async (_name, makeBody) => {
  const transport = createDesktopNetworkFetch().singleHopNetworkFetch;
  if (!("sendWithHandoff" in transport)) throw new Error("transport handoff missing");
  let checks = 0;
  await transport.sendWithHandoff("https://api.example.test/v1", { method: "POST", body: makeBody() } as RequestInit, () => {
    checks += 1;
    const request = netState.requests.at(-1);
    expect(request?.writes).toBe(0);
    expect(request?.ends).toBe(0);
  });
  expect(checks).toBe(1);
  expect(netState.requests.at(-1)?.ends).toBe(1);
});

async function rotateFromChild(root: string): Promise<void> {
  const child = spawn(process.env.AVE_TEST_NODE_EXEC_PATH ?? process.execPath,
    ["--import=tsx", childFixture, "settings-rotate", root, secretKey],
    { cwd: repoRoot, env: process.env, stdio: ["ignore", "ignore", "pipe"], timeout: 15_000 });
  let stderr = "";
  child.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  await new Promise<void>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolveExit() : reject(new Error(`writer exited ${code}: ${stderr}`)));
  });
}

it("checks the lease after the first stream pull and before the desktop request writes", async () => {
  const root = mkdtempSync(join(tmpdir(), "ave-desktop-lease-handoff-"));
  roots.push(root);
  const store = new SettingsService({ userDataPath: root, encryption });
  await store.setSecret(secretKey, "synthetic-old-key");
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
  let requestStarted!: () => void;
  const atRequest = new Promise<void>((resolveRequest) => { requestStarted = resolveRequest; });
  netState.onRequest = requestStarted;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      await atRequest;
      await rotateFromChild(root);
      controller.enqueue(new Uint8Array([65]));
      controller.close();
    },
  });
  const first = await evaluateHostFetch({
    pluginId: "fixture", rawUrl: "https://api.example.test/v1", method: "POST",
    allowedDomains: ["api.example.test"], ensurePublicUrl: async (rawUrl) => new URL(rawUrl),
  });
  if (!first.ok) throw new Error(first.message);
  await expect(runHostFetchHops({
    pluginId: "fixture", first, init: { body, duplex: "half" } as RequestInit,
    transport: createDesktopNetworkFetch().singleHopNetworkFetch,
    allowedDomains: ["api.example.test"], allowPrivateNetworks: false,
    credentialUse: registry.beginUse(lease.leaseId, "fixture", incarnation),
  })).rejects.toMatchObject({ code: "lease-unavailable" });
  expect(netState.requests).toHaveLength(1);
  expect(netState.requests[0]!.headers.get("authorization")).toBe("Bearer synthetic-old-key");
  expect(netState.requests[0]!.writes).toBe(0);
  expect(netState.requests[0]!.aborted).toBe(true);
});
