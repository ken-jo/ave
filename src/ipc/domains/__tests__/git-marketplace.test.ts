/**
 * The git marketplace IPC boundary (design §13): host renderer only, every
 * answer an envelope, requests checked before the service sees them, and
 * the service built once, on the first request.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNELS, isPublicChannel } from "../../../contract/app-contract.js";
import { MarketplaceError } from "../../../marketplace/errors.js";
import { NetworkGate } from "../../../marketplace/net/network-gate.js";
import { normalizeSourceUrl } from "../../../marketplace/net/source-url.js";
import { createPinnedFetch } from "../../../marketplace/net/pinned-fetch.js";
import { FilePolicySource } from "../../../marketplace/sources/policy.js";
import { parseGitMarketplaceResult } from "../../../shared/git-marketplace.js";
import { breakDiagnosticScrubberOn, DIAGNOSTIC_KEPT, DIAGNOSTIC_SECRET_PROBES } from "../../../shared/__tests__/fixtures/diagnostic-secret-probes.js";
import { invokeAppIpcHandlerFromFrame, invokeFileIpcHandler } from "./test-helpers.js";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { latestBootstrapStatus } from "../../../boot/bootstrap-status.js";
import { revocationRegistry, type RevocationRule } from "../../../plugins/revocation/revocation-registry.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();

const resumeListeners = new Set<() => void>();

vi.mock("electron", () => ({
  app: { getPath: () => "/tmp" },
  session: { defaultSession: { resolveProxy: async () => "DIRECT" } },
  powerMonitor: {
    on: vi.fn((event: string, listener: () => void) => {
      if (event === "resume") resumeListeners.add(listener);
    }),
    removeListener: vi.fn((event: string, listener: () => void) => {
      if (event === "resume") resumeListeners.delete(listener);
    }),
  },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (...args: unknown[]) => unknown) => {
      handlers.set(channel, handler);
    }),
  },
}));

/** The app's shutdown hooks, run by the test instead of `before-quit`. */
const shutdownHooks = new Map<string, () => void>();
/** The plugin port's install-state preparation, which needs the whole plugin runtime, is not under test here. */
vi.mock("../plugins.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../plugins.js")>()),
  pluginLifecycleServices: () => ({ ensureInstallStateReady: async () => {}, uninstall: async () => {}, retirement: {} }),
}));
vi.mock("../../../main/app-shutdown.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../../main/app-shutdown.js")>()),
  registerShutdownHook: vi.fn((name: string, stop: () => void) => {
    shutdownHooks.set(name, stop);
  }),
}));

/**
 * Holds the update history's next save of a finished apply check until the
 * test releases it, so a test can act while that check is still in flight.
 * Every other save, and every save while nothing is held, goes straight
 * through to the real store.
 */
const historySave = vi.hoisted(() => ({ held: null as Promise<void> | null }));
vi.mock("../../../marketplace/updates/history.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../marketplace/updates/history.js")>();
  return {
    ...original,
    updateHistoryStore: (path: string) => {
      const store = original.updateHistoryStore(path);
      return {
        ...store,
        save: async (history: Parameters<typeof store.save>[0]) => {
          if (history.applyCheckAt !== null && historySave.held) await historySave.held;
          await store.save(history);
        },
      };
    },
  };
});

/** Hold apply-check saves until the returned release is called. */
function holdApplyCheckSaves(): () => void {
  let release!: () => void;
  historySave.held = new Promise<void>((resolve) => {
    release = resolve;
  });
  return () => {
    historySave.held = null;
    release();
  };
}

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
    repairSource: vi.fn(async () => []),
    acceptRewrite: vi.fn(),
    acknowledgeSource: vi.fn(async (id: string, warnings: unknown) => ({ id, acknowledged: warnings })),
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
    discover: vi.fn(async () => ({ result: "ok", reached: ["ave"] })),
    enforceRevocations: vi.fn(async () => {}),
    takeRevocationNotice: vi.fn(() => null),
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
  const marketplace: Record<string, unknown> = { updateCheckIntervalMs: 0 };
  const settings = { get: () => marketplace };
  // A lifetime of its own: the app's shared one (`getMarketplaceLifetime`) would outlive this test's shutdown.
  const lifetime = new AbortController();
  const registration = registerGitMarketplaceHandlers(
    { auditLogger: { log: vi.fn() }, getMainWindow: () => null, settingsService: settings } as never,
    async () => null,
    create,
    onBuilt,
    home,
    lifetime,
  );
  return { service, create, onBuilt, registration, home, marketplace, lifetime };
}

beforeEach(() => {
  handlers.clear();
  resumeListeners.clear();
});

describe("git marketplace IPC boundary", () => {
  it("removes the kept artifacts when keeping is turned off, and only then", async () => {
    // The environment decides over the setting when set; this case is about the setting.
    const saved = process.env.AVE_MARKETPLACE_USE_CACHE;
    delete process.env.AVE_MARKETPLACE_USE_CACHE;
    try {
      const { registration, home, marketplace } = await setup();
      const kept = join(home, "packages", "artifacts");
      mkdirSync(kept, { recursive: true });
      writeFileSync(join(kept, `${"a".repeat(64)}.zip`), "zip");

      registration.settingsChanged();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(existsSync(kept)).toBe(true);

      marketplace.offlineCacheEnabled = false;
      registration.settingsChanged();
      await vi.waitFor(() => expect(existsSync(kept)).toBe(false));
    } finally {
      if (saved === undefined) delete process.env.AVE_MARKETPLACE_USE_CACHE;
      else process.env.AVE_MARKETPLACE_USE_CACHE = saved;
    }
  });

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
    expect(service.discover).not.toHaveBeenCalled();

    // The pass, its apply check and the first update list: what Retry would otherwise join.
    await registration.startBackground();
    expect(latestBootstrapStatus()).toEqual({ phase: "complete", installed: ["meeting"], failed: [] });
    expect(service.discover).toHaveBeenCalledTimes(1);
    expect(service.applyBootInstalls).toHaveBeenCalledTimes(1);
    expect(state.getBootInstallNotice()).toEqual({ forYou: [{ sourceId: "ave", kind: "plugin", name: "meeting" }], required: [], unmanaged: [], lostGrants: [], revoked: [] });

    await expect(invokeFileIpcHandler(handlers, CHANNELS.bootstrap.retry)).resolves.toEqual({ ok: true });
    expect(service.applyBootInstalls).toHaveBeenCalledTimes(2);
    await expect(invokeAppIpcHandlerFromFrame(handlers, CHANNELS.bootstrap.retry, "file:///app/plugin-ui-shell.html"))
      .resolves.toEqual({ ok: false, error: "unauthorized-frame" });
    expect(service.applyBootInstalls).toHaveBeenCalledTimes(2);
  });

  it("joins the boot pass in flight on Retry, and the boot's apply check in flight on Check now", async () => {
    const { registration, service } = await setup();
    const release = holdApplyCheckSaves();
    try {
      const started = registration.startBackground();
      // The boot's apply check has recorded its time and is held saving it: the pass awaits it, so both are in flight.
      await vi.waitFor(async () => {
        const status = await invokeFileIpcHandler(handlers, channels.updatesStatus) as { ok: true; value: { running: boolean; applyCheckAt: string | null } };
        expect(status.value).toMatchObject({ running: true, applyCheckAt: expect.any(String) });
      });
      const retried = invokeFileIpcHandler(handlers, CHANNELS.bootstrap.retry);
      const checked = invokeFileIpcHandler(handlers, channels.updatesCheck);
      release();
      await expect(retried).resolves.toEqual({ ok: true });
      await expect(checked).resolves.toMatchObject({ ok: true, value: { running: false } });
      await started;
    } finally {
      release();
    }
    expect(service.applyBootInstalls).toHaveBeenCalledTimes(1);
    expect(service.discover).toHaveBeenCalledTimes(1);
  });

  it("rechecks the updates when marketplace settings are written, once the boot pass runs", async () => {
    const { registration, service } = await setup();
    registration.settingsChanged();
    expect(service.updates).not.toHaveBeenCalled();

    registration.startBackground();
    // The boot's discovery, then the list after the boot installs.
    await vi.waitFor(() => expect(service.updates).toHaveBeenCalledTimes(2));
    registration.settingsChanged();
    await vi.waitFor(() => expect(service.updates).toHaveBeenCalledTimes(3));
    expect(service.discover).toHaveBeenCalledTimes(1);
    expect(service.refresh).not.toHaveBeenCalled();
  });

  it("answers the update scheduler's status and Check now from the host renderer only, once the scheduler runs", async () => {
    const { registration, service, home } = await setup({ updates: vi.fn(async () => [{ key: { sourceId: "ave", kind: "plugin", name: "meeting" }, displayName: "Meeting", from: "1.0.0", to: "1.1.0" }]) });
    // Before the window starts it there is no scheduler; the card says why.
    await expect(invokeFileIpcHandler(handlers, channels.updatesStatus)).resolves.toEqual({ ok: false, code: "unavailable", message: "update checks have not started" });

    // The boot's apply check has ended, not only recorded its time: Check now starts its own.
    await registration.startBackground();
    const status = await invokeFileIpcHandler(handlers, channels.updatesStatus) as { ok: true; value: { applyCheckAt: string | null; running: boolean } };
    expect(status).toMatchObject({ ok: true, value: { running: false } });
    expect(status.value.applyCheckAt).not.toBeNull();
    const checked = await invokeFileIpcHandler(handlers, channels.updatesCheck) as { ok: true; value: { running: boolean; discovery: { result: string }; packages: unknown[] } };
    expect(checked).toMatchObject({ ok: true, value: { running: false, discovery: { result: "ok" }, packages: [{ key: { name: "meeting" }, state: "manual" }] } });
    expect(service.discover).toHaveBeenCalledTimes(2);
    // Remembered in ~/.ave/marketplaces/updates.json.
    expect(JSON.parse(readFileSync(join(home, "marketplaces", "updates.json"), "utf8"))).toMatchObject({ version: 1, discovery: { result: "ok" } });

    for (const channel of [channels.updatesStatus, channels.updatesCheck]) {
      await expect(invokeAppIpcHandlerFromFrame(handlers, channel, "file:///app/plugin-ui-shell.html"))
        .resolves.toEqual({ ok: false, code: "unauthorized-frame", message: "unauthorized-frame" });
    }
    expect(service.discover).toHaveBeenCalledTimes(2);

    // Waking from sleep runs a due check; nothing is due an instant after a check.
    expect(resumeListeners.size).toBe(1);
    resumeListeners.forEach((listener) => listener());
    expect(service.discover).toHaveBeenCalledTimes(2);
  });

  it("answers every scheduler request with its declared refusal once the app has stopped the scheduler", async () => {
    shutdownHooks.clear();
    const { registration, service } = await setup();
    registration.startBackground();
    await vi.waitFor(() => expect(latestBootstrapStatus()).toMatchObject({ phase: "complete" }));
    // One hook closes the domain's event boundary and stops the scheduler in the same step.
    await vi.waitFor(() => expect(shutdownHooks.has("git-marketplace-events")).toBe(true));
    shutdownHooks.get("git-marketplace-events")!();
    const discoveries = service.discover.mock.calls.length;

    // Retry: the {ok:false,error} envelope it declares, not a rejection across IPC.
    await expect(invokeFileIpcHandler(handlers, CHANNELS.bootstrap.retry)).resolves.toEqual({ ok: false, error: "the update scheduler has stopped" });
    // Check now: the marketplace envelope, `unavailable`.
    await expect(invokeFileIpcHandler(handlers, channels.updatesCheck)).resolves.toEqual({ ok: false, code: "unavailable", message: "the update scheduler has stopped" });
    // The status still answers with what the scheduler knew.
    await expect(invokeFileIpcHandler(handlers, channels.updatesStatus)).resolves.toMatchObject({ ok: true });
    // A settings write rechecks nothing and leaves no rejection behind.
    const unhandled = vi.fn();
    process.on("unhandledRejection", unhandled);
    try {
      registration.settingsChanged();
      await new Promise((resolve) => setTimeout(resolve, 10));
    } finally {
      process.off("unhandledRejection", unhandled);
    }
    expect(unhandled).not.toHaveBeenCalled();
    expect(service.discover.mock.calls.length).toBe(discoveries);
    expect(service.applyBootInstalls).toHaveBeenCalledTimes(1);
    // Nor does a scheduler start again after the shutdown.
    registration.startBackground();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(service.discover.mock.calls.length).toBe(discoveries);
  });

  it("lets a plugin install that lands after the shutdown hook finish, without telling the host or refreshing the bridge", async () => {
    shutdownHooks.clear();
    const { lifetime } = await setup();
    const { onEvent } = await import("../../../boot/types.js");
    const { pluginInstaller } = await import("../git-marketplace.js");
    const { whileRunning } = await import("../../../marketplace/app/background.js");
    const announced = vi.fn();
    const off = onEvent("plugin.installed", announced);
    let land: () => void = () => {};
    const installGitPlugin = vi.fn(
      () =>
        new Promise<{ pluginId: string; action: "install"; staged: false }>((resolve) => {
          land = () => resolve({ pluginId: "calendar", action: "install", staged: false });
        }),
    );
    const deps = {
      pluginMarketplace: { installGitPlugin },
      pluginRuntime: {
        resolvePluginId: (id: string) => id,
        resolvePluginInstallIdIfKnown: () => "calendar@1",
        cancelPendingRestart: vi.fn(),
        listPluginIds: () => ["calendar"],
        activatePreparedArtifact: vi.fn(),
      },
      refreshPluginEventBridge: vi.fn(),
    };
    // The port the domain builds, with the domain's boundary over this registration's lifetime.
    const port = pluginInstaller(deps as never, whileRunning(lifetime.signal));
    const plan = { name: "calendar" } as never;
    try {
      // While the app runs, a landed install is announced and the bridge refreshed.
      const first = port.install(plan, { stage: false, switchSource: false } as never);
      await vi.waitFor(() => expect(installGitPlugin).toHaveBeenCalledTimes(1));
      land();
      await expect(first).resolves.toEqual({ action: "install", staged: false });
      expect(announced).toHaveBeenCalledTimes(1);
      expect(deps.refreshPluginEventBridge).toHaveBeenCalledTimes(1);

      const second = port.install(plan, { stage: false, switchSource: false } as never);
      await vi.waitFor(() => expect(installGitPlugin).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => expect(shutdownHooks.has("git-marketplace-events")).toBe(true));
      shutdownHooks.get("git-marketplace-events")!();
      land();
      // The install itself completes and answers; nothing after it reaches the host or the bridge.
      await expect(second).resolves.toEqual({ action: "install", staged: false });
      expect(announced).toHaveBeenCalledTimes(1);
      expect(deps.refreshPluginEventBridge).toHaveBeenCalledTimes(1);
    } finally {
      off();
    }
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

  it("passes reviewed authority and validated MCP consent through one install request", async () => {
    const executeInstall = vi.fn(async () => ({ installed: true }));
    await setup({ executeInstall });
    const consents = [{ name: "notes", digest: "a".repeat(64) }];
    await expect(invokeFileIpcHandler(handlers, channels.installExecute, "p1", consents))
      .resolves.toEqual({ ok: true, value: { installed: true } });
    expect(executeInstall).toHaveBeenLastCalledWith("p1", consents, true);
    await invokeFileIpcHandler(handlers, channels.installExecute, "p2");
    expect(executeInstall).toHaveBeenLastCalledWith("p2", [], true);
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

  it("carries a failure's detail in its envelope, and the renderer's parse keeps it", async () => {
    const detail = { reason: "dns", host: "nowhere.invalid" } as const;
    await setup({ refresh: vi.fn(async () => { throw new MarketplaceError("SOURCE_UNREACHABLE", "git fetch failed: Could not resolve host", { detail }); }) });
    const answer = await invokeFileIpcHandler(handlers, channels.sourcesRefresh);
    expect(answer).toEqual({ ok: false, code: "SOURCE_UNREACHABLE", message: "git fetch failed: Could not resolve host", detail });
    expect(parseGitMarketplaceResult(answer)).toEqual(answer);
  });

  it("repairs through the refresh channel with the repair intent, and keeps a failed repair's code and detail", async () => {
    const detail = { reason: "repair-failed", sourceId: "ave" } as const;
    const { service } = await setup({
      repairSource: vi.fn(async () => {
        throw new MarketplaceError("SOURCE_LOCAL_DATA_DAMAGED", "could not move the downloaded copy of source ave aside (EBUSY)", { detail });
      }),
    });
    const answer = await invokeFileIpcHandler(handlers, channels.sourcesRefresh, "ave", "repair");
    expect(answer).toEqual({ ok: false, code: "SOURCE_LOCAL_DATA_DAMAGED", message: "could not move the downloaded copy of source ave aside (EBUSY)", detail });
    expect(parseGitMarketplaceResult(answer)).toEqual(answer);
    expect(service.repairSource).toHaveBeenCalledWith("ave");
    expect(service.refresh).not.toHaveBeenCalled();

    // Repair names one source, and no other intent exists.
    await expect(invokeFileIpcHandler(handlers, channels.sourcesRefresh, undefined, "repair")).resolves.toMatchObject({ ok: false, code: "invalid-request" });
    await expect(invokeFileIpcHandler(handlers, channels.sourcesRefresh, "ave", "wipe")).resolves.toMatchObject({ ok: false, code: "invalid-request" });
    expect(service.repairSource).toHaveBeenCalledTimes(1);
  });

  it("refuses an address with a password by its reason, and the password never reaches the renderer", async () => {
    await setup({ previewSource: vi.fn(async (request: { input: string }) => normalizeSourceUrl(request.input)) });
    const answer = await invokeFileIpcHandler(handlers, channels.sourcesPreview, { input: "https://alice:verifier-secret@example.com/owner/repo", auth: "none" });
    expect(answer).toMatchObject({ ok: false, code: "SOURCE_URL_REJECTED", detail: { reason: "credentials-in-url" } });
    expect(JSON.stringify(parseGitMarketplaceResult(answer))).not.toContain("verifier-secret");
  });

  it("scrubs credentials from every failure message it answers with", async () => {
    const bearer = "abc123def456ghi789";
    await setup({
      refresh: vi.fn(async () => {
        throw new MarketplaceError("SOURCE_UNREACHABLE", "fatal: unable to access 'https://alice:verifier-secret@example.com/owner/repo/'");
      }),
      listSources: vi.fn(async () => { throw new Error(`proxy said no\nAuthorization: Bearer ${bearer}\npassword=hunter2`); }),
    });
    const refreshed = await invokeFileIpcHandler(handlers, channels.sourcesRefresh);
    expect(refreshed).toMatchObject({ ok: false, code: "SOURCE_UNREACHABLE", message: expect.stringContaining("https://[REDACTED:CREDENTIALS]@example.com/owner/repo/") });
    expect(JSON.stringify(refreshed)).not.toContain("verifier-secret");
    const listed = await invokeFileIpcHandler(handlers, channels.sourcesList);
    expect(listed).toMatchObject({ ok: false, code: "unavailable", message: expect.stringContaining("proxy said no") });
    expect(JSON.stringify(listed)).not.toMatch(new RegExp(`${bearer}|hunter2`, "u"));
  });

  it("scrubs every credential spelling a git error can carry, and keeps ssh account names", async () => {
    const raw = [
      "pip: git+https://canary-token@github.com/acme/tools",
      'helper failed: token="canarypass"; retry',
      "askpass: secret='canary pass' then",
      "ssh://alice%3Acanary-secret@git.example/acme/tools",
      "scp: alice:canary-scp@github.com:acme/tools",
      "remote ssh://git@git.example/acme/tools",
    ].join("\n");
    await setup({ refresh: vi.fn(async () => { throw new MarketplaceError("SOURCE_UNREACHABLE", raw); }) });
    const answer = parseGitMarketplaceResult(await invokeFileIpcHandler(handlers, channels.sourcesRefresh));
    if (answer === null || answer.ok) throw new Error("expected a failure envelope");
    expect(answer.message).not.toMatch(/canary/u);
    expect(answer.message).toContain("git+https://[REDACTED:CREDENTIALS]@github.com/acme/tools");
    expect(answer.message).toContain("ssh://git@git.example/acme/tools");
  });

  it.each(DIAGNOSTIC_SECRET_PROBES)("scrubs the $id spelling from the envelope it answers with", async ({ text, secret, address, kept }) => {
    // An address goes through the real normalizer, whose refusal quotes it; any other text is a failure's message.
    await setup({
      previewSource: vi.fn(async (request: { input: string }) => {
        if (address) return normalizeSourceUrl(request.input);
        throw new MarketplaceError("SOURCE_UNREACHABLE", request.input);
      }),
    });
    const answer = await invokeFileIpcHandler(handlers, channels.sourcesPreview, { input: text, auth: "none" });
    expect(answer).toMatchObject({ ok: false });
    expect(JSON.stringify(answer)).not.toContain(secret);
    if (kept !== undefined) expect((answer as { message: string }).message).toContain(kept);
  });

  it("keeps a failure's code when the scrubber fails closed, its message wholly redacted", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await setup({ refresh: vi.fn(async () => { throw new MarketplaceError("SOURCE_UNREACHABLE", "git said token=canarysentinel"); }) });
    const restore = breakDiagnosticScrubberOn("canarysentinel");
    let answer: unknown;
    try {
      answer = await invokeFileIpcHandler(handlers, channels.sourcesRefresh);
    } finally {
      restore();
      warn.mockRestore();
    }
    expect(answer).toEqual({ ok: false, code: "SOURCE_UNREACHABLE", message: "[REDACTED:DIAGNOSTIC]" });
  });

  it("keeps diagnostics that name no credential", async () => {
    await setup({ refresh: vi.fn(async () => { throw new MarketplaceError("SOURCE_UNREACHABLE", DIAGNOSTIC_KEPT.join("\n")); }) });
    const answer = parseGitMarketplaceResult(await invokeFileIpcHandler(handlers, channels.sourcesRefresh));
    if (answer === null || answer.ok) throw new Error("expected a failure envelope");
    expect(answer.message).toBe(DIAGNOSTIC_KEPT.join("\n"));
  });

  it("scrubs a detail's diagnostic text before it crosses, as for a policy file the loader refuses", async () => {
    const dir = mkdtempSync(join(tmpdir(), "ave-mkt-policy-"));
    try {
      const key = "https://alice:detail-canary@example.com/x";
      writeFileSync(join(dir, "policy.json"), `{"${key}": 1, "${key}": 2}`);
      const policy = await FilePolicySource.open(join(dir, "policy.json"));
      const gate = new NetworkGate({ policy, allowLoopback: false, transport: createPinnedFetch() });
      await setup({ refresh: vi.fn(async () => gate.checkRemote(normalizeSourceUrl("https://1.1.1.1/acme/market"), { official: false, acknowledged: new Set() })) });
      const answer = await invokeFileIpcHandler(handlers, channels.sourcesRefresh);
      expect(answer).toMatchObject({
        ok: false,
        code: "SOURCE_POLICY_BLOCKED",
        detail: { reason: "policy-invalid", error: expect.stringContaining("https://[REDACTED:CREDENTIALS]@example.com/x") },
      });
      expect(JSON.stringify(answer)).not.toContain("detail-canary");
      expect(parseGitMarketplaceResult(answer)).toEqual(answer);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
    await expect(invokeFileIpcHandler(handlers, channels.installExecute, "p1", [{ name: "notes", digest: "not-a-digest" }])).resolves.toMatchObject(invalid);
    await expect(invokeFileIpcHandler(handlers, channels.installExecute, "p1", [{ name: "notes", digest: "a".repeat(64) }, { name: "notes", digest: "a".repeat(64) }])).resolves.toMatchObject(invalid);
    await expect(invokeFileIpcHandler(handlers, channels.directPreview, { serverJson: "{}", select: { package: -1 } })).resolves.toMatchObject(invalid);
    expect(service.previewSource).not.toHaveBeenCalled();
    expect(service.planInstall).not.toHaveBeenCalled();
    expect(service.executeInstall).not.toHaveBeenCalled();
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

  it("passes only known confirmations, each once, to a preview and to Allow… (§18.5)", async () => {
    const { service } = await setup();
    const invalid = { ok: false, code: "invalid-request" };
    await expect(invokeFileIpcHandler(handlers, channels.sourcesPreview, { input: "http://x.example/m", auth: "none", acknowledge: ["network-folder"] })).resolves.toMatchObject(invalid);
    await expect(invokeFileIpcHandler(handlers, channels.sourcesPreview, { input: "http://x.example/m", auth: "none", acknowledge: ["unencrypted", "unencrypted"] })).resolves.toMatchObject(invalid);
    await expect(invokeFileIpcHandler(handlers, channels.sourcesPreview, { input: "http://x.example/m", auth: "none", acknowledge: "unencrypted" })).resolves.toMatchObject(invalid);
    expect(service.previewSource).not.toHaveBeenCalled();
    await invokeFileIpcHandler(handlers, channels.sourcesPreview, { input: "http://x.example/m", auth: "none", acknowledge: ["unencrypted", "internal-network"] });
    expect(service.previewSource).toHaveBeenCalledWith({ input: "http://x.example/m", auth: "none", acknowledge: ["unencrypted", "internal-network"] });

    await expect(invokeFileIpcHandler(handlers, channels.sourcesAcknowledge, "corp", [])).resolves.toMatchObject(invalid);
    await expect(invokeFileIpcHandler(handlers, channels.sourcesAcknowledge, "corp", ["everything"])).resolves.toMatchObject(invalid);
    await expect(invokeFileIpcHandler(handlers, channels.sourcesAcknowledge, 7, ["unencrypted"])).resolves.toMatchObject(invalid);
    expect(service.acknowledgeSource).not.toHaveBeenCalled();
    await expect(invokeFileIpcHandler(handlers, channels.sourcesAcknowledge, "corp", ["internal-downloads"])).resolves.toEqual({ ok: true, value: { id: "corp", acknowledged: ["internal-downloads"] } });
    expect(service.acknowledgeSource).toHaveBeenCalledWith("corp", ["internal-downloads"]);
  });

  it("uninstalls a package bound to no source", async () => {
    const { service } = await setup();
    await expect(invokeFileIpcHandler(handlers, channels.uninstall, { sourceId: null, kind: "mcp", name: "weather", removeData: true })).resolves.toMatchObject({ ok: true });
    expect(service.uninstall).toHaveBeenCalledWith({ sourceId: null, kind: "mcp", name: "weather", removeData: true });
  });
});

describe("revocationSink", () => {
  const rule: RevocationRule = { kind: "skill", name: "review", versions: "*", reason: "prompt injection", at: "2026-09-24T00:00:00Z", action: "disable", sourceId: "acme" };

  it("feeds the registry, and reloads content and the catalog only when the rules change", async () => {
    revocationRegistry.resetForTesting();
    const reload = vi.fn(async () => {});
    const catalogChanged = vi.fn();
    const { revocationSink } = await import("../git-marketplace.js");
    const sink = revocationSink(async () => ({ reload }) as never, catalogChanged);

    await sink.apply({ rules: [rule], unreadable: [] });
    expect(revocationRegistry.evaluate("skill", "review", "1.0.0")).toMatchObject({ kind: "block", sourceId: "acme" });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(catalogChanged).toHaveBeenCalledTimes(1);

    await sink.apply({ rules: [rule], unreadable: [{ sourceId: "broken", message: "unreadable" }] });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(catalogChanged).toHaveBeenCalledTimes(1);

    await sink.apply({ rules: [], unreadable: [] });
    expect(revocationRegistry.evaluate("skill", "review", "1.0.0")).toEqual({ kind: "allow" });
    expect(reload).toHaveBeenCalledTimes(2);
    expect(catalogChanged).toHaveBeenCalledTimes(2);
    revocationRegistry.resetForTesting();
  });

  it("refreshes the catalog when no installed content runtime exists yet", async () => {
    revocationRegistry.resetForTesting();
    const catalogChanged = vi.fn();
    const { revocationSink } = await import("../git-marketplace.js");
    await revocationSink(async () => null, catalogChanged).apply({ rules: [rule], unreadable: [] });
    expect(catalogChanged).toHaveBeenCalledTimes(1);
    revocationRegistry.resetForTesting();
  });
});
