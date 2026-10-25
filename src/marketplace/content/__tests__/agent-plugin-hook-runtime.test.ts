import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { ScriptHookManager } from "../../../hooks/script-hook-manager.js";
import { PluginHookTrustStore } from "../../../hooks/plugin-hook-projection.js";
import type { InstalledAgentPluginRuntime } from "../service.js";
import { AgentPluginHookRuntime } from "../agent-plugin-hook-runtime.js";

const root = mkdtempSync(join(tmpdir(), "ave-agent-hook-runtime-"));
const generationRoot = join(root, "generation");
const dataDir = join(root, "data");
mkdirSync(join(generationRoot, "server"), { recursive: true });
mkdirSync(dataDir);
writeFileSync(join(generationRoot, "server", "hook.cjs"), "process.stdout.write(JSON.stringify({action:'allow',reason:'ran'}))");
const hookFile = (text: string) => [{ path: "server/hook.cjs", data: Buffer.from(text) }];
afterAll(async () => { await cleanupTmpDir(root); });

const HOOK_SOURCE = "process.stdout.write(JSON.stringify({action:'allow',reason:'ran'}))";

function item(version: string, generationId: string, digest: string, files: InstalledAgentPluginRuntime["content"]["files"] = []): InstalledAgentPluginRuntime {
  return { name: "review-plugin", version, generationId, dir: generationRoot,
    content: { kind: "agent-plugin", files, components: {
      skills: [], mcpServers: {}, prompts: [], agents: [], routineTemplates: [],
      hooks: [{ event: "pre", command: ["node", "${PLUGIN_ROOT}/server/hook.cjs"], timeoutMs: 1500, digest }],
    } } };
}

describe("installed hook activation", () => {
  it("requires an exact reviewed digest and asks again after a generation change", async () => {
    const manager = new ScriptHookManager();
    const trust = new PluginHookTrustStore();
    const runtime = new AgentPluginHookRuntime(manager, { trust, dataDirForPackage: async () => dataDir });
    const first = item("1.0.0", "a".repeat(64), "b".repeat(64));
    await runtime.sync([first]);
    expect(manager.size()).toBe(0);
    await expect(runtime.activate(first, [{ kind: "hook", index: 0, digest: "c".repeat(64) }])).rejects.toThrow(/does not match/);
    await runtime.activate(first, [{ kind: "hook", index: 0, digest: "b".repeat(64) }]);
    expect(manager.size()).toBe(1);
    expect((await manager.runPreToolUse({ toolName: "read_file", source: "builtin", category: "read",
      input: {}, sessionId: "hook", trustOrigin: "user-keyboard" })).decision).toBe("allow");

    const update = item("1.0.1", "d".repeat(64), "b".repeat(64));
    await runtime.sync([update]);
    expect(manager.size()).toBe(0);
    await runtime.activate(update, [{ kind: "hook", index: 0, digest: "b".repeat(64) }]);
    expect(manager.size()).toBe(1);
    await runtime.deactivate(update.name);
    expect(manager.size()).toBe(0);
  });

  it("carries a hook's approval to an update with unchanged bytes, not to one whose hook changed, and retires the old one after it drains", async () => {
    const manager = new ScriptHookManager();
    let acquire!: (pluginId: string, activationId: string) => Promise<{ release(): void }>;
    const register = manager.registerGenerationLeaseSource.bind(manager);
    manager.registerGenerationLeaseSource = (prefix, source) => { acquire = source; register(prefix, source); };
    const trust = new PluginHookTrustStore();
    const runtime = new AgentPluginHookRuntime(manager, { trust, dataDirForPackage: async () => dataDir });
    const first = item("1.0.0", "a".repeat(64), "b".repeat(64), hookFile(HOOK_SOURCE));
    await runtime.activate(first, [{ kind: "hook", index: 0, digest: "b".repeat(64) }]);
    expect(manager.size()).toBe(1);
    const firstActivation = manager.hooksOfType("pre")[0]!.owner!.activationId!;
    const running = await acquire("agent-plugin/review-plugin", firstActivation);
    expect(runtime.hasCallsInFlight("review-plugin")).toBe(true);

    const { retired } = await runtime.activate(item("1.0.1", "d".repeat(64), "b".repeat(64), hookFile(HOOK_SOURCE)));
    expect(manager.size()).toBe(1);
    expect(manager.hooksOfType("pre")[0]!.owner).toMatchObject({ pluginVersion: "1.0.1", generationId: "d".repeat(64) });
    await expect(acquire("agent-plugin/review-plugin", firstActivation)).rejects.toThrow(/is retired/u);
    let settled = false;
    void retired.then(() => { settled = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    running.release();
    running.release();
    await retired;

    await runtime.activate(item("1.0.2", "e".repeat(64), "b".repeat(64), hookFile("process.exit(1)")));
    expect(manager.size()).toBe(0);
    await runtime.deactivate("review-plugin");
  });
});
