import type { ConversationLoop } from "../conversation-loop.js";
import type { TurnCallbacks, TurnResult } from "./types.js";
import type { ChatInputOrigin } from "../../shared/chat-origin.js";
import { isUserKeyboardOrigin } from "../../shared/chat-origin.js";
import type { ToolSource } from "../../tools/types.js";
import { t } from "../../i18n/index.js";
import { getWorkspaceRootLifecycle } from "../../permissions/workspace-root-lifecycle.js";
import { findSessionByIdPrefix } from "../../shared/session-lookup.js";
import { formatMediumDateTime } from "../../shared/format-time.js";
import { activeLlmRouteModel } from "../../shared/llm-vendor-defaults.js";
import {
  catalogModelFor,
  llmRouteCatalogAddress,
  resolveModelRetirement,
  type LlmRouteCatalogAddress,
} from "../../shared/context-budget.js";
import { llmModelListCacheKey, type LlmModelListCacheEntry } from "../../shared/llm-model-list.js";
import { activeModelCatalog } from "../../shared/model-catalog/active.js";
import { CATALOG_PROVIDERS_BY_VENDOR } from "../../shared/model-catalog/provider-map.js";
import { allowsImplicitModelLimits } from "../../shared/model-catalog/resolve.js";
import { refreshRouteModelList } from "../llm/model-list.js";
import { cleanModelOverride, subscriptionAcceptsModelOverride } from "./provider.js";

function toolProvenanceLabel(tool: {
  source: ToolSource;
  pluginId?: string;
  mcpServerId?: string;
}): string {
  if (tool.source === "plugin") return `plugin:${tool.pluginId ?? "unknown"}`;
  if (tool.source === "mcp") return `mcp:${tool.mcpServerId ?? "unknown"}`;
  return "builtin";
}

// Builtins retain their names; command files and skills may claim only names outside this switch set.
export const BUILTIN_SLASH_COMMANDS: ReadonlySet<string> = new Set([
  "new", "remember", "memory", "sessions", "load", "model", "vendor",
  "compact", "tools", "permission", "goal", "help",
]);

const MODEL_COMMAND_RESET = "default";

// Loose catalog matches are safe for capacity lookup, not dispatchable model spelling.
const VERIFYING_CATALOG_MATCHES: ReadonlySet<string> = new Set([
  "exact", "alias", "version-tag", "canonical", "date-suffix",
]);

// Deployment names cannot be enumerated; switching them remains explicitly unverified.
type ModelVerification = "verified" | "unknown" | "retired" | "unverifiable" | "deployment";

// Only the next request can confirm a user-created deployment name.
const DEPLOYMENT_NAMED_VENDORS: ReadonlySet<string> = new Set(["azure-foundry"]);

/** Empty or unreachable subscription catalogs leave model choices unverifiable. */
async function verifySubscriptionModel(self: ConversationLoop, model: string): Promise<ModelVerification> {
  const list = self.provider?.listSubscriptionModels;
  if (!list) return "unverifiable";
  let models: readonly string[];
  try {
    models = await list.call(self.provider);
  } catch {
    return "unverifiable";
  }
  if (models.length === 0) return "unverifiable";
  return models.includes(model) ? "verified" : "unknown";
}

/** Validate against route-owned catalog or endpoint knowledge; absent knowledge never implies support. */
async function verifyRouteModel(self: ConversationLoop, model: string): Promise<ModelVerification> {
  const settings = self.deps.settingsService;
  const llm = settings.get("llm");
  const presets = llm.provider === "openai-compatible" && llm.marketplaceProviderPresetId
    ? settings.get("marketplace").installedProviderPresets
    : undefined;
  const address: LlmRouteCatalogAddress = llmRouteCatalogAddress(llm, presets);
  const key = llmModelListCacheKey(address.vendor, address.baseUrl, address.credentialScope);
  const listing = (): LlmModelListCacheEntry | undefined => settings.get("llm").modelListCache?.[key];
  const retired = (): boolean => resolveModelRetirement({
    vendor: address.vendor,
    model,
    ...(address.baseUrl !== undefined ? { baseUrl: address.baseUrl } : {}),
    ...(listing() ? { listing: listing() } : {}),
  }) !== undefined;

  const hit = catalogModelFor(address.vendor, model, undefined, address.baseUrl);
  const inCatalog = hit !== undefined && VERIFYING_CATALOG_MATCHES.has(hit.match);
  if (DEPLOYMENT_NAMED_VENDORS.has(address.vendor) && !listing()?.models.includes(model)) return "deployment";
  if (!listing()?.models.includes(model) && !inCatalog) {
    const policy = address.credentialScope
      ? presets?.find((preset) => preset.providerId === address.credentialScope)?.modelDiscoveryPolicy
      : undefined;
    try {
      await refreshRouteModelList({
        settingsService: settings,
        fetchOptions: { fetchImpl: self.deps.networkFetch },
        address,
        ...(policy ? { modelDiscoveryPolicy: policy } : {}),
      });
    } catch {
      // Unreachable discovery leaves cached knowledge, or none, authoritative.
    }
  }
  if (listing()?.models.includes(model) || inCatalog) return retired() ? "retired" : "verified";
  if (listing() !== undefined || catalogSpeaksFor(address)) return "unknown";
  return "unverifiable";
}

// Catalog entries speak for native endpoints, not gateways serving arbitrary model names.
function catalogSpeaksFor(address: LlmRouteCatalogAddress): boolean {
  if (!allowsImplicitModelLimits(address.vendor, address.baseUrl)) return false;
  const providers = Object.hasOwn(CATALOG_PROVIDERS_BY_VENDOR, address.vendor)
    ? CATALOG_PROVIDERS_BY_VENDOR[address.vendor]
    : [];
  const catalog = activeModelCatalog();
  return providers.some((provider) => Object.keys(catalog.providers[provider]?.models ?? {}).length > 0);
}

/** Session model overrides last until switching sessions; accept only route-verified choices. */
async function handleModelCommand(self: ConversationLoop, args: string): Promise<string> {
  const requested = args.trim();
  const llm = self.deps.settingsService.get("llm");
  const runtime = llm.activeChatRuntime;
  const subscription = runtime?.kind === "subscription" ? runtime : undefined;
  const currentModel = (): string => subscription
    ? self.provider?.subscriptionRuntime?.model ?? subscription.model ?? MODEL_COMMAND_RESET
    : activeLlmRouteModel(llm, self.deps.modelOverride);
  if (!requested) {
    return t("be_conversationLoop.cmdModelCurrent", { model: currentModel() || "-" });
  }
  if (subscription && !subscriptionAcceptsModelOverride(subscription)) {
    return t("be_conversationLoop.cmdModelUnsupported");
  }
  if (requested === MODEL_COMMAND_RESET) {
    self.setSessionModelOverride(undefined);
    return t("be_conversationLoop.cmdModelReset", { model: currentModel() || "-" });
  }
  const model = cleanModelOverride(requested);
  if (!model || /\s/.test(model)) return t("be_conversationLoop.cmdModelInvalid");
  const verification = subscription
    ? await verifySubscriptionModel(self, model)
    : await verifyRouteModel(self, model);
  if (verification === "unknown") return t("be_conversationLoop.cmdModelUnknown", { model });
  if (verification === "retired") return t("be_conversationLoop.cmdModelRetired", { model });
  if (verification === "unverifiable") return t("be_conversationLoop.cmdModelUnverifiable", { model });
  self.setSessionModelOverride(model);
  return verification === "deployment"
    ? t("be_conversationLoop.cmdModelSetUnverifiedDeployment", { model })
    : t("be_conversationLoop.cmdModelSet", { model });
}

export async function handleCommand(
  self: ConversationLoop,
    command: string,
    args: string,
    inputOrigin: ChatInputOrigin,
    callbacks?: TurnCallbacks,
  ): Promise<TurnResult> {
    if (!isUserKeyboardOrigin(inputOrigin)) {
      const result = t("be_conversationLoop.nonKeyboardSlashCommandBlocked");
      callbacks?.onTextDelta?.(result);
      callbacks?.onTurnComplete?.(result);
      return { text: result, toolCalls: [], route: "command" };
    }
    let result: string;

    switch (command) {
      case "new":
        await self.newConversation();
        result = t("be_conversationLoop.cmdNewConversation");
        break;
      case "remember": {
        if (!args.trim()) { result = t("be_conversationLoop.cmdRememberUsage"); break; }
        const title = args.slice(0, 40).replace(/\n/g, " ");
        const memoryCaptureService = self.deps.memoryCaptureService;
        if (!memoryCaptureService) {
          result = t("be_conversationLoop.cmdRememberNotSaved");
          break;
        }
        try {
          const capture = await memoryCaptureService.captureExplicit({
            title,
            content: args,
            ...(self.getSessionMemoryProjectContext?.()
              ?? self.getSessionProjectContext?.()
              ?? {}),
          });
          result = capture.status === "saved"
            ? t("be_conversationLoop.cmdRememberSaved", { title: capture.entry.title })
            : t("be_conversationLoop.cmdRememberNotSaved");
        } catch {
          // A reviewer failure must never silently fall back to raw persistence.
          result = t("be_conversationLoop.cmdRememberNotSaved");
        }
        break;
      }
      case "memory": {
        const memories = self.deps.memoryManager.listMemoryEntries(
          self.getSessionMemoryProjectContext?.() ?? self.getSessionProjectContext?.(),
        );
        result = memories.length === 0
          ? t("be_conversationLoop.cmdMemoryEmpty")
          : memories.map((n) => `- ${n.title} (${n.filename})`).join("\n");
        break;
      }
      case "sessions": {
        const sessions = self.listSessions(10);
        if (sessions.length === 0) { result = t("be_conversationLoop.cmdSessionsEmpty"); break; }
        const current = self.sessionId;
        const sessionListLines = sessions.slice(0, 10).map((s) => {
          const marker = s.id === current ? t("be_conversationLoop.cmdSessionMarkerCurrent") : "";
          const date = formatMediumDateTime(s.modifiedAt.getTime());
          return `- ${s.id.slice(0, 8)}… (${date})${marker}`;
        }).join("\n");
        result = t("be_conversationLoop.cmdSessionsList", { max: 10, list: sessionListLines });
        break;
      }
      case "load": {
        if (!args.trim()) { result = t("be_conversationLoop.cmdLoadUsage"); break; }
        const targetId = args.trim();
        // 부분 ID 매칭 — 렌더러의 `/load`와 같은 술어를 공유한다.
        const sessions = self.listSessions();
        const match = findSessionByIdPrefix(sessions, targetId);
        if (!match) { result = t("be_conversationLoop.cmdLoadNotFound", { id: targetId }); break; }
        const loaded = await self.loadSession(match.id);
        result = loaded
          ? t("be_conversationLoop.cmdLoadSuccess", { id: match.id.slice(0, 8), count: self.history.length })
          : t("be_conversationLoop.cmdLoadFailed", { id: match.id });
        break;
      }
      case "model":
        result = await handleModelCommand(self, args);
        break;
      case "vendor":
        result = t("be_conversationLoop.cmdVendorInfo", { vendor: self.getVendor(), session: self.sessionId.slice(0, 8), input: self.cumulativeUsage.inputTokens, output: self.cumulativeUsage.outputTokens });
        break;
      case "compact": {
        // Pass compact focus and progress callbacks through the checkpointing summary path.
        const focus = args.trim();
        const r = await self.manualCompact({
          ...(callbacks?.onCompactOccurred ? { onCompactOccurred: callbacks.onCompactOccurred } : {}),
          ...(callbacks?.onCompactStarted ? { onCompactStarted: callbacks.onCompactStarted } : {}),
          ...(focus.length > 0 ? { focus } : {}),
        });
        result = r.summary;
        break;
      }
      case "tools": {
        // Diagnostics list model-visible tools only; executable app-only tools must not leak their names.
        const tools = self.deps.toolRegistry.getModelVisibleTools();
        result = tools.map((tool) => `${tool.name} [${toolProvenanceLabel(tool)}]`).join("\n") || t("be_conversationLoop.cmdToolsEmpty");
        break;
      }
      case "permission": {
        result = await handlePermissionCommand(self, args, inputOrigin, callbacks);
        break;
      }
      case "goal": {
        const store = self.deps.sessionGoalStore;
        if (!store) { result = t("be_conversationLoop.cmdGoalUnavailable"); break; }
        const text = args.trim();
        // Goal upsert replaces text without resetting rounds already spent.
        if (!text) {
          const current = store.get(self.sessionId);
          result = current === null
            ? t("be_conversationLoop.cmdGoalUsage")
            : t("be_conversationLoop.cmdGoalCurrent", {
                goal: current.text,
                status: current.status,
                round: current.round,
                ceiling: current.ceiling,
              });
          break;
        }
        try {
          const goal = await store.set(self.sessionId, text);
          result = t("be_conversationLoop.cmdGoalSet", {
            goal: goal.text,
            ceiling: goal.ceiling,
          });
        } catch (err) {
          result = t("be_conversationLoop.cmdGoalRejected", { error: (err as Error).message });
        }
        break;
      }
      case "help":
        result = t("be_conversationLoop.cmdHelp");
        break;
      default:
        result = t("be_conversationLoop.cmdUnknown", { command });
    }

    callbacks?.onTextDelta?.(result);
    callbacks?.onTurnComplete?.(result);
    return { text: result, toolCalls: [], route: "command" };
  }

export async function handlePermissionCommand(
  self: ConversationLoop,
    args: string,
    inputOrigin: ChatInputOrigin,
    callbacks?: TurnCallbacks,
  ): Promise<string> {
    const {
      dispatchPermissionAuditCommand,
      dispatchPermissionDirCommand,
      dispatchPermissionHooksCommand,
      dispatchPermissionReviewerCommandWithRewire,
      dispatchPermissionSlash,
    } = await import("../../permissions/permission-slash.js");
    const raw = args.trim().length > 0 ? `/permission ${args.trim()}` : "/permission";
    const outcome = dispatchPermissionSlash(
      raw,
      inputOrigin,
    );
    if (outcome.kind === "parse-error") return t("be_conversationLoop.permissionParseError", { error: outcome.error });
    if (outcome.kind === "show-current") {
      const mode = self.deps.permissionManager?.getMode() ?? "strict";
      return t("be_conversationLoop.permissionShowCurrent", { mode });
    }
    if (outcome.kind === "dir") {
      const result = await dispatchPermissionDirCommand(outcome.cmd, undefined, getWorkspaceRootLifecycle());
      if (!result.ok) {
        const warnings = result.warnings?.length ? t("be_conversationLoop.permissionDirWarnings", { warnings: result.warnings.map((w) => `- ${w}`).join("\n") }) : "";
        const ack = result.requiresAcknowledgement ? t("be_conversationLoop.permissionDirAckRequired") : "";
        return t("be_conversationLoop.permissionDirError", { error: result.error, warnings, ack });
      }
      if (result.verb === "list") {
        return [
          t("be_conversationLoop.permissionDirListHeader"),
          result.defaults.length ? t("be_conversationLoop.permissionDirListDefaults", { list: result.defaults.join(", ") }) : t("be_conversationLoop.permissionDirListDefaultsEmpty"),
          result.userAdditions.length ? t("be_conversationLoop.permissionDirListAdditions", { list: result.userAdditions.join(", ") }) : t("be_conversationLoop.permissionDirListAdditionsEmpty"),
          result.effective.length ? t("be_conversationLoop.permissionDirListEffective", { list: result.effective.join(", ") }) : t("be_conversationLoop.permissionDirListEffectiveEmpty"),
        ].join("\n");
      }
      if (result.verb === "allow") {
        if (result.sessionOnly && result.sessionDirectory) {
          self.addSessionAdditionalDirectory(result.sessionDirectory);
          return t("be_conversationLoop.permissionDirSessionAllowed", { dir: result.sessionDirectory });
        }
        return t("be_conversationLoop.permissionDirAllowed", { list: result.persisted.map((d) => `- ${d}`).join("\n") });
      }
      return t("be_conversationLoop.permissionDirDenied", { list: result.persisted.length ? result.persisted.map((d) => `- ${d}`).join("\n") : t("be_conversationLoop.permissionDirDeniedEmpty") });
    }
    if (outcome.kind === "reviewer") {
      const result = await dispatchPermissionReviewerCommandWithRewire(
        outcome.cmd,
        self.deps.rewireReviewerAgent,
      );
      if (!result.ok) return t("be_conversationLoop.permissionReviewerError", { error: result.error });
      const { mode, fallbackOnError } = result.settings;
      return [
        t("be_conversationLoop.permissionReviewerSettings"),
        `mode=${mode}`,
        "provider/model=active LLM settings",
        `fallbackOnError=${fallbackOnError}`,
      ].join("\n");
    }
    if (outcome.kind === "audit") {
      const auditLogger = self.deps.auditLogger;
      if (!auditLogger) return t("be_conversationLoop.permissionAuditNoLogger");
      const result = dispatchPermissionAuditCommand(outcome.cmd, {
        auditDir: auditLogger.getAuditDir(),
        secret: auditLogger.getPermissionAuditSecret(),
        sealStore: auditLogger.getPermissionAuditSealStore() ?? undefined,
      });
      if (!result.ok) return t("be_conversationLoop.permissionAuditError", { error: result.error });
      if (result.verb === "verify") {
        return [
          `Audit verify: ${result.intact ? "intact" : "broken"}`,
          `files=${result.totalFiles}`,
          `entries=${result.totalEntries}`,
          ...(result.firstBrokenFile ? [`firstBrokenFile=${result.firstBrokenFile}`] : []),
        ].join("\n");
      }
      return [
        t("be_conversationLoop.permissionAuditRecent", { count: result.entries.length }),
        ...result.entries.map((entry) => JSON.stringify(entry)),
      ].join("\n");
    }
    if (outcome.kind === "mode") {
      const pm = self.deps.permissionManager;
      if (!pm) return t("be_conversationLoop.permissionModeNoManager");
      const { applyPermissionModeCommand } = await import("../../permissions/permission-mode-apply.js");
      const result = await applyPermissionModeCommand(outcome.cmd, {
        permissionManager: pm,
        approvalGate: self.deps.approvalGate,
        auditLogger: self.deps.auditLogger,
        approvalBypass: {
          source: "builtin-slash",
          trustOrigin: "user-keyboard",
          explicitUserAction: true,
        },
      });
      if (!result.ok) return t("be_conversationLoop.permissionModeCancelled", { message: result.message ?? result.error });
      callbacks?.onPermissionModeChanged?.(result.mode);
      return t("be_conversationLoop.permissionModeChanged", {
        previous: result.previous,
        mode: result.mode,
        durability: result.durable ? t("be_conversationLoop.permissionModeDurable") : t("be_conversationLoop.permissionModeSession"),
      });
    }
    if (outcome.kind === "rules") {
      const pm = self.deps.permissionManager;
      if (!pm) return t("be_conversationLoop.permissionRulesNoManager");
      if (outcome.cmd.sub === "add") {
        if (outcome.cmd.action === "allow") {
          await pm.addAlwaysAllowedPersist(outcome.cmd.pattern);
        } else {
          await pm.addAlwaysDeniedPersist(outcome.cmd.pattern);
        }
        self.deps.toolRegistry.setDenyRules(pm.getVisibilityDenyRules());
        return t("be_conversationLoop.permissionRuleAdded", { action: outcome.cmd.action, pattern: outcome.cmd.pattern });
      }
      if (outcome.cmd.sub === "remove") {
        await pm.removeRule(outcome.cmd.pattern, outcome.cmd.action);
        self.deps.toolRegistry.setDenyRules(pm.getVisibilityDenyRules());
        return t("be_conversationLoop.permissionRuleRemoved", { action: outcome.cmd.action, pattern: outcome.cmd.pattern });
      }
      const rules = await pm.listPersistedRules();
      return rules.length
        ? rules.map((rule) => `- ${rule.action} ${rule.pattern}${rule.source ? ` [${rule.source}]` : ""}`).join("\n")
        : t("be_conversationLoop.permissionRulesEmpty");
    }
    if (outcome.kind !== "hooks") {
      return t("be_conversationLoop.permissionUnhandled", { kind: outcome.kind });
    }

    const result = await dispatchPermissionHooksCommand(outcome.cmd, {
      ...self.deps.hookTrustCommandOptions,
      manager: self.deps.scriptHookManager,
    });
    if (!result.ok) return t("be_conversationLoop.hookTrustError", { error: result.error });
    if (result.verb === "list") {
      const active = result.active.length === 0
        ? t("be_conversationLoop.hookListActiveEmpty")
        : result.active.map((h) => [`- active ${h.fileName} [${h.state}]`,
          ...(h.errors ?? []).map((error) => `  - ${error}`)].join("\n")).join("\n");
      const disabled = result.disabled.length === 0
        ? t("be_conversationLoop.hookListDisabledEmpty")
        : result.disabled.map((h) => [`- disabled ${h.fileName}`,
          ...(h.errors ?? []).map((error) => `  - ${error}`)].join("\n")).join("\n");
      return t("be_conversationLoop.hookTrustStatus", { active, disabled });
    }
    // Successful trust mutations must broadcast to permission views in every window; reads do not.
    self.deps.broadcastPermissionConfigChanged?.();
    if (result.verb === "accept") {
      return t("be_conversationLoop.hookAccepted", { fileName: result.accepted.fileName, count: result.trusted.length });
    }
    if (result.verb === "disable") {
      return t("be_conversationLoop.hookDisabled", { fileName: result.disabled.fileName, count: result.trusted.length });
    }
    return t("be_conversationLoop.hookRejected", { fileName: result.rejected.fileName, count: result.trusted.length });
  }
