import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { openFeatureNamespace } from "../../main/storage/feature-namespace.js";
import { resolveRuntimeMcp } from "../../mcp/agent-plugin-mcp.js";
import type { McpManager } from "../../mcp/mcp-manager.js";
import { PluginMcpTrustStore } from "../../mcp/plugin-mcp-projection.js";
import type { InstalledAgentPluginRuntime } from "./service.js";

type BundledManager = Pick<McpManager, "prepareBundledGeneration" | "publishBundledGeneration" | "discardBundledGeneration" | "disconnectBundledGeneration">;

interface ActivePackage {
  version: string;
  generationId: string;
  dir: string;
  activationId: string;
}

export interface AgentPluginMcpRuntimeOptions {
  trust?: PluginMcpTrustStore;
  dataDirForPackage?: (name: string) => Promise<string>;
}

/** Publish installed server components through the shared bundled MCP manager. */
export class AgentPluginMcpRuntime {
  private active = new Map<string, ActivePackage>();
  private trust: PluginMcpTrustStore | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly manager: BundledManager, private readonly options: AgentPluginMcpRuntimeOptions = {}) {
    this.trust = options.trust;
  }

  private async trustStore(): Promise<PluginMcpTrustStore> {
    if (this.trust) return this.trust;
    const dir = await openFeatureNamespace("agent-plugin-trust").childDir("mcp");
    this.trust = new PluginMcpTrustStore(join(dir, "approvals.json"));
    return this.trust;
  }

  private async dataDir(name: string): Promise<string> {
    if (!/^[a-z][a-z0-9-]*$/u.test(name)) throw new Error(`invalid agent plugin package name ${name}`);
    return this.options.dataDirForPackage?.(name) ?? openFeatureNamespace("agent-plugin-data").childDir(name);
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }

  private async removeOne(name: string): Promise<void> {
    const previous = this.active.get(name);
    if (!previous) return;
    await this.manager.disconnectBundledGeneration(`agent-plugin/${name}`, previous.activationId);
    this.active.delete(name);
  }

  private async publishOne(item: InstalledAgentPluginRuntime): Promise<void> {
    const pluginId = `agent-plugin/${item.name}`;
    const previous = this.active.get(item.name);
    if (Object.keys(item.content.components.mcpServers).length === 0) {
      await this.removeOne(item.name);
      return;
    }
    if (previous?.version === item.version && previous.generationId === item.generationId && previous.dir === item.dir) return;
    const activationId = randomUUID();
    const projections = resolveRuntimeMcp(item.content.components.mcpServers, {
      packageName: item.name,
      version: item.version,
      generationRoot: item.dir,
      dataDir: await this.dataDir(item.name),
      activationId,
      generationId: item.generationId,
    });
    const prepared = await this.manager.prepareBundledGeneration(
      { pluginId, generationId: activationId }, projections, await this.trustStore(),
    );
    try { this.manager.publishBundledGeneration(prepared); }
    catch (error) { await this.manager.discardBundledGeneration(prepared); throw error; }
    this.active.set(item.name, { version: item.version, generationId: item.generationId, dir: item.dir, activationId });
    if (previous) await this.manager.disconnectBundledGeneration(pluginId, previous.activationId);
  }

  /** Called inside the content-store transaction so a refused publication rolls back the ledger. */
  async activate(item: InstalledAgentPluginRuntime): Promise<void> {
    await this.serialize(() => this.publishOne(item));
  }

  async deactivate(name: string): Promise<void> {
    await this.serialize(() => this.removeOne(name));
  }

  async sync(packages: readonly InstalledAgentPluginRuntime[]): Promise<void> {
    await this.serialize(async () => {
      const desired = new Set<string>();
      for (const item of packages) {
        if (Object.keys(item.content.components.mcpServers).length > 0) desired.add(item.name);
        await this.publishOne(item);
      }
      for (const name of this.active.keys()) {
        if (desired.has(name)) continue;
        await this.removeOne(name);
      }
    });
  }
}
