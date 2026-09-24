/**
 * The git marketplace IPC boundary (design §13): host renderer only, every
 * answer an envelope, requests checked before the service sees them, and
 * the service built once, on the first request.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNELS, isPublicChannel } from "../../../contract/app-contract.js";
import { MarketplaceError } from "../../../marketplace/errors.js";
import { parseGitMarketplaceResult } from "../../../shared/git-marketplace.js";
import { invokeAppIpcHandlerFromFrame, invokeFileIpcHandler } from "./test-helpers.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { latestBootstrapStatus } from "../../../boot/bootstrap-status.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp" },
  session: { defaultSession: { resolveProxy: async () => "DIRECT" } },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

const channels = CHANNELS.gitMarketplace;

async function setup(overrides: Record<string, unknown> = {}) {
  handlers.clear();
  const service = {
    listSources: vi.fn(async () => []),
    previewSource: vi.fn(async (request: unknown) => ({ kind: "marketplace", request })),
    addSource: vi.fn(),
    removeSource: vi.fn(),
    setEnabled: vi.fn(),
    refresh: vi.fn(async () => []),
    acceptRewrite: vi.fn(),
    setToken: vi.fn(async (host: string) => ({ host })),
    deleteToken: vi.fn(),
    catalog: vi.fn(async (query: unknown) => ({ entries: [], query })),
    detail: vi.fn(),
    planInstall: vi.fn(async (request: unknown) => ({ planId: "p1", request })),
    planUpdate: vi.fn(),
    executeInstall: vi.fn(async () => {
      throw new MarketplaceError("PLAN_EXPIRED", "the install plan is no longer valid; start again");
    }),
    uninstall: vi.fn(async (request: unknown) => ({ key: request, keptDataDir: null })),
    previewDirectMcp: vi.fn(),
    updates: vi.fn(async () => []),
    applyBootInstalls: vi.fn(async () => ({
      report: { installed: [{ kind: "plugin", name: "meeting", source: "ave" }], updated: [], switched: [], skipped: [], failed: [] },
      notice: { forYou: [{ sourceId: "ave", kind: "plugin", name: "meeting" }], required: [], unmanaged: [], lostGrants: [], revoked: [] },
    })),
    ...overrides,
  };
  const create = vi.fn(async () => ({ service: service as never, close: async () => {} }));
  const { registerGitMarketplaceHandlers } = await import("../git-marketplace.js");
  const onBuilt = vi.fn(async () => {});
  const home = mkdtempSync(join(tmpdir(), "ave-git-marketplace-ipc-"));
  const settings = { get: () => ({ updateCheckIntervalMs: 0 }) };
  const registration = registerGitMarketplaceHandlers(
    { auditLogger: { log: vi.fn() }, getMainWindow: () => null, settingsService: settings } as never,
    async () => null,
    create,
    onBuilt,
    home,
  );
  return { service, create, onBuilt, registration, home };
}

beforeEach(() => {
  handlers.clear();
});

describe("git marketplace IPC boundary", () => {
  it("registers every request channel, keeps them internal, and builds the service once", async () => {
    const { create, onBuilt } = await setup();
    const requests = Object.entries(channels).filter(([, channel]) => channel.startsWith("ave:")).map(([, channel]) => channel);
    expect(requests.every((channel) => handlers.has(channel))).toBe(true);
    expect(requests.some((channel) => isPublicChannel(channel))).toBe(false);
    expect(create).not.toHaveBeenCalled();
    await expect(invokeFileIpcHandler(handlers, channels.sourcesList)).resolves.toEqual({ ok: true, value: [] });
    await invokeFileIpcHandler(handlers, channels.catalogList, {});
    expect(create).toHaveBeenCalledTimes(1);
    // The close is registered once, for the one marketplace built.
    expect(onBuilt).toHaveBeenCalledTimes(1);
  });

  it("hands a held deep link to the tab once, and holds the boot-install notice until dismissed, building no marketplace", async () => {
    const { create } = await setup();
    const state = await import("../../../main/app-state.js");
    await expect(invokeFileIpcHandler(handlers, channels.deepLinkTake)).resolves.toEqual({ ok: true, value: null });
    state.setPendingGitMarketplaceLink({ action: "install", key: { sourceId: "ave", kind: "plugin", name: "calendar" } });
    await expect(invokeFileIpcHandler(handlers, channels.deepLinkTake)).resolves.toEqual({
      ok: true,
      value: { action: "install", key: { sourceId: "ave", kind: "plugin", name: "calendar" } },
    });
    await expect(invokeFileIpcHandler(handlers, channels.deepLinkTake)).resolves.toEqual({ ok: true, value: null });

    const notice = { forYou: [{ sourceId: "ave", kind: "plugin" as const, name: "meeting" }], required: [], unmanaged: [], lostGrants: [], revoked: [] };
    state.setBootInstallNotice(notice);
    await expect(invokeFileIpcHandler(handlers, channels.bootInstallsNotice)).resolves.toEqual({ ok: true, value: notice });
    await expect(invokeFileIpcHandler(handlers, channels.bootInstallsNotice)).resolves.toEqual({ ok: true, value: notice });
    await expect(invokeFileIpcHandler(handlers, channels.bootInstallsDismiss)).resolves.toEqual({ ok: true, value: null });
    await expect(invokeFileIpcHandler(handlers, channels.bootInstallsNotice)).resolves.toEqual({ ok: true, value: null });
    state.setBootInstallNotice({ forYou: [], required: [], unmanaged: [], lostGrants: [], revoked: [] });
    await expect(invokeFileIpcHandler(handlers, channels.bootInstallsNotice)).resolves.toEqual({ ok: true, value: null });

    state.setPendingGitMarketplaceLink({ action: "add", url: "acme/tools" });
    await expect(invokeAppIpcHandlerFromFrame(handlers, channels.deepLinkTake, "file:///app/plugin-ui-shell.html"))
      .resolves.toEqual({ ok: false, code: "unauthorized-frame", message: "unauthorized-frame" });
    // A refused frame does not consume the link.
    await expect(invokeFileIpcHandler(handlers, channels.deepLinkTake)).resolves.toEqual({ ok: true, value: { action: "add", url: "acme/tools" } });
    expect(create).not.toHaveBeenCalled();
  });

  it("runs the boot pass once started, publishes its notice and status, and runs it again on Retry", async () => {
    const { registration, service } = await setup();
    const state = await import("../../../main/app-state.js");
    state.setBootInstallNotice(null);
    // Before the window starts it, Retry has nothing to run.
    await expect(invokeFileIpcHandler(handlers, CHANNELS.bootstrap.retry)).resolves.toEqual({
      ok: false,
      error: "the marketplace boot pass has not started",
    });
    expect(service.refresh).not.toHaveBeenCalled();

    registration.startBackground();
    await vi.waitFor(() => expect(latestBootstrapStatus()).toEqual({ phase: "complete", installed: ["meeting"], failed: [] }));
    expect(service.refresh).toHaveBeenCalledTimes(1);
    expect(service.applyBootInstalls).toHaveBeenCalledTimes(1);
    expect(state.getBootInstallNotice()).toEqual({ forYou: [{ sourceId: "ave", kind: "plugin", name: "meeting" }], required: [], unmanaged: [], lostGrants: [], revoked: [] });

    await expect(invokeFileIpcHandler(handlers, CHANNELS.bootstrap.retry)).resolves.toEqual({ ok: true });
    expect(service.applyBootInstalls).toHaveBeenCalledTimes(2);
    await expect(invokeAppIpcHandlerFromFrame(handlers, CHANNELS.bootstrap.retry, "file:///app/plugin-ui-shell.html"))
      .resolves.toEqual({ ok: false, error: "unauthorized-frame" });
    expect(service.applyBootInstalls).toHaveBeenCalledTimes(2);
  });

  it("rechecks the updates when marketplace settings are written, once the boot pass runs", async () => {
    const { registration, service } = await setup();
    registration.settingsChanged();
    expect(service.updates).not.toHaveBeenCalled();

    registration.startBackground();
    await vi.waitFor(() => expect(service.updates).toHaveBeenCalledTimes(1));
    registration.settingsChanged();
    await vi.waitFor(() => expect(service.updates).toHaveBeenCalledTimes(2));
    expect(service.refresh).toHaveBeenCalledTimes(1);
  });

  it("reports the boot pass skipped in an isolated E2E run, and never builds the marketplace", async () => {
    const { registration, create } = await setup();
    vi.stubEnv("AVE_E2E", "1");
    vi.stubEnv("NODE_ENV", "test");
    try {
      registration.startBackground();
    } finally {
      vi.unstubAllEnvs();
    }
    expect(latestBootstrapStatus()).toEqual({ phase: "complete", installed: [], failed: [], skipped: { reason: "e2e-isolated" } });
    expect(create).not.toHaveBeenCalled();
  });

  it("refuses plugin frames without building the service", async () => {
    const { create, service } = await setup();
    const answer = await invokeAppIpcHandlerFromFrame(handlers, channels.installExecute, "file:///app/plugin-ui-shell.html", "p1");
    expect(answer).toEqual({ ok: false, code: "unauthorized-frame", message: "unauthorized-frame" });
    expect(parseGitMarketplaceResult(answer)).toMatchObject({ ok: false, code: "unauthorized-frame" });
    expect(create).not.toHaveBeenCalled();
    expect(service.executeInstall).not.toHaveBeenCalled();
  });

  it("answers a marketplace failure with its code, and an unexpected one as unavailable", async () => {
    await setup({ listSources: vi.fn(async () => { throw new Error("disk gone"); }) });
    await expect(invokeFileIpcHandler(handlers, channels.installExecute, "p1")).resolves.toEqual({
      ok: false,
      code: "PLAN_EXPIRED",
      message: "the install plan is no longer valid; start again",
    });
    await expect(invokeFileIpcHandler(handlers, channels.sourcesList)).resolves.toEqual({ ok: false, code: "unavailable", message: "disk gone" });
  });

  it("builds the service again after a failed build", async () => {
    handlers.clear();
    const create = vi.fn()
      .mockRejectedValueOnce(new Error("policy unreadable"))
      .mockResolvedValue({ service: { listSources: async () => [] }, close: async () => {} });
    const { registerGitMarketplaceHandlers } = await import("../git-marketplace.js");
    registerGitMarketplaceHandlers({ auditLogger: { log: vi.fn() } } as never, async () => null, create, async () => {});
    await expect(invokeFileIpcHandler(handlers, channels.sourcesList)).resolves.toMatchObject({ ok: false, code: "unavailable" });
    await expect(invokeFileIpcHandler(handlers, channels.sourcesList)).resolves.toEqual({ ok: true, value: [] });
    expect(create).toHaveBeenCalledTimes(2);
  });

  it("closes a service whose quit hook failed to register, and builds a fresh one next time", async () => {
    handlers.clear();
    const closes = [vi.fn(async () => {}), vi.fn(async () => {})];
    const create = vi.fn()
      .mockResolvedValueOnce({ service: { listSources: async () => [] }, close: closes[0] })
      .mockResolvedValueOnce({ service: { listSources: async () => [] }, close: closes[1] });
    const onBuilt = vi.fn().mockRejectedValueOnce(new Error("shutdown hook unavailable")).mockResolvedValue(undefined);
    const { registerGitMarketplaceHandlers } = await import("../git-marketplace.js");
    registerGitMarketplaceHandlers({ auditLogger: { log: vi.fn() } } as never, async () => null, create, onBuilt);
    await expect(invokeFileIpcHandler(handlers, channels.sourcesList)).resolves.toMatchObject({ ok: false, code: "unavailable" });
    expect(closes[0]).toHaveBeenCalledTimes(1);
    await expect(invokeFileIpcHandler(handlers, channels.sourcesList)).resolves.toEqual({ ok: true, value: [] });
    expect(create).toHaveBeenCalledTimes(2);
    expect(closes[1]).not.toHaveBeenCalled();
  });

  it("checks each request before the service sees it", async () => {
    const { service } = await setup();
    const invalid = { ok: false, code: "invalid-request" };
    await expect(invokeFileIpcHandler(handlers, channels.sourcesPreview, { input: "acme/tools", auth: "password" })).resolves.toMatchObject(invalid);
    await expect(invokeFileIpcHandler(handlers, channels.installPlan, { sourceId: "acme", kind: "widget", name: "x" })).resolves.toMatchObject(invalid);
    await expect(invokeFileIpcHandler(handlers, channels.installPlan, { sourceId: "acme", kind: "plugin", name: "x", switchSource: "yes" })).resolves.toMatchObject(invalid);
    await expect(invokeFileIpcHandler(handlers, channels.sourcesSetEnabled, "acme", "true")).resolves.toMatchObject(invalid);
    await expect(invokeFileIpcHandler(handlers, channels.catalogList, { installedOnly: 1 })).resolves.toMatchObject(invalid);
    await expect(invokeFileIpcHandler(handlers, channels.directPreview, { serverJson: "{}", select: { package: -1 } })).resolves.toMatchObject(invalid);
    expect(service.previewSource).not.toHaveBeenCalled();
    expect(service.planInstall).not.toHaveBeenCalled();
    expect(service.setEnabled).not.toHaveBeenCalled();
    expect(service.catalog).not.toHaveBeenCalled();
    expect(service.previewDirectMcp).not.toHaveBeenCalled();

    // Only the fields the contract names reach the service.
    await invokeFileIpcHandler(handlers, channels.sourcesPreview, { input: "acme/tools", auth: "token", token: "t0k", extra: 1 });
    expect(service.previewSource).toHaveBeenCalledWith({ input: "acme/tools", auth: "token", token: "t0k" });
    await invokeFileIpcHandler(handlers, channels.installPlan, { sourceId: "acme", kind: "plugin", name: "x", version: "1.2.0", switchSource: true });
    expect(service.planInstall).toHaveBeenCalledWith({ sourceId: "acme", kind: "plugin", name: "x", version: "1.2.0", switchSource: true });
    await invokeFileIpcHandler(handlers, channels.catalogList, { kind: "skill", query: "" });
    expect(service.catalog).toHaveBeenCalledWith({ kind: "skill" });
  });

  it("uninstalls a package bound to no source", async () => {
    const { service } = await setup();
    await expect(invokeFileIpcHandler(handlers, channels.uninstall, { sourceId: null, kind: "mcp", name: "weather", removeData: true })).resolves.toMatchObject({ ok: true });
    expect(service.uninstall).toHaveBeenCalledWith({ sourceId: null, kind: "mcp", name: "weather", removeData: true });
  });
});
