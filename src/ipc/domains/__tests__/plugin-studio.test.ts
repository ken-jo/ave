vi.mock("../../../shared/windows-path-facts.js", async original => (await import("../../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../../shared/windows-configuration-handles.js", async original => (await import("../../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));
vi.mock("node:fs", async original => (await import("../../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationFs(await original()));

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import AdmZip from "adm-zip";
import { dialog } from "electron";
import { CHANNELS } from "../../../contract/app-contract.js";
import { hostFrameEvent, pluginShellFrameEvent } from "../../../__tests__/test-helpers.js";
import { ContentStore, type ContentActivation } from "../../../marketplace/content/store.js";
import { PluginStudioStore } from "../../../studio/store.js";
import { previewStudioConnector } from "../../../studio/connector.js";
import { setProcessPlatform } from "../../../__tests__/support/process-platform.js";
import { setAveHomePrivacyAtBoot, _resetAveHomePrivacyForTest } from "../../../shared/ave-home.js";
import { setPluginWorkerConfinementRequestedAtBoot, __resetSandboxRequestedAtBootForTest } from "../../../permissions/sandbox-capability.js";
import { setAppRelaunchRequested } from "../../../main/app-relaunch-state.js";
import { registerAppHandlers } from "../app.js";

const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>() }));
vi.mock("electron", () => ({
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => handlers.set(channel, fn) },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })), showSaveDialog: vi.fn(async () => ({ canceled: true })) },
}));

import { registerPluginStudioHandlers } from "../plugin-studio.js";

const originalHome = process.env.AVE_HOME;
const ORIGINAL_PLATFORM = process.platform;
let root: string;
let content: ContentStore;
let reload: ReturnType<typeof vi.fn>;
let activate: ContentActivation["activate"];

beforeEach(async () => {
  handlers.clear();
  vi.clearAllMocks();
  root = await mkdtemp(join(tmpdir(), "ave-studio-ipc-"));
  process.env.AVE_HOME = join(root, "home");
  reload = vi.fn(async () => undefined);
  activate = vi.fn(async () => ({ retired: Promise.resolve() }));
  content = await ContentStore.open({ root: join(root, "packages"), english: {}, activation: {
    activate, deactivate: vi.fn(async () => undefined), approveComponents: vi.fn(async () => undefined),
  } });
  registerPluginStudioHandlers({ auditLogger: { log: vi.fn() }, mcpManager: {
    getStudioStoredCredentialValues: async () => [],
  } } as never, async () => ({ store: content, reload } as never));
});
afterEach(async () => {
  setAppRelaunchRequested(false);
  _resetAveHomePrivacyForTest();
  __resetSandboxRequestedAtBootForTest();
  setProcessPlatform(ORIGINAL_PLATFORM);
  if (originalHome === undefined) delete process.env.AVE_HOME;
  else process.env.AVE_HOME = originalHome;
  await rm(root, { recursive: true, force: true });
});

async function invoke(channel: string, event: unknown, ...args: unknown[]): Promise<unknown> {
  const handler = handlers.get(channel);
  expect(handler).toBeDefined();
  return handler!(event, ...args);
}

describe("plugin Studio IPC", () => {
  async function reviewedPreview(): Promise<string> {
    const studio = new PluginStudioStore();
    const draft = await studio.writeDraft({ name: "team-kit", version: "1.0.0", description: "A team plugin",
      files: [{ path: "skills/review/SKILL.md", text: "---\nname: review\ndescription: Review work\n---\nReview work.\n" }] });
    await studio.reviewDraft("team-kit", draft.treeDigest);
    const preview = await invoke(CHANNELS.pluginStudio.previewInstallDraft, hostFrameEvent(), "team-kit") as { value: { previewId: string } };
    return preview.value.previewId;
  }

  function registerRelaunch() {
    const event = hostFrameEvent();
    Object.assign(event.sender, { mainFrame: event.senderFrame });
    const relaunchApp = vi.fn();
    registerAppHandlers({ auditLogger: { log: vi.fn() }, relaunchApp,
      getMainWindow: () => ({ webContents: event.sender, isDestroyed: () => false }) } as never);
    return { relaunchApp, request: () => invoke(CHANNELS.app.relaunch, event, { intent: { inputOrigin: "user-keyboard", userActivation: true } }) };
  }

  it("refuses a reviewed local install after reserving relaunch without creating installed files", async () => {
    const previewId = await reviewedPreview();
    const relaunch = registerRelaunch();
    expect(await relaunch.request()).toEqual({ ok: true });
    expect(await invoke(CHANNELS.pluginStudio.installFromFile, hostFrameEvent(), previewId, []))
      .toMatchObject({ ok: false, message: expect.stringMatching(/restart/i) });
    expect(content.list()).toEqual([]);
    await expect(readdir(join(root, "packages"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(activate).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it("refuses relaunch throughout a local install activation", async () => {
    const previewId = await reviewedPreview();
    const relaunch = registerRelaunch();
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const held = new Promise<void>((resolve) => { release = resolve; });
    vi.mocked(activate).mockImplementationOnce(async () => { entered(); await held; return { retired: Promise.resolve() }; });
    const pending = invoke(CHANNELS.pluginStudio.installFromFile, hostFrameEvent(), previewId, []);
    await started;
    try {
      expect(await relaunch.request()).toEqual({ ok: false, error: "plugin-install-in-progress" });
      expect(relaunch.relaunchApp).not.toHaveBeenCalled();
    } finally {
      release();
      await pending;
    }
    expect(await relaunch.request()).toEqual({ ok: true });
  });

  it("previews a reviewed draft while home privacy refuses extension starts", async () => {
    const studio = new PluginStudioStore();
    const draft = await studio.writeDraft({ name: "team-kit", version: "1.0.0", description: "A team plugin",
      files: [{ path: "skills/review/SKILL.md", text: "---\nname: review\ndescription: Review work\n---\nReview work.\n" }] });
    await studio.reviewDraft("team-kit", draft.treeDigest);
    setProcessPlatform("win32");
    setPluginWorkerConfinementRequestedAtBoot(true);
    setAveHomePrivacyAtBoot({ enforcement: "none", home: root, category: "read-back-failed", reason: "fixture" });
    expect(await invoke(CHANNELS.pluginStudio.previewInstallDraft, hostFrameEvent(), "team-kit"))
      .toMatchObject({ ok: true, value: { name: "team-kit", hookConfinement: "user-permissions" } });
  });

  it("registers every declared channel and refuses a plugin shell", async () => {
    expect([...handlers.keys()].sort()).toEqual(Object.values(CHANNELS.pluginStudio).sort());
    const result = await invoke(CHANNELS.pluginStudio.listDrafts, pluginShellFrameEvent());
    expect(result).toEqual({ ok: false, error: "unauthorized-frame" });
  });

  it("installs reviewed local bytes through the content store with no source binding", async () => {
    const studio = new PluginStudioStore();
    const created = await studio.writeDraft({ name: "team-kit", version: "1.0.0", description: "A team plugin",
      files: [{ path: "skills/review/SKILL.md", text: "---\nname: review\ndescription: Review work\n---\nReview work.\n" }] });
    expect(await invoke(CHANNELS.pluginStudio.previewInstallDraft, hostFrameEvent(), "team-kit"))
      .toMatchObject({ ok: false, code: "invalid-request" });
    await studio.reviewDraft("team-kit", created.treeDigest);
    const previewResult = await invoke(CHANNELS.pluginStudio.previewInstallDraft, hostFrameEvent(), "team-kit") as { ok: boolean; value: { previewId: string } };
    expect(previewResult.ok).toBe(true);
    const installed = await invoke(CHANNELS.pluginStudio.installFromFile, hostFrameEvent(), previewResult.value.previewId, []) as { ok: boolean; value: unknown };
    expect(installed).toMatchObject({ ok: true, value: { name: "team-kit", version: "1.0.0", sourceId: null } });
    expect(content.list()).toMatchObject([{ origin: { sourceId: null, sourceOrigin: null, commit: null } }]);
    expect(reload).toHaveBeenCalledOnce();
    const replay = await invoke(CHANNELS.pluginStudio.installFromFile, hostFrameEvent(), previewResult.value.previewId, []);
    expect(replay).toMatchObject({ ok: false });
  });

  it("keeps the connector value projection in the host renderer and rejects stale confirmations", async () => {
    const manager = { getStudioConnectorSource: vi.fn(async () => ({ spec: { id: "sample", transport: "stdio" as const,
      command: "node", auth: "api-key" as const, apiKeyEnv: "SAMPLE_KEY" }, args: ["--visible-arg"], env: { SAMPLE: "visible-env" } })),
      getConfigs: vi.fn(async () => [{ id: "sample", transport: "stdio" as const, command: "node", auth: "api-key" as const, apiKeyEnv: "SAMPLE_KEY" }]),
      getStudioConnectorSummary: vi.fn(async () => ({ digest: (await previewStudioConnector(manager as never, "sample")).specDigest, argsCount: 1, envCount: 1 })) };
    registerPluginStudioHandlers({ auditLogger: { log: vi.fn() }, mcpManager: manager } as never,
      async () => ({ store: content, reload } as never));
    const draft = await invoke(CHANNELS.pluginStudio.writeDraft, hostFrameEvent(), { name: "team-kit", version: "1.0.0",
      description: "A team plugin", references: [{ kind: "connector", name: "sample" }] });
    expect(draft).toMatchObject({ ok: true });
    expect(await invoke(CHANNELS.pluginStudio.connectorCopyPreview, pluginShellFrameEvent(), "sample"))
      .toEqual({ ok: false, error: "unauthorized-frame" });
    const response = await invoke(CHANNELS.pluginStudio.connectorCopyPreview, hostFrameEvent(), "sample") as { ok: boolean; value: Awaited<ReturnType<typeof previewStudioConnector>> };
    expect(response.ok).toBe(true);
    expect(response.value.args).toMatchObject([{ value: "--visible-arg" }]);
    expect(response.value.env).toMatchObject([{ value: "visible-env" }]);
    expect(JSON.stringify(response.value)).not.toContain("stored-key-sentinel");
    const stale = await invoke(CHANNELS.pluginStudio.confirmConnectorCopy, hostFrameEvent(), "team-kit", "sample",
      { specDigest: "0".repeat(64), args: [], env: [] });
    expect(stale).toMatchObject({ ok: false, code: "connector-changed" });
  });

  it("refuses a shared draft when decoded package JSON contains a stored credential", async () => {
    const key = "stored-\"-credential";
    registerPluginStudioHandlers({ auditLogger: { log: vi.fn() }, mcpManager: {
      getStudioStoredCredentialValues: async () => [key],
    } } as never, async () => ({ store: content, reload } as never));
    const studio = new PluginStudioStore();
    const draft = await studio.writeDraft({ name: "team-kit", version: "1.0.0", description: "A team plugin",
      files: [{ path: "mcp.json", text: JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json",
        mcpServers: { sample: { type: "stdio", command: "uvx", args: ["studio-sample==1.0.0"], env: { VALUE: key } } } }) }] });
    await studio.reviewDraft("team-kit", draft.treeDigest);
    const exported = await invoke(CHANNELS.pluginStudio.exportDraft, hostFrameEvent(), "team-kit", false);
    expect(exported).toMatchObject({ ok: false, code: "invalid-request" });
    expect(dialog.showSaveDialog).not.toHaveBeenCalled();
  });

  it("passes only exact reviewed hook consent into a source-free install", async () => {
    const source = join(root, "legacy-hooks");
    await mkdir(join(source, ".claude-plugin"), { recursive: true });
    await mkdir(join(source, "server"), { recursive: true });
    await writeFile(join(source, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "team-kit", version: "1.0.0",
      description: "A team plugin", hooks: { PreToolUse: [{ hooks: [{ type: "command", command: "node",
        args: ["./server/hook.js"] }] }] } }));
    await writeFile(join(source, "server", "hook.js"), "process.stdout.write('ready');\n");
    const studio = new PluginStudioStore();
    await studio.importPackage(source);
    const adapted = await studio.writeDraft({ name: "team-kit", adaptedHooks: [{ index: 0, command: ["node", "./server/hook.js"] }] });
    expect(adapted.errors).toEqual([]);
    await studio.reviewDraft("team-kit", adapted.treeDigest);
    const first = await invoke(CHANNELS.pluginStudio.previewInstallDraft, hostFrameEvent(), "team-kit") as { ok: true; value: { previewId: string;
      components: { hooks: Array<{ digest: string }> }; hookConfinement: string } };
    expect(first.ok).toBe(true);
    expect(first.value.components.hooks).toHaveLength(1);
    expect(first.value.hookConfinement).toMatch(/sandboxed|user-permissions|unavailable/);
    expect(await invoke(CHANNELS.pluginStudio.installFromFile, hostFrameEvent(), first.value.previewId,
      [{ kind: "hook", index: 0, digest: "0".repeat(64) }])).toMatchObject({ ok: false, code: "invalid-request" });
    const second = await invoke(CHANNELS.pluginStudio.previewInstallDraft, hostFrameEvent(), "team-kit") as typeof first;
    const consent = { kind: "hook", index: 0, digest: second.value.components.hooks[0]!.digest };
    expect(await invoke(CHANNELS.pluginStudio.installFromFile, hostFrameEvent(), second.value.previewId, [consent]))
      .toMatchObject({ ok: true, value: { name: "team-kit", sourceId: null } });
    expect(activate).toHaveBeenCalledWith(expect.objectContaining({ kind: "agent-plugin" }), expect.anything(), null, false,
      expect.any(String), [consent]);
    const zipPath = join(root, "installed-export.zip");
    vi.mocked(dialog.showSaveDialog).mockResolvedValueOnce({ canceled: false, filePath: zipPath } as never);
    expect(await invoke(CHANNELS.pluginStudio.exportInstalled, hostFrameEvent(), "team-kit", true))
      .toEqual({ ok: true, value: zipPath });
    const zip = new AdmZip(await readFile(zipPath));
    const legacy = JSON.parse(zip.getEntry("hooks/hooks.json")!.getData().toString("utf8")) as { hooks: Record<string, unknown> };
    expect(Object.keys(legacy.hooks)).toEqual(["PreToolUse"]);
    expect(zip.getEntry("hooks/PROTOCOL.md")!.getData().toString("utf8")).toContain("Stdin payload");
  });
});
