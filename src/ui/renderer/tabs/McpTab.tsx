import { useCallback, useEffect, useId, useRef, useState } from "react";
import { Badge } from "../../../components/ui/badge.js";
import { Button } from "../../../components/ui/button.js";
import { Checkbox } from "../../../components/ui/checkbox.js";
import { Input } from "../../../components/ui/input.js";
import { Label } from "../../../components/ui/label.js";
import { NativeSelect, NativeSelectOption } from "../../../components/ui/native-select.js";
import { ScrollArea } from "../../../components/ui/scroll-area.js";
import { Separator } from "../../../components/ui/separator.js";
import { Textarea } from "../../../components/ui/textarea.js";
import type { McpManagementState } from "../../../mcp/types.js";
import type { McpAuthErrorCode, McpServerConfig, McpServerConfigDto, McpServerState } from "../types.js";
import { NoticeLiveRegion, NoticeToast } from "../components/StatusBar.js";
import { useInlineNotice } from "../hooks/use-status-bar.js";
import { SettingsControlActions, useSettingsControls, useSettingsEditor, type SettingsControlDescriptor } from "../context/SettingsEditorContext.js";
import { isIpcErrorResult } from "../types.js";
import { useNotifySaved } from "../context/SavedToastContext.js";
import { SettingsPageHeader } from "../components/PageShell.js";
import { t } from "../../../i18n/runtime.js";
import { useTranslation } from "../../../i18n/react.js";
import { formatDateTime } from "../../../shared/format-time.js";
import { errorMessage } from "../../../shared/error-message.js";
import { MCP_CONFIG_RECOVERY_REQUIRED, MCP_CREDENTIAL_MIGRATION_FAILED, MCP_GOVERNANCE_UNAPPROVED_SERVER } from "../../../shared/mcp-error-code.js";
import { invokeErrorCode, invokeErrorDetail } from "../format-ipc-error.js";
import { isValidOAuthClientId, MAX_OAUTH_CLIENT_ID_LEN } from "../../../mcp/safe-names.js";

function getMcpRecoveryError(error: unknown): string | undefined {
  return errorMessage(error).includes(`${MCP_CONFIG_RECOVERY_REQUIRED}:`) ? t("mcpTab.configRecoveryRequired") : undefined;
}

type Transport = "stdio" | "http";

const AUTH_STATUS_POLL_MS = 3_000;

const STATUS_BADGE: Record<McpServerState["status"], string> = {
  connected: "bg-success/(--opacity-soft) text-success",
  connecting: "bg-warning/(--opacity-soft) text-warning",
  disconnected: "bg-muted text-muted-foreground",
  error: "bg-destructive/(--opacity-soft) text-destructive",
};

function getStatusLabel(status: McpServerState["status"]): string {
  const labels: Record<McpServerState["status"], string> = {
    connected: t("mcpTab.statusConnected"),
    connecting: t("mcpTab.statusConnecting"),
    disconnected: t("mcpTab.statusDisconnected"),
    error: t("mcpTab.statusError"),
  };
  return labels[status];
}

function getAuthStatusLabel(status: NonNullable<McpServerState["authStatus"]>): string {
  const labels = {
    required: t("mcpTab.authRequired"),
    authenticating: t("mcpTab.authenticating"),
    authenticated: t("mcpTab.authenticated"),
    insufficient_scope: t("mcpTab.authStepUpRequired"),
    error: t("mcpTab.authError"),
  };
  return labels[status];
}

/** Localized guidance for a host authorization failure code; never provider text. */
function getAuthErrorMessage(code: McpAuthErrorCode | undefined): string {
  switch (code) {
    case "mcp-auth-required": return t("mcpTab.authRequiredMessage");
    case "mcp-auth-device-unsupported": return t("mcpTab.authDeviceUnsupportedMessage");
    case "mcp-auth-device-headless": return t("mcpTab.authDeviceHeadlessMessage");
    case "mcp-auth-device-denied": return t("mcpTab.authDeviceDeniedMessage");
    case "mcp-auth-device-expired": return t("mcpTab.authDeviceExpiredMessage");
    case "mcp-auth-device-canceled": return t("mcpTab.authDeviceCanceledMessage");
    case "mcp-auth-dpop-unsupported": return t("mcpTab.authDpopUnsupportedMessage");
    case "mcp-auth-dpop-failed": return t("mcpTab.authDpopFailedMessage");
    case "mcp-auth-storage-unavailable": return t("mcpTab.authStorageUnavailableMessage");
    case "mcp-auth-storage-unreadable": return t("mcpTab.authStorageUnreadableMessage");
    case "mcp-auth-registration-unsupported": return t("mcpTab.authRegistrationUnsupportedMessage");
    case "mcp-auth-resource-mismatch": return t("mcpTab.authResourceMismatchMessage");
    case "mcp-auth-index-unreadable": return t("mcpTab.authIndexUnreadableMessage");
    default: return t("mcpTab.authFailedMessage");
  }
}

const EMPTY_FORM = {
  id: "",
  transport: "stdio" as Transport,
  command: "",
  args: "",
  url: "",
  auth: "none" as "none" | "sso" | "api-key" | "oauth",
  apiKey: "",
  apiKeyEnv: "",
  apiKeyHeader: "",
  oauthClientId: "",
  headers: "",
  env: "",
  allowPrivateNetworks: false,
};

export function parseCliWords(input: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaping = false;
  const trimmed = input.trim();

  for (let i = 0; i < trimmed.length; i += 1) {
    const char = trimmed[i];
    const nextChar = trimmed[i + 1];
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      const shouldEscape =
        nextChar !== undefined &&
        (/\s/.test(nextChar) || nextChar === "'" || nextChar === '"' || nextChar === "\\");
      if (shouldEscape) {
        escaping = true;
        continue;
      }
      current += char;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaping || quote) {
    throw new Error(t("mcpTab.parseCliWordsUnclosed"));
  }
  if (current) tokens.push(current);
  return tokens;
}

const WINDOWS_EXECUTABLE_PATTERN =
  /^((?:[A-Za-z]:\\|\\\\)[^"'<>|?*]*?\.(?:exe|cmd|bat|com|ps1|py|js|mjs|cjs))(?=\s|$)\s*(.*)$/i;

/**
 * Validates that the auth/apiKey combination is coherent.
 * - "api-key" auth requires a non-empty API key.
 * - "oauth" auth rejects an API key because credentials come from the browser flow.
 * - "none" auth rejects any API key value (it would be silently dropped by
 *   the config builder and confuse the user into thinking it was saved).
 *
 * Returns a user-facing error string, or null when the combination is valid.
 */
export function validateAuthApiKey(
  auth: "none" | "sso" | "api-key" | "oauth",
  apiKey: string,
): string | null {
  if (auth === "sso") {
    return t("mcpTab.ssoNotSupported");
  }
  if (auth === "api-key" && !apiKey.trim()) {
    return t("mcpTab.apiKeyRequired");
  }
  if (auth === "oauth" && apiKey.trim()) {
    return t("mcpTab.apiKeyNotAllowedWithOAuth");
  }
  if (auth === "none" && apiKey.trim()) {
    return t("mcpTab.apiKeyNotAllowedWithNoneAuth");
  }
  return null;
}

export function splitCommandLine(input: string): string[] {
  const trimmed = input.trim();
  if (!trimmed) return [];

  const winMatch = trimmed.match(WINDOWS_EXECUTABLE_PATTERN);
  if (winMatch) {
    const [, command, rest] = winMatch;
    return [command, ...parseCliWords(rest)];
  }

  return parseCliWords(trimmed);
}

function parseKeyValueLines(input: string, delimiter: ":" | "="): Record<string, string> | undefined {
  const lines = input
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  if (lines.length === 0) return undefined;

  return Object.fromEntries(
    lines.map((line) => {
      const index = line.indexOf(delimiter);
      if (index <= 0) {
        throw new Error(
          delimiter === ":"
            ? t("mcpTab.headersFormatError")
            : t("mcpTab.envFormatError"),
        );
      }
      return [line.slice(0, index).trim(), line.slice(index + 1).trim()];
    }),
  );
}

type McpSnapshot = [McpServerState[], McpServerConfigDto[], string, McpManagementState];
const MCP_SNAPSHOT_CACHE_KEY = "mcp.snapshot";

export function McpTab({ onNavigate, active = true }: { onNavigate?: (tab: string) => void; active?: boolean } = {}) {
  const { t } = useTranslation();
  const notifySaved = useNotifySaved();
  const settingsEditor = useSettingsEditor();
  const editorRevisionRef = useRef(settingsEditor?.reloadEpoch);
  editorRevisionRef.current = settingsEditor?.reloadEpoch;
  const formIdPrefix = useId();
  const formIds = {
    id: `${formIdPrefix}-server-id`,
    transport: `${formIdPrefix}-transport`,
    auth: `${formIdPrefix}-auth`,
    apiKey: `${formIdPrefix}-api-key`,
    apiKeyEnv: `${formIdPrefix}-api-key-env`,
    apiKeyHeader: `${formIdPrefix}-api-key-header`,
    oauthClientId: `${formIdPrefix}-oauth-client-id`,
    command: `${formIdPrefix}-command`,
    args: `${formIdPrefix}-args`,
    env: `${formIdPrefix}-env`,
    url: `${formIdPrefix}-url`,
    allowPrivateNetworks: `${formIdPrefix}-allow-private`,
    headers: `${formIdPrefix}-headers`,
  };

  // Search mounts can reuse the last answer; entering the actual tab revalidates all independent server stores.
  const editorCache = settingsEditor?.cache;
  const [heldSnapshot] = useState(() => editorCache?.peek<McpSnapshot>(MCP_SNAPSHOT_CACHE_KEY));
  const [loading, setLoading] = useState(heldSnapshot === undefined);
  const [error, setError] = useState<string | null>(null);

  const { show: showNotice, notice: banner, dismiss: dismissBanner } = useInlineNotice();
  // The policy refusal carries its how-to under the notice for as long as that notice is the one shown.
  const [policyGuidanceFor, setPolicyGuidanceFor] = useState<string | null>(null);
  const showBanner = useCallback((type: "error" | "success", msg: string, policyApprovalRequired = false) => {
    showNotice(type, msg);
    setPolicyGuidanceFor(policyApprovalRequired ? msg : null);
  }, [showNotice]);

  const [states, setStates] = useState<McpServerState[]>(heldSnapshot?.[0] ?? []);
  const [configs, setConfigs] = useState<McpServerConfigDto[]>(heldSnapshot?.[1] ?? []);
  const [configPath, setConfigPath] = useState(heldSnapshot?.[2] ?? "");
  const [form, setForm] = useState(EMPTY_FORM);
  const [management, setManagement] = useState<McpManagementState | null>(heldSnapshot?.[3] ?? null);
  const [reviewingServerId, setReviewingServerId] = useState<string | null>(null);
  const [startingServerId, setStartingServerId] = useState<string | null>(null);
  const startingServerIdRef = useRef<string | null>(null);
  const [removedServerId, setRemovedServerId] = useState<string | null>(null);
  const [formBusy, setFormBusy] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const [removingId, setRemovingId] = useState<string | null>(null);
  const removingIdRef = useRef<string | null>(null);
  const [credentialTargetId, setCredentialTargetId] = useState<string | null>(null);
  const [credentialApiKey, setCredentialApiKey] = useState("");
  const [credentialBusy, setCredentialBusy] = useState(false);
  const [authenticatingId, setAuthenticatingId] = useState<string | null>(null);
  const authenticatingIdRef = useRef<string | null>(null);
  const statesRequestRef = useRef(0);
  const managementRequestRef = useRef(0);

  const fetchAll = useCallback(async (background = false) => {
    const editorRevision = settingsEditor?.reloadEpoch;
    const requestId = ++statesRequestRef.current;
    const managementRequestId = ++managementRequestRef.current;
    setLoading(!background);
    setError(null);
    try {
      const read = (): Promise<McpSnapshot> => Promise.all([
        window.ave.mcp.servers(),
        window.ave.mcp.getConfigs(),
        window.ave.mcp.getConfigPath(),
        window.ave.mcp.getManagementState(),
      ]);
      const [statesRes, configsRes, configPathRes, managementRes] = editorCache
        ? await editorCache.load(MCP_SNAPSHOT_CACHE_KEY, read, { fresh: true })
        : await read();
      if (managementRequestId !== managementRequestRef.current || editorRevision !== editorRevisionRef.current) return;
      if (requestId === statesRequestRef.current) setStates(statesRes);
      setConfigs(configsRes);
      setConfigPath(configPathRes);
      setManagement(managementRes);
    } catch (e) {
      if (managementRequestId !== managementRequestRef.current || editorRevision !== editorRevisionRef.current) return;
      const message = errorMessage(e);
      setError(message.includes(`${MCP_CREDENTIAL_MIGRATION_FAILED}:`) ? t("mcpTab.credentialMigrationFailed") : (getMcpRecoveryError(e) ?? message) || t("mcpTab.fetchError"));
    } finally {
      if (managementRequestId === managementRequestRef.current && editorRevision === editorRevisionRef.current) setLoading(false);
    }
  }, [t, editorCache, settingsEditor?.reloadEpoch]);

  const initialReadRef = useRef(true);
  const previousReadRef = useRef(fetchAll);
  useEffect(() => {
    const initial = initialReadRef.current;
    const readChanged = previousReadRef.current !== fetchAll;
    initialReadRef.current = false;
    previousReadRef.current = fetchAll;
    if (!active && !readChanged && (!initial || heldSnapshot !== undefined)) return;
    void fetchAll(heldSnapshot !== undefined);
  }, [active, fetchAll, heldSnapshot]);

  // There is no server-state event: a status that changes while the tab stays open (a contained server quarantined at
  // disconnect, a crash) is re-read when the user returns to the window, without polling.
  useEffect(() => {
    let mounted = true;
    const refreshStates = (): void => {
      if (!active || document.visibilityState === "hidden") return;
      if (mounted) void fetchAll(true);
    };
    window.addEventListener("focus", refreshStates);
    document.addEventListener("visibilitychange", refreshStates);
    return () => {
      mounted = false;
      window.removeEventListener("focus", refreshStates);
      document.removeEventListener("visibilitychange", refreshStates);
    };
  }, [active, fetchAll]);

  const hasOAuthServer = configs.some((config) => config.transport === "http" && config.auth === "oauth")
    || states.some((state) => state.authStatus !== undefined);
  useEffect(() => {
    if (!hasOAuthServer) return;
    let active = true;
    let inFlight = false;
    const timer = setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      const requestId = ++statesRequestRef.current;
      void window.ave.mcp.servers().then((nextStates) => {
        if (active && requestId === statesRequestRef.current) setStates(nextStates);
      }).catch(() => { /* Keep the last observed status until the next refresh. */ })
        .finally(() => { inFlight = false; });
    }, AUTH_STATUS_POLL_MS);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [hasOAuthServer]);

  // 킬 스위치
  const handleKill = useCallback(
    async (id: string) => {
      try {
        await window.ave.mcp.kill(id);
        showBanner("success", t("mcpTab.killSuccess", { id }));
        void fetchAll();
      } catch (e) {
        showBanner("error", getMcpRecoveryError(e) ?? errorMessage(e));
      }
    },
    [fetchAll, showBanner],
  );

  const handleAuthenticate = useCallback(async (id: string) => {
    if (authenticatingIdRef.current) return;
    authenticatingIdRef.current = id;
    setAuthenticatingId(id);
    try {
      const result = await window.ave.mcp.authenticate(id);
      showBanner(
        result.connected ? "success" : "error",
        result.connected ? t("mcpTab.authSuccess", { id }) : getAuthErrorMessage(result.errorCode),
      );
      await fetchAll();
    } catch {
      showBanner("error", t("mcpTab.authFailedMessage"));
    } finally {
      authenticatingIdRef.current = null;
      setAuthenticatingId(null);
    }
  }, [fetchAll, showBanner, t]);

  // 서버 제거
  const handleRemove = useCallback(
    async (id: string) => {
      if (removingIdRef.current) return;
      removingIdRef.current = id;
      setRemovingId(id);
      try {
        await window.ave.mcp.removeConfig(id);
        setRemovedServerId(id);
        await fetchAll();
        showBanner("success", t("mcpTab.removeSuccess", { id }));
        notifySaved();
      } catch (e) {
        showBanner("error", getMcpRecoveryError(e) ?? errorMessage(e));
      } finally {
        removingIdRef.current = null;
        setRemovingId(null);
      }
    },
    [fetchAll, showBanner, notifySaved],
  );

  const managementError = useCallback((error: unknown, fallbackKey = "mcpTab.startFailed") => {
    const message = errorMessage(error);
    const recoveryError = getMcpRecoveryError(error);
    if (recoveryError) return recoveryError;
    if (message.includes("user-keyboard-required:")) return t("formatIpcError.userKeyboardRequired");
    if (message.includes("mcp-api-key-required:")) return t("mcpTab.missingApiKey");
    if (message.includes("mcp-trust-stale:")) return t("mcpTab.trustStale");
    if (message.includes("mcp-trust-required:")) return t("mcpTab.trustRequired");
    if (message.includes("mcp-policy-refused:") || message.includes("runtime approval not admitted by policy")) return t("mcpTab.policyRefused");
    if (message.includes("mcp-undo-unavailable:")) return t("mcpTab.undoUnavailable");
    if (message.includes("mcp-server-missing:")) return t("mcpTab.serverMissing");
    if (message.includes("mcp-server-exists:")) return t("mcpTab.serverExists");
    return t(fallbackKey);
  }, [t]);

  const handleStart = useCallback(async (id: string, fingerprint?: string) => {
    if (startingServerIdRef.current !== null) return;
    startingServerIdRef.current = id;
    setStartingServerId(id);
    try {
      const result = await window.ave.mcp.startServer(id, fingerprint);
      if (!result.connected) showBanner("error", getAuthErrorMessage(result.errorCode));
      else showBanner("success", t("mcpTab.reconnected", { id }));
      setReviewingServerId(null);
      await fetchAll();
    } catch (error) {
      showBanner("error", managementError(error));
      await fetchAll();
    } finally {
      startingServerIdRef.current = null;
      setStartingServerId(null);
    }
  }, [fetchAll, showBanner, managementError, t]);

  const handleUndoRemove = useCallback(async () => {
    if (!removedServerId) return;
    try {
      await window.ave.mcp.undoRemove(removedServerId);
      setRemovedServerId(null);
      await fetchAll();
      notifySaved();
    } catch (error) {
      showBanner("error", managementError(error, "mcpTab.restoreFailed"));
    }
  }, [removedServerId, fetchAll, notifySaved, showBanner, managementError]);

  const handleSetApiKey = useCallback(async () => {
    if (!credentialTargetId) return;
    if (!credentialApiKey.trim()) {
      showBanner("error", t("mcpTab.apiKeyEmpty"));
      return;
    }
    setCredentialBusy(true);
    try {
      const result = await window.ave.mcp.setApiKey(credentialTargetId, credentialApiKey);
      setCredentialTargetId(null);
      setCredentialApiKey("");
      await fetchAll();
      showBanner(
        result.connected ? "success" : "error",
        result.connected
          ? t("mcpTab.apiKeySavedConnected", { id: credentialTargetId })
          : t("mcpTab.apiKeySavedNotConnected", { id: credentialTargetId, warning: result.warning === "mcp-trust-required" ? t("mcpTab.trustRequired") : result.warning ?? t("mcpTab.unknownCause") }),
      );
      notifySaved();
    } catch (e) {
      showBanner("error", getMcpRecoveryError(e) ?? errorMessage(e));
    } finally {
      setCredentialBusy(false);
    }
  }, [credentialApiKey, credentialTargetId, fetchAll, showBanner, notifySaved]);

  // 서버 추가
  const handleAdd = useCallback(async () => {
    if (!form.id.trim()) { showBanner("error", t("mcpTab.serverIdRequired")); return; }
    if (form.transport === "stdio" && !form.command.trim()) {
      showBanner("error", t("mcpTab.stdioCommandRequired"));
      return;
    }
    if (form.transport === "http" && !form.url.trim()) {
      showBanner("error", t("mcpTab.httpUrlRequired"));
      return;
    }

    if (form.auth === "oauth" && form.transport !== "http") {
      showBanner("error", t("mcpTab.oauthHttpOnly"));
      return;
    }
    const authError = validateAuthApiKey(form.auth, form.apiKey);
    if (authError) { showBanner("error", authError); return; }
    const oauthClientId = form.oauthClientId.trim();
    if (form.auth === "oauth" && oauthClientId && !isValidOAuthClientId(oauthClientId)) {
      showBanner("error", t("mcpTab.oauthClientIdInvalid", { max: String(MAX_OAUTH_CLIENT_ID_LEN) }));
      return;
    }

    let config: McpServerConfig;
    try {
      const shared = {
        id: form.id.trim(),
        ...(form.auth !== "none" ? { auth: form.auth } : {}),
        ...(form.auth === "api-key" ? { apiKey: form.apiKey.trim() } : {}),
      };

      if (form.transport === "stdio") {
        const [command, ...inlineArgs] = splitCommandLine(form.command);
        if (!command) {
          showBanner("error", t("mcpTab.stdioExecutableRequired"));
          return;
        }
        const extraArgs = form.args.trim() ? parseCliWords(form.args) : [];
        const args = [...inlineArgs, ...extraArgs];
        const env = parseKeyValueLines(form.env, "=");
        config = {
          ...shared,
          transport: "stdio",
          command,
          ...(args.length > 0 ? { args } : {}),
          ...(env ? { env } : {}),
          ...(form.auth === "api-key" ? { apiKeyEnv: form.apiKeyEnv.trim() } : {}),
        };
      } else {
        const headers = parseKeyValueLines(form.headers, ":");
        config = {
          ...shared,
          transport: "http",
          url: form.url.trim(),
          allowPrivateNetworks: form.allowPrivateNetworks,
          ...(form.auth === "oauth" ? { oauth: oauthClientId ? { clientId: oauthClientId } : {} } : {}),
          ...(headers ? { headers } : {}),
          ...(form.auth === "api-key" && form.apiKeyHeader.trim() ? { apiKeyHeader: form.apiKeyHeader.trim() } : {}),
        };
      }
    } catch (e) {
      showBanner("error", getMcpRecoveryError(e) ?? errorMessage(e));
      return;
    }

    setFormBusy(true);
    try {
      const result = await window.ave.mcp.addConfig(config);
      setForm(EMPTY_FORM);
      setShowForm(false);
      showBanner(
        result.connected || result.requiresTrust || result.errorCode === "mcp-auth-required" ? "success" : "error",
        result.connected
          ? t("mcpTab.serverAddedConnected", { id: config.id })
          : result.requiresTrust ? t("mcpTab.serverSavedTrustRequired", { id: config.id })
          : result.errorCode === "mcp-auth-required"
            ? t("mcpTab.serverSavedAuthRequired", { id: config.id })
            : result.errorCode
              ? getAuthErrorMessage(result.errorCode)
              : t("mcpTab.serverAddedNotConnected", { id: config.id, warning: result.warning ?? t("mcpTab.unknownCause") }),
      );
      notifySaved();
      void fetchAll();
    } catch (e) {
      const message = getMcpRecoveryError(e) ?? invokeErrorDetail(e) ?? errorMessage(e);
      showBanner("error", message, invokeErrorCode(e) === MCP_GOVERNANCE_UNAPPROVED_SERVER);
    } finally {
      setFormBusy(false);
    }
  }, [form, fetchAll, showBanner, notifySaved]);

  const handleClearApiKey = useCallback(async (id: string): Promise<void> => {
    try {
      await window.ave.mcp.clearApiKey(id);
    } finally {
      await fetchAll();
    }
  }, [fetchAll]);

  const controls: SettingsControlDescriptor[] = [{ id: "mcp.management", section: "mcp-servers", label: t("mcpTab.pageTitle"),
    modified: false, loading, loadError: error ?? undefined, disabledReason: t("settingsEditor.noDefault") }];
  for (const config of configs) {
    if (!config.bundled) controls.push({ id: `mcp.server.${config.id}`, section: "mcp-servers",
      label: t("mcpTab.serverSetting", { id: config.id }), modified: true, loading, loadError: error ?? undefined,
      reset: async () => {
        const result: unknown = await window.ave.mcp.removeConfig(config.id);
        if (isIpcErrorResult(result)) throw new Error(t("mcpTab.removeFailed"));
        setRemovedServerId(config.id);
        await fetchAll();
      } });
    if (config.auth === "api-key") {
      const known = management !== null && Object.hasOwn(management.hasApiKey, config.id);
      controls.push({ id: `mcp.apiKey.${config.id}`, section: "mcp-servers", label: t("mcpTab.credentialSetting", { id: config.id }),
        modified: known ? management.hasApiKey[config.id] : undefined, loading,
        loadError: error ?? (!loading && !known ? t("mcpTab.fetchError") : undefined),
        reset: () => handleClearApiKey(config.id) });
    }
  }
  useSettingsControls(controls);

  // 설정에는 있지만 현재 연결 상태가 없는 서버도 표시
  const allIds = new Set([
    ...states.map((s) => s.id),
    ...configs.map((c) => c.id),
  ]);

  const getState = (id: string) => states.find((s) => s.id === id);
  const getConfig = (id: string) => configs.find((c) => c.id === id);

  return (
    <div className="space-y-6">
      <SettingsPageHeader
        title={t("mcpTab.pageTitle")}
        description={t("mcpTab.pageDescription")}
      />

      {/* The server list and the toolbar that adds to it are the whole page
          below the header, so they are one deep-link anchor rather than two. */}
      <div className="flex flex-col gap-4" data-settings-section="mcp-servers" tabIndex={-1}>
        {/* 배너 */}
        <NoticeLiveRegion toast={banner} />
        {banner && (
          <div className="space-y-2">
            <NoticeToast key={banner.id} toast={banner} onDismiss={dismissBanner} wrap />
            {policyGuidanceFor === banner.message && (
              <div className="space-y-2 text-sm text-destructive">
                <p>{t("mcpTab.policyApprovalGuidance", { tabPermissions: t("settingsContent.tabPermissions"), homeTrustTitle: t("permissionsTab.homeTrustTitle") })}</p>
                {onNavigate && (
                  <Button size="sm" variant="outline" onClick={() => onNavigate("permissions")}>
                    {t("mcpTab.openPermissionsButton")}
                  </Button>
                )}
              </div>
            )}
          </div>
        )}

        {/* 에러 */}
        {error && (
          <div className="rounded-md bg-destructive/(--opacity-soft) px-3 py-2 text-sm text-destructive">{error}</div>
        )}

        {management && <div data-testid="mcp-policy-state" className="rounded-md border p-3 text-sm space-y-1">
          <p>{t(management.policyStatus === "pending-review" ? "mcpTab.policyPendingReview"
            : management.policyStatus === "invalid" ? "mcpTab.policyInvalid"
              : management.userServersAllowed ? "mcpTab.policyUserTrustAllowed" : "mcpTab.policyUserTrustBlocked")}</p>
          <code className="text-xs [overflow-wrap:anywhere]">{management.policyPath}</code>
          {management.managedServerIds.length > 0 && <p>{t("mcpTab.managedServers", { ids: management.managedServerIds.join(", ") })}</p>}
        </div>}
        {removedServerId && <div role="status" className="flex flex-wrap items-center gap-2 text-sm">
          <span>{t("mcpTab.removeSuccess", { id: removedServerId })}</span>
          <Button variant="outline" size="sm" onClick={() => void handleUndoRemove()}>{t("mcpTab.undoRemove")}</Button>
        </div>}

        {/* ── Section A: 서버 목록 ──────────────────────
            The page header (SettingsPageHeader above) already titles this
            surface "MCP"; the server-list toolbar must NOT repeat that title
            (the duplicate `mcpTab.pageTitle` h3 was the "MCP twice" report).
            Just the refresh/add toolbar, right-aligned. */}
        <div className="flex items-center justify-end">
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => void fetchAll()} disabled={loading}>
              {t("mcpTab.refreshButton")}
            </Button>
            <Button size="sm" onClick={() => setShowForm((v) => !v)}>
              {showForm ? t("mcpTab.cancelButton") : t("mcpTab.addServerButton")}
            </Button>
          </div>
        </div>

        {loading ? (
          <p className="text-xs text-muted-foreground">{t("mcpTab.loading")}</p>
        ) : allIds.size === 0 ? (
          <div className="min-w-0 rounded-md border border-dashed p-4 text-center text-xs text-muted-foreground">
            {t("mcpTab.emptyState")}
            <br />
            <span className="text-xs">
              {t("mcpTab.configFileLabel")} <code className="[overflow-wrap:anywhere]">{configPath}</code>
            </span>
          </div>
        ) : (
          <ScrollArea className="flex-1 min-h-0">
            <div className="space-y-2 pr-2">
              {Array.from(allIds).map((id) => {
                const st = getState(id);
                const cfg = getConfig(id);
                const status = st?.status ?? "disconnected";
                const launch = management?.servers[id];
                const hasApiKey = management?.hasApiKey[id];
                const policyBlocked = management !== null && !management.userServersAllowed && !management.managedServerIds.includes(id);
                const authStatus = authenticatingId === id ? "authenticating" : st?.authStatus;
                const canAuthenticate = cfg?.transport === "http" && (cfg.auth === "oauth" || authStatus !== undefined);
                return (
                  <div key={id} data-mcp-server-id={id} data-setting-id={`mcp.server.${id}`} data-setting-registered={!cfg?.bundled ? "true" : undefined} className="rounded-md border bg-card p-3">
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex-1 min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono text-xs font-semibold line-clamp-1 min-w-0">{cfg?.bundled
                            ? `${t(cfg.bundled.kind === "agent-plugin" ? "gitMarketplace.server.plugin" : "gitMarketplace.server.extension")}: ${cfg.bundled.name}/${cfg.bundled.server}`
                            : id}</span>
                          <Badge className={`text-tiny px-1.5 py-0 ${STATUS_BADGE[status]}`}>
                            {getStatusLabel(status)}
                          </Badge>
                          {cfg && (
                            <Badge variant="outline" className="text-tiny px-1.5 py-0">
                              {cfg.transport}
                            </Badge>
                          )}
                          {authStatus && (
                            <Badge variant="outline" className="text-tiny px-1.5 py-0" role="status">
                              {getAuthStatusLabel(authStatus)}
                            </Badge>
                          )}
                          {cfg?.auth && (
                            <Badge variant="outline" className="text-tiny px-1.5 py-0">
                              {t("mcpTab.authBadge", { auth: cfg.auth })}
                            </Badge>
                          )}
                        </div>
                        {cfg?.auth === "api-key" && hasApiKey === false && <p role="status" className="mt-1 text-dense text-warning">{t("mcpTab.missingApiKey")}</p>}
                        {launch && <p className="mt-1 text-dense text-muted-foreground">
                          {t("mcpTab.launchSummary", { count: String(launch.argumentCount), names: launch.environmentKeys.join(", ") || t("mcpTab.noEnvironmentKeys") })}
                        </p>}
                        {st?.registeredTools.length ? (
                          <p className="mt-1 text-dense text-muted-foreground">
                            {t("mcpTab.toolsLabel")} {st.registeredTools.join(", ")}
                          </p>
                        ) : null}
                        {st?.lastError && (
                          <p className="mt-1 text-dense text-destructive line-clamp-2">{
                            authStatus === "required" ? t("mcpTab.authRequiredMessage")
                              : authStatus === "error" ? t("mcpTab.authFailedMessage") : st.lastError
                          }</p>
                        )}
                        {st?.containedQuarantined && (
                          <p data-testid={`mcp-contained-quarantined-${id}`} role="status" className="mt-1 text-dense text-warning">
                            {t("mcpTab.containedQuarantined")}
                          </p>
                        )}
                        {st?.authError && (
                          <p className="mt-1 text-dense text-destructive line-clamp-2">{getAuthErrorMessage(st.authError)}</p>
                        )}
                        {st?.connectedAt && (
                          <p className="mt-0.5 text-tiny text-muted-foreground">
                            {t("mcpTab.connectedAtLabel")} {formatDateTime(st.connectedAt)}
                          </p>
                        )}
                        {cfg?.transport === "stdio" && cfg.command && (
                          <p className="mt-0.5 text-tiny text-muted-foreground font-mono line-clamp-1 [overflow-wrap:anywhere]">
                            {t("mcpTab.commandLabel")} {cfg.command}
                          </p>
                        )}
                        {cfg?.transport === "http" && cfg.url && (
                          <p className="mt-0.5 text-tiny text-muted-foreground font-mono line-clamp-1 [overflow-wrap:anywhere]">
                            {t("mcpTab.urlLabel")} {cfg.url}
                          </p>
                        )}
                      </div>
                      <div className="flex gap-1.5 shrink-0">
                        {canAuthenticate && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-6 text-xs px-2"
                            disabled={authenticatingId !== null || authStatus === "authenticating"}
                            onClick={() => void handleAuthenticate(id)}
                          >
                            {authStatus === "authenticating" ? t("mcpTab.authenticating") : t("mcpTab.authenticateButton")}
                          </Button>
                        )}
                        {cfg?.auth === "api-key" && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-6 text-xs px-2"
                            onClick={() => {
                              setCredentialTargetId((current) => (current === id ? null : id));
                              setCredentialApiKey("");
                            }}
                          >
                            {t("mcpTab.setKeyButton")}
                          </Button>
                        )}
                        {!cfg?.bundled && launch && status !== "connected" && <Button variant="outline" size="sm"
                          className="h-6 text-xs px-2" disabled={policyBlocked || startingServerId !== null || st?.containedQuarantined || cfg?.auth === "api-key" && hasApiKey === false}
                          onClick={() => launch.trusted ? void handleStart(id) : setReviewingServerId(id)}>
                          {t(launch.trusted ? "mcpTab.reconnect" : "mcpTab.reviewAndStart")}
                        </Button>}
                        {cfg?.auth === "api-key" && hasApiKey === true && <Button size="sm" variant="outline" className="h-6 text-xs px-2"
                          onClick={() => { void handleClearApiKey(id).catch((clearError) => showBanner("error", managementError(clearError, "mcpTab.clearApiKeyFailed"))); }}>
                          {t("mcpTab.clearApiKey")}
                        </Button>}
                        {status === "connected" && (
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-6 text-xs px-2 text-warning border-warning/(--opacity-medium)"
                            onClick={() => void handleKill(id)}
                          >
                            {t("mcpTab.killButton")}
                          </Button>
                        )}
                        {!cfg?.bundled && <Button
                          variant="outline"
                          size="sm"
                          className="h-6 text-xs px-2 text-destructive border-destructive/(--opacity-medium)"
                          disabled={loading || removingId !== null}
                          onClick={() => void handleRemove(id)}
                        >
                          {t("mcpTab.removeButton")}
                        </Button>}
                      </div>
                    </div>
                    {reviewingServerId === id && cfg && launch && <fieldset className="mt-3 min-w-0 space-y-2 border-t pt-3" aria-label={t("mcpTab.trustReviewTitle")}>
                      <p className="text-sm">{t("mcpTab.trustReviewDescription")}</p>
                      <code className="block whitespace-pre-wrap break-all text-xs">{cfg.transport === "stdio"
                        ? [cfg.command, ...launch.arguments.map((argument) => JSON.stringify(argument))].join(" ") : cfg.url}</code>
                      <p className="text-xs">{t("mcpTab.launchSummary", { count: String(launch.argumentCount), names: launch.environmentKeys.join(", ") || t("mcpTab.noEnvironmentKeys") })}</p>
                      <div className="flex flex-wrap gap-2">
                        <Button size="sm" disabled={policyBlocked || startingServerId !== null}
                          onClick={() => void handleStart(id, launch.fingerprint)}>{t("mcpTab.trustAndStart")}</Button>
                        <Button size="sm" variant="outline" onClick={() => setReviewingServerId(null)}>{t("common.cancel")}</Button>
                      </div>
                    </fieldset>}
                    {credentialTargetId === id && (
                      <div className="mt-3 flex items-end gap-2 border-t pt-3">
                        <div className="min-w-0 flex-1 space-y-1">
                          <Label htmlFor={`${id}-api-key-update`} className="text-xs">
                            {t("mcpTab.apiKeyWriteOnlyLabel")}
                          </Label>
                          <Input
                            id={`${id}-api-key-update`}
                            data-setting-id={`mcp.apiKey.${id}`} data-setting-registered="true"
                            type="password"
                            className="h-7 text-xs font-mono"
                            placeholder={
                              cfg?.transport === "stdio" && cfg.apiKeyEnv
                                  ? `${cfg.apiKeyEnv}=...`
                                  : cfg?.transport === "http" && cfg.apiKeyHeader
                                    ? `${cfg.apiKeyHeader}: ...`
                                    : t("mcpTab.apiKeyPlaceholder")
                            }
                            value={credentialApiKey}
                            onChange={(event) => setCredentialApiKey(event.target.value)}
                          />
                        </div>
                        <Button
                          size="sm"
                          className="h-7 px-2 text-xs"
                          disabled={credentialBusy}
                          onClick={() => void handleSetApiKey()}
                        >
                          {t("mcpTab.saveButton")}
                        </Button>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </ScrollArea>
        )}

        {/* ── Section B: 서버 추가 폼 ─────────────────── */}
        {showForm && (
          <>
            <Separator />
            <div className="space-y-3 rounded-md border bg-muted/(--opacity-medium) p-4" data-settings-transient="mcp-server-draft">
              <h4 className="text-xs font-semibold text-foreground">{t("mcpTab.addFormTitle")}</h4>

              <div className="grid grid-cols-2 gap-3">
                {/* ID */}
                <div className="space-y-1">
                  <Label htmlFor={formIds.id} className="text-xs">
                    {t("mcpTab.serverIdLabel")}
                  </Label>
                  <Input
                    id={formIds.id}
                    className="h-7 text-xs"
                    placeholder="my-mcp-server"
                    value={form.id}
                    onChange={(e) => setForm((f) => ({ ...f, id: e.target.value }))}
                  />
                </div>

                {/* Transport */}
                <div className="space-y-1">
                  <Label htmlFor={formIds.transport} className="text-xs">
                    {t("mcpTab.transportLabel")}
                  </Label>
                  <NativeSelect
                    id={formIds.transport}
                    size="sm"
                    className="w-full"
                    value={form.transport}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, transport: e.target.value as Transport, auth: e.target.value === "stdio" && f.auth === "oauth" ? "none" : f.auth }))
                    }
                  >
                    <NativeSelectOption value="stdio">{t("mcpTab.transportStdio")}</NativeSelectOption>
                    <NativeSelectOption value="http">{t("mcpTab.transportHttp")}</NativeSelectOption>
                  </NativeSelect>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1">
                  <Label htmlFor={formIds.auth} className="text-xs">
                    {t("mcpTab.authLabel")}
                  </Label>
                  <NativeSelect
                    id={formIds.auth}
                    size="sm"
                    className="w-full"
                    value={form.auth}
                    onChange={(e) =>
                      setForm((f) => ({ ...f, auth: e.target.value as typeof EMPTY_FORM.auth, apiKey: e.target.value === "oauth" ? "" : f.apiKey }))
                    }
                  >
                    <NativeSelectOption value="none">{t("mcpTab.authNone")}</NativeSelectOption>
                    <NativeSelectOption value="sso">SSO</NativeSelectOption>
                    {form.transport === "http" && <NativeSelectOption value="oauth">{t("mcpTab.authOAuth")}</NativeSelectOption>}
                    <NativeSelectOption value="api-key">{t("mcpTab.authApiKey")}</NativeSelectOption>
                  </NativeSelect>
                </div>
                <div className="space-y-1">
                  <Label htmlFor={formIds.apiKey} className="text-xs">
                    {t("mcpTab.apiKeyWriteOnlyLabel")}
                  </Label>
                  <Input
                    id={formIds.apiKey}
                    type="password"
                    className="h-7 text-xs font-mono"
                    placeholder={t("mcpTab.apiKeyPlaceholder")}
                    disabled={form.auth === "oauth"}
                    value={form.apiKey}
                    onChange={(e) => setForm((f) => ({ ...f, apiKey: e.target.value }))}
                  />
                </div>
              </div>

              {form.auth === "api-key" && <div className="space-y-1">
                <Label htmlFor={form.transport === "stdio" ? formIds.apiKeyEnv : formIds.apiKeyHeader} className="text-xs">
                  {t(form.transport === "stdio" ? "mcpTab.apiKeyEnvironmentName" : "mcpTab.apiKeyHeaderName")}
                </Label>
                <Input id={form.transport === "stdio" ? formIds.apiKeyEnv : formIds.apiKeyHeader} className="h-7 text-xs font-mono"
                  value={form.transport === "stdio" ? form.apiKeyEnv : form.apiKeyHeader}
                  onChange={(event) => setForm((current) => ({ ...current, [form.transport === "stdio" ? "apiKeyEnv" : "apiKeyHeader"]: event.target.value }))} />
                {form.transport === "http" && <p className="text-tiny text-muted-foreground">{t("mcpTab.apiKeyHeaderHint")}</p>}
              </div>}

              {form.transport === "http" && form.auth === "oauth" && (
                <div className="space-y-1">
                  <Label htmlFor={formIds.oauthClientId} className="text-xs">
                    {t("mcpTab.oauthClientIdLabel")}
                  </Label>
                  <Input
                    id={formIds.oauthClientId}
                    className="h-7 text-xs font-mono"
                    autoComplete="off"
                    spellCheck={false}
                    maxLength={MAX_OAUTH_CLIENT_ID_LEN}
                    value={form.oauthClientId}
                    onChange={(e) => setForm((f) => ({ ...f, oauthClientId: e.target.value }))}
                  />
                  <p className="text-tiny text-muted-foreground">{t("mcpTab.oauthClientIdHint")}</p>
                </div>
              )}

              {form.transport === "stdio" ? (
                <>
                  <div className="space-y-1">
                    <Label htmlFor={formIds.command} className="text-xs">
                      {t("mcpTab.commandRequiredLabel")}
                    </Label>
                    <Input
                      id={formIds.command}
                      className="h-7 text-xs font-mono"
                      placeholder="uvx my-mcp-server"
                      value={form.command}
                      onChange={(e) => setForm((f) => ({ ...f, command: e.target.value }))}
                    />
                    <p className="text-tiny text-muted-foreground">
                      {t("mcpTab.commandHint")}
                    </p>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor={formIds.args} className="text-xs">
                      {t("mcpTab.argsLabel")}
                    </Label>
                    <Input
                      id={formIds.args}
                      className="h-7 text-xs font-mono"
                      placeholder="--port 3000 --profile 'team alpha'"
                      value={form.args}
                      onChange={(e) => setForm((f) => ({ ...f, args: e.target.value }))}
                    />
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor={formIds.env} className="text-xs">
                      {t("mcpTab.envWriteOnlyLabel")}
                    </Label>
                    <Textarea
                      id={formIds.env}
                      className="min-h-[88px] text-xs font-mono"
                      placeholder={"OPENAI_API_KEY=...\nMCP_PROFILE=team-alpha"}
                      value={form.env}
                      onChange={(e) => setForm((f) => ({ ...f, env: e.target.value }))}
                    />
                  </div>
                </>
              ) : (
                <>
                  <div className="space-y-1">
                    <Label htmlFor={formIds.url} className="text-xs">
                      {t("mcpTab.urlRequiredLabel")}
                    </Label>
                    <Input
                      id={formIds.url}
                      className="h-7 text-xs font-mono"
                      placeholder="https://example.com/mcp"
                      value={form.url}
                      onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
                    />
                  </div>
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id={formIds.allowPrivateNetworks}
                      checked={form.allowPrivateNetworks}
                      onCheckedChange={(checked) =>
                        setForm((f) => ({ ...f, allowPrivateNetworks: checked === true }))
                      }
                      className="size-3.5"
                    />
                    <Label htmlFor={formIds.allowPrivateNetworks} className="text-xs">
                      {t("mcpTab.allowPrivateNetworksLabel")}
                    </Label>
                  </div>
                  <div className="space-y-1">
                    <Label htmlFor={formIds.headers} className="text-xs">
                      {t("mcpTab.headersWriteOnlyLabel")}
                    </Label>
                    <Textarea
                      id={formIds.headers}
                      className="min-h-[88px] text-xs font-mono"
                      placeholder={"Authorization: Bearer ...\nX-Team: alpha"}
                      value={form.headers}
                      onChange={(e) => setForm((f) => ({ ...f, headers: e.target.value }))}
                    />
                  </div>
                </>
              )}

              <p className="text-tiny text-muted-foreground">
                {t("mcpTab.secretsNote")}
              </p>

              <div className="flex justify-end gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setForm(EMPTY_FORM);
                    setShowForm(false);
                  }}
                >
                  {t("mcpTab.cancelButton")}
                </Button>
                <Button size="sm" onClick={() => void handleAdd()} disabled={formBusy}>
                  {formBusy ? t("mcpTab.addingButton") : t("mcpTab.addButton")}
                </Button>
              </div>
            </div>
          </>
        )}
        <SettingsControlActions section="mcp-servers" />
      </div>
    </div>
  );
}
