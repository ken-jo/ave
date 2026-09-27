import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ToolRegistry } from "../registry.js";
import { createPluginStudioTools } from "../plugin-studio.js";
import { PluginStudioStore } from "../../studio/store.js";

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
});
