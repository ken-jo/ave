/** Keep message actions inside the composer and session status below it; send becomes stop only while running with empty input.
 * Permission and model cells open their own cards (docs/blueprints/composer-redesign-message-queue.md). */
import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ArrowUp, Brain, Check, ChevronRight, HelpCircle, Lightbulb, Paperclip, Square } from "lucide-react";
import { Button } from "../../../components/ui/button.js";
import { Checkbox } from "../../../components/ui/checkbox.js";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover.js";
import { SandboxRestartDialog } from "./SandboxRestartDialog.js";
import { Tooltip, TooltipContent, TooltipTrigger } from "../../../components/ui/tooltip.js";
import { t } from "../../../i18n/runtime.js";
import { useTranslation } from "../../../i18n/react.js";
import { isSubscriptionRuntimeId, subscriptionRuntimeDescriptor } from "../../../shared/subscription-runtime.js";
import type { PluginEntry } from "../types.js";
import { SandboxStatusBadge } from "./SandboxStatusBadge.js";
import { SlashPicker } from "./SlashPicker.js";
import { ReasoningLevelControl, useReasoningLevel } from "./ReasoningSlider.js";
import type { ReasoningLevel } from "./ReasoningSlider.js";
import { getApi } from "../api-client.js";
import { isIpcErrorResult } from "../types.js";
import { modelCardChoices, type ModelCardChoice } from "../hooks/use-settings.js";
import type { AppSettings } from "../types.js";
import type { RolePreset } from "../../../data/role-presets.js";
import type { UserKeyboardIntentSnapshot } from "../../../shared/chat-origin.js";
import type { McpPromptEntry } from "./slash-picker-data.js";
import type { AgentPluginTemplatePrompt } from "../../../shared/agent-plugin-prompt.js";
import type { CustomCommandEntry } from "../../../shared/custom-command.js";
import type { InputStatusRow } from "../hooks/use-input-status-row.js";
import type { ExecutionMode, ExecutionModeDisplay } from "../../../shared/permission-mode.js";
import { EXEC_MODE_OPTIONS } from "../constants.js";
import { interactiveAutoApproveForExecMode, reviewerModeForExecMode } from "../tabs/PermissionsTab.js";
import type {
  ShellSandboxStatusInfo,
  ShellSandboxUnavailableCause,
} from "../../../shared/sandbox-capability-info.js";
import { EnvForcedNotice } from "./EnvForcedNotice.js";
import { PlanUsageComposerControls } from "./PlanUsageComposerControls.js";
import { errorMessage } from "../../../shared/error-message.js";

export interface InputActionBarProps {
  // Leading; slash/command picker (folds plugins/mcp/skills inside its own categories, so
  // there is no separate plugin grid button: the sidebar already surfaces plugins + marketplace).
  plugins: PluginEntry[];
  onSelectPlugin: (viewKey: string) => void;
  onInsertSlashCommand: (cmd: string) => void;
  onRunMcpPrompt: (prompt: McpPromptEntry) => void;
  onRunPluginPrompt: (prompt: AgentPluginTemplatePrompt) => void;
  /** Lists this tile's custom slash commands; absent on surfaces without the channel. */
  loadCustomCommands?: () => Promise<{ commands: CustomCommandEntry[] }>;
  slashPickerOpen: boolean;
  onSlashPickerOpenChange: (open: boolean) => void;
  // Leading; attachment picker (single unified button, no count badge; count lives on the in-composer chip).
  onAttach: () => void | Promise<void>;
  attachDisabled: boolean;

  attachDisabledReason?: "limit" | "no-api-key" | "subscription-unsupported" | "runtime-pending";
  attachDisabledSubscriptionProvider?: string;
  // Leading; role preset (persona). Chosen inside the command menu, as its first submenu; there is no button of its own.
  rolePresets: RolePreset[];
  activePresetId: string;
  onSelectPreset: (id: string) => void;

  // Trailing; turn controls (merged from the former BottomActionRow).

  isBusy: boolean;

  isSendDisabled: boolean;
  /** Whether the composer holds anything sendable (draft text or an attachment). Distinct from `!isSendDisabled`, which also folds in the runtime
   * blocks; this one is purely "does the user have something queued up", and it is what flips the single turn-control button between send and stop. */
  hasDraft: boolean;
  /** Send click (= Enter). intent capture lives in the caller. */
  onSend: () => void;

  onCancel: () => void;
}

function attachButtonLabel(
  disabled: boolean,
  reason: "limit" | "no-api-key" | "subscription-unsupported" | "runtime-pending",
  subscriptionProvider?: string,
): string {
  if (!disabled) return t("inputActionBar.attachEnabled");
  if (reason === "runtime-pending") {
    return t("subscriptionProvidersSection.statusChecking");
  }
  if (reason === "subscription-unsupported") {
    return t("app.subscriptionAttachmentUnsupported", {
      provider: subscriptionProvider ?? "subscription",
    });
  }
  if (reason === "no-api-key") return t("inputActionBar.attachDisabledNoApiKey");
  return t("inputActionBar.attachDisabledLimit");
}

const PERMISSION_LABEL_KEYS: Record<ExecutionModeDisplay, string> = {
  default: "permissionModeBadge.labelDefault",
  strict: "permissionModeBadge.labelStrict",
  auto: "permissionModeBadge.labelAuto",
  allow: "permissionModeBadge.labelAllow",
  unknown: "permissionModeBadge.labelUnknown",
};

// Per-mode TEXT color (no pill/outline); reuses the PermissionModeBadge color

const PERMISSION_TEXT_COLOR: Record<ExecutionModeDisplay, string> = {
  default: "text-info",
  strict: "text-destructive",
  auto: "text-warning",
  allow: "text-success",
  unknown: "text-input-bar-placeholder",
};

export function InputActionBar({
  plugins,
  onSelectPlugin,
  onInsertSlashCommand,
  onRunMcpPrompt,
  onRunPluginPrompt,
  loadCustomCommands,
  slashPickerOpen,
  onSlashPickerOpenChange,
  onAttach,
  attachDisabled,
  attachDisabledReason = "limit",
  attachDisabledSubscriptionProvider,
  rolePresets,
  activePresetId,
  onSelectPreset,
  isBusy,
  isSendDisabled,
  hasDraft,
  onSend,
  onCancel,
}: InputActionBarProps) {
  return (
    <div
      data-testid="input-action-bar"
      // SpotlightTour anchor. Step 2 of `first-boot-essentials` pins to this action-bar root, see `default-tour-scenarios.ts`.
      data-tour-anchor="input-action-bar"
      className="flex min-w-0 flex-nowrap items-center gap-1.5 px-3 py-2"
    >
      {/* Leading cluster — [command/slash] → [attach]. The persona is the
          command menu's first submenu, not a button of its own. The token ring
          lives in the status row under the box. */}
      <div className="flex shrink-0 flex-nowrap items-center gap-0.5" data-testid="iab-leading">
        <SlashPicker
          personas={rolePresets}
          activePersonaId={activePresetId}
          onSelectPersona={onSelectPreset}
          plugins={plugins}
          onSelectPlugin={onSelectPlugin}
          onInsert={onInsertSlashCommand}
          onRunMcpPrompt={onRunMcpPrompt}
          onRunPluginPrompt={onRunPluginPrompt}
          {...(loadCustomCommands ? { loadCustomCommands } : {})}
          open={slashPickerOpen}
          onOpenChange={onSlashPickerOpenChange}
        />

        <AttachButton
          onAttach={onAttach}
          disabled={attachDisabled}
          disabledReason={attachDisabledReason}
          disabledSubscriptionProvider={attachDisabledSubscriptionProvider}
        />
      </div>

      {/* Trailing cluster — turn controls (? · thinking · send/stop). */}
      <div
        className="ml-auto flex min-w-0 flex-1 flex-nowrap items-center justify-end gap-1.5 overflow-hidden pr-2"
        data-testid="iab-trailing"
      >
        <ShortcutsButton />
        {/* Reasoning control lives in the status row (between model and dot). */}
        <TurnControlButton
          isBusy={isBusy}
          hasDraft={hasDraft}
          isSendDisabled={isSendDisabled}
          onSend={onSend}
          onCancel={onCancel}
        />
      </div>
    </div>
  );
}

interface TurnControlButtonProps {
  isBusy: boolean;
  /** See {@link InputActionBarProps.hasDraft}. */
  hasDraft: boolean;
  isSendDisabled: boolean;
  onSend: () => void;
  onCancel: () => void;
}

/** ONE turn-control button, shared by every composer surface. The draft decides which verb it carries: anything typed (or attached) means the user's next action is "send", so it stays a send button even mid-run; an empty draft during a run leaves "stop" as the only useful action. Idle with an empty draft keeps the
 * send glyph, disabled. ESC still cancels a run regardless of what the button currently shows. The label is the icon plus title/aria-label; the old "전송 + ⏎ keycap" pair rendered the keycap as an empty box (its background and its text both resolved to `primary-foreground`, so the glyph disappeared into the chip). */
export function TurnControlButton({
  isBusy,
  hasDraft,
  isSendDisabled,
  onSend,
  onCancel,
}: TurnControlButtonProps) {
  const { t } = useTranslation();
  const showStop = isBusy && !hasDraft;
  const turnControlLabel = showStop
    ? t("bottomActionRow.cancelButton")
    : t("bottomActionRow.sendButton");
  // Stop is always actionable; send is not whenever `isSendDisabled` says so; which covers BOTH "nothing to send" and the runtime blocks (no
  // API key, runtime unavailable). One flag drives the `disabled` attribute and the quiet styling together, so the two can never disagree.
  const turnControlInert = !showStop && isSendDisabled;
  return (
    <Button
      type="button"
      /* Quiet whenever it cannot act: a disabled SOLID button is a near-black disc at 50% opacity, which reads as a broken grey blob rather than "waiting". Inert it borrows the leading cluster's outline treatment, so an idle composer shows one calm row of controls; it goes solid the instant the button can actually do something. */
      variant={turnControlInert ? "outline" : "default"}
      onClick={showStop ? onCancel : onSend}
      disabled={turnControlInert}
      data-testid={showStop ? "composer-cancel-button" : "composer-send-button"}
      title={turnControlLabel}
      aria-label={turnControlLabel}
      className={
        "inline-flex h-[26px] w-[26px] shrink-0 items-center justify-center rounded-full p-0 transition-transform duration-(--motion-fast) ease-(--motion-ease-standard) active:scale-90 focus-visible:ring-input-bar-focus motion-reduce:transition-none motion-reduce:active:scale-100 " +
        (turnControlInert
          ? "border-input-bar-border bg-input-bar-subtle text-input-bar-action"
          : "")
      }
    >
      {/* Keyed so the send↔stop swap is a crossfade on the SAME button,
          not an instant glyph substitution that reads as two buttons
          trading places. */}
      <span
        key={showStop ? "stop" : "send"}
        className="ave-turn-control-glyph inline-flex items-center justify-center"
      >
        {showStop
          ? <Square className="h-2.5 w-2.5 fill-current" strokeWidth={0} />
          : <ArrowUp className="h-3.5 w-3.5" strokeWidth={2.5} />}
      </span>
    </Button>
  );
}

interface AttachButtonProps {
  onAttach: () => void | Promise<void>;
  disabled: boolean;
  disabledReason?: "limit" | "no-api-key" | "subscription-unsupported" | "runtime-pending";
  disabledSubscriptionProvider?: string;
}

/** Single unified attach button; images, files, anything except the deny-listed dangerous extensions. The
 * chip count badge lives on the inline composer chip (n/5), not here. Shared by every composer surface. */
export function AttachButton({
  onAttach,
  disabled,
  disabledReason = "limit",
  disabledSubscriptionProvider,
}: AttachButtonProps) {
  const label = attachButtonLabel(disabled, disabledReason, disabledSubscriptionProvider);
  return (
    <Button
      variant="outline"
      size="sm"
      onClick={() => void onAttach()}
      disabled={disabled}
      data-testid="iab-attach-button"
      className="h-[26px] w-[26px] shrink-0 border-input-bar-border bg-input-bar-subtle p-0 text-input-bar-action transition-colors duration-(--motion-fast) ease-(--motion-ease-standard) hover:bg-input-bar-action/(--opacity-subtle) hover:text-input-bar-action focus-visible:ring-input-bar-focus motion-reduce:transition-none"
      title={label}
      aria-label={label}
    >
      <Paperclip className="h-3.5 w-3.5" />
    </Button>
  );
}

/** Status sub-row; compact single line at the bottom of the unified bar: [● active] · [model] · [permission; per-mode text color] · [ring] Permission is plain text colored per-mode (no
 * pill/outline). The TokenProgressRing widget sits at the END (after permission); the usage % / cost detail is surfaced on the ring's hover/click; there is no separate context-percent text cell. */
export interface ComposerStatusRowProps {
  /** Resolved model / permission / active fields (from useInputStatusRow). */
  statusRow: InputStatusRow;
  /** Token progress ring, composed by the caller (ring + cost detail). Leftmost. */
  ringSlot: ReactNode;
  /** The session's tasks chip, drawn right after the ring; absent when the plan is empty. */
  tasksSlot?: ReactNode;
  /** The session's goal chip, drawn after the tasks chip; absent when there is no goal. */
  goalSlot?: ReactNode;
  /** Opens Settings → LLM; the model card's way to the full catalogue. */
  onOpenModelSettings: () => void;
  /** Opens Settings → Permissions when the permission cell is clicked. */
  onOpenPermissions?: () => void;
  /** Opens the deferred approval queue dialog. Separate from permission settings. */
  onOpenApprovalQueue?: () => void;
  /** Thinking (extended reasoning) toggle + depth. */
  enableThinkingChat: boolean;
  /** Whether the selected runtime accepts this app-controlled reasoning setting. */
  reasoningAvailable?: boolean;
  onToggleThinking: (next: boolean) => void | Promise<void>;
}

/** The session line under the input box; see the module header for why it is outside. */
export function ComposerStatusRow({
  statusRow,
  ringSlot,
  tasksSlot,
  goalSlot,
  onOpenModelSettings,
  onOpenPermissions,
  onOpenApprovalQueue,
  enableThinkingChat,
  reasoningAvailable = true,
  onToggleThinking,
}: ComposerStatusRowProps) {
  const { t } = useTranslation();
  const { vendorModel, activeChatModel, permissionMode, pendingApprovals } = statusRow;
  // No connected provider means no model: the row offers setup in the model's place instead of naming the vendor default
  // nobody chose. A retired provider keeps its picker; choosing a model there is how the retirement notice is resolved.
  const noActiveModel = activeChatModel?.kind === "none" && activeChatModel.reason === "no-connected-provider";
  // The row names the model only. Which vendor serves it is a detail of the route, not of the sentence the person is about to send; it belongs in the model card the cell opens, next to the models they can switch
  // to. One case survives the strip whole: before a model is chosen the label is the vendor alone (or "not configured"), with no " · " to cut at; and that is right, because there is no model name yet to show instead.
  const displayModel = stripVendorPrefix(vendorModel);

  return (
    <div
      data-testid="iab-status-row"
      className="flex min-w-0 flex-nowrap items-center gap-1.5 px-3 pt-1 text-caption text-muted-foreground"
    >
      {/* Status sub-row order (user): ring on the LEFT; then a right-aligned
          cluster — [대기 승인 N] · permission(mode only) · model 추론 slider. */}

      {/* Token progress ring — leftmost. */}
      <span className="shrink-0" data-testid="iab-status-ring">
        {ringSlot}
      </span>
      {tasksSlot}
      {goalSlot}
      <SandboxStatusBadge capability={statusRow.sandboxCapability} statusQueryFailed={statusRow.sandboxStatusQueryFailed} onRetry={statusRow.refreshSandboxStatus} />

      <div className="ml-auto flex min-w-0 flex-nowrap items-center gap-1.5">
        {/* Pending approvals — its OWN button, BEFORE the permission cell. */}
        {pendingApprovals > 0 && (
          <>
            {onOpenApprovalQueue ? (
              <button
                type="button"
                onClick={onOpenApprovalQueue}
                data-testid="iab-status-pending"
                className="shrink-0 rounded-full border border-warning px-1.5 tabular-nums text-warning transition-opacity duration-(--motion-fast) ease-(--motion-ease-standard) hover:opacity-80 focus:outline-none focus-visible:ring-1 focus-visible:ring-input-bar-focus motion-reduce:transition-none"
                title={t("permissionModeBadge.queueButtonLabel", {
                  pendingText: t("permissionModeBadge.pendingTextCount", { count: pendingApprovals }),
                })}
              >
                <span data-testid="permission-pending-badge">
                  {t("permissionModeBadge.queueLabelCount", { count: pendingApprovals })}
                </span>
              </button>
            ) : (
              <span
                data-testid="iab-status-pending"
                className="shrink-0 rounded-full border border-warning px-1.5 tabular-nums text-warning"
              >
                <span data-testid="permission-pending-badge">
                  {t("permissionModeBadge.queueLabelCount", { count: pendingApprovals })}
                </span>
              </span>
            )}
            <span className="shrink-0 opacity-30" aria-hidden="true">·</span>
          </>
        )}

        {/* Permission — mode label ONLY, per-mode color. Clicking it opens the
            permission card: the modes (the current one marked) and the way to
            Settings → Permissions. The pending-approval count is its own
            button before this cell, never appended to the label text. */}
        <PermissionQuickPicker permissionMode={permissionMode} onOpenPermissions={onOpenPermissions} />

        <span className="shrink-0 opacity-30" aria-hidden="true">·</span>

        {/* Model — brain icon + the model name alone. Which vendor serves it
            shows in the card this opens, beside the model it belongs to.
            Clicking it, or the reasoning chip after it, opens the model card:
            the models (the current one among them, marked), the reasoning
            level, and the way to the full catalogue. Settings is one more
            click away, not the first thing a model click does. */}
        {noActiveModel ? (
          <button
            type="button"
            data-testid="iab-status-model-setup"
            data-tour-anchor="model-picker"
            onClick={onOpenModelSettings}
            className="inline-flex min-w-0 shrink items-center gap-1 text-left text-input-bar-action transition-opacity duration-(--motion-fast) ease-(--motion-ease-standard) hover:opacity-80 focus:outline-none focus-visible:ring-1 focus-visible:ring-input-bar-focus motion-reduce:transition-none"
          >
            <Brain className="h-3 w-3 shrink-0" aria-hidden="true" />
            <span className="min-w-0 truncate">{t("bottomActionRow.setUpProvider")}</span>
          </button>
        ) : (
          <>
            <PlanUsageComposerControls />
            <ModelQuickPicker
              vendorModel={vendorModel}
              displayModel={displayModel}
              enableThinking={enableThinkingChat}
              reasoningAvailable={reasoningAvailable}
              onToggleThinking={onToggleThinking}
              onOpenModelSettings={onOpenModelSettings}
            />
          </>
        )}
      </div>
    </div>
  );
}

/** The permission card: what the status row's permission cell opens. The same four modes Settings → Permissions offers, in the same order, the current one marked; a pick persists through the same `setMode` the tab uses and then sends the tab's two
 * reviewer dispatches, so a mode chosen here leaves the reviewer exactly as the tab would. The row's own label follows the host's mode broadcast, so nothing here is optimistic. Settings is one more click away, not the first thing a permission click does. */
function PermissionQuickPicker({
  permissionMode,
  onOpenPermissions,
}: {
  permissionMode: ExecutionModeDisplay;
  onOpenPermissions?: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [sandboxRestartOpen, setSandboxRestartOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const permissionLabel = t(PERMISSION_LABEL_KEYS[permissionMode]);

  const pick = async (mode: ExecutionMode) => {
    if (mode === permissionMode) {
      setOpen(false);
      return;
    }
    if (busy) return;
    setBusy(true);
    try {
      const perm = getApi().permission;
      // The card closes only once the pick took. A refused or failed change leaves it open with the current mark unmoved; the honest state.
      const res = await perm.setMode(mode);
      if (!res.ok) {
        console.warn("[ave] permission mode pick was refused: %s", res.message ?? res.error);
        return;
      }
      const reviewer = await perm.reviewerDispatch(`mode ${reviewerModeForExecMode(mode)}`);
      if (!reviewer.ok) {
        console.warn("[ave] reviewer mode did not follow the permission mode: %s", reviewer.error);
        return;
      }
      const interactive = await perm.reviewerDispatch(`interactive ${interactiveAutoApproveForExecMode(mode)}`);
      if (!interactive.ok) {
        console.warn("[ave] reviewer auto-approve did not follow the permission mode: %s", interactive.error);
        return;
      }
      setOpen(false);
    } finally {
      setBusy(false);
    }
  };

  const title = t("inputActionBar.permissionPickerTitle");
  return (
    <>
    <SandboxRestartDialog open={sandboxRestartOpen} onOpenChange={setSandboxRestartOpen} />
    <Popover open={open} onOpenChange={(next) => { if (!sandboxRestartOpen) setOpen(next); }}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="iab-status-permission"
          data-mode={permissionMode}
          className={`shrink-0 truncate transition-opacity duration-(--motion-fast) ease-(--motion-ease-standard) hover:opacity-80 focus:outline-none focus-visible:ring-1 focus-visible:ring-input-bar-focus motion-reduce:transition-none ${PERMISSION_TEXT_COLOR[permissionMode]}`}
          title={permissionLabel}
        >
          {permissionLabel}
        </button>
      </PopoverTrigger>
      <PopoverContent align="end" side="top" sideOffset={6} className="w-72 p-0" data-testid="permission-quick-picker">
        <div className="px-3 pt-3 text-caption font-medium text-muted-foreground">{title}</div>
        <ul className="px-1 py-1" role="listbox" aria-label={title} aria-busy={busy}>
          {EXEC_MODE_OPTIONS.map((opt) => {
            const current = opt.value === permissionMode;
            return (
              <li key={opt.value} role="option" aria-selected={current}>
                <button
                  type="button"
                  onClick={() => void pick(opt.value)}
                  disabled={busy}
                  data-testid={`permission-quick-picker-option:${opt.value}`}
                  title={opt.description}
                  className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent focus:outline-none focus-visible:bg-accent disabled:opacity-50"
                >
                  <span className={`min-w-0 flex-1 truncate ${PERMISSION_TEXT_COLOR[opt.value]}`}>
                    {t(PERMISSION_LABEL_KEYS[opt.value])}
                  </span>
                  {current ? <Check className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" /> : null}
                </button>
              </li>
            );
          })}
        </ul>
        {onOpenPermissions ? (
          <button
            type="button"
            onClick={() => { setOpen(false); onOpenPermissions(); }}
            data-testid="permission-quick-picker-more"
            className="flex w-full items-center justify-between border-t border-border/(--opacity-medium) px-3 py-2 text-sm hover:bg-accent focus:outline-none focus-visible:bg-accent"
          >
            <span>{t("inputActionBar.permissionPickerMore")}</span>
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
          </button>
        ) : null}
        <SandboxCheckboxRow
          onRestartRequired={() => setSandboxRestartOpen(true)}
          onOpenPermissions={onOpenPermissions ? () => { setOpen(false); onOpenPermissions(); } : undefined}
        />
      </PopoverContent>
    </Popover>
    </>
  );
}

const SANDBOX_CAUSE_KEYS: Record<ShellSandboxUnavailableCause, string> = {
  "ave-home-privacy-failed": "permissionsTab.homePrivacyBootFailed",
  "missing-bwrap": "inputActionBar.sandboxCauseMissingBwrap",
  "missing-socat": "inputActionBar.sandboxCauseMissingSocat",
  "missing-ripgrep": "inputActionBar.sandboxCauseMissingRipgrep",
  "dependency-check-failed": "inputActionBar.sandboxCauseDependencyCheckFailed",
  "windows-setup-incomplete": "inputActionBar.sandboxCauseWindowsSetupIncomplete",
  "windows-sandbox-missing": "inputActionBar.sandboxCauseWindowsSandboxMissing",
  "windows-sandbox-integrity-failed": "inputActionBar.sandboxCauseWindowsSandboxIntegrityFailed",
  "linux-runtime-probe-failed": "inputActionBar.sandboxCauseLinuxRuntimeProbeFailed",
  "init-failed": "inputActionBar.sandboxCauseInitFailed",
  "platform-unsupported": "inputActionBar.sandboxCausePlatformUnsupported",
  "windows-shell-not-contained": "inputActionBar.sandboxCauseWindowsShellNotContained",
  "shell-not-contained": "inputActionBar.sandboxCauseShellNotContained",
};

function sandboxStatusText(status: ShellSandboxStatusInfo): string {
  switch (status.state) {
    case "on":
      return t("inputActionBar.sandboxStateOn");
    case "off":
      return t("inputActionBar.sandboxStateOff");
    case "pending-on":
      return t("inputActionBar.sandboxStatePendingOn");
    case "pending-off":
      return t("inputActionBar.sandboxStatePendingOff");
    case "unknown":
      return t("inputActionBar.sandboxStateUnknown");
    case "error":
      return t("inputActionBar.sandboxStateError");
    case "unavailable":
    case "unsupported":
      return t("inputActionBar.sandboxStateUnavailable", {
        reason: status.causes.map((cause) => t(SANDBOX_CAUSE_KEYS[cause])).join(", "),
      });
  }
}

const SANDBOX_STATUS_TONE: Record<ShellSandboxStatusInfo["state"], string> = {
  on: "text-muted-foreground",
  off: "text-muted-foreground",
  "pending-on": "text-info",
  "pending-off": "text-info",
  unknown: "text-muted-foreground",
  unavailable: "text-warning",
  unsupported: "text-warning",
  error: "text-destructive",
};

/** The shell sandbox checkbox at the foot of the permission card (design I3: a silent off or a sandbox that did not start is visible here and one click away). The host decides the state; `sandboxCapability().shell`; and this row renders
 * it; a click writes `features.osToolSandbox` and nothing else, the same write Settings → Permissions makes for the shell toggle. The sandbox starts once at boot, so a change shows as pending until a restart instead of claiming it applied. */
function SandboxCheckboxRow({ onOpenPermissions, onRestartRequired }: { onOpenPermissions?: () => void; onRestartRequired: () => void }) {
  const { t } = useTranslation();
  const checkboxId = useId();
  const statusId = useId();
  const [status, setStatus] = useState<ShellSandboxStatusInfo | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [saveFailed, setSaveFailed] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const info = await getApi().permission.sandboxCapability();
      setStatus(info.shell);
      setLoadFailed(false);
      return info.shell;
    } catch (error) {
      console.warn("[ave] sandbox status read failed: %s", errorMessage(error));
      setLoadFailed(true);
    }
  }, []);

  // Mounted only while the card is open, so this reads on open and follows a change made in Settings while the card stays up.
  useEffect(() => {
    void refresh();
    return getApi().onSettingsUpdated(() => { void refresh(); });
  }, [refresh]);

  const toggle = async () => {
    if (busy || status === null) return;
    setBusy(true);
    setSaveFailed(false);
    try {
      const res = await getApi().updateSettings({ features: { osToolSandbox: !status.setting } });
      if (isIpcErrorResult(res)) {
        console.warn("[ave] sandbox toggle was refused: %s", res.error);
        setSaveFailed(true);
        return;
      }
      const next = await refresh();
      if (next?.state === "pending-on" || next?.state === "pending-off") onRestartRequired();
    } catch (error) {
      console.warn("[ave] sandbox toggle failed: %s", errorMessage(error));
      setSaveFailed(true);
    } finally {
      setBusy(false);
    }
  };

  const statusText = loadFailed
    ? t("inputActionBar.sandboxLoadFailed")
    : status === null
      ? ""
      : sandboxStatusText(status);
  const checked = status !== null && (status.setting || status.envForced);
  const disabled =
    busy || status === null || status.state === "unsupported" || status.envForced;
  // The one-time Windows administrator setup lives in Settings → Permissions (it raises a UAC prompt on an
  // explicit click there), so a card that says the setup is incomplete leads to it rather than leaving the user stuck.
  const needsWindowsSetup =
    status?.state === "unavailable" && status.causes.includes("windows-setup-incomplete");

  return (
    <div
      className="border-t border-border/(--opacity-medium) px-3 py-2"
      data-testid="permission-quick-picker-sandbox"
      data-state={status?.state ?? (loadFailed ? "error" : "loading")}
    >
      <div className="flex items-center gap-2">
        <Checkbox
          id={checkboxId}
          checked={checked}
          disabled={disabled}
          aria-describedby={statusId}
          data-testid="permission-quick-picker-sandbox-checkbox"
          onCheckedChange={() => void toggle()}
        />
        <label htmlFor={checkboxId} className="text-sm">
          {t("inputActionBar.sandboxLabel")}
        </label>
      </div>
      <p
        id={statusId}
        role="status"
        aria-live="polite"
        data-testid="permission-quick-picker-sandbox-status"
        className={`mt-1 pl-6 text-caption ${loadFailed ? "text-destructive" : status ? SANDBOX_STATUS_TONE[status.state] : "text-muted-foreground"}`}
      >
        {statusText}
      </p>
      {saveFailed ? (
        <p role="alert" data-testid="permission-quick-picker-sandbox-error" className="mt-1 pl-6 text-caption text-destructive">
          {t("inputActionBar.sandboxToggleFailed")}
        </p>
      ) : null}
      {needsWindowsSetup && onOpenPermissions ? (
        <button
          type="button"
          onClick={onOpenPermissions}
          data-testid="permission-quick-picker-sandbox-setup"
          className="mt-1 ml-6 text-caption text-primary underline-offset-2 hover:underline focus:outline-none focus-visible:ring-1 focus-visible:ring-input-bar-focus"
        >
          {t("inputActionBar.sandboxOpenWindowsSetup")}
        </button>
      ) : null}
      {status?.envForced ? (
        <EnvForcedNotice
          settingsPath="features.osToolSandbox"
          forcedPaths={["features.osToolSandbox"]}
          messageKey="permissionsTab.osSandboxEnvForced"
          testId="permission-quick-picker-sandbox-forced"
          className="mt-1 pl-6"
        />
      ) : null}
    </div>
  );
}

/** The model and reasoning chips open one card backed by shared persisted pins.
 * Use yellow depth steps with an accessible level name; zero stays unlit. */
const REASONING_FILL: Record<Exclude<ReasoningLevel, 0>, string> = {
  1: "var(--reasoning-fill-1)",
  2: "var(--reasoning-fill-2)",
  3: "var(--reasoning-fill-3)",
  4: "var(--reasoning-fill-4)",
  5: "var(--reasoning-fill-5)",
};

function ReasoningGauge({ level }: { level: ReasoningLevel }): React.JSX.Element {
  return (
    <span
      className="relative inline-flex h-3 w-3 shrink-0"
      data-testid="iab-reasoning-gauge"
      data-level={level}
      aria-hidden="true"
    >
      {/* The fill goes BEHIND the glyph, and the glyph keeps the row's full
          contrast on top of it. Painted over the outline instead, a solid
          colour swallows the bulb's own lines and the control stops reading as
          a bulb at all — at 12px the silhouette is most of what identifies it.
          Level 0 draws this layer not at all, so the outline is the whole
          control and the "off" state is unmistakable. */}
      {level !== 0 && (
        <Lightbulb
          className="absolute inset-0 h-3 w-3 stroke-none transition-colors duration-(--motion-fast) ease-(--motion-ease-standard) motion-reduce:transition-none"
          style={{ fill: REASONING_FILL[level] }}
        />
      )}
      <Lightbulb className="absolute inset-0 h-3 w-3" />
    </span>
  );
}

function ModelQuickPicker({
  vendorModel,
  displayModel,
  enableThinking,
  reasoningAvailable,
  onToggleThinking,
  onOpenModelSettings,
}: {
  vendorModel: string;
  displayModel: string;
  enableThinking: boolean;
  reasoningAvailable: boolean;
  onToggleThinking: (next: boolean) => void | Promise<void>;
  onOpenModelSettings: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  // The chip sits outside the card, so Radix would treat a click on it as "outside"; dismiss, then the click reopens: a flicker. The card is
  // told the chip is not outside, and the chip toggles like the trigger does. Whichever of the two opened the card gets focus back when it closes.
  const chipRef = useRef<HTMLButtonElement>(null);
  const openedByChipRef = useRef(false);
  const [choices, setChoices] = useState<ModelCardChoice[]>([]);
  const [anyPinned, setAnyPinned] = useState(true);
  const runtimeRef = useRef<string>("api");
  const { level, levelLabels, currentLabel, custom, apply } = useReasoningLevel({ enabled: enableThinking, onToggle: onToggleThinking });

  // Read on open and follow the broadcast while open: a pin added in Settings, or a pick made in another tile, shows up without reopening.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    const take = (settings: AppSettings) => {
      if (cancelled) return;
      setChoices(modelCardChoices(settings.llm));
      setAnyPinned((settings.llm.pinnedModels ?? []).length > 0);
      runtimeRef.current = settings.llm.activeChatRuntime?.kind ?? "api";
    };
    const api = getApi();
    void api.getSettings().then(take).catch(() => { /* card stays as it was */ });
    const unsubscribe = api.onSettingsUpdated(take);
    return () => { cancelled = true; unsubscribe(); };
  }, [open]);

  const pick = async (choice: Extract<ModelCardChoice, { kind: "api" }>) => {
    if (choice.current) {
      setOpen(false);
      return;
    }
    const api = getApi();
    // The card closes only once the pick took. A refused or failed save leaves it open with the current mark unmoved; the honest state.
    const saved = await api.updateSettings({
      llm: {
        provider: choice.vendor,
        vendors: { [choice.vendor]: { model: choice.modelId } },
      },
    });
    if (isIpcErrorResult(saved)) {
      console.warn("[ave] model pick was refused: %s", saved.error);
      return;
    }
    // A pinned model is an API model, so picking one is also choosing the API path when a subscription runtime was in use. That switch
    // has its own request; the settings patch refuses a runtime change on its own; and it is the same one the settings chooser sends.
    if (runtimeRef.current !== "api") await api.subscriptionUseApiForChat();
    setOpen(false);
  };

  const reasoningLabel = t("bottomActionRow.reasoning");
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid="iab-status-model"
          // SpotlightTour anchor. Step 6 of `first-boot-essentials` points at the model in use, and this button is the control that changes it.
          data-tour-anchor="model-picker"
          // The visible text is the model alone, so the vendor would be lost to anyone who cannot hover for the tooltip. The accessible name
          // carries the whole route; it still contains the visible text, so name-in-label holds and voice control can still say the model.
          aria-label={vendorModel}
          onClick={() => { openedByChipRef.current = false; }}
          className="inline-flex min-w-0 shrink items-center gap-1 text-left transition-opacity duration-(--motion-fast) ease-(--motion-ease-standard) hover:opacity-80 focus:outline-none focus-visible:ring-1 focus-visible:ring-input-bar-focus motion-reduce:transition-none"
          title={vendorModel}
        >
          <Brain className="h-3 w-3 shrink-0 text-input-bar-placeholder" aria-hidden="true" />
          <span className="min-w-0 truncate">{displayModel}</span>
        </button>
      </PopoverTrigger>
      {reasoningAvailable ? (
        <button
          type="button"
          ref={chipRef}
          data-testid="iab-status-reasoning"
          data-level={level}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label={`${reasoningLabel}: ${currentLabel}`}
          title={`${reasoningLabel}: ${currentLabel}`}
          onClick={() => {
            openedByChipRef.current = !open;
            setOpen(!open);
          }}
          className={`-m-1.5 flex shrink-0 cursor-pointer items-center p-1.5 transition-colors duration-(--motion-fast) ease-(--motion-ease-standard) hover:text-input-bar-action focus:outline-none focus-visible:ring-1 focus-visible:ring-input-bar-focus motion-reduce:transition-none ${level > 0 ? "text-input-bar-action" : "text-input-bar-placeholder"}`}
        >
          <ReasoningGauge level={level} />
        </button>
      ) : null}
      <PopoverContent
        align="end"
        side="top"
        sideOffset={6}
        className="w-72 p-0"
        data-testid="model-quick-picker"
        onInteractOutside={(event) => {
          if (chipRef.current?.contains(event.target as Node)) event.preventDefault();
        }}
        onCloseAutoFocus={(event) => {
          if (!openedByChipRef.current) return;
          event.preventDefault();
          chipRef.current?.focus();
        }}
      >
        <div className="px-3 pt-3 text-caption font-medium text-muted-foreground">
          {t("bottomActionRow.modelPickerModels")}
        </div>
        <ul className="max-h-56 overflow-y-auto px-1 py-1" role="listbox" aria-label={t("bottomActionRow.modelPickerModels")}>
          {choices.map((choice) => {
            const apiChoice = choice.kind === "api" ? choice : null;
            const subscriptionChoice = choice.kind === "subscription" ? choice : null;
            const key = apiChoice
              ? `${apiChoice.vendor}::${apiChoice.modelId}`
              : `subscription::${subscriptionChoice?.provider}`;
            const testId = apiChoice
              ? `model-quick-picker-option:${apiChoice.vendor}:${apiChoice.modelId}`
              : `model-quick-picker-option:${subscriptionChoice?.provider}`;
            // A subscription runtime with no model of its own (kimi-code, grok-build; `modelId` null) has nothing to put in the primary column, so the
            // provider label moves there instead of leaving it empty; the muted vendor column is then blank rather than repeating the same label twice.
            const modelLessSubscription = subscriptionChoice !== null && subscriptionChoice.modelId === null;
            // A CLI that runs its own default when nothing is chosen says so instead of leaving the model column to the label.
            const cliDefault = modelLessSubscription && isSubscriptionRuntimeId(subscriptionChoice.provider)
              && subscriptionRuntimeDescriptor(subscriptionChoice.provider).offersCliDefaultModel;
            const vendorText = modelLessSubscription && !cliDefault ? "" : choice.vendorLabel;
            const primaryText = cliDefault
              ? t("llmTab.cliDefaultModel")
              : modelLessSubscription ? choice.vendorLabel : (choice.modelId ?? "");
            return (
            <li key={key} role="option" aria-selected={choice.current}>
              <button
                type="button"
                onClick={apiChoice ? () => void pick(apiChoice) : undefined}
                disabled={!apiChoice}
                data-testid={testId}
                className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-accent focus:outline-none focus-visible:bg-accent disabled:cursor-default"
              >
                <span className="max-w-[7rem] shrink-0 truncate text-caption text-muted-foreground">{vendorText}</span>
                <span className="min-w-0 flex-1 truncate">{primaryText}</span>
                {choice.current ? <Check className="h-3.5 w-3.5 shrink-0 text-primary" aria-hidden="true" /> : null}
              </button>
            </li>
            );
          })}
        </ul>
        {anyPinned ? null : (
          <p className="px-3 pb-2 text-caption text-muted-foreground" data-testid="model-quick-picker-no-pins">
            {t("bottomActionRow.modelPickerNoPins")}
          </p>
        )}
        {reasoningAvailable ? (
          <div className="border-t border-border/(--opacity-medium) px-3 py-3" data-testid="model-quick-picker-reasoning">
            <div className="mb-2 text-caption font-medium text-muted-foreground">{reasoningLabel}</div>
            <ReasoningLevelControl level={level} levelLabels={levelLabels} currentLabel={currentLabel} custom={custom} apply={apply} label={reasoningLabel} />
          </div>
        ) : null}
        <button
          type="button"
          onClick={() => { setOpen(false); onOpenModelSettings(); }}
          data-testid="model-quick-picker-more"
          className="flex w-full items-center justify-between border-t border-border/(--opacity-medium) px-3 py-2 text-sm hover:bg-accent focus:outline-none focus-visible:bg-accent"
        >
          <span>{t("bottomActionRow.modelPickerMore")}</span>
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
        </button>
      </PopoverContent>
    </Popover>
  );
}

function stripVendorPrefix(vendorModel: string): string {
  const marker = " · ";
  const idx = vendorModel.indexOf(marker);
  if (idx < 0) return vendorModel;
  return vendorModel.slice(idx + marker.length);
}

/** Helper to capture user keyboard intent snapshot from window.aveApi. The bar itself does not know the intent → the caller wraps the send. */
export function makeBottomActionSendHandler(
  baseSend: (intent: UserKeyboardIntentSnapshot) => void,
): () => void {
  return () => {
    const api = (globalThis as typeof globalThis & {
      window?: { aveApi?: { captureUserKeyboardIntent?: () => UserKeyboardIntentSnapshot } };
    }).window?.aveApi;
    const intent = api?.captureUserKeyboardIntent?.() ?? {
      inputOrigin: "user-keyboard",
      token: "",
    };
    baseSend(intent);
  };
}

/** ShortcutsButton; fixed-size "?" affordance. Hover surfaces a "단축키" tooltip; click opens a tidy popover
 * listing every composer keybinding. Fixed form (h-[26px] w-[26px]) keeps the action row layout stable. */
export function ShortcutsButton() {
  const { t } = useTranslation();
  const label = t("bottomActionRow.shortcuts");
  return (
    <Popover>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              data-testid="composer-shortcuts-button"
              aria-label={label}
              className="h-[26px] w-[26px] shrink-0 text-input-bar-action transition-colors duration-(--motion-fast) ease-(--motion-ease-standard) hover:bg-input-bar-subtle hover:text-input-bar-action focus-visible:ring-input-bar-focus motion-reduce:transition-none"
            >
              <HelpCircle className="h-3.5 w-3.5" />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">{label}</TooltipContent>
      </Tooltip>

      <PopoverContent align="end" className="w-56 p-2" data-testid="composer-shortcuts-popover">
        <div className="px-1 pb-1.5 text-caption font-medium text-muted-foreground">{label}</div>
        <div className="flex flex-col gap-0.5">
          <ShortcutRow keys={["⏎"]} label={t("bottomActionRow.shortcutSend")} />
          <ShortcutRow keys={["⇧⏎"]} label={t("bottomActionRow.shortcutNewline")} />
          <ShortcutRow keys={["⌘⏎"]} label={t("bottomActionRow.shortcutImmediate")} />
          <ShortcutRow keys={["Esc"]} label={t("bottomActionRow.shortcutCancel")} />
          <ShortcutRow keys={["⌘K"]} label={t("bottomActionRow.shortcutPalette")} />
        </div>
      </PopoverContent>
    </Popover>
  );
}

function ShortcutRow({ keys, label }: { keys: string[]; label: string }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded px-1 py-0.5 text-caption">
      <span className="text-foreground">{label}</span>
      <span className="inline-flex items-center gap-1">
        {keys.map((k) => (
          <Kbd key={k}>{k}</Kbd>
        ))}
      </span>
    </div>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="inline-flex h-4 min-w-[16px] items-center justify-center rounded border border-border border-b-2 bg-muted px-1 font-mono text-micro text-muted-foreground">
      {children}
    </kbd>
  );
}
