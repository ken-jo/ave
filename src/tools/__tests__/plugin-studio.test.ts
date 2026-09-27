import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ToolRegistry } from "../registry.js";
import { createPluginStudioTools } from "../plugin-studio.js";
import { PluginStudioStore } from "../../studio/store.js";
import { previewStudioConnector } from "../../studio/connector.js";

const originalHome = process.env.AVE_HOME;
let root: string;
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), "ave-studio-tools-")); process.env.AVE_HOME = join(root, "home"); });
afterEach(async () => { if (originalHome === undefined) delete process.env.AVE_HOME; else process.env.AVE_HOME = originalHome; await rm(root, { recursive: true, force: true }); });

describe("Studio tool registry and executor surface", () => {
  it("exposes exactly three approval-gated builtin meta tools", async () => {
    const registry = new ToolRegistry();
    registry.registerBatch(createPluginStudioTools());
    const names = ["plugin_studio_draft", "plugin_studio_read", "plugin_studio_validate"];
    expect(registry.listAll().map((tool) => tool.name).sort()).toEqual(names);
    for (const name of names) {
      const tool = registry.findByName(name)!;
      expect(tool).toMatchObject({ source: "builtin", category: "meta", decisionOverride: "ask" });
      expect(tool.toJsonSchema()).toBeDefined();
    }
    const written = await registry.findByName("plugin_studio_draft")!.execute({ name: "team-kit", version: "1.0.0", description: "A team plugin" },
      { metadata: { sessionId: "session-one" } } as never);
    expect(written.isError).toBe(false);
    const read = await registry.findByName("plugin_studio_read")!.execute({ name: "team-kit" }, {} as never);
    expect(read.isError).toBe(false);
    expect(JSON.parse(read.output).draft.name).toBe("team-kit");
    const checked = await registry.findByName("plugin_studio_validate")!.execute({ name: "team-kit" }, {} as never);
    expect(checked.isError).toBe(false);
    expect(JSON.parse(checked.output).errors).toEqual([]);
    expect((await new PluginStudioStore().readDraft("team-kit")).draft.reviewed).toBeUndefined();
    const refused = await registry.findByName("plugin_studio_draft")!.execute({ name: "team-kit", files: [{ path: "server/run.sh", text: "echo hi" }] },
      { metadata: { sessionId: "session-one" } } as never);
    expect(refused).toMatchObject({ isError: true });
    expect(refused.output).toContain("cannot author");
  });

  it("lets a model reference a connector while read and validation reveal only counts and status", async () => {
    const argValue = "arg-sentinel-DoNotReturn==1.0.0";
    const envValue = "env-sentinel-DoNotReturn";
    const manager = { getStudioConnectorSource: async () => ({ spec: { id: "sample", transport: "stdio" as const,
      command: "uvx" }, args: [argValue], env: { SAMPLE: envValue } }) };
    const preview = await previewStudioConnector(manager as never, "sample");
    const store = new PluginStudioStore(async () => ({ digest: preview.specDigest, argsCount: 1, envCount: 1 }), async () => {});
    const registry = new ToolRegistry();
    registry.registerBatch(createPluginStudioTools(store, { getMcpConfigs: async () => [preview.spec] }));
    const created = await registry.findByName("plugin_studio_draft")!.execute({ name: "team-kit", version: "1.0.0",
      description: "A team plugin", references: [{ kind: "connector", name: "sample" }] },
    { metadata: { sessionId: "session-one" } } as never);
    expect(created.isError).toBe(false);
    await store.confirmConnectorCopy("team-kit", "sample", preview, { specDigest: preview.specDigest,
      args: preview.args.map(({ index, digest }) => ({ index, digest })),
      env: preview.env.map(({ name, digest }) => ({ name, digest })) });
    for (const name of ["plugin_studio_read", "plugin_studio_validate"]) {
      const response = await registry.findByName(name)!.execute({ name: "team-kit" }, {} as never);
      expect(response.isError).toBe(false);
      expect(response.output).not.toContain(argValue);
      expect(response.output).not.toContain(envValue);
      expect(JSON.parse(response.output).connectorStatuses).toMatchObject([{ status: "confirmed", argsCount: 1, envCount: 1 }]);
    }
  });
});
