import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { ScriptHookManager } from "../../hooks/script-hook-manager.js";
import { PluginHookTrustStore, type PreparedPluginHookProjection } from "../../hooks/plugin-hook-projection.js";
import { resolveBundledArgv } from "../../plugins/resolve-bundled-argv.js";
import { agentPluginComponentDigests } from "../../plugins/contribution-approval-digest.js";
import { assertCarriedApprovalsHold, carryApprovals } from "../../plugins/plugin-contribution-trust.js";
import { openFeatureNamespace } from "../../main/storage/feature-namespace.js";
import { agentPluginDataDir } from "./agent-plugin-data.js";
import type { HookComponentConsent } from "../../shared/git-marketplace.js";
import type { InstalledAgentPluginRuntime } from "./service.js";

interface ActiveHooks {
  item: InstalledAgentPluginRuntime;
  activationId: string;
  projections: readonly PreparedPluginHookProjection[];
  leases: number;
  drained: Array<() => void>;
}

/** What an activation leaves: how to undo it inside its transaction, and when its predecessor is gone. */
export interface HookActivation {
  rollback(): Promise<void>;
  /** Resolves once the replaced activation's hooks have drained (immediately when none was replaced). */
  retired: Promise<void>;
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
      let released = false;
      return { release: () => {
        if (released) return;
        released = true;
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
    return agentPluginDataDir(name, this.options.dataDirForPackage);
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

  /** As {@link AgentPluginMcpRuntime.approvals}, for each hook of the published generation, by index. */
  async approvals(name: string): Promise<Array<{ index: number; approvalDigest: string | null; approved: boolean; recordDigest: string | null }>> {
    const current = this.active.get(name);
    if (!current) return [];
    const trust = await this.trustStore();
    return current.projections.map((projection) => {
      const record = trust.record(projection);
      return { index: Number(projection.owner.localId), approvalDigest: projection.approvalDigest, approved: record !== undefined, recordDigest: record?.approvalDigest ?? null };
    });
  }

  /** Whether a hook of the package's current activation is running (the apply queue waits for none, §18.7.4). */
  hasCallsInFlight(name: string): boolean {
    return (this.active.get(name)?.leases ?? 0) > 0;
  }

  private async projections(item: InstalledAgentPluginRuntime, activationId: string): Promise<PreparedPluginHookProjection[]> {
    const dataDir = await this.dataDir(item.name);
    const pluginId = `agent-plugin/${item.name}`;
    const digests = agentPluginComponentDigests(item.content.components, item.content.files).hooks;
    return item.content.components.hooks.map((hook, index) => {
      const envEntries = Object.entries(hook.env ?? {});
      const resolved = resolveBundledArgv({ generationRoot: item.dir, dataDir,
        argv: [...hook.command, ...envEntries.map(([, value]) => value)],
        baseFingerprint: hook.digest, label: `hook ${item.name}#${index}`, policy: "hook" });
      return {
        owner: { pluginId, pluginVersion: item.version,
          activationId, generationId: item.generationId, localId: String(index), fingerprint: hook.digest },
        entries: [{ id: String(index), event: hook.event as PreparedPluginHookProjection["entries"][number]["event"],
          ...(hook.matcher ? { matcher: hook.matcher } : {}), command: [...resolved.argv.slice(0, hook.command.length)],
          ...(hook.env ? { env: Object.fromEntries(envEntries.map(([key], offset) => [key, resolved.argv[hook.command.length + offset]!])) } : {}),
          timeoutMs: hook.timeoutMs, source: "config" }],
        confinement: { kind: "bundled" as const, pluginId, dataDir, generationRoot: item.dir },
        approvalDigest: digests[index]!,
      };
    });
  }

  private async publishOne(item: InstalledAgentPluginRuntime, consents: readonly HookComponentConsent[] = []): Promise<HookActivation> {
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
      if (!old) return { rollback: async () => undefined, retired: Promise.resolve() };
      // Admission closes now; the old hooks drain outside this queue, and their files stay until then.
      this.manager.removePluginGeneration(`agent-plugin/${item.name}`, old.activationId);
      this.active.delete(item.name);
      return { rollback: async () => { await this.restore(old); }, retired: this.waitForDrain(old) };
    }
    if (old && old.item.version === item.version && old.item.generationId === item.generationId
      && old.item.dir === item.dir && selected.size === 0) return { rollback: async () => undefined, retired: Promise.resolve() };
    const activationId = randomUUID();
    const projections = await this.projections(item, activationId);
    const trust = await this.trustStore();
    // An approval of exactly this generation that predates approval digests gets the digest of these, its running bytes.
    for (const projection of projections) trust.recordDigest(projection);
    const newlyApproved = projections.filter((projection, index) => selected.has(index) && !trust.isApproved(projection));
    try {
      for (const projection of newlyApproved) trust.approve(projection);
      // Approval carry-forward (§18.7.3): an unchanged hook keeps the approval it had in the active generation.
      const carried = carryApprovals(trust, old?.projections ?? [], projections);
      for (const { to } of carried) newlyApproved.push(to);
      assertCarriedApprovalsHold(trust, carried);
      const publication = this.manager.preparePluginGeneration(projections, trust,
        { pluginId: `agent-plugin/${item.name}`, generationId: activationId });
      this.active.set(item.name, { item, activationId, projections, leases: 0, drained: [] });
      publication.publish();
      // Admission to the replaced activation closes at publication (its lease source throws for it).
      if (old) this.manager.removePluginGeneration(`agent-plugin/${item.name}`, old.activationId);
    } catch (error) {
      if (old) this.active.set(item.name, old);
      else this.active.delete(item.name);
      for (const projection of newlyApproved) trust.revoke(projection);
      throw error;
    }
    return {
      rollback: async () => {
        await this.removeOne(item.name);
        for (const projection of newlyApproved) trust.revoke(projection);
        if (old) await this.restore(old);
      },
      // The replaced hooks' runs end before its files may go.
      retired: old ? this.waitForDrain(old) : Promise.resolve(),
    };
  }

  /**
   * Called inside the content-store transaction: `rollback` undoes it there;
   * `retired` resolves once the activation it replaced has drained.
   */
  async activate(item: InstalledAgentPluginRuntime, consents: readonly HookComponentConsent[] = []): Promise<HookActivation> {
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
