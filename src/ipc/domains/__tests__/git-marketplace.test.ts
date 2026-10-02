/**
 * The git marketplace IPC boundary (design §13): host renderer only, every
 * answer an envelope, requests checked before the service sees them, and
 * the service built once, on the first request.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNELS, isPublicChannel } from "../../../contract/app-contract.js";
import { MARKETPLACE_ERROR_DETAIL_FIELDS, MarketplaceError } from "../../../marketplace/errors.js";
import { NetworkGate } from "../../../marketplace/net/network-gate.js";
import { normalizeSourceUrl } from "../../../marketplace/net/source-url.js";
import { createPinnedFetch } from "../../../marketplace/net/pinned-fetch.js";
import { FilePolicySource } from "../../../marketplace/sources/policy.js";
import { parseGitMarketplaceResult, type EnteredTargetWarningView } from "../../../shared/git-marketplace.js";
import { breakDiagnosticScrubberOn, DIAGNOSTIC_KEPT, DIAGNOSTIC_SECRET_PROBES } from "../../../shared/__tests__/fixtures/diagnostic-secret-probes.js";
import { invokeAppIpcHandlerFromFrame, invokeFileIpcHandler } from "./test-helpers.js";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { latestBootstrapStatus } from "../../../boot/bootstrap-status.js";
import { revocationRegistry, type RevocationRule } from "../../../plugins/revocation/revocation-registry.js";
import { FakeVolume, TEST_FOLDER_LIMITS } from "../../../marketplace/__tests__/fixtures/folder-fs.js";
import { folderService } from "../../../marketplace/__tests__/fixtures/folder-service.js";
import { policyLoad, policySource } from "../../../marketplace/__tests__/fixtures/policy.js";
import { translate } from "../../../i18n/translate.js";
import { ENTRY_SUBJECT, failureText, warningText } from "../../../ui/renderer/tabs/git-marketplace/labels.js";

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

/** `window` stands for the app window broadcasts reach; none by default. */
async function setup(overrides: Record<string, unknown> = {}, window: unknown = null) {
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
    { auditLogger: { log: vi.fn() }, getMainWindow: () => window, settingsService: settings } as never,
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

    // The boot's discovery, then the list after the boot installs.
    await registration.startBackground();
    expect(service.updates).toHaveBeenCalledTimes(2);
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
    // This scheduler's own boot pass: the recorded bootstrap status is process-wide and may still be an earlier test's.
    await registration.startBackground();
    expect(latestBootstrapStatus()).toMatchObject({ phase: "complete" });
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
    await registration.startBackground();
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
    let started: Promise<void>;
    try {
      started = registration.startBackground();
    } finally {
      vi.unstubAllEnvs();
    }
    await started;
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

  describe("source refusals the renderer turns into advice (§18.4, §18.8)", () => {
    /** The renderer's sentence for an envelope, in both catalogs. */
    const sentences = (answer: unknown) => {
      const parsed = parseGitMarketplaceResult(answer);
      if (parsed.ok) throw new Error("expected a failure");
      return {
        en: failureText((key, vars) => translate("en", key, vars), parsed, ENTRY_SUBJECT),
        ko: failureText((key, vars) => translate("ko", key, vars), parsed, ENTRY_SUBJECT),
      };
    };

    it("answers a drive whose classifier cannot run with classifier-unavailable, rendered as reinstall advice", async () => {
      const root = mkdtempSync(join(tmpdir(), "ave-ipc-folder-"));
      const volume = new FakeVolume("win32").file("C:\\m\\SKILL.md", "---\nname: note\ndescription: d\n---\n");
      volume.queryDosDevice = async () => {
        throw new Error("Windows folder classifier is missing: C:\\Ave\\resources\\windows-path-kind\\x64\\ave-path-kind.exe. Reinstall Ave.");
      };
      const harness = await folderService({ root, folders: { fs: volume, platform: "win32", limits: TEST_FOLDER_LIMITS }, home: "C:\\Users\\example" });
      try {
        await setup({ previewSource: vi.fn((request: never) => harness.service.previewSource(request)) });
        const answer = await invokeFileIpcHandler(handlers, channels.sourcesPreview, { input: "C:\\m", auth: "none" });
        expect(answer).toMatchObject({ ok: false, code: "SOURCE_LOCAL_UNREADABLE", detail: { reason: "classifier-unavailable", path: "C:\\m" } });
        expect((answer as { message: string }).message).toContain("classifier is missing");
        expect(sentences(answer)).toEqual({
          en: "Ave cannot tell whether C:\\m is on another computer because its folder classifier is missing or broken. Reinstall Ave.",
          ko: "Ave의 폴더 분류 도구가 없거나 손상되어 C:\\m이(가) 다른 컴퓨터에 있는지 알 수 없습니다. Ave를 다시 설치하세요.",
        });
      } finally {
        harness.service.close();
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("answers a folder overlapping a source with the relation and the source, rendered as what to do instead of another id", async () => {
      const root = mkdtempSync(join(tmpdir(), "ave-ipc-folder-"));
      const skill = "---\nname: note\ndescription: d\n---\n";
      const volume = new FakeVolume("linux").file("/m/SKILL.md", skill).file("/m/inner/SKILL.md", skill);
      const harness = await folderService({ root, folders: { fs: volume, platform: "linux", limits: TEST_FOLDER_LIMITS } });
      try {
        const outer = await harness.service.previewSource({ input: "/m", auth: "none" });
        if (outer.type === "confirm") throw new Error("unexpected confirmation");
        await harness.service.addSource({ previewId: outer.previewId, id: "team" });
        await setup({
          previewSource: vi.fn((request: never) => harness.service.previewSource(request)),
          addSource: vi.fn((request: never) => harness.service.addSource(request)),
        });
        const preview = (await invokeFileIpcHandler(handlers, channels.sourcesPreview, { input: "/m/inner", auth: "none" })) as { ok: true; value: { previewId: string } };
        const inside = await invokeFileIpcHandler(handlers, channels.sourcesAdd, { previewId: preview.value.previewId, id: "inner" });
        expect(inside).toMatchObject({ ok: false, code: "SOURCE_ID_TAKEN", detail: { reason: "folder-inside-source", path: "/m/inner", existingId: "team", existingPath: "/m" } });
        expect(sentences(inside)).toEqual({
          en: "Folder sources cannot overlap: /m/inner lies inside /m, which is already added as team. Use team, or remove it and add the folder you want.",
          ko: "폴더 소스는 서로 겹칠 수 없습니다. /m/inner은(는) 이미 team(으)로 추가된 /m 안에 있습니다. team을(를) 쓰거나, 지운 뒤 원하는 폴더를 추가하세요.",
        });
        const again = (await invokeFileIpcHandler(handlers, channels.sourcesPreview, { input: "/m", auth: "none" })) as { ok: true; value: { previewId: string } };
        const same = await invokeFileIpcHandler(handlers, channels.sourcesAdd, { previewId: again.value.previewId, id: "again" });
        expect(same).toMatchObject({ ok: false, code: "SOURCE_ID_TAKEN", detail: { reason: "folder-already-added", path: "/m", existingId: "team" } });
        expect(sentences(same).en).toBe("/m is already added as team. Use team, or remove it before adding this folder again.");
        expect(sentences(same).ko).toBe("/m은(는) 이미 team(으)로 추가되어 있습니다. team을(를) 쓰거나, 지운 뒤 이 폴더를 다시 추가하세요.");
      } finally {
        harness.service.close();
        rmSync(root, { recursive: true, force: true });
      }
    });

    describe("a token in any string main hands the renderer (§18.8)", () => {
      // Real token shapes, assembled here so no whole token sits in the source.
      const TOKENS = [`gh${"p_"}${"A1b2C3d4".repeat(5).slice(0, 36)}`, `sk${"-proj-"}${"Z9y8X7w6".repeat(8)}`];
      const leaks = (text: string) => TOKENS.some((token) => text.toLowerCase().includes(token.toLowerCase()));
      /** `value` with every string in it, at any depth, replaced by `token`. */
      const poison = (value: unknown, token: string): unknown =>
        typeof value === "string" ? token
          : Array.isArray(value) ? value.map((item) => poison(item, token))
            : typeof value === "object" && value !== null ? Object.fromEntries(Object.entries(value).map(([key, item]) => [key, poison(item, token)]))
              : value;
      const fields = Object.entries(MARKETPLACE_ERROR_DETAIL_FIELDS).flatMap(([code, reasons]) =>
        Object.entries(reasons as Record<string, Record<string, string>>).flatMap(([reason, declared]) =>
          Object.entries(declared).filter(([, kind]) => kind !== "number").flatMap(([field]) => TOKENS.map((token) => ({ code, reason, declared, field, token })))));

      it.each(fields)("$code $reason: a token in $field never crosses, identifier or not", async ({ code, reason, declared, field, token }) => {
        const benign = (kind: string) => (kind === "number" ? 1 : kind === "string[]" ? ["x"] : "x");
        const detail = Object.fromEntries(Object.entries(declared).map(([name, kind]) => [name, name === field ? (kind === "string[]" ? [token] : token) : benign(kind)]));
        await setup({
          refresh: vi.fn(async () => {
            throw new MarketplaceError(code as never, "failed", { detail: { reason, ...detail } as never });
          }),
        });
        const answer = await invokeFileIpcHandler(handlers, channels.sourcesRefresh);
        expect(answer).toMatchObject({ ok: false, code, detail: { reason } });
        const { en, ko } = sentences(answer);
        expect(leaks(JSON.stringify(answer))).toBe(false);
        expect(leaks(`${en}\n${ko}`)).toBe(false);
      });

      it("never lets one cross in an answer of the preview, list, add, sync and update-status channels", async () => {
        const root = mkdtempSync(join(tmpdir(), "ave-ipc-payload-"));
        const skill = "---\nname: note\ndescription: d\n---\n";
        const harness = await folderService({ root, folders: { fs: new FakeVolume("linux").file("/m/SKILL.md", skill), platform: "linux", limits: TEST_FOLDER_LIMITS } });
        const network = await folderService({ root: mkdtempSync(join(root, "win-")), folders: { fs: new FakeVolume("win32"), platform: "win32", limits: TEST_FOLDER_LIMITS }, home: "C:\\Users\\example" });
        try {
          // Real answers of each shape, every string in them then replaced by a token.
          const preview = await harness.service.previewSource({ input: "/m", auth: "none" });
          if (preview.type === "confirm") throw new Error("unexpected confirmation");
          const confirm = await network.service.previewSource({ input: "\\\\server\\share\\m", auth: "none" });
          expect(confirm.type).toBe("confirm");
          const added = await harness.service.addSource({ previewId: preview.previewId, id: "team" });
          const listed = await harness.service.listSources();
          const synced = await harness.service.refresh("team");
          for (const token of TOKENS) {
            const sent = vi.fn();
            await setup({
              previewSource: vi.fn(async (request: { input: string }) => poison(request.input === "c" ? confirm : preview, token)),
              listSources: vi.fn(async () => poison(listed, token)),
              addSource: vi.fn(async () => poison(added, token)),
              acknowledgeSource: vi.fn(async () => poison(added, token)),
              setEnabled: vi.fn(async () => poison(added, token)),
              refresh: vi.fn(async () => poison(synced, token)),
              repairSource: vi.fn(async () => poison(synced, token)),
              // A key the scheduler can match, so the package and its name reach the status and its broadcasts.
              updates: vi.fn(async () => [{ key: { sourceId: "ave", kind: "plugin", name: "meeting" }, displayName: `Meeting ${token}`, from: "1.0.0", to: "1.1.0" }]),
            }, { isDestroyed: () => false, webContents: { send: sent } }).then(async ({ registration }) => {
              const answers = [
                await invokeFileIpcHandler(handlers, channels.sourcesPreview, { input: "/m", auth: "none" }),
                await invokeFileIpcHandler(handlers, channels.sourcesPreview, { input: "c", auth: "none" }),
                await invokeFileIpcHandler(handlers, channels.sourcesList),
                await invokeFileIpcHandler(handlers, channels.sourcesAdd, { previewId: "p", id: "team" }),
                await invokeFileIpcHandler(handlers, channels.sourcesAcknowledge, "team", ["network-folder"]),
                await invokeFileIpcHandler(handlers, channels.sourcesSetEnabled, "team", false),
                await invokeFileIpcHandler(handlers, channels.sourcesRefresh, "team"),
                await invokeFileIpcHandler(handlers, channels.sourcesRefresh, "team", "repair"),
              ];
              await registration.startBackground();
              answers.push(await invokeFileIpcHandler(handlers, channels.updatesStatus), await invokeFileIpcHandler(handlers, channels.updatesCheck));
              for (const answer of answers) {
                expect(answer).toMatchObject({ ok: true });
                expect(leaks(JSON.stringify(answer))).toBe(false);
              }
              // The scheduler's broadcasts (its status, the boot status and notice) cross scrubbed too.
              expect(sent.mock.calls.map(([channel]) => channel)).toEqual(expect.arrayContaining([channels.updateStatusChanged, channels.bootInstallsApplied, CHANNELS.bootstrap.status]));
              expect(leaks(JSON.stringify(sent.mock.calls))).toBe(false);
            });
          }
        } finally {
          harness.service.close();
          network.service.close();
          rmSync(root, { recursive: true, force: true });
        }
      });

      it("names a source and a package whose names only look like a credential back to main unchanged: list, disable, catalog, plan", async () => {
        const root = mkdtempSync(join(tmpdir(), "ave-ipc-roundtrip-"));
        const name = "test-marketplace2026";
        const volume = new FakeVolume("linux")
          .file("/m/marketplace.2.json", JSON.stringify({ schemaVersion: 2, name, displayName: "Test marketplace", packages: [{ kind: "skill", name, path: `skills/${name}` }] }))
          .file(`/m/skills/${name}/ave-package.json`, JSON.stringify({ schemaVersion: 2, kind: "skill", name, version: "1.0.0", minAppVersion: "0.12.0", payload: { entry: "SKILL.md" } }))
          .file(`/m/skills/${name}/SKILL.md`, `---\nname: ${name}\ndescription: d\n---\nBody.\n`);
        const harness = await folderService({ root, folders: { fs: volume, platform: "linux", limits: TEST_FOLDER_LIMITS } });
        try {
          const real = harness.service;
          await setup({
            previewSource: vi.fn((request: never) => real.previewSource(request)),
            addSource: vi.fn((request: never) => real.addSource(request)),
            listSources: vi.fn(() => real.listSources()),
            setEnabled: vi.fn((id: string, enabled: boolean) => real.setEnabled(id, enabled)),
            catalog: vi.fn((query: never) => real.catalog(query)),
            planInstall: vi.fn((request: never) => real.planInstall(request)),
          });
          const preview = (await invokeFileIpcHandler(handlers, channels.sourcesPreview, { input: "/m", auth: "none" })) as { ok: true; value: { previewId: string } };
          expect(await invokeFileIpcHandler(handlers, channels.sourcesAdd, { previewId: preview.value.previewId, id: name })).toMatchObject({ ok: true, value: { id: name } });
          // Each request names what the renderer was handed, exactly as a renderer would.
          const listed = (await invokeFileIpcHandler(handlers, channels.sourcesList)) as { ok: true; value: Array<{ id: string }> };
          const id = listed.value.find((source) => source.id.startsWith("test-"))!.id;
          expect(id).toBe(name);
          expect(await invokeFileIpcHandler(handlers, channels.sourcesSetEnabled, id, false)).toMatchObject({ ok: true });
          expect(await invokeFileIpcHandler(handlers, channels.sourcesSetEnabled, id, true)).toMatchObject({ ok: true });
          const catalog = (await invokeFileIpcHandler(handlers, channels.catalogList, { sourceId: id })) as { ok: true; value: { entries: Array<{ key: { sourceId: string; kind: string; name: string } }> } };
          const [entry] = catalog.value.entries;
          expect(entry?.key).toEqual({ sourceId: name, kind: "skill", name });
          expect(await invokeFileIpcHandler(handlers, channels.installPlan, entry!.key)).toMatchObject({ ok: true, value: { planId: expect.any(String) } });
        } finally {
          harness.service.close();
          rmSync(root, { recursive: true, force: true });
        }
      });

      describe("an identifier with a credential's shape is refused where it enters, with its reason in both languages", () => {
        // Assembled here: one fits a source id and a package name, one an MCP server's key.
        const NAME_TOKEN = `glp${"at-"}${"abcd1234".repeat(3)}`;
        const KEY_TOKEN = `gh${"p_"}${"A1b2C3d4".repeat(5).slice(0, 36)}`;
        const refusal = async (volume: FakeVolume, act: (harness: Awaited<ReturnType<typeof folderService>>) => Promise<unknown>) => {
          const root = mkdtempSync(join(tmpdir(), "ave-ipc-ingress-"));
          const harness = await folderService({ root, folders: { fs: volume, platform: "linux", limits: TEST_FOLDER_LIMITS } });
          try {
            return await act(harness);
          } finally {
            harness.service.close();
            rmSync(root, { recursive: true, force: true });
          }
        };
        const noToken = (answer: unknown) => {
          const text = JSON.stringify(answer);
          expect(text).not.toContain(NAME_TOKEN);
          expect(text).not.toContain(KEY_TOKEN);
        };

        it("refuses a source id", async () => {
          const answer = await refusal(new FakeVolume("linux").file("/m/SKILL.md", "---\nname: note\ndescription: d\n---\n"), async (harness) => {
            await setup({
              previewSource: vi.fn((request: never) => harness.service.previewSource(request)),
              addSource: vi.fn((request: never) => harness.service.addSource(request)),
            });
            const preview = (await invokeFileIpcHandler(handlers, channels.sourcesPreview, { input: "/m", auth: "none" })) as { ok: true; value: { previewId: string } };
            return invokeFileIpcHandler(handlers, channels.sourcesAdd, { previewId: preview.value.previewId, id: NAME_TOKEN });
          });
          expect(answer).toMatchObject({ ok: false, code: "SOURCE_ID_INVALID", detail: { reason: "holds-credential" } });
          noToken(answer);
          expect(sentences(answer)).toEqual({
            en: "This id looks like a password or token, so it cannot be used. Choose another id.",
            ko: "이 ID는 비밀번호나 토큰처럼 보여 쓸 수 없습니다. 다른 ID를 고르세요.",
          });
        });

        it.each([
          ["a package name", new FakeVolume("linux").file("/m/SKILL.md", `---\nname: ${NAME_TOKEN}\ndescription: d\n---\n`), "name-holds-credential", {
            en: "This package's name looks like a password or token, so Ave does not offer it. Ask the package's author to rename it.",
            ko: "이 패키지의 이름이 비밀번호나 토큰처럼 보여 Ave가 제공하지 않습니다. 패키지 작성자에게 이름을 바꿔 달라고 하세요.",
          }],
          ["a package version", new FakeVolume("linux").file("/m/SKILL.md", `---\nname: note\nversion: 1.0.0-${NAME_TOKEN}\ndescription: d\n---\n`), "version-holds-credential", {
            en: "This package's version looks like a password or token, so Ave does not offer it. Ask the package's author to change it.",
            ko: "이 패키지의 버전이 비밀번호나 토큰처럼 보여 Ave가 제공하지 않습니다. 패키지 작성자에게 버전을 바꿔 달라고 하세요.",
          }],
          ["an MCP server's name with a word glued to its token", new FakeVolume("linux")
            .file("/m/plugin.json", JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "writer", version: "1.0.0", description: "Writes" }))
            .file("/m/mcp.json", JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: { [`backup_${KEY_TOKEN}`]: { type: "stdio", command: "./server/editor", args: [] } } }))
            .file("/m/server/editor", "#!/bin/sh\n"), "component-holds-credential", {
            en: "A skill, agent, prompt, routine or MCP server in this package has a name that looks like a password or token, so Ave does not offer it. Ask the package's author to rename it.",
            ko: "이 패키지에 든 스킬, 에이전트, 프롬프트, 루틴 또는 MCP 서버의 이름이 비밀번호나 토큰처럼 보여 Ave가 제공하지 않습니다. 패키지 작성자에게 이름을 바꿔 달라고 하세요.",
          }],
          ["an MCP server's name", new FakeVolume("linux")
            .file("/m/plugin.json", JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "writer", version: "1.0.0", description: "Writes" }))
            .file("/m/mcp.json", JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json", mcpServers: { [KEY_TOKEN]: { type: "stdio", command: "./server/editor", args: [] } } }))
            .file("/m/server/editor", "#!/bin/sh\n"), "component-holds-credential", {
            en: "A skill, agent, prompt, routine or MCP server in this package has a name that looks like a password or token, so Ave does not offer it. Ask the package's author to rename it.",
            ko: "이 패키지에 든 스킬, 에이전트, 프롬프트, 루틴 또는 MCP 서버의 이름이 비밀번호나 토큰처럼 보여 Ave가 제공하지 않습니다. 패키지 작성자에게 이름을 바꿔 달라고 하세요.",
          }],
        ])("refuses a direct folder package by %s", async (_label, volume, reason, expected) => {
          const answer = await refusal(volume, async (harness) => {
            await setup({ previewSource: vi.fn((request: never) => harness.service.previewSource(request)) });
            return invokeFileIpcHandler(handlers, channels.sourcesPreview, { input: "/m", auth: "none" });
          });
          expect(answer).toMatchObject({ ok: false, code: "SOURCE_INDEX_INVALID", detail: { reason } });
          noToken(answer);
          expect(sentences(answer)).toEqual(expected);
        });

        it("quarantines a source an earlier build stored under one, and removes it through the handle its row carries", async () => {
          const root = mkdtempSync(join(tmpdir(), "ave-ipc-legacy-"));
          const skill = "---\nname: note\ndescription: d\n---\n";
          const volume = new FakeVolume("linux").file("/m/SKILL.md", skill).file("/n/SKILL.md", skill);
          try {
            // An earlier build stored the id as typed: write it the way the registry does, then reopen.
            const first = await folderService({ root, folders: { fs: volume, platform: "linux", limits: TEST_FOLDER_LIMITS } });
            const preview = await first.service.previewSource({ input: "/m", auth: "none" });
            if (preview.type === "confirm") throw new Error("unexpected confirmation");
            await first.service.addSource({ previewId: preview.previewId, id: "team" });
            const other = await first.service.previewSource({ input: "/n", auth: "none" });
            if (other.type === "confirm") throw new Error("unexpected confirmation");
            await first.service.addSource({ previewId: other.previewId, id: "notes" });
            first.service.close();
            const list = join(root, "marketplaces", "sources.json");
            writeFileSync(list, readFileSync(list, "utf8").replace('"team"', JSON.stringify(NAME_TOKEN)));
            // Its data moves with it, the snapshot naming it, so the source reads as healthy and holds a package.
            const data = join(root, "marketplaces", NAME_TOKEN);
            renameSync(join(root, "marketplaces", "team"), data);
            for (const file of readdirSync(join(data, "snapshots"))) {
              const snapshot = join(data, "snapshots", file);
              writeFileSync(snapshot, readFileSync(snapshot, "utf8").replace('"sourceId":"team"', `"sourceId":${JSON.stringify(NAME_TOKEN)}`));
            }

            const harness = await folderService({ root, folders: { fs: volume, platform: "linux", limits: TEST_FOLDER_LIMITS } });
            try {
              const real = harness.service;
              await setup({
                listSources: vi.fn(() => real.listSources()),
                setEnabled: vi.fn((id: string, enabled: boolean) => real.setEnabled(id, enabled)),
                refresh: vi.fn((id?: string) => real.refresh(id)),
                removeSource: vi.fn((id: string) => real.removeSource(id)),
                catalog: vi.fn((query: never) => real.catalog(query)),
              });
              const listed = (await invokeFileIpcHandler(handlers, channels.sourcesList)) as { ok: true; value: Array<{ id: string; status: { state: string }; canRemove: boolean; canDisable: boolean; enabled: boolean }> };
              noToken(listed);
              const row = listed.value.find((source) => source.status.state === "id-holds-credential")!;
              expect(row).toMatchObject({ id: expect.stringMatching(/^ave-legacy-[0-9a-f]{32}$/u), canRemove: true, canDisable: false, enabled: false });
              expect(await harness.registry.readState(NAME_TOKEN)).toMatchObject({ enabled: true });
              expect((await harness.syncer.readSnapshot(NAME_TOKEN))?.packages).toHaveLength(1);
              expect(listed.value.find((source) => source.id === "notes")).toMatchObject({ status: { state: expect.not.stringMatching("id-holds-credential") } });
              // Served to no one, and named back by nothing but its handle.
              const catalog = (await invokeFileIpcHandler(handlers, channels.catalogList, {})) as { ok: true; value: { entries: Array<{ key: { sourceId: string } }> } };
              expect(catalog.value.entries.map((entry) => entry.key.sourceId)).toEqual(["notes"]);
              for (const answer of [
                await invokeFileIpcHandler(handlers, channels.sourcesSetEnabled, row.id, true),
                await invokeFileIpcHandler(handlers, channels.sourcesRefresh, row.id),
              ]) {
                expect(answer).toMatchObject({ ok: false, code: "SOURCE_ID_INVALID", detail: { reason: "stored-id-holds-credential" } });
                noToken(answer);
                expect(sentences(answer)).toEqual({
                  en: "This source's id looks like a password or token, so Ave does not sync it or offer its packages. Remove the source and add it again with another id.",
                  ko: "이 소스의 ID가 비밀번호나 토큰처럼 보여 Ave가 동기화하거나 패키지를 제공하지 않습니다. 소스를 제거한 뒤 다른 ID로 다시 추가하세요.",
                });
              }
              // Refreshing everything syncs the other sources and never this one (the official source's git fails here, as in every folder harness).
              const synced = vi.spyOn(harness.syncer, "sync");
              await invokeFileIpcHandler(handlers, channels.sourcesRefresh);
              expect(synced.mock.calls.map(([id]) => id)).toContain("notes");
              expect(synced.mock.calls.map(([id]) => id)).not.toContain(NAME_TOKEN);
              // Nor by the stored id itself, were a request to carry it; refused before its state changes.
              const statePath = join(root, "marketplaces", NAME_TOKEN, "state.json");
              const stateBefore = readFileSync(statePath, "utf8");
              expect(await invokeFileIpcHandler(handlers, channels.sourcesSetEnabled, NAME_TOKEN, false)).toMatchObject({ ok: false, code: "SOURCE_ID_INVALID", detail: { reason: "stored-id-holds-credential" } });
              expect(readFileSync(statePath, "utf8")).toBe(stateBefore);
              // The masked id it would otherwise have shown names nothing.
              expect(await invokeFileIpcHandler(handlers, channels.sourcesRemove, "[REDACTED:TOKEN]")).toMatchObject({ ok: false, code: "SOURCE_ID_INVALID" });
              expect(await invokeFileIpcHandler(handlers, channels.sourcesRemove, row.id)).toMatchObject({ ok: true });
              const after = (await invokeFileIpcHandler(handlers, channels.sourcesList)) as { ok: true; value: Array<{ id: string }> };
              expect(after.value.map((source) => source.id)).not.toContain(row.id);
              expect(after.value.map((source) => source.id)).toContain("notes");
              expect(readFileSync(list, "utf8")).not.toContain(NAME_TOKEN);
            } finally {
              harness.service.close();
            }
          } finally {
            rmSync(root, { recursive: true, force: true });
          }
        });

        it("refuses a pasted server.json whose name ends in one", async () => {
          const answer = await refusal(new FakeVolume("linux"), async (harness) => {
            await setup({ previewDirectMcp: vi.fn((request: never) => harness.service.previewDirectMcp(request)) });
            return invokeFileIpcHandler(handlers, channels.directPreview, { serverJson: JSON.stringify({ name: `io.github.acme/${NAME_TOKEN}`, version: "1.0.0" }) });
          });
          expect(answer).toMatchObject({ ok: false, code: "SOURCE_INDEX_INVALID", detail: { reason: "name-holds-credential" } });
          noToken(answer);
        });
      });

      it("answers a folder preview whose path holds a token with the confirmation, the path masked in it and in both sentences", async () => {
        const root = mkdtempSync(join(tmpdir(), "ave-ipc-folder-"));
        const harness = await folderService({ root, folders: { fs: new FakeVolume("win32"), platform: "win32", limits: TEST_FOLDER_LIMITS }, home: "C:\\Users\\example" });
        try {
          await setup({ previewSource: vi.fn((request: never) => harness.service.previewSource(request)) });
          // Each token alone and behind or before a name's separator, and the formats whose edges the detector once missed.
          const mixed = "A1b2C3d4".repeat(43);
          const appToken = `gh${"s_"}123456_eyJ${"hbGciOiJSUzI1NiJ9"}.eyJ${"pc3MiOiIxMjM0NTYifQ"}.${mixed.slice(0, 342)}`;
          const googleDash = `AI${"za"}${mixed.slice(0, 34)}-`;
          for (const token of [...TOKENS, appToken, googleDash]) {
            for (const segment of [token, `backup_${token}`, `backup-${token}`, `${token}_old`]) {
              const answer = await invokeFileIpcHandler(handlers, channels.sourcesPreview, { input: `//server/share/${segment}`, auth: "none" }) as { ok: true; value: { type: string; warnings: EnteredTargetWarningView[] } };
              expect(answer).toMatchObject({ ok: true, value: { type: "confirm", warnings: [{ warning: "network-folder", address: expect.stringContaining("[REDACTED:") }] } });
              expect(JSON.stringify(answer), segment).not.toContain(token);
              for (const language of ["en", "ko"] as const) {
                expect(warningText((key, vars) => translate(language, key, vars), answer.value.warnings[0]!)).not.toContain(token);
              }
            }
          }
        } finally {
          harness.service.close();
          rmSync(root, { recursive: true, force: true });
        }
      });
    });

    it("answers a repository that is already a source with that source's id, rendered as what to do instead of another id", async () => {
      const root = mkdtempSync(join(tmpdir(), "ave-ipc-repository-"));
      const harness = await folderService({ root, folders: { fs: new FakeVolume("linux"), platform: "linux", limits: TEST_FOLDER_LIMITS } });
      try {
        await harness.registry.add({ id: "acme", origin: "custom", url: "https://github.com/acme/market", auth: { kind: "none" } });
        // The add a held git preview makes (the preview itself fetches): the registry's refusal crosses as it is.
        await setup({
          addSource: vi.fn(() => harness.registry.add({ id: "acme-ssh", origin: "custom", url: "git@github.com:Acme/Market.git", auth: { kind: "ssh" } })),
        });
        const answer = await invokeFileIpcHandler(handlers, channels.sourcesAdd, { previewId: "p", id: "acme-ssh" });
        expect(answer).toMatchObject({ ok: false, code: "SOURCE_ID_TAKEN", detail: { reason: "repository-already-added", url: "ssh://git@github.com/Acme/Market", existingId: "acme" } });
        expect(sentences(answer)).toEqual({
          en: "ssh://git@github.com/Acme/Market is already added as acme. Use acme, or remove it before adding this repository again.",
          ko: "ssh://git@github.com/Acme/Market은(는) 이미 acme(으)로 추가되어 있습니다. acme을(를) 쓰거나, 지운 뒤 이 저장소를 다시 추가하세요.",
        });
      } finally {
        harness.service.close();
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("masks a token pasted as the ssh account of an address a refusal names, in the envelope and both sentences", async () => {
      // Built here, never written out whole: normalization keeps an ssh account name, and this one is token-shaped.
      const token = `ghp_${"a".repeat(36)}`;
      const pasted = `ssh://${token}@github.com/acme/market`;
      const root = mkdtempSync(join(tmpdir(), "ave-ipc-repository-"));
      const harness = await folderService({ root, folders: { fs: new FakeVolume("linux"), platform: "linux", limits: TEST_FOLDER_LIMITS } });
      const gate = new NetworkGate({ policy: policySource(policyLoad({ allowDirectInstall: false })), allowLoopback: false, transport: createPinnedFetch() });
      try {
        await harness.registry.add({ id: "acme", origin: "custom", url: "https://github.com/acme/market", auth: { kind: "none" } });
        await setup({
          addSource: vi.fn(() => harness.registry.add({ id: "acme-ssh", origin: "custom", url: pasted, auth: { kind: "ssh" } })),
          previewSource: vi.fn(async () => gate.checkDirectInstall(normalizeSourceUrl(pasted).url)),
        });
        const duplicate = await invokeFileIpcHandler(handlers, channels.sourcesAdd, { previewId: "p", id: "acme-ssh" });
        expect(duplicate).toMatchObject({ ok: false, code: "SOURCE_ID_TAKEN", detail: { reason: "repository-already-added", url: "ssh://[REDACTED:TOKEN]@github.com/acme/market", existingId: "acme" } });
        const direct = await invokeFileIpcHandler(handlers, channels.sourcesPreview, { input: pasted, auth: "ssh" });
        expect(direct).toMatchObject({ ok: false, code: "SOURCE_POLICY_BLOCKED", detail: { reason: "direct-install-blocked", target: "ssh://[REDACTED:TOKEN]@github.com/acme/market" } });
        for (const answer of [duplicate, direct]) {
          expect(JSON.stringify(answer)).not.toContain(token);
          const { en, ko } = sentences(answer);
          // Scrubbed once, in main: the sentence shows the envelope's marker as it arrived.
          expect(en).toContain("ssh://[REDACTED:TOKEN]@github.com/acme/market");
          expect(ko).toContain("ssh://[REDACTED:TOKEN]@github.com/acme/market");
          expect(`${en}\n${ko}`).not.toContain(token);
        }
      } finally {
        harness.service.close();
        rmSync(root, { recursive: true, force: true });
      }
    });
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

  it("masks the whole value of an Authorization header of any scheme in a failure it answers with (§18.8)", async () => {
    const secret = "opaque-pass-12345";
    await setup({
      refresh: vi.fn(async () => {
        throw new MarketplaceError("SOURCE_UNREACHABLE", `proxy returned Authorization: Custom ${secret}`, { detail: { reason: "proxy", host: "git.example", proxy: `Proxy-Authorization: Weird ${secret}` } });
      }),
    });
    const answer = await invokeFileIpcHandler(handlers, channels.sourcesRefresh);
    expect(answer).toMatchObject({ ok: false, code: "SOURCE_UNREACHABLE", message: "proxy returned Authorization: [REDACTED:TOKEN]", detail: { reason: "proxy", proxy: "Proxy-Authorization: [REDACTED:TOKEN]" } });
    expect(JSON.stringify(answer)).not.toContain(secret);
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
    await expect(invokeFileIpcHandler(handlers, channels.sourcesPreview, { input: "http://x.example/m", auth: "none", acknowledge: ["not-a-warning"] })).resolves.toMatchObject(invalid);
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
