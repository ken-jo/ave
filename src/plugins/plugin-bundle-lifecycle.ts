import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import type { ScriptHookManager } from "../hooks/script-hook-manager.js";
import { PluginHookTrustStore, preparePluginHookGeneration, type PreparedPluginHookProjection } from "../hooks/plugin-hook-projection.js";
import type { SkillStore } from "../main/skill-store.js";
import type { PersonaPromptStore } from "../main/persona-prompt-store.js";
import { parseAgentPluginRoutineTemplates } from "../marketplace/content/agent-plugin-components.js";
import type { AgentPluginRoutineTemplate } from "../shared/agent-plugin-routine-template.js";
import type { McpManager, PreparedBundledMcpGeneration } from "../mcp/mcp-manager.js";
import type { PluginLoopbackManager } from "../mcp/plugin-loopback-manager.js";
import { PluginMcpTrustStore, preparePluginMcpGeneration, type PreparedPluginMcpProjection } from "../mcp/plugin-mcp-projection.js";
import { pluginArtifactGenerationId } from "./plugin-artifact-identity.js";
import { extensionComponentDigests, readPayloadFiles } from "./contribution-approval-digest.js";
import {
  assertCarriedApprovalsHold,
  carryApprovals,
  ContributionTrustReviewStaleError,
} from "./plugin-contribution-trust.js";
import {
  isCommittedPluginGenerationPublicationError,
} from "./committed-generation-publication-error.js";
import { installReceiptPath } from "./plugin-install-receipt.js";
import {
  materializePluginContributions,
  materializePluginGenerationRoot,
  removeRetainedPluginGeneration,
} from "./plugin-contributions.js";
import { PluginGenerationCoordinator, type ActivePluginGeneration } from "./plugin-generation-coordinator.js";
import type { PluginRuntime } from "./runtime.js";
import type {
  ActivePluginGenerationSnapshot,
  CommittedPluginGeneration,
  HostPluginGenerationState,
  PluginRuntimeGenerationLifecycle,
  PluginRuntimeGenerationProjection,
  PluginRuntimeRetirementPhase,
} from "./plugin-host-generation.js";
import type { PluginGenerationLease } from "./plugin-generation-coordinator.js";
import { createLogger } from "../lib/logger.js";
import {
  PluginRetirementJournal,
  pluginRetirementJournalPath,
} from "./plugin-retirement-journal.js";
import {
  opaqueHealthError,
  PluginGenerationHealthJournal,
  pluginGenerationHealthJournalPath,
  type PluginGenerationHealthFault,
} from "./plugin-generation-health-journal.js";
import { errorMessage } from "../shared/error-message.js";
import { sha256Hex } from "../lib/hex-digest-equal.js";
import { sleep } from "../shared/abortable-deadline.js";

const log = createLogger("plugin-bundle-lifecycle");
const MAX_RETIREMENT_ATTEMPTS = 3;
/** Internal runtime-only guard around a prepared generation's pointer commit. */
type GenerationCommitScope = <T>(operation: () => Promise<T>) => Promise<T>;
interface LifecycleQueueToken {
  readonly completions: Promise<void>[];
}
type RetirementPhase =
  | "operation-authority"
  | "skills"
  | "hooks"
  | "mcp"
  | "loopback"
  | PluginRuntimeRetirementPhase
  | "payload"
  | "health";

function freezeSnapshot(value: unknown): void {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return;
  for (const nested of Object.values(value)) freezeSnapshot(nested);
  Object.freeze(value);
}

function activeGenerationSnapshot(
  generation: ActivePluginGeneration<HostPluginGenerationState>,
): ActivePluginGenerationSnapshot {
  const manifest = structuredClone(generation.state.runtime.manifest);
  freezeSnapshot(manifest);
  return Object.freeze({
    pluginId: generation.pluginId,
    generationId: generation.generationId,
    manifest,
  });
}

function extensionRoutineTemplates(
  generation: ActivePluginGeneration,
): AgentPluginRoutineTemplate[] {
  const templates: AgentPluginRoutineTemplate[] = [];
  const ids = new Set<string>();
  for (const contribution of generation.contributions) {
    if (contribution.kind !== "routineTemplate") continue;
    const file = contribution.files[0];
    if (!file || contribution.files.length !== 1) {
      throw new Error(`extension routine declaration ${contribution.localId} has no single file`);
    }
    for (const template of parseAgentPluginRoutineTemplates(Buffer.from(file.content), contribution.path)) {
      if (ids.has(template.id)) throw new Error(`duplicate extension routine template ${generation.pluginId}:${template.id}`);
      ids.add(template.id);
      templates.push({ ...template, packageName: generation.pluginId, version: generation.pluginVersion, sourceKind: "extension" });
    }
  }
  return templates;
}

export interface PluginBundleLifecycleHandler extends PluginRuntimeGenerationLifecycle {
  activate(pluginId: string): Promise<void>;
  deactivate(pluginId: string): Promise<void>;
}

export interface PluginBundleLifecycleDeps {
  pluginRuntime: Pick<PluginRuntime,
    | "getPluginManifest"
    | "getPluginRoot"
    | "getRuntimeGenerationProjection"
    | "prepareRuntimeGeneration"
    | "prepareRuntimeRemoval"
    | "postPublishRuntimeGeneration"
    | "publishRuntimeGeneration"
    | "unpublishRuntimeGeneration"
    | "prepareRuntimeRetirement"
  >;
  receiptCacheRoot: string;
  skillStore: SkillStore;
  personaPromptStore: PersonaPromptStore;
  onContributionsUpdated: () => void;
  hookManager: ScriptHookManager;
  mcpManager: McpManager;
  loopbackManager: Pick<PluginLoopbackManager,
    | "prepareGeneration"
    | "prepareRemoval"
    | "publishGeneration"
    | "postPublishGeneration"
    | "discardGeneration"
    | "retireGeneration"
  >;
  hookTrust?: PluginHookTrustStore;
  mcpTrust?: PluginMcpTrustStore;
  revokeOperationGeneration: (pluginId: string, generationId: string) => void;
}

export interface PluginContributionTrustRow {
  kind: "hook" | "mcpServer";
  pluginId: string;
  pluginVersion: string;
  /** The projection's artifact generation id: the reviewed artifact an approval binds to (§18.7.5). */
  generationId: string;
  localId: string;
  fingerprint: string;
  /** What an approval of this component covers (§18.7.3); null when it cannot be determined. */
  approvalDigest: string | null;
  status: "approved" | "approval_required";
}

/**
 * What an approval of an installed component is bound to (design §18.7.5):
 * the artifact generation the review showed and the component's approval
 * digest there.
 */
export interface ReviewedContributionBinding {
  generationId: string;
  approvalDigest: string | null;
}

/**
 * Consent to one bundled component of an extension being installed (design
 * §18.7.3 "Extension components"): its kind and local id, and the approval
 * digest the update review showed, which the installed component must have.
 */
export interface ExtensionComponentConsent {
  kind: "hook" | "mcpServer";
  localId: string;
  approvalDigest: string | null;
}

/**
 * Converges the three plugin-owned projections on one verified generation.
 * Operations for one plugin are serialized; malformed candidates are prepared
 * entirely before the active generation changes. Hook/MCP authority remains
 * fail-closed until an exact trust record is supplied.
 */
export class PluginBundleLifecycle implements PluginBundleLifecycleHandler {
  readonly hookTrust: PluginHookTrustStore;
  readonly mcpTrust: PluginMcpTrustStore;
  private readonly coordinator = new PluginGenerationCoordinator<HostPluginGenerationState>();
  private readonly tails = new Map<string, Promise<void>>();
  private readonly lifecycleQueueContext = new AsyncLocalStorage<ReadonlyMap<string, LifecycleQueueToken>>();
  private readonly activeLifecycleQueueTokens = new WeakSet<LifecycleQueueToken>();
  private readonly retirementJournal: PluginRetirementJournal;
  private readonly healthJournal: PluginGenerationHealthJournal;
  private readonly retirementTasks = new Set<Promise<void>>();
  private readonly retirementProgress = new Map<string, Set<RetirementPhase>>();
  /** Component consents the install now running for a plugin carries, consumed by its next generation. */
  private readonly pendingConsents = new Map<string, readonly ExtensionComponentConsent[]>();

  constructor(private readonly deps: PluginBundleLifecycleDeps) {
    if (typeof deps.receiptCacheRoot !== "string" || deps.receiptCacheRoot.trim().length === 0) {
      throw new Error("PluginBundleLifecycle requires a non-empty receiptCacheRoot");
    }
    if (!deps.loopbackManager || typeof deps.loopbackManager.prepareGeneration !== "function") {
      throw new Error("PluginBundleLifecycle requires the loopback generation manager");
    }
    if (typeof deps.revokeOperationGeneration !== "function") {
      throw new Error("PluginBundleLifecycle requires exact operation-generation revocation");
    }
    if (!deps.personaPromptStore || typeof deps.personaPromptStore.preparePluginGeneration !== "function") {
      throw new Error("PluginBundleLifecycle requires the prompt generation store");
    }
    if (typeof deps.onContributionsUpdated !== "function") {
      throw new Error("PluginBundleLifecycle requires contribution update notification");
    }
    this.hookTrust = deps.hookTrust ?? new PluginHookTrustStore(
      resolve(deps.receiptCacheRoot, "plugin-contribution-trust", "hooks.json"),
    );
    this.mcpTrust = deps.mcpTrust ?? new PluginMcpTrustStore(
      resolve(deps.receiptCacheRoot, "plugin-contribution-trust", "mcp-servers.json"),
    );
    this.retirementJournal = new PluginRetirementJournal(pluginRetirementJournalPath(deps.receiptCacheRoot));
    this.healthJournal = new PluginGenerationHealthJournal(
      pluginGenerationHealthJournalPath(deps.receiptCacheRoot),
    );
  }

  activate(pluginId: string): Promise<void> {
    return this.serializeCommitted(pluginId, async () => {
      const committed = await this.activateNow(pluginId);
      return Object.freeze({ ...committed, result: undefined });
    }).then(() => undefined);
  }

  runInLifecycleQueue<T>(pluginId: string, operation: () => Promise<T>): Promise<T> {
    return this.serialize(pluginId, operation);
  }

  replaceRuntime(
    runtime: PluginRuntimeGenerationProjection,
    commitScope?: GenerationCommitScope,
  ): Promise<void> {
    return this.serializeCommitted(runtime.manifest.id, async () => {
      const committed = await this.replaceRuntimeNow(runtime, undefined, undefined, commitScope);
      return Object.freeze({ ...committed, result: undefined });
    }).then(() => undefined);
  }

  async replaceRuntimeWithCommit<T>(
    runtime: PluginRuntimeGenerationProjection,
    receiptRaw: string,
    durableCommit: () => Promise<T>,
    commitScope?: GenerationCommitScope,
  ): Promise<CommittedPluginGeneration<T>> {
    return this.serializeCommitted(
      runtime.manifest.id,
      () => this.replaceRuntimeNow(runtime, receiptRaw, durableCommit, commitScope),
    );
  }

  deactivate(pluginId: string): Promise<void> {
    return this.serializeCommitted(pluginId, async () => {
      const committed = await this.deactivateNow(pluginId);
      return Object.freeze({ ...committed, result: undefined });
    }).then(() => undefined);
  }

  async deactivateWithCommit<T>(
    pluginId: string,
    durableCommit: () => Promise<T>,
    commitScope?: GenerationCommitScope,
  ): Promise<CommittedPluginGeneration<T>> {
    return this.serializeCommitted(
      pluginId,
      () => this.deactivateNow(pluginId, durableCommit, commitScope),
    );
  }

  getActive(pluginId: string): ActivePluginGenerationSnapshot | undefined {
    const generation = this.coordinator.getActive(pluginId);
    return generation ? activeGenerationSnapshot(generation) : undefined;
  }

  listRoutineTemplates(): AgentPluginRoutineTemplate[] {
    return this.coordinator.listActive().flatMap(extensionRoutineTemplates);
  }

  isExactAdmitted(pluginId: string, generationId: string): boolean {
    return this.coordinator.isExactAdmitted(pluginId, generationId);
  }

  acquire(pluginId: string): Promise<PluginGenerationLease<HostPluginGenerationState>> {
    return this.coordinator.acquire(pluginId);
  }

  acquireExact(pluginId: string, generationId: string): Promise<PluginGenerationLease<HostPluginGenerationState>> {
    return this.coordinator.acquireExact(pluginId, generationId);
  }

  runWithLease<T>(
    lease: PluginGenerationLease<HostPluginGenerationState>,
    operation: () => Promise<T>,
  ): Promise<T> {
    return this.coordinator.runWithLease(lease, operation);
  }

  waitForRetirements(): Promise<void> {
    return this.waitForTrackedRetirements();
  }

  async recoverRetirements(): Promise<void> {
    for (const record of this.retirementJournal.list()) {
      const progressKey = `${record.pluginId}\0${record.generationId}`;
      if (this.retirementProgress.has(progressKey)) {
        throw new Error(
          `cannot recover in-process incomplete plugin retirement '${record.pluginId}:${record.generationId}'`,
        );
      }
      const active = this.coordinator.getActive(record.pluginId);
      if (active?.generationId === record.generationId) {
        throw new Error(`retirement journal targets active plugin generation '${record.pluginId}:${record.generationId}'`);
      }
      await removeRetainedPluginGeneration(
        this.deps.receiptCacheRoot,
        record.pluginId,
        record.generationId,
      );
      this.retirementJournal.complete(record.pluginId, record.generationId);
    }
    const cacheEntries = await readdir(this.deps.receiptCacheRoot, { withFileTypes: true }).catch((error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    });
    for (const entry of cacheEntries) {
      if (!entry.isDirectory()) continue;
      const generationEntries = await readdir(
        resolve(this.deps.receiptCacheRoot, entry.name, "generations"),
        { withFileTypes: true },
      ).catch((error) => {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      });
      const activeGenerationId = this.coordinator.getActive(entry.name)?.generationId;
      for (const generationEntry of generationEntries) {
        if (!generationEntry.isDirectory() || generationEntry.name === activeGenerationId) continue;
        if (!/^[a-f0-9]{64}$/.test(generationEntry.name)) continue;
        await removeRetainedPluginGeneration(this.deps.receiptCacheRoot, entry.name, generationEntry.name);
      }
    }
  }

  /**
   * Run `install` with consents to the bundled components of the generation
   * it installs (design §18.7.3): that generation approves each named
   * component whose approval digest equals the consent's, and a consent
   * that matches no component of it fails the install.
   */
  async withComponentConsents<T>(pluginId: string, consents: readonly ExtensionComponentConsent[], install: () => Promise<T>): Promise<T> {
    if (consents.length === 0) return install();
    if (this.pendingConsents.has(pluginId)) throw new Error(`plugin '${pluginId}' already has an install with component consents in progress`);
    this.pendingConsents.set(pluginId, consents);
    try {
      return await install();
    } finally {
      this.pendingConsents.delete(pluginId);
    }
  }

  /** Approve an installed hook as reviewed: `binding` must name the active generation and digest (design §18.7.5). */
  async approveHook(pluginId: string, localId: string, binding: ReviewedContributionBinding): Promise<void> {
    await this.updateHookTrust(pluginId, localId, binding);
  }

  async revokeHook(pluginId: string, localId: string): Promise<void> {
    await this.updateHookTrust(pluginId, localId, null);
  }

  /** Approve an installed MCP server as reviewed: `binding` must name the active generation and digest (design §18.7.5). */
  async approveMcpServer(pluginId: string, localId: string, binding: ReviewedContributionBinding): Promise<void> {
    await this.updateMcpTrust(pluginId, localId, binding);
  }

  async revokeMcpServer(pluginId: string, localId: string): Promise<void> {
    await this.updateMcpTrust(pluginId, localId, null);
  }

  listContributionTrust(pluginId?: string): PluginContributionTrustRow[] {
    const generations = pluginId
      ? [this.coordinator.getActive(pluginId)].filter((entry): entry is ActivePluginGeneration<HostPluginGenerationState> => Boolean(entry))
      : [...this.coordinator.listActive()];
    return generations.flatMap((generation) => [
      ...generation.state.hooks.map((projection): PluginContributionTrustRow => ({
        kind: "hook",
        ...trustRowOwner(projection.owner),
        approvalDigest: projection.approvalDigest,
        status: this.hookTrust.isApproved(projection) ? "approved" : "approval_required",
      })),
      ...generation.state.mcpServers.map((projection): PluginContributionTrustRow => ({
        kind: "mcpServer",
        ...trustRowOwner(projection.owner),
        approvalDigest: projection.approvalDigest,
        status: this.mcpTrust.isApproved(projection) ? "approved" : "approval_required",
      })),
    ]);
  }

  /**
   * The approval state of each bundled component of the active generation
   * (§18.7.2): whether it is approved, and the approval digest its record
   * holds (null for an approval from an earlier Ave version that could not
   * be matched to its bytes, which does not carry).
   */
  componentApprovals(pluginId: string): Array<{ kind: "hook" | "mcpServer"; localId: string; approvalDigest: string | null; approved: boolean; recordDigest: string | null }> {
    const generation = this.coordinator.getActive(pluginId);
    if (!generation) return [];
    return [
      ...generation.state.hooks.map((projection) => {
        const record = this.hookTrust.record(projection);
        return { kind: "hook" as const, localId: projection.owner.localId, approvalDigest: projection.approvalDigest, approved: record !== undefined, recordDigest: record?.approvalDigest ?? null };
      }),
      ...generation.state.mcpServers.map((projection) => {
        const record = this.mcpTrust.record(projection);
        return { kind: "mcpServer" as const, localId: projection.owner.localId, approvalDigest: projection.approvalDigest, approved: record !== undefined, recordDigest: record?.approvalDigest ?? null };
      }),
    ];
  }

  /**
   * `binding` approves, bound to the reviewed generation and digest; null
   * revokes, which only narrows trust and needs no binding. The binding is
   * checked here, under the serialization a new generation's publication
   * takes, so a generation that replaced the reviewed one is never approved.
   */
  private async updateHookTrust(pluginId: string, localId: string, binding: ReviewedContributionBinding | null): Promise<void> {
    const approve = binding !== null;
    await this.serialize(pluginId, async () => {
      const generation = this.requireActive(pluginId);
      const projection = generation.state.hooks.find((entry) => entry.owner.localId === localId);
      if (!projection) throw new Error(`plugin Hook '${pluginId}:${localId}' is not active`);
      if (approve) assertReviewedBinding(pluginId, localId, projection, binding);
      const wasApproved = this.hookTrust.isApproved(projection);
      if (approve) this.hookTrust.approve(projection);
      else this.hookTrust.revoke(projection);
      try {
        const preparedHooks = this.deps.hookManager.preparePluginGeneration(
          generation.state.hooks,
          this.hookTrust,
          { pluginId, generationId: generation.generationId },
        );
        await this.coordinator.quiesce(
          pluginId,
          generation.generationId,
          async () => undefined,
          () => preparedHooks.publish(),
        );
      } catch (error) {
        if (wasApproved) this.hookTrust.approve(projection);
        else this.hookTrust.revoke(projection);
        throw error;
      }
    });
  }

  /** As {@link updateHookTrust}, for a bundled MCP server. */
  private async updateMcpTrust(pluginId: string, localId: string, binding: ReviewedContributionBinding | null): Promise<void> {
    const approve = binding !== null;
    await this.serialize(pluginId, async () => {
      const generation = this.requireActive(pluginId);
      const projection = generation.state.mcpServers.find((entry) => entry.owner.localId === localId);
      if (!projection) throw new Error(`plugin MCP '${pluginId}:${localId}' is not active`);
      if (approve) assertReviewedBinding(pluginId, localId, projection, binding);
      const wasApproved = this.mcpTrust.isApproved(projection);
      if (approve) this.mcpTrust.approve(projection);
      else this.mcpTrust.revoke(projection);
      let prepared: PreparedBundledMcpGeneration | undefined;
      try {
        const candidate = await this.deps.mcpManager.prepareBundledGeneration(
          { pluginId, generationId: generation.generationId },
          generation.state.mcpServers,
          this.mcpTrust,
        );
        prepared = candidate;
        await this.coordinator.quiesce(
          pluginId,
          generation.generationId,
          async () => undefined,
          () => this.deps.mcpManager.publishBundledGeneration(candidate),
        );
      } catch (error) {
        if (prepared?.published) {
          this.recordPostCommitFault(
            pluginId,
            generation.generationId,
            "mcp-publication",
            error,
          );
          this.trackPublishedMcpRetirement(pluginId, generation.generationId, prepared);
          return;
        }
        if (wasApproved) this.mcpTrust.approve(projection);
        else this.mcpTrust.revoke(projection);
        if (prepared) await this.deps.mcpManager.discardBundledGeneration(prepared);
        throw error;
      }
      if (!prepared) throw new Error("bundled MCP preparation completed without a candidate");
      this.trackPublishedMcpRetirement(pluginId, generation.generationId, prepared);
    });
  }

  /**
   * Approve, for `candidate`, each component the install running for this
   * plugin consented to (design §18.7.3). The candidate's component must have
   * the consent's approval digest: the review approved those bytes.
   */
  private approveConsented(
    pluginId: string,
    candidate: ActivePluginGeneration<HostPluginGenerationState>,
    provisional: Array<() => void>,
  ): void {
    for (const consent of this.pendingConsents.get(pluginId) ?? []) {
      const trust = consent.kind === "hook" ? this.hookTrust : this.mcpTrust;
      const projections: readonly (PreparedPluginHookProjection | PreparedPluginMcpProjection)[] =
        consent.kind === "hook" ? candidate.state.hooks : candidate.state.mcpServers;
      const projection = projections.find((item) => item.owner.localId === consent.localId);
      if (!projection || projection.approvalDigest !== consent.approvalDigest) {
        throw new Error(`plugin '${pluginId}' component consent does not match the installed ${consent.kind} ${consent.localId}`);
      }
      if (trust.isApproved(projection as never)) continue;
      trust.approve(projection as never);
      provisional.push(() => trust.revoke(projection as never));
    }
  }

  private requireActive(pluginId: string): ActivePluginGeneration<HostPluginGenerationState> {
    const generation = this.coordinator.getActive(pluginId);
    if (!generation) throw new Error(`plugin '${pluginId}' has no active bundle generation`);
    return generation;
  }

  private serializeCommitted<T>(
    pluginId: string,
    operation: () => Promise<CommittedPluginGeneration<T>>,
  ): Promise<CommittedPluginGeneration<T>> {
    return this.serialize(pluginId, async () => {
      const token = this.lifecycleQueueContext.getStore()?.get(pluginId);
      if (!token || !this.activeLifecycleQueueTokens.has(token)) {
        throw new Error(`plugin '${pluginId}' committed outside its lifecycle queue`);
      }
      try {
        const committed = await operation();
        await this.holdCommittedCompletion(token, committed);
        return committed;
      } catch (error) {
        if (isCommittedPluginGenerationPublicationError(error) && error.committed) {
          try {
            await this.holdCommittedCompletion(token, error.committed);
          } catch {
            // The typed publication failure remains the primary post-linearization
            // outcome. Its committed completion retains the retirement failure
            // for storage cleanup/recovery ownership without disguising the
            // original synchronous publication cause.
          }
        }
        throw error;
      }
    });
  }

  private async holdCommittedCompletion(
    token: LifecycleQueueToken,
    committed: CommittedPluginGeneration<unknown>,
  ): Promise<void> {
    if (committed.retirementDeferred) token.completions.push(committed.completion);
    else await committed.completion;
  }

  private serialize<T>(pluginId: string, operation: () => Promise<T>): Promise<T> {
    const current = this.lifecycleQueueContext.getStore();
    const currentToken = current?.get(pluginId);
    if (currentToken && this.activeLifecycleQueueTokens.has(currentToken)) return operation();
    const admittedGenerationId = this.coordinator.currentAdmissionGenerationId(pluginId);
    if (
      this.tails.has(pluginId) &&
      admittedGenerationId &&
      this.coordinator.getActive(pluginId)?.generationId !== admittedGenerationId
    ) {
      return Promise.reject(new Error(
        `plugin '${pluginId}' cannot start another lifecycle mutation before its admitted transition completes`,
      ));
    }

    const prior = this.tails.get(pluginId) ?? Promise.resolve();
    let resolveResult!: (result: T) => void;
    let rejectResult!: (error: unknown) => void;
    const result = new Promise<T>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const next = prior.then(async () => {
      const token: LifecycleQueueToken = { completions: [] };
      const inherited = new Map(this.lifecycleQueueContext.getStore() ?? current ?? []);
      inherited.set(pluginId, token);
      this.activeLifecycleQueueTokens.add(token);
      let operationError: unknown;
      let operationFailed = false;
      try {
        try {
          const value = await this.lifecycleQueueContext.run(inherited, operation);
          resolveResult(value);
        } catch (error) {
          operationFailed = true;
          operationError = error;
          rejectResult(error);
        }
        const completionResults = await Promise.allSettled(token.completions);
        const failedCompletion = completionResults.find(
          (completion): completion is PromiseRejectedResult => completion.status === "rejected",
        );
        if (failedCompletion && !operationFailed) throw failedCompletion.reason;
        if (operationFailed) throw operationError;
      } finally {
        this.activeLifecycleQueueTokens.delete(token);
      }
    });
    const tail = next.then(() => undefined, () => undefined);
    this.tails.set(pluginId, tail);
    void tail.finally(() => {
      if (this.tails.get(pluginId) === tail) this.tails.delete(pluginId);
    });
    return result;
  }

  private async activateNow(pluginId: string): Promise<CommittedPluginGeneration<void>> {
    const runtime = this.deps.pluginRuntime.getRuntimeGenerationProjection(pluginId);
    if (!runtime) throw new Error(`plugin '${pluginId}' is not loaded`);
    return this.replaceRuntimeNow(runtime);
  }

  private async replaceRuntimeNow<T = void>(
    runtime: PluginRuntimeGenerationProjection,
    receiptRawOverride?: string,
    durableCommit?: () => Promise<T>,
    commitScope?: GenerationCommitScope,
  ): Promise<CommittedPluginGeneration<T>> {
    const manifest = runtime.manifest;
    const pluginRoot = runtime.pluginRoot;
    const pluginId = manifest.id;
    const manifestRaw = await readFile(resolve(pluginRoot, "plugin.json"), "utf8");
    const receiptRaw = receiptRawOverride
      ?? await readFile(
        installReceiptPath(this.deps.receiptCacheRoot, runtime.installId ?? pluginId),
        "utf8",
      );
    const artifactGenerationId = pluginArtifactGenerationId(manifestRaw, receiptRaw);
    const generationId = createHash("sha256")
      .update(artifactGenerationId)
      .update("\0")
      .update(runtime.activationId)
      .digest("hex");
    const predecessorBeforePreparation = this.coordinator.getActive(pluginId);
    const activeBeforePreparation =
      predecessorBeforePreparation?.generationId === generationId;
    const payloadRoot = await materializePluginGenerationRoot(
      pluginRoot,
      this.deps.receiptCacheRoot,
      pluginId,
      generationId,
      receiptRaw,
      runtime.installId ?? pluginId,
    );
    // Approvals this preparation writes for the candidate (carried forward, or
    // consented by the install): revoked if it is never published (§18.7.3).
    const provisional: Array<() => void> = [];
    const revokeProvisional = () => {
      for (const revoke of provisional.splice(0).reverse()) revoke();
    };
    let carriedHooks: ReturnType<typeof carryApprovals<PreparedPluginHookProjection>> = [];
    let carriedMcp: ReturnType<typeof carryApprovals<PreparedPluginMcpProjection>> = [];
    const prepared = await (async () => {
      let candidate:
        | ActivePluginGeneration<HostPluginGenerationState>
        | undefined;
      try {
        const contributions =
          await materializePluginContributions(payloadRoot, manifest);
        // Each bundled component's approval digest, read from the retained bytes (§18.7.3).
        const digests = extensionComponentDigests(JSON.parse(manifestRaw) as unknown, await readPayloadFiles(payloadRoot));
        const digestsOf = (kind: "hook" | "mcpServer") =>
          new Map(digests.filter((item) => item.kind === kind).map((item) => [item.localId, item.approvalDigest]));
        const identity = {
          pluginId,
          pluginVersion: manifest.version,
          artifactGenerationId,
          generationId,
          manifestSha256:
            sha256Hex(manifestRaw),
          receiptSha256:
            sha256Hex(receiptRaw),
          contributions,
        };
        const preparationView: ActivePluginGeneration = {
          ...identity,
          state: undefined,
        };
        candidate = {
          ...identity,
          state: Object.freeze({
            payloadRoot,
            runtime,
            hooks: await preparePluginHookGeneration(
              preparationView,
              payloadRoot,
              resolve(runtime.pluginRoot, "data"),
              digestsOf("hook"),
            ),
            mcpServers: await preparePluginMcpGeneration(
              preparationView,
              payloadRoot,
              digestsOf("mcpServer"),
            ),
          }),
        };
        const prepared = candidate;
        // An approval of exactly this generation that predates approval digests gets the digest of these, its running bytes.
        for (const projection of prepared.state.hooks) this.hookTrust.recordDigest(projection);
        for (const projection of prepared.state.mcpServers) this.mcpTrust.recordDigest(projection);
        // Approval carry-forward: an unchanged component keeps the approval it had in the active generation.
        if (predecessorBeforePreparation && predecessorBeforePreparation.artifactGenerationId !== prepared.artifactGenerationId) {
          carriedHooks = carryApprovals(this.hookTrust, predecessorBeforePreparation.state.hooks, prepared.state.hooks);
          for (const { to } of carriedHooks) provisional.push(() => this.hookTrust.revoke(to));
          carriedMcp = carryApprovals(this.mcpTrust, predecessorBeforePreparation.state.mcpServers, prepared.state.mcpServers);
          for (const { to } of carriedMcp) provisional.push(() => this.mcpTrust.revoke(to));
        }
        this.approveConsented(pluginId, prepared, provisional);
        // Validate cross-file template IDs before committing a generation.
        extensionRoutineTemplates(candidate);
        candidate.state.runtime.hostEffects?.bindGeneration(
          this,
          candidate.generationId,
        );
        const predecessorMcpServerIds =
          this.deps.mcpManager.bundledServerIdsForPlugin(pluginId);
        const preparedRuntime =
          this.deps.pluginRuntime.prepareRuntimeGeneration(
            candidate.state.runtime,
            predecessorBeforePreparation?.generationId,
          );
        const preparedSkills =
          this.deps.skillStore.preparePluginGeneration(candidate);
        const preparedPrompts = this.deps.personaPromptStore.preparePluginGeneration(candidate);
        const preparedHooks =
          this.deps.hookManager.preparePluginGeneration(
            candidate.state.hooks,
            this.hookTrust,
            { pluginId, generationId: candidate.generationId },
          );
        // ToolRegistry reservation is prepared last so any earlier preparation
        // failure cannot strand the global publication reservation.
        const preparedLoopback =
          await this.deps.loopbackManager.prepareGeneration(
            candidate.state.runtime.manifest,
            candidate.generationId,
            predecessorMcpServerIds,
          );
        return {
          candidate,
          preparedRuntime,
          preparedSkills,
          preparedPrompts,
          preparedHooks,
          preparedLoopback,
        };
      } catch (error) {
        revokeProvisional();
        candidate?.state.runtime.hostEffects?.discard();
        if (!activeBeforePreparation) {
          try {
            await removeRetainedPluginGeneration(
              this.deps.receiptCacheRoot,
              pluginId,
              generationId,
            );
          } catch (cleanupError) {
            throw new AggregateError(
              [error, cleanupError],
              `plugin generation preparation and retained-root cleanup both failed: ${pluginId}:${generationId}`,
            );
          }
        }
        throw error;
      }
    })();
    const {
      candidate,
      preparedRuntime,
      preparedSkills,
      preparedPrompts,
      preparedHooks,
      preparedLoopback,
    } = prepared;
    const predecessor = this.coordinator.getActive(pluginId);

    let published;
    let result!: T;
    try {
      const publish = () => {
        // Under this plugin's serialization, before the active generation changes: a carried
        // approval holds only while its source does and the generation it came from is still active.
        if (carriedHooks.length + carriedMcp.length > 0 && this.coordinator.getActive(pluginId)?.generationId !== predecessorBeforePreparation?.generationId) {
          throw new Error(`plugin '${pluginId}' changed generation while its update was prepared`);
        }
        assertCarriedApprovalsHold(this.hookTrust, carriedHooks);
        assertCarriedApprovalsHold(this.mcpTrust, carriedMcp);
        return this.coordinator.commit(
        candidate,
        async () => {
          if (durableCommit) result = await durableCommit();
        },
        (predecessor) => this.retireWithRetries(predecessor),
        pluginId,
        () => {
          this.deps.loopbackManager.publishGeneration(preparedLoopback);
          preparedRuntime.publish();
          preparedSkills.publish();
          preparedPrompts.publish();
          preparedHooks.publish();
        },
      );
      };
      published = commitScope ? await commitScope(publish) : await publish();
      this.deps.onContributionsUpdated();
    } catch (error) {
      const activeGenerationId = this.coordinator.getActive(pluginId)?.generationId;
      if (activeGenerationId === candidate.generationId) {
        if (isCommittedPluginGenerationPublicationError(error)) {
          const retirement = this.trackRetirement(error.transition.retired);
          const committed = Object.freeze({
            result,
            retirement,
            completion: retirement,
            retirementDeferred: Boolean(
              predecessor &&
              this.coordinator.isExactAdmitted(pluginId, predecessor.generationId),
            ),
          });
          const committedError = error.withCommitted(committed);
          this.recordPostCommitFault(
            pluginId,
            candidate.generationId,
            "runtime-post-publish",
            committedError,
          );
          throw committedError;
        }
        this.recordPostCommitFault(
          pluginId,
          candidate.generationId,
          "runtime-post-publish",
          error,
        );
        throw error;
      }
      revokeProvisional();
      candidate.state.runtime.hostEffects?.discard();
      const cleanupErrors: unknown[] = [];
      try {
        await this.deps.loopbackManager.discardGeneration(preparedLoopback);
      } catch (cleanupError) {
        cleanupErrors.push(cleanupError);
      }
      if (
        !activeBeforePreparation
        && activeGenerationId !== candidate.generationId
      ) {
        try {
          await removeRetainedPluginGeneration(
            this.deps.receiptCacheRoot,
            pluginId,
            candidate.generationId,
          );
        } catch (cleanupError) {
          cleanupErrors.push(cleanupError);
        }
      }
      if (cleanupErrors.length > 0) {
        throw new AggregateError(
          [error, ...cleanupErrors],
          `plugin generation commit and candidate cleanup failed: ${pluginId}:${candidate.generationId}`,
        );
      }
      throw error;
    }
    const hasPredecessor = Boolean(
      predecessor && predecessor.generationId !== candidate.generationId,
    );
    const retirement = hasPredecessor ? published.retired : Promise.resolve();
    const finalizePostCommit = async (): Promise<void> => {
      let dispatchReady = true;
      if (hasPredecessor) {
        try {
          // A replacement's onPublished hook may start write-capable workers.
          // Do not overlap those effects with the predecessor: its graceful
          // stop must release sockets, sandbox markers, and shared durable state
          // before the new generation begins externally observable startup.
          await retirement;
        } catch (error) {
          dispatchReady = false;
          published.markDispatchUnavailable(error);
          this.recordPostCommitFault(
            pluginId,
            candidate.generationId,
            "runtime-post-publish",
            new AggregateError(
              [error],
              `plugin '${pluginId}' post-publish startup blocked by predecessor retirement`,
            ),
          );
        }
      }
      if (dispatchReady) {
        try {
          // Only host-owned generation-fence faults reach this catch. A plugin
          // whose own onPublished() failed is published, dispatchable, and
          // recorded as degraded by the runtime — it does not arrive here, so
          // the health journal's "internal post-commit fault" stays truthful.
          await this.coordinator.runPostCommitWithGeneration(
            pluginId,
            candidate.generationId,
            () => this.deps.pluginRuntime.postPublishRuntimeGeneration(candidate.state.runtime),
          );
        } catch (error) {
          dispatchReady = false;
          published.markDispatchUnavailable(error);
          this.recordPostCommitFault(pluginId, candidate.generationId, "runtime-post-publish", error);
        }
      }
      try {
        this.deps.loopbackManager.postPublishGeneration(preparedLoopback);
      } catch (error) {
        this.recordPostCommitFault(pluginId, candidate.generationId, "loopback-post-publish", error);
      }
      try {
        // Provider/connect failures are already represented by McpManager as a
        // typed same-generation degraded record. Reaching this catch is an
        // internal publication/contract fault and receives durable health state.
        await this.projectApprovedMcp(candidate);
      } catch (error) {
        this.recordPostCommitFault(pluginId, candidate.generationId, "mcp-publication", error);
      }
      if (dispatchReady) {
        try {
          await published.markDispatchReady();
        } catch (error) {
          published.markDispatchUnavailable(error);
          this.recordPostCommitFault(pluginId, candidate.generationId, "runtime-post-publish", error);
        }
      }
    };
    const completion = this.trackRetirement(finalizePostCommit());
    const retirementDeferred = Boolean(
      predecessor &&
      this.coordinator.isExactAdmitted(pluginId, predecessor.generationId),
    );
    return Object.freeze({ result, retirement, completion, retirementDeferred });
  }

  private async deactivateNow<T = void>(
    pluginId: string,
    durableCommit?: () => Promise<T>,
    commitScope?: GenerationCommitScope,
  ): Promise<CommittedPluginGeneration<T>> {
    let result!: T;
    const active = this.coordinator.getActive(pluginId);
    const bundledServerIds = this.deps.mcpManager.bundledServerIdsForPlugin(pluginId);
    if (!active) {
      if (this.deps.pluginRuntime.getRuntimeGenerationProjection(pluginId) || bundledServerIds.length > 0) {
        throw new Error(`plugin '${pluginId}' has live projections without an active bundle generation`);
      }
      if (durableCommit) result = await durableCommit();
      const completion = Promise.resolve();
      return Object.freeze({
        result,
        retirement: completion,
        completion,
        retirementDeferred: false,
      });
    }
    const preparedLoopback = this.deps.loopbackManager.prepareRemoval(
      pluginId,
      active.generationId,
      bundledServerIds,
    );
    const preparedRuntime = this.deps.pluginRuntime.prepareRuntimeRemoval(
      pluginId,
      active.generationId,
    );
    const preparedSkills = this.deps.skillStore.preparePluginRemoval(pluginId, active.generationId);
    const preparedPrompts = this.deps.personaPromptStore.preparePluginRemoval(pluginId);
    const preparedHooks = this.deps.hookManager.preparePluginGeneration(
      [],
      this.hookTrust,
      { pluginId, generationId: active.generationId },
    );
    let published;
    try {
      const publish = () => this.coordinator.commit(
        undefined,
        async () => {
          if (durableCommit) result = await durableCommit();
        },
        (predecessor) => this.retireWithRetries(predecessor),
        pluginId,
        () => {
          this.deps.loopbackManager.publishGeneration(preparedLoopback);
          preparedRuntime.publish();
          preparedSkills.publish();
          preparedPrompts.publish();
          preparedHooks.publish();
        },
      );
      published = commitScope ? await commitScope(publish) : await publish();
      this.deps.onContributionsUpdated();
    } catch (error) {
      if (isCommittedPluginGenerationPublicationError(error)) {
        const retirement = this.trackRetirement(error.transition.retired);
        const committed = Object.freeze({
          result,
          retirement,
          completion: retirement,
          retirementDeferred: this.coordinator.isExactAdmitted(
            pluginId,
            active.generationId,
          ),
        });
        const committedError = error.withCommitted(committed);
        this.recordPostCommitFault(
          pluginId,
          active.generationId,
          "runtime-post-publish",
          committedError,
        );
        throw committedError;
      }
      await this.deps.loopbackManager.discardGeneration(preparedLoopback);
      throw error;
    }
    this.deps.loopbackManager.postPublishGeneration(preparedLoopback);
    const retirement = this.trackRetirement(published.retired);
    const retirementDeferred = this.coordinator.isExactAdmitted(
      pluginId,
      active.generationId,
    );
    return Object.freeze({
      result,
      retirement,
      completion: retirement,
      retirementDeferred,
    });
  }

  /**
   * External MCP work is deliberately post-pointer. Exact trust is evaluated
   * only after the immutable generation is active; connection/discovery failure
   * leaves that generation active with a typed zero-tool degraded projection.
   */
  private async projectApprovedMcp(
    generation: ActivePluginGeneration<HostPluginGenerationState>,
  ): Promise<void> {
    let prepared: Awaited<ReturnType<McpManager["prepareBundledGeneration"]>> | undefined;
    try {
      prepared = await this.deps.mcpManager.prepareBundledGeneration(
        { pluginId: generation.pluginId, generationId: generation.generationId },
        generation.state.mcpServers,
        this.mcpTrust,
      );
      const publication = prepared;
      await this.coordinator.quiesce(
        generation.pluginId,
        generation.generationId,
        async () => undefined,
        () => this.deps.mcpManager.publishBundledGeneration(publication),
      );
      await this.deps.mcpManager.retirePublishedMcpReplacement(publication);
    } catch (error) {
      if (prepared) await this.deps.mcpManager.discardBundledGeneration(prepared);
      // Expected provider/connect failures are represented as typed degraded
      // records by prepareBundledGeneration. Everything reaching this catch is
      // an internal contract or publication failure and must remain visible.
      throw error;
    }
  }

  private async retire(generation: ActivePluginGeneration<HostPluginGenerationState>): Promise<void> {
    this.retirementJournal.record(generation.pluginId, generation.generationId);
    const progressKey = `${generation.pluginId}\0${generation.generationId}`;
    const completed = this.retirementProgress.get(progressKey) ?? new Set<RetirementPhase>();
    this.retirementProgress.set(progressKey, completed);
    const errors: Error[] = [];
    const runPhase = async (
      phase: RetirementPhase,
      operation: () => void | Promise<void>,
    ): Promise<void> => {
      if (completed.has(phase)) return;
      try {
        await operation();
        // Update the in-process checkpoint first. If durable journal writing
        // itself fails, a retry must still not rerun a completed non-idempotent
        // teardown phase such as plugin stop().
        completed.add(phase);
        this.retirementJournal.completePhase(
          generation.pluginId,
          generation.generationId,
          phase,
        );
      } catch (error) {
        errors.push(error instanceof Error ? error : new Error(String(error)));
      }
    };

    await runPhase("operation-authority", () => {
      this.deps.revokeOperationGeneration(generation.pluginId, generation.generationId);
    });
    await runPhase("skills", () => {
      this.deps.skillStore.removePluginGeneration(generation.pluginId, generation.generationId);
    });
    await runPhase("hooks", () => {
      this.deps.hookManager.removePluginGeneration(generation.pluginId, generation.generationId);
    });
    // Current-turn Skill overlays own generation leases. They release at the
    // turn boundary, so coordinator drain itself guarantees the body remains
    // available for every subsequent assistant round of the admitted turn.
    await runPhase("mcp", () =>
      this.deps.mcpManager.disconnectBundledGeneration(
        generation.pluginId,
        generation.generationId,
      ));
    await runPhase("loopback", () =>
      this.deps.loopbackManager.retireGeneration(
        generation.pluginId,
        generation.generationId,
      ));
    for (const step of this.deps.pluginRuntime.prepareRuntimeRetirement(
      generation.state.runtime,
    )) {
      await runPhase(step.phase, step.run);
    }
    if (errors.length > 0) {
      const aggregate = new AggregateError(errors, `plugin '${generation.pluginId}' generation retirement failed`);
      this.retirementJournal.record(generation.pluginId, generation.generationId, aggregate);
      throw aggregate;
    }
    await runPhase("payload", () =>
      removeRetainedPluginGeneration(
        this.deps.receiptCacheRoot,
        generation.pluginId,
        generation.generationId,
      ));
    await runPhase("health", () => {
      this.healthJournal.clearGeneration(generation.pluginId, generation.generationId);
    });
    if (errors.length > 0) {
      const aggregate = new AggregateError(errors, `plugin '${generation.pluginId}' generation retirement failed`);
      this.retirementJournal.record(generation.pluginId, generation.generationId, aggregate);
      throw aggregate;
    }
    this.retirementJournal.complete(generation.pluginId, generation.generationId);
    this.retirementProgress.delete(progressKey);
  }

  private recordPostCommitFault(
    pluginId: string,
    generationId: string,
    phase: PluginGenerationHealthFault["phase"],
    error: unknown,
  ): void {
    try {
      this.healthJournal.record(pluginId, generationId, phase, error);
    } catch (journalError) {
      const journalFault = opaqueHealthError(journalError);
      log.error(
        `plugin generation health journal failed (${pluginId}:${generationId}:${phase}) error=%s code=%s`,
        journalFault.errorName,
        journalFault.errorCode ?? "none",
      );
      return;
    }
    const fault = opaqueHealthError(error);
    log.error(
      `plugin generation internal post-commit fault (${pluginId}:${generationId}:${phase}) error=%s code=%s`,
      fault.errorName,
      fault.errorCode ?? "none",
    );
  }

  private async retireWithRetries(
    generation: ActivePluginGeneration<HostPluginGenerationState>,
  ): Promise<void> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        await this.retire(generation);
        return;
      } catch (error) {
        log.error(
          `plugin generation retirement failed (${generation.pluginId}:${generation.generationId}, attempt ${attempt}): %s`,
          errorMessage(error),
        );
        if (attempt >= MAX_RETIREMENT_ATTEMPTS) throw error;
        await sleep(attempt * 100);
      }
    }
  }

  private trackRetirement(task: Promise<void>): Promise<void> {
    this.retirementTasks.add(task);
    void task.finally(() => this.retirementTasks.delete(task)).catch(() => undefined);
    return task;
  }

  private trackPublishedMcpRetirement(
    pluginId: string,
    generationId: string,
    prepared: Parameters<McpManager["retirePublishedMcpReplacement"]>[0],
  ): void {
    const task = (async () => {
      for (let attempt = 1; attempt <= MAX_RETIREMENT_ATTEMPTS; attempt += 1) {
        try {
          await this.deps.mcpManager.retirePublishedMcpReplacement(prepared);
          return;
        } catch (error) {
          if (attempt === MAX_RETIREMENT_ATTEMPTS) {
            this.recordPostCommitFault(
              pluginId,
              generationId,
              "mcp-predecessor-retirement",
              error,
            );
            return;
          }
          await sleep(attempt * 100);
        }
      }
    })();
    this.retirementTasks.add(task);
    void task.finally(() => this.retirementTasks.delete(task)).catch(() => undefined);
  }

  private async waitForTrackedRetirements(): Promise<void> {
    while (this.retirementTasks.size > 0) {
      await Promise.all([...this.retirementTasks]);
    }
  }
}

/** A trust row's owner fields: the durable identity, without the activation id. */
function trustRowOwner(owner: { pluginId: string; pluginVersion: string; generationId: string; localId: string; fingerprint: string }) {
  return {
    pluginId: owner.pluginId,
    pluginVersion: owner.pluginVersion,
    generationId: owner.generationId,
    localId: owner.localId,
    fingerprint: owner.fingerprint,
  };
}

/**
 * The approval binding of design §18.7.5: the active projection's artifact
 * generation id (`owner.generationId`, never the activation-bound
 * coordinator id) and its approval digest must be the reviewed ones.
 */
function assertReviewedBinding(
  pluginId: string,
  localId: string,
  projection: { owner: { generationId: string }; approvalDigest: string | null },
  binding: ReviewedContributionBinding | null | undefined,
): void {
  if (binding === null || binding === undefined) throw new Error(`approving ${pluginId}:${localId} requires the reviewed generation and approval digest`);
  if (projection.owner.generationId !== binding.generationId || projection.approvalDigest !== binding.approvalDigest) {
    throw new ContributionTrustReviewStaleError(pluginId, localId);
  }
}
