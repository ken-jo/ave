import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ScriptHookManager } from "../../hooks/script-hook-manager.js";
import { PluginHookTrustStore, type PreparedPluginHookProjection } from "../../hooks/plugin-hook-projection.js";
import { resolveBundledArgv } from "../../plugins/resolve-bundled-argv.js";
import { openFeatureNamespace } from "../../main/storage/feature-namespace.js";
import type { HookComponentConsent } from "../../shared/git-marketplace.js";
import type { InstalledAgentPluginRuntime } from "./service.js";

interface ActiveHooks {
  item: InstalledAgentPluginRuntime;
  activationId: string;
  projections: readonly PreparedPluginHookProjection[];
  leases: number;
  drained: Array<() => void>;
}

export interface AgentPluginHookRuntimeOptions {
  trust?: PluginHookTrustStore;
  dataDirForPackage?: (name: string) => Promise<string>;
}

/** Bind reviewed hook components to installed generations and the shared runner. */
export class AgentPluginHookRuntime {
  private readonly active = new Map<string, ActiveHooks>();
  private trust: PluginHookTrustStore | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly manager: ScriptHookManager, private readonly options: AgentPluginHookRuntimeOptions = {}) {
    this.trust = options.trust;
    manager.registerGenerationLeaseSource("agent-plugin/", async (pluginId, activationId) => {
      const name = pluginId.slice("agent-plugin/".length);
      const current = this.active.get(name);
      if (!current || current.activationId !== activationId) throw new Error(`hook generation ${activationId} is retired`);
      current.leases += 1;
      return { release: () => {
        current.leases -= 1;
        if (current.leases === 0) for (const done of current.drained.splice(0)) done();
      } };
    });
  }

  private async trustStore(): Promise<PluginHookTrustStore> {
    if (this.trust) return this.trust;
    const dir = await openFeatureNamespace("agent-plugin-trust").childDir("hooks");
    this.trust = new PluginHookTrustStore(join(dir, "approvals.json"));
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

  private async waitForDrain(record: ActiveHooks): Promise<void> {
    if (record.leases === 0) return;
    await new Promise<void>((resolve) => record.drained.push(resolve));
  }

  private async removeOne(name: string): Promise<void> {
    const old = this.active.get(name);
    if (!old) return;
    this.manager.removePluginGeneration(`agent-plugin/${name}`, old.activationId);
    this.active.delete(name);
    await this.waitForDrain(old);
  }

  private async restore(record: ActiveHooks): Promise<void> {
    const trust = await this.trustStore();
    const publication = this.manager.preparePluginGeneration(record.projections, trust,
      { pluginId: `agent-plugin/${record.item.name}`, generationId: record.activationId });
    this.active.set(record.item.name, record);
    publication.publish();
  }

  private async projections(item: InstalledAgentPluginRuntime, activationId: string): Promise<PreparedPluginHookProjection[]> {
    const dataDir = await this.dataDir(item.name);
    return item.content.components.hooks.map((hook, index) => {
      const envEntries = Object.entries(hook.env ?? {});
      const resolved = resolveBundledArgv({ generationRoot: item.dir, dataDir,
        argv: [...hook.command, ...envEntries.map(([, value]) => value)],
        baseFingerprint: hook.digest, label: `hook ${item.name}#${index}`, policy: "hook" });
      return {
        owner: { pluginId: `agent-plugin/${item.name}`, pluginVersion: item.version,
          activationId, generationId: item.generationId, localId: String(index), fingerprint: hook.digest },
        entries: [{ id: String(index), event: hook.event as PreparedPluginHookProjection["entries"][number]["event"],
          ...(hook.matcher ? { matcher: hook.matcher } : {}), command: [...resolved.argv.slice(0, hook.command.length)],
          ...(hook.env ? { env: Object.fromEntries(envEntries.map(([key], offset) => [key, resolved.argv[hook.command.length + offset]!])) } : {}),
          timeoutMs: hook.timeoutMs, source: "config" }],
        confinement: { kind: "bundled" as const, dataDir, generationRoot: item.dir },
      };
    });
  }

  private async publishOne(item: InstalledAgentPluginRuntime, consents: readonly HookComponentConsent[] = []): Promise<() => Promise<void>> {
    const old = this.active.get(item.name);
    const selected = new Set<number>();
    for (const consent of consents) {
      if (!Number.isInteger(consent.index) || consent.index < 0 || selected.has(consent.index)
        || item.content.components.hooks[consent.index]?.digest !== consent.digest) {
        throw new Error(`hook consent does not match installed component ${consent.index}`);
      }
      selected.add(consent.index);
    }
    if (item.content.components.hooks.length === 0) {
      await this.removeOne(item.name);
      return async () => { if (old) await this.restore(old); };
    }
    if (old && old.item.version === item.version && old.item.generationId === item.generationId
      && old.item.dir === item.dir && selected.size === 0) return async () => undefined;
    const activationId = randomUUID();
    const projections = await this.projections(item, activationId);
    const trust = await this.trustStore();
    const newlyApproved = projections.filter((projection, index) => selected.has(index) && !trust.isApproved(projection));
    try {
      for (const projection of newlyApproved) trust.approve(projection);
      const publication = this.manager.preparePluginGeneration(projections, trust,
        { pluginId: `agent-plugin/${item.name}`, generationId: activationId });
      this.active.set(item.name, { item, activationId, projections, leases: 0, drained: [] });
      publication.publish();
      if (old) {
        this.manager.removePluginGeneration(`agent-plugin/${item.name}`, old.activationId);
        await this.waitForDrain(old);
      }
    } catch (error) {
      if (old) this.active.set(item.name, old);
      else this.active.delete(item.name);
      for (const projection of newlyApproved) trust.revoke(projection);
      throw error;
    }
    return async () => {
      await this.removeOne(item.name);
      for (const projection of newlyApproved) trust.revoke(projection);
      if (old) await this.restore(old);
    };
  }

  async activate(item: InstalledAgentPluginRuntime, consents: readonly HookComponentConsent[] = []): Promise<() => Promise<void>> {
    return this.serialize(() => this.publishOne(item, consents));
  }

  async deactivate(name: string): Promise<void> {
    await this.serialize(() => this.removeOne(name));
  }

  async sync(packages: readonly InstalledAgentPluginRuntime[]): Promise<void> {
    await this.serialize(async () => {
      const desired = new Set<string>();
      for (const item of packages) {
        if (item.content.components.hooks.length > 0) desired.add(item.name);
        await this.publishOne(item);
      }
      for (const name of this.active.keys()) if (!desired.has(name)) await this.removeOne(name);
    });
  }
}
