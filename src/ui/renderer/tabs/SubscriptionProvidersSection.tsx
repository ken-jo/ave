import { useId } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../components/ui/dialog.js";
import { Label } from "../../../components/ui/label.js";
import { RadioGroup, RadioGroupItem } from "../../../components/ui/radio-group.js";
import { useTranslation } from "../../../i18n/react.js";
import {
  isSubscriptionRuntimeId,
  subscriptionRuntimeDescriptor,
  type SubscriptionConnectionState,
  type SubscriptionLoginMethod,
  type SubscriptionRuntimeCapabilities,
  type SubscriptionRuntimeErrorCode,
  type SubscriptionRuntimeExecutableSource,
  type SubscriptionRuntimeId,
  type SubscriptionRuntimeInstallGuidance,
  type SubscriptionRuntimeNotice,
  type SubscriptionRuntimeState,
} from "../../../shared/subscription-runtime.js";

/** Renderer-safe subscription provider identifier. The main process owns any executable paths, authentication URLs, account
 * tokens, and raw runtime output; none of those values belong in this UI contract. */
type SubscriptionProviderId = SubscriptionRuntimeId;

type SubscriptionProviderRuntimeState = SubscriptionRuntimeState | "checking";

export type SubscriptionBusyAction =
  | "refresh"
  | "configure-runtime"
  | "verify-runtime"
  | "forget-runtime"
  | "login-browser"
  | "login-device-code"
  | "open-login-browser"
  | "cancel-login"
  | "logout"
  | "load-models"
  | "use-for-chat"
  | "acknowledge-notice";

/** Stable, renderer-safe error codes. Raw runtime errors must be mapped in main. */
type SubscriptionProviderErrorCode = SubscriptionRuntimeErrorCode;

export interface SubscriptionProviderModel {
  /** Provider model identifier, not an account credential. */
  id: string;
  /** Main-validated model display name. */
  label: string;
  isDefault?: boolean;
}

type SubscriptionProviderCapabilities = SubscriptionRuntimeCapabilities;

interface SubscriptionProviderDescriptor {
  id: SubscriptionProviderId;
  /** Internal runtime name. Never drawn: the row names the company. */
  label: string;
  /** The plan as the provider brands it, e.g. "ChatGPT" in "ChatGPT subscription". */
  planName: string;
  /** The CLI's own name, used only to say what to install or what was found. */
  cliName: string;
  /** Static, browser-safe provider description. */
  description: string;
  loginMethods: readonly SubscriptionLoginMethod[];
  /** `discovered`: Ave finds the CLI and the card only reports what it found (with install guidance and "Check again" when
   * nothing usable is there). `user-selected`: the card offers the official runtime picker. */
  executable: SubscriptionRuntimeExecutableSource;
  supportsLogout?: boolean;
  /** The oldest runtime version Ave can run, when the runtime enforces one. */
  minimumVersion?: string;
  /** Official install instructions, shown while no runtime is found. */
  installGuidance?: SubscriptionRuntimeInstallGuidance;
}

export interface SubscriptionProviderStatus {
  runtime: SubscriptionProviderRuntimeState;
  connection: SubscriptionConnectionState;
  /** Only a short, validated one-time device code may be projected here. */
  pendingDeviceCode?: string | null;
  pendingLoginMethod?: SubscriptionLoginMethod | null;
  /** Main opens the verified address itself; the renderer never receives it. */
  canOpenLoginBrowser?: boolean;
  /** Offered in the settings page's one model chooser, never on this card. */
  models?: readonly SubscriptionProviderModel[];
  /** Whether chat is host-verified. Only `chat` is read; the rest of the projection describes the Ave agent harness, not this
   * provider. */
  capabilities?: Partial<SubscriptionProviderCapabilities>;
  /** The version the resolved runtime reported, when it has been read. */
  version?: string | null;
  errorCode?: SubscriptionProviderErrorCode | null;
  /** A fixed sign-in notice code; never provider text. */
  notice?: SubscriptionRuntimeNotice | null;
}

export interface SubscriptionProviderView {
  descriptor: SubscriptionProviderDescriptor;
  /** Omitted while the main process is still loading the safe status projection. */
  status?: SubscriptionProviderStatus | null;
  busyAction?: SubscriptionBusyAction | null;
  /** A status re-read is in flight without displacing an in-flight mutation. */
  refreshPending?: boolean;
  disabled?: boolean;
}

/** The selected subscription provider and model used by the chat runtime. */
export interface SubscriptionChatSelection {
  providerId: SubscriptionProviderId;
  modelId: string | null;
}

interface SubscriptionProviderActions {
  refreshStatus?: (providerId: SubscriptionProviderId) => void | Promise<void>;
  configureRuntime?: (providerId: SubscriptionProviderId) => void | Promise<void>;
  verifyRuntime?: (providerId: SubscriptionProviderId) => void | Promise<void>;
  forgetRuntime?: (providerId: SubscriptionProviderId) => void | Promise<void>;
  beginLogin?: (providerId: SubscriptionProviderId, method: SubscriptionLoginMethod) => void | Promise<void>;
  /** Opens a main-owned, verified login page without exposing its URL to the renderer. */
  openLoginBrowser?: (providerId: SubscriptionProviderId) => void | Promise<void>;
  cancelLogin?: (providerId: SubscriptionProviderId) => void | Promise<void>;
  logout?: (providerId: SubscriptionProviderId) => void | Promise<void>;
  /** Adopts a subscription-backed model chosen in the settings page's chooser. */
  useForChat?: (providerId: SubscriptionProviderId, modelId: string | null) => void | Promise<void>;
  /** Explicitly return chat to the separately configured API-key provider. */
  useApiForChat?: () => void | Promise<void>;
  /** Dismisses the card's sign-in notice. */
  acknowledgeNotice?: (providerId: SubscriptionProviderId) => void | Promise<void>;
  /** Opens the provider's own usage settings (ChatGPT plan usage: chatgpt.com/settings/usage). */
  manageUsage?: (providerId: SubscriptionProviderId) => void | Promise<void>;
}

export interface SubscriptionProvidersSectionProps {
  /** Browser-safe provider descriptors, statuses, and capability projections only. */
  providers: readonly SubscriptionProviderView[];
  /** Main-owned active chat selection, projected without authentication data. */
  activeSelection: SubscriptionChatSelection | null;
  /** `true` when the separately configured API-key provider is the active chat path. */
  apiChatActive?: boolean;
  /** A subscription/API chat-selection request is in flight in this surface. */
  chatSelectionBusy?: boolean;
  apiChatBusy?: boolean;
  apiChatError?: SubscriptionProviderErrorCode | null;
  actions: SubscriptionProviderActions;
  /** Use a stable custom anchor only when the embedding settings page needs one. */
  sectionId?: string;
}

/** What each sign-in notice tells the user, and what they can do about it. `welcome` is the first-sign-in dialog. */
const NOTICE_MESSAGE_KEYS: Record<Exclude<SubscriptionRuntimeNotice, "welcome">, string> = {
  "plan-usage-disabled": "subscriptionProvidersSection.chatgptPlanNoticePlanUsageDisabled",
  "reconnect-required": "subscriptionProvidersSection.chatgptPlanNoticeReconnectRequired",
  "revocation-unconfirmed": "subscriptionProvidersSection.chatgptPlanNoticeRevocationUnconfirmed",
  declined: "subscriptionProvidersSection.chatgptPlanNoticeDeclined",
  "account-mismatch": "subscriptionProvidersSection.chatgptPlanNoticeAccountMismatch",
  "state-mismatch": "subscriptionProvidersSection.chatgptPlanNoticeStateMismatch",
  "sign-in-failed": "subscriptionProvidersSection.chatgptPlanNoticeSignInFailed",
};

export const ERROR_MESSAGE_KEYS: Record<SubscriptionProviderErrorCode, string> = {
  "subscription-provider-not-supported": "subscriptionProvidersSection.errorProviderNotSupported",
  "subscription-runtime-not-configured": "subscriptionProvidersSection.errorRuntimeNotConfigured",
  "subscription-runtime-unavailable": "subscriptionProvidersSection.errorRuntimeUnavailable",
  "subscription-runtime-unsafe-location": "subscriptionProvidersSection.errorRuntimeUnsafeLocation",
  "subscription-runtime-native-required": "formatIpcError.subscriptionRuntimeNativeRequired",
  "subscription-runtime-unauthenticated": "formatIpcError.subscriptionRuntimeUnauthenticated",
  "subscription-runtime-version-unsupported": "subscriptionProvidersSection.errorRuntimeVersionUnsupported",
  "subscription-runtime-incompatible": "subscriptionProvidersSection.errorRuntimeIncompatible",
  "subscription-login-in-progress": "subscriptionProvidersSection.errorLoginInProgress",
  "subscription-login-failed": "subscriptionProvidersSection.errorLoginFailed",
  "subscription-verification-url-unavailable": "subscriptionProvidersSection.errorVerificationUrlUnavailable",
  "subscription-logout-not-supported": "subscriptionProvidersSection.errorLogoutNotSupported",
  "subscription-chat-unavailable": "subscriptionProvidersSection.errorChatUnavailable",
  "subscription-model-not-supported": "formatIpcError.subscriptionModelNotSupported",
  "subscription-operation-failed": "subscriptionProvidersSection.errorOperationFailed",
};

/** Device codes are the sole transient authentication value this renderer may display. Reject values that look like URLs,
 * bearer tokens, or raw logs. */
function isSafeDeviceCode(value: string | null | undefined): value is string {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9 -]{0,63}$/.test(value);
}

/** Whether a discovered CLI was found but cannot be used until it is updated. */
function discoveredCliNeedsUpdate(errorCode: SubscriptionProviderErrorCode | null | undefined): boolean {
  return errorCode === "subscription-runtime-version-unsupported"
    || errorCode === "subscription-runtime-incompatible";
}

/** The error text for a discovered CLI: never "select a runtime", since there is nothing to pick. */
function errorMessageKey(
  descriptor: SubscriptionProviderDescriptor,
  errorCode: SubscriptionProviderErrorCode,
): string {
  if (descriptor.executable === "discovered" && errorCode === "subscription-runtime-not-configured") {
    return "subscriptionProvidersSection.errorCliNotFound";
  }
  if (descriptor.executable === "none" && errorCode === "subscription-runtime-not-configured") {
    return "subscriptionProvidersSection.chatgptPlanNotConfigured";
  }
  return ERROR_MESSAGE_KEYS[errorCode];
}

/** Discovered runtimes expose install/update guidance, never a file picker; user-selected runtimes retain their picker.
 * Parent IPC keeps validation and secret handling in main. */
export function SubscriptionAuthControls({
  provider,
  actions,
}: {
  provider: SubscriptionProviderView;
  actions: SubscriptionProviderActions;
}) {
  const { t } = useTranslation();
  const invoke = (operation: (() => void | Promise<void>) | undefined) => {
    if (!operation) return;
    try {
      // The parent maps rejected IPC operations to a safe status.errorCode. Never surface an arbitrary runtime exception in the
      // renderer.
      void Promise.resolve(operation()).catch(() => undefined);
    } catch {
      // Synchronous callback failures follow the same safe parent-state path.
    }
  };
  const { descriptor, status } = provider;
  const discovered = descriptor.executable === "discovered";
  // Plan usage runs no executable: there is nothing to find, pick, change or forget.
  const runsNoExecutable = descriptor.executable === "none";
  const runtime = status?.runtime ?? "checking";
  const connection = status?.connection ?? "unknown";
  const chatReady = connection === "connected" && status?.capabilities?.chat === true;
  const pending = connection === "pending";
  const connected = connection === "connected";
  // Login admits the executable before spawning; chat still needs verification.
  const signedOutUnverified = runtime === "unverified" && connection === "signed-out";
  const hasRuntimeSelection = runtime !== "not-configured" && runtime !== "checking";
  const needsRuntimeSelection = runtime === "not-configured";
  const needsVerification = (runtime === "unverified" && !signedOutUnverified)
    || (runtime === "ready" && connected && !chatReady);
  const isBusy = provider.busyAction !== null && provider.busyAction !== undefined;
  const disabled = provider.disabled === true || isBusy || provider.refreshPending === true;
  const safeDeviceCode = isSafeDeviceCode(status?.pendingDeviceCode)
    ? status.pendingDeviceCode
    : null;
  const cliMissing = discovered && needsRuntimeSelection;
  const cliNeedsUpdate = discovered && discoveredCliNeedsUpdate(status?.errorCode);
  const cliNeedsNativeInstall = discovered && status?.errorCode === "subscription-runtime-native-required";
  const cliUnauthenticated = discovered && status?.errorCode === "subscription-runtime-unauthenticated";
  const cliFound = discovered && hasRuntimeSelection && !cliNeedsUpdate && runtime !== "unavailable";
  const showGuidance = Boolean(descriptor.installGuidance)
    && (cliMissing || cliNeedsUpdate || cliNeedsNativeInstall || cliUnauthenticated || (!discovered && needsRuntimeSelection));
  const checking = provider.refreshPending === true || provider.busyAction === "refresh";
  // A found CLI that could not be used for another reason (a probe that failed to run, an auth status it could not read)
  // gets the same way back.
  const cliUnavailable = discovered && runtime === "unavailable" && !cliNeedsUpdate && !cliNeedsNativeInstall && !cliUnauthenticated;
  const checkAgainButton = actions.refreshStatus ? (
    <Button
      type="button"
      size="sm"
      variant="outline"
      className="h-7 gap-1.5 text-xs"
      onClick={() => invoke(() => actions.refreshStatus?.(descriptor.id))}
      disabled={provider.disabled === true || isBusy || checking}
      data-testid={`subscription-provider:${descriptor.id}:check-again`}
    >
      {checking
        ? <Loader2 className="size-3 animate-spin" aria-hidden={true} />
        : <RefreshCw className="size-3" aria-hidden={true} />}
      {checking
        ? t("subscriptionProvidersSection.checkingAgain")
        : t("subscriptionProvidersSection.checkAgain")}
    </Button>
  ) : null;

  // A runtime reached through the user's own installed CLI bills the user's own subscription; the card says so, and says the
  // credentials stay there.
  const usesOwnCli = isSubscriptionRuntimeId(descriptor.id)
    && subscriptionRuntimeDescriptor(descriptor.id).transport === "claude-cli";
  // ChatGPT plan usage follows OpenAI's guidelines: say that eligible requests use the plan, how that differs from
  // API-key charges, and link to where usage is managed.
  const usesChatGptPlan = isSubscriptionRuntimeId(descriptor.id)
    && subscriptionRuntimeDescriptor(descriptor.id).transport === "chatgpt-plan-direct";

  return (
    <div className="space-y-3" data-testid={`subscription-provider:${descriptor.id}`}>
      {usesOwnCli ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid={`subscription-provider:${descriptor.id}:billing-disclosure`}
        >
          {t("subscriptionProvidersSection.claudeCliBillingDisclosure")}
        </p>
      ) : null}
      {usesChatGptPlan ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid={`subscription-provider:${descriptor.id}:billing-disclosure`}
        >
          {t("subscriptionProvidersSection.chatgptPlanDisclosure")}
        </p>
      ) : null}
      {status?.notice === "welcome" ? (
        <Dialog
          open={true}
          onOpenChange={(open) => {
            if (!open) invoke(() => actions.acknowledgeNotice?.(descriptor.id));
          }}
        >
          <DialogContent data-testid={`subscription-provider:${descriptor.id}:welcome`}>
            <DialogHeader>
              <DialogTitle>{t("subscriptionProvidersSection.chatgptPlanWelcomeTitle")}</DialogTitle>
              <DialogDescription>{t("subscriptionProvidersSection.chatgptPlanWelcomeBody")}</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                type="button"
                onClick={() => invoke(() => actions.acknowledgeNotice?.(descriptor.id))}
                data-testid={`subscription-provider:${descriptor.id}:welcome-got-it`}
              >
                {t("subscriptionProvidersSection.chatgptPlanWelcomeGotIt")}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      ) : null}
      {status?.notice && status.notice !== "welcome" ? (
        <div
          role="status"
          className="flex flex-wrap items-start gap-2 rounded-md border bg-muted/(--opacity-muted) px-3 py-2 text-xs text-muted-foreground"
          data-testid={`subscription-provider:${descriptor.id}:notice`}
          data-notice={status.notice}
        >
          <p className="min-w-0 flex-1">{t(NOTICE_MESSAGE_KEYS[status.notice])}</p>
          {actions.acknowledgeNotice ? (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="h-6 text-xs"
              onClick={() => invoke(() => actions.acknowledgeNotice?.(descriptor.id))}
              data-testid={`subscription-provider:${descriptor.id}:notice-dismiss`}
            >
              {t("subscriptionProvidersSection.chatgptPlanNoticeDismiss")}
            </Button>
          ) : null}
        </div>
      ) : null}
      {usesChatGptPlan && runtime === "not-configured" && !status?.errorCode ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid={`subscription-provider:${descriptor.id}:not-configured`}
        >
          {t("subscriptionProvidersSection.chatgptPlanNotConfigured")}
        </p>
      ) : null}
      {usesChatGptPlan && chatReady ? (
        <div
          className="flex flex-wrap items-center gap-2 text-xs"
          data-testid={`subscription-provider:${descriptor.id}:plan-in-use`}
        >
          <span className="font-medium">{t("subscriptionProvidersSection.chatgptPlanInUse")}</span>
          {actions.manageUsage ? (
            <Button
              type="button"
              size="sm"
              variant="link"
              className="h-auto p-0 text-xs"
              onClick={() => invoke(() => actions.manageUsage?.(descriptor.id))}
              data-testid={`subscription-provider:${descriptor.id}:manage-usage`}
            >
              {t("subscriptionProvidersSection.chatgptPlanManageUsage")}
            </Button>
          ) : null}
        </div>
      ) : null}
      {status?.errorCode && !(cliMissing && status.errorCode === "subscription-runtime-not-configured") ? (
        <p
          role="alert"
          className="rounded-md border border-destructive/(--opacity-medium) bg-destructive/(--opacity-subtle) px-3 py-2 text-xs text-destructive"
          data-testid={`subscription-provider:${descriptor.id}:error`}
        >
          {t(errorMessageKey(descriptor, status.errorCode))}
        </p>
      ) : null}

      {cliFound && status?.version ? (
        <p
          className="text-xs text-muted-foreground"
          data-testid={`subscription-provider:${descriptor.id}:cli-found`}
        >
          {t("subscriptionProvidersSection.cliFound", { version: status.version })}
        </p>
      ) : null}

      {showGuidance && descriptor.installGuidance ? (
        <div
          className="space-y-2 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground"
          data-testid={`subscription-provider:${descriptor.id}:${cliNeedsNativeInstall ? "native-install-guidance" : cliUnauthenticated ? "publisher-verification-guidance" : cliNeedsUpdate ? "update-guidance" : "install-guidance"}`}
        >
          <p className="font-medium text-foreground">
            {cliNeedsUpdate
              ? t("subscriptionProvidersSection.updateGuidance", { cli: descriptor.cliName, plan: descriptor.planName })
              : t("subscriptionProvidersSection.installGuidance", { cli: descriptor.cliName, plan: descriptor.planName })}
          </p>
          {descriptor.minimumVersion ? (
            <p data-testid={cliNeedsUpdate ? `subscription-provider:${descriptor.id}:minimum-version` : undefined}>
              {cliNeedsUpdate && status?.version
                ? t("subscriptionProvidersSection.minimumVersionRequiredFound", {
                  cli: descriptor.cliName,
                  minimumVersion: descriptor.minimumVersion,
                  version: status.version,
                })
                : t("subscriptionProvidersSection.minimumVersionRequired", {
                  cli: descriptor.cliName,
                  minimumVersion: descriptor.minimumVersion,
                })}
            </p>
          ) : null}
          {cliNeedsNativeInstall ? (
            <div className="space-y-1" data-testid={`subscription-provider:${descriptor.id}:migration-commands`}>
              <code className="block select-all break-all rounded bg-background px-2 py-1 font-mono text-foreground">claude install</code>
              <code className="block select-all break-all rounded bg-background px-2 py-1 font-mono text-foreground">npm uninstall -g @anthropic-ai/claude-code</code>
            </div>
          ) : null}
          <dl className="space-y-1">
            {descriptor.installGuidance.commands.map((entry) => (
              <div key={entry.label}>
                <dt className="font-medium text-foreground">{entry.label}</dt>
                <dd>
                  <code className="block select-all break-all rounded bg-background px-2 py-1 font-mono text-foreground">
                    {entry.command}
                  </code>
                </dd>
              </div>
            ))}
          </dl>
          <p>
            {t("subscriptionProvidersSection.installGuidanceDocs")}{" "}
            <code className="select-all break-all font-mono text-foreground">
              {descriptor.installGuidance.documentationUrl}
            </code>
          </p>
          {discovered ? (
            <div className="flex flex-wrap items-center gap-2">
              <p>{t("subscriptionProvidersSection.installGuidanceAfter")}</p>
              {checkAgainButton}
            </div>
          ) : null}
        </div>
      ) : null}

      {cliUnavailable ? (
        <div
          className="flex flex-wrap items-center gap-2 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground"
          data-testid={`subscription-provider:${descriptor.id}:cli-unavailable`}
        >
          <p>{t("subscriptionProvidersSection.cliUnavailable")}</p>
          {checkAgainButton}
        </div>
      ) : null}

      {pending ? (
        <div className="space-y-2 rounded-md border border-dashed px-3 py-2 text-xs text-muted-foreground" aria-live="polite">
          <p>{t("subscriptionProvidersSection.loginPendingNotice")}</p>
          {safeDeviceCode ? (
            <div className="space-y-1 rounded-sm bg-muted/(--opacity-muted) px-2 py-2">
              <p className="font-medium text-foreground">{t("subscriptionProvidersSection.deviceCodeLabel")}</p>
              <code
                className="block select-all break-all rounded bg-background px-2 py-1 font-mono text-sm text-foreground"
                data-testid={`subscription-provider:${descriptor.id}:device-code`}
              >
                {safeDeviceCode}
              </code>
              <p>{t("subscriptionProvidersSection.deviceCodeHint")}</p>
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="flex flex-wrap gap-2">
        {!discovered && !runsNoExecutable && needsRuntimeSelection && actions.configureRuntime ? (
          <Button
            type="button"
            size="sm"
            onClick={() => invoke(() => actions.configureRuntime?.(descriptor.id))}
            disabled={disabled}
            data-testid={`subscription-provider:${descriptor.id}:configure-runtime`}
          >
            {provider.busyAction === "configure-runtime" ? <Loader2 className="mr-1 size-3 animate-spin" /> : null}
            {provider.busyAction === "configure-runtime"
              ? t("subscriptionProvidersSection.configuringRuntime")
              : t("subscriptionProvidersSection.configureRuntime")}
          </Button>
        ) : null}
        {!discovered && !runsNoExecutable && hasRuntimeSelection && actions.configureRuntime ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => invoke(() => actions.configureRuntime?.(descriptor.id))}
            disabled={disabled || pending}
            data-testid={`subscription-provider:${descriptor.id}:change-runtime`}
          >
            {provider.busyAction === "configure-runtime" ? <Loader2 className="mr-1 size-3 animate-spin" /> : null}
            {provider.busyAction === "configure-runtime"
              ? t("subscriptionProvidersSection.configuringRuntime")
              : t("subscriptionProvidersSection.changeRuntime")}
          </Button>
        ) : null}

        {!discovered && !runsNoExecutable && hasRuntimeSelection && actions.forgetRuntime ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => invoke(() => actions.forgetRuntime?.(descriptor.id))}
            disabled={disabled || pending}
            data-testid={`subscription-provider:${descriptor.id}:forget-runtime`}
          >
            {provider.busyAction === "forget-runtime" ? <Loader2 className="mr-1 size-3 animate-spin" /> : null}
            {provider.busyAction === "forget-runtime"
              ? t("subscriptionProvidersSection.forgettingRuntime")
              : t("subscriptionProvidersSection.forgetRuntime")}
          </Button>
        ) : null}
        {needsVerification && actions.verifyRuntime ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => invoke(() => actions.verifyRuntime?.(descriptor.id))}
            disabled={disabled || pending}
            data-testid={`subscription-provider:${descriptor.id}:verify-runtime`}
          >
            {provider.busyAction === "verify-runtime" ? <Loader2 className="mr-1 size-3 animate-spin" /> : null}
            {provider.busyAction === "verify-runtime"
              ? t("subscriptionProvidersSection.verifyingRuntime")
              : t("subscriptionProvidersSection.verifyRuntime")}
          </Button>
        ) : null}

        {pending && status?.canOpenLoginBrowser && actions.openLoginBrowser ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => invoke(() => actions.openLoginBrowser?.(descriptor.id))}
            disabled={disabled}
            data-testid={`subscription-provider:${descriptor.id}:open-login-browser`}
          >
            {provider.busyAction === "open-login-browser" ? <Loader2 className="mr-1 size-3 animate-spin" /> : null}
            {provider.busyAction === "open-login-browser"
              ? t("subscriptionProvidersSection.openingLoginBrowser")
              : t("subscriptionProvidersSection.openLoginBrowser")}
          </Button>
        ) : null}

        {pending && actions.cancelLogin ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => invoke(() => actions.cancelLogin?.(descriptor.id))}
            disabled={disabled}
            data-testid={`subscription-provider:${descriptor.id}:cancel-login`}
          >
            {provider.busyAction === "cancel-login" ? <Loader2 className="mr-1 size-3 animate-spin" /> : null}
            {provider.busyAction === "cancel-login"
              ? t("subscriptionProvidersSection.cancellingLogin")
              : t("subscriptionProvidersSection.cancelLogin")}
          </Button>
        ) : null}

        {!pending && !connected && (runtime === "ready" || signedOutUnverified) ? descriptor.loginMethods.map((method) => (
          <Button
            key={method}
            type="button"
            size="sm"
            variant={method === "browser" ? "default" : "outline"}
            onClick={() => invoke(() => actions.beginLogin?.(descriptor.id, method))}
            disabled={disabled || !actions.beginLogin}
            data-testid={`subscription-provider:${descriptor.id}:login-${method}`}
          >
            {provider.busyAction === `login-${method}` ? <Loader2 className="mr-1 size-3 animate-spin" /> : null}
            {provider.busyAction === `login-${method}`
              ? t("subscriptionProvidersSection.startingLogin")
              : method === "browser"
                ? usesChatGptPlan
                  ? t("subscriptionProvidersSection.chatgptPlanContinue")
                  : t("subscriptionProvidersSection.loginBrowser")
                : t("subscriptionProvidersSection.loginDeviceCode")}
          </Button>
        )) : null}

        {connected && descriptor.supportsLogout && actions.logout ? (
          <Button
            type="button"
            variant="destructive"
            size="sm"
            onClick={() => invoke(() => actions.logout?.(descriptor.id))}
            disabled={disabled}
            data-testid={`subscription-provider:${descriptor.id}:logout`}
          >
            {provider.busyAction === "logout" ? <Loader2 className="mr-1 size-3 animate-spin" /> : null}
            {provider.busyAction === "logout"
              ? t("subscriptionProvidersSection.signingOut")
              : t("subscriptionProvidersSection.signOut")}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** How a provider with two (or, for OpenAI, three) ways in is signed in to: its CLI subscription, its plan-usage sign-in, or an API key. */
export type ProviderSignInMethod = "subscription" | "plan" | "api";

/** No configured method means neither radio is selected; switching methods must not delete the other credential. */
export function SignInMethodChoice({
  rowId,
  planName,
  value,
  onChange,
  disabled,
  offersPlan,
}: {
  rowId: string;
  planName: string;
  value: ProviderSignInMethod | null;
  onChange: (method: ProviderSignInMethod) => void;
  disabled?: boolean;
  /** The row also has plan usage (Sign in with ChatGPT): offer it as a third choice. */
  offersPlan?: boolean;
}) {
  const { t } = useTranslation();
  const labelId = useId();
  const optionId = (method: ProviderSignInMethod) => `${labelId}-${method}`;
  // The existing two choices keep their labels; plan usage, when offered, is a third choice with its own.
  const options: { method: ProviderSignInMethod; label: string }[] = [
    { method: "subscription", label: t("subscriptionProvidersSection.methodSubscription", { plan: planName }) },
    ...(offersPlan
      ? [{ method: "plan" as const, label: t("subscriptionProvidersSection.methodChatgptPlan", { plan: planName }) }]
      : []),
    { method: "api", label: t("subscriptionProvidersSection.methodApiKey") },
  ];
  return (
    <div className="space-y-2" data-testid={`llm-tab:sign-in-method:${rowId}`}>
      <p id={labelId} className="text-sm font-medium">{t("subscriptionProvidersSection.methodQuestion")}</p>
      <RadioGroup
        aria-labelledby={labelId}
        value={value ?? ""}
        onValueChange={(next) => {
          if (next === "subscription" || next === "api" || (offersPlan && next === "plan")) onChange(next);
        }}
        disabled={disabled}
        className="flex flex-wrap gap-2"
      >
        {options.map(({ method, label }) => (
          <div
            key={method}
            className="flex items-center gap-2 rounded-md border px-3 py-2 has-[[data-state=checked]]:border-primary"
          >
            <RadioGroupItem
              value={method}
              id={optionId(method)}
              aria-label={label}
              aria-describedby={`${optionId(method)}-billing`}
              data-testid={`llm-tab:sign-in-method:${rowId}:${method}`}
            />
            <Label htmlFor={optionId(method)} className="cursor-pointer text-sm font-normal">
              <span className="block">{label}</span>
              <span id={`${optionId(method)}-billing`} className="block text-xs text-muted-foreground">
                {method === "api"
                  ? t("modelBilling.apiKey")
                  : t("modelBilling.subscription", { plan: planName })}
              </span>
            </Label>
          </div>
        ))}
      </RadioGroup>
    </div>
  );
}
