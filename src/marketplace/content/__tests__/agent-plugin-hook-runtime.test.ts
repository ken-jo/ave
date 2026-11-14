import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { promises as dns } from "node:dns";
import { directHostFetchTransport } from "../../../__tests__/support/host-fetch-transport.js";
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
  it("runs an approved HTTP contribution through the host policy and retains its activation lease", async () => {
    const lookup = vi.spyOn(dns, "lookup").mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);
    try {
      const manager = new ScriptHookManager();
      const send = vi.fn(async () => new Response('{"action":"allow","reason":"http ran"}'));
      manager.setHttpHookRuntime({ transport: directHostFetchTransport(send as typeof fetch),
        allowedUrls: ["https://hooks.example.com/check"], allowedEnvVars: [], auditTarget: vi.fn() });
      const runtime = new AgentPluginHookRuntime(manager, { trust: new PluginHookTrustStore(), dataDirForPackage: async () => dataDir });
      const installed = item("1.0.0", "c".repeat(64), "d".repeat(64));
      installed.content.components.hooks = [{ event: "pre", command: [], handlerType: "http",
        http: { url: "https://hooks.example.com/check", method: "POST" }, timeoutMs: 1500, digest: "d".repeat(64) }];
      await runtime.sync([installed]);
      expect(manager.size()).toBe(0);
      await runtime.activate(installed, [{ kind: "hook", index: 0, digest: "d".repeat(64) }]);
      const result = await manager.runPreToolUse({ toolName: "read_file", source: "builtin", category: "read", input: {}, sessionId: "hook", trustOrigin: "user-keyboard" });
      expect(result.decision).toBe("allow");
      expect(send).toHaveBeenCalledOnce();
      expect(runtime.hasCallsInFlight(installed.name)).toBe(false);
      await runtime.deactivate(installed.name);
    } finally { lookup.mockRestore(); }
  });

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
