import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { openFeatureNamespace } from "../../main/storage/feature-namespace.js";
import { resolveRuntimeMcp } from "../../mcp/agent-plugin-mcp.js";
import type { McpManager } from "../../mcp/mcp-manager.js";
import { PluginMcpTrustStore, type PreparedPluginMcpProjection } from "../../mcp/plugin-mcp-projection.js";
import { agentPluginComponentDigests } from "../../plugins/contribution-approval-digest.js";
import { assertCarriedApprovalsHold, carryApprovals } from "../../plugins/plugin-contribution-trust.js";
import { bundledCredentialDeclaration } from "../../mcp/bundled-credential.js";
import type { McpComponentConsent } from "../../shared/git-marketplace.js";
import { createLogger } from "../../lib/logger.js";
import { errorMessage } from "../../shared/error-message.js";
import type { InstalledAgentPluginRuntime } from "./service.js";

const log = createLogger("agent-plugin-mcp-runtime");

type BundledManager = Pick<McpManager,
  | "prepareBundledGeneration"
  | "publishBundledGeneration"
  | "discardBundledGeneration"
  | "disconnectBundledGeneration"
  | "stageBundledCredentialDrop"
  | "registerGenerationLeaseSource"
>;

interface ActivePackage {
  version: string;
  generationId: string;
  dir: string;
  activationId: string;
  credentialDeclarations: Readonly<Record<string, string>>;
  /** The published servers, whose approvals an update may carry forward (§18.7.3). */
  projections: readonly PreparedPluginMcpProjection[];
}

/**
 * One published activation's calls (design §18.7.4): a call takes a lease,
 * and a retired activation admits none. Its servers disconnect only once its
 * count is zero.
 */
interface ActivationLeases {
  name: string;
  leases: number;
  retired: boolean;
  drained: Array<() => void>;
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

const OWNER_PREFIX = "agent-plugin/";

/**
 * Publish installed server components through the shared bundled MCP manager.
 *
 * It owns the generation leases of `agent-plugin/` servers (design §18.7.4):
 * every bundled call through the manager takes a lease on the exact
 * activation that published its server, a new activation closes admission
 * to the one it replaces, and the replaced one disconnects only after its
 * calls drain. An update in flight therefore never cuts a call short.
 */
export class AgentPluginMcpRuntime {
  private active = new Map<string, ActivePackage>();
  private readonly activations = new Map<string, ActivationLeases>();
  private trust: PluginMcpTrustStore | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly manager: BundledManager, private readonly options: AgentPluginMcpRuntimeOptions = {}) {
    this.trust = options.trust;
    manager.registerGenerationLeaseSource(OWNER_PREFIX, async (pluginId, activationId) => this.acquireExact(pluginId, activationId));
  }

  /** A lease on the exact activation; throws for one that is retired or never published. */
  acquireExact(pluginId: string, activationId: string): { release(): void } {
    const record = this.activations.get(activationId);
    if (!record || record.retired || `${OWNER_PREFIX}${record.name}` !== pluginId) {
      throw new Error(`bundled MCP generation ${activationId} of ${pluginId} is retired`);
    }
    record.leases += 1;
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        record.leases -= 1;
        if (record.leases === 0) for (const done of record.drained.splice(0)) done();
      },
    };
  }

  /** Resolves when the activation's calls have all ended. */
  waitForDrain(activationId: string): Promise<void> {
    const record = this.activations.get(activationId);
    if (!record || record.leases === 0) return Promise.resolve();
    return new Promise<void>((resolve) => record.drained.push(resolve));
  }

  /** Whether a call is running on the package's current activation (the apply queue waits for none, §18.7.4). */
  hasCallsInFlight(name: string): boolean {
    const current = this.active.get(name);
    return current !== undefined && (this.activations.get(current.activationId)?.leases ?? 0) > 0;
  }

  /**
   * The approval state of each server of the package's published
   * generation (§18.7.2, §18.7.5): whether it is approved, and the approval
   * digest its record holds (null for an approval from an earlier Ave
   * version that could not be matched to its bytes).
   */
  async approvals(name: string): Promise<Array<{ name: string; approvalDigest: string | null; approved: boolean; recordDigest: string | null }>> {
    const current = this.active.get(name);
    if (!current) return [];
    const trust = await this.trustStore();
    return current.projections.map((projection) => {
      const record = trust.record(projection);
      return { name: projection.owner.localId, approvalDigest: projection.approvalDigest, approved: record !== undefined, recordDigest: record?.approvalDigest ?? null };
    });
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

  /** Close admission, wait for the calls in flight, then disconnect: the activation's servers stop only once unused. */
  private async retire(name: string, activationId: string): Promise<void> {
    const record = this.activations.get(activationId);
    if (record) record.retired = true;
    await this.waitForDrain(activationId);
    await this.manager.disconnectBundledGeneration(`${OWNER_PREFIX}${name}`, activationId);
    this.activations.delete(activationId);
  }

  private async removeOne(name: string): Promise<void> {
    const previous = this.active.get(name);
    if (!previous) return;
    this.active.delete(name);
    await this.retire(name, previous.activationId);
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

  /**
   * Publish `item`. Resolves once the new activation is published; the
   * returned `retired` resolves once the activation it replaced has drained
   * and disconnected (immediately when it replaced none).
   */
  private async publishOne(item: InstalledAgentPluginRuntime, consents: readonly McpComponentConsent[] = [], force = false): Promise<{ retired: Promise<void> }> {
    const pluginId = `${OWNER_PREFIX}${item.name}`;
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
      if (!previous) return { retired: Promise.resolve() };
      this.active.delete(item.name);
      const record = this.activations.get(previous.activationId);
      if (record) record.retired = true;
      // The servers' calls drain before they disconnect; the package's old files stay until then.
      const retired = this.retire(item.name, previous.activationId).catch(async (error: unknown) => {
        await restoreCredentials();
        throw error;
      });
      return { retired };
    }
    const sameGeneration = previous?.version === item.version && previous.generationId === item.generationId && previous.dir === item.dir;
    if (!force && consents.length === 0 && sameGeneration) return { retired: Promise.resolve() };
    const activationId = force && sameGeneration ? previous.activationId : randomUUID();
    const projections = resolveRuntimeMcp(item.content.components.mcpServers, {
      packageName: item.name,
      version: item.version,
      generationRoot: item.dir,
      dataDir: await this.dataDir(item.name),
      activationId,
      generationId: item.generationId,
      approvalDigests: agentPluginComponentDigests(item.content.components, item.content.files).mcpServers,
    });
    const trust = await this.trustStore();
    // An approval of exactly this generation that predates approval digests gets the digest of these, its running bytes.
    for (const projection of projections) trust.recordDigest(projection);
    const newApprovals = projections.filter((projection) => selected.has(projection.owner.localId) && !trust.isApproved(projection));
    const restoreCredentials = await this.stageChangedCredentials(item.name, previous, nextCredentials, Object.keys(item.content.components.mcpServers));
    const replacing = previous !== undefined && previous.activationId !== activationId;
    if (!this.activations.has(activationId)) this.activations.set(activationId, { name: item.name, leases: 0, retired: false, drained: [] });
    try {
      for (const projection of newApprovals) trust.approve(projection);
      // Approval carry-forward (§18.7.3): an unchanged server keeps the approval it had in the active generation.
      const carried = carryApprovals(trust, previous?.projections ?? [], projections);
      for (const { to } of carried) newApprovals.push(to);
      const prepared = await this.manager.prepareBundledGeneration(
        { pluginId, generationId: activationId }, projections, trust,
      );
      try {
        // Before the active generation changes: a carried approval holds only while its source does.
        assertCarriedApprovalsHold(trust, carried);
        if (this.active.get(item.name) !== previous) throw new Error(`agent plugin ${item.name} changed generation while it was prepared`);
        // Admission to the replaced activation closes at publication: a call after this lands on the new one.
        if (replacing) this.activations.get(previous.activationId)!.retired = true;
        this.manager.publishBundledGeneration(prepared);
      } catch (error) {
        if (replacing) {
          const record = this.activations.get(previous.activationId);
          if (record) record.retired = false;
        }
        await this.manager.discardBundledGeneration(prepared);
        throw error;
      }
    } catch (error) {
      if (activationId !== previous?.activationId) this.activations.delete(activationId);
      const rollbackErrors: unknown[] = [];
      for (const projection of newApprovals) {
        try { trust.revoke(projection); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
      }
      try { await restoreCredentials(); } catch (rollbackError) { rollbackErrors.push(rollbackError); }
      if (rollbackErrors.length > 0) throw new AggregateError([error, ...rollbackErrors], "agent plugin MCP activation rollback failed");
      throw error;
    }
    this.active.set(item.name, { version: item.version, generationId: item.generationId, dir: item.dir, activationId, credentialDeclarations: nextCredentials, projections });
    // The predecessor disconnects only after its calls drain, outside this queue.
    return { retired: replacing ? this.retire(item.name, previous.activationId) : Promise.resolve() };
  }

  /**
   * Called inside the content-store transaction so a refused publication
   * rolls back the ledger. `retired` resolves when the activation this one
   * replaced has drained and disconnected.
   */
  async activate(item: InstalledAgentPluginRuntime, consents: readonly McpComponentConsent[] = []): Promise<{ retired: Promise<void> }> {
    return this.serialize(() => this.publishOne(item, consents));
  }

  async deactivate(name: string): Promise<void> {
    await this.serialize(() => this.removeOne(name));
  }

  async reconnect(item: InstalledAgentPluginRuntime): Promise<void> {
    await this.serialize(async () => {
      this.reportRetirement(item.name, (await this.publishOne(item, [], true)).retired);
    });
  }

  /** A retirement nobody waits for: its failure is logged, and the boot sweep removes what it left (§18.7.4). */
  private reportRetirement(name: string, retired: Promise<void>): void {
    retired.catch((error: unknown) => log.warn({ name, err: errorMessage(error) }, "agent plugin MCP predecessor retirement failed"));
  }

  async sync(packages: readonly InstalledAgentPluginRuntime[]): Promise<void> {
    await this.serialize(async () => {
      const desired = new Set<string>();
      for (const item of packages) {
        if (Object.keys(item.content.components.mcpServers).length > 0) desired.add(item.name);
        this.reportRetirement(item.name, (await this.publishOne(item)).retired);
      }
      for (const name of this.active.keys()) {
        if (desired.has(name)) continue;
        await this.removeOne(name);
      }
    });
  }
}
