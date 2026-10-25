import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipcMain, type IpcMainInvokeEvent } from "electron";
import { CHANNELS, CHANNEL_GESTURE, isPublicChannel } from "../../../contract/app-contract.js";
import { hostFrameEvent, pluginShellFrameEvent } from "../../../__tests__/test-helpers.js";
import { beginAppUpdateInstallRequest, clearAppUpdateInstallRequested } from "../../../main/app-update-install-intent.js";
import { withPluginInstallLock } from "../../../plugins/install-lifecycle.js";
import { registerAppHandlers } from "../app.js";
import type { IpcDeps } from "../../types.js";
import { setAppRelaunchRequested } from "../../../main/app-relaunch-state.js";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { folderService, type FolderServiceHarness } from "../../../marketplace/__tests__/fixtures/folder-service.js";
import { nodeFolders, writeFolderFiles } from "../../../marketplace/__tests__/fixtures/folder-fs.js";
import { descriptorText, jsonText } from "../../../marketplace/__tests__/fixtures/package-files.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { ContentStore } from "../../../marketplace/content/store.js";
import { EMPTY_MARKETPLACE_POLICY } from "../../../marketplace/sources/policy.js";

vi.mock("electron", () => ({ ipcMain: { handle: vi.fn() } }));

const handlers = new Map<string, Parameters<typeof ipcMain.handle>[1]>();
const auditLogger = { log: vi.fn() };
const relaunchApp = vi.fn();
const intent = { intent: { inputOrigin: "user-keyboard", userActivation: true } };
let mainEvent: IpcMainInvokeEvent;
let marketplace: FolderServiceHarness | undefined;

beforeEach(() => {
  clearAppUpdateInstallRequested();
  setAppRelaunchRequested(false);
  auditLogger.log.mockClear();
  relaunchApp.mockReset();
  mainEvent = hostFrameEvent();
  Object.assign(mainEvent.sender, { mainFrame: mainEvent.senderFrame });
  vi.spyOn(ipcMain, "handle").mockImplementation((channel, handler) => { handlers.set(channel, handler); });
  registerAppHandlers({ auditLogger, relaunchApp, getMainWindow: () => ({ webContents: mainEvent.sender, isDestroyed: () => false }) } as unknown as IpcDeps);
});
afterEach(async () => {
  clearAppUpdateInstallRequested();
  setAppRelaunchRequested(false);
  vi.restoreAllMocks();
  handlers.clear();
  if (marketplace) {
    marketplace.service.close();
    await cleanupTmpDir(marketplace.root);
    marketplace = undefined;
  }
});

function invoke(event = mainEvent, payload: unknown = intent) {
  return handlers.get(CHANNELS.app.relaunch)!(event, payload);
}

async function languageInstall() {
  const root = mkdtempSync(join(tmpdir(), "ave-relaunch-marketplace-"));
  const folder = join(root, "source");
  writeFolderFiles(folder, {
    "marketplace.json": jsonText({ schemaVersion: 2, name: "languages", displayName: "Languages", packages: [{ kind: "language", name: "french", path: "french" }] }),
    "french/ave-package.json": descriptorText("language", "french", "1.0.0", { locale: "fr", entry: "language.json", messages: "messages.json" }),
    "french/language.json": jsonText({ locale: "fr", nativeName: "Français", englishName: "French" }),
    "french/messages.json": jsonText({}),
  });
  marketplace = await folderService({ root, home: root, folders: nodeFolders() });
  const preview = await marketplace.service.previewSource({ input: folder, auth: "none" });
  if (preview.type === "confirm") throw new Error("Unexpected source confirmation");
  await marketplace.service.addSource({ previewId: preview.previewId });
  const plan = await marketplace.service.planInstall({ sourceId: "languages", kind: "language", name: "french" });
  return { harness: marketplace, planId: plan.planId, written: join(root, "language-installed") };
}

async function unboundMcpInstall() {
  const root = mkdtempSync(join(tmpdir(), "ave-relaunch-marketplace-"));
  marketplace = await folderService({ root, home: root, folders: nodeFolders() });
  const preview = marketplace.service.previewDirectMcp({
    serverJson: jsonText({ name: "io.example/weather", version: "0.3.0", remotes: [{ type: "streamable-http", url: "https://weather.example/mcp" }] }),
  });
  return { harness: marketplace, planId: preview.planId, written: join(root, "mcp-installed") };
}

async function installedLanguage() {
  const { harness, planId } = await languageInstall();
  await harness.service.executeInstall(planId);
  const deactivate = vi.fn(async () => undefined);
  const store = await ContentStore.open({ root: join(harness.root, "packages"), english: {}, activation: {
    activate: async () => ({ retired: Promise.resolve() }), deactivate, approveComponents: async () => undefined,
  } });
  await store.install(harness.content[0]!);
  harness.installers.content.list = async () => store.list().map((entry) => ({ kind: entry.kind, name: entry.name,
    version: entry.version, sourceId: entry.origin.sourceId, originCommit: entry.origin.commit }));
  harness.installers.content.uninstall = async () => { await store.uninstall("language", "french", EMPTY_MARKETPLACE_POLICY); };
  return { harness, store, deactivate, key: { sourceId: "languages", kind: "language" as const, name: "french" } };
}

function revokeLanguage(root: string) {
  writeFolderFiles(join(root, "source"), { "policy/revocations.json": jsonText({ schemaVersion: 1, revocations: [
    { kind: "language", name: "french", versions: "*", reason: "unsafe", at: "2026-10-02T00:00:00Z", action: "uninstall" },
  ] }) });
}

describe("app relaunch boundary", () => {
  it("refuses language removal after accepted relaunch without deactivating or changing the ledger", async () => {
    const { harness, store, deactivate, key } = await installedLanguage();
    const before = store.list();
    expect(invoke()).toEqual({ ok: true });
    await expect(harness.service.uninstall(key)).rejects.toMatchObject({ code: "relaunch-in-progress" });
    expect(deactivate).not.toHaveBeenCalled();
    expect(store.list()).toEqual(before);
  });

  it("refuses catalog language revocation after accepted relaunch", async () => {
    const { harness, store, deactivate } = await installedLanguage();
    const before = store.list();
    revokeLanguage(harness.root);
    expect(invoke()).toEqual({ ok: true });
    await harness.service.refresh("languages");
    expect(deactivate).not.toHaveBeenCalled();
    expect(store.list()).toEqual(before);
    expect(harness.service.takeRevocationNotice()?.revoked).toEqual([expect.objectContaining({ outcome: "failed" })]);
  });

  async function heldLanguageRemoval(revoked: boolean) {
    const { harness, store, deactivate, key } = await installedLanguage();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    deactivate.mockImplementationOnce(async () => { entered(); await held; });
    if (revoked) revokeLanguage(harness.root);
    const pending = revoked ? harness.service.refresh("languages") : harness.service.uninstall(key);
    await started;
    try {
      expect(invoke()).toEqual({ ok: false, error: "plugin-install-in-progress" });
      expect(relaunchApp).not.toHaveBeenCalled();
      expect(store.list()).toHaveLength(1);
    } finally {
      release();
      await pending;
    }
    expect(store.list()).toEqual([]);
    expect(invoke()).toEqual({ ok: true });
  }

  it("refuses relaunch while a language uninstall holds deactivation", async () => {
    await heldLanguageRemoval(false);
  });

  it("refuses relaunch while catalog language revocation holds deactivation", async () => {
    await heldLanguageRemoval(true);
  });

  it("refuses a language pack without writing after relaunch is accepted", async () => {
    const { harness, planId, written } = await languageInstall();
    const install = vi.spyOn(harness.installers.content, "install").mockImplementation(async () => {
      writeFileSync(written, "installed");
      return { action: { action: "install" } };
    });
    expect(invoke()).toEqual({ ok: true });
    await expect(harness.service.executeInstall(planId)).rejects.toMatchObject({ code: "relaunch-in-progress" });
    expect(install).not.toHaveBeenCalled();
    expect(existsSync(written)).toBe(false);
  });

  it("refuses relaunch while a language pack install is held mid-flight", async () => {
    const { harness, planId, written } = await languageInstall();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(harness.installers.content, "install").mockImplementation(async () => {
      entered();
      await held;
      writeFileSync(written, "installed");
      return { action: { action: "install" } };
    });
    const pending = harness.service.executeInstall(planId);
    await started;
    try {
      expect(invoke()).toEqual({ ok: false, error: "plugin-install-in-progress" });
      expect(relaunchApp).not.toHaveBeenCalled();
      expect(existsSync(written)).toBe(false);
    } finally {
      release();
      await pending;
    }
    expect(existsSync(written)).toBe(true);
    expect(invoke()).toEqual({ ok: true });
  });

  it("registers a language pack install before yielding to relaunch", async () => {
    const { harness, planId } = await languageInstall();
    const pending = harness.service.executeInstall(planId);
    try {
      expect(invoke()).toEqual({ ok: false, error: "plugin-install-in-progress" });
      expect(relaunchApp).not.toHaveBeenCalled();
    } finally {
      await pending;
    }
    expect(invoke()).toEqual({ ok: true });
  });

  it("refuses an unbound MCP install without writing after relaunch is accepted", async () => {
    const { harness, planId, written } = await unboundMcpInstall();
    const install = vi.spyOn(harness.installers.mcp, "installUnbound").mockImplementation(async () => {
      writeFileSync(written, "installed");
      return { connectionWarning: null };
    });
    expect(invoke()).toEqual({ ok: true });
    await expect(harness.service.executeInstall(planId)).rejects.toMatchObject({ code: "relaunch-in-progress" });
    expect(install).not.toHaveBeenCalled();
    expect(existsSync(written)).toBe(false);
  });

  it("refuses relaunch while an unbound MCP install is held mid-flight", async () => {
    const { harness, planId, written } = await unboundMcpInstall();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.spyOn(harness.installers.mcp, "installUnbound").mockImplementation(async () => {
      entered();
      await held;
      writeFileSync(written, "installed");
      return { connectionWarning: null };
    });
    const pending = harness.service.executeInstall(planId);
    await started;
    try {
      expect(invoke()).toEqual({ ok: false, error: "plugin-install-in-progress" });
      expect(relaunchApp).not.toHaveBeenCalled();
      expect(existsSync(written)).toBe(false);
    } finally {
      release();
      await pending;
    }
    expect(existsSync(written)).toBe(true);
    expect(invoke()).toEqual({ ok: true });
  });

  it("refuses an unrelated local window with hand-written intent", () => {
    const event = hostFrameEvent();
    Object.assign(event.senderFrame!, { url: "file:///tmp/unrelated.html" });
    Object.assign(event.sender, { mainFrame: event.senderFrame });
    expect(invoke(event)).toEqual({ ok: false, error: "unauthorized-frame" });
    expect(relaunchApp).not.toHaveBeenCalled();
  });

  it("refuses a subframe of the main window", () => {
    const event = { ...mainEvent, senderFrame: { url: mainEvent.senderFrame!.url } } as IpcMainInvokeEvent;
    expect(invoke(event)).toEqual({ ok: false, error: "unauthorized-frame" });
    expect(relaunchApp).not.toHaveBeenCalled();
  });

  it("audits missing activation", () => {
    expect(invoke(mainEvent, {})).toEqual({ ok: false, error: "user-keyboard-required" });
    expect(auditLogger.log).toHaveBeenCalledWith(expect.objectContaining({ type: "warn", input: expect.stringContaining("user-keyboard-required") }));
  });

  it("closes plugin install entry before invoking the host", async () => {
    const install = vi.fn(async () => undefined);
    let pending!: Promise<unknown>;
    relaunchApp.mockImplementation(() => { pending = withPluginInstallLock("after-relaunch", install); });
    expect(invoke()).toEqual({ ok: true });
    await expect(pending).rejects.toMatchObject({ code: "relaunch-in-progress" });
    expect(install).not.toHaveBeenCalled();
  });

  it("closes update install entry after accepting relaunch", () => {
    expect(invoke()).toEqual({ ok: true });
    expect(() => beginAppUpdateInstallRequest()).toThrow("relaunch-in-progress");
  });

  it("audits and refuses repeated IPC requests", () => {
    expect(invoke()).toEqual({ ok: true });
    expect(invoke()).toEqual({ ok: false, error: "relaunch-in-progress" });
    expect(relaunchApp).toHaveBeenCalledExactlyOnceWith();
    expect(auditLogger.log).toHaveBeenCalledWith(expect.objectContaining({ type: "warn", input: expect.stringContaining("relaunch-in-progress") }));
  });

  it("reopens install entry after a failed relaunch", async () => {
    relaunchApp.mockImplementation(() => { throw new Error("relaunch-unsupported"); });
    expect(invoke()).toEqual({ ok: false, error: "relaunch-unsupported" });
    const install = vi.fn(async () => undefined);
    await withPluginInstallLock("after-failure", install);
    expect(install).toHaveBeenCalledExactlyOnceWith();
    expect(() => beginAppUpdateInstallRequest()).not.toThrow();
  });

  it("keeps installs closed when the host reports an already scheduled relaunch", async () => {
    relaunchApp.mockImplementation(() => { throw new Error("relaunch-in-progress"); });
    expect(invoke()).toEqual({ ok: false, error: "relaunch-in-progress" });
    const install = vi.fn(async () => undefined);
    await expect(withPluginInstallLock("scheduled", install)).rejects.toMatchObject({ code: "relaunch-in-progress" });
    expect(install).not.toHaveBeenCalled();
    expect(() => beginAppUpdateInstallRequest()).toThrow("relaunch-in-progress");
  });

  it("requires a user gesture and stays internal", () => {
    expect(CHANNEL_GESTURE[CHANNELS.app.relaunch]).toBe("required");
    expect(isPublicChannel(CHANNELS.app.relaunch)).toBe(false);
    expect(invoke(mainEvent, {})).toEqual({ ok: false, error: "user-keyboard-required" });
    expect(relaunchApp).not.toHaveBeenCalled();
  });

  it("audits and refuses a plugin frame before considering consent", () => {
    expect(invoke(pluginShellFrameEvent())).toEqual({ ok: false, error: "unauthorized-frame" });
    expect(auditLogger.log).toHaveBeenCalledWith(expect.objectContaining({ sessionId: "ipc-guard", input: expect.stringContaining(CHANNELS.app.relaunch) }));
    expect(relaunchApp).not.toHaveBeenCalled();
  });

  it("refuses while an extension installation holds its lifecycle lock", async () => {
    await withPluginInstallLock("relaunch-fixture", async () => {
      expect(invoke()).toEqual({ ok: false, error: "plugin-install-in-progress" });
      expect(auditLogger.log).toHaveBeenCalledWith(expect.objectContaining({ type: "warn", input: expect.stringContaining("plugin-install-in-progress") }));
      expect(relaunchApp).not.toHaveBeenCalled();
    });
    expect(invoke()).toEqual({ ok: true });
  });

  it("refuses while an app update installation is requested", () => {
    beginAppUpdateInstallRequest();
    expect(invoke()).toEqual({ ok: false, error: "update-install-in-progress" });
    expect(auditLogger.log).toHaveBeenCalledWith(expect.objectContaining({ type: "warn", input: expect.stringContaining("update-install-in-progress") }));
    expect(relaunchApp).not.toHaveBeenCalled();
  });

  it("relaunches the host after authorized confirmation", () => {
    expect(invoke()).toEqual({ ok: true });
    expect(relaunchApp).toHaveBeenCalledExactlyOnceWith();
  });

  it("returns a typed unsupported result from a headless host", () => {
    relaunchApp.mockImplementation(() => { throw new Error("relaunch-unsupported"); });
    expect(invoke()).toEqual({ ok: false, error: "relaunch-unsupported" });
  });

  it("contains unexpected runtime failures in a typed result", () => {
    relaunchApp.mockImplementation(() => { throw new Error("private runtime detail"); });
    expect(invoke()).toEqual({ ok: false, error: "relaunch-failed" });
  });
});
