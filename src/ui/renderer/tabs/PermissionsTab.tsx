import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "../../../i18n/react.js";
import { t } from "../../../i18n/runtime.js";
import { useSandboxCapability } from "../hooks/use-sandbox-capability.js";
import { SandboxStatusBadge } from "../components/SandboxStatusBadge.js";
import { SandboxRestartDialog } from "../components/SandboxRestartDialog.js";
import { Badge } from "../../../components/ui/badge.js";
import { Button } from "../../../components/ui/button.js";
import { Checkbox } from "../../../components/ui/checkbox.js";
import { Input } from "../../../components/ui/input.js";
import { Label } from "../../../components/ui/label.js";
import { RadioGroup, RadioGroupItem } from "../../../components/ui/radio-group.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../../components/ui/select.js";
import type { UserApprovalScope, UserApprovalVerdict } from "../../../shared/permissions-events.js";
import { EXEC_MODE_OPTIONS, LONG_TOAST_TTL_MS } from "../constants.js";
import {
  isExecutionMode,
  normalizeExecutionMode,
  type ExecutionModeDisplay,
} from "../../../shared/permission-mode.js";
import { formatIpcError, resolveIpcErrorKey } from "../format-ipc-error.js";
import type {
  ExecutionMode,
  HookTrustRow,
  PermissionReviewerMode,
  PermissionReviewerSettings,
  ScopedPermissionRule,
  ScopedPermissionRuleError,
} from "../types.js";
import type {
  SandboxCapabilityInfo,
  SandboxMxcUnavailableReason,
  SandboxWindowsStatusInfo,
} from "../../../shared/sandbox-capability-info.js";
import { PERMISSION_REVIEWER_FRAMEWORK } from "../../../shared/permission-reviewer-framework.js";
import { RecentlyDeniedPanel } from "../components/permissions/RecentlyDeniedPanel.js";
import { isOwnerAwayAutoSkipMinutes } from "../../../shared/owner-away-permission.js";
import { AuditPanel } from "../components/permissions/AuditPanel.js";
import { PermissionJudgeContent } from "../components/permissions/PermissionJudgeContent.js";
import { EgressDenialsList } from "../components/permissions/EgressDenialsList.js";
import { EgressGrantsList } from "../components/permissions/EgressGrantsList.js";
import { UpstreamProxySettings } from "../components/permissions/UpstreamProxySettings.js";
import { EnvForcedNotice, useEnvForcedSettings } from "../components/EnvForcedNotice.js";
import { SettingsPageHeader, SettingsSection } from "../components/PageShell.js";
import { getApi } from "../api-client.js";
import { isIpcErrorResult } from "../types.js";
import { canonicalStringify } from "../../../shared/canonical-json.js";
import type { ExactDenyDraft } from "../exact-permission-decision.js";
import { TEST_IDS, execModeTestId, testIdSelector } from "../../../shared/test-ids.js";
import { errorMessage } from "../../../shared/error-message.js";

const DEFAULT_REVIEWER_SETTINGS: PermissionReviewerSettings = {
  mode: "disabled",
  fallbackOnError: "deny",
};

/** What the Windows install click led to, as the panel shows it. */
interface WindowsInstallOutcomeView {
  /** The main-side `outcome`, or `refused` / `unexpected` for other shapes. */
  outcome: string;
  tone: "success" | "info" | "warning" | "error";
  text: string;
  /** With `outcome: "failed"` / `refused`: the stable code main reported. */
  errorCode?: string;
}

/** Localized copy per stable failure code. Only the code crosses IPC: ASRT's message holds srt-win output and local paths, so it stays in the main log. */
const WINDOWS_INSTALL_FAILURE_COPY: Record<string, () => string> = {
  install_wfp_failed: () => t("permissionsTab.osSandboxWindowsInstallFailedWfp"),
  install_user_failed: () => t("permissionsTab.osSandboxWindowsInstallFailedUser"),
  install_config_conflict: () => t("permissionsTab.osSandboxWindowsInstallFailedConfigConflict"),
  install_ambient_failed: () => t("permissionsTab.osSandboxWindowsInstallFailedAmbient"),
  srt_win_not_found: () => t("permissionsTab.osSandboxWindowsInstallFailedHelperMissing"),
  "srt-win-not-found": () => t("permissionsTab.osSandboxWindowsInstallFailedHelperMissing"),
  "srt-win-integrity-mismatch": () => t("permissionsTab.osSandboxWindowsHelperIntegrityError"),
  unexpected: () => t("permissionsTab.osSandboxWindowsInstallFailedUnexpected"),
};

const WINDOWS_USER_STATE_LABEL: Record<string, () => string> = {
  absent: () => t("permissionsTab.osSandboxWindowsUserStateAbsent"),
  incomplete: () => t("permissionsTab.osSandboxWindowsUserStateIncomplete"),
  ready: () => t("permissionsTab.osSandboxWindowsUserStateReady"),
};

const WINDOWS_WFP_STATE_LABEL: Record<string, () => string> = {
  absent: () => t("permissionsTab.osSandboxWindowsWfpStateAbsent"),
  installed: () => t("permissionsTab.osSandboxWindowsWfpStateInstalled"),
  "cannot-read": () => t("permissionsTab.osSandboxWindowsWfpStateCannotRead"),
};

/** Boot degraded because the bundled Windows helper is missing or failed its integrity check. An env opt-in leaves
 * the toggles off, so the helper status and notice key on this as well as on the toggles, agreeing with the banner. */
function bootReportsWindowsHelperFailure(boot: SandboxCapabilityInfo["boot"] | undefined): boolean {
  return (boot?.action === "degrade" || boot?.action === "abort") &&
    boot.causes.some((cause) => cause === "windows-sandbox-missing" || cause === "windows-sandbox-integrity-failed");
}

function windowsStateLabel(labels: Record<string, () => string>, value: unknown): string {
  return typeof value === "string" && Object.hasOwn(labels, value)
    ? labels[value]()
    : t("permissionsTab.osSandboxWindowsStateUnknown");
}

const UNEXPECTED_WINDOWS_INSTALL_VIEW = (): WindowsInstallOutcomeView => ({
  outcome: "unexpected",
  tone: "error",
  text: t("permissionsTab.osSandboxWindowsInstallUnexpected"),
});

/** Every value `sandboxWindowsInstall` can resolve to; an outcome, an IPC refusal, an older shape, or something unexpected; becomes a visible
 * state. The click must never end looking like nothing happened (). No free text from main reaches the screen; only codes and localized copy do. */
function describeWindowsInstallResult(result: unknown): WindowsInstallOutcomeView {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    return UNEXPECTED_WINDOWS_INSTALL_VIEW();
  }
  const record = result as Record<string, unknown>;
  if (record.ok === false) {
    const code = ipcErrorCode(record.error);
    const message = code === "user-keyboard-required"
      ? t("permissionsTab.osSandboxWindowsInstallNeedsClick")
      : ipcFailureText("Windows install", record, t("formatIpcError.unknownError"));
    return { outcome: "refused", tone: "error", text: t("permissionsTab.osSandboxWindowsInstallError", { message }), errorCode: code };
  }
  // An older main process answers without `outcome`; read what it did say.
  const outcome = typeof record.outcome === "string"
    ? record.outcome
    : record.cancelled === true
      ? "cancelled"
      : record.ready === true
        ? "ready"
        : record.ready === false
          ? "installed-unverified"
          : undefined;
  switch (outcome) {
    case "ready":
      return { outcome, tone: "success", text: t("permissionsTab.osSandboxWindowsInstallReady") };
    case "already-ready":
      return { outcome, tone: "info", text: t("permissionsTab.osSandboxWindowsInstallAlreadyReady") };
    case "installed-unverified":
      return {
        outcome,
        tone: "warning",
        text: t("permissionsTab.osSandboxWindowsInstallUnverified", {
          userState: windowsStateLabel(WINDOWS_USER_STATE_LABEL, record.userState),
          wfpState: windowsStateLabel(WINDOWS_WFP_STATE_LABEL, record.wfpState),
        }),
      };
    case "cancelled":
      return { outcome, tone: "warning", text: t("permissionsTab.osSandboxWindowsInstallCancelled") };
    case "timed-out":
      return { outcome, tone: "error", text: t("permissionsTab.osSandboxWindowsInstallTimedOut") };
    case "failed": {
      const errorCode = ipcErrorCode(record.errorCode) ?? "unexpected";
      const text = Object.hasOwn(WINDOWS_INSTALL_FAILURE_COPY, errorCode)
        ? WINDOWS_INSTALL_FAILURE_COPY[errorCode]()
        : t("permissionsTab.osSandboxWindowsInstallFailedOther", { code: errorCode });
      return { outcome, tone: "error", text, errorCode };
    }
    default:
      return UNEXPECTED_WINDOWS_INSTALL_VIEW();
  }
}

/** Settings text for each reason MXC cannot carry agent shells (`mxc-windows.ts`). */
const MXC_UNAVAILABLE_REASON_KEY = {
  "not-windows": "permissionsTab.osSandboxWindowsMxcReasonNotWindows",
  "unsupported-arch": "permissionsTab.osSandboxWindowsMxcReasonUnsupportedArch",
  "binary-missing": "permissionsTab.osSandboxWindowsMxcReasonBinaryMissing",
  "probe-failed": "permissionsTab.osSandboxWindowsMxcReasonProbeFailed",
  "tier-unsupported": "permissionsTab.osSandboxWindowsMxcReasonTierUnsupported",
  "request-rejected": "permissionsTab.osSandboxWindowsMxcReasonRequestRejected",
  "launcher-mismatch": "permissionsTab.osSandboxWindowsMxcReasonLauncherMismatch",
  "powershell-start-failed": "permissionsTab.osSandboxWindowsMxcReasonPowershellStartFailed",
  "unverified-session": "permissionsTab.osSandboxWindowsMxcReasonUnverifiedSession",
} as const satisfies Record<SandboxMxcUnavailableReason, string>;

const WINDOWS_INSTALL_OUTCOME_TONE: Record<WindowsInstallOutcomeView["tone"], string> = {
  success: "border-success/(--opacity-medium) bg-success/(--opacity-faint) text-success",
  info: "border-info/(--opacity-medium) bg-info/(--opacity-soft) text-info",
  warning: "border-warning/(--opacity-medium) bg-warning/(--opacity-soft) text-warning",
  error: "border-destructive/(--opacity-medium) bg-destructive/(--opacity-subtle) text-destructive",
};


/** A thrown IPC failure as this tab shows it. The thrown text can carry paths and internal messages, so it goes to the renderer log, and the screen gets localized copy only. */
function thrownErrorText(context: string, error: unknown): string {
  console.warn(`[ave] permissions: ${context} failed:`, errorMessage(error));
  return t("formatIpcError.unknownError");
}

/** A stable machine code (`user-keyboard-required`), as opposed to free text. */
const IPC_ERROR_CODE_RE = /^[a-z][a-z0-9]*(?:[-_][a-z0-9]+)*$/;

function ipcErrorCode(value: unknown): string | undefined {
  return typeof value === "string" && value.length <= 80 && IPC_ERROR_CODE_RE.test(value)
    ? value
    : undefined;
}

function sandboxKindText(kind: unknown): string {
  if (kind === "full") return t("permissionsTab.osSandboxKindFull");
  if (kind === "partial") return t("permissionsTab.osSandboxKindPartial");
  if (kind === "none") return t("permissionsTab.osSandboxKindNone");
  return t("permissionsTab.osSandboxKindUnknown");
}

/** An `ok: false` IPC result as this tab shows it: a known code in its localized form, otherwise the action's own localized copy with the code. The free-text `message` (English, possibly with paths) is logged, not
 * shown. Some handlers (the slash-backed directory and reviewer dispatch) put free text in `error` itself, such as a "usage: /permission dir …" line; that is logged and replaced by the action's copy, without a code. */
function ipcFailureText(
  context: string,
  result: { readonly error?: unknown; readonly message?: unknown },
  fallback: string | ((code: string | undefined) => string),
): string {
  const error = typeof result.error === "string" && result.error ? result.error : undefined;
  const code = ipcErrorCode(error);
  console.warn(
    `[ave] permissions: ${context} failed:`,
    error ?? "-",
    typeof result.message === "string" ? result.message : "",
  );
  if (code && resolveIpcErrorKey(code)) return formatIpcError(code, undefined);
  // A template that places the code itself gets it (or "-"); a plain sentence gets the code appended.
  if (typeof fallback === "function") return fallback(code);
  return code ? `${fallback} (${code})` : fallback;
}

function formatRevokeError(error: string | undefined, message: string | undefined): string {
  return ipcFailureText("revoke", { error, message }, error === "invalid-key"
    ? t("permissionsTab.errorInvalidKey")
    : t("formatIpcError.unknownError"));
}

function formatReviewerDispatchError(error: string): string {
  if (error.startsWith("reviewer-rewire-failed:")) {
    // The detail is a raw exception message from main: log it, do not show it.
    console.warn("[ave] permissions: reviewer rewire failed:", error.slice("reviewer-rewire-failed:".length).trim());
    return [
      t("permissionsTab.errorReviewerRewireFailed"),
      t("permissionsTab.errorReviewerRewireHint"),
    ].join(" ");
  }
  if (error === "user-keyboard-required") return t("permissionsTab.errorUserKeyboardRequired");
  // A slash-parse failure arrives here as English free text; ipcFailureText logs it and shows the localized reviewer-error copy instead.
  return ipcFailureText("reviewer dispatch", { error }, t("permissionsTab.errorReviewerFallbackContext"));
}

function preserveSettingsScrollPosition(): () => void {
  const scroller = document.querySelector<HTMLElement>(".ave-settings-scroll");
  if (!scroller) return () => undefined;
  const top = scroller.scrollTop;
  return () => {
    requestAnimationFrame(() => {
      scroller.scrollTop = top;
    });
  };
}

/** This tab's fields are 11px, and a popup that opens from an 11px control must be 11px too; `SelectContent` carries the size so
 * its items inherit it, rather than each item pinning `text-sm` and the menu reading a size larger than the field it belongs to. */
const DENSE_SELECT_POPUP = "text-[11px]";

/** Selecting auto enables the reviewer; every other mode disables automatic review. */
export function reviewerModeForExecMode(m: ExecutionMode): PermissionReviewerMode {
  return m === "auto" ? "llm" : "disabled";
}

export function PermissionsTab({
  exactDenyDraft = null,
  onExactDenySaved,
  onDiscardExactDeny,
}: {
  exactDenyDraft?: ExactDenyDraft | null;
  onExactDenySaved?: (requestId: string) => void;
  onDiscardExactDeny?: () => void;
} = {}) {
  const { t } = useTranslation();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);


  const [banner, setBanner] = useState<{ type: "error" | "warn"; msg: string } | null>(null);
  const bannerTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => {
    if (bannerTimerRef.current !== null) {
      clearTimeout(bannerTimerRef.current);
      bannerTimerRef.current = null;
    }
  }, []);

  const showBanner = useCallback((type: "error" | "warn", msg: string) => {
    if (bannerTimerRef.current) clearTimeout(bannerTimerRef.current);
    setBanner({ type, msg });
    bannerTimerRef.current = setTimeout(() => setBanner(null), LONG_TOAST_TTL_MS);
  }, []);

  // "unknown" until the first host read lands, and whenever the host reports a mode this tab cannot name: no radio is selected rather than a wrong one.
  const [mode, setMode] = useState<ExecutionModeDisplay>("unknown");
  const [modeBusy, setModeBusy] = useState(false);
  const [ownerAwayAutoSkipMinutes, setOwnerAwayAutoSkipMinutes] = useState(0);
  const [ownerAwayBusy, setOwnerAwayBusy] = useState(false);
  const [ownerAwayRevision, setOwnerAwayRevision] = useState(0);

  // ── Explicit Approval Policy ──────────────────────
  const [requireExplicit, setRequireExplicit] = useState(true);
  const [policyManaged, setPolicyManaged] = useState(false);
  const [policyBusy, setPolicyBusy] = useState(false);
  const [policySource, setPolicySource] = useState<"defaults" | "user" | "admin" | "merged">("defaults");
  const [policyAdminPath, setPolicyAdminPath] = useState<string | undefined>(undefined);
  const [policyAdminReason, setPolicyAdminReason] = useState<string | undefined>(undefined);

  // ── Rule Editor ───────────────────────────────────
  const [rules, setRules] = useState<ScopedPermissionRule[]>([]);
  const [newPattern, setNewPattern] = useState("");
  const [newAction, setNewAction] = useState<"allow" | "deny">("allow");
  const [ruleLoadErrors, setRuleLoadErrors] = useState<ScopedPermissionRuleError[]>([]);
  const [approvalLoadError, setApprovalLoadError] = useState(false);
  const [rulesBusy, setRulesBusy] = useState(false);
  const [directories, setDirectories] = useState<string[]>([]);
  const [newDirectory, setNewDirectory] = useState("");
  const [dirsBusy, setDirsBusy] = useState(false);
  const [pendingDirectoryWarning, setPendingDirectoryWarning] = useState<{
    path: string;
    warnings: string[];
  } | null>(null);
  const [quarantinedHooks, setQuarantinedHooks] = useState<HookTrustRow[]>([]);
  const [auditOpen, setAuditOpen] = useState(false);
  const [userApprovals, setUserApprovals] = useState<Array<{
    key: string;
    decision?: "allow" | "deny";
    approvedAt: string;
    scope: UserApprovalScope;
    verdictAtApproval: UserApprovalVerdict;
    nlJustification: string | null;
    revokedAt: string | null;
    toolName?: string;
    source?: string;
    args?: string;
    projectCwd?: string;
    sessionId?: string;
  }>>([]);
  const [approvalsBusy, setApprovalsBusy] = useState(false);
  const [exactDenyBusy, setExactDenyBusy] = useState(false);
  const exactDenyFocusRef = useRef<HTMLDivElement>(null);
  const [reviewer, setReviewer] = useState<PermissionReviewerSettings>(DEFAULT_REVIEWER_SETTINGS);

  // ── OS Tool Sandbox ───────────────────────────────
  const { capability: sandboxCapability, statusQueryFailed: sandboxStatusQueryFailed, refresh: refreshSandboxCapability } =
    useSandboxCapability(window.ave?.permission, getApi().onSettingsUpdated);
  const [sandboxEnabled, setSandboxEnabled] = useState(false);
  const [sandboxRestartOpen, setSandboxRestartOpen] = useState(false);
  const sandboxRestartPending = sandboxCapability?.shell?.state === "pending-on"
    || sandboxCapability?.shell?.state === "pending-off" || sandboxCapability?.workerRestartPending === true;
  // `AVE_SANDBOX_ENABLED=1` is OR-ed with this setting at boot, so with the variable set the toggle cannot turn the sandbox off for
  // this run. The stored value still decides the next run without it, so the control stays usable; what was missing was saying so.
  const envForcedPaths = useEnvForcedSettings();
  const [sandboxBusy, setSandboxBusy] = useState(false);
  // Plugin-worker confinement: its own setting, so the shell toggle above never confines workers
  // and this one never confines shells. `AVE_PLUGIN_WORKER_CONFINEMENT=1` is OR-ed with it at boot.
  const [workerConfinementEnabled, setWorkerConfinementEnabled] = useState(false);
  const [workerConfinementBusy, setWorkerConfinementBusy] = useState(false);
  // Windows srt-win repair flow (the OS sandbox is normally provisioned at app-install time; this panel is the re-provision/repair fallback). `windowsStatus` holds the latest readiness snapshot once the user opts in on win32; the panel renders off it.
  // `windowsInstallPhase` is where a click is: "installing" (main checks status, then may raise the UAC prompt) or "refreshing" (re-reading status afterwards); while it is set the "Re-provision" button is disabled. `windowsInstallOutcome` is what the last click led to, shown until the next.
  const [windowsStatus, setWindowsStatus] = useState<SandboxWindowsStatusInfo | null>(null);
  const [windowsInstallPhase, setWindowsInstallPhase] = useState<"installing" | "refreshing" | null>(null);
  const windowsInstallBusy = windowsInstallPhase !== null;
  const [windowsInstallOutcome, setWindowsInstallOutcome] = useState<WindowsInstallOutcomeView | null>(null);

  // True once the panel has content on screen. After that, a refresh must not reach for the blank/error surface: `loading` replaces the WHOLE panel with one line, the scroll container collapses from ~4000px to
  // one viewport, and the browser clamps scrollTop to the new maximum. When the content comes back the scroll position is gone; which is why removing a rule at the bottom of the page threw the user back to the top.
  const hasLoadedRef = useRef(false);

  const fetchAll = useCallback(async () => {
    if (!hasLoadedRef.current) {
      setLoading(true);
      setError(null);
    }
    try {
      const [modeRes, policyRes, rulesRes, hookTrustRes, dirRes, reviewerRes, settingsRes] =
        await Promise.all([
          window.ave.permission.getMode(),
          window.ave.policy.get(),
          window.ave.permission.listScopedRules(),
          window.ave.permission.hookTrustList(),
          window.ave.permission.dirDispatch("list"),
          window.ave.permission.reviewerDispatch("show"),
          getApi().getSettings(),
        ]);
      if (!reviewerRes.ok) {
        throw new Error(reviewerRes.error);
      }
      setMode(normalizeExecutionMode(modeRes.mode));
      setOwnerAwayAutoSkipMinutes(settingsRes.permissions?.ownerAwayAutoSkipMinutes ?? 0);
      setRequireExplicit(policyRes.requireExplicitApproval);
      // Host-derived: `managed` alone misses an admin-dir file that does not set managed:true, which savePolicy still refuses to overwrite.
      setPolicyManaged(!policyRes.editable);
      setPolicySource((policyRes.source as "defaults" | "user" | "admin" | "merged") ?? "defaults");
      setPolicyAdminPath(policyRes.adminPath as string | undefined);
      setPolicyAdminReason(policyRes.adminStatus === "invalid" ? policyRes.adminReason : undefined);
      setRules(rulesRes.rules);
      setRuleLoadErrors(rulesRes.errors);
      setQuarantinedHooks(hookTrustRes.ok ? hookTrustRes.disabled : []);
      setDirectories(dirRes.ok && dirRes.verb === "list" ? dirRes.userAdditions : []);
      setReviewer(reviewerRes.settings);
      const osSandboxOn = settingsRes.features?.osToolSandbox ?? false;
      setSandboxEnabled(osSandboxOn);
      const workerConfinementOn = settingsRes.features?.pluginWorkerConfinement ?? false;
      setWorkerConfinementEnabled(workerConfinementOn);
    } catch (e) {
      console.warn("[ave] permissions: load failed:", errorMessage(e));
      const message = t("permissionsTab.errorLoadFailed");
      // Same rule for the failure surface. A refresh that fails still has the last-known state on screen,
      // so it reports through the banner instead of replacing what the user is reading with an error page.
      if (hasLoadedRef.current) showBanner("error", message);
      else setError(message);
    } finally {
      hasLoadedRef.current = true;
      setLoading(false);
    }
  }, [showBanner]);

  useEffect(() => { void fetchAll(); }, [fetchAll]);

  useEffect(() => {
    // On win32 with either setting ON (or a reported home-privacy / helper failure), surface the consent/setup state so
    // the panel persists across navigations until ready. Extension provisioning is separate from MXC shell readiness.
    const windowsSetupRelevant = sandboxEnabled || workerConfinementEnabled ||
      sandboxCapability?.homePrivacyError !== undefined || bootReportsWindowsHelperFailure(sandboxCapability?.boot);
    if (sandboxCapability?.platform !== "win32" || !windowsSetupRelevant) {
      setWindowsStatus(null);
      return;
    }
    let cancelled = false;
    void window.ave.permission.sandboxWindowsStatus().then((status) => {
      if (status.instructions) console.warn("[ave] permissions: Windows setup diagnostics:", status.instructions);
      if (!cancelled) setWindowsStatus(status);
    }).catch(() => { /* The explicit setup action reports repair errors. */ });
    return () => { cancelled = true; };
  }, [sandboxCapability?.platform, sandboxCapability?.homePrivacyError, sandboxCapability?.boot, sandboxEnabled, workerConfinementEnabled]);

  const fetchApprovals = useCallback(async () => {
    if (!window.ave?.userApproval) return;
    try {
      const list = await window.ave.userApproval.list();
      setUserApprovals(list.filter((a) => !a.revokedAt));
      setApprovalLoadError(false);
    } catch {
      setApprovalLoadError(true);
      try {
        const sessionEntries = await window.ave.userApproval.listSession();
        setUserApprovals(sessionEntries.filter((entry) => !entry.revokedAt));
      } catch {
        // Keep the corruption notice and the last known session rows.
        setUserApprovals((entries) => entries.filter((entry) => entry.scope === "session"));
      }
    }
  }, []);

  useEffect(() => { void fetchApprovals(); }, [fetchApprovals]);

  useEffect(() => {
    if (!exactDenyDraft) return;
    const frame = requestAnimationFrame(() => {
      const target = exactDenyFocusRef.current;
      target?.scrollIntoView({ block: "start" });
      target?.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [exactDenyDraft]);

  const handleDiscardExactDeny = useCallback(() => {
    onDiscardExactDeny?.();
    requestAnimationFrame(() => {
      const opener = document.querySelector<HTMLButtonElement>(
        testIdSelector(TEST_IDS.openPermanentDenySettings),
      );
      if (opener && !opener.disabled) {
        opener.focus();
        return;
      }
      document.querySelector<HTMLElement>(testIdSelector(TEST_IDS.settingsPageTitle))?.focus();
    });
  }, [onDiscardExactDeny]);

  const handleSaveExactDeny = useCallback(async () => {
    if (!exactDenyDraft || !window.ave?.userApproval) return;
    setExactDenyBusy(true);
    try {
      const result = await window.ave.userApproval.record({
        requestId: exactDenyDraft.requestId,
        toolName: exactDenyDraft.toolName,
        args: canonicalStringify(exactDenyDraft.args),
        source: exactDenyDraft.source,
        decision: "deny",
        scope: "persistent",
        verdictAtApproval: exactDenyDraft.verdictAtApproval,
        nlJustification: null,
        trustOrigin: exactDenyDraft.trustOrigin,
        approvalCacheKey: exactDenyDraft.approvalCacheKey,
      });
      if (!result.ok) {
        showBanner("error", ipcFailureText("exact deny save", result, t("permissionsTab.exactDenySaveFailed")));
        return;
      }
      await fetchApprovals();
      showBanner("warn", t("permissionsTab.exactDenySaved", { toolName: exactDenyDraft.toolName }));
      onExactDenySaved?.(exactDenyDraft.requestId);
      requestAnimationFrame(() => {
        document.querySelector<HTMLElement>(testIdSelector(TEST_IDS.settingsPageTitle))?.focus();
      });
    } catch (err) {
      showBanner("error", t("permissionsTab.errorRevokeFailed", { message: thrownErrorText("exact deny save", err) }));
    } finally {
      setExactDenyBusy(false);
    }
  }, [exactDenyDraft, fetchApprovals, onExactDenySaved, showBanner]);

  // Auto-refresh on cross-window directory/rule/user-approval config changes (persistent directory grants from the out-of-allowed-dir approval card, addRule/removeRule through PermissionManager SOT, userApprovalRecord/Revoke in
  // another window). Refresh BOTH `fetchAll` (rules + directories + mode) AND `fetchApprovals` (active approvals) so every PermissionsTab section stays in sync; the broadcast is a single hint event covering all permission-state mutations.
  useEffect(() => {
    const unsubscribe = window.ave?.permission?.onConfigChanged?.(() => {
      void fetchAll();
      void fetchApprovals();
    });
    return () => {
      unsubscribe?.();
    };
  }, [fetchAll, fetchApprovals]);

  useEffect(() => {
    const unsubscribe = window.ave?.permission?.onModeChanged?.((nextMode) => {
      setMode(normalizeExecutionMode(nextMode));
      void fetchAll();
    });
    return () => {
      unsubscribe?.();
    };
  }, [fetchAll]);

  // Revoked at once for every scope, persistent included. Removing a stored decision destroys nothing and grants nothing: the next
  // matching call simply follows the current policy and may ask again, which is the same position the user was in before they ever answered.
  const handleRevokeApproval = async (key: string, toolName: string) => {
    if (!window.ave?.userApproval) return;
    setApprovalsBusy(true);
    try {
      try {
        const result = await window.ave.userApproval.revokeByKey(key);
        if (!result.ok) {
          const message = formatRevokeError(result.error, result.message);
          showBanner("error", t("permissionsTab.errorRevokeFailed", { message }));
          return;
        }
      } catch (err) {
        showBanner("error", t("permissionsTab.errorRevokeFailed", { message: thrownErrorText("revoke", err) }));
        return;
      }
      try {
        await fetchApprovals();
        showBanner("warn", t("permissionsTab.successRevokeApproval", { toolName }));
      } catch (err) {
        showBanner(
          "warn",
          t("permissionsTab.errorRevokeRefreshFailed", { toolName, message: thrownErrorText("approval list refresh", err) }),
        );
      }
    } finally {
      setApprovalsBusy(false);
    }
  };

  const handleModeChange = async (m: ExecutionMode) => {
    const targetReviewerMode = reviewerModeForExecMode(m);
    if (
      (m === mode && reviewer.mode === targetReviewerMode) ||
      modeBusy
    ) {
      return;
    }
    setModeBusy(true);
    try {
      let modeChanged = m === mode;
      if (m !== mode) {
        const res = await window.ave.permission.setMode(m);
        if (res.ok) {
          setMode(normalizeExecutionMode(res.mode));
          modeChanged = true;
        } else {
          showBanner("error", ipcFailureText("mode change", res, t("permissionsTab.errorModeChangeFailed")));
          return;
        }
      }
      if (reviewer.mode !== targetReviewerMode) {
        if (!modeChanged) return;
        const reviewerRes = await window.ave.permission.reviewerDispatch(`mode ${targetReviewerMode}`);
        if (reviewerRes.ok) {
          setReviewer(reviewerRes.settings);
        } else {
          showBanner("error", formatReviewerDispatchError(reviewerRes.error));
          return;
        }
      }
    } catch (e) {
      showBanner("error", t("permissionsTab.errorModeChangeError", { message: thrownErrorText("mode change", e) }));
    } finally {
      setModeBusy(false);
    }
  };

  const handleOwnerAwayAutoSkip = async (value: number) => {
    if (ownerAwayBusy || value === ownerAwayAutoSkipMinutes) return;
    if (!isOwnerAwayAutoSkipMinutes(value)) {
      setOwnerAwayRevision((revision) => revision + 1);
      return;
    }
    setOwnerAwayBusy(true);
    try {
      const result = await getApi().updateSettings({ permissions: { ownerAwayAutoSkipMinutes: value } });
      if (isIpcErrorResult(result)) {
        showBanner("error", ipcFailureText("owner-away auto-skip", result, t("permissionsTab.ownerAwaySaveFailed")));
      } else {
        setOwnerAwayAutoSkipMinutes(value);
      }
    } catch {
      showBanner("error", t("permissionsTab.ownerAwaySaveFailed"));
    } finally {
      setOwnerAwayRevision((revision) => revision + 1);
      setOwnerAwayBusy(false);
    }
  };

  const handleExplicitToggle = async () => {
    if (policyManaged) return;
    setPolicyBusy(true);
    try {
      const next = !requireExplicit;
      const res = await window.ave.policy.set({ requireExplicitApproval: next });
      if (res.ok) {
        setRequireExplicit(next);
      } else if (res.error === "managed") {
        showBanner("warn", t("permissionsTab.errorPolicyManaged"));
      } else {
        showBanner("error", ipcFailureText("policy change", res, t("permissionsTab.errorPolicyChangeFailed")));
      }
    } finally {
      setPolicyBusy(false);
    }
  };

  // One write path for both confinement scopes. Each scope writes ONLY its own setting: the shell toggle writes `osToolSandbox`, the worker toggle
  // writes `pluginWorkerConfinement`, and neither reads or changes the other's value beyond deciding whether the Windows setup panel stays open.
  const toggleConfinementScope = async (scope: "shell" | "pluginWorkers") => {
    const isShell = scope === "shell";
    if (isShell ? sandboxBusy : workerConfinementBusy) return;
    const setEnabled = isShell ? setSandboxEnabled : setWorkerConfinementEnabled;
    const setBusy = isShell ? setSandboxBusy : setWorkerConfinementBusy;
    const next = !(isShell ? sandboxEnabled : workerConfinementEnabled);
    const label = isShell ? "OS sandbox toggle" : "plugin-worker confinement toggle";
    setBusy(true);
    setEnabled(next);
    // Clear any stale install outcome whenever a toggle moves.
    setWindowsInstallOutcome(null);
    try {
      const res = await getApi().updateSettings({
        features: isShell ? { osToolSandbox: next } : { pluginWorkerConfinement: next },
      });
      if (isIpcErrorResult(res)) {
        setEnabled(!next);
        showBanner("error", ipcFailureText(label, res, t(isShell
          ? "permissionsTab.osSandboxToggleFailed"
          : "permissionsTab.workerConfinementToggleFailed")));
        return;
      }
      // Re-read capability so the activation note reflects the new state.
      const capability = await refreshSandboxCapability();
      const pending = isShell
        ? capability?.shell?.state === "pending-on" || capability?.shell?.state === "pending-off"
        : capability?.workerRestartPending === true;
      setSandboxRestartOpen(pending);
    } catch (e) {
      setEnabled(!next);
      showBanner("error", t(isShell
        ? "permissionsTab.osSandboxToggleError"
        : "permissionsTab.workerConfinementToggleError", { message: thrownErrorText(label, e) }));
    } finally {
      setBusy(false);
    }
  };
  const handleSandboxToggle = () => toggleConfinementScope("shell");
  const handleWorkerConfinementToggle = () => toggleConfinementScope("pluginWorkers");
  const [privacyApprovalBusy, setPrivacyApprovalBusy] = useState(false);
  const handlePrivacyApproval = async () => {
    if (privacyApprovalBusy) return;
    setPrivacyApprovalBusy(true);
    try {
      const result = await window.ave.permission.approveExtensionsWithoutIsolation();
      if (!result.ok) {
        showBanner("error", t("permissionsTab.homePrivacyApprovalFailed"));
        return;
      }
      setWindowsStatus(await window.ave.permission.sandboxWindowsStatus());
    } catch (error) {
      showBanner("error", t("permissionsTab.homePrivacyApprovalFailed"));
      console.warn("[ave] extension isolation session approval failed:", errorMessage(error));
    } finally {
      setPrivacyApprovalBusy(false);
    }
  };

  // The ONLY user-consented privilege-escalation trigger. The OS sandbox is normally provisioned at app-install time (NSIS customInstall), so this is the manual REPAIR
  // / re-provision path; invoked from an explicit "Re-provision" click inside the win32 panel, never automatically. Triggers ASRT's single self-elevating UAC prompt.
  const handleWindowsInstall = async () => {
    if (windowsInstallBusy) return;
    setWindowsInstallOutcome(null);
    // The install is invoked straight from the click: preload stamps the click's transient user activation onto the call, and that
    // lapses after ~5 s. Main validates it at entry, then reads status (up to ~45 s) and raises the UAC prompt only when setup is needed ().
    setWindowsInstallPhase("installing");
    try {
      let view: WindowsInstallOutcomeView;
      try {
        view = describeWindowsInstallResult(await window.ave.permission.sandboxWindowsInstall());
      } catch (error) {
        // Main logs its own failure; this records the renderer's side of it.
        console.warn("[ave] sandboxWindowsInstall rejected:", errorMessage(error));
        view = { outcome: "refused", tone: "error", text: t("permissionsTab.osSandboxWindowsInstallRejected") };
      }
      if (view.outcome === "refused") {
        console.warn("[ave] sandboxWindowsInstall refused:", view.errorCode ?? "rejected");
      }
      // Shown whatever the status re-read says: an unchanged panel is exactly what made the click look
      // like a no-op. The user's opt-in stays ON in every case, so the panel remains the place to retry.
      setWindowsInstallOutcome(view);
      setWindowsInstallPhase("refreshing");
      try {
        setWindowsStatus(await window.ave.permission.sandboxWindowsStatus());
      } catch (error) {
        console.warn("[ave] sandboxWindowsStatus re-read failed:", errorMessage(error));
        showBanner("error", t("permissionsTab.osSandboxWindowsStatusRefreshFailed"));
      }
    } finally {
      setWindowsInstallPhase(null);
    }
  };

  const refreshRules = async () => {
    const r = await window.ave.permission.listScopedRules();
    setRules(r.rules);
    setRuleLoadErrors(r.errors);
  };

  const handleAddRule = async () => {
    const pattern = newPattern.trim();
    if (!pattern) return;
    setRulesBusy(true);
    try {
      const res = await window.ave.permission.addRule(pattern, newAction);
      if (res.ok) {
        setNewPattern("");
        await refreshRules();
      } else {
        showBanner("error", ipcFailureText("rule add", res, (code) => t("permissionsTab.errorRuleAddFailed", { error: code ?? "-" })));
      }
    } catch (e) {
      showBanner("error", t("permissionsTab.errorRuleAddError", { message: thrownErrorText("rule add", e) }));
    } finally {
      setRulesBusy(false);
    }
  };

  const handleRemoveRule = async (rule: ScopedPermissionRule) => {
    setRulesBusy(true);
    try {
      const res = await window.ave.permission.removeScopedRule(rule);
      if (res.ok) {
        await refreshRules();
      } else {
        showBanner("error", ipcFailureText("rule remove", res, (code) => t("permissionsTab.errorRuleRemoveFailed", { error: code ?? "-" })));
      }
    } catch (e) {
      showBanner("error", t("permissionsTab.errorRuleRemoveError", { message: thrownErrorText("rule remove", e) }));
    } finally {
      setRulesBusy(false);
    }
  };

  const refreshDirectories = async () => {
    const res = await window.ave.permission.dirDispatch("list");
    if (res.ok && res.verb === "list") {
      setDirectories(res.userAdditions);
    }
  };

  const handleAddDirectory = async (acknowledgeWarnings = false) => {
    const dir = newDirectory.trim();
    if (!dir) return;
    setDirsBusy(true);
    try {
      const command = acknowledgeWarnings
        ? `allow --ack-warnings ${formatPermissionDirArg(dir)}`
        : `allow ${formatPermissionDirArg(dir)}`;
      const res = await window.ave.permission.dirDispatch(command);
      if (res.ok && res.verb === "allow") {
        setNewDirectory("");
        setPendingDirectoryWarning(null);
        setDirectories(res.persisted);
        if (res.warnings.length > 0) {
          console.warn("[ave] permissions: directory warnings:", ...res.warnings);
          showBanner("warn", t("permissionsTab.directoryWarningBody"));
        }
      } else if (!res.ok) {
        const failed = res as {
          ok: false;
          error: string;
          warnings?: string[];
          requiresAcknowledgement?: boolean;
        };
        if (failed.requiresAcknowledgement && failed.warnings?.length) {
          console.warn("[ave] permissions: directory warnings:", ...failed.warnings);
          setPendingDirectoryWarning({ path: dir, warnings: failed.warnings });
          showBanner("warn", t("permissionsTab.warnDirectoryAckRequired"));
        } else {
          setPendingDirectoryWarning(null);
          showBanner("error", ipcFailureText("directory add", failed, t("permissionsTab.errorDirectoryAddFailed")));
        }
      }
    } catch (e) {
      setPendingDirectoryWarning(null);
      showBanner("error", t("permissionsTab.errorDirectoryAddError", { message: thrownErrorText("directory add", e) }));
    } finally {
      setDirsBusy(false);
    }
  };

  const handleRemoveDirectory = async (dir: string) => {
    const restoreScroll = preserveSettingsScrollPosition();
    setDirsBusy(true);
    try {
      const res = await window.ave.permission.dirDispatch(`deny ${formatPermissionDirArg(dir)}`);
      if (res.ok && res.verb === "deny") {
        setDirectories(res.persisted);
      } else if (!res.ok) {
        showBanner("error", ipcFailureText("directory remove", res, t("permissionsTab.errorDirectoryRemoveFailed")));
      }
    } catch (e) {
      showBanner("error", t("permissionsTab.errorDirectoryRemoveError", { message: thrownErrorText("directory remove", e) }));
    } finally {
      setDirsBusy(false);
      restoreScroll();
    }
  };

  const sandboxPotentialReason = sandboxCapability?.potentialReason ?? sandboxCapability?.reason ?? "";
  const sandboxRuntimeReason = sandboxCapability?.runtime?.reason ?? "";
  // The setting is on and the gate did not activate it this session. Distinct from the toggle being off; the user chose this and it did not take;
  // and distinct from "restart to apply", which is what an unchanged gate would mean. A gate that never ran (`null`) is NOT reported as either.
  const sandboxBoot = sandboxCapability?.boot ?? null;
  // The host could not reconcile its own shell sandbox observations. Only the shell row reports it; the rest of
  // the panel still renders the snapshot. The toggle stays usable: turning the setting off is what clears it.
  const shellStatusError = sandboxCapability?.shell?.state === "error";
  const sandboxDegraded =
    sandboxBoot !== null && (sandboxBoot.action === "degrade" || sandboxBoot.action === "abort");
  const windowsHelperRequested =
    sandboxEnabled || workerConfinementEnabled || bootReportsWindowsHelperFailure(sandboxBoot);
  // Windows: which substrate carries shells and extensions this session. Shown whenever boot recorded one, so an unavailable MXC is never silent.
  const windowsSubstrate = sandboxCapability?.windowsSubstrate ?? null;

  return (
    <div className="pr-1">
      <div className="space-y-6">
        <SettingsPageHeader
          title={t("permissionsTab.pageTitle")}
          description={t("permissionsTab.pageDescription")}
        />

        {/* ── 인라인 배너 (§F9 — alert 대체) ── */}
        {banner && (
          <div
            role={banner.type === "error" ? "alert" : "status"}
            aria-live={banner.type === "error" ? "assertive" : "polite"}
            aria-atomic="true"
            className={`flex items-start gap-2 rounded-md border px-3 py-2 text-[12px] ${banner.type === "error" ? "border-destructive/(--opacity-medium) bg-destructive/(--opacity-subtle) text-destructive" : "border-warning/(--opacity-medium) bg-warning/(--opacity-soft) text-warning"}`}
          >
            <span className="mt-0.5 flex-shrink-0">{banner.type === "error" ? "⚠" : "🔒"}</span>
            <span>{banner.msg}</span>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="ml-auto h-6 w-6 flex-shrink-0 opacity-60 hover:opacity-100"
              onClick={() => setBanner(null)}
              aria-label={t("permissionsTab.closeBannerAriaLabel")}
            >
              ✕
            </Button>
          </div>
        )}

        {exactDenyDraft ? (
          <div
            ref={exactDenyFocusRef}
            tabIndex={-1}
            className="scroll-mt-3 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
            data-testid="exact-deny-focus-target"
          >
            <SettingsSection
              title={t("permissionsTab.exactDenyDraftTitle")}
              description={t("permissionsTab.exactDenyDraftDescription")}
            >
              <div className="rounded-md border border-destructive/(--opacity-muted) bg-destructive/(--opacity-faint) p-3" data-testid="exact-deny-draft">
              <div className="grid gap-2 text-xs sm:grid-cols-2">
                <div>
                  <p className="text-[10px] text-muted-foreground">{t("permissionsTab.approvalsColTool")}</p>
                  <code className="break-all font-mono">{exactDenyDraft.toolName}</code>
                </div>
                <div>
                  <p className="text-[10px] text-muted-foreground">{t("permissionsTab.rulesColSource")}</p>
                  <code className="break-all font-mono">{exactDenyDraft.source}</code>
                </div>
              </div>
              <details className="group mt-3 overflow-hidden rounded-md border bg-background">
                <summary className="cursor-pointer px-3 py-2 text-xs font-semibold">
                  {t("permissionsTab.exactDenyReviewInput")}
                </summary>
                <pre className="max-h-48 overflow-auto border-t px-3 py-2 whitespace-pre-wrap break-all font-mono text-[11px]">
                  {JSON.stringify(exactDenyDraft.args, null, 2)}
                </pre>
              </details>
              <p className="mt-2 text-[11px] text-muted-foreground">
                {t("permissionsTab.exactDenyScopeNotice")}
              </p>
              <div className="mt-3 flex flex-wrap justify-end gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={exactDenyBusy}
                  onClick={handleDiscardExactDeny}
                >
                  {t("permissionsTab.cancelButton")}
                </Button>
                <Button
                  type="button"
                  variant="destructive"
                  size="sm"
                  disabled={exactDenyBusy}
                  onClick={() => void handleSaveExactDeny()}
                  data-testid="save-exact-deny"
                >
                  {t("permissionsTab.saveExactDeny")}
                </Button>
              </div>
              </div>
            </SettingsSection>
          </div>
        ) : null}

        {loading ? (
          <div
            className="py-8 text-center text-sm text-muted-foreground"
            data-testid="permissions-loading"
          >
            {t("permissionsTab.loading")}
          </div>
        ) : error ? (
          <div
            className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-destructive/(--opacity-medium) bg-destructive/(--opacity-subtle) px-3 py-2 text-sm text-destructive"
            data-testid="permissions-load-error"
          >
            <span className="min-w-0 break-words">{error}</span>
            <Button type="button" size="sm" variant="outline" onClick={() => void fetchAll()}>
              {t("permissionsTab.refreshButton")}
            </Button>
          </div>
        ) : (
          <>

        {quarantinedHooks.length > 0 && (
          <div
            data-testid="hook-quarantine-notice"
            className="rounded-md border border-warning/(--opacity-medium) bg-warning/(--opacity-soft) px-3 py-2 text-[12px] text-warning"
          >
            <div className="flex items-start gap-2">
              <Badge variant="secondary" className="mt-0.5 text-[10px] text-warning">
                {t("permissionsTab.hookQuarantineBadge", { count: quarantinedHooks.length })}
              </Badge>
              <div className="min-w-0 flex-1">
                <p className="font-medium">{t("permissionsTab.hookQuarantineTitle")}</p>
                <p className="mt-1 text-[11px]">
                  {t("permissionsTab.hookQuarantineInstructionBefore")}<code className="rounded bg-background/(--opacity-stronger) px-1 font-mono">/permission hooks list</code>{t("permissionsTab.hookQuarantineInstructionAfter")}
                </p>
                <div className="mt-2 flex flex-wrap gap-1">
                  {quarantinedHooks.slice(0, 3).map((hook) => (
                    <code key={hook.fileName} className="rounded border border-warning/(--opacity-medium) bg-background/(--opacity-stronger) px-1.5 py-0.5 font-mono text-[10px]">
                      {hook.fileName}
                    </code>
                  ))}
                  {quarantinedHooks.length > 3 && (
                    <span className="text-[10px] text-warning/(--opacity-intense)">
                      +{quarantinedHooks.length - 3}
                    </span>
                  )}
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                className="h-7 px-2 text-[11px]"
                onClick={() => void fetchAll()}
              >
                {t("permissionsTab.refreshButton")}
              </Button>
            </div>
          </div>
        )}

        {/* ── 현재 권한 정책 요약 ── */}
        <SettingsSection
          data-settings-section="permissions-policy-summary"
          title={t("permissionsTab.currentPolicySummaryTitle")}
          description={t("permissionsTab.currentPolicySummaryDescription")}
        >
          <div className="grid gap-2 sm:grid-cols-2">
            <div className="rounded-md border px-3 py-2">
              <p className="text-[11px] font-medium text-muted-foreground">{t("permissionsTab.summaryPolicyPreset")}</p>
              <p className="mt-1 text-sm font-medium">{EXEC_MODE_OPTIONS.find((opt) => opt.value === mode)?.label ?? t("permissionModeBadge.labelUnknown")}</p>
            </div>
            <div className="rounded-md border px-3 py-2">
              <p className="text-[11px] font-medium text-muted-foreground">{t("permissionsTab.summaryApprovalDialog")}</p>
              <p className="mt-1 text-sm font-medium">{requireExplicit ? t("permissionsTab.summaryExplicitRequired") : t("permissionsTab.summaryCloseDenies")}</p>
            </div>
          </div>
        </SettingsSection>

        <PermissionJudgeContent />

        {/* ── Section A: Permission Policy Preset ── */}
        <SettingsSection
          data-settings-section="permissions-policy"
          title={t("permissionsTab.policyTitle")}
          description={t("permissionsTab.policyDescription")}
        >
          <RadioGroup
            value={mode}
            disabled={modeBusy}
            aria-label={t("permissionsTab.policyAriaLabel")}
            onValueChange={(value) => {
              if (!isExecutionMode(value)) return;
              void handleModeChange(value);
            }}
            className="space-y-1.5"
          >
            {EXEC_MODE_OPTIONS.map((opt) => (
              <Label
                key={opt.value}
                htmlFor={`exec-mode-${opt.value}-radio`}
                data-testid={execModeTestId(opt.value)}
                className={`flex h-auto min-w-0 w-full cursor-pointer items-start justify-start gap-2.5 rounded-md border px-3 py-2 text-left text-sm font-normal ${mode === opt.value ? "border-primary bg-primary/(--opacity-subtle) hover:bg-primary/(--opacity-subtle)" : "border-muted hover:border-muted-foreground/(--opacity-medium)"}`}
              >
                <RadioGroupItem
                  id={`exec-mode-${opt.value}-radio`}
                  value={opt.value}
                  aria-label={opt.label}
                  className="mt-0.5"
                />
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{opt.label}</span>
                  <span className="mt-0.5 block text-[11px] text-muted-foreground">{opt.description}</span>
                  {opt.value === "auto" && mode === "auto" && (
                    <>
                      <span
                        className="mt-2 block rounded-md border bg-background/(--opacity-stronger) px-3 py-2 text-[11px] text-muted-foreground"
                        data-testid="auto-review-behavior"
                      >
                        {t("permissionsTab.autoReviewBehavior")}
                      </span>
                      <details
                        className="mt-2 rounded-md border bg-muted/(--opacity-light)"
                        data-testid={TEST_IDS.reviewerPromptPanel}
                        onClick={(event) => event.stopPropagation()}
                      >
                        <summary className="cursor-pointer px-3 py-2 text-[11px] font-semibold text-muted-foreground">
                          {t("permissionsTab.frameworkSystemPromptTitle")}
                        </summary>
                        <pre
                          className="max-h-44 overflow-auto border-t px-3 py-3 whitespace-pre-wrap break-all font-mono text-[11px] leading-relaxed"
                          data-testid="reviewer-system-prompt"
                        >
                          {PERMISSION_REVIEWER_FRAMEWORK.systemPrompt}
                        </pre>
                      </details>
                    </>
                  )}
                </span>
              </Label>
            ))}
          </RadioGroup>
        </SettingsSection>

        {/* ── Section B: Explicit Approval Policy ── */}
        <SettingsSection
          data-settings-section="permissions-approval-dialog"
          title={t("permissionsTab.approvalDialogTitle")}
          description={t("permissionsTab.approvalDialogDescription")}
        >
          <div className="flex items-center gap-3">
            <Checkbox
              checked={requireExplicit}
              aria-label={t("permissionsTab.approvalDialogCheckboxAriaLabel")}
              disabled={policyManaged || policyBusy}
              className="size-5"
              onCheckedChange={() => void handleExplicitToggle()}
            />
            <span className="text-sm">{requireExplicit ? t("permissionsTab.policyEnabled") : t("permissionsTab.policyDisabled")}</span>
            {policyManaged && <span className="text-base" title={t("permissionsTab.adminManagedTitle")}>🔒</span>}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="owner-away-auto-skip">{t("permissionsTab.ownerAwayAutoSkipLabel")}</Label>
            <p className="text-xs text-muted-foreground">{t("permissionsTab.ownerAwayAutoSkipHint")}</p>
            <Input
              key={ownerAwayRevision}
              id="owner-away-auto-skip"
              data-testid="owner-away-auto-skip"
              type="number"
              min={0}
              step={1}
              defaultValue={ownerAwayAutoSkipMinutes}
              disabled={ownerAwayBusy}
              aria-label={t("permissionsTab.ownerAwayAutoSkipLabel")}
              className="w-32"
              onBlur={(event) => void handleOwnerAwayAutoSkip(event.currentTarget.value === "" ? Number.NaN : Number(event.currentTarget.value))}
            />
          </div>
          {policyManaged && (
            <p className="rounded-md border border-warning/(--opacity-medium) bg-warning/(--opacity-soft) px-3 py-2 text-[11px] text-warning">
              {policyAdminReason
                ? t("permissionsTab.invalidAdminPolicy", { reason: policyAdminReason })
                : (policySource === "admin" || policySource === "merged") && policyAdminPath
                ? t("permissionsTab.adminPolicyWithPath", { policyAdminPath })
                : t("permissionsTab.adminPolicyNoPath")}
            </p>
          )}
        </SettingsSection>

        <RecentlyDeniedPanel showEmpty />

        {/* ── OS Tool Sandbox ── */}
        <SettingsSection
          data-settings-section="permissions-os-sandbox"
          title={t("permissionsTab.osSandboxTitle")}
          description={t("permissionsTab.osSandboxDescription")}
        >
          <SandboxStatusBadge capability={sandboxCapability} statusQueryFailed={sandboxStatusQueryFailed} onRetry={() => { void refreshSandboxCapability(); }} />
          <SandboxRestartDialog open={sandboxRestartOpen} onOpenChange={setSandboxRestartOpen} />
          {sandboxRestartPending && <Button variant="outline" onClick={() => setSandboxRestartOpen(true)}>{t("permissionsTab.sandboxRestartNow")}</Button>}
          <div className="flex items-start gap-3">
            <Checkbox
              checked={sandboxEnabled}
              data-testid="os-sandbox-toggle"
              aria-label={t("permissionsTab.osSandboxCheckboxAriaLabel")}
              disabled={sandboxBusy || !(sandboxCapability?.available ?? false)}
              className="mt-0.5 size-5"
              onCheckedChange={() => void handleSandboxToggle()}
            />
            <div className="min-w-0 space-y-0.5">
              <p className="text-sm">
                {t("permissionsTab.osSandboxShellLabel")}
                {" — "}
                {sandboxEnabled ? t("permissionsTab.osSandboxEnabled") : t("permissionsTab.osSandboxDisabled")}
              </p>
              <p className="text-[11px] text-muted-foreground">{t("permissionsTab.osSandboxShellHint")}</p>
              {shellStatusError ? (
                <p role="alert" data-testid="os-sandbox-shell-status-error" className="text-[11px] text-destructive">
                  {t("permissionsTab.osSandboxShellStatusError")}
                </p>
              ) : null}
            </div>
          </div>
          <EnvForcedNotice
            settingsPath="features.osToolSandbox"
            forcedPaths={envForcedPaths}
            messageKey="permissionsTab.osSandboxEnvForced"
            testId="os-sandbox-forced"
            className="mt-2"
          />
          <div className="mt-3 flex items-start gap-3">
            <Checkbox
              checked={workerConfinementEnabled}
              data-testid="worker-confinement-toggle"
              aria-label={t("permissionsTab.workerConfinementCheckboxAriaLabel")}
              disabled={workerConfinementBusy || !(sandboxCapability?.available ?? false)}
              className="mt-0.5 size-5"
              onCheckedChange={() => void handleWorkerConfinementToggle()}
            />
            <div className="min-w-0 space-y-0.5">
              <p className="text-sm">
                {t("permissionsTab.workerConfinementLabel")}
                {" — "}
                {workerConfinementEnabled ? t("permissionsTab.osSandboxEnabled") : t("permissionsTab.osSandboxDisabled")}
              </p>
              <p className="text-[11px] text-muted-foreground">{t("permissionsTab.workerConfinementHint")}</p>
            </div>
          </div>
          <EnvForcedNotice
            settingsPath="features.pluginWorkerConfinement"
            forcedPaths={envForcedPaths}
            messageKey="permissionsTab.workerConfinementEnvForced"
            testId="worker-confinement-forced"
            className="mt-2"
          />
          {sandboxCapability && !sandboxCapability.available ? (
            <p
              data-testid="os-sandbox-unavailable"
              className="rounded-md border border-warning/(--opacity-medium) bg-warning/(--opacity-soft) px-3 py-2 text-[11px] text-warning"
            >
              {t("permissionsTab.osSandboxUnavailable", { platform: sandboxCapability.platform })}
            </p>
          ) : null}
          {sandboxCapability && sandboxCapability.available ? (
            <div className="space-y-1 rounded-md border bg-muted/(--opacity-light) px-3 py-2 text-[11px] text-muted-foreground">
              <p className="font-medium text-foreground">{t("permissionsTab.osSandboxCapabilityHeading")}</p>
              <p>
                {sandboxCapability.platform === "darwin"
                  ? t("permissionsTab.osSandboxCapabilityMac")
                  : sandboxCapability.platform === "linux"
                    ? t("permissionsTab.osSandboxCapabilityLinux")
                    : sandboxCapability.platform === "win32"
                      ? t("permissionsTab.osSandboxCapabilityWindows")
                      : t("permissionsTab.osSandboxCapabilityOther")}
              </p>
              {sandboxPotentialReason ? (
                <p data-testid="os-sandbox-potential-reason">
                  {t("permissionsTab.osSandboxPotentialReason", { reason: sandboxKindText(sandboxCapability.kind) })}
                </p>
              ) : null}
              {sandboxRuntimeReason ? (
                <p data-testid="os-sandbox-runtime-reason">
                  {t("permissionsTab.osSandboxRuntimeReason", { reason: sandboxKindText(sandboxCapability.runtime?.kind) })}
                </p>
              ) : null}
              {sandboxCapability.workerRuntime ? (
                <p data-testid="worker-confinement-runtime-reason">
                  {t("permissionsTab.workerConfinementRuntimeReason", { reason: sandboxKindText(sandboxCapability.workerRuntime.kind) })}
                </p>
              ) : null}
            </div>
          ) : null}
          {sandboxDegraded && sandboxBoot ? (
            <div
              data-testid="os-sandbox-boot-degraded"
              className="space-y-1 rounded-md border border-warning/(--opacity-medium) bg-warning/(--opacity-soft) px-3 py-2 text-[11px] text-warning"
            >
              <p className="font-medium">{t("permissionsTab.osSandboxBootDegradedHeading")}</p>
              <p>{t("permissionsTab.osSandboxBootDegradedBody")}</p>
              {sandboxBoot.causes.length > 0 ? (
                <p
                  data-testid="os-sandbox-boot-degraded-detail"
                  className="whitespace-pre-line font-mono text-foreground"
                >
                  {sandboxBoot.causes.includes("windows-sandbox-integrity-failed")
                    ? t("permissionsTab.osSandboxWindowsHelperIntegrityError")
                    : sandboxBoot.causes.includes("windows-sandbox-missing")
                    ? t("inputActionBar.sandboxCauseWindowsSandboxMissing")
                    : sandboxBoot.reason === "degrade-windows-init-failed"
                    ? t("permissionsTab.osSandboxInitFailedHint")
                    : t("permissionsTab.osSandboxDiagnosticHint")}
                </p>
              ) : null}
              <p className="italic">
                {t("permissionsTab.osSandboxBootDegradedReason", { reason: ipcErrorCode(sandboxBoot.reason) ?? "unknown" })}
              </p>
            </div>
          ) : null}
          {windowsSubstrate ? (
            <div
              data-testid="os-sandbox-windows-substrate"
              data-shells={windowsSubstrate.shells}
              data-extensions={windowsSubstrate.extensions}
              data-mxc={windowsSubstrate.mxc.state}
              className="space-y-1 rounded-md border bg-muted/(--opacity-light) px-3 py-2 text-[11px] text-muted-foreground"
            >
              <p className="font-medium text-foreground">{t("permissionsTab.osSandboxWindowsSubstrateHeading")}</p>
              <p data-testid="os-sandbox-windows-substrate-shells">
                {windowsSubstrate.shells === "mxc"
                  ? t("permissionsTab.osSandboxWindowsShellsMxc")
                  : windowsSubstrate.mxc.state === "checking" && windowsSubstrate.shells === "approved-host"
                    ? t("permissionsTab.osSandboxWindowsShellsChecking")
                    : windowsSubstrate.shells === "approved-host"
                      ? t("permissionsTab.osSandboxWindowsShellsApprovedHost")
                      : t("permissionsTab.osSandboxWindowsShellsNone")}
              </p>
              {windowsSubstrate.shells === "mxc" ? (
                <p data-testid="os-sandbox-windows-bash-note">{t("permissionsTab.osSandboxWindowsBashNote")}</p>
              ) : null}
              {windowsSubstrate.mxc.state === "unavailable" ? (
                <p data-testid="os-sandbox-windows-mxc-reason" data-reason={windowsSubstrate.mxc.reason}>
                  {t("permissionsTab.osSandboxWindowsMxcUnavailable", {
                    reason: t(MXC_UNAVAILABLE_REASON_KEY[windowsSubstrate.mxc.reason]),
                    build: windowsSubstrate.windowsBuild ?? "?",
                  })}
                </p>
              ) : windowsSubstrate.mxc.state === "available" && windowsSubstrate.shells === "none" ? (
                <p data-testid="os-sandbox-windows-mxc-unused">
                  {t("permissionsTab.osSandboxWindowsMxcUnused", { build: windowsSubstrate.windowsBuild ?? "?" })}
                </p>
              ) : null}
              <p data-testid="os-sandbox-windows-substrate-extensions">
                {windowsSubstrate.extensions === "srt-win"
                  ? t("permissionsTab.osSandboxWindowsExtensionsSrtWin")
                  : t("permissionsTab.osSandboxWindowsExtensionsNone")}
              </p>
              {windowsSubstrate.extensionEgressIdentity === "shared" && windowsSubstrate.extensions === "srt-win" ? (
                <p data-testid="os-sandbox-windows-shared-identity">{t("permissionsTab.osSandboxWindowsSharedIdentity")}</p>
              ) : null}
            </div>
          ) : null}
          {/* ── Windows srt-win consent flow ── */}
          {(sandboxCapability?.profileReadDenyWarnings ?? windowsStatus?.profileReadDenyWarnings ?? []).map(({ path, principals }) => (
            <p key={path} data-testid="os-sandbox-windows-profile-read-deny-warning" role="alert"
              className="rounded-md border border-warning/(--opacity-medium) bg-warning/(--opacity-soft) px-3 py-2 text-[11px] text-warning">
              {principals?.length
                ? t("permissionsTab.osSandboxWindowsProfileReadDenyReadable", { path, principals: principals.join(", ") })
                : t("permissionsTab.osSandboxWindowsProfileReadDenyUnverified", { path })}
            </p>
          ))}
          {windowsInstallOutcome ? (
            <p
              data-testid="os-sandbox-windows-install-outcome"
              data-outcome={windowsInstallOutcome.outcome}
              data-error-code={windowsInstallOutcome.errorCode}
              role={windowsInstallOutcome.tone === "error" ? "alert" : "status"}
              className={`whitespace-pre-line rounded-md border px-3 py-2 text-[11px] ${WINDOWS_INSTALL_OUTCOME_TONE[windowsInstallOutcome.tone]}`}
            >
              {windowsInstallOutcome.text}
            </p>
          ) : null}
          {windowsInstallPhase ? (
            <p
              data-testid="os-sandbox-windows-install-pending"
              data-phase={windowsInstallPhase}
              role="status"
              className="text-[11px] italic text-muted-foreground"
            >
              {windowsInstallPhase === "installing"
                ? t("permissionsTab.osSandboxWindowsInstallPending")
                : t("permissionsTab.osSandboxWindowsInstallRefreshing")}
            </p>
          ) : null}
          {(windowsHelperRequested || windowsStatus?.homePrivacyError) && windowsStatus?.applicable && !windowsStatus.ready ? (
            windowsStatus.homePrivacyError ? (
              <div
                data-testid="os-sandbox-windows-home-privacy-error"
                role="alert"
                className="rounded-md border border-warning/(--opacity-medium) bg-warning/(--opacity-soft) px-3 py-2 text-[11px] text-warning"
              >
                {t("permissionsTab.osSandboxWindowsHomePrivacyError", {
                  path: windowsStatus.homePrivacyError.path,
                  reason: {
                    "directory-failed": t("permissionsTab.homePrivacyDirectoryFailed"),
                    "system-root-missing": t("permissionsTab.homePrivacySystemRootMissing"),
                    "identity-failed": t("permissionsTab.homePrivacyIdentityFailed"),
                    "icacls-failed": t("permissionsTab.homePrivacyIcaclsFailed"),
                    "read-back-failed": t("permissionsTab.homePrivacyReadBackFailed"),
                    "not-protected": t("permissionsTab.homePrivacyNotProtected"),
                    "invalid-owner-grant": t("permissionsTab.homePrivacyInvalidOwnerGrant"),
                    "owner-claim-failed": t("permissionsTab.homePrivacyOwnerClaimFailed"),
                    "reparse-point": t("permissionsTab.homePrivacyReparsePoint"),
                    "extra-principals": t("permissionsTab.homePrivacyExtraPrincipals", {
                      principals: (windowsStatus.homePrivacyError.extraPrincipals ?? []).map(({ sid, account }) => account ? `${sid} (${account})` : sid).join(", "),
                    }),
                  }[windowsStatus.homePrivacyError.category],
                })}
                {windowsStatus.homePrivacyError.approvedForSession ? (
                  <p>{t("permissionsTab.homePrivacyApprovedForSession")}</p>
                ) : (
                  <Button type="button" size="sm" variant="default" disabled={privacyApprovalBusy}
                    onClick={() => void handlePrivacyApproval()}>
                    {t("permissionsTab.homePrivacyApproveForSession")}
                  </Button>
                )}
              </div>
            ) : windowsStatus.helperError ? (
              <p
                data-testid="os-sandbox-windows-helper-unavailable"
                data-error-code={windowsStatus.helperError}
                role="status"
                className="rounded-md border border-warning/(--opacity-medium) bg-warning/(--opacity-soft) px-3 py-2 text-[11px] text-warning"
              >
                {windowsStatus.helperError === "srt-win-integrity-mismatch"
                  ? t("permissionsTab.osSandboxWindowsHelperIntegrityError")
                  : t("permissionsTab.osSandboxWindowsInstallFailedHelperMissing")}
              </p>
            ) : windowsStatus.userState !== "absent" ||
            windowsStatus.wfpState !== "absent" ? (
              // Install partially ran or status cannot be fully read. Show the localized setup guidance and keep the explicit retry action available. Setup does not require signing out.
              <div
                data-testid="os-sandbox-windows-setup-status"
                className="space-y-2 rounded-md border border-info/(--opacity-medium) bg-info/(--opacity-soft) px-3 py-2 text-[11px] text-info"
              >
                <p className="font-medium">{t("permissionsTab.osSandboxWindowsReloginHeading")}</p>
                <p className="italic">{t("permissionsTab.osSandboxWindowsReloginPending")}</p>
                <Button
                  type="button"
                  size="sm"
                  variant="default"
                  data-testid="os-sandbox-windows-install"
                  disabled={windowsInstallBusy}
                  onClick={() => void handleWindowsInstall()}
                >
                  {windowsInstallBusy
                    ? t("permissionsTab.osSandboxWindowsInstalling")
                    : t("permissionsTab.osSandboxWindowsInstallButton")}
                </Button>
              </div>
            ) : (
              // Sandbox not ready (install-time provisioning was cancelled/failed or the app was not installed via the
              // NSIS installer). REPAIR fallback: warning card + a "Re-provision" button. No auto-UAC; the user must click.
              <div
                data-testid="os-sandbox-windows-consent"
                className="space-y-2 rounded-md border border-warning/(--opacity-medium) bg-warning/(--opacity-soft) px-3 py-2 text-[11px] text-warning"
              >
                <p className="font-medium">{t("permissionsTab.osSandboxWindowsConsentHeading")}</p>
                <p>{t("permissionsTab.osSandboxWindowsConsentBody")}</p>
                <p className="italic">{t("permissionsTab.osSandboxWindowsReloginPending")}</p>
                <Button
                  type="button"
                  size="sm"
                  variant="default"
                  data-testid="os-sandbox-windows-install"
                  disabled={windowsInstallBusy}
                  onClick={() => void handleWindowsInstall()}
                >
                  {windowsInstallBusy
                    ? t("permissionsTab.osSandboxWindowsInstalling")
                    : t("permissionsTab.osSandboxWindowsInstallButton")}
                </Button>
              </div>
            )
          ) : null}
          <UpstreamProxySettings />
        </SettingsSection>

        {/* ── Network: what the sandbox proxy refused ── */}
        <SettingsSection
          data-settings-section="permissions-network"
          title={t("permissionsTab.networkTitle")}
          description={t("permissionsTab.networkDescription")}
        >
          <EgressGrantsList />
          <EgressDenialsList />
        </SettingsSection>

        {/* ── Section C: Rule Editor ── */}
        <SettingsSection
          data-settings-section="permissions-rules"
          title={t("permissionsTab.unifiedRulesTitle")}
          description={t("permissionsTab.unifiedRulesDescription")}
        >
          {ruleLoadErrors.length > 0 || approvalLoadError ? (
            <div role="alert" data-testid="permissions-rule-load-error" className="text-xs text-destructive">
              {t("permissionsTab.unifiedRulesLoadError")}
              {ruleLoadErrors.map((failure, index) => <p key={`${failure.filePath}:${index}`} className="break-all">{failure.filePath}</p>)}
              {approvalLoadError ? <p>{t("permissionsTab.savedApprovalsFile")}</p> : null}
            </div>
          ) : null}
          {rules.length === 0 && userApprovals.length === 0 ? (
            <p className="text-[11px] text-muted-foreground italic">{t("permissionsTab.rulesEmpty")}</p>
          ) : (
            <div className="min-w-0 overflow-x-auto rounded-md border">
              <table data-testid="permissions-rules-table" className="min-w-[560px] w-full text-xs">
                <thead><tr className="border-b bg-muted/(--opacity-medium)">
                  <th className="px-3 py-2 text-left">{t("permissionsTab.rulesColPattern")}</th>
                  <th className="px-3 py-2 text-left">{t("permissionsTab.rulesColAction")}</th>
                  <th className="px-3 py-2 text-left">{t("permissionsTab.approvalsColScope")}</th>
                  <th className="px-3 py-2 text-left">{t("permissionsTab.rulesColSource")}</th>
                  <th className="px-3 py-2" />
                </tr></thead>
                <tbody>
                  {rules.map((rule, index) => (
                    <tr key={`rule:${rule.scope}:${rule.projectCwd ?? ""}:${rule.pattern}:${rule.action}:${index}`} className="border-b last:border-0" data-rule-store="scoped">
                      <td className="max-w-[220px] break-all px-3 py-2 font-mono">
                        {rule.pattern}
                        {rule.invalidReason === "wildcard-not-allowlisted" ? (
                          <p data-testid="permissions-rule-invalid" className="break-normal whitespace-normal font-sans text-[10px] text-destructive">
                            {t("permissionsTab.ruleInvalidWildcardNotAllowlisted")}
                          </p>
                        ) : rule.action === "allow" && rule.pattern.startsWith("Bash(") ? (
                          <p data-testid="permissions-shell-outside-sandbox" className="break-normal whitespace-normal font-sans text-[10px] text-muted-foreground">{t("permissionsTab.shellOutsideSandbox")}</p>
                        ) : null}
                      </td>
                      <td className="px-3 py-2"><Badge variant={rule.action === "allow" ? "default" : "secondary"}>
                        {rule.action === "allow" ? t("permissionsTab.actionAllow") : rule.action === "deny" ? t("permissionsTab.actionDeny") : t("permissionsTab.actionAsk")}
                      </Badge></td>
                      <td className="max-w-[180px] break-all px-3 py-2">
                        {rule.scope === "project" ? t("permissionsTab.scopeProject") : t("permissionsTab.scopeUser")}
                        {rule.projectCwd ? <p className="text-[10px] text-muted-foreground">{rule.projectCwd}</p> : null}
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{rule.source ?? t("permissionsTab.sourceAll")}</td>
                      <td className="px-3 py-2"><Button type="button" variant="ghost" size="sm" disabled={rulesBusy}
                        onClick={() => void handleRemoveRule(rule)} aria-label={t("permissionsTab.revokeNamedRule", { pattern: rule.pattern })}>
                        {t("permissionsTab.revokeButton")}
                      </Button></td>
                    </tr>
                  ))}
                  {userApprovals.map((approval) => (
                    <tr key={`exact:${approval.key}`} className="border-b last:border-0" data-rule-store="exact">
                      <td className="max-w-[220px] break-all px-3 py-2 font-mono">
                        {approval.toolName ?? approval.key.slice(0, 12)}
                        <p className="text-[10px] text-muted-foreground">{t("permissionsTab.exactApprovalLabel")}</p>
                      </td>
                      <td className="px-3 py-2"><Badge variant={approval.decision === "deny" ? "secondary" : "default"}>
                        {approval.decision === "deny" ? t("permissionsTab.actionDeny") : t("permissionsTab.actionAllow")}
                      </Badge></td>
                      <td className="max-w-[180px] break-all px-3 py-2">
                        {approval.scope === "session" ? t("permissionsTab.scopeSession") : approval.scope === "global" ? t("permissionsTab.scopeGlobal") : t("permissionsTab.scopePersistent")}
                        <p className="text-[10px] text-muted-foreground">{approval.scope === "session" ? approval.sessionId : approval.scope === "global" ? t("permissionsTab.scopeGlobalTarget") : approval.projectCwd}</p>
                      </td>
                      <td className="px-3 py-2 text-muted-foreground">{approval.source ?? t("permissionsTab.sourceAll")}</td>
                      <td className="px-3 py-2"><Button type="button" variant="ghost" size="sm" disabled={approvalsBusy}
                        onClick={() => void handleRevokeApproval(approval.key, approval.toolName ?? approval.key.slice(0, 12))}>
                        {t("permissionsTab.revokeButton")}
                      </Button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex items-center gap-2">
            <Input
              className="h-8 flex-1 text-xs"
              placeholder={t("permissionsTab.patternInputPlaceholder")}
              data-testid="permissions-rule-pattern-input"
              value={newPattern}
              onChange={(e) => setNewPattern(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && newPattern.trim()) void handleAddRule(); }}
            />
            <Select
              value={newAction}
              onValueChange={(value) => setNewAction(value as "allow" | "deny")}
            >
              <SelectTrigger className="h-8 w-24 text-xs">
                <SelectValue />
              </SelectTrigger>
              <SelectContent className={DENSE_SELECT_POPUP}>
                <SelectItem value="allow">{t("permissionsTab.actionAllow")}</SelectItem>
                <SelectItem value="deny">{t("permissionsTab.actionDeny")}</SelectItem>
              </SelectContent>
            </Select>
            <Button size="sm" className="h-8" data-testid="permissions-rule-add" onClick={() => void handleAddRule()} disabled={rulesBusy || !newPattern.trim()}>
              {t("permissionsTab.addButton")}
            </Button>
          </div>
        </SettingsSection>

        {/* ── Section D: Additional Directories ── */}
        <SettingsSection
          data-settings-section="permissions-directories"
          title={t("permissionsTab.directoriesTitle")}
          description={t("permissionsTab.directoriesDescription")}
          actions={
            <Button
              variant="outline"
              size="sm"
              className="h-7 px-2 text-[11px]"
              onClick={() => void refreshDirectories()}
              disabled={dirsBusy}
            >
              {t("permissionsTab.refreshButton")}
            </Button>
          }
        >
          {directories.length === 0 ? (
            <p className="text-[11px] text-muted-foreground italic">{t("permissionsTab.directoriesEmpty")}</p>
          ) : (
            <div className="rounded-md border">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b bg-muted/(--opacity-medium)">
                    <th className="px-3 py-2 text-left font-medium">{t("permissionsTab.directoriesColPath")}</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {directories.map((dir) => (
                    <tr key={dir} className="border-b last:border-0 hover:bg-muted/(--opacity-light)">
                      <td className="min-w-0 px-3 py-1.5 font-mono text-[11px]">
                        <span className="block whitespace-normal break-all" title={dir}>{dir}</span>
                      </td>
                      <td className="px-3 py-1.5 text-right">
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 text-[10px] text-muted-foreground hover:text-destructive"
                          disabled={dirsBusy}
                          onClick={() => void handleRemoveDirectory(dir)}
                        >
                          ✕
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex items-center gap-2">
            <Input
              className="h-8 flex-1 text-xs"
              placeholder={t("permissionsTab.directoryInputPlaceholder")}
              value={newDirectory}
              onChange={(e) => {
                setNewDirectory(e.target.value);
                setPendingDirectoryWarning(null);
              }}
              onKeyDown={(e) => { if (e.key === "Enter" && newDirectory.trim()) void handleAddDirectory(); }}
            />
            <Button size="sm" className="h-8" onClick={() => void handleAddDirectory()} disabled={dirsBusy || !newDirectory.trim()}>
              {t("permissionsTab.addButton")}
            </Button>
          </div>
          {pendingDirectoryWarning && pendingDirectoryWarning.path === newDirectory.trim() && (
            <div
              data-testid="directory-warning-confirmation"
              className="rounded-md border border-warning/(--opacity-medium) bg-warning/(--opacity-soft) px-3 py-2 text-[12px] text-warning"
            >
              <p className="font-medium">{t("permissionsTab.directoryWarningTitle")}</p>
              <p className="mt-1">{t("permissionsTab.directoryWarningBody")}</p>
              <div className="mt-2 flex gap-2">
                <Button
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                  onClick={() => void handleAddDirectory(true)}
                  disabled={dirsBusy}
                >
                  {t("permissionsTab.directoryWarningConfirmButton")}
                </Button>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 px-2 text-[11px]"
                  onClick={() => setPendingDirectoryWarning(null)}
                  disabled={dirsBusy}
                >
                  {t("permissionsTab.cancelButton")}
                </Button>
              </div>
            </div>
          )}
        </SettingsSection>

        {/* ── Audit Log ── */}
        <SettingsSection
          data-settings-section="permissions-audit-log"
          title={t("permissionsTab.auditLogTitle")}
          description={t("permissionsTab.auditLogDescription")}
          actions={auditOpen ? undefined : (
            <Button size="sm" variant="outline" className="h-8 px-3 text-[12px]" onClick={() => setAuditOpen(true)}>
              {t("permissionsTab.auditLogOpenButton")}
            </Button>
          )}
        >
          <p className="text-[11px] text-muted-foreground">{t("permissionsTab.auditLogHelp")}</p>
          {/* The log opens INSIDE this section, so it takes the pane's own
              width and pushes the sections below it down. A panel fixed to the
              window edge would cover the tiles beside this one and the title
              bar, and its 480px would not fit a tile at the width floor. */}
          <AuditPanel open={auditOpen} onClose={() => setAuditOpen(false)} />
        </SettingsSection>

          </>
        )}

      </div>
    </div>
  );
}

function formatPermissionDirArg(path: string): string {
  return /[\s"']|^-/.test(path) ? JSON.stringify(path) : path;
}
