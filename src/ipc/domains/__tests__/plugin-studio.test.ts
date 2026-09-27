import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CHANNELS } from "../../../contract/app-contract.js";
import { hostFrameEvent, pluginShellFrameEvent } from "../../../__tests__/test-helpers.js";
import { ContentStore } from "../../../marketplace/content/store.js";
import { PluginStudioStore } from "../../../studio/store.js";
import { previewStudioConnector } from "../../../studio/connector.js";

const { handlers } = vi.hoisted(() => ({ handlers: new Map<string, (...args: unknown[]) => Promise<unknown>>() }));
vi.mock("electron", () => ({
  ipcMain: { handle: (channel: string, fn: (...args: unknown[]) => Promise<unknown>) => handlers.set(channel, fn) },
  dialog: { showOpenDialog: vi.fn(async () => ({ canceled: true, filePaths: [] })), showSaveDialog: vi.fn(async () => ({ canceled: true })) },
}));

import { registerPluginStudioHandlers } from "../plugin-studio.js";

const originalHome = process.env.AVE_HOME;
let root: string;
let content: ContentStore;
let reload: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  handlers.clear();
  root = await mkdtemp(join(tmpdir(), "ave-studio-ipc-"));
  process.env.AVE_HOME = join(root, "home");
  reload = vi.fn(async () => undefined);
  content = await ContentStore.open({ root: join(root, "packages"), english: {}, activation: {
    activate: vi.fn(async () => undefined), deactivate: vi.fn(async () => undefined),
  } });
  registerPluginStudioHandlers({ auditLogger: { log: vi.fn() } } as never, async () => ({ store: content, reload } as never));
});
afterEach(async () => {
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
});
