import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { openFeatureNamespace } from "../../main/storage/feature-namespace.js";
import { resolveRuntimeMcp } from "../../mcp/agent-plugin-mcp.js";
import type { McpManager } from "../../mcp/mcp-manager.js";
import { PluginMcpTrustStore } from "../../mcp/plugin-mcp-projection.js";
import { bundledCredentialDeclaration } from "../../mcp/bundled-credential.js";
import type { McpComponentConsent } from "../../shared/git-marketplace.js";
import type { InstalledAgentPluginRuntime } from "./service.js";

type BundledManager = Pick<McpManager, "prepareBundledGeneration" | "publishBundledGeneration" | "discardBundledGeneration" | "disconnectBundledGeneration" | "stageBundledCredentialDrop">;

interface ActivePackage {
  version: string;
  generationId: string;
  dir: string;
  activationId: string;
  credentialDeclarations: Readonly<Record<string, string>>;
}

function credentialDeclarations(item: InstalledAgentPluginRuntime): Record<string, string> {
  return Object.fromEntries(Object.entries(item.content.components.mcpServers)
    .filter(([, server]) => server.auth === "api-key")
    .map(([name, server]) => [name, bundledCredentialDeclaration(server)]));
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

  private async stageChangedCredentials(name: string, previous: ActivePackage | undefined, next: Readonly<Record<string, string>>, serverNames: readonly string[]): Promise<() => Promise<void>> {
    const restores: Array<() => Promise<void>> = [];
    const restore = async () => {
      const results = await Promise.allSettled(restores.reverse().map((run) => run()));
      const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
      if (failures.length > 0) throw new AggregateError(failures.map((result) => result.reason), "bundled credential rollback failed");
    };
    try {
      for (const serverName of new Set([...Object.keys(previous?.credentialDeclarations ?? {}), ...serverNames])) {
        restores.push(await this.manager.stageBundledCredentialDrop({ kind: "agent-plugin", name }, serverName, next[serverName]));
      }
    } catch (error) {
      try { await restore(); }
      catch (restoreError) { throw new AggregateError([error, restoreError], "bundled credential staging rollback failed"); }
      throw error;
    }
    return restore;
  }

  private async publishOne(item: InstalledAgentPluginRuntime, consents: readonly McpComponentConsent[] = [], force = false): Promise<void> {
    const pluginId = `agent-plugin/${item.name}`;
    const previous = this.active.get(item.name);
    const nextCredentials = credentialDeclarations(item);
    const selected = new Set<string>();
    for (const consent of consents) {
      const server = Object.hasOwn(item.content.components.mcpServers, consent.name)
        ? item.content.components.mcpServers[consent.name] : undefined;
      if (!server || server.digest !== consent.digest || selected.has(consent.name)) {
        throw new Error(`agent plugin ${item.name} MCP consent does not match the installed component ${consent.name}`);
      }
      selected.add(consent.name);
    }
    if (Object.keys(item.content.components.mcpServers).length === 0) {
      const restoreCredentials = await this.stageChangedCredentials(item.name, previous, nextCredentials, []);
      try { await this.removeOne(item.name); }
      catch (error) { await restoreCredentials(); throw error; }
      return;
    }
    const sameGeneration = previous?.version === item.version && previous.generationId === item.generationId && previous.dir === item.dir;
    if (!force && consents.length === 0 && sameGeneration) return;
    const activationId = force && sameGeneration ? previous.activationId : randomUUID();
    const projections = resolveRuntimeMcp(item.content.components.mcpServers, {
      packageName: item.name,
      version: item.version,
      generationRoot: item.dir,
      dataDir: await this.dataDir(item.name),
      activationId,
      generationId: item.generationId,
    });
    const trust = await this.trustStore();
    const newApprovals = projections.filter((projection) => selected.has(projection.owner.localId) && !trust.isApproved(projection));
    const restoreCredentials = await this.stageChangedCredentials(item.name, previous, nextCredentials, Object.keys(item.content.components.mcpServers));
    try {
      for (const projection of newApprovals) trust.approve(projection);
      const prepared = await this.manager.prepareBundledGeneration(
        { pluginId, generationId: activationId }, projections, trust,
      );
      try { this.manager.publishBundledGeneration(prepared); }
      catch (error) { await this.manager.discardBundledGeneration(prepared); throw error; }
    } catch (error) {
      const rollbackErrors: unknown[] = [];
      for (const projection of newApprovals) {
        try { trust.revoke(projection); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
      try { await restoreCredentials(); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
      if (rollbackErrors.length > 0) throw new AggregateError([error, ...rollbackErrors], "agent plugin MCP activation rollback failed");
      throw error;
    }
    this.active.set(item.name, { version: item.version, generationId: item.generationId, dir: item.dir, activationId, credentialDeclarations: nextCredentials });
    if (previous && previous.activationId !== activationId) await this.manager.disconnectBundledGeneration(pluginId, previous.activationId);
  }

  /** Called inside the content-store transaction so a refused publication rolls back the ledger. */
  async activate(item: InstalledAgentPluginRuntime, consents: readonly McpComponentConsent[] = []): Promise<void> {
    await this.serialize(() => this.publishOne(item, consents));
  }

  async deactivate(name: string): Promise<void> {
    await this.serialize(() => this.removeOne(name));
  }

  async reconnect(item: InstalledAgentPluginRuntime): Promise<void> {
    await this.serialize(() => this.publishOne(item, [], true));
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
