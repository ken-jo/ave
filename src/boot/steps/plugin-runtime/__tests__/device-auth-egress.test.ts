import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createBootHostFixture, createDesktopHostFixture, stationaryLeaseState } from "../../../../__tests__/support/host-runtime.js";
import { directHostFetchTransport } from "../../../../__tests__/support/host-fetch-transport.js";
import { pluginDataDirIn } from "../../../../plugins/__tests__/test-helpers.js";
import { PermissionManager, type ReviewerDispatchResult } from "../../../../permissions/permission-manager.js";
import { runWithEffectGateContext } from "../../../../permissions/effect-enforcement.js";
import type { HostFetchInit, PluginManifest } from "../../../../plugins/types.js";
import { createHostApiFactory } from "../host-api-factory.js";

vi.mock("node:dns", () => ({ promises: { lookup: async () => [{ address: "93.184.216.34", family: 4 }] } }));

const cleanups: Array<() => void> = [];
afterEach(() => { for (const cleanup of cleanups.splice(0).reverse()) cleanup(); });

const ISSUER = "https://issuer.example.test";
const RESOURCE = "https://api.example.test/resource";

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "device-egress-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const secrets = new Map<string, string>();
  const requests: Array<{ url: string; body: string }> = [];
  const disposers: Array<() => void> = [];
  cleanups.push(() => { for (const dispose of disposers) dispose(); });
  const audit = vi.fn();
  const transport = directHostFetchTransport(async (input, init) => {
    const request = new Request(input, init);
    const body = await request.text();
    requests.push({ url: request.url, body });
    const path = new URL(request.url).pathname;
    const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
    if (path.includes(".well-known")) return json({ issuer: ISSUER, device_authorization_endpoint: `${ISSUER}/device`, token_endpoint: `${ISSUER}/token` });
    if (path === "/device") return json({ device_code: "secret-device-grant", user_code: "CODE-1234", verification_uri: `${ISSUER}/verify`, expires_in: 60, interval: 1 });
    if (path === "/token") return json({ access_token: "host-access-token", refresh_token: "secret-refresh-grant", token_type: "Bearer", expires_in: 0 });
    return new Response("resource");
  });
  const permissionManager = new PermissionManager(join(dir, "permissions.json"));
  permissionManager.setMode("auto");
  const evidence: ReviewerDispatchResult = { verdict: { level: "low", reason: "Allowed fixture effect" }, outcome: "fresh", cacheReason: "miss-not-found", judge: { judged: false, skip: "judge-off" } };
  const review = vi.spyOn(permissionManager, "dispatchReviewer").mockResolvedValue(evidence);
  const manifest: PluginManifest = {
    id: "device-egress", name: "Device Egress", version: "1.0.0", description: "Host-owned authorization egress", entry: "plugin.mjs", tools: [],
    capabilities: ["external-auth-consumer"], networkAccess: { allowedDomains: ["example.test"], deviceCodeAuth: true },
  };
  const factory = createHostApiFactory({
    host: createBootHostFixture({ desktop: createDesktopHostFixture({ deviceCodePresentation: { available: () => true, show: async () => () => {} } }) }),
    getPluginRuntime: () => ({ getApprovedPluginAccess: () => undefined, listPluginIds: () => [manifest.id], getWildcardConfigOverride: () => ({}), isShuttingDown: () => false }),
    lateBinding: {}, getRegistryEntry: () => undefined, refreshRegistryEntryCacheIfChanged: async () => {},
    pluginShutdownHandlers: [], readAppPreference: () => undefined,
    settingsService: { ...stationaryLeaseState, getPluginConfig: () => ({}), isSecretStorageEncrypted: async () => true,
      getEncryptedSecret: async (key: string) => secrets.get(key) ?? null,
      setSecret: async (key: string, value: string) => { secrets.set(key, value); }, deleteSecret: async (key: string) => { secrets.delete(key); } },
    bootAuditLogger: { log: audit }, pluginRuntimeAuditLog: () => {}, networkFetch: transport, mainWindow: {},
    openAuthWindowService: async () => [], openLinkWindowService: async () => {}, openAuthPartitionViewerService: async () => {},
    clearAuthPartitionService: async () => {}, shellOpenExternal: async () => {},
    approvalGate: { requestAndWait: async () => { throw new Error("Unexpected approval fallback"); } }, permissionManager,
    routinesStore: {}, getAlertsService: () => undefined,
  } as never);
  const api = factory(manifest.id, manifest, pluginDataDirIn(dir), {
    registerDisposer: dispose => { disposers.push(dispose); }, trackOperation: operation => operation, isActive: () => true, isLifecycleHookActive: () => false,
  }, null, undefined);
  return { api, requests, secrets, review, audit };
}

describe("device authorization at the live plugin network boundary", () => {
  it("keeps private grant bodies out of review and logs while retaining ordinary resource body inspection", async () => {
    const f = fixture();
    await runWithEffectGateContext({ headless: false, toolName: "plugin-login" }, async () => {
      const { handle } = await f.api.authDeviceCode.authorize({ issuer: ISSUER, clientId: "public-client", resource: RESOURCE });
      await f.api.authDeviceCode.fetch({ handle, url: RESOURCE, method: "POST", body: "resource-operation" });
      const hostFetch = f.api.hostFetch;
      if (!hostFetch) throw new Error("Missing fixture network service");
      await hostFetch(RESOURCE, { method: "POST", body: "ordinary-operation", credentialPayload: true } as HostFetchInit);
      const key = [...f.secrets.keys()][0];
      if (!key) throw new Error("Missing persisted credential");
      expect(await f.api.getSecret(key)).toBeNull();
    });
    expect(f.requests.some(request => request.body.includes("secret-device-grant"))).toBe(true);
    expect(f.requests.some(request => request.body.includes("secret-refresh-grant"))).toBe(true);
    const reviews = f.review.mock.calls.map(call => call[1].finalInput);
    expect(JSON.stringify(reviews)).not.toContain("secret-device-grant");
    expect(JSON.stringify(reviews)).not.toContain("secret-refresh-grant");
    expect(JSON.stringify(reviews)).not.toContain("host-access-token");
    expect(reviews).toContainEqual(expect.objectContaining({ body: "[host authorization material]" }));
    expect(reviews).toContainEqual(expect.objectContaining({ body: "resource-operation" }));
    expect(reviews).toContainEqual(expect.objectContaining({ body: "ordinary-operation" }));
    expect(JSON.stringify(f.audit.mock.calls)).not.toContain("secret-device-grant");
    expect(JSON.stringify(f.audit.mock.calls)).not.toContain("secret-refresh-grant");
    expect(JSON.stringify(f.audit.mock.calls)).not.toContain("host-access-token");
  });
});
