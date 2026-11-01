// Only TOFU-trusted entries enter the registry; untrusted config contributes nothing. Hook allows never override upstream denies, and mutation is unsupported (docs/architecture/permission-policy-design.md; docs/architecture/hook-runtime-expansion-design.md).
import { HookMatcherError, type DiscoveredHook } from "./hook-discovery.js";
import { lifecycleMatcherSubject } from "./hook-contract.js";
import {
  buildHookRegistry,
  filterRegistryByEventAndSubject,
  filterRegistryByEventAndTool,
  type HookRegistryEntry,
} from "./hook-registry.js";
import type { HookConfigEntry } from "./hook-config.js";
import {
  runHookChain,
  runnableFromDiscovered,
  type RunnableHook,
  type RunOneHookOptions,
} from "./script-hook-runner.js";
import {
  isBlockingLifecycleEvent,
  USER_PROMPT_SUBMIT_EVENT,
  type HookDispatchPayload,
  type HookTrustOrigin,
  type LifecycleEventPayload,
  type LifecycleHookEvent,
  type LifecycleHookStdin,
  type ScriptHookInvocationResult,
  type ScriptHookStdin,
  type ScriptHookType,
  type UserPromptSubmitPayload,
} from "./script-hook-types.js";
import { redactForLLM } from "../audit/dlp-filter.js";
import { createLogger } from "../lib/logger.js";
import { areExternalTurnHooksAllowed } from "../shared/turn-extension-policy.js";
import type { PluginHookTrustStore, PreparedPluginHookProjection } from "./plugin-hook-projection.js";
import type { PluginRuntimeGenerationAccess } from "../plugins/plugin-host-generation.js";
import { errorMessage } from "../shared/error-message.js";
import type { HookCommandAuthorizer } from "./hook-command-policy.js";

const log = createLogger("script-hook-manager");

function externalHooksSuppressed(): HookDispatchResult {
  return {
    decision: "allow",
    reason: "external hooks disabled for this turn",
    results: [],
  };
}

export interface HookDispatchResult {
  decision: "allow" | "deny";
  reason: string;
  results: ScriptHookInvocationResult[];
}

export interface PreparedPluginHookGenerationPublication {
  readonly pluginId: string;
  readonly generationId: string;
  publish(): void;
}

export class ScriptHookManager {
  private registry: HookRegistryEntry[] = [];
  private matcherGuards: readonly HookRegistryEntry[] = [];
  private pluginRegistries = new Map<string, readonly HookRegistryEntry[]>();
  private generation = 0;
  private generationAccess: PluginRuntimeGenerationAccess | undefined;
  private readonly generationLeaseSources = new Map<string, (pluginId: string, activationId: string) => Promise<{ release(): void }>>();
  private commandAuthorizer: HookCommandAuthorizer | undefined;

  setCommandAuthorizer(authorizer: HookCommandAuthorizer): void {
    this.commandAuthorizer = authorizer;
    this.generation += 1;
  }

  private executionOptions(options?: RunOneHookOptions): RunOneHookOptions {
    return { ...options, ...(this.commandAuthorizer ? { authorizeCommand: this.commandAuthorizer } : {}) };
  }

  setPluginGenerationAccess(access: PluginRuntimeGenerationAccess): void {
    this.generationAccess = access;
  }

  registerGenerationLeaseSource(prefix: string, acquireExact: (pluginId: string, activationId: string) => Promise<{ release(): void }>): void {
    if (!prefix || this.generationLeaseSources.has(prefix)) throw new Error("hook generation lease source is already registered or invalid");
    this.generationLeaseSources.set(prefix, acquireExact);
  }

  // Legacy adapter for callers without config entries.
  setTrustedHooks(hooks: DiscoveredHook[]): void {
    this.setTrustedRegistry(hooks, []);
  }

  // Callers must supply only trusted entries after quarantine resolves; the manager does not revalidate trust.
  setTrustedRegistry(shHooks: DiscoveredHook[], configEntries: HookConfigEntry[]): void {
    this.registry = buildHookRegistry(shHooks, configEntries);
    this.generation += 1;
  }

  setMatcherGuards(guards: readonly HookRegistryEntry[]): void {
    this.matcherGuards = guards.filter((entry) => entry.matcherError && (entry.event === "pre" || entry.event === "perm"));
    this.generation += 1;
  }

  publishPluginGeneration(
    projections: readonly PreparedPluginHookProjection[],
    trust: PluginHookTrustStore,
  ): void {
    this.preparePluginGeneration(projections, trust).publish();
  }

  preparePluginGeneration(
    projections: readonly PreparedPluginHookProjection[],
    trust: PluginHookTrustStore,
    owner?: { pluginId: string; generationId: string },
  ): PreparedPluginHookGenerationPublication {
    for (const projection of projections) {
      if (!projection.owner.activationId) {
        throw new Error(`plugin Hook activation identity is missing for '${projection.owner.localId}'`);
      }
    }
    const inferred = projections[0]?.owner;
    const pluginId = owner?.pluginId ?? inferred?.pluginId;
    const generationId = owner?.generationId ?? inferred?.generationId;
    if (!pluginId || !generationId) {
      throw new Error("plugin Hook generation identity is required");
    }
    const generations = new Set(
      projections.map((projection) =>
        `${projection.owner.pluginId}\0${projection.owner.activationId}`),
    );
    generations.add(`${pluginId}\0${generationId}`);
    // Only this generation's registries: publish applies them to the live map so another plugin published in between is kept.
    const replacements = new Map<string, readonly HookRegistryEntry[]>();
    for (const projection of projections) {
      if (!trust.isApproved(projection)) continue;
      const entries = buildHookRegistry([], projection.entries).map((entry) => ({
        ...entry,
        id: `plugin:${projection.owner.pluginId}:${projection.owner.localId}:${entry.id.slice("config:".length)}`,
        event: entry.event,
        ...(entry.matcher !== undefined ? { matcher: entry.matcher } : {}),
        command: [...entry.command],
        ...(entry.env ? { env: { ...entry.env } } : {}),
        owner: projection.owner,
        confinement: projection.confinement,
      }));
      replacements.set(pluginProjectionKey(projection), Object.freeze(entries));
    }
    let published = false;
    return Object.freeze({
      pluginId,
      generationId,
      publish: () => {
        if (published) return;
        const next = new Map(this.pluginRegistries);
        for (const identity of generations) {
          const [targetPluginId, targetGenerationId] = identity.split("\0");
          for (const [key, entries] of next) {
            if (entries.some((entry) =>
              entry.owner?.pluginId === targetPluginId &&
              entry.owner.activationId === targetGenerationId)) {
              next.delete(key);
            }
          }
        }
        for (const [key, entries] of replacements) next.set(key, entries);
        this.pluginRegistries = next;
        this.generation += 1;
        published = true;
      },
    });
  }

  removePluginGeneration(pluginId: string, generationId: string): void {
    for (const [key, entries] of this.pluginRegistries) {
      if (entries.some((entry) => entry.owner?.pluginId === pluginId &&
        entry.owner.activationId === generationId)) {
        this.pluginRegistries.delete(key);
      }
    }
    this.generation += 1;
  }

  removePlugin(pluginId: string): void {
    for (const [key, entries] of this.pluginRegistries) {
      if (entries.some((entry) => entry.owner?.pluginId === pluginId)) this.pluginRegistries.delete(key);
    }
  }

  private snapshotRegistry(): HookRegistryEntry[] {
    return [...this.registry, ...[...this.pluginRegistries.values()].flat()];
  }

  hooksOfType(type: ScriptHookType): HookRegistryEntry[] {
    return this.snapshotRegistry().filter((e) => e.event === type);
  }

  size(): number {
    return this.snapshotRegistry().length;
  }

  getGeneration(): string {
    return String(this.generation);
  }

  // Redact top-level strings and string arrays before stdin; callers must exclude nested secrets because nested objects are not walked.
  async runPreToolUse(
    payload: HookDispatchPayload,
    options?: RunOneHookOptions,
  ): Promise<HookDispatchResult> {
    if (!areExternalTurnHooksAllowed()) return externalHooksSuppressed();
    return this.runForType("pre", payload, options);
  }

  // Post-use denials are audit-only and cannot roll back execution.
  async runPostToolUse(
    payload: HookDispatchPayload,
    options?: RunOneHookOptions,
  ): Promise<HookDispatchResult> {
    if (!areExternalTurnHooksAllowed()) return externalHooksSuppressed();
    return this.runForType("post", payload, options);
  }

  // Permission hooks may deny before interactive approval.
  async runPermissionRequest(
    payload: HookDispatchPayload,
    options?: RunOneHookOptions,
  ): Promise<HookDispatchResult> {
    if (!areExternalTurnHooksAllowed()) return externalHooksSuppressed();
    return this.runForType("perm", payload, options);
  }

  // Lifecycle decisions are audit-only and must not affect control flow; dispatch errors return an empty result without throwing. Match subjects use the shared compiled matcher.
  async runLifecycleEvent(
    event: LifecycleHookEvent,
    sessionId: string,
    trustOrigin: HookTrustOrigin,
    payload: LifecycleEventPayload = {},
    options?: RunOneHookOptions,
  ): Promise<HookDispatchResult> {
    if (!areExternalTurnHooksAllowed()) return externalHooksSuppressed();
    // Routing a blocking prompt event here must fail closed; use runUserPromptSubmit so a denial cannot be swallowed.
    if (isBlockingLifecycleEvent(event)) {
      log.error(
        "runLifecycleEvent called for the BLOCKING %s event — use runUserPromptSubmit; failing closed (deny)",
        event,
      );
      return {
        decision: "deny",
        reason: `${event} is blocking — must dispatch via runUserPromptSubmit`,
        results: [],
      };
    }
    try {
      // Subjects are bounded event values; Stop ignores matchers entirely.
      const entries = filterRegistryByEventAndSubject(
        this.snapshotRegistry(),
        event,
        lifecycleMatcherSubject(event, sessionId, payload),
      );
      if (entries.length === 0) {
        return { decision: "allow", reason: "no matching lifecycle hooks", results: [] };
      }
      const stdinPayload: LifecycleHookStdin = {
        hookType: event,
        event,
        sessionId,
        trustOrigin,
        ...(event === "SessionStart" ? { sessionSource: payload.sessionSource ?? "startup" } : {}),
        ...(event === "Notification" ? { notificationType: payload.notificationType ?? "agent_completed" } : {}),
        ...(payload.toolName !== undefined ? { toolName: payload.toolName } : {}),
        // DLP-redact free-text fields: a tool error message can echo user/secret data. No tool inputs flow through lifecycle events.
        ...(payload.errorMessage !== undefined
          ? { errorMessage: redactForLLM(payload.errorMessage).redacted }
          : {}),
        ...(payload.durationMs !== undefined ? { durationMs: payload.durationMs } : {}),
        // The finalized deny reason is free text (it can quote a path or an argument), so it is redacted like the other free-text fields.
        ...(payload.denyReason !== undefined
          ? {
            denyReason: {
              ...payload.denyReason,
              ...(payload.denyReason.reason !== undefined
                ? { reason: redactForLLM(payload.denyReason.reason).redacted }
                : {}),
            },
          }
          : {}),
        ...(payload.sessionMeta !== undefined ? { sessionMeta: payload.sessionMeta } : {}),
        ...(payload.stopReason !== undefined ? { stopReason: payload.stopReason } : {}),
        ...(payload.toolCount !== undefined ? { toolCount: payload.toolCount } : {}),
        ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
        ...(payload.tokenEstimate !== undefined ? { tokenEstimate: payload.tokenEstimate } : {}),
        ...(payload.messagesBefore !== undefined ? { messagesBefore: payload.messagesBefore } : {}),
        ...(payload.messagesAfter !== undefined ? { messagesAfter: payload.messagesAfter } : {}),
        ...(payload.tokensBefore !== undefined ? { tokensBefore: payload.tokensBefore } : {}),
        ...(payload.tokensAfter !== undefined ? { tokensAfter: payload.tokensAfter } : {}),
        ...(payload.agentId !== undefined ? { agentId: payload.agentId } : {}),
        ...(payload.agentType !== undefined ? { agentType: payload.agentType } : {}),
        // Notification text is assistant output and can echo user/secret data.
        ...(payload.message !== undefined
          ? { message: redactForLLM(payload.message).redacted }
          : {}),
        ...(payload.stopHookActive !== undefined ? { stopHookActive: payload.stopHookActive } : {}),
      };
      // The first denial stops the chain for audit, but lifecycle callers must ignore its decision.
      const result = await this.runWithGenerationLeases(entries, (activeEntries) =>
        runHookChain(activeEntries.map(toRunnable), stdinPayload, this.executionOptions(options)));
      if (result.decision === "deny") {
        log.warn("lifecycle hook %s reported a non-blocking failure or denial: %s", event, redactForLLM(result.reason).redacted);
      }
      return result;
    } catch (err) {
      // Lifecycle dispatch failures must not break the turn.
      log.warn(
        "lifecycle hook dispatch for %s failed (non-blocking, ignored): %s",
        event,
        errorMessage(err),
      );
      return { decision: "allow", reason: "lifecycle dispatch error (ignored)", results: [] };
    }
  }

  // Prompt denials and all hook or dispatch failures refuse the turn before queryLoop; no trusted hooks allows it. Run every trusted prompt hook without matcher filtering and DLP-redact input before stdin/env.
  async runUserPromptSubmit(
    sessionId: string,
    trustOrigin: HookTrustOrigin,
    payload: UserPromptSubmitPayload,
    options?: RunOneHookOptions,
  ): Promise<HookDispatchResult> {
    if (!areExternalTurnHooksAllowed()) return externalHooksSuppressed();
    try {
      const entries = this.snapshotRegistry().filter((entry) => entry.event === USER_PROMPT_SUBMIT_EVENT);
      if (entries.length === 0) {
        // No trusted hooks allows the prompt.
        return { decision: "allow", reason: "no matching UserPromptSubmit hooks", results: [] };
      }
      const stdinPayload: LifecycleHookStdin = {
        hookType: USER_PROMPT_SUBMIT_EVENT,
        event: USER_PROMPT_SUBMIT_EVENT,
        sessionId,
        trustOrigin,
        // Redact the prompt before exposing it to hooks.
        inputText: redactForLLM(payload.inputText).redacted,
        ...(payload.inputOrigin !== undefined ? { inputOrigin: payload.inputOrigin } : {}),
        ...(payload.route !== undefined ? { route: payload.route } : {}),
        ...(payload.classification !== undefined ? { classification: payload.classification } : {}),
      };
      // The first denial, including timeout/exit/parse/spawn failures, is authoritative; callers must refuse the turn.
      return await this.runWithGenerationLeases(entries, (activeEntries) =>
        runHookChain(activeEntries.map(toRunnable), stdinPayload, this.executionOptions(options)));
    } catch (err) {
      // Unexpected blocking dispatch errors must deny the turn.
      log.warn(
        "UserPromptSubmit hook dispatch failed (fail-closed → deny): %s",
        errorMessage(err),
      );
      return {
        decision: "deny",
        reason: `UserPromptSubmit dispatch error (fail-closed → deny): ${errorMessage(err)}`,
        results: [],
      };
    }
  }

  private async runForType(
    type: ScriptHookType,
    payload: HookDispatchPayload,
    options?: RunOneHookOptions,
  ): Promise<HookDispatchResult> {
    // Absent matchers run for every tool.
    const registry = this.snapshotRegistry();
    const invalid = [...this.matcherGuards, ...registry].find((entry) => entry.event === type && entry.matcherError);
    if (invalid) return { decision: "deny", reason: invalid.matcherError!, results: [] };
    let entries: HookRegistryEntry[];
    try {
      entries = filterRegistryByEventAndTool(registry, type, payload.toolName);
    } catch (error) {
      if (!(error instanceof HookMatcherError)) throw error;
      return { decision: "deny", reason: error.message, results: [] };
    }
    if (entries.length === 0) {
      return { decision: "allow", reason: "no matching hooks of this type", results: [] };
    }
    const stdinPayload: ScriptHookStdin = {
      hookType: type,
      event: type,
      toolName: payload.toolName,
      source: payload.source,
      category: payload.category,
      input: dlpRedactInput(payload.input),
      sessionId: payload.sessionId,
      trustOrigin: payload.trustOrigin,
      ...(payload.mcpServerId !== undefined ? { mcpServerId: payload.mcpServerId } : {}),
      ...(payload.pluginId !== undefined ? { pluginId: payload.pluginId } : {}),
      ...(payload.toolOutput !== undefined ? { toolOutput: redactForLLM(payload.toolOutput).redacted } : {}),
      ...(payload.isError !== undefined ? { isError: payload.isError } : {}),
    };
    // Each config hook uses its own clamped timeout; scripts use the caller option or default.
    return this.runWithGenerationLeases(entries, (activeEntries) =>
      runHookChain(activeEntries.map(toRunnable), stdinPayload, this.executionOptions(options)));
  }

  private async runWithGenerationLeases<T>(
    entries: readonly HookRegistryEntry[],
    operation: (activeEntries: HookRegistryEntry[]) => Promise<T>,
  ): Promise<T> {
    const leases = new Map<
      string,
      { release(): void }
    >();
    const acquiredOwnerKeys = new Set<string>();
    try {
      for (const entry of entries) {
        const owner = entry.owner;
        if (!owner) continue;
        const activationId = owner.activationId;
        const key = `${owner.pluginId}\0${activationId}`;
        if (acquiredOwnerKeys.has(key)) continue;
        const source = [...this.generationLeaseSources.entries()]
          .filter(([prefix]) => owner.pluginId.startsWith(prefix))
          .sort(([a], [b]) => b.length - a.length)[0]?.[1];
        const acquire = source ?? this.generationAccess?.acquireExact.bind(this.generationAccess);
        if (!acquire) throw new Error(`plugin hook '${entry.id}' cannot run without generation leasing for '${owner.pluginId}' generation '${owner.generationId}'`);
        leases.set(key, await acquire(owner.pluginId, activationId));
        acquiredOwnerKeys.add(key);
      }
      return await operation([...entries]);
    } finally {
      for (const lease of leases.values()) lease.release();
    }
  }
}

function toRunnable(entry: HookRegistryEntry): RunnableHook {
  if (entry.source === "sh") {
    return runnableFromDiscovered(entry.discovered);
  }
  return {
    id: entry.id,
    hookType: entry.event,
    command: entry.command,
    ...(entry.env ? { env: entry.env } : {}),
    ...(entry.matcher !== undefined ? { matcher: entry.matcher } : {}),
    // For a config command, the forensic path is argv[0] (or the script arg).
    hookPath: entry.command[0],
    timeoutMs: entry.timeoutMs,
    // Config command identity hashes verbatim argv when no local script hash exists.
    source: "config",
    ...(entry.owner ? { pluginOwner: entry.owner } : {}),
    ...(entry.confinement ? { confinement: entry.confinement } : {}),
  };
}

function pluginProjectionKey(projection: PreparedPluginHookProjection): string {
  const owner = projection.owner;
  return [owner.pluginId, owner.pluginVersion, owner.generationId, owner.localId, owner.fingerprint].join("|");
}

// Redact string values; numbers, booleans and nested objects pass through unchanged.
export function dlpRedactInput(
  input: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    if (typeof v === "string") {
      out[k] = redactForLLM(v).redacted;
    } else if (Array.isArray(v)) {
      out[k] = v.map((item) =>
        typeof item === "string" ? redactForLLM(item).redacted : item,
      );
    } else {
      out[k] = v;
    }
  }
  return out;
}
