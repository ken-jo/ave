/** Permissions domain IPC handlers. Covers: ave:permission:*, ave:approval:*, ave:policy:* */
import { ipcMain, session, type IpcMainInvokeEvent } from "electron";
import { isRuleSpecifier } from "../../permissions/rules/rule-specifier.js";
import { validatePermissionRule } from "../../permissions/rules/rule-files.js";
import { saveApprovalCardRule } from "../../permissions/approval-rule-save.js";
import { loadPolicy, savePolicy } from "../../permissions/policy-store.js";
import { isPolicyUserEditable } from "../../shared/policy-editability.js";
import { UNATTRIBUTED_APPROVAL_SESSION_ID, type ApprovalDecision } from "../../permissions/approval-gate.js";
import { PERMISSIONS } from "../../shared/ipc-channels.js";
import {
  UPSTREAM_PROXY_CREDENTIALS_SECRET,
  UPSTREAM_PROXY_MODES,
  type UpstreamProxySettings,
  type UpstreamProxyView,
} from "../../shared/upstream-proxy.js";

/** The destination the Settings diagnostic line resolves. */
const UPSTREAM_PROXY_DIAGNOSTIC_URL = "https://example.com/";
import { errorMessage } from "../../shared/error-message.js";
import { approveExtensionsWithoutIsolation, areExtensionsWithoutIsolationApproved, getAveHomePrivacyFailure } from "../../shared/ave-home.js";
import { getWindowsProfileReadDenyWarnings } from "../../permissions/asrt-sandbox.js";
import {
  RECENT_EGRESS_DENIALS_LIMIT,
  RECENT_EGRESS_DENIALS_WINDOW_HOURS,
  type EgressDenialRow,
} from "../../shared/egress-denials.js";
import { envForcedValueForSettingsPath, resolveEnvBackedBoolean } from "../../shared/env-backed-settings.js";
import {
  isSessionOnlyApprovalMemoryScope,
  isUserOwnedSurfaceChoice,
  type PermissionReviewSuggestionPayload,
  type PermissionReviewSuggestionReason,
} from "../../shared/permissions-events.js";
import { hasUserKeyboardIntent } from "../../shared/chat-origin.js";
import {
  validateHostRendererSender,
  UNAUTHORIZED_FRAME,
  auditUnauthorized,
} from "../gated.js";
import { buildApprovalScopeOptions } from "../../permissions/approval-scope-options.js";
import type { ApprovalRequestFacts } from "../../permissions/reviewer/approval-sentence-selector.js";
import { sendToWindow } from "../safe-send.js";
import { getWorkspaceRootLifecycle } from "../../permissions/workspace-root-lifecycle.js";
import { createLogger } from "../../lib/logger.js";
import type { IpcDeps } from "../types.js";
import type {
  PermissionDirCommand,
  PermissionReviewerCommand,
  PermissionRulesCommand,
} from "../../permissions/permission-slash.js";
import {
} from "../../permissions/permission-settings-store.js";
import {
  recordApproval,
  getUserApprovalGeneration,
  approvalCacheKeyIdentity,
  revokeApprovalByKey,
  listApprovals,
  listSessionApprovals,
  canonicalStringify,
} from "../../permissions/user-approval-store.js";
import { isEgressGrantNetwork } from "../../shared/egress-grant-scopes.js";
import { isTerminalTabId } from "../../shared/tab-id.js";
import type {
  SandboxWindowsStatusInfo,
  SandboxWindowsInstallResult,
  SandboxRuntimeCapabilityInfo,
  ShellSandboxStatusInfo,
} from "../../shared/sandbox-capability-info.js";
import {
  detectPluginWorkerSandboxCapability,
  detectShellSandboxCapability,
  getHostShellExecutionPlan,
  getSandboxBootOutcome,
  getWindowsSandboxSubstrate,
  isShellSandboxRequestedAtBoot,
  isPluginWorkerConfinementRequestedAtBoot,
  type SandboxCapability,
} from "../../permissions/sandbox-capability.js";
import {
  installAsrtWindowsSandbox,
  readAsrtWindowsStatus,
} from "../../permissions/asrt-windows-support.js";
import {
  handleGetMode,
  handleSetPermissionMode,
} from "../handlers/permissions.js";

import { getHostShellExecutionPlanAuditProjection } from "../../permissions/host-shell-execution-plan.js";

const log = createLogger("ave");

function validateRulePatternInput(pattern: unknown): { ok: true; pattern: string } | { ok: false; error: string; message: string } {
  if (typeof pattern !== "string") {
    return { ok: false, error: "invalid-pattern", message: "pattern must be a string" };
  }
  const normalized = pattern.trim();
  if (normalized.length === 0) {
    return { ok: false, error: "invalid-pattern", message: "pattern must be non-empty" };
  }
  if (isRuleSpecifier(normalized)) {
    try { validatePermissionRule({ pattern: normalized, action: "deny" }); } catch {
      return { ok: false, error: "invalid-pattern", message: "Invalid command rule" };
    }
    return { ok: true, pattern: normalized };
  }
  if (normalized.length > 128) {
    return { ok: false, error: "invalid-pattern", message: "pattern must not exceed 128 characters" };
  }
  if (/\s/.test(normalized)) {
    return { ok: false, error: "invalid-pattern", message: "pattern must not contain whitespace" };
  }
  return { ok: true, pattern: normalized };
}

function requireUserKeyboardIntent(payload: unknown): { ok: true } | { ok: false; error: string; message: string } {
  if (hasUserKeyboardIntent(payload)) return { ok: true };
  return {
    ok: false,
    error: "user-keyboard-required",
    message: "permission change requires active user gesture (keyboard intent)",
  };
}

function payloadRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function isParseError<T>(value: T | { ok: false; error: string }): value is { ok: false; error: string } {
  return "ok" in (value as Record<string, unknown>) && (value as { ok?: unknown }).ok === false;
}

function runtimeKindFromCapability(
  capability: SandboxCapability,
): SandboxRuntimeCapabilityInfo["kind"] {
  if (capability.kind === "none") return "none";
  if (
    capability.confines?.filesystem &&
    capability.confines.process &&
    capability.confines.network
  ) {
    return "full";
  }
  return "partial";
}

function runtimeInfoFromCapability(
  capability: SandboxCapability,
): SandboxRuntimeCapabilityInfo {
  const kind = runtimeKindFromCapability(capability);
  return {
    available: kind !== "none",
    kind,
    reason: capability.reason,
  };
}

const REVIEW_SUGGESTION_WINDOW_MS = 5 * 60 * 1000;
const REVIEW_SUGGESTION_REPEAT_THRESHOLD = 3;
const REVIEW_SUGGESTION_COOLDOWN_MS = 30 * 60 * 1000;

interface ApprovalAllowSample {
  at: number;
  choice: ApprovalDecision["choice"];
}

function broadcastPermissionReviewSuggestion(
  deps: IpcDeps,
  payload: PermissionReviewSuggestionPayload,
): void {
  const mainWindow = deps.getMainWindow();
  const windows = deps.getAppWindows?.() ?? [mainWindow];
  for (const win of windows) {
    sendToWindow(win, PERMISSIONS.reviewSuggestion, payload);
  }
}

function createPermissionReviewSuggestionTracker() {
  let samples: ApprovalAllowSample[] = [];
  let lastSuggestedAt = 0;

  return {
    record(
      deps: IpcDeps,
      decision: ApprovalDecision,
      snapshot: { toolName: string } | null | undefined,
    ): void {
      if (!decision.choice.startsWith("allow")) return;
      if (snapshot?.toolName === "/permission mode") return;

      const pm = deps.conversationLoop.permissionManager;
      if (!pm) return;
      if (pm.getMode() !== "default") return;

      const now = Date.now();
      samples = samples
        .filter((sample) => now - sample.at <= REVIEW_SUGGESTION_WINDOW_MS)
        .concat({ at: now, choice: decision.choice });

      if (now - lastSuggestedAt < REVIEW_SUGGESTION_COOLDOWN_MS) return;

      const allowAlwaysCount = samples.filter((sample) => sample.choice === "allow-always").length;
      const reason: PermissionReviewSuggestionReason | null =
        decision.choice === "allow-always" || allowAlwaysCount > 0
          ? "allow-always"
          : samples.length >= REVIEW_SUGGESTION_REPEAT_THRESHOLD
            ? "repeat-allow"
            : null;
      if (reason === null) return;

      lastSuggestedAt = now;
      deps.auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: "permissions",
        type: "approval",
        output:
          `[permission-review:suggest] reason=${reason} allowCount=${samples.length} ` +
          `allowAlwaysCount=${allowAlwaysCount} windowMs=${REVIEW_SUGGESTION_WINDOW_MS}`,
      });
      broadcastPermissionReviewSuggestion(deps, {
        reason,
        allowCount: samples.length,
        allowAlwaysCount,
        threshold: REVIEW_SUGGESTION_REPEAT_THRESHOLD,
        windowMs: REVIEW_SUGGESTION_WINDOW_MS,
      });
    },
  };
}

/** Notify all renderers that the allowed-directories config mutated (session-add via slash dispatch / PermissionsTab dirDispatch / etc.). Multi-window subscribers (PermissionsTab) refresh their views without manual reload. Sent as a hint
 * event; listeners pull fresh state via the existing `permission.dirDispatch("list")` rather than receiving the full list in the broadcast payload (avoids serialization size and keeps a single source of truth in the slash dispatcher). */
export type PermissionConfigBroadcastTarget = Pick<IpcDeps, "getMainWindow" | "getAppWindows">;

export function broadcastPermissionConfigChanged(deps: PermissionConfigBroadcastTarget): void {
  const mainWindow = deps.getMainWindow();
  const windows = deps.getAppWindows?.() ?? [mainWindow];
  for (const win of windows) {
    sendToWindow(win, PERMISSIONS.configChanged, {});
  }
}

export function registerPermissionsHandlers(deps: IpcDeps): void {
  const { conversationLoop, approvalGate, auditLogger } = deps;
  const reviewSuggestionTracker = createPermissionReviewSuggestionTracker();
  const isNativeApprovalFrame = (event: IpcMainInvokeEvent): boolean => {
    if (!event.sender || event.sender.isDestroyed() || event.senderFrame !== event.sender.mainFrame) return false;
    const windows = deps.getAppWindows?.() ?? [deps.getMainWindow()];
    return windows.some((window) => window && !window.isDestroyed() && window.webContents === event.sender);
  };

  // read-only, sender guard optional
  ipcMain.handle(PERMISSIONS.getMode, () => handleGetMode(deps));

  // read-only, sender guard optional; honest OS sandbox capability for the current platform. `available`/`kind` report the PLATFORM's potential (macOS/Linux can fully confine, Windows can partially confine filesystem + network, others cannot), NOT whether a runner
  // is currently registered; registration is verified at boot, so reporting the platform potential lets the toggle show "not available on this platform" rather than reading as unavailable merely because it's off. `enabled` separately reflects the current setting.
  ipcMain.handle(PERMISSIONS.sandboxCapability, async () => {
    const { sandboxConfinementForPlatform, describeShellSandboxStatus, sandboxBootOutcomeView } = await import(
      "../../shared/sandbox-capability-info.js"
    );
    const platform = process.platform;
    const storedShellSetting = deps.settingsService.get("features")?.osToolSandbox ?? false;
    // Must answer the same question boot answered (`shellRequested` in sandbox-init.ts), so it resolves through the registry rather than re-stating which variable forces it on.
    const enabled = resolveEnvBackedBoolean(
      "features.osToolSandbox",
      storedShellSetting,
      process.env,
      false,
    );
    // Report potential confinement independently of activation: full on macOS/Linux, filesystem and network only on Windows.
    const kind: "full" | "partial" | "none" =
      platform === "linux" || platform === "darwin"
        ? "full"
        : platform === "win32"
          ? "partial"
          : "none";
    const available = kind !== "none";
    // Meaningful, platform-honest reason surfaced to the UI alongside the capability. This describes PLATFORM POTENTIAL only. Runtime registration is boot-time, so it is reported separately below. On Windows the filesystem
    // confinement is against the host only: every confined process runs as the one `srt-sandbox` account, so plugins are not isolated from each other there (owner decision 2026-10-10, plugin-hostapi-protocol.md §9.8 A2).
    const potentialReason =
      platform === "darwin"
        ? "ASRT (Seatbelt) confines filesystem, process, and network egress when enabled"
        : platform === "linux"
          ? "ASRT (bwrap) confines filesystem, process, and network egress when enabled"
          : platform === "win32"
            ? "Agent shell commands run each in its own Microsoft Execution Containers container where Windows offers it (filesystem, process and network confined; no admin install). ASRT (srt-win) confines plugin processes' filesystem access and network egress against the host after a one-time admin install; every confined plugin runs as one shared sandbox account, so plugins are not isolated from each other"
            : "OS sandbox is fail-closed on this platform; tools run unconfined";
    // Per scope: ASRT is one runtime, but each scope is confined only when it was requested at boot, so a worker-only boot must not show shells as sandboxed (and the reverse).
    const runtime = runtimeInfoFromCapability(detectShellSandboxCapability());
    const workerRuntime = runtimeInfoFromCapability(detectPluginWorkerSandboxCapability());
    const boot = getSandboxBootOutcome();
    // The route a default host shell takes right now; the same plan the bash and powershell tools run under,
    // so "on" means shells are contained, not merely that ASRT is running (Windows Plan B runs shells plain).
    const shellPlan = getHostShellExecutionPlan();
    const envForced = envForcedValueForSettingsPath("features.osToolSandbox") === true;
    let shell: ShellSandboxStatusInfo;
    try {
      shell = describeShellSandboxStatus({
        platformSupported: kind !== "none",
        setting: storedShellSetting,
        envForced,
        requestedAtBoot: isShellSandboxRequestedAtBoot(),
        boot,
        shellPlanMode: shellPlan.mode,
        shellPlanFallback: shellPlan.fallbackReason,
      });
    } catch (error) {
      // The boot seal and the shell plan contradict each other; a host bug, not a user state. It is reported loudly here and on the one row
      // that depends on it; the rest of this snapshot (and every Settings section loaded beside it) still describes what the host does observe.
      const message = errorMessage(error);
      log.error("sandboxCapability: shell sandbox status contract violated: %s", message);
      auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: "permissions",
        type: "error",
        output: `[sandbox-status:contract-violation] ${message}`,
      });
      shell = { state: "error", setting: storedShellSetting, envForced, causes: [] };
    }
    const privacyFailure = getAveHomePrivacyFailure();
    return {
      platform,
      enabled,
      available,
      kind,
      reason: potentialReason,
      potentialReason,
      runtime,
      workerRuntime,
      ...(platform === "win32" ? { profileReadDenyWarnings: getWindowsProfileReadDenyWarnings() } : {}),
      workerRestartPending: boot !== null && resolveEnvBackedBoolean(
        "features.pluginWorkerConfinement",
        deps.settingsService.get("features")?.pluginWorkerConfinement ?? false,
        process.env,
        false,
      ) !== isPluginWorkerConfinementRequestedAtBoot(),
      ...(privacyFailure ? { homePrivacyError: {
        path: privacyFailure.failedPath ?? privacyFailure.home,
        category: privacyFailure.category,
        extraPrincipals: privacyFailure.extraPrincipals,
        approvedForSession: areExtensionsWithoutIsolationApproved(),
      } } : {}),
      // What the gate decided THIS boot. The runtime snapshot cannot stand in for it: a degraded gate never publishes a capability, so `runtime` reports the same "no OS
      // sandbox configured" it reports when the user never turned the sandbox on. Raw dependency messages stay main-side (boot log); the renderer gets the classified causes.
      boot: boot === null ? null : sandboxBootOutcomeView(boot),
      shell,
      // Windows: which substrate carries shells and extensions this boot and how strongly their egress is attributed (proxy-egress PR 9).
      windowsSubstrate: platform === "win32" ? getWindowsSandboxSubstrate() : null,
      shellExecutionPlan: getHostShellExecutionPlanAuditProjection(shellPlan),
      confines: sandboxConfinementForPlatform(platform, kind),
    };
  });

  // read-only, sender guard optional; Windows srt-win install readiness. The ASRT package surface is intentionally hidden behind asrt-windows-support.ts because Windows support
  // is moving quickly upstream. Non-win32 → a clean "not-applicable" shape. Non-mutating: no UAC/install; a `cannot-read` WFP enum may run ASRT's local behavioral egress verifier.
  ipcMain.handle(PERMISSIONS.sandboxWindowsStatus, async (): Promise<SandboxWindowsStatusInfo> => {
    return readAsrtWindowsStatus();
  });

  // read-only, sender-frame-guarded (it is audit data, like auditShow); the proxy denies of the last 24
  // h, newest first, from the sandbox audit channel the deny monitor writes (egress-deny-monitor.ts).
  ipcMain.handle(PERMISSIONS.egressDenialsRecent, async (e): Promise<EgressDenialRow[] | typeof UNAUTHORIZED_FRAME> => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, PERMISSIONS.egressDenialsRecent, e); return UNAUTHORIZED_FRAME; }
    const { readRecentSandboxEgressDenials } = await import("../../audit/sandbox-audit-sink.js");
    const rows = await readRecentSandboxEgressDenials({
      windowMs: RECENT_EGRESS_DENIALS_WINDOW_HOURS * 3_600_000,
      limit: RECENT_EGRESS_DENIALS_LIMIT,
    });
    return rows.map((row) => ({ timestamp: row.timestamp, source: row.invocation, deny: row.deny }));
  });

  // read-only, sender-frame-guarded; the shell egress grants that outlive a call (conversation, terminal tab, workspace, always), for Settings → Permissions → Network.
  ipcMain.handle(PERMISSIONS.egressGrantsList, async (e) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, PERMISSIONS.egressGrantsList, e); return UNAUTHORIZED_FRAME; }
    const { listEgressGrants } = await import("../../permissions/egress-runtime.js");
    try {
      return { ok: true as const, grants: await listEgressGrants() };
    } catch (error) {
      return { ok: false as const, error: "egress-grant-store-unreadable", message: errorMessage(error) };
    }
  });

  // MUTATING (sender-frame-guarded + user-keyboard intent): revoke one shell egress grant. The payload names it exactly; anything else is refused.
  ipcMain.handle(PERMISSIONS.egressGrantRevoke, async (e, payload: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, PERMISSIONS.egressGrantRevoke, e); return UNAUTHORIZED_FRAME; }
    const body = payloadRecord(payload);
    const intent = requireUserKeyboardIntent(body.intent);
    if (!intent.ok) return intent;
    const { scope, origin, host, port, projectRoot, sessionId, tabId, network } = body;
    if (network !== undefined && !isEgressGrantNetwork(network)) {
      return { ok: false, error: "invalid-egress-grant-destination", message: "revoke: invalid network class" };
    }
    if (scope !== "session" && scope !== "tab" && scope !== "project" && scope !== "always") {
      return { ok: false, error: "invalid-egress-grant-scope", message: "revoke: scope must be session, tab, project or always" };
    }
    if (typeof host !== "string" || host.length === 0 || typeof port !== "number" || !Number.isInteger(port)) {
      return { ok: false, error: "invalid-egress-grant-destination", message: "revoke: host and port are required" };
    }
    if (scope === "project" ? typeof projectRoot !== "string" : projectRoot !== undefined) {
      return { ok: false, error: "invalid-egress-grant-project", message: "revoke: a project grant names its projectRoot, no other grant does" };
    }
    if (scope === "session" ? typeof sessionId !== "string" || sessionId.length === 0 : sessionId !== undefined) {
      return { ok: false, error: "invalid-egress-grant-session", message: "revoke: a session grant names its sessionId, no other grant does" };
    }
    if (scope === "tab" ? typeof tabId !== "string" || !isTerminalTabId(tabId) : tabId !== undefined) {
      return { ok: false, error: "invalid-egress-grant-tab", message: "revoke: a tab grant names its terminal tabId, no other grant does" };
    }
    const persistent = scope === "project" || scope === "always";
    if (persistent
      ? (scope === "project" ? origin !== "shell" : origin !== "shell" && origin !== "terminal")
      : origin !== undefined) {
      return { ok: false, error: "invalid-egress-grant-origin", message: "revoke: a project or always grant names its origin (shell, or terminal for always), no other grant does" };
    }
    const destination = { host, port, ...(network === undefined ? {} : { network }) };
    const { revokeEgressGrant } = await import("../../permissions/egress-runtime.js");
    try {
      const { removed, closed } = await revokeEgressGrant(
        scope === "session" ? { scope, sessionId: sessionId as string, ...destination }
        : scope === "tab" ? { scope, tabId: tabId as string, ...destination }
        : scope === "project" ? { scope, origin: "shell", projectRoot: projectRoot as string, ...destination }
        : { scope, origin: origin as "shell" | "terminal", ...destination },
      );
      auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: "settings",
        type: "approval",
        output: `[egress-grant:revoke] scope=${scope}${persistent ? ` origin=${String(origin)}` : ""} host=${host} port=${port} removed=${removed} closedConnections=${closed}`,
      });
      return removed ? { ok: true } : { ok: false, error: "not-found", message: "revoke: no such grant" };
    } catch (error) {
      return { ok: false, error: "egress-grant-store-unreadable", message: errorMessage(error) };
    }
  });

  // Upstream proxy (owner decision 2026-10-20). Main-owned setting: these two handlers are its only reader
  // and writer for the renderer, and neither ever returns a credential value (only whether one is stored).
  const upstreamProxyView = async (): Promise<UpstreamProxyView> => {
    const { describeUpstreamProxy, upstreamProxyDeps, parseStoredProxyCredentials } = await import("../../permissions/upstream-proxy.js");
    const routerDeps = upstreamProxyDeps(deps.settingsService, (url) => session.defaultSession.resolveProxy(url));
    const settings = deps.settingsService.get("upstreamProxy");
    const stored = parseStoredProxyCredentials(deps.settingsService.getSecret(UPSTREAM_PROXY_CREDENTIALS_SECRET));
    return {
      settings,
      // Only credentials that would be sent count: bound to the manual proxy as it is now.
      hasCredentials: stored !== null && stored.origin === settings.manualUrl,
      diagnostic: await describeUpstreamProxy(routerDeps, UPSTREAM_PROXY_DIAGNOSTIC_URL),
    };
  };

  ipcMain.handle(PERMISSIONS.upstreamProxyGet, async (e) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, PERMISSIONS.upstreamProxyGet, e); return UNAUTHORIZED_FRAME; }
    return upstreamProxyView();
  });

  ipcMain.handle(PERMISSIONS.upstreamProxySet, async (e, payload: unknown) => {
    // This setter redirects all sandbox egress, and the keyboard-intent marker below is the renderer's own claim: it also requires the main
    // frame of one of Ave's own windows (the approvalRespond rule), never a subframe or another webContents that loads a host-renderer URL.
    const windows = deps.getAppWindows?.() ?? [deps.getMainWindow()];
    const appWindowMainFrame = e.senderFrame !== null && e.senderFrame === e.sender?.mainFrame
      && windows.some((window) => window?.webContents === e.sender);
    if (!validateHostRendererSender(e) || !appWindowMainFrame) { auditUnauthorized(auditLogger, PERMISSIONS.upstreamProxySet, e); return UNAUTHORIZED_FRAME; }
    const body = payloadRecord(payload);
    const intent = requireUserKeyboardIntent(body.intent);
    if (!intent.ok) return intent;
    const { parseProxyUrl, proxyOrigin, parseStoredProxyCredentials } = await import("../../permissions/upstream-proxy.js");
    const { normalizeUpstreamProxy } = await import("../../data/settings-normalization.js");
    const next = deps.settingsService.get("upstreamProxy");
    if (body.mode !== undefined) {
      if (typeof body.mode !== "string" || !(UPSTREAM_PROXY_MODES as readonly string[]).includes(body.mode)) {
        return { ok: false, error: "invalid-upstream-proxy-mode", message: "upstream proxy: mode must be off, system or manual" };
      }
      next.mode = body.mode as UpstreamProxySettings["mode"];
    }
    if (body.resolvesNames !== undefined) {
      if (typeof body.resolvesNames !== "boolean") {
        return { ok: false, error: "invalid-upstream-proxy-resolves-names", message: "upstream proxy: resolvesNames must be a boolean" };
      }
      next.resolvesNames = body.resolvesNames;
    }
    if (body.bypass !== undefined) {
      if (typeof body.bypass !== "string" || body.bypass.length > 8192) {
        return { ok: false, error: "invalid-upstream-proxy-bypass", message: "upstream proxy: the bypass list must be text of at most 8192 characters" };
      }
      next.bypass = body.bypass;
    }
    let credentials: { username: string; password: string } | undefined;
    if (body.manualUrl !== undefined) {
      if (typeof body.manualUrl !== "string" || body.manualUrl.length > 2048) {
        return { ok: false, error: "invalid-upstream-proxy-url", message: "upstream proxy: the URL must be text of at most 2048 characters" };
      }
      if (body.manualUrl.trim() === "") {
        next.manualUrl = "";
      } else {
        const parsed = parseProxyUrl(body.manualUrl);
        if (!parsed.ok) {
          return parsed.reason === "socks"
            ? { ok: false, error: "upstream-proxy-socks-unsupported", message: "upstream proxy: SOCKS proxies cannot be used as the sandbox's upstream" }
            : { ok: false, error: "invalid-upstream-proxy-url", message: "upstream proxy: enter http://host:port or https://host:port" };
        }
        next.manualUrl = proxyOrigin(parsed);
        credentials = parsed.auth;
      }
    }
    if (next.mode === "manual" && next.manualUrl === "") {
      return { ok: false, error: "upstream-proxy-url-required", message: "upstream proxy: manual mode needs a proxy URL" };
    }
    // Stored credentials are bound to the manual proxy's origin: entered with a URL, they are saved for that URL's origin; a URL
    // change to another host, port or scheme removes them (and says so), so the old proxy's password is never sent to the new one.
    let credentialsChange: "replaced" | "cleared" | "removed" | "unchanged" = "unchanged";
    if (credentials !== undefined) {
      await deps.settingsService.setSecret(UPSTREAM_PROXY_CREDENTIALS_SECRET, JSON.stringify({ ...credentials, origin: next.manualUrl }));
      credentialsChange = "replaced";
    } else if (body.clearCredentials === true) {
      await deps.settingsService.deleteSecret(UPSTREAM_PROXY_CREDENTIALS_SECRET);
      credentialsChange = "cleared";
    } else {
      const storedSecret = deps.settingsService.getSecret(UPSTREAM_PROXY_CREDENTIALS_SECRET);
      const stored = parseStoredProxyCredentials(storedSecret);
      if (storedSecret !== null && (stored === null || stored.origin !== next.manualUrl)) {
        await deps.settingsService.deleteSecret(UPSTREAM_PROXY_CREDENTIALS_SECRET);
        credentialsChange = "removed";
      }
    }
    // `set` notifies the boot router, which drops its cached routes.
    const stored = normalizeUpstreamProxy(next);
    await deps.settingsService.set("upstreamProxy", stored);
    auditLogger.log({
      timestamp: new Date().toISOString(),
      sessionId: "settings",
      type: "approval",
      output: `[upstream-proxy:set] mode=${stored.mode} manual=${stored.manualUrl === "" ? "-" : stored.manualUrl}`
        + ` credentials=${credentialsChange}`
        + ` bypassEntries=${stored.bypass === "" ? 0 : stored.bypass.split(",").filter((entry) => entry.trim() !== "").length}`
        + ` resolvesNames=${stored.resolvesNames}`,
    });
    return {
      ok: true as const,
      view: await upstreamProxyView(),
      ...(credentialsChange === "removed" ? { credentialsRemoved: true as const } : {}),
    };
  });

  // Only explicit user consent may trigger privilege elevation; reject foreign frames and synthetic gestures, with auditing.
  // Check intent synchronously before awaits, and invoke directly from the click because a status probe can outlast activation.
  ipcMain.handle(PERMISSIONS.sandboxWindowsInstall, async (e, payload: unknown): Promise<SandboxWindowsInstallResult | typeof UNAUTHORIZED_FRAME | { ok: false; error: string; message: string }> => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, PERMISSIONS.sandboxWindowsInstall, e); return UNAUTHORIZED_FRAME; }
    const body = payloadRecord(payload);
    const intent = requireUserKeyboardIntent(body.intent);
    if (!intent.ok) return intent;
    if (process.platform !== "win32") {
      return { ok: false, error: "not-applicable", message: "Windows sandbox install is only available on win32" };
    }
    return installAsrtWindowsSandbox();
  });

  ipcMain.handle(PERMISSIONS.approveExtensionsWithoutIsolation, async (e, payload: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, PERMISSIONS.approveExtensionsWithoutIsolation, e); return UNAUTHORIZED_FRAME; }
    const intent = requireUserKeyboardIntent(payloadRecord(payload).intent);
    if (!intent.ok) return intent;
    const failure = getAveHomePrivacyFailure();
    if (failure === undefined) return { ok: false, error: "not-applicable", message: "Home privacy approval is not applicable" };
    if (!areExtensionsWithoutIsolationApproved()) {
      auditLogger.log({ timestamp: new Date().toISOString(), sessionId: "permissions", type: "approval",
        output: JSON.stringify({ action: "extensions_without_isolation_approved", who: "user-ui",
          category: failure.category, path: failure.failedPath ?? failure.home }) });
      approveExtensionsWithoutIsolation();
    }
    return { ok: true };
  });

  ipcMain.handle(PERMISSIONS.setMode, async (e, payload: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, PERMISSIONS.setMode, e); return UNAUTHORIZED_FRAME; }
    const body = payloadRecord(payload);
    const intent = requireUserKeyboardIntent(body.intent);
    if (!intent.ok) return intent;
    return handleSetPermissionMode(deps, body.mode, {
      source: "settings-ui",
      trustOrigin: "user-keyboard",
      explicitUserAction: true,
    });
  });

  // read-only, sender guard optional
  ipcMain.handle(PERMISSIONS.listRules, async () => {
    const pm = conversationLoop.permissionManager;
    if (!pm) return [];
    return pm.listPersistedRules();
  });

  ipcMain.handle(PERMISSIONS.listScopedRules, async (e) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, PERMISSIONS.listScopedRules, e); return UNAUTHORIZED_FRAME; }
    const pm = conversationLoop.permissionManager;
    return pm ? pm.listScopedRules() : { rules: [], errors: [] };
  });

  ipcMain.handle(PERMISSIONS.removeScopedRule, async (e, payload: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, PERMISSIONS.removeScopedRule, e); return UNAUTHORIZED_FRAME; }
    const body = payloadRecord(payload);
    const intent = requireUserKeyboardIntent(body.intent);
    if (!intent.ok) return intent;
    const pm = conversationLoop.permissionManager;
    if (!pm) return { ok: false, error: "no-permission-manager" };
    try {
      // Only a row enumerated by this host can name a stored project identity.
      const listed = await pm.listScopedRules();
      const row = listed.rules.find((rule) => rule.pattern === body.pattern && rule.action === body.action &&
        rule.scope === body.scope && rule.projectCwd === body.projectCwd && rule.source === body.source &&
        rule.storedFile === body.storedFile);
      if (!row) return { ok: false, error: "invalid-rule" };
      await pm.removeRulePersist(row, row.scope === "project"
        ? { kind: "project", projectCwd: row.projectCwd!, storedFile: row.storedFile! } : { kind: "user" });
      deps.toolRegistry.setDenyRules(pm.getVisibilityDenyRules());
      return { ok: true };
    } catch (error) {
      return { ok: false, error: "remove-failed", message: errorMessage(error) };
    }
  });

  ipcMain.handle(PERMISSIONS.addRule, async (e, payload: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, PERMISSIONS.addRule, e); return UNAUTHORIZED_FRAME; }
    const body = payloadRecord(payload);
    const intent = requireUserKeyboardIntent(body.intent);
    if (!intent.ok) return intent;
    const action = body.action;
    if (action !== "allow" && action !== "deny") {
      return { ok: false, error: "invalid-action", message: `invalid action: '${action}' (allowed: allow, deny)` };
    }
    const validated = validateRulePatternInput(body.pattern);
    if (!validated.ok) return validated;
    const { parsePermissionRulesCommand } = await import("../../permissions/permission-slash.js");
    const ruleAction = action === "allow" ? "allow" : "deny";
    const parsed: PermissionRulesCommand | { ok: false; error: string } = isRuleSpecifier(validated.pattern)
      ? { verb: "rules", sub: "add", action: ruleAction, pattern: validated.pattern }
      : parsePermissionRulesCommand(`add ${ruleAction} ${validated.pattern}`);
    if (isParseError<PermissionRulesCommand>(parsed)) return { ok: false, error: "parse-error", message: parsed.error };
    if (parsed.sub !== "add") return { ok: false, error: "parse-error", message: "add rule command did not parse as add" };
    const pm = conversationLoop.permissionManager;
    if (!pm) return { ok: false, error: "no-permission-manager", message: "permission manager not initialized" };
    if (isRuleSpecifier(parsed.pattern)) {
      // The store's own check: refused prefixes, irreversible argv and wildcards outside the allowlist.
      try { validatePermissionRule({ pattern: parsed.pattern, action: parsed.action }); } catch (error) {
        return { ok: false, error: "invalid-rule", message: errorMessage(error) };
      }
    }
    try {
      if (isRuleSpecifier(parsed.pattern)) {
        await pm.addRulePersist({ pattern: parsed.pattern, action: parsed.action }, { kind: "user" });
      } else if (parsed.action === "allow") {
        await pm.addAlwaysAllowedPersist(parsed.pattern);
      } else {
        await pm.addAlwaysDeniedPersist(parsed.pattern);
      }
      deps.toolRegistry.setDenyRules(pm.getVisibilityDenyRules());
      // No explicit broadcast; PermissionManager.addAlwaysAllowed/DeniedPersist fire broadcastConfigChanged via the boot-wired setter.
      return { ok: true, rule: { pattern: parsed.pattern, action: parsed.action } };
    } catch (err) {
      return { ok: false, error: "add-failed", message: (err as Error).message };
    }
  });

  ipcMain.handle(PERMISSIONS.removeRule, async (e, payload: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, PERMISSIONS.removeRule, e); return UNAUTHORIZED_FRAME; }
    const body = payloadRecord(payload);
    const intent = requireUserKeyboardIntent(body.intent);
    if (!intent.ok) return intent;
    const action = body.action;
    if (action !== "allow" && action !== "deny") {
      return { ok: false, error: "invalid-action", message: `invalid action: '${action}' (allowed: allow, deny)` };
    }
    const validated = validateRulePatternInput(body.pattern);
    if (!validated.ok) return validated;
    const { parsePermissionRulesCommand } = await import("../../permissions/permission-slash.js");
    const ruleAction = action === "allow" ? "allow" : "deny";
    const parsed: PermissionRulesCommand | { ok: false; error: string } = isRuleSpecifier(validated.pattern)
      ? { verb: "rules", sub: "remove", action: ruleAction, pattern: validated.pattern }
      : parsePermissionRulesCommand(`remove ${ruleAction} ${validated.pattern}`);
    if (isParseError<PermissionRulesCommand>(parsed)) return { ok: false, error: "parse-error", message: parsed.error };
    if (parsed.sub !== "remove") return { ok: false, error: "parse-error", message: "remove rule command did not parse as remove" };
    const pm = conversationLoop.permissionManager;
    if (!pm) return { ok: false, error: "no-permission-manager", message: "permission manager not initialized" };
    try {
      await pm.removeRule(parsed.pattern, parsed.action);
      deps.toolRegistry.setDenyRules(pm.getVisibilityDenyRules());
      // No explicit broadcast; PermissionManager.removeRule fires broadcastConfigChanged via the boot-wired setter.
      return { ok: true };
    } catch (err) {
      return { ok: false, error: "remove-failed", message: (err as Error).message };
    }
  });

  // ave:approval:request direction is main→renderer (webContents.send); no ipcMain.handle needed
  ipcMain.handle(PERMISSIONS.approvalRespond, async (e, payload: unknown) => {
    if (!validateHostRendererSender(e) || !isNativeApprovalFrame(e)) { auditUnauthorized(auditLogger, PERMISSIONS.approvalRespond, e); return UNAUTHORIZED_FRAME; }
    const body = payloadRecord(payload);
    if (typeof body.requestId !== "string" ||
      body.userOwnedSurface !== undefined || body.userOwnedSurfaceReviewFallback !== undefined ||
      (body.choice !== "allow-once" && body.choice !== "allow-session" && body.choice !== "allow-always" && body.choice !== "deny-once" && body.choice !== "deny-always") ||
      (body.userOwnedSurfaceChoice !== undefined && !isUserOwnedSurfaceChoice(body.userOwnedSurfaceChoice))) {
      return { ok: false, error: "invalid-payload", message: "Invalid approval response" };
    }
    const decision = body as unknown as ApprovalDecision;
    const snapshot = approvalGate?.getRequestSnapshot?.(decision.requestId);
    const honoredDecision = await approvalGate?.resolveFromDesktopRendererWithFreshIdentity(decision.requestId, decision, e.sender);
    if (honoredDecision) reviewSuggestionTracker.record(deps, honoredDecision, snapshot);
    return { ok: true };
  });

  // Reloads and conversation moves recover only the live owner's signed cards.
  ipcMain.handle(PERMISSIONS.approvalPending, (e) => {
    if (!validateHostRendererSender(e) || !isNativeApprovalFrame(e)) { auditUnauthorized(auditLogger, PERMISSIONS.approvalPending, e); return UNAUTHORIZED_FRAME; }
    return approvalGate ? approvalGate.listPendingRendererRequests(e.sender) : [];
  });

  /** Approval-sentence results are proposals only; require the user to confirm an existing pending choice and never resolve the gate here.
   * Read identity and paths from the host pending entry, not renderer claims. */
  ipcMain.handle(PERMISSIONS.approvalSentenceSelect, async (e, payload: unknown) => {
    if (!validateHostRendererSender(e) || !isNativeApprovalFrame(e)) {
      auditUnauthorized(auditLogger, PERMISSIONS.approvalSentenceSelect, e);
      return UNAUTHORIZED_FRAME;
    }
    const body = payloadRecord(payload);
    // Only a keyboard-origin submission speaks for the user. Agent output, tool results and remote-controller text all reach the composer.
    const intent = requireUserKeyboardIntent(body.intent);
    if (!intent.ok) return intent;

    const rawInput = typeof body.input === "string" ? body.input : "";
    const requestId = typeof body.requestId === "string" ? body.requestId : "";
    const { dispatchPermissionSlash } = await import("../../permissions/permission-slash.js");
    const outcome = dispatchPermissionSlash(rawInput, "user-keyboard");
    if (outcome.kind !== "allow") {
      return {
        ok: false,
        error: "allow-parse-error",
        message: outcome.kind === "parse-error" ? outcome.error : "input is not an /allow command",
      };
    }

    const state = approvalGate?.getApprovalSentenceState(requestId) ?? null;
    if (!state) {
      return {
        ok: false,
        error: "allow-no-pending-request",
        message: "no pending directory approval matches this request id",
      };
    }
    if (!approvalGate!.canAccessRendererRequest(requestId, e.sender, "desk")) return UNAUTHORIZED_FRAME;
    const options = buildApprovalScopeOptions({
      candidatePath: state.candidatePath,
      suggestedParent: state.suggestedParent,
      ...(state.allowedChoices ? { allowedChoices: state.allowedChoices } : {}),
    });
    const selector = deps.getApprovalSentenceSelector?.();
    if (!selector) {
      return {
        ok: false,
        error: "allow-selector-unavailable",
        message: "approval sentence selector is not wired",
      };
    }
    // The reasoning-blind boundary. `ApprovalRequestFacts` is a CLOSED record, so this literal is where a future disclosure would have to be typed out deliberately; adding a field to the gate snapshot cannot leak through here, because an extra key is
    // a compile error rather than a passenger. The selector re-derives the wire envelope field by field for the same reason; this is the caller half of that boundary, not a second copy of it. Nothing agent-authored is in scope: no `reason`, no `args`.
    const facts: ApprovalRequestFacts = {
      toolName: state.toolName,
      category: state.toolCategory ?? "unknown",
      source: state.source,
      candidatePath: state.candidatePath,
    };
    const selection = await selector.select({
      sentence: outcome.cmd.sentence,
      request: facts,
      options,
    });
    switch (selection.outcome) {
      case "selected":
        // Only the choice crosses back. The host-resolved path stays here; the card derives the
        // same scope list from the same authority, so it already knows which path this choice means.
        return { ok: true, requestId, choice: selection.option.choice };
      case "declined":
        return {
          ok: false,
          error: "allow-no-match",
          message: "the sentence did not clearly name one of the offered scopes",
        };
      case "unavailable":
        return {
          ok: false,
          error: "allow-selector-unavailable",
          message: "no reviewer provider is configured",
        };
      case "error":
      case "malformed":
        return {
          ok: false,
          error: "allow-selection-failed",
          message: "the approval sentence could not be resolved",
        };
    }
  });

  // read-only, sender guard optional
  ipcMain.handle(PERMISSIONS.policyGet, async () => {
    const policy = await loadPolicy();
    // `editable` is host-derived, never re-derived in the renderer: it is the same predicate that decides whether `savePolicy` will accept a write.
    return { ...policy, editable: isPolicyUserEditable(policy) };
  });

  ipcMain.handle(
    PERMISSIONS.dirDispatch,
    async (e, args: { rawArgs: string }) => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, PERMISSIONS.dirDispatch, e);
        return UNAUTHORIZED_FRAME;
      }
      const { parsePermissionDirCommand, dispatchPermissionDirCommand } =
        await import("../../permissions/permission-slash.js");
      const parsed = parsePermissionDirCommand(args?.rawArgs ?? "");
      if (isParseError<PermissionDirCommand>(parsed)) return { ok: false, error: parsed.error };
      if (parsed.verb !== "list") {
        const intent = requireUserKeyboardIntent((args as { intent?: unknown } | undefined)?.intent);
        if (!intent.ok) return intent;
      }
      const lifecycle = getWorkspaceRootLifecycle();
      const requiresPersistentLifecycle =
        parsed.verb === "deny" || (parsed.verb === "allow" && !parsed.session);
      if (requiresPersistentLifecycle && !lifecycle) {
        // Fail closed: a Settings mutation must never fall back to the slash dispatcher's settings-only persistence path.
        return { ok: false, error: "workspace lifecycle unavailable" };
      }
      const result = await dispatchPermissionDirCommand(parsed, undefined, lifecycle);
      if (result.ok && result.verb === "allow" && result.sessionOnly && result.sessionDirectory) {
        conversationLoop.addSessionAdditionalDirectory(result.sessionDirectory);
      }
      // Notify all renderer windows whenever the directory config mutates (any successful allow/deny that touches persisted
      // or session additions). The `verb === "list"` short-circuit avoids spurious broadcasts from read-only list queries.
      if (result.ok && result.verb !== "list") {
        broadcastPermissionConfigChanged(deps);
      }
      return result;
    },
  );

  ipcMain.handle(
    PERMISSIONS.reviewerDispatch,
    async (e, args: { rawArgs: string }) => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, PERMISSIONS.reviewerDispatch, e);
        return UNAUTHORIZED_FRAME;
      }
      const { parsePermissionReviewerCommand, dispatchPermissionReviewerCommandWithRewire } =
        await import("../../permissions/permission-slash.js");
      const parsed = parsePermissionReviewerCommand(args?.rawArgs ?? "");
      if (isParseError<PermissionReviewerCommand>(parsed)) return { ok: false, error: parsed.error };
      if (parsed.verb !== "show") {
        const intent = requireUserKeyboardIntent((args as { intent?: unknown } | undefined)?.intent);
        if (!intent.ok) return intent;
      }
      const result = await dispatchPermissionReviewerCommandWithRewire(
        parsed,
        deps.rewireReviewerAgent,
      );
      // Surface the runtime degrade flag (persisted mode="llm" but wiring fell back to rule because no provider/key is configured). This is a
      // runtime condition computed at boot wiring, not a persisted setting, so it is read from the live PermissionManager rather than the settings file.
      if (result.ok) {
        const pm = conversationLoop.permissionManager;
        return {
          ...result,
          reviewerDegradedToRule: pm?.isReviewerDegradedToRule() ?? false,
        };
      }
      return result;
    },
  );

  // Denial history is host-only display data; reruns require a fresh user gesture and executor admission.
  ipcMain.handle(PERMISSIONS.recentlyDeniedList, async (event) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(auditLogger, PERMISSIONS.recentlyDeniedList, event);
      return UNAUTHORIZED_FRAME;
    }
    const entries = await conversationLoop.permissionManager?.getRecentlyDenied()?.list() ?? [];
    return { ok: true, entries };
  });

  ipcMain.handle(PERMISSIONS.recentlyDeniedRerun, async (event, payload: unknown) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(auditLogger, PERMISSIONS.recentlyDeniedRerun, event);
      return UNAUTHORIZED_FRAME;
    }
    if (!isNativeApprovalFrame(event)) return UNAUTHORIZED_FRAME;
    const body = payloadRecord(payload);
    const intent = requireUserKeyboardIntent(body.intent);
    if (!intent.ok) return intent;
    if (typeof body.id !== "string" || !/^[a-f0-9-]{36}$/.test(body.id)) {
      return { ok: false, error: "invalid-id" };
    }
    const history = conversationLoop.permissionManager?.getRecentlyDenied();
    if (!history) return { ok: false, error: "rerun-unavailable" };
    const result = await history.rerun(body.id);
    auditLogger.log({ timestamp: new Date().toISOString(), sessionId: "permissions", type: "approval",
      output: JSON.stringify({ action: "recently_denied_rerun", id: body.id, ok: result.ok }) });
    return result;
  });

  ipcMain.handle(PERMISSIONS.hookTrustList, async (e) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, PERMISSIONS.hookTrustList, e);
      return UNAUTHORIZED_FRAME;
    }
    const { listHookTrustState } = await import(
      "../../hooks/hook-trust-commands.js"
    );
    const state = listHookTrustState();
    return {
      ok: true,
      active: state.active,
      disabled: state.disabled,
      totalDisabled: state.disabled.length,
    };
  });

  // Audit entries can contain DLP-redacted tool inputs and decision metadata; gated so foreign frames cannot harvest them.
  ipcMain.handle(
    PERMISSIONS.auditShow,
    async (e, args: { last?: number }) => {
      if (!validateHostRendererSender(e)) {
        auditUnauthorized(auditLogger, PERMISSIONS.auditShow, e);
        return UNAUTHORIZED_FRAME;
      }
      const last = Math.max(1, Math.min(1000, Math.floor(args?.last ?? 50)));
      const { readRecentAuditEntries, summarizeAuditDir } = await import(
        "../../permissions/permission-audit-runner.js"
      );
      const dir = auditLogger.getAuditDir();
      const entries = readRecentAuditEntries(dir, last);
      const summary = summarizeAuditDir(dir);
      return { ok: true, entries, total: entries.length, summary };
    },
  );

  ipcMain.handle(PERMISSIONS.auditVerify, async (e) => {
    if (!validateHostRendererSender(e)) {
      auditUnauthorized(auditLogger, PERMISSIONS.auditVerify, e);
      return UNAUTHORIZED_FRAME;
    }
    const { verifyAllAuditFiles } = await import(
      "../../permissions/permission-audit-runner.js"
    );
    const secret = auditLogger.getPermissionAuditSecret();
    if (!secret) {
      return {
        ok: false,
        error: "audit-chain-not-initialized",
      };
    }
    const sealStore = auditLogger.getPermissionAuditSealStore() ?? undefined;
    const dir = auditLogger.getAuditDir();
    const result = verifyAllAuditFiles(dir, secret, sealStore);
    return {
      ok: true,
      intact: result.intact,
      totalFiles: result.totalFiles,
      totalEntries: result.totalEntries,
      firstBrokenFile: result.firstBrokenFile,
      perDay: result.perDay.map((d) => ({
        file: d.file,
        totalLines: d.totalLines,
        chainOk: d.result.ok,
        firstBrokenLineIndex: d.result.ok ? undefined : d.result.firstBrokenLineIndex,
        reason: d.result.ok ? undefined : d.result.reason,
        sealMatch: d.sealMatch,
      })),
    };
  });

  ipcMain.handle(PERMISSIONS.policySet, async (e, payload: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, PERMISSIONS.policySet, e); return UNAUTHORIZED_FRAME; }
    const body = payloadRecord(payload);
    const intent = requireUserKeyboardIntent(body.intent);
    if (!intent.ok) return intent;
    const patch = payloadRecord(body.patch);
    if ("managed" in patch) {
      return { ok: false, error: "invalid-patch", message: "'managed' field is read-only and cannot be modified by user" };
    }
    if ("requireExplicitApproval" in patch && typeof patch.requireExplicitApproval !== "boolean") {
      return { ok: false, error: "invalid-patch", message: "'requireExplicitApproval' must be a boolean" };
    }
    try {
      const updated = await savePolicy(patch as Parameters<typeof savePolicy>[0]);
      if (approvalGate) {
        approvalGate.setPolicy(updated);
      }
      return { ok: true, policy: updated };
    } catch (err) {
      return { ok: false, error: "managed", message: (err as Error).message };
    }
  });

  // ── User-Approval Store handlers ──────────────────────────

  ipcMain.handle(PERMISSIONS.userApprovalRecord, async (e, payload: unknown) => {
    if (!validateHostRendererSender(e) || !isNativeApprovalFrame(e)) { auditUnauthorized(auditLogger, PERMISSIONS.userApprovalRecord, e); return UNAUTHORIZED_FRAME; }
    const body = payloadRecord(payload);
    // parity with peer mutating handlers (addRule, removeRule, setMode, dirDispatch, reviewerDispatch, recentlyDeniedRerun, policySet).
    // Gates on user-keyboard freshness so a synthetic record submission from a compromised renderer cannot record without an active gesture.
    const intent = requireUserKeyboardIntent(body.intent);
    if (!intent.ok) return intent;
    const scope = body.scope;
    const decision = body.decision ?? "allow";
    const displayedVerdictAtApproval = body.verdictAtApproval;
    const nlJustification = body.nlJustification;
    const args = body.args;
    // Bind approval identity and input to the host's pending requestId; renderer-supplied identity would permit cache-key spoofing.
    // Accept only decision metadata after the fresh-user-intent gate.
    const requestId = body.requestId;
    if (typeof requestId !== "string" || requestId.length === 0) {
      return { ok: false, error: "invalid-request-id", message: "user-approval record: requestId required (server-side ApprovalRequest binding)" };
    }
    if (
      typeof args !== "string" ||
      (decision !== "allow" && decision !== "deny") ||
      (scope !== "session" && scope !== "persistent" && scope !== "global") ||
      (displayedVerdictAtApproval !== "low" && displayedVerdictAtApproval !== "medium" && displayedVerdictAtApproval !== "high")
    ) {
      return { ok: false, error: "invalid-payload", message: "user-approval record: invalid payload" };
    }
    if (decision === "deny" && scope === "session") {
      return { ok: false, error: "deny-requires-persistent-scope", message: "Exact deny decisions are managed persistently in Settings" };
    }
    // Server-side SOT lookup. If the approval already resolved/timed out or never existed, reject; we
    // never silently create an orphan entry that the renderer can later use to fish for memory hits.
    const snapshot = approvalGate?.getRequestSnapshot(requestId) ?? null;
    if (!approvalGate || !snapshot) {
      return { ok: false, error: "no-such-request", message: "user-approval record: no in-flight ApprovalRequest for requestId" };
    }
    if (!approvalGate.canAccessRendererRequest(requestId, e.sender, "desk")) return UNAUTHORIZED_FRAME;
    const capturedAuthority = approvalGate.capturePendingRequestIdentityGuard(requestId);
    if (!capturedAuthority) return { ok: false, error: "no-such-request", message: "Approval authority is unavailable" };
    const authority = {
      refresh: capturedAuthority.refresh,
      isCurrent: () => capturedAuthority.isCurrent() && approvalGate.canAccessRendererRequest(requestId, e.sender, "desk"),
    };
    if (!await authority.refresh() || !authority.isCurrent()) {
      return { ok: false, error: "no-such-request", message: "Approval authority is unavailable" };
    }
    if (body.rule !== undefined) {
      // A card's rule save (owner 2026-10-25, unified approval card): the renderer names the choice's action and scope and, only when the person edited it, the rule text. The host checks an edited rule against the card's own rule grammar and requires it to decide this very request; without one it stores the rule it derived itself.
      if (!approvalGate?.mayRecordFrom(requestId, e.sender)) {
        return { ok: false, error: "not-request-owner", message: "This request is answered from the window that owns its terminal tab" };
      }
      const manager = conversationLoop.permissionManager;
      const saveToken = manager === undefined ? undefined : approvalGate.beginApprovalRuleSave(requestId, manager.getPolicyEpoch());
      const saved = await saveApprovalCardRule(snapshot, payloadRecord(body.rule), { decision, scope, displayedVerdictAtApproval }, manager, authority);
      if (manager !== undefined) {
        approvalGate.completeApprovalRuleSave(saveToken, manager.getPolicyEpoch(), saved.ok && saved.action === "allow" ? saved.scope : undefined);
      }
      if (!saved.ok) return saved;
      auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: snapshot.sessionId ?? UNATTRIBUTED_APPROVAL_SESSION_ID,
        type: "approval",
        output: `[approval:remembered] store=rules decision=${saved.action} scope=${saved.scope} rule=${JSON.stringify(saved.pattern)} edited=${saved.edited} toolName=${JSON.stringify(snapshot.toolName)} source=${JSON.stringify(snapshot.source)}`,
      });
      broadcastPermissionConfigChanged(deps);
      return saved.warning === undefined ? { ok: true } : { ok: true, warning: saved.warning };
    }
    // A bash card remembers an allow only as its exact command rule, at any scope.
    if (decision === "allow" && snapshot.shellRule) {
      return { ok: false, error: "command-rule-required", message: "A shell allow is remembered only as its exact Bash(<command>) rule" };
    }
    if (!snapshot.durableApprovalRecordAllowed) {
      return { ok: false, error: "one-shot-not-recordable", message: "user-approval record: one-shot approvals cannot be recorded" };
    }
    // An allow for a session-only scope (browser actions) is never written to disk, whatever the renderer asked for: the lifetime is a property of
    // the host-derived scope, not of the button that was pressed. (A persistent exact deny stays available from Settings; it only ever narrows.)
    if (
      decision === "allow" &&
      scope !== "session" &&
      snapshot.approvalMemory?.kind === "key" &&
      isSessionOnlyApprovalMemoryScope(snapshot.approvalMemory.scope)
    ) {
      return { ok: false, error: "session-only-scope", message: "user-approval record: this approval can only be remembered for the current session" };
    }
    if (displayedVerdictAtApproval !== snapshot.verdictAtApproval) {
      return { ok: false, error: "verdict-mismatch", message: "user-approval record: displayed verdict does not match the host request" };
    }
    const verdictAtApproval = snapshot.verdictAtApproval;
    // Conservative risk display during a failed assessment does not decide persistence. Only the gate's live eligibility snapshot can authorize it.
    // Every session approval (shell, browser, terminal, any exact tool approval) belongs to the
    // root conversation of the request, so one without a conversation has nothing to be scoped to.
    if (scope === "session" && !snapshot.sessionId) {
      return { ok: false, error: "missing-session", message: "This request has no conversation session" };
    }
    // A project allow is bound to the request's working directory; a global one (owner 2026-10-25, "Always allow everywhere") applies in every project
    // and needs none, but the live request must still permit remembering it.
    if (decision === "allow" && (!snapshot.persistentAllowAllowed || (scope !== "global" && !snapshot.workingDirectoryIdentity))) {
      return { ok: false, error: verdictAtApproval === "high" ? "high-is-one-shot" : "one-shot-not-recordable", message: "This request requires a one-shot approval and cannot be recorded" };
    }
    try {
      // Canonicalize the host-owned raw input from ApprovalGate. The renderer still sends `args` for wire
      // compatibility and display, but it cannot swap the exact tuple that is persisted from Settings or the card.
      let canonicalArgs: string;
      try {
        if (snapshot.args === null || typeof snapshot.args !== "object" || Array.isArray(snapshot.args)) {
          return { ok: false, error: "args-not-object", message: "user-approval record: args must be a JSON object" };
        }
        canonicalArgs = canonicalStringify(snapshot.args);
      } catch {
        return { ok: false, error: "args-not-json", message: "user-approval record: args must be canonicalizable JSON" };
      }
      // Authority fields come from the main-process snapshot, never the renderer body. The renderer
      // contribution is reduced to decision metadata; the exact tool/input identity remains host-owned.
      const exactSaveToken = decision === "allow" ? approvalGate.beginExactApprovalSave(requestId, getUserApprovalGeneration()) : undefined;
      await recordApproval(snapshot.toolName, canonicalArgs, snapshot.source, {
        decision,
        scope,
        ...(scope === "session" ? { sessionId: snapshot.sessionId } : {}),
        ...(snapshot.projectCwd === undefined || scope === "global" ? {} : { projectCwd: snapshot.projectCwd }),
        verdictAtApproval,
        nlJustification: typeof nlJustification === "string" ? nlJustification : null,
        trustOrigin: snapshot.trustOrigin,
        // Throws (→ "managed") when the host request carried a key without its identity mode: never guess which identity to persist under.
        approvalCacheKey: approvalCacheKeyIdentity(snapshot.approvalCacheKey,
          decision === "deny" && snapshot.approvalMemory?.kind === "key" && snapshot.approvalMemory.scope.kind === "mcp-tool"
            ? { kind: "args" } : snapshot.approvalMemory),
        ...(decision === "allow" ? {
          workingDirectoryIdentity: snapshot.workingDirectoryIdentity,
          riskCeilingAtApproval: snapshot.riskCeilingAtApproval,
        } : {}),
      }, authority);
      if (decision === "allow") approvalGate.completeExactApprovalSave(exactSaveToken, getUserApprovalGeneration(), scope);
      auditLogger.log({
        timestamp: new Date().toISOString(),
        sessionId: snapshot.sessionId ?? UNATTRIBUTED_APPROVAL_SESSION_ID,
        type: "approval",
        output: `[approval:remembered] store=exact decision=${decision} scope=${scope} toolName=${JSON.stringify(snapshot.toolName)} source=${JSON.stringify(snapshot.source)}`,
      });
      // User-approval store mutation; outside PermissionManager, so emit the broadcast explicitly to keep the Active Approvals view in multi-window PermissionsTab fresh.
      broadcastPermissionConfigChanged(deps);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: "managed", message: (err as Error).message };
    }
  });

  ipcMain.handle(PERMISSIONS.userApprovalRevoke, async (e, payload: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, PERMISSIONS.userApprovalRevoke, e); return UNAUTHORIZED_FRAME; }
    // revoke is destructive (forces re-approval). Gate on user-keyboard intent for parity with peer mutating handlers. Payload contract: object `{ key, intent
    // }`. The preload bridge auto-injects `intent`; untrusted callers that submit a raw string key will fail the `payloadRecord` narrow and return `invalid-key`.
    const body = payloadRecord(payload);
    const intent = requireUserKeyboardIntent(body.intent);
    if (!intent.ok) return intent;
    const key = body.key;
    if (typeof key !== "string" || key.trim().length === 0) {
      return { ok: false, error: "invalid-key", message: "revoke: key must be a non-empty string" };
    }
    try {
      await revokeApprovalByKey(key.trim());
      // Destructive; emit broadcast so the Active Approvals table refreshes in any concurrently open PermissionsTab.
      broadcastPermissionConfigChanged(deps);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: "managed", message: (err as Error).message };
    }
  });

  ipcMain.handle(PERMISSIONS.userApprovalList, async (e, payload?: unknown) => {
    if (!validateHostRendererSender(e)) { auditUnauthorized(auditLogger, PERMISSIONS.userApprovalList, e); return UNAUTHORIZED_FRAME; }
    if (payloadRecord(payload).scope === "session") return listSessionApprovals();
    return listApprovals();
  });
}
