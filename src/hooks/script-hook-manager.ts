/**
 * Permission policy — Layer 6 hook runtime manager.
 *
 * Spec ref: docs/architecture/permission-policy-design.md §3 Layer 6 +
 * docs/architecture/hook-runtime-expansion-design.md §4 (#811).
 *
 * Holds the trusted hook registry at runtime and exposes
 * {@link runPreToolUse} / {@link runPostToolUse} / {@link runPermissionRequest}
 * — the three integration points the executor / approval-gate call into.
 *
 * The registry is the UNIFIED list (`hook-registry.ts`): trusted legacy `.sh`
 * hooks AND trusted declarative `hooks.json` `command` entries collapse into one
 * normalized shape, so dispatch is origin-agnostic. CRITICAL: only entries that
 * passed the TOFU trust gate ever land here — `setTrustedRegistry` is called by
 * the boot pipeline / `/permission hooks accept` AFTER quarantine resolves. An
 * untrusted or changed `hooks.json` contributes NOTHING to this registry.
 *
 * Composition rule (v1, deny precedence):
 *   - {@link runPreToolUse} returns `decision: "deny"` when *any* hook denied.
 *   - {@link runPreToolUse} returns `decision: "allow"` only when no hook denies.
 *     Caller MUST NOT promote this allow over an upstream deny.
 *   - `modify` is **NOT** supported in v1.
 */
import { type DiscoveredHook } from "./hook-discovery.js";
import {
  buildHookRegistry,
  filterRegistryByEventAndSubject,
  filterRegistryByEventAndTool,
  type HookRegistryEntry,
  type ConfigHookRegistryEntry,
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
    reason: "external hooks disabled for remote-controller turn",
    results: [],
  };
}

export interface HookDispatchResult {
  decision: "allow" | "deny";
  reason: string;
  /** Per-hook results — for audit + observability. */
  results: ScriptHookInvocationResult[];
}

export interface PreparedPluginHookGenerationPublication {
  readonly pluginId: string;
  readonly generationId: string;
  publish(): void;
}

export class ScriptHookManager {
  private registry: HookRegistryEntry[] = [];
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

  /**
   * Replace the trusted hook list with legacy `.sh` hooks only. Retained for
   * back-compat with callers that don't (yet) carry config entries. Equivalent
   * to `setTrustedRegistry(hooks, [])`.
   */
  setTrustedHooks(hooks: DiscoveredHook[]): void {
    this.setTrustedRegistry(hooks, []);
  }

  /**
   * Replace the trusted registry with the unified set: trusted `.sh` hooks
   * (origin `sh`) + trusted declarative config entries (origin `config`).
   * Called by the boot pipeline once the TOFU workflow resolves and by
   * `/permission hooks accept` when trust state changes. The executor /
   * approval-gate read from this snapshot for every tool call.
   *
   * SECURITY: callers MUST pass ONLY trusted entries. The manager never
   * re-validates trust — it assumes the quarantine gate already ran.
   */
  setTrustedRegistry(shHooks: DiscoveredHook[], configEntries: HookConfigEntry[]): void {
    this.registry = buildHookRegistry(shHooks, configEntries);
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
    // Only this generation's registries: publish applies them to the live map
    // so another plugin published in between is kept.
    const replacements = new Map<string, readonly HookRegistryEntry[]>();
    for (const projection of projections) {
      if (!trust.isApproved(projection)) continue;
      const entries: ConfigHookRegistryEntry[] = projection.entries.map((entry) => ({
        id: `plugin:${projection.owner.pluginId}:${projection.owner.localId}:${entry.id}`,
        event: entry.event,
        ...(entry.matcher !== undefined ? { matcher: entry.matcher } : {}),
        command: [...entry.command],
        ...(entry.env ? { env: { ...entry.env } } : {}),
        source: "config",
        timeoutMs: entry.timeoutMs,
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

  /** Registry entries for the given type. Used by tests + diagnostics. */
  hooksOfType(type: ScriptHookType): HookRegistryEntry[] {
    return this.snapshotRegistry().filter((e) => e.event === type);
  }

  /** Total trusted entry count. */
  size(): number {
    return this.snapshotRegistry().length;
  }

  getGeneration(): string {
    return String(this.generation);
  }

  /**
   * Dispatch all PreToolUse hooks. DLP-redacts top-level string fields
   * and string array items in `input` before passing into hook stdin.
   * Nested objects are passed as-is, so pathFields/category metadata must
   * keep secret material out of nested tool arguments.
   */
  async runPreToolUse(
    payload: HookDispatchPayload,
    options?: RunOneHookOptions,
  ): Promise<HookDispatchResult> {
    if (!areExternalTurnHooksAllowed()) return externalHooksSuppressed();
    return this.runForType("pre", payload, options);
  }

  /** Dispatch all PostToolUse hooks. v1 outputs are *informational*
   * (deny does NOT roll back the already-executed tool); the result
   * surfaces in audit so reviewers see the after-the-fact concern. */
  async runPostToolUse(
    payload: HookDispatchPayload,
    options?: RunOneHookOptions,
  ): Promise<HookDispatchResult> {
    if (!areExternalTurnHooksAllowed()) return externalHooksSuppressed();
    return this.runForType("post", payload, options);
  }

  /** Dispatch all PermissionRequest hooks. Hooks may deny what the
   * approval-gate would have asked the user about — useful for SIEM
   * "this user must NEVER approve writes outside repo X" policies. */
  async runPermissionRequest(
    payload: HookDispatchPayload,
    options?: RunOneHookOptions,
  ): Promise<HookDispatchResult> {
    if (!areExternalTurnHooksAllowed()) return externalHooksSuppressed();
    return this.runForType("perm", payload, options);
  }

  /**
   * Dispatch all hooks registered for a NON-BLOCKING lifecycle event (#811
   * milestone-2, design §5). OBSERVE-ONLY: the returned decision is recorded for
   * audit but MUST NEVER affect control flow — a lifecycle hook's `deny` mirrors
   * `PostToolUse` (informational), and a hook erroring / timing out must not
   * break the turn. The matcher subject for lifecycle events is `sessionId`
   * (or `'*'` = all), matched via the same glob as `.sh` / tool-use matchers.
   *
   * Fail-soft: this method NEVER throws. A dispatch error collapses to an empty
   * observe result so the caller can ignore it and continue.
   */
  async runLifecycleEvent(
    event: LifecycleHookEvent,
    sessionId: string,
    trustOrigin: HookTrustOrigin,
    payload: LifecycleEventPayload = {},
    options?: RunOneHookOptions,
  ): Promise<HookDispatchResult> {
    if (!areExternalTurnHooksAllowed()) return externalHooksSuppressed();
    // Misroute guard: the BLOCKING event must NEVER run through this observe-only
    // path (it would swallow a deny and let a refused prompt through). Route it
    // to {@link runUserPromptSubmit} instead. Fail closed — return a deny so a
    // wiring bug refuses rather than silently allows.
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
      // Subject for lifecycle matchers is the sessionId (design §6). Reuse the
      // same glob filter so a `'*'` / sessionId matcher behaves identically to
      // tool-use matchers. (`'*'` / absent matcher ⇒ match every session.)
      const entries = filterRegistryByEventAndSubject(this.snapshotRegistry(), event, sessionId);
      if (entries.length === 0) {
        return { decision: "allow", reason: "no matching lifecycle hooks", results: [] };
      }
      const stdinPayload: LifecycleHookStdin = {
        hookType: event,
        event,
        sessionId,
        trustOrigin,
        ...(payload.toolName !== undefined ? { toolName: payload.toolName } : {}),
        // DLP-redact free-text fields (§6.6): a tool error message can echo
        // user/secret data. No tool inputs flow through lifecycle events.
        ...(payload.errorMessage !== undefined
          ? { errorMessage: redactForLLM(payload.errorMessage).redacted }
          : {}),
        ...(payload.durationMs !== undefined ? { durationMs: payload.durationMs } : {}),
        // The finalized deny reason is free text (it can quote a path or an
        // argument), so it is redacted like the other free-text fields.
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
      };
      // runHookChain stops at the first deny — but for a non-blocking event the
      // decision is OBSERVE-ONLY, so the caller ignores it. (Chain-stop just
      // avoids running later hooks once one already signaled deny — the audit
      // captures every result up to that point, same as PostToolUse.)
      const result = await this.runWithGenerationLeases(entries, (activeEntries) =>
        runHookChain(activeEntries.map(toRunnable), stdinPayload, this.executionOptions(options)));
      if (result.decision === "deny") {
        log.warn("lifecycle hook %s reported a non-blocking failure or denial: %s", event, redactForLLM(result.reason).redacted);
      }
      return result;
    } catch (err) {
      // Fail-soft: a lifecycle dispatch must NEVER break the turn. Log + return
      // an empty observe result so the caller continues unaffected.
      log.warn(
        "lifecycle hook dispatch for %s failed (non-blocking, ignored): %s",
        event,
        errorMessage(err),
      );
      return { decision: "allow", reason: "lifecycle dispatch error (ignored)", results: [] };
    }
  }

  /**
   * Dispatch the ONE BLOCKING lifecycle event — `UserPromptSubmit` (#811
   * milestone-2, design §5). Runs the matching trusted hooks via the
   * deny-precedence chain and returns a decision the CALLER MUST RESPECT: on
   * `deny` the caller refuses the turn before entering queryLoop.
   *
   * FAIL-CLOSED (security-sensitive, mirrors `PreToolUse`):
   *   - a hook `deny` → deny (turn refused)
   *   - timeout / nonzero-exit / bad-json / spawn-error → deny (runHookChain /
   *     runOneHookScript already collapse all of these to a deny result)
   *   - an UNEXPECTED throw inside this dispatch → deny (NOT allow). Unlike the
   *     observe-only {@link runLifecycleEvent} which swallows-and-continues, this
   *     blocking event must fail closed.
   *
   * BACK-COMPAT: when NO trusted hook matches, returns `allow` with an empty
   * `results` so the caller proceeds byte-identically to today. The matcher
   * subject is the prompt text (or `'*'`), matched via the same glob as `.sh` /
   * tool-use matchers.
   *
   * DLP: `inputText` is DLP-redacted here (§6.6, via {@link redactForLLM}) before
   * it reaches the hook stdin / env — exactly as the observe path redacts
   * `errorMessage` and the tool path redacts `input`.
   */
  async runUserPromptSubmit(
    sessionId: string,
    trustOrigin: HookTrustOrigin,
    payload: UserPromptSubmitPayload,
    options?: RunOneHookOptions,
  ): Promise<HookDispatchResult> {
    if (!areExternalTurnHooksAllowed()) return externalHooksSuppressed();
    try {
      // Matcher subject = the prompt text (design §5). Reuse the same glob as
      // tool-use / lifecycle matchers (`'*'` / absent matcher ⇒ match every prompt).
      const entries = filterRegistryByEventAndSubject(
        this.snapshotRegistry(),
        USER_PROMPT_SUBMIT_EVENT,
        payload.inputText,
      );
      if (entries.length === 0) {
        // No trusted matching hook ⇒ ALLOW (back-compat: turn proceeds as today).
        return { decision: "allow", reason: "no matching UserPromptSubmit hooks", results: [] };
      }
      const stdinPayload: LifecycleHookStdin = {
        hookType: USER_PROMPT_SUBMIT_EVENT,
        event: USER_PROMPT_SUBMIT_EVENT,
        sessionId,
        trustOrigin,
        // DLP-redact the free-text prompt (§6.6) BEFORE it reaches the hook.
        inputText: redactForLLM(payload.inputText).redacted,
        ...(payload.inputOrigin !== undefined ? { inputOrigin: payload.inputOrigin } : {}),
        ...(payload.route !== undefined ? { route: payload.route } : {}),
        ...(payload.classification !== undefined ? { classification: payload.classification } : {}),
      };
      // Deny precedence: runHookChain stops at the first deny and returns it.
      // All fail-closed cases (timeout/nonzero-exit/bad-json/spawn-error) are
      // already collapsed to a deny RESULT by runOneHookScript, so the chain's
      // returned decision is authoritative — the caller refuses on deny.
      return await this.runWithGenerationLeases(entries, (activeEntries) =>
        runHookChain(activeEntries.map(toRunnable), stdinPayload, this.executionOptions(options)));
    } catch (err) {
      // FAIL-CLOSED: a blocking event must DENY (refuse the turn) on an
      // unexpected dispatch error — NOT allow. (Contrast runLifecycleEvent,
      // which is observe-only and swallows-then-allows.)
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
    // #811 — filter by event + matcher (the same glob as `.sh` frontmatter).
    // A config/`.sh` entry with no matcher runs for every tool.
    const entries = filterRegistryByEventAndTool(this.snapshotRegistry(), type, payload.toolName);
    if (entries.length === 0) {
      return { decision: "allow", reason: "no matching hooks of this type", results: [] };
    }
    const stdinPayload: ScriptHookStdin = {
      hookType: type,
      // Closed-set surface: for tool-use hooks `event` equals `hookType`.
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
    // Each entry runs with its own timeout: config entries carry a per-entry
    // (already-clamped) `timeoutMs`; `.sh` entries fall back to the default /
    // caller-supplied option.
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

/**
 * Normalize one registry entry into the runner's {@link RunnableHook} shape,
 * carrying its per-entry timeout when present (config entries) so each hook runs
 * on its own clamped budget.
 */
function toRunnable(entry: HookRegistryEntry): RunnableHook {
  if (entry.source === "sh") {
    // `.sh` entries carry NO per-entry timeout — they fall back to the
    // caller-supplied option (e.g. the Windows shell-integration override) or
    // the default, exactly as before this change.
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
    // A declarative `hooks.json` command — the runner falls back to hashing the
    // verbatim argv for `commandIdentity` (no on-disk local-script sha exists).
    source: "config",
    ...(entry.owner ? { pluginOwner: entry.owner } : {}),
    ...(entry.confinement ? { confinement: entry.confinement } : {}),
  };
}

function pluginProjectionKey(projection: PreparedPluginHookProjection): string {
  const owner = projection.owner;
  return [owner.pluginId, owner.pluginVersion, owner.generationId, owner.localId, owner.fingerprint].join("|");
}

/**
 * Apply DLP redaction to every string-valued field of the `input`
 * object before it reaches the hook stdin. Numbers / booleans / nested
 * objects are passed through (the redactor only mutates strings).
 *
 * Exported for unit tests.
 */
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
