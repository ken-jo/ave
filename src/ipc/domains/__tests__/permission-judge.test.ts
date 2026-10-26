import { useConfigurationOwner } from "../../../__tests__/support/configuration-owner.js";

useConfigurationOwner();

import { permissionSettingsPath } from "../../../permissions/permission-settings-store.js";
import { writePermissionSettingsFixture } from "../../../__tests__/support/permission-settings-fixture.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { foreignFrameEvent, hostFrameEvent, useTempDirs } from "../../../__tests__/test-helpers.js";
import { PERMISSIONS } from "../../../shared/ipc-channels.js";
import type { IpcDeps } from "../../types.js";
import { registerPermissionJudgeHandlers } from "../permission-judge.js";
import * as permissionSettings from "../../../permissions/permission-settings-store.js";
import { ensureAveHomePrivate } from "../../../shared/ave-home.js";
import { setFixtureOwner } from "../../../__tests__/support/fixture-owner.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
vi.mock("electron", () => ({ ipcMain: { handle: (channel: string, handler: (...args: unknown[]) => unknown) => handlers.set(channel, handler) } }));
const makeDir = useTempDirs("ave-judge-ipc-");
const intent = { inputOrigin: "user-keyboard", userActivation: true };
let deps: IpcDeps;
let home: string;

beforeEach(() => {
  handlers.clear();
  const root = makeDir();
  setFixtureOwner(root);
  home = join(root, ".ave");
  expect(ensureAveHomePrivate(home)).not.toMatchObject({ enforcement: "none" });
  vi.stubEnv("AVE_HOME", home);
  deps = {
    settingsService: {
      get: () => ({ vendors: { "openai-compatible": { model: "team/local", baseUrl: "http://localhost:9000/v1" } } }),
      getSecret: () => null,
    },
    auditLogger: { log: vi.fn() },
    rewireReviewerAgent: vi.fn(),
    getMainWindow: () => null,
  } as unknown as IpcDeps;
  registerPermissionJudgeHandlers(deps);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("judge settings host boundary", () => {
  it.each([PERMISSIONS.judgeGet, PERMISSIONS.judgeSet])("refuses foreign and plugin senders on %s", async (channel) => {
    for (const url of ["https://untrusted.example/", "file:///dist/src/plugin-ui-shell.html"]) {
      expect(await handlers.get(channel)!(foreignFrameEvent(url), { intent, settings: { chain: [] } })).toEqual({ ok: false, error: "unauthorized-frame" });
    }
    expect(deps.auditLogger.log).toHaveBeenCalledTimes(2);
    expect(deps.rewireReviewerAgent).not.toHaveBeenCalled();
  });

  it("requires a user gesture before persisting or refreshing runtime", async () => {
    expect(await handlers.get(PERMISSIONS.judgeSet)!(hostFrameEvent(), { settings: { chain: [] } })).toEqual({ ok: false, error: "user-keyboard-required" });
    expect(deps.rewireReviewerAgent).not.toHaveBeenCalled();
  });

  it("reports a rejected stored chain so the renderer does not present it as off", async () => {
    writePermissionSettingsFixture(home, JSON.stringify({ permissions: { judge: { chain: [{ provider: "external" }], mode: "active" } } }));
    const result = await handlers.get(PERMISSIONS.judgeGet)!(hostFrameEvent());
    expect(result).toMatchObject({ ok: true, settings: { chain: [], mode: "active" }, storedChainRejected: true });
    expect(result).not.toHaveProperty("chainRejected");
    expect(result).not.toHaveProperty("migrated");
  });

  it("names the chat model an unset reviewer follows and flags an unavailable selection", async () => {
    (deps.settingsService as unknown as { get: () => unknown }).get = () => ({
      provider: "openai-compatible",
      vendors: { "openai-compatible": { model: "team/local", baseUrl: "http://localhost:9000/v1" } },
    });
    expect(await handlers.get(PERMISSIONS.judgeGet)!(hostFrameEvent())).toMatchObject({
      ok: true, settings: { model: null }, chatModel: "openai-compatible/team/local", reviewerModelUnavailable: false,
    });
    writePermissionSettingsFixture(home, JSON.stringify({ permissions: { judge: { model: "claude/removed-model" } } }));
    expect(await handlers.get(PERMISSIONS.judgeGet)!(hostFrameEvent())).toMatchObject({
      ok: true, settings: { model: { vendor: "claude", model: "removed-model" } }, reviewerModelUnavailable: true,
    });
  });

  it("keeps fatal read metadata on the host side of the snapshot", async () => {
    writePermissionSettingsFixture(home, "{broken");
    expect(permissionSettings.readJudgeSettings()).toHaveProperty("unreadable", true);
    const result = await handlers.get(PERMISSIONS.judgeGet)!(hostFrameEvent());
    expect(result).toMatchObject({ ok: true, settings: { chain: [], mode: "shadow" } });
    expect(result).not.toHaveProperty("unreadable");
    expect(result).not.toHaveProperty("chainRejected");
  });

  it("rejects unwired mutations before creating a settings file", async () => {
    deps.rewireReviewerAgent = undefined;
    expect(await handlers.get(PERMISSIONS.judgeSet)!(hostFrameEvent(), {
      intent, settings: { chain: [{ provider: "builtin-llm" }] },
    })).toEqual({ ok: false, error: "judge-rewire-failed" });
    expect(existsSync(permissionSettingsPath(home))).toBe(false);
  });

  it("shows configured provider models and persists selected identity before refresh", async () => {
    const read = await handlers.get(PERMISSIONS.judgeGet)!(hostFrameEvent());
    expect(read).toMatchObject({ ok: true, settings: { chain: [], mode: "shadow" }, modelOptions: [{ vendor: "openai-compatible", model: "team/local" }] });
    const saved = await handlers.get(PERMISSIONS.judgeSet)!(hostFrameEvent(), {
      intent,
      settings: { chain: [{ provider: "builtin-llm", model: "openai-compatible/team/local" }] },
    });
    expect(saved).toMatchObject({ ok: true, settings: { chain: [{ model: { vendor: "openai-compatible", model: "team/local" } }], mode: "shadow" } });
    expect(JSON.parse(readFileSync(permissionSettingsPath(home), "utf8")).permissions.judge.chain[0].model).toBe("openai-compatible/team/local");
    expect(deps.rewireReviewerAgent).toHaveBeenCalledOnce();
  });

  it("returns a stable validation error without runtime refresh", async () => {
    const result = await handlers.get(PERMISSIONS.judgeSet)!(hostFrameEvent(), { intent, settings: { chain: [{ provider: "external" }] } });
    expect(result).toEqual({ ok: false, error: "invalid-judge-settings" });
    expect(deps.rewireReviewerAgent).not.toHaveBeenCalled();
  });

  it("uses the active preset catalog consistently for the picker and writes", async () => {
    const preset = {
      providerId: "team-route", baseUrl: "https://models.example.test/v1", defaultModel: "team/default",
      modelOptions: ["team/default", "team/chosen"], requiresApiKey: false, modelDiscoveryPolicy: "static",
    };
    vi.spyOn(deps.settingsService, "get").mockImplementation((key) => (key === "llm" ? {
      provider: "openai-compatible", marketplaceProviderPresetId: "team-route",
      vendors: { "openai-compatible": { model: "generic/saved", presetModels: { "team-route": "team/chosen" } } },
    } : { installedProviderPresets: [preset] }) as never);
    expect(await handlers.get(PERMISSIONS.judgeGet)!(hostFrameEvent())).toMatchObject({
      ok: true, modelOptions: [{ vendor: "openai-compatible", model: "team/default" }, { vendor: "openai-compatible", model: "team/chosen" }],
    });
    expect(await handlers.get(PERMISSIONS.judgeSet)!(hostFrameEvent(), {
      intent, settings: { chain: [{ provider: "builtin-llm", model: "openai-compatible/team/chosen" }] },
    })).toMatchObject({ ok: true, settings: { chain: [{ model: { vendor: "openai-compatible", model: "team/chosen" } }] } });
  });

  it("notifies every app window only after settings and runtime agree", async () => {
    const sends = [vi.fn(), vi.fn()];
    deps.getAppWindows = () => sends.map((send) => ({
      isDestroyed: () => false,
      webContents: { isDestroyed: () => false, send },
    })) as unknown as ReturnType<NonNullable<IpcDeps["getAppWindows"]>>;
    const result = await handlers.get(PERMISSIONS.judgeSet)!(hostFrameEvent(), { intent, settings: { chain: [] } });
    expect(result).toMatchObject({ ok: true });
    for (const send of sends) expect(send).toHaveBeenCalledWith(PERMISSIONS.configChanged, {});
  });

  it("restores prior settings and wiring after refresh fails", async () => {
    vi.mocked(deps.rewireReviewerAgent!).mockImplementationOnce(() => { throw new Error("refresh failed"); });
    expect(await handlers.get(PERMISSIONS.judgeSet)!(hostFrameEvent(), { intent, settings: { chain: [{ provider: "builtin-llm" }] } })).toEqual({ ok: false, error: "judge-rewire-failed" });
    expect(JSON.parse(readFileSync(permissionSettingsPath(home), "utf8"))).not.toHaveProperty("permissions.judge");
    expect(deps.rewireReviewerAgent).toHaveBeenCalledTimes(2);
  });

  it("reports an unsuccessful runtime rollback separately", async () => {
    vi.mocked(deps.rewireReviewerAgent!).mockImplementation(() => { throw new Error("refresh failed"); });
    expect(await handlers.get(PERMISSIONS.judgeSet)!(hostFrameEvent(), { intent, settings: { chain: [{ provider: "builtin-llm" }] } })).toEqual({ ok: false, error: "judge-rollback-failed" });
    expect(JSON.parse(readFileSync(permissionSettingsPath(home), "utf8"))).not.toHaveProperty("permissions.judge");
  });

  it("restores a rejected active raw chain when a replacement cannot activate", async () => {
    const rejected = { chain: [{ provider: "external", id: "missing-transport" }], mode: "active" };
    writePermissionSettingsFixture(home, JSON.stringify({ permissions: { judge: rejected, allow: ["Read(*)"] } }));
    vi.mocked(deps.rewireReviewerAgent!).mockImplementationOnce(() => { throw new Error("refresh failed"); });
    expect(await handlers.get(PERMISSIONS.judgeSet)!(hostFrameEvent(), {
      intent, settings: { chain: [{ provider: "builtin-llm" }] },
    })).toEqual({ ok: false, error: "judge-rewire-failed" });
    expect(JSON.parse(readFileSync(permissionSettingsPath(home), "utf8"))).toEqual({ permissions: { judge: rejected, allow: ["Read(*)"] } });
    expect(permissionSettings.readJudgeSettings()).toMatchObject({ settings: { mode: "active" }, chainRejected: true });
  });

  it("reports rollback conflict without replacing a later manual judge change", async () => {
    const later = { permissions: { judge: { provider: "off" } } };
    vi.mocked(deps.rewireReviewerAgent!).mockImplementationOnce(() => {
      writePermissionSettingsFixture(home, JSON.stringify(later));
      throw new Error("refresh failed");
    });
    expect(await handlers.get(PERMISSIONS.judgeSet)!(hostFrameEvent(), {
      intent, settings: { chain: [{ provider: "builtin-llm" }] },
    })).toEqual({ ok: false, error: "judge-rollback-failed" });
    expect(JSON.parse(readFileSync(permissionSettingsPath(home), "utf8"))).toEqual(later);
    expect(deps.rewireReviewerAgent).toHaveBeenCalledOnce();
  });

  it("serializes concurrent saves through failed activation and rollback", async () => {
    const persist = permissionSettings.setJudgeSettingsPersist;
    let signalPersisted!: () => void;
    let releaseFirst!: () => void;
    const persisted = new Promise<void>((resolve) => { signalPersisted = resolve; });
    const blocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let writes = 0;
    const writer = vi.spyOn(permissionSettings, "setJudgeSettingsPersist").mockImplementation(async (...args) => {
      const first = writes++ === 0;
      const result = await persist(...args);
      if (first) {
        signalPersisted();
        await blocked;
      }
      return result;
    });
    vi.mocked(deps.rewireReviewerAgent!).mockImplementationOnce(() => { throw new Error("refresh failed"); });
    const first = handlers.get(PERMISSIONS.judgeSet)!(hostFrameEvent(), { intent, settings: { timeoutMs: 20_000 } });
    await persisted;
    const second = handlers.get(PERMISSIONS.judgeSet)!(hostFrameEvent(), { intent, settings: { timeoutMs: 30_000 } });
    await Promise.resolve();
    const writesBeforeRelease = writer.mock.calls.length;
    releaseFirst();
    const [failed, saved] = await Promise.all([first, second]);
    expect(writesBeforeRelease).toBe(1);
    expect(failed).toEqual({ ok: false, error: "judge-rewire-failed" });
    expect(saved).toMatchObject({ ok: true, settings: { timeoutMs: 30_000 } });
    expect(writer).toHaveBeenCalledTimes(2);
    expect(deps.rewireReviewerAgent).toHaveBeenCalledTimes(3);
    expect(JSON.parse(readFileSync(permissionSettingsPath(home), "utf8")).permissions.judge.timeoutMs).toBe(30_000);
  });
});
