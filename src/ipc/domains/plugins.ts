import { createPluginRetirementPort, type PluginConfigRetention } from "../../plugins/retired-config.js";
import { ContributionTrustReviewStaleError } from "../../plugins/plugin-contribution-trust.js";
import { getAveAppVersion } from "../../shared/app-version.js";
import { dialog, ipcMain, webContents } from "electron";
import { t } from "../../i18n/index.js";
import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { emitEvent as emitHostEvent } from "../../boot/types.js";
import { HOST_ONLY_EMIT_NAMESPACES, canEmitEvent } from "../../plugins/capabilities.js";
import { auditPluginEmitDenial } from "../../plugins/emit-denial-audit.js";
import { PluginDeploymentDeniedError } from "../../plugins/deployment-guard.js";
import { getDeclaredEmittedEvents } from "../../plugins/runtime/manifest-validation.js";
import { stripSecretFields } from "../../plugins/config-schema.js";
import { shouldBlockPluginSecretRead, validateApiKeyLikeSecretValue } from "../../plugins/secret-shape.js";
import { emitPluginConfigChange, SECRET_REDACTED_SENTINEL } from "../../plugins/config-change-bus.js";
import { latestBootstrapStatus } from "../../boot/bootstrap-status.js";
import { isDevModeUnlocked, isE2eTestRuntime } from "../../boot/dev-flags.js";
import {
  IPC_NOTIFICATION_CLICKED,
  NOTIFICATION_KINDS,
  type NotificationContextRef,
  type NotificationKind,
} from "../../main/notification-service.js";
import { validateHostRendererSender, UNAUTHORIZED_FRAME, auditUnauthorized, validatePluginFrame } from "../gated.js";
import { CHANNELS } from "../../contract/app-contract.js";
import type { IpcDeps } from "../types.js";
import { sendToWindow } from "../safe-send.js";
import { broadcastToAppWindows } from "../window-fanout.js";
import { createLogger } from "../../lib/logger.js";
import { logPluginLifecycle, PluginPhase } from "../../plugins/lifecycle-log.js";
import { redactFsPath, redactAuditPayload } from "../../audit/dlp-filter.js";
import {
  cloneThemePayload,
  getLastThemePayload,
  recordValidatedTheme,
  resetLastThemePayloadForTests,
  validateThemePayload,
  type SafeThemePayload,
} from "../../shared/plugin-theme-cache.js";
import {
  installPluginAssetProtocolHandler,
  pluginAssetUrlFromRealPath,
} from "../../main/plugin-asset-protocol.js";
import { pluginPartitionName } from "../../shared/plugin-partition.js";
import {
  installMcpAppPartitionPolicy,
  installPluginPartitionPolicy,
} from "../../main/html-preview-partition.js";
import { createMcpAppProxySession, disposeMcpAppProxySession } from "../../main/mcp-app-protocol.js";
import { resolveMcpUiBackend } from "../../mcp/mcp-ui-backend-resolver.js";
import {
  createExternalToolCallSource,
  createLoopbackToolCallSource,
} from "../../mcp/mcp-ui-tool-call.js";
import type { McpAuthErrorCode, McpUiResourceBundle, McpUiToolCallOutcome } from "../../mcp/types.js";

/** A settings-row id for a plugin-bundled server that is not running (see `bundledConfigId`). */
function isBundledMcpConfigId(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 1024) return false;
  try { return parseBundledConfigId(value) !== null; }
  catch { return false; }
}

/** Authorization outcomes the renderer may see; anything else collapses to a generic failure. */
const MCP_AUTH_ERROR_CODES: ReadonlySet<McpAuthErrorCode> = new Set<McpAuthErrorCode>([
  "mcp-auth-required", "mcp-auth-failed", "mcp-auth-storage-unavailable",
  "mcp-auth-storage-unreadable", "mcp-auth-registration-unsupported", "mcp-auth-resource-mismatch",
  "mcp-auth-index-unreadable",
]);
import type { ClaudeDesktopImportFailure } from "../../mcp/claude-desktop-import.js";
import { parseUiMessageIntent, type McpUiMessageOutcome } from "../../mcp/mcp-ui-message.js";
import { parseMcpAppDownload, type McpUiDownloadOutcome } from "../../mcp/mcp-app-download.js";
import type { McpUiModelContextOutcome } from "../../mcp/mcp-app-model-context.js";
import { appMessageSource, formatAppMessageEnvelope, isAppMessageOrigin } from "../../shared/mcp-app-message-source.js";
import { formatStagedEnvelope, stagedOriginFor } from "../../shared/staged-origins.js";
import { renderMcpPrompt } from "../../mcp/mcp-prompt-render.js";
import { renderResourceAttachment } from "../../mcp/mcp-resource-attachment.js";
import { isUsableResourceUri } from "../../shared/mcp-resource-bounds.js";
import {
  isUsableResourceUriTemplate,
  isUsableTemplateVariableName,
  MCP_RESOURCE_TEMPLATE_MAX_VARIABLES,
  MCP_RESOURCE_TEMPLATE_VALUE_MAX_CHARS,
} from "../../shared/mcp-resource-template-bounds.js";
import { isUsableMcpServerId } from "../../shared/mcp-app-partition.js";
import { parseBundledConfigId } from "../../mcp/bundled-credential.js";
import { scrubShortError } from "../../shared/dlp.js";
import {
  isUsablePromptName,
  MCP_PROMPT_ARG_NAME_MAX_CHARS,
  MCP_PROMPT_ARG_VALUE_MAX_CHARS,
  MCP_PROMPT_NAME_MAX_CHARS,
} from "../../shared/mcp-prompt-bounds.js";
// App-message staging shares the plugin proposal rate limiter and overlay channel.
import {
  deriveOverlaySummaryForDisplay,
  triggerConversationRateLimiter,
  userPromptRateLimiter,
} from "../../boot/steps/plugin-runtime/trigger-gate.js";
import { OVERLAY_V1 } from "../../shared/ipc-channels.js";
import {
  drainPluginInstallLockOperations,
  withPluginInstallLock,
} from "../../plugins/install-lifecycle.js";
import { shouldRestartAfterPluginConfigWrite } from "../../plugins/config-restart-policy.js";
import {
  ensurePluginStateReadyForInstall,
  uninstallPluginWithLifecycle,
} from "../../plugins/uninstall-lifecycle.js";
import { buildInstallFailureResult } from "../../shared/plugin-install-result.js";
import {
  ProcessEntryRequiresPinnedArtifactError,
  ProcessEntryUnconfinedError,
  PROCESS_ENTRY_REQUIRES_PINNED_ARTIFACT_CODE,
  PROCESS_ENTRY_UNCONFINED_CODE,
} from "../../plugins/process-entry.js";
import { aveHome } from "../../shared/ave-home.js";
import { isPathWithin } from "../../plugins/plugin-storage-containment.js";
import {
  handlePluginBundleE2eSnapshot,
  handlePluginCards,
} from "../handlers/plugins.js";
import { errorMessage } from "../../shared/error-message.js";
const log = createLogger("ave");

export {
  getLastThemePayload,
  recordValidatedTheme,
  validateThemePayload,
};
export type { SafeThemePayload };

function pluginConfigError(
  error: string,
  message: string,
): { ok: false; error: string; message: string } {
  return { ok: false, error, message };
}

// Report only refusals recorded by this restart; older failures cannot explain a newer attempt.
function runtimeReloadFailureMessage(
  pluginRuntime: Pick<IpcDeps["pluginRuntime"], "listPluginCards">,
  pluginId: string,
  saved: "config" | "secret",
  result: string | undefined,
  attemptedAt: string,
): string {
  const prefix = saved === "config" ? "Plugin config saved" : "Plugin secret saved";
  const refusal = pluginRuntime.listPluginCards()
    .find((card) => card.id === pluginId || card.installAliases?.includes(pluginId))
    ?.lastAttemptRefusal;
  if (result === "failed" && refusal?.attempt === "restart" && refusal.at >= attemptedAt) {
    return `${prefix} but runtime reload refused: ${refusal.message}`;
  }
  return `${prefix} but runtime reload returned ${result ?? "not-loaded"}`;
}

function asPlainRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return {};
}

function sanitizeNotificationContextRef(value: unknown): NotificationContextRef | undefined {
  const input = asPlainRecord(value);
  const contextRef: NotificationContextRef = {};
  for (const key of ["sessionId", "routineId", "questionId", "approvalId"] as const) {
    const candidate = input[key];
    if (typeof candidate === "string" && candidate.length > 0) {
      contextRef[key] = candidate.slice(0, 256);
    }
  }
  return Object.keys(contextRef).length > 0 ? contextRef : undefined;
}

// Plugin callbacks may throw non-Error values; normalize them for logging.
function errMessage(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

function validateSecretConfigValue(
  pluginId: string,
  key: string,
  value: string,
): { ok: false; error: string; message: string } | null {
  if (validateApiKeyLikeSecretValue({ key, value })) {
    return pluginConfigError(
      "plugin-config-secret-invalid-value",
      `Plugin '${pluginId}' secret field '${key}' looks like an endpoint URL. Save endpoint URLs in the matching URL/baseUrl field, not in the API key field.`,
    );
  }
  return null;
}
interface PluginWebviewBinding {
  pluginId: string;
  /** Exact runtime generation that minted this renderer authority. */
  generationId: string;
  entryUrl: string;
  assetEntryUrl: string;
  /** Host-minted authority scope; never accepted from the renderer/plugin. */
  appSessionId: string;
  runtimeRevision: number;
}
const pluginWebviewRegistry = new Map<number, PluginWebviewBinding>();

// Publish one host theme event alongside direct webview delivery.
export function publishHostThemeChanged(safe: SafeThemePayload): void {
  emitHostEvent("host.theme.changed", cloneThemePayload(safe));
}

// Replay cached tokens on registration so a new webview paints the active theme immediately.
export function replayThemeToWebview(webContentsId: number): SafeThemePayload | null {
  const theme = getLastThemePayload();
  if (!theme) return null;
  try {
    const wc = webContents.fromId(webContentsId);
    if (wc && !wc.isDestroyed()) {
      wc.send(CHANNELS.pluginBridge.event, "host.theme.changed", theme);
      return theme;
    }
  } catch {
  }
  return null;
}

export function __resetLastThemePayloadForTests(): void {
  resetLastThemePayloadForTests();
}

// Queue entry-URL reads until registration: first attach runs preload, and shell startup can outrun host registration.
// Return not-registered when the bounded wait expires.
const PENDING_ENTRY_URL_DEADLINE_MS = 5_000;
type PendingEntryUrlResolver = (
  reply: { ok: true; entryUrl: string } | { ok: false; error: "not-registered" },
) => void;
const pendingEntryUrlResolvers = new Map<number, Set<PendingEntryUrlResolver>>();

function flushPendingEntryUrl(webContentsId: number, binding: PluginWebviewBinding): void {
  const resolvers = pendingEntryUrlResolvers.get(webContentsId);
  if (!resolvers) return;
  pendingEntryUrlResolvers.delete(webContentsId);
  for (const resolve of resolvers) resolve({ ok: true, entryUrl: binding.assetEntryUrl });
}

function clearPendingEntryUrl(webContentsId: number): void {
  const resolvers = pendingEntryUrlResolvers.get(webContentsId);
  if (!resolvers) return;
  pendingEntryUrlResolvers.delete(webContentsId);
  for (const resolve of resolvers) resolve({ ok: false, error: "not-registered" });
}

export function unregisterPluginWebview(
  webContentsId: number,
  revokeSession: (appSessionId: string) => void,
): void {
  const binding = pluginWebviewRegistry.get(webContentsId);
  if (binding) revokeSession(binding.appSessionId);
  pluginWebviewRegistry.delete(webContentsId);
  clearPendingEntryUrl(webContentsId);
}

/** Revoke every renderer authority minted by a superseded plugin generation. */
export function revokePluginWebviewsForPlugin(
  pluginId: string,
  revokeSession: (appSessionId: string) => void,
): void {
  for (const [webContentsId, binding] of pluginWebviewRegistry) {
    if (binding.pluginId !== pluginId) continue;
    revokeSession(binding.appSessionId);
    pluginWebviewRegistry.delete(webContentsId);
    clearPendingEntryUrl(webContentsId);
  }
}

// Share install-state preparation and cleanup between IPC and marketplace lifecycles.
export function pluginLifecycleServices(deps: IpcDeps) {
  const retirement = createPluginRetirementPort({
    settings: deps.settingsService,
    marketplace: deps.pluginMarketplace,
    wildcard: () => deps.pluginRuntime.getWildcardConfigOverride(),
    appVersion: getAveAppVersion,
  });
  const {
    pluginRuntime,
    pluginMarketplace,
    settingsService,
    refreshPluginEventBridge,
    pluginPaths,
    clearAuthPartitionService,
    listPluginAuthPartitionsService,
    forgetPluginAuthPartitionsService,
  } = deps;
  const requireCleanupServices = () => {
    if (
      !pluginPaths
      || !clearAuthPartitionService
      || !listPluginAuthPartitionsService
      || !forgetPluginAuthPartitionsService
    ) {
      throw new Error("plugin lifecycle cleanup services are not fully wired");
    }
    return {
      pluginPaths,
      clearAuthPartitionService,
      listPluginAuthPartitionsService,
      forgetPluginAuthPartitionsService,
    };
  };
  const ensureInstallStateReady = (pluginId: string) => {
    const cleanupServices = requireCleanupServices();
    return ensurePluginStateReadyForInstall(pluginId, {
      pluginMarketplace,
      pluginRuntime,
      settingsService,
      retirement,
      ...cleanupServices,
      drainPluginInstallLockOperationsService:
        drainPluginInstallLockOperations,
      refreshPluginEventBridge,
      emitHostEvent,
      log,
    });
  };
  /** Uninstall through the runtime generation barrier with journaled cleanup (see the uninstall handler). */
  const uninstall = (pluginId: string, retain?: PluginConfigRetention) =>
    uninstallPluginWithLifecycle(pluginId, {
      pluginMarketplace,
      pluginRuntime,
      settingsService,
      ...requireCleanupServices(),
      retirement,
      drainPluginInstallLockOperationsService:
        drainPluginInstallLockOperations,
      refreshPluginEventBridge,
      emitHostEvent,
      // Its MCP sign-ins go the moment the registry stops naming it, whatever is reinstalled under the same id later.
      onRegistryRemovalCommitted: (removed) => void deps.mcpManager.reconcileBundledCredentials("plugin", { removed }),
      log,
    }, retain);
  return { ensureInstallStateReady, uninstall, retirement };
}

export function registerPluginsHandlers(deps: IpcDeps): void {
  const {
    pluginRuntime,
    pluginMarketplace,
    settingsService,
    auditLogger,
    refreshPluginEventBridge,
    getMainWindow,
  } = deps;
  const broadcastPluginLifecycleEvent = (channel: string, payload: unknown) => {
    broadcastToAppWindows(deps, channel, payload, { logger: log });
  };
  const { ensureInstallStateReady, uninstall: uninstallPlugin } = pluginLifecycleServices(deps);
  // Retain bootstrap status for windows that miss events while the splash document is loaded.
  ipcMain.handle(CHANNELS.bootstrap.statusGet, (e) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.bootstrap.statusGet, e);
      return null;
    }
    return latestBootstrapStatus();
  });

  ipcMain.handle(CHANNELS.plugins.uninstall, async (e, pluginId: string) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.plugins.uninstall, e); return UNAUTHORIZED_FRAME; }
    const broadcastUninstallResult = (payload: { slug: string; success: boolean; error?: string }) => {
      broadcastPluginLifecycleEvent(CHANNELS.plugins.uninstallResult, payload);
    };
    try {
      // Remove marketplace state inside the generation barrier before journaled config, secret, and auth cleanup.
      const result = await uninstallPlugin(pluginId);
      broadcastUninstallResult({ slug: pluginId, success: true });
      return result;
    } catch (err) {
      const message = (err as Error).message ?? "uninstall failed";
      broadcastUninstallResult({ slug: pluginId, success: false, error: message });
      throw err;
    }
  });

  // Disable drains the generation; re-enable verifies installed bytes before publishing a live pointer.
  ipcMain.handle(
    CHANNELS.plugins.setEnabled,
    async (e, pluginId: unknown, enabled: unknown) => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.plugins.setEnabled, e);
        return UNAUTHORIZED_FRAME;
      }
      if (typeof pluginId !== "string" || pluginId.length === 0) {
        return pluginConfigError("invalid-plugin-id", "pluginId must be a non-empty string");
      }
      if (typeof enabled !== "boolean") {
        return pluginConfigError("invalid-enabled", "enabled must be a boolean");
      }
      try {
        await pluginRuntime.setPluginEnabled(pluginId, enabled);
      } catch (err) {
        const message = errMessage(err);
        if (err instanceof PluginDeploymentDeniedError) {
          // Log deployment-policy details internally; return a stable renderer refusal.
          log.warn(`plugin enabled-state change denied (${pluginId}): %s`, message);
          return pluginConfigError(
            "disable-not-permitted",
            t("mainDialog.pluginDisableNotPermitted"),
          );
        }
        if (message.startsWith("Plugin not found")) {
          return pluginConfigError("no-such-plugin", `unknown plugin: ${pluginId}`);
        }
        log.error(`plugin enabled-state change failed (${pluginId}): %s`, message);
        return pluginConfigError("toggle-failed", "plugin enabled state could not be changed");
      }
      emitHostEvent("plugin.enabled-changed", { pluginId, enabled });
      broadcastPluginLifecycleEvent(CHANNELS.plugins.enabledChanged, { pluginId, enabled });
      return { ok: true, pluginId, enabled } as const;
    },
  );

  ipcMain.handle(CHANNELS.plugins.installLocal, async (e) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.plugins.installLocal, e); return UNAUTHORIZED_FRAME; }
    if (!isDevModeUnlocked()) {
      throw new Error("[security] dev mode not unlocked — enable a supported AVE_DEV* flag in a non-packaged build");
    }
    const { filePaths, canceled } = await dialog.showOpenDialog({
      title: t("mainDialog.installLocalPluginTitle"),
      properties: ["openDirectory"],
      message: t("mainDialog.installLocalPluginMessage"),
    });
    if (canceled || !filePaths[0]) return null;
    // Stage immutable candidate bytes before changing live payload, receipt, registry, or generation.
    const pluginId = await pluginMarketplace.resolveLocalInstallPluginId(filePaths[0]);
    pluginRuntime.cancelPendingRestart(pluginId);
    return await withPluginInstallLock(pluginId, async () => {
      try {
        await ensureInstallStateReady(pluginId);
        const result = await pluginMarketplace.installLocal(filePaths[0], {
          activatePreparedArtifact: (prepared) => pluginRuntime.activatePreparedArtifact<string>(prepared),
        });
        if (!pluginRuntime.listPluginIds().includes(result.pluginId)) {
          throw new Error(`atomic local install committed without active runtime: ${result.pluginId}`);
        }
        emitHostEvent("plugin.installed", { pluginId: result.pluginId, source: "local-dev" });
        refreshPluginEventBridge?.();
        broadcastPluginLifecycleEvent(CHANNELS.plugins.installResult, {
          slug: result.pluginId,
          success: true,
        });
        return result;
      } catch (err) {
        broadcastPluginLifecycleEvent(
          CHANNELS.plugins.installResult,
          buildInstallFailureResult(pluginId, err, "addPlugin failed"),
        );
        if (err instanceof ProcessEntryUnconfinedError) {
          return { ok: false, error: PROCESS_ENTRY_UNCONFINED_CODE } as const;
        }
        if (err instanceof ProcessEntryRequiresPinnedArtifactError) {
          return { ok: false, error: PROCESS_ENTRY_REQUIRES_PINNED_ARTIFACT_CODE } as const;
        }
        throw err;
      }
    });
  });

  ipcMain.handle(CHANNELS.plugins.uiList, () => pluginRuntime.listUiExtensions());

  ipcMain.handle(CHANNELS.plugins.uiReadModule, async (e, payload?: { pluginId?: string; viewId?: string }) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.plugins.uiReadModule, e);
      throw new Error("Unauthorized renderer frame for ave:plugins:ui:read-module");
    }

    const pluginId = payload?.pluginId?.trim();
    const viewId = payload?.viewId?.trim();
    if (!pluginId || !viewId) {
      throw new Error("pluginId and viewId are required to load a plugin UI module.");
    }

    const view = pluginRuntime
      .listUiExtensions()
      .find((item) => item.pluginId === pluginId && item.extension.id === viewId);
    if (!view?.entryUrl) {
      throw new Error(`Plugin UI entry not found (plugin=${pluginId}, view=${viewId}).`);
    }
    if (!view.entryUrl.startsWith("file:")) {
      throw new Error(`Plugin UI entry is not file-backed (plugin=${pluginId}, view=${viewId}).`);
    }

    const entryPath = fileURLToPath(view.entryUrl);

    const rawPluginRoot = pluginRuntime.getPluginRoot(pluginId);
    if (!rawPluginRoot) {
      throw new Error(`Plugin root not found (plugin=${pluginId}).`);
    }
    const pluginRoot = realpathSync(rawPluginRoot);
    let resolvedEntryPath: string;
    try {
      resolvedEntryPath = realpathSync(entryPath);
    } catch {
      throw new Error(`Plugin UI entry path could not be resolved (plugin=${pluginId}).`);
    }
    if (!isPathWithin(pluginRoot, resolvedEntryPath)) {
      throw new Error(`Plugin UI entry path escapes plugin directory (plugin=${pluginId}).`);
    }
    return readFile(resolvedEntryPath, "utf-8");
  });

  ipcMain.handle(CHANNELS.plugins.cards, () => handlePluginCards(deps));

  ipcMain.handle(CHANNELS.plugins.contributionTrustList, (e, pluginId?: unknown) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.plugins.contributionTrustList, e);
      return UNAUTHORIZED_FRAME;
    }
    if (pluginId !== undefined && (typeof pluginId !== "string" || pluginId.length === 0)) {
      return { ok: false, error: "invalid-plugin-id" };
    }
    const lifecycle = deps.pluginBundleLifecycle;
    if (!lifecycle) return { ok: false, error: "plugin-bundle-lifecycle-unavailable" };
    return {
      ok: true,
      rows: lifecycle.listContributionTrust(pluginId as string | undefined),
    };
  });

  ipcMain.handle(CHANNELS.plugins.contributionTrustSet, async (e, input: unknown) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.plugins.contributionTrustSet, e);
      return UNAUTHORIZED_FRAME;
    }
    const value = asPlainRecord(input);
    const pluginId = value.pluginId;
    const localId = value.localId;
    const kind = value.kind;
    const approved = value.approved;
    if (
      typeof pluginId !== "string" || !pluginId ||
      typeof localId !== "string" || !localId ||
      (kind !== "hook" && kind !== "mcpServer") ||
      typeof approved !== "boolean"
    ) {
      return { ok: false, error: "invalid-contribution-trust-request" };
    }
    // Approval binds the reviewed generation and digest; revocation only narrows trust.
    const generationId = value.generationId;
    const approvalDigest = value.approvalDigest;
    const sha256 = /^[a-f0-9]{64}$/u;
    if (approved
      ? typeof generationId !== "string" || !sha256.test(generationId) || !(approvalDigest === null || (typeof approvalDigest === "string" && sha256.test(approvalDigest)))
      : generationId !== undefined || approvalDigest !== undefined) {
      return { ok: false, error: "invalid-contribution-trust-request" };
    }
    const lifecycle = deps.pluginBundleLifecycle;
    if (!lifecycle) return { ok: false, error: "plugin-bundle-lifecycle-unavailable" };
    try {
      const binding = approved ? { generationId: generationId as string, approvalDigest: approvalDigest as string | null } : null;
      if (kind === "hook") {
        if (binding) await lifecycle.approveHook(pluginId, localId, binding);
        else await lifecycle.revokeHook(pluginId, localId);
      } else if (binding) {
        await lifecycle.approveMcpServer(pluginId, localId, binding);
      } else {
        await lifecycle.revokeMcpServer(pluginId, localId);
      }
      return { ok: true, pluginId, localId, kind, approved };
    } catch (error) {
      if (error instanceof ContributionTrustReviewStaleError) return { ok: false, error: "contribution-trust-review-stale", message: errMessage(error) };
      return { ok: false, error: "contribution-trust-update-failed", message: errMessage(error) };
    }
  });

  ipcMain.handle(CHANNELS.runtime.counts, (e) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.runtime.counts, e); return UNAUTHORIZED_FRAME; }
    return {
      // Count model-visible tools; registry size also includes app-only and auth tools.
      tools: deps.toolRegistry.getModelVisibleTools().length,
      plugins: pluginRuntime.listPluginIds().length,
      mcps: deps.mcpManager.listServers().filter((s) => s.status === "connected").length,
    };
  });

  ipcMain.handle(CHANNELS.runtime.env, async (e) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.runtime.env, e); return UNAUTHORIZED_FRAME; }
    const os = await import("node:os");
    return {
      platform: process.platform,
      hostname: os.hostname(),
      user: os.userInfo().username,
    };
  });

  ipcMain.handle(CHANNELS.agents.list, async (e) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.agents.list, e);
      return UNAUTHORIZED_FRAME;
    }
    const agents = (await deps.agentProfileStore?.list() ?? []).map((agent) => ({
      name: agent.name,
      description: agent.description,
      sourceTools: agent.sourceTools,
      triggers: agent.triggers,
      ...(agent.model ? { model: agent.model } : {}),
      ...(agent.mode ? { mode: agent.mode } : {}),
    }));
    return { agents };
  });

  ipcMain.handle(CHANNELS.skills.list, async (e) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.skills.list, e);
      return UNAUTHORIZED_FRAME;
    }
    const skills = deps.skillStore?.listCatalogSync() ?? [];
    return { skills };
  });

  ipcMain.handle(CHANNELS.agents.uninstall, async (e, slug: string) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.agents.uninstall, e);
      return UNAUTHORIZED_FRAME;
    }
    const trimmed = typeof slug === "string" ? slug.trim() : "";
    if (!trimmed) return { ok: false, error: "invalid-slug", message: "slug is required" } as const;
    try {
      const { uninstallAgentPackage } = await import("../../agents/agent-installer.js");
      const result = await uninstallAgentPackage(trimmed, {
        installRoot: path.resolve(aveHome(), "agents"),
        registryPath: path.resolve(aveHome(), "agents", "registry.json"),
      });
      emitHostEvent("agent.uninstalled", { agentId: result.agentId, slug: result.slug, source: "marketplace" });
      broadcastPluginLifecycleEvent(CHANNELS.agents.uninstallResult, {
        slug: result.slug,
        agentId: result.agentId,
        success: true,
      });
      return { ok: true as const, slug: result.slug, agentId: result.agentId, uninstalled: true as const };
    } catch (err) {
      const message = (err as Error).message ?? "Agent uninstall failed";
      broadcastPluginLifecycleEvent(
        CHANNELS.agents.uninstallResult,
        buildInstallFailureResult(trimmed, err, "Agent uninstall failed"),
      );
      return { ok: false as const, error: "uninstall-failed", message };
    }
  });

  ipcMain.handle(CHANNELS.skills.uninstall, async (e, slug: string) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.skills.uninstall, e);
      return UNAUTHORIZED_FRAME;
    }
    const trimmed = typeof slug === "string" ? slug.trim() : "";
    if (!trimmed) return { ok: false, error: "invalid-slug", message: "slug is required" } as const;
    try {
      const { uninstallSkillPackage } = await import("../../skills/skill-installer.js");
      const result = await uninstallSkillPackage(trimmed, {
        installRoot: path.resolve(aveHome(), "skills"),
        registryPath: path.resolve(aveHome(), "skills", "registry.json"),
      });
      emitHostEvent("skill.uninstalled", { skillId: result.skillId, slug: result.slug, source: "marketplace" });
      broadcastPluginLifecycleEvent(CHANNELS.skills.uninstallResult, {
        slug: result.slug,
        skillId: result.skillId,
        success: true,
      });
      return { ok: true as const, slug: result.slug, skillId: result.skillId, uninstalled: true as const };
    } catch (err) {
      const message = (err as Error).message ?? "Skill uninstall failed";
      broadcastPluginLifecycleEvent(
        CHANNELS.skills.uninstallResult,
        buildInstallFailureResult(trimmed, err, "Skill uninstall failed"),
      );
      return { ok: false as const, error: "uninstall-failed", message };
    }
  });

  ipcMain.handle(CHANNELS.plugins.configGet, (e, pluginId: string) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.plugins.configGet, e);
      return pluginConfigError("unauthorized-frame", t("mainDialog.unauthorizedFrame"));
    }
    try {
      return { ok: true as const, config: settingsService.getPluginConfig(pluginId) };
    } catch (err) {
      return pluginConfigError("invalid-plugin-config-request", (err as Error).message);
    }
  });

  ipcMain.handle(CHANNELS.plugins.configSet, async (e, pluginId: string, config: unknown) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.plugins.configSet, e);
      return pluginConfigError("unauthorized-frame", t("mainDialog.unauthorizedFrame"));
    }
    try {
      const persisted = await withPluginInstallLock(pluginId, async () => {
        const manifest = pluginRuntime.getPluginManifest(pluginId);
        if (!manifest) {
          throw new Error(`Plugin not found: ${pluginId}`);
        }
        const schema = manifest?.configSchema;
        const stripped = stripSecretFields(schema, asPlainRecord(config));
        const previous = settingsService.getPluginConfig(pluginId) ?? {};
        const savedConfig = await settingsService.setPluginConfig(pluginId, stripped);
        pluginRuntime.setConfigOverride(pluginId, savedConfig);
        const observed = new Set<string>([
          ...Object.keys(savedConfig ?? {}),
          ...Object.keys(previous ?? {}),
        ]);
        for (const k of observed) {
          emitPluginConfigChange(pluginId, k, savedConfig?.[k]);
        }
        return { manifest, savedConfig };
      });
      // Host config writes may restart safely; see plugins/config-restart-policy.ts.
      if (pluginRuntime.getPluginManifest(pluginId) !== persisted.manifest) {
        throw new Error(`Plugin instance changed before config reload: ${pluginId}`);
      }
      const restartAttemptedAt = new Date().toISOString();
      const restartResult = await pluginRuntime.restartPlugin(
        pluginId,
        { skipPreparation: true },
      );
      if (restartResult !== "started") {
        throw new Error(runtimeReloadFailureMessage(pluginRuntime, pluginId, "config", restartResult, restartAttemptedAt));
      }
      return { ok: true as const, config: persisted.savedConfig };
    } catch (err) {
      return pluginConfigError("plugin-config-save-failed", (err as Error).message);
    }
  });

  ipcMain.handle(CHANNELS.plugins.configSchemaGet, (e, pluginId: string) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.plugins.configSchemaGet, e);
      return pluginConfigError("unauthorized-frame", t("mainDialog.unauthorizedFrame"));
    }
    try {
      const manifest = pluginRuntime.getPluginManifest(pluginId);
      return { ok: true as const, schema: manifest?.configSchema ?? null };
    } catch (err) {
      return pluginConfigError("plugin-config-schema-load-failed", (err as Error).message);
    }
  });

  ipcMain.handle(CHANNELS.plugins.configSecretSet, async (e, pluginId: string, key: string, value: string) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.plugins.configSecretSet, e);
      return pluginConfigError("unauthorized-frame", t("mainDialog.unauthorizedFrame"));
    }
    try {
      const safePluginId = pluginId.trim();
      if (!/^[A-Za-z][A-Za-z0-9._-]{0,127}$/.test(safePluginId)) {
        return pluginConfigError("plugin-config-secret-invalid-plugin-id", `Invalid pluginId: ${pluginId}`);
      }
      const secretValue = String(value ?? "");
      const validationError = validateSecretConfigValue(safePluginId, key, secretValue);
      if (validationError) return validationError;
      const persisted = await withPluginInstallLock(safePluginId, async () => {
        const manifest = pluginRuntime.getPluginManifest(safePluginId);
        const prop = manifest?.configSchema?.properties?.[key];
        if (!prop || prop.type !== "string" || prop.format !== "secret") {
          return pluginConfigError(
            "plugin-config-secret-invalid-key",
            `Plugin '${safePluginId}' configSchema does not declare a secret field '${key}'.`,
          );
        }
        await settingsService.setSecret(`plugin.${safePluginId}.${key}`, secretValue);
        const current = settingsService.getPluginConfig(safePluginId) ?? {};
        // An update can mark an existing plaintext key secret, leaving a cleartext copy to remove.
        let mutatedCleartextConfig = false;
        if (key in current) {
          const next = { ...current };
          delete next[key];
          await settingsService.setPluginConfig(safePluginId, next);
          pluginRuntime.setConfigOverride(safePluginId, next);
          mutatedCleartextConfig = true;
        }
        emitPluginConfigChange(safePluginId, key, SECRET_REDACTED_SENTINEL);
        return { ok: true as const, manifest, mutatedCleartextConfig };
      });
      if (!persisted.ok) return persisted;
      if (!persisted.mutatedCleartextConfig) return { ok: true as const };
      // Removing a cleartext secret invalidates the plugin's start-time config snapshot.
      if (
        !shouldRestartAfterPluginConfigWrite({
          mutatedCleartextConfig: true,
          restartUnsafe: false,
        })
      ) {
        return persisted;
      }
      if (pluginRuntime.getPluginManifest(safePluginId) !== persisted.manifest) {
        throw new Error(`Plugin instance changed before secret reload: ${safePluginId}`);
      }
      const restartAttemptedAt = new Date().toISOString();
      const restartResult = await pluginRuntime.restartPlugin(
        safePluginId,
        { skipPreparation: true },
      );
      if (restartResult !== "started") {
        throw new Error(runtimeReloadFailureMessage(pluginRuntime, safePluginId, "secret", restartResult, restartAttemptedAt));
      }
      return { ok: true as const };
    } catch (err) {
      return pluginConfigError("plugin-config-secret-save-failed", (err as Error).message);
    }
  });

  ipcMain.handle(CHANNELS.plugins.configSecretListKeys, (e, pluginId: string) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.plugins.configSecretListKeys, e);
      return pluginConfigError("unauthorized-frame", t("mainDialog.unauthorizedFrame"));
    }
    try {
      const manifest = pluginRuntime.getPluginManifest(pluginId);
      const schema = manifest?.configSchema;
      if (!schema?.properties) return { ok: true as const, keys: [] as string[] };
      const presentKeys: string[] = [];
      for (const key of Object.keys(schema.properties)) {
        const prop = schema.properties[key];
        if (prop?.type === "string" && prop.format === "secret") {
          const storageKey = `plugin.${pluginId}.${key}`;
          const stored = settingsService.getSecret(storageKey);
          if (stored !== null && !shouldBlockPluginSecretRead({ pluginId, storageKey, value: stored })) {
            presentKeys.push(key);
          }
        }
      }
      return { ok: true as const, keys: presentKeys };
    } catch (err) {
      return pluginConfigError("plugin-config-secret-list-failed", (err as Error).message);
    }
  });

  ipcMain.handle(CHANNELS.plugins.perfStats, () => pluginRuntime.getPerfStats());

  ipcMain.handle(CHANNELS.plugins.call, (
    e,
    method: string,
    payload?: unknown,
    options?: { userAction?: boolean; operationGrantToken?: string },
  ) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.plugins.call, e); return UNAUTHORIZED_FRAME; }
    return pluginRuntime.callFromUi(method, payload, {
      userAction: options?.userAction === true,
      // Renderer cannot choose the authority-bearing session identity.
      appSessionId: `plugin-ui:${e.sender?.id ?? `${e.processId}:${e.frameId}`}`,
      ...(typeof options?.operationGrantToken === "string"
        ? { operationGrantToken: options.operationGrantToken }
        : {}),
    });
  });

  ipcMain.handle(
    CHANNELS.plugins.e2eBundleSnapshot,
    async (
      e,
      pluginId: unknown,
      skillLocalId: unknown,
      hookProbeToolName: unknown,
    ) => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.plugins.e2eBundleSnapshot, e);
        return UNAUTHORIZED_FRAME;
      }
      if (!isE2eTestRuntime()) {
        return { ok: false as const, error: "production-disabled" };
      }
      return handlePluginBundleE2eSnapshot(
        deps,
        pluginId,
        skillLocalId,
        hookProbeToolName,
      );
    },
  );

  const setApiKeyRateBucket = new Map<string, { count: number; windowStart: number }>();
  const SET_API_KEY_MAX_CALLS = 5;
  const SET_API_KEY_WINDOW_MS = 60_000;

  function checkSetApiKeyRateLimit(serverId: string): boolean {
    // Wall-clock rollback can leave windowStart in the future and lock the bucket until time catches up.
    const now = Date.now();
    // Above the map threshold, evict expired windows to bound abandoned rate-limit entries.
    if (setApiKeyRateBucket.size > 64) {
      for (const [k, b] of setApiKeyRateBucket) {
        if (now - b.windowStart >= SET_API_KEY_WINDOW_MS) {
          setApiKeyRateBucket.delete(k);
        }
      }
    }
    const bucket = setApiKeyRateBucket.get(serverId);
    if (!bucket || now - bucket.windowStart >= SET_API_KEY_WINDOW_MS) {
      setApiKeyRateBucket.set(serverId, { count: 1, windowStart: now });
      return true;
    }
    if (bucket.count >= SET_API_KEY_MAX_CALLS) {
      return false;
    }
    bucket.count += 1;
    return true;
  }

  // Rendering and tool calls share one loopback-first backend resolver so server ownership cannot diverge.
  const mcpUiSources = {
    loopback: {
      has: (serverId: string) => deps.pluginLoopbackManager.has(serverId),
      assertCardGeneration: (serverId: string, generationId: string) =>
        deps.pluginLoopbackManager.assertCardGeneration(serverId, generationId),
      readUiResource: (serverId: string, uri: string) =>
        deps.pluginLoopbackManager.readUiResource(serverId, uri),
      ...createLoopbackToolCallSource({
        runtime: pluginRuntime,
        findTool: (name) => deps.toolRegistry.findByName(name),
      }),
    },
    mcpManager: {
      readUiResource: (serverId: string, uri: string) => deps.mcpManager.readUiResource(serverId, uri),
      ...createExternalToolCallSource({
        namespacedToolName: (serverId, toolName) => deps.mcpManager.namespacedToolName(serverId, toolName),
        findTool: (name) => deps.toolRegistry.findByName(name),
        // Resolve the tool executor per call; boot installs it after IPC registration.
        getInvoker: () => deps.getPluginToolInvoker(),
      }),
    },
  };

  ipcMain.handle(CHANNELS.mcp.servers, (e) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.mcp.servers, e); return UNAUTHORIZED_FRAME; }
    return deps.mcpManager.listServers();
  });
  ipcMain.handle(CHANNELS.mcp.kill, (e, serverId: string) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.mcp.kill, e); return UNAUTHORIZED_FRAME; }
    return deps.mcpManager.killSwitch(serverId);
  });
  ipcMain.handle(CHANNELS.mcp.authenticate, async (e, serverId: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.mcp.authenticate, e); return UNAUTHORIZED_FRAME; }
    if (!isUsableMcpServerId(serverId) && !isBundledMcpConfigId(serverId)) {
      return { connected: false, errorCode: "mcp-auth-failed" };
    }
    try {
      const result = await deps.mcpManager.authenticate(serverId);
      if (result.connected) return { connected: true };
      const errorCode = MCP_AUTH_ERROR_CODES.has(result.errorCode as McpAuthErrorCode) ? result.errorCode : "mcp-auth-failed";
      return { connected: false, errorCode };
    } catch {
      return { connected: false, errorCode: "mcp-auth-failed" };
    }
  });
  ipcMain.handle(CHANNELS.mcp.configGet, (e) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.mcp.configGet, e); return UNAUTHORIZED_FRAME; }
    return deps.mcpManager.getConfigs();
  });
  ipcMain.handle(CHANNELS.mcp.configPath, (e) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.mcp.configPath, e); return UNAUTHORIZED_FRAME; }
    return deps.mcpManager.getConfigPath();
  });
  ipcMain.handle(CHANNELS.mcp.configAdd, async (e, config: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.mcp.configAdd, e); return UNAUTHORIZED_FRAME; }
    return deps.mcpManager.addConfig(config as import("../../mcp/types.js").McpServerConfig);
  });
  ipcMain.handle(CHANNELS.mcp.configSetApiKey, async (e, serverId: string, apiKey: string) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.mcp.configSetApiKey, e); return UNAUTHORIZED_FRAME; }
    if (!checkSetApiKeyRateLimit(String(serverId))) {
      throw new Error("Rate limit exceeded: ave:mcp:config:set-api-key (5/min per server)");
    }
    const bundled = deps.mcpManager.bundledCredentialRefForConfigId(serverId);
    return bundled
      ? deps.mcpManager.setBundledApiKey(bundled.packageRef, bundled.server, apiKey)
      : deps.mcpManager.setApiKey(serverId, apiKey);
  });
  ipcMain.handle(CHANNELS.mcp.configRemove, async (e, serverId: string) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.mcp.configRemove, e); return UNAUTHORIZED_FRAME; }
    return deps.mcpManager.removeConfig(serverId);
  });
  // Rendering has no user-action rate bucket; legitimate card mounts must not starve prompt or attachment requests.
  // Proxy-session capacity and dispose-on-unmount own reclamation.
  ipcMain.handle(CHANNELS.mcp.uiResource, async (e, serverId: string, uri: string, generationId?: string) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.mcp.uiResource, e); return UNAUTHORIZED_FRAME; }
    // Install the server's deny-by-default network gate before reading its resource.
    installMcpAppPartitionPolicy(serverId);

    // Resolve bundled loopback servers first; they are absent from the external client map.
    const backend = resolveMcpUiBackend(serverId, mcpUiSources, generationId);

    // Read CSP from the resource's own metadata, never from renderer input.
    const resource = await backend.readUiResource(uri);
    const proxyUrl = createMcpAppProxySession(serverId, resource.csp, resource.permissions);
    return { proxyUrl, html: resource.html } satisfies McpUiResourceBundle;
  });

  // Require host-renderer identity and server-owned tools; backend visibility checks precede normal risk and consent gates.
  // Use mcp-app provenance without userAction so iframe claims cannot bypass governance.
  ipcMain.handle(CHANNELS.mcp.callTool, async (e, serverId: unknown, name: unknown, args: unknown, generationId?: unknown) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.mcp.callTool, e);
      return UNAUTHORIZED_FRAME;
    }
    if (typeof serverId !== "string" || !serverId.trim()) {
      return { ok: false, error: "invalid-server-id", message: "serverId must be a non-empty string" } satisfies McpUiToolCallOutcome;
    }
    if (typeof name !== "string" || !name.trim()) {
      return { ok: false, error: "invalid-tool-name", message: "tool name must be a non-empty string" } satisfies McpUiToolCallOutcome;
    }

    const backend = resolveMcpUiBackend(
      serverId,
      mcpUiSources,
      typeof generationId === "string" ? generationId : undefined,
    );

    // The bound server must own the requested tool.
    const owner = backend.resolveToolOwner(name);
    if (owner !== serverId) {
      auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: "mcp-app",
        type: "error",
        input: `[mcp-app:${serverId}] cross-server call denied: tool='${name}' owner='${owner ?? "unknown"}'`,
      });
      return {
        ok: false,
        error: "cross-server-call-denied",
        message: `Tool '${name}' is not owned by MCP server '${serverId}'`,
      } satisfies McpUiToolCallOutcome;
    }

    try {
      // The backend enforces app visibility before permission and consent.
      const input = asPlainRecord(args);
      // Mint session authority from host IPC identity and the bound server, never renderer input.
      const appSessionId = `mcp-app:${serverId}:${e.sender?.id ?? `${e.processId}:${e.frameId}`}`;
      const grantTarget = backend.resolveOperationGrantTarget(name, input);
      const grant = grantTarget
        ? await deps.requestPluginOperationGrant({
            pluginId: grantTarget.pluginId,
            toolName: grantTarget.toolName,
            input,
            appSessionId,
            origin: "mcp-app",
            ...(grantTarget.expectedGenerationId
              ? { expectedGenerationId: grantTarget.expectedGenerationId }
              : {}),
          })
        : undefined;
      const result = await backend.callTool(name, input, {
        appSessionId,
        ...(grant ? { operationGrantToken: grant.operationGrantToken } : {}),
      });
      return { ok: true, result } satisfies McpUiToolCallOutcome;
    } catch (err) {
      // Map visibility, permission, and execution failures to one error outcome for the app bridge.
      const message = errMessage(err);
      auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: "mcp-app",
        type: "error",
        input: `[mcp-app:${serverId}] tools/call denied or failed: tool='${name}' reason='${message}'`,
      });
      return { ok: false, error: "tool-call-failed", message } satisfies McpUiToolCallOutcome;
    }
  });

  // App text retains untrusted provenance; active turns queue guidance atomically and idle turns require user confirmation.
  // Notifications share the existing focus, cooldown, and sanitization policy.
  ipcMain.handle(CHANNELS.mcp.uiMessage, async (e, serverId: unknown, cardSessionId: unknown, params: unknown) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.mcp.uiMessage, e);
      return UNAUTHORIZED_FRAME;
    }
    const auditMcpApp = (type: "info" | "error", input: string) => {
      auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: "mcp-app",
        type,
        input,
      });
    };
    if (typeof serverId !== "string" || !isAppMessageOrigin(appMessageSource(serverId))) {
      return { ok: false, error: "invalid-server-id", message: "serverId must be a valid MCP server id" } satisfies McpUiMessageOutcome;
    }
    const source = appMessageSource(serverId);

    if (triggerConversationRateLimiter.isOverCap(serverId)) {
      auditMcpApp("error", `[mcp-app:${serverId}] ui/message rate limited`);
      return { ok: false, error: "rate-limited", message: "too many messages from this app" } satisfies McpUiMessageOutcome;
    }
    triggerConversationRateLimiter.record(serverId);

    const intent = parseUiMessageIntent(params);
    if (intent.kind === "invalid") {
      return { ok: false, error: intent.error, message: intent.message } satisfies McpUiMessageOutcome;
    }

    // The host owns title attribution and delivery policy; app text cannot bypass focus gates or claim urgency.
    const notify = (title: string, body: string, severity?: string): McpUiMessageOutcome => {
      const notificationService = deps.notificationService;
      if (!notificationService) {
        return { ok: false, error: "notification-unavailable", message: "notification service is not running" };
      }
      const appTitle = title.trim();
      notificationService.fire({
        kind: "plugin",
        title: appTitle ? `${source} · ${appTitle}` : source,
        body,
      });
      auditMcpApp(
        "info",
        `[mcp-app:${serverId}] ui/message → notification` +
          (severity ? ` severityClaimed=${severity}` : ""),
      );
      return { ok: true, disposition: "notified" };
    };

    if (intent.kind === "notification") {
      const { title, body, severity } = intent.notification;
      return notify(title, body, severity);
    }

    // Deliver only to a loop still holding the card's session; otherwise use notification delivery.
    const cardSession = typeof cardSessionId === "string" ? cardSessionId : "";
    const cardLoop = cardSession ? deps.findLoopBySessionId(cardSession) : undefined;
    if (!cardLoop) {
      auditMcpApp("info", `[mcp-app:${serverId}] ui/message session mismatch → notification fallback`);
      // No app-authored title on this path — the source tag IS the title.
      return notify("", intent.text);
    }

    const envelope = formatAppMessageEnvelope(intent.text, source);

    // queueGuidance is the atomic active-turn check.
    const queued = cardLoop.queueGuidance(envelope);
    if (queued === "queued") {
      auditMcpApp("info", `[mcp-app:${serverId}] ui/message → guidance queued (active turn)`);
      return { ok: true, disposition: "queued" } satisfies McpUiMessageOutcome;
    }
    if (queued !== "no-active-turn") {
      auditMcpApp("error", `[mcp-app:${serverId}] ui/message guidance rejected: ${queued}`);
      return { ok: false, error: queued, message: `guidance rejected: ${queued}` } satisfies McpUiMessageOutcome;
    }

    // Stage idle messages for confirmation; summary is bounded display text while pendingPrompt retains the full body.
    const eventId = randomUUID();
    const overlayItem = {
      id: `app:${serverId}:${eventId}`,
      source: { kind: "app" as const, serverId, eventId },
      // Address the staged card to its originating conversation so only its owning tile may confirm it.
      originSessionId: cardSession,
      title: serverId,
      summary: deriveOverlaySummaryForDisplay({ prompt: intent.text }),
      running: false,
      pendingPrompt: envelope,
      createdAt: new Date().toISOString(),
    };
    const win = getMainWindow();
    if (!win || win.isDestroyed()) {
      return { ok: false, error: "no-window", message: "host window is unavailable" } satisfies McpUiMessageOutcome;
    }
    sendToWindow(win, OVERLAY_V1.show, overlayItem, log);
    auditMcpApp("info", `[mcp-app:${serverId}] ui/message → staged for user confirmation (no active turn)`);
    return { ok: true, disposition: "staged" } satisfies McpUiMessageOutcome;
  });

  // Return a provenance envelope without starting a turn; ordinary send revalidates it under prompt-emitted origin.
  ipcMain.handle(CHANNELS.mcp.getPrompt, async (e, serverId: unknown, name: unknown, args: unknown) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.mcp.getPrompt, e);
      return UNAUTHORIZED_FRAME;
    }
    const auditPrompt = (type: "info" | "error", input: string) => {
      auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: "mcp-prompt",
        type,
        input,
      });
    };
    // Bound prompt names before audit and server requests using the shared discovery predicate.
    if (typeof serverId !== "string" || !isUsablePromptName(name, MCP_PROMPT_NAME_MAX_CHARS)) {
      return { ok: false, error: "invalid-request" };
    }
    // Validate server identity independently of staged-origin envelope syntax.
    if (!isUsableMcpServerId(serverId)) {
      return { ok: false, error: "invalid-server-id" };
    }
    const kind = stagedOriginFor("mcp-prompt-emitted");
    const source = `mcp-prompt:${serverId}`;
    // Fail closed if server-id and staged-tag validation ever disagree.
    if (!kind.sourcePattern.test(source)) {
      return { ok: false, error: "invalid-server-id" };
    }
    // User-initiated prompt requests need a separate budget from autonomous app proposals.
    if (userPromptRateLimiter.isOverCap(serverId)) {
      auditPrompt("error", `[mcp-prompt:${serverId}] prompts/get rate limited`);
      return { ok: false, error: "rate-limited" };
    }
    userPromptRateLimiter.record(serverId);
    // Keep only allowed string arguments in a null-prototype object so __proto__ cannot change inheritance.
    const promptArgs: Record<string, string> = Object.create(null) as Record<string, string>;
    if (args && typeof args === "object" && !Array.isArray(args)) {
      for (const [key, value] of Object.entries(args as Record<string, unknown>)) {
        if (typeof value === "string" && isUsablePromptName(key, MCP_PROMPT_ARG_NAME_MAX_CHARS)) {
          promptArgs[key] = value.slice(0, MCP_PROMPT_ARG_VALUE_MAX_CHARS);
        }
      }
    }
    try {
      const result = await deps.mcpManager.getPrompt(serverId, name, promptArgs);
      const rendered = renderMcpPrompt(result.blocks, result.description);
      // Report clipping by either the client or renderer.
      const truncated = rendered.truncated || result.droppedBlocks > 0;
      if (rendered.text.length === 0) {
        auditPrompt("error", `[mcp-prompt:${serverId}] prompts/get '${name}' returned no text`);
        return { ok: false, error: "empty-prompt" };
      }
      auditPrompt(
        "info",
        `[mcp-prompt:${serverId}] prompts/get '${name}' → ${rendered.text.length} chars`
          + `${truncated ? " (truncated)" : ""}`
          + `${rendered.omittedBlocks > 0 ? ` (${rendered.omittedBlocks} non-text block(s))` : ""}`,
      );
      return {
        ok: true,
        envelope: formatStagedEnvelope(kind, rendered.text, source),
        truncated,
        omittedBlocks: rendered.omittedBlocks,
      };
    } catch (err) {
      // Scrub and bound server errors before audit storage.
      const message = scrubShortError(errorMessage(err));
      auditPrompt("error", `[mcp-prompt:${serverId}] prompts/get '${name}' failed: ${message}`);
      return { ok: false, error: "prompt-failed" };
    }
  });

  // The host builds untrusted resource fences; attachments remain data under the user's turn origin.
  // Catalog reads use local declared-resource state and consume no server round-trip budget.
  ipcMain.handle(CHANNELS.mcp.listResources, (e) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.mcp.listResources, e);
      return UNAUTHORIZED_FRAME;
    }
    return { ok: true as const, servers: deps.mcpManager.listDeclaredResources() };
  });

  ipcMain.handle(CHANNELS.mcp.attachResource, async (e, serverId: unknown, uri: unknown) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.mcp.attachResource, e);
      return UNAUTHORIZED_FRAME;
    }
    const auditAttach = (type: "info" | "error", input: string) => {
      auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: "mcp-resource",
        type,
        input,
      });
    };
    if (typeof serverId !== "string" || !isUsableResourceUri(uri)) {
      return { ok: false, error: "invalid-request" };
    }
    // Bound server ids before allocating rate keys or storing audit text.
    if (!isUsableMcpServerId(serverId)) {
      return { ok: false, error: "invalid-server-id" };
    }
    if (userPromptRateLimiter.isOverCap(serverId)) {
      auditAttach("error", `[mcp-resource:${serverId}] attach rate limited`);
      return { ok: false, error: "rate-limited" };
    }
    userPromptRateLimiter.record(serverId);
    try {
      const read = await deps.mcpManager.readDeclaredResource(serverId, uri);
      const rendered = renderResourceAttachment(serverId, uri, read);
      // Check the body, not the rendered fence; empty framing is not an attachment.
      if (rendered.bodyChars === 0) {
        auditAttach("error", `[mcp-resource:${serverId}] read returned no text`);
        return { ok: false, error: "empty-resource" };
      }
      auditAttach(
        "info",
        `[mcp-resource:${serverId}] attached ${uri.slice(0, 256)} → ${rendered.text.length} chars`
          + `${rendered.truncated ? " (truncated)" : ""}`
          + `${rendered.omittedBlocks > 0 ? ` (${rendered.omittedBlocks} non-text block(s))` : ""}`,
      );
      return {
        ok: true,
        // Return the complete host-built user-content part; renderer code must not assemble the trust fence.
        attachment: { type: "text", text: rendered.text },
        truncated: rendered.truncated,
        omittedBlocks: rendered.omittedBlocks,
      };
    } catch (err) {
      // Scrub and bound server errors for audit; renderer callers receive a stable code.
      auditAttach(
        "error",
        `[mcp-resource:${serverId}] attach ${uri.slice(0, 256)} failed: `
          + scrubShortError(errorMessage(err)),
      );
      return { ok: false, error: "resource-failed" };
    }
  });

  // Template listing reads host-held state without a server request or rate charge.
  ipcMain.handle(CHANNELS.mcp.listResourceTemplates, (e) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.mcp.listResourceTemplates, e);
      return UNAUTHORIZED_FRAME;
    }
    return { ok: true as const, servers: deps.mcpManager.listDeclaredResourceTemplates() };
  });

  // Main expands the template from user values; renderer input cannot supply the final resource URI.
  ipcMain.handle(
    CHANNELS.mcp.attachResourceTemplate,
    async (e, serverId: unknown, uriTemplate: unknown, values: unknown) => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.mcp.attachResourceTemplate, e);
        return UNAUTHORIZED_FRAME;
      }
      const auditAttach = (type: "info" | "error", input: string) => {
        auditLogger.log({
          timestamp: new Date().toISOString(),
          sessionId: "mcp-resource",
          type,
          input,
        });
      };
      // Validate template syntax before audit and rate limiting; legal braces differ from URI syntax.
      if (typeof serverId !== "string" || !isUsableResourceUriTemplate(uriTemplate)) {
        return { ok: false, error: "invalid-request" };
      }
      if (!isUsableMcpServerId(serverId)) {
        return { ok: false, error: "invalid-server-id" };
      }
      // Use a Map through expansion so __proto__ and inherited method names remain ordinary variables.
      const templateValues = new Map<string, string>();
      if (values && typeof values === "object" && !Array.isArray(values)) {
        for (const [key, value] of Object.entries(values as Record<string, unknown>)) {
          if (typeof value !== "string" || !isUsableTemplateVariableName(key)) continue;
          // Reject overlong path segments; clipping would silently read a different resource.
          if (value.length > MCP_RESOURCE_TEMPLATE_VALUE_MAX_CHARS) {
            return { ok: false, error: "invalid-request" };
          }
          // Validate every value before applying the variable cap so entry order cannot hide an overlong value.
          if (templateValues.size >= MCP_RESOURCE_TEMPLATE_MAX_VARIABLES) break;
          templateValues.set(key, value);
        }
      }
      if (userPromptRateLimiter.isOverCap(serverId)) {
        auditAttach("error", `[mcp-resource:${serverId}] template attach rate limited`);
        return { ok: false, error: "rate-limited" };
      }
      userPromptRateLimiter.record(serverId);
      try {
        const read = await deps.mcpManager.readDeclaredResourceTemplate(
          serverId,
          uriTemplate,
          templateValues,
        );
        // Reuse attachment authorization and accounting with the host-expanded URI.
        const rendered = renderResourceAttachment(serverId, read.uri, read);
        if (rendered.bodyChars === 0) {
          auditAttach("error", `[mcp-resource:${serverId}] template read returned no text`);
          return { ok: false, error: "empty-resource" };
        }
        auditAttach(
          "info",
          `[mcp-resource:${serverId}] attached ${read.uri.slice(0, 256)}`
            + ` (from template ${uriTemplate.slice(0, 256)})`
            + ` → ${rendered.text.length} chars`
            + `${rendered.truncated ? " (truncated)" : ""}`
            + `${rendered.omittedBlocks > 0 ? ` (${rendered.omittedBlocks} non-text block(s))` : ""}`,
        );
        return {
          ok: true,
          attachment: { type: "text", text: rendered.text },
          truncated: rendered.truncated,
          omittedBlocks: rendered.omittedBlocks,
          // Returned URIs grant no authority: core reads require declared resources, while app reads accept only ui://.
          // Discovery rejects ui: resources and templates, so expanded core URIs cannot replay through the app path.
          uri: read.uri,
        };
      } catch (err) {
        auditAttach(
          "error",
          `[mcp-resource:${serverId}] template attach ${uriTemplate.slice(0, 256)} failed: `
            + scrubShortError(errorMessage(err)),
        );
        return { ok: false, error: "resource-failed" };
      }
    },
  );

  // Save only validated inline bytes with bounded names and sizes; never fetch app-supplied resource links.
  // The user's save dialog authorizes each write; cancellation stops the remaining files without error.
  ipcMain.handle(CHANNELS.mcp.uiDownloadFile, async (e, serverId: unknown, params: unknown) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.mcp.uiDownloadFile, e);
      return UNAUTHORIZED_FRAME;
    }
    const auditDownload = (type: "info" | "error", input: string) => {
      auditLogger.log({ timestamp: new Date().toISOString(), sessionId: "mcp-app", type, input });
    };
    if (typeof serverId !== "string" || !serverId.trim()) {
      return { ok: false, error: "invalid-server-id", message: "serverId must be a non-empty string" } satisfies McpUiDownloadOutcome;
    }

    const parsed = parseMcpAppDownload(params);
    if (parsed.kind === "invalid") {
      auditDownload("error", `[mcp-app:${serverId}] ui/download-file rejected: ${parsed.error}`);
      return { ok: false, error: parsed.error, message: parsed.message } satisfies McpUiDownloadOutcome;
    }

    const win = getMainWindow();
    for (const file of parsed.files) {
      const extension = file.filename.includes(".") ? file.filename.split(".").pop() ?? "" : "";
      const dialogOptions = {
        title: "MCP 앱 파일 저장",
        defaultPath: file.filename,
        ...(extension ? { filters: [{ name: extension.toUpperCase(), extensions: [extension] }] } : {}),
      };
      const result = win && !win.isDestroyed()
        ? await dialog.showSaveDialog(win, dialogOptions)
        : await dialog.showSaveDialog(dialogOptions);
      if (result.canceled || !result.filePath) {
        auditDownload("info", `[mcp-app:${serverId}] ui/download-file cancelled by user`);
        return { ok: true, disposition: "cancelled" } satisfies McpUiDownloadOutcome;
      }
      await writeFile(result.filePath, file.bytes);
      // Audit file writes with a redacted destination path.
      auditDownload(
        "info",
        `[mcp-app:${serverId}] ui/download-file saved ${JSON.stringify({
          bytes: file.bytes.byteLength,
          mimeType: file.mimeType,
          path: redactFsPath(result.filePath),
        })}`,
      );
    }
    return { ok: true, disposition: "saved" } satisfies McpUiDownloadOutcome;
  });

  // Overwrite only the card's bound session/server slot with untrusted data for the next prompt; never start a turn.
  // Drop updates unless an open loop still holds the session.
  ipcMain.handle(
    CHANNELS.mcp.uiModelContext,
    (e, serverId: unknown, cardSessionId: unknown, cardId: unknown, params: unknown) => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.mcp.uiModelContext, e);
        return UNAUTHORIZED_FRAME;
      }
      const auditContext = (type: "info" | "error", input: string) => {
        auditLogger.log({ timestamp: new Date().toISOString(), sessionId: "mcp-app", type, input });
      };
      if (typeof serverId !== "string" || typeof cardId !== "string") {
        return { ok: false, error: "invalid-binding", message: "serverId and cardId must be strings" } satisfies McpUiModelContextOutcome;
      }
      // Any open tile may hold the card's session; primary-only checks would drop valid secondary updates.
      if (typeof cardSessionId !== "string" || !deps.findLoopBySessionId(cardSessionId)) {
        auditContext("info", `[mcp-app:${serverId}] ui/update-model-context dropped: session mismatch`);
        return { ok: false, error: "session-mismatch", message: "the card's session is not an open conversation" } satisfies McpUiModelContextOutcome;
      }

      const record = asPlainRecord(params);
      const outcome = deps.mcpAppModelContext.update({
        sessionId: cardSessionId,
        serverId,
        cardId,
        content: record.content,
        structuredContent: record.structuredContent,
      });
      // The app receives EmptyResult even on refusal, so audit rejected updates here.
      auditContext(
        outcome.ok ? "info" : "error",
        outcome.ok
          ? `[mcp-app:${serverId}] ui/update-model-context ${outcome.disposition}`
          : `[mcp-app:${serverId}] ui/update-model-context refused: ${outcome.error}`,
      );
      return outcome;
    },
  );

  // Dispose proxy tokens on unmount so reclaimed cards cannot evict still-mounted sessions.
  ipcMain.handle(CHANNELS.mcp.disposeUiSession, (e, token: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, CHANNELS.mcp.disposeUiSession, e); return UNAUTHORIZED_FRAME; }
    if (typeof token === "string" && token.length > 0) disposeMcpAppProxySession(token);
    return { ok: true as const };
  });

  ipcMain.handle(CHANNELS.mcp.importClaudeDesktopPreview, async (e, raw: string) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.mcp.importClaudeDesktopPreview, e);
      return UNAUTHORIZED_FRAME;
    }
    if (typeof raw === "string" && raw.length > 1_000_000) {
      return {
        entries: [],
        errors: [{ id: "<root>", reason: "config exceeds 1MB size limit" }],
      };
    }
    const { parseClaudeDesktopConfig } = await import("../../mcp/claude-desktop-import.js");
    return parseClaudeDesktopConfig(typeof raw === "string" ? raw : "");
  });

  ipcMain.handle(
    CHANNELS.mcp.importClaudeDesktopApply,
    async (
      e,
      payload: { raw: string; conflictPolicy?: "skip" | "overwrite" },
    ) => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, CHANNELS.mcp.importClaudeDesktopApply, e);
        return UNAUTHORIZED_FRAME;
      }
      const { importFailureKind, parseClaudeDesktopConfig } = await import("../../mcp/claude-desktop-import.js");
      const policy = payload?.conflictPolicy ?? "skip";
      const parsed = parseClaudeDesktopConfig(typeof payload?.raw === "string" ? payload.raw : "");
      const seenIds = new Set<string>();
      const dedupedEntries: typeof parsed.entries = [];
      for (const entry of parsed.entries) {
        if (seenIds.has(entry.id)) continue;
        seenIds.add(entry.id);
        dedupedEntries.push(entry);
      }

      const existing = await deps.mcpManager.getConfigs();
      const existingIds = new Set(existing.map((s) => s.id));
      const results: Array<
        | { id: string; action: "added" | "skipped-conflict" | "overwritten"; reason?: string; warning?: string }
        | { id: string; action: "failed"; failure: ClaudeDesktopImportFailure; reason: string; warning?: string }
      > = [];
      for (const entry of dedupedEntries) {
        const conflictedAtStart = existingIds.has(entry.id);
        if (conflictedAtStart) {
          if (policy === "skip") {
            results.push({ id: entry.id, action: "skipped-conflict" });
            continue;
          }
          try {
            await deps.mcpManager.removeConfig(entry.id);
            existingIds.delete(entry.id);
          } catch (err) {
            results.push({
              id: entry.id,
              action: "failed",
              failure: importFailureKind(err),
              reason: (err as Error).message ?? "remove failed",
            });
            continue;
          }
        }
        try {
          const addResult = await deps.mcpManager.addConfig(entry.config);
          existingIds.add(entry.id);
          results.push({
            id: entry.id,
            action: conflictedAtStart ? "overwritten" : "added",
            reason: addResult.connected ? undefined : addResult.warning,
            warning: entry.warning,
          });
        } catch (err) {
          results.push({
            id: entry.id,
            action: "failed",
            failure: importFailureKind(err),
            reason: (err as Error).message ?? "addConfig failed",
            warning: entry.warning,
          });
        }
      }
      return {
        ok: true as const,
        results,
        parseErrors: parsed.errors,
      };
    },
  );

  // Audit every rejected webview binding without changing its sentinel response.
  const safeStringify = (value: unknown): string => {
    try {
      const s = JSON.stringify(value);
      return typeof s === "string" && s.length > 1024 ? s.slice(0, 1024) + "...<truncated>" : s ?? "<unserializable>";
    } catch {
      return "<unserializable>";
    }
  };
  const logRegisterReject = (reason: string, payload: unknown) => {
    try {
      auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: "ipc-guard",
        type: "warn",
        input: safeStringify({
          channel: CHANNELS.pluginBridge.registerWebview,
          reason,
          payload: redactAuditPayload(payload),
        }),
      });
    } catch {
      // Never let audit logging break the IPC sentinel return.
    }
  };
  // Install preload, request gates, and asset schemes before creating the guest; first-load scheme tables cannot be repaired by retry.
  ipcMain.handle(CHANNELS.pluginBridge.ensurePartition, (e, payload: { pluginId?: string }) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.pluginBridge.ensurePartition, e);
      return UNAUTHORIZED_FRAME;
    }
    const pluginId = payload?.pluginId;
    if (typeof pluginId !== "string" || !pluginRuntime.getPluginManifest(pluginId)) {
      return { ok: false, error: "unknown-plugin-id" };
    }
    installPluginPartitionPolicy(pluginPartitionName(pluginId), {
      pluginRoot: pluginRuntime.getPluginRoot(pluginId) || undefined,
    });
    return { ok: true };
  });
  ipcMain.handle(CHANNELS.pluginBridge.registerWebview, (e, payload: { webContentsId: number; pluginId: string; entryUrl: string }) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.pluginBridge.registerWebview, e);
      return UNAUTHORIZED_FRAME;
    }
    const { webContentsId, pluginId, entryUrl } = payload ?? {};
    logPluginLifecycle("debug", { pluginId: pluginId ?? "<unknown>", phase: PluginPhase.WEBVIEW_REGISTER, webContentsId, entryUrl: typeof entryUrl === "string" ? redactFsPath(entryUrl) : entryUrl }, "webview register requested");
    if (typeof webContentsId !== "number" || !Number.isFinite(webContentsId)) {
      logRegisterReject("invalid-webcontents-id", payload);
      logPluginLifecycle("warn", { pluginId: pluginId ?? "<unknown>", phase: PluginPhase.WEBVIEW_REJECT, webContentsId, reason: "invalid-webcontents-id" }, "webview register rejected");
      return { ok: false, error: "invalid-webcontents-id" };
    }
    if (typeof pluginId !== "string" || !pluginRuntime.getPluginManifest(pluginId)) {
      logRegisterReject("unknown-plugin-id", { webContentsId, pluginId });
      logPluginLifecycle("warn", { pluginId: pluginId ?? "<unknown>", phase: PluginPhase.WEBVIEW_REJECT, webContentsId, reason: "unknown-plugin-id" }, "webview register rejected");
      return { ok: false, error: "unknown-plugin-id" };
    }
    if (typeof entryUrl !== "string" || !entryUrl.startsWith("file://") || entryUrl.length <= "file://".length) {
      logRegisterReject("invalid-entry-url", { webContentsId, pluginId, entryUrl });
      logPluginLifecycle("warn", { pluginId, phase: PluginPhase.WEBVIEW_REJECT, webContentsId, reason: "invalid-entry-url" }, "webview register rejected");
      return { ok: false, error: "invalid-entry-url" };
    }
    const rawInstallRoot = pluginRuntime.getPluginRoot(pluginId);
    if (!rawInstallRoot) {
      logRegisterReject("plugin-not-loaded", { webContentsId, pluginId });
      logPluginLifecycle("warn", { pluginId, phase: PluginPhase.WEBVIEW_REJECT, webContentsId, reason: "plugin-not-loaded" }, "webview register rejected");
      return { ok: false, error: "plugin-not-loaded" };
    }
    let entryFsPath: string;
    try {
      entryFsPath = fileURLToPath(entryUrl);
    } catch {
      logRegisterReject("invalid-entry-url", { webContentsId, pluginId, entryUrl });
      logPluginLifecycle("warn", { pluginId, phase: PluginPhase.WEBVIEW_REJECT, webContentsId, reason: "invalid-entry-url" }, "webview register rejected");
      return { ok: false, error: "invalid-entry-url" };
    }
    let resolvedRoot: string;
    let resolvedEntry: string;
    try {
      resolvedRoot = realpathSync(rawInstallRoot);
      resolvedEntry = realpathSync(entryFsPath);
    } catch (err) {
      // Treat missing install directories separately from actual boundary violations.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        // Purge missing runtime tracking asynchronously so registration returns promptly.
        void pluginRuntime.removePlugin(pluginId).catch((purgeErr) => {
          logPluginLifecycle(
            "warn",
            { pluginId, phase: PluginPhase.WEBVIEW_REJECT, reason: "auto-purge-failed", error: (purgeErr as Error).message },
            "register-webview auto-purge after ENOENT failed",
          );
        });
        logRegisterReject("plugin-not-loaded", { webContentsId, pluginId, reason: "install-dir-missing" });
        logPluginLifecycle("warn", { pluginId, phase: PluginPhase.WEBVIEW_REJECT, webContentsId, reason: "plugin-not-loaded" }, "webview register rejected (install dir missing)");
        return { ok: false, error: "plugin-not-loaded" };
      }
      logRegisterReject("entry-url-outside-install-root", { webContentsId, pluginId, entryFsPath, rawInstallRoot });
      logPluginLifecycle("warn", { pluginId, phase: PluginPhase.WEBVIEW_REJECT, webContentsId, reason: "entry-url-outside-install-root" }, "webview register rejected");
      return { ok: false, error: "entry-url-outside-install-root" };
    }
    if (!isPathWithin(resolvedRoot, resolvedEntry)) {
      logRegisterReject("entry-url-outside-install-root", { webContentsId, pluginId, resolvedEntry, resolvedRoot });
      logPluginLifecycle("warn", { pluginId, phase: PluginPhase.WEBVIEW_REJECT, webContentsId, reason: "entry-url-outside-install-root" }, "webview register rejected");
      return { ok: false, error: "entry-url-outside-install-root" };
    }
    const assetEntryUrl = pluginAssetUrlFromRealPath(resolvedRoot, resolvedEntry);
    // Preserve the generation query so reloaded entries receive a fresh module cache key.
    const entrySearch = new URL(entryUrl).search;
    const versionedAssetEntryUrl = entrySearch ? `${assetEntryUrl}${entrySearch}` : assetEntryUrl;
    const runtimeRevision = Number(new URL(entryUrl).searchParams.get("aveRuntimeRevision"));
    if (!Number.isSafeInteger(runtimeRevision) || !pluginRuntime.isPluginUiRevisionCurrent(pluginId, runtimeRevision)) {
      logRegisterReject("stale-runtime-revision", { webContentsId, pluginId, runtimeRevision });
      return { ok: false, error: "stale-runtime-revision" };
    }
    const generationAccess = pluginRuntime.getGenerationAccess();
    const activeGeneration = generationAccess?.getActive(pluginId);
    if (!activeGeneration) {
      logRegisterReject("plugin-not-loaded", { webContentsId, pluginId, reason: "active-generation-missing" });
      return { ok: false, error: "plugin-not-loaded" };
    }
    let targetWebview: Electron.WebContents | null = null;
    try {
      targetWebview = webContents.fromId(webContentsId) ?? null;
    } catch {
      targetWebview = null;
    }
    if (
      !targetWebview
      || targetWebview.isDestroyed()
      || targetWebview.getType() !== "webview"
    ) {
      logRegisterReject("webview-not-live", { webContentsId, pluginId });
      logPluginLifecycle("warn", { pluginId, phase: PluginPhase.WEBVIEW_REJECT, webContentsId, reason: "webview-not-live" }, "webview register rejected");
      return { ok: false, error: "webview-not-live" };
    }
    // Serve assets from the exact generation root used to build the entry URL before guest imports.
    // Root refresh failures are non-fatal and must not misreport a live webview as dead.
    try {
      installPluginAssetProtocolHandler(
        pluginPartitionName(pluginId),
        targetWebview.session,
        resolvedRoot,
      );
    } catch (err) {
      logPluginLifecycle(
        "warn",
        { pluginId, phase: PluginPhase.WEBVIEW_ATTACH, webContentsId, reason: scrubShortError(errorMessage(err)) },
        "plugin asset root re-bind failed",
      );
    }
    const binding = {
      pluginId,
      generationId: activeGeneration.generationId,
      entryUrl,
      assetEntryUrl: versionedAssetEntryUrl,
      appSessionId: `plugin-ui:${webContentsId}:${randomUUID()}`,
      runtimeRevision,
    };
    const previousBinding = pluginWebviewRegistry.get(webContentsId);
    if (previousBinding) {
      deps.revokePluginOperationSession(previousBinding.appSessionId);
    }
    pluginWebviewRegistry.set(webContentsId, binding);
    flushPendingEntryUrl(webContentsId, binding);
    logPluginLifecycle("debug", { pluginId, phase: PluginPhase.WEBVIEW_ATTACH, webContentsId }, "webview attached");
    const replayedTheme = replayThemeToWebview(webContentsId);
    if (replayedTheme) {
      publishHostThemeChanged(replayedTheme);
      logPluginLifecycle("debug", { pluginId, phase: PluginPhase.WEBVIEW_ATTACH, webContentsId }, "theme replay sent");
    }
    return { ok: true };
  });

  function resolvePluginFromSender(e: import("electron").IpcMainInvokeEvent): PluginWebviewBinding | null {
    if (!validatePluginFrame(e)) return null;
    const senderId = e.sender?.id;
    if (typeof senderId !== "number") return null;
    const binding = pluginWebviewRegistry.get(senderId);
    if (!binding) return null;
    const activeGeneration = pluginRuntime.getGenerationAccess()?.getActive(binding.pluginId);
    if (
      activeGeneration?.generationId === binding.generationId
      && pluginRuntime.isPluginUiRevisionCurrent(binding.pluginId, binding.runtimeRevision)
    ) {
      return binding;
    }
    pluginWebviewRegistry.delete(senderId);
    deps.revokePluginOperationSession(binding.appSessionId);
    return null;
  }

  ipcMain.handle(CHANNELS.pluginBridge.getEntryUrl, (e) => {
    const binding = resolvePluginFromSender(e);
    if (binding) return { ok: true as const, entryUrl: binding.assetEntryUrl };

    if (!validatePluginFrame(e)) {
      auditUnauthorized(auditLogger, CHANNELS.pluginBridge.getEntryUrl, e);
      return UNAUTHORIZED_FRAME;
    }
    const senderId = e.sender?.id;
    if (typeof senderId !== "number") {
      return { ok: false as const, error: "not-registered" };
    }
    // Wait for host registration when the shell requests its entry URL during first attach or reattach.
    return new Promise<{ ok: true; entryUrl: string } | { ok: false; error: "not-registered" }>(
      (resolve) => {
        let settled = false;
        const wrapped: PendingEntryUrlResolver = (reply) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve(reply);
        };
        const set = pendingEntryUrlResolvers.get(senderId) ?? new Set();
        set.add(wrapped);
        pendingEntryUrlResolvers.set(senderId, set);
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          const current = pendingEntryUrlResolvers.get(senderId);
          if (current) {
            current.delete(wrapped);
            if (current.size === 0) pendingEntryUrlResolvers.delete(senderId);
          }
          try {
            auditLogger.log({
              timestamp: new Date().toISOString(),
              sessionId: "ipc-guard",
              type: "warn",
              input: safeStringify({
                channel: CHANNELS.pluginBridge.getEntryUrl,
                reason: "not-registered",
                frameUrl: redactFsPath(e?.senderFrame?.url ?? ""),
                senderId,
                deadlineMs: PENDING_ENTRY_URL_DEADLINE_MS,
              }),
            });
          } catch { /* audit must never break the sentinel return */ }
          resolve({ ok: false, error: "not-registered" });
        }, PENDING_ENTRY_URL_DEADLINE_MS);
      },
    );
  });

  // Apply theme tokens before importing the entry module to avoid a fallback-theme first paint.
  ipcMain.handle(CHANNELS.pluginBridge.getTheme, (e) => {
    if (!validatePluginFrame(e)) {
      auditUnauthorized(auditLogger, CHANNELS.pluginBridge.getTheme, e);
      return UNAUTHORIZED_FRAME;
    }
    return { ok: true as const, theme: getLastThemePayload() };
  });

  ipcMain.handle(CHANNELS.pluginBridge.callTool, async (
    e,
    method: string,
    payload?: unknown,
    options?: { userAction?: boolean; operationGrantToken?: string },
  ) => {
    const binding = resolvePluginFromSender(e);
    if (!binding) {
      auditUnauthorized(auditLogger, CHANNELS.pluginBridge.callTool, e);
      return UNAUTHORIZED_FRAME;
    }
    if (typeof method !== "string" || !method.trim()) {
      return { ok: false, error: "invalid-method" };
    }
    const ownerPluginId = pluginRuntime.resolveToolOwner(method);
    if (!ownerPluginId) {
      return { ok: false, error: `Plugin method not found: ${method}` };
    }
    if (ownerPluginId !== binding.pluginId) {
      auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: "plugin-frame",
        type: "error",
        input: `[plugin:${binding.pluginId}] cross-plugin call denied: method='${method}' owner='${ownerPluginId}'`,
      });
      return { ok: false, error: "cross-plugin-call-denied" };
    }
    try {
      const result = await pluginRuntime.callFromUi(method, payload, {
        userAction: options?.userAction === true,
        appSessionId: binding.appSessionId,
        ...(typeof options?.operationGrantToken === "string"
          ? { operationGrantToken: options.operationGrantToken }
          : {}),
        expectedGenerationId: binding.generationId,
      });
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  ipcMain.handle(CHANNELS.pluginBridge.requestOperationGrant, async (
    e,
    method: unknown,
    payload: unknown,
  ) => {
    const binding = resolvePluginFromSender(e);
    if (!binding) {
      auditUnauthorized(auditLogger, CHANNELS.pluginBridge.requestOperationGrant, e);
      return UNAUTHORIZED_FRAME;
    }
    if (typeof method !== "string" || !method.trim()) {
      return { ok: false as const, error: "invalid-method" };
    }
    const ownerPluginId = pluginRuntime.resolveToolOwner(method);
    if (ownerPluginId !== binding.pluginId) {
      return { ok: false as const, error: "cross-plugin-call-denied" };
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return { ok: false as const, error: "invalid-operation-input" };
    }
    try {
      const result = await deps.requestPluginOperationGrant({
        pluginId: binding.pluginId,
        toolName: method,
        input: payload as Record<string, unknown>,
        appSessionId: binding.appSessionId,
        expectedGenerationId: binding.generationId,
      });
      return { ok: true as const, result };
    } catch (error) {
      return { ok: false as const, error: errMessage(error) };
    }
  });

  // Bind config access to the sender's own plugin and strip secrets before plaintext persistence.
  ipcMain.handle(CHANNELS.pluginBridge.configGet, (e, key: string) => {
    const binding = resolvePluginFromSender(e);
    if (!binding) {
      auditUnauthorized(auditLogger, CHANNELS.pluginBridge.configGet, e);
      return UNAUTHORIZED_FRAME;
    }
    if (typeof key !== "string" || !key.trim()) {
      return { ok: false as const, error: "invalid-key" };
    }
    try {
      const config = settingsService.getPluginConfig(binding.pluginId) ?? {};
      return { ok: true as const, value: config[key] };
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    }
  });

  ipcMain.handle(CHANNELS.pluginBridge.configSet, async (e, key: string, value: unknown) => {
    const binding = resolvePluginFromSender(e);
    if (!binding) {
      auditUnauthorized(auditLogger, CHANNELS.pluginBridge.configSet, e);
      return UNAUTHORIZED_FRAME;
    }
    if (typeof key !== "string" || !key.trim()) {
      return { ok: false as const, error: "invalid-key" };
    }
    try {
      return await withPluginInstallLock(binding.pluginId, async () => {
        const currentBinding = resolvePluginFromSender(e);
        const manifest = pluginRuntime.getPluginManifest(binding.pluginId);
        if (
          currentBinding !== binding
          || !manifest
          || !pluginRuntime.isPluginUiRevisionCurrent(binding.pluginId, binding.runtimeRevision)
        ) {
          throw new Error(`Plugin webview is no longer active: ${binding.pluginId}`);
        }
        const schema = manifest.configSchema;
        const current = settingsService.getPluginConfig(binding.pluginId) ?? {};
        const next = { ...current, [key]: value };
        // Use the shared secret-stripping path so UI writes cannot bypass encrypted storage.
        const stripped = stripSecretFields(schema, asPlainRecord(next));
        const savedConfig = await settingsService.setPluginConfig(binding.pluginId, stripped);
        pluginRuntime.setConfigOverride(binding.pluginId, savedConfig);
        emitPluginConfigChange(binding.pluginId, key, savedConfig?.[key]);
        // Do not restart from a webview config call; it would tear down the caller mid-request.
        return { ok: true as const };
      });
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    }
  });

  // Storage keys map to private plugin files without exposing filesystem layout; sanitize before path construction.
  function sanitizeStorageKey(key: unknown): string | null {
    if (typeof key !== "string") return null;
    const trimmed = key.trim();
    if (!trimmed || trimmed.length > 128) return null;
    // Reject traversal, separators, and controls before joining storage keys to the plugin data path.
    if (!/^[A-Za-z0-9._-]+$/.test(trimmed)) return null;
    if (trimmed === "." || trimmed === "..") return null;
    return trimmed;
  }
  ipcMain.handle(CHANNELS.pluginBridge.storageGet, async (e, key: string) => {
    const binding = resolvePluginFromSender(e);
    if (!binding) {
      auditUnauthorized(auditLogger, CHANNELS.pluginBridge.storageGet, e);
      return UNAUTHORIZED_FRAME;
    }
    const safeKey = sanitizeStorageKey(key);
    if (!safeKey) return { ok: false as const, error: "invalid-key" };
    const access = pluginRuntime.getGenerationAccess();
    if (!access) return { ok: false as const, error: "unknown-plugin-id" };
    let lease;
    try {
      lease = await access.acquireExact(binding.pluginId, binding.generationId);
      return await access.runWithLease(lease, async () => {
        const storage = pluginRuntime.getPluginStorage(binding.pluginId);
        if (!storage) return { ok: false as const, error: "unknown-plugin-id" };
        const value = await storage.readJson<unknown>(`ui-storage/${safeKey}.json`);
        return { ok: true as const, value: value ?? undefined };
      });
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    } finally {
      lease?.release();
    }
  });
  ipcMain.handle(CHANNELS.pluginBridge.storageSet, async (e, key: string, value: unknown) => {
    const binding = resolvePluginFromSender(e);
    if (!binding) {
      auditUnauthorized(auditLogger, CHANNELS.pluginBridge.storageSet, e);
      return UNAUTHORIZED_FRAME;
    }
    const safeKey = sanitizeStorageKey(key);
    if (!safeKey) return { ok: false as const, error: "invalid-key" };
    const access = pluginRuntime.getGenerationAccess();
    if (!access) return { ok: false as const, error: "unknown-plugin-id" };
    let lease;
    try {
      lease = await access.acquireExact(binding.pluginId, binding.generationId);
      return await access.runWithLease(lease, async () => {
        const storage = pluginRuntime.getPluginStorage(binding.pluginId);
        if (!storage) return { ok: false as const, error: "unknown-plugin-id" };
        await storage.writeJson(`ui-storage/${safeKey}.json`, value);
        return { ok: true as const };
      });
    } catch (err) {
      return { ok: false as const, error: (err as Error).message };
    } finally {
      lease?.release();
    }
  });

  ipcMain.handle(CHANNELS.pluginBridge.emitEvent, (e, type: string, data?: unknown) => {
    const binding = resolvePluginFromSender(e);
    if (!binding) {
      auditUnauthorized(auditLogger, CHANNELS.pluginBridge.emitEvent, e);
      return UNAUTHORIZED_FRAME;
    }
    if (typeof type !== "string" || !type.trim()) {
      return { ok: false, error: "invalid-event-type" };
    }
    const manifest = pluginRuntime.getPluginManifest(binding.pluginId);
    if (!manifest) {
      return { ok: false, error: "unknown-plugin-id" };
    }
    // Use canEmitEvent for both lanes so host namespaces and undeclared events remain forbidden.
    const declaredEmittedEvents = getDeclaredEmittedEvents(manifest);
    if (!canEmitEvent(type, declaredEmittedEvents)) {
      const requiredCap = auditPluginEmitDenial({
        auditLogger,
        lane: "ipc-bridge",
        pluginId: binding.pluginId,
        eventType: type,
        declaredEmittedEvents,
      });
      const namespacePrefix = type.split(".")[0] ?? "";
      return {
        ok: false,
        error: HOST_ONLY_EMIT_NAMESPACES.has(namespacePrefix)
          ? `host-only-namespace:${namespacePrefix}`
          : `missing-capability:${requiredCap}`,
      };
    }
    try {
      pluginRuntime.assertPluginEventEmitAccess(binding.pluginId, type);
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
    try {
      emitHostEvent(type, { ...((data as Record<string, unknown>) ?? {}), pluginId: binding.pluginId });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });

  // Fan out theme updates to registered webviews and publish the same host event.
  ipcMain.handle(CHANNELS.host.pluginThemeNotify, (e, payload: unknown) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.host.pluginThemeNotify, e);
      return UNAUTHORIZED_FRAME;
    }
    const validated = recordValidatedTheme(payload);
    if (!validated.ok) return validated;
    const { safe } = validated;
    publishHostThemeChanged(safe);
    for (const [wcId] of pluginWebviewRegistry) {
      try {
        const wc = webContents.fromId(wcId);
        if (wc && !wc.isDestroyed()) {
          wc.send(CHANNELS.pluginBridge.event, "host.theme.changed", cloneThemePayload(safe));
        }
      } catch { /* webview destroyed between registry read and send */ }
    }
    return { ok: true };
  });

  ipcMain.handle(CHANNELS.notification.clicked, (e, payload: unknown) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, CHANNELS.notification.clicked, e);
      return UNAUTHORIZED_FRAME;
    }
    const kind = (payload as { kind?: unknown } | null | undefined)?.kind;
    if (typeof kind !== "string" || !NOTIFICATION_KINDS.has(kind as never)) {
      auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: "ipc-bridge",
        type: "warn",
        input: JSON.stringify({
          event: "notification.clicked.invalid-payload",
          receivedKind: typeof kind === "string" ? kind.slice(0, 32) : typeof kind,
          hasContextRef: typeof (payload as Record<string, unknown> | null | undefined)?.contextRef === "object",
        }),
      });
      return { ok: false, error: "invalid-payload" };
    }
    const clickPayload: { kind: NotificationKind; contextRef?: NotificationContextRef } = {
      kind: kind as NotificationKind,
    };
    const contextRef = sanitizeNotificationContextRef(
      (payload as { contextRef?: unknown } | null | undefined)?.contextRef,
    );
    if (contextRef) clickPayload.contextRef = contextRef;
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      try {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
        win.webContents.send(IPC_NOTIFICATION_CLICKED, clickPayload);
      } catch (err) {
        log.warn(
          "notification:clicked focus failed: %s",
          (err as Error).message,
        );
      }
    }
    return { ok: true };
  });
}
