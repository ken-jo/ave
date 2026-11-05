import { chatSurface } from "./chat-surface.js";
import type React from "react";
import { KeyRound, ShieldQuestion, Store } from "lucide-react";
import { useTranslation } from "../../../i18n/react.js";
import { imageInputRecoveryMessage } from "../../../shared/model-capability-settings.js";
import { Popover, PopoverContent, PopoverTrigger } from "../../../components/ui/popover.js";
import { useCallback, type RefObject } from "react";
import { SessionTasksPanel } from "./SessionTasksPanel.js";
import { ShellTasksPanel } from "./ShellTasksPanel.js";
import { SessionGoalPanel } from "./SessionGoalPanel.js";
import { LatestTurnSummary } from "./LatestTurnSummary.js";
import type { WorkspaceChanges } from "../preview/workspace-changes.js";
import { MessageQueuePanel } from "./MessageQueuePanel.js";
import { StatusBar, type StatusBarProps } from "./StatusBar.js";
import { Composer, ComposerFrame, type ComposerHandle } from "./Composer.js";
import { ComposerStatusRow, InputActionBar } from "./InputActionBar.js";
import { QuestionOverlay } from "./QuestionOverlay.js";
import { computeComposerPlaceholder } from "../utils/composer-placeholder.js";
import { ATTACH_MAX_COUNT, type Attachment } from "../types/attachments.js";
import { MessageQueueStore, type MessageQueueItem } from "../state/message-queue-store.js";
import type { ApprovalRequest, AveApi } from "../types.js";
import type { UserKeyboardIntentSnapshot } from "../../../shared/chat-origin.js";
import type { SuggestedRepliesSnapshot } from "../hooks/use-suggested-replies.js";
import type { QuickAction } from "./command-actions.js";
import type { PluginEntry } from "../types.js";
import type { ViewModeState } from "./ViewModeBanner.js";
import type { RolePreset } from "../../../data/role-presets.js";
import type { AskUserQuestionRequest } from "./AskUserQuestionCard.js";
import { ComposerProjectSelector } from "./ComposerProjectSelector.js";
import type { ProjectErrorReporter } from "../hooks/use-add-project-folder.js";
import type { ProjectIdentity } from "../../../shared/project-identity.js";
import type { McpPromptEntry } from "./slash-picker-data.js";
import type { AgentPluginTemplatePrompt } from "../../../shared/agent-plugin-prompt.js";

import { subscriptionImageAttachmentLimitViolation, type SubscriptionRuntimeUiPolicy } from "../utils/subscription-runtime-ui-policy.js";
import { supportsVision } from "../../../engine/llm/vendor-capabilities.js";
import type { LLMVendor } from "../../../shared/llm-vendor-defaults.js";
import type { RouteInputModalities } from "../../../shared/context-budget.js";
type InputStatusRow = React.ComponentProps<typeof ComposerStatusRow>["statusRow"];

export interface ChatComposerDockProps {
  dockColumnClass: string;
  /** Next-send notices belong inside the composer's reading column, above its frame. */
  notices?: React.ReactNode;
  /** Empty conversation: offer the new-chat project selector. The composer itself stays bottom-docked whether or
   * not the conversation is empty — there is no centered placement and no descent on first send. */
  emptyConversation?: boolean;
  workflowApi: AveApi;
  api: AveApi;
  currentSessionId: string;
  workspaceChanges: WorkspaceChanges;
  onRevealChangedFile: (path: string) => void;
  messageQueueStore: MessageQueueStore;
  onMessageQueueSendNow: (item: MessageQueueItem) => void;
  question: string;
  /** Prompts typed earlier in this session, oldest first (Up-arrow recall). */
  promptHistory?: readonly string[];
  statusBar?: StatusBarProps;
  composerRef: RefObject<ComposerHandle | null>;
  setQuestion: React.Dispatch<React.SetStateAction<string>>;
  attachments: Attachment[];
  setAttachments: React.Dispatch<React.SetStateAction<Attachment[]>>;
  attachmentNCounter: { current: number };
  onComposerSend: (intent: UserKeyboardIntentSnapshot) => void;
  suggestedReplies: SuggestedRepliesSnapshot;
  commandActions: QuickAction[];
  plugins: PluginEntry[];
  onSelectPlugin: (viewKey: string) => void;
  hasApiKey: boolean | null;
  /** Opens the settings window on a tab. Used by the no-key chip. */
  onOpenSettings: (tab?: string) => void;
  viewMode: ViewModeState | null;
  streaming: boolean;
  onInsertSlashCommand: (cmd: string) => void;
  onRunMcpPrompt: (prompt: McpPromptEntry) => void;
  onRunPluginPrompt: (prompt: AgentPluginTemplatePrompt) => void;
  slashPickerOpen: boolean;
  onSlashPickerOpenChange: (open: boolean) => void;
  ringSlot: React.ReactNode;
  onAttach: () => Promise<void> | void;
  /** Files dropped on the composer (resolved and registered through the preload). */
  onDropFiles?: (files: FileList) => void;
  /** App-owned warning for a verified image-capability refusal only. */
  onImageAttachmentUnavailable?: () => void;
  /** Canonical selected subscription runtime policy; legacy markers are fallback-only. */
  subscriptionRuntimePolicy?: SubscriptionRuntimeUiPolicy;
  /** App-owned warning for a supported image that exceeds the runtime budget. */
  onImageAttachmentLimitExceeded?: () => void;
  /** Selected subscription runtime has not verified original local image input. */
  subscriptionImageAttachmentProvider?: string;
  /** Selected subscription runtime has not verified file-marker attachment support. */
  subscriptionFileAttachmentProvider?: string;
  /** False until the persisted active runtime selection is authoritative. */
  settingsLoaded?: boolean;
  subscriptionUnavailableProvider?: string;
  subscriptionPendingProvider?: string;
  /** The API-key model the draft would go to — read for the image capability gate. */
  llmVendor: LLMVendor;
  llmModel: string;
  /** That route's input modalities, as its endpoint or the catalog states them; `undefined` until settings have resolved. */
  llmRouteModalities: RouteInputModalities | undefined;
  rolePresets: RolePreset[];
  activePresetId: string;
  onSelectPreset: (id: string) => void;
  onBottomSend: () => void;
  onCancel: () => void;
  enableThinkingChat: boolean;
  reasoningAvailable?: boolean;
  onToggleThinking: (v: boolean) => Promise<void> | void;
  inputStatusRow: InputStatusRow;
  onOpenModelSettings: () => void;
  onOpenPermissions: () => void;
  onOpenApprovalQueue?: () => void;
  /** Approvals this conversation's turn is parked on; the band above the queue names them. */
  pendingApprovals: readonly ApprovalRequest[];
  askQuestions: AskUserQuestionRequest[];
  onResolveAskQuestion: (id: string) => void;
  /** Active project — drives the empty-state project selector trigger label. */
  activeProject?: ProjectIdentity;
  /** Full known project list — same SOT the sidebar's project group reads from. */
  workspaceProjects?: ProjectIdentity[];
  /** Switch the active project — the same handler wired to the sidebar's project rows. */
  onNewChatForProject?: (project: { projectRoot?: string; projectName?: string }) => void | Promise<void>;
  /** Re-fetch the workspace project list after adding a project folder. */
  onRefreshProjects?: () => void | Promise<void>;
  onProjectError?: ProjectErrorReporter;
  /** Controlled open state for the project selector dropdown — owned by ChatView so it can be force-closed when the
   * conversation stops being empty. */
  projectSelectorOpen: boolean;
  onProjectSelectorOpenChange: (open: boolean) => void;
}

interface ComposerRuntimeGateInput {
  /** Canonical selected subscription runtime policy; legacy markers are fallback-only. */
  subscriptionRuntimePolicy?: SubscriptionRuntimeUiPolicy;
  subscriptionImageAttachmentProvider?: string;
  subscriptionFileAttachmentProvider?: string;
  settingsLoaded?: boolean;
  subscriptionUnavailableProvider?: string;
  subscriptionPendingProvider?: string;
  /** The draft's current attachments — checked against the selected runtime. */
  attachments: Attachment[];
  /** The API-key model the draft would go to. Only consulted when no subscription runtime is selected — a selected runtime
   * owns its own image capability and the API-key model is not in the path at all. */
  llmVendor?: LLMVendor;
  llmModel?: string;
  /** That route's input modalities; `undefined` until settings have resolved. */
  llmRouteModalities?: RouteInputModalities;
}

interface ComposerRuntimeGates {
  runtimeImageAttachmentProvider: string | undefined;
  runtimeFileAttachmentProvider: string | undefined;
  runtimeUnavailable: boolean;
  runtimePending: boolean;
  attachmentInputsReady: boolean;
  imagesEnabled: boolean;
  filesEnabled: boolean;
  /**
   * A runtime may be switched after a draft has accumulated attachments. Keep
   * the draft editable so the user can remove or preserve markers, but do not
   * leave either visual send path enabled for an attachment type the newly
   * selected runtime has not verified.
   */
  draftHasUnsupportedAttachment: boolean;
  /** The unsupported attachment is an image the API-key model cannot read. It is the one cause the user can clear from inside
   * the composer — by removing the images or switching models — so it is the one that earns a written hint. */
  draftImagesRejectedByModel: boolean;
}

/**
 * What the selected runtime lets a composer accept and send. One resolver for
 * every composer surface: the main dock and the side chat read the same
 * readiness contract, so the answer to "may this draft go out" is computed
 * once, here, rather than once per surface.
 */
export function resolveComposerRuntimeGates({
  subscriptionRuntimePolicy,
  subscriptionImageAttachmentProvider,
  subscriptionFileAttachmentProvider,
  settingsLoaded,
  subscriptionUnavailableProvider,
  subscriptionPendingProvider,
  attachments,
  llmVendor,
  llmModel,
  llmRouteModalities,
}: ComposerRuntimeGateInput): ComposerRuntimeGates {
  const runtimeImageAttachmentProvider = subscriptionRuntimePolicy
    ? subscriptionRuntimePolicy.imageAttachmentProvider
    : subscriptionImageAttachmentProvider;
  const runtimeFileAttachmentProvider = subscriptionRuntimePolicy
    ? subscriptionRuntimePolicy.fileAttachmentProvider
    : subscriptionFileAttachmentProvider;
  const runtimeUnavailable = subscriptionRuntimePolicy
    ? subscriptionRuntimePolicy.chatUnavailable
    : subscriptionUnavailableProvider !== undefined;
  const runtimePending = subscriptionRuntimePolicy
    ? subscriptionRuntimePolicy.chatPending
    : subscriptionPendingProvider !== undefined;
  const attachmentInputsReady = subscriptionRuntimePolicy
    ? subscriptionRuntimePolicy.attachmentInputsReady
    : settingsLoaded !== false && !runtimePending;
  const imagesEnabled = subscriptionRuntimePolicy
    ? subscriptionRuntimePolicy.imagesEnabled
    : attachmentInputsReady && runtimeImageAttachmentProvider === undefined;
  const filesEnabled = subscriptionRuntimePolicy
    ? subscriptionRuntimePolicy.filesEnabled
    : attachmentInputsReady && runtimeFileAttachmentProvider === undefined;
  // Disable image sends only for resolved text-only API routes; subscription runtimes own their image capability.
  const draftImagesRejectedByModel =
    subscriptionRuntimePolicy?.subscriptionSelected !== true
    && llmVendor !== undefined
    && llmModel !== undefined
    && attachments.some((attachment) => attachment.kind === "image")
    && !supportsVision(llmVendor, llmModel, llmRouteModalities);
  const draftHasUnsupportedAttachment =
    (runtimeImageAttachmentProvider !== undefined
      && attachments.some((attachment) => attachment.kind === "image"))
    || (runtimeFileAttachmentProvider !== undefined
      && attachments.some((attachment) => attachment.kind === "file"))
    || draftImagesRejectedByModel
    || subscriptionImageAttachmentLimitViolation(
      subscriptionRuntimePolicy?.imageAttachmentLimits,
      attachments
        .filter((attachment) => attachment.kind === "image")
        .map((attachment) => ({ bytes: attachment.bytes })),
    ) !== null;
  return {
    runtimeImageAttachmentProvider,
    runtimeFileAttachmentProvider,
    runtimeUnavailable,
    runtimePending,
    attachmentInputsReady,
    imagesEnabled,
    filesEnabled,
    draftHasUnsupportedAttachment,
    draftImagesRejectedByModel,
  };
}

/**
 * Presentational composer dock: the tasks/queue panels, the deferred-approval
 * chip, the composer toast surface, the unified input box (Composer +
 * InputActionBar), and the ask-user question overlay. Moved verbatim from
 * ChatView so every data-testid + i18n key + gating expression is unchanged;
 * all stateful logic stays in ChatView's hooks and is threaded in via props.
 */
export function ChatComposerDock({
  dockColumnClass,
  notices,
  emptyConversation = false,
  workflowApi,
  api,
  currentSessionId,
  messageQueueStore,
  onMessageQueueSendNow,
  question,
  promptHistory,
  statusBar,
  composerRef,
  setQuestion,
  attachments,
  setAttachments,
  attachmentNCounter,
  onComposerSend,
  suggestedReplies,
  commandActions,
  plugins,
  onSelectPlugin,
  hasApiKey,
  onOpenSettings,
  viewMode,
  streaming,
  onInsertSlashCommand,
  onRunMcpPrompt,
  onRunPluginPrompt,
  slashPickerOpen,
  onSlashPickerOpenChange,
  onImageAttachmentUnavailable,
  onImageAttachmentLimitExceeded,
  ringSlot,
  onAttach,
  onDropFiles,
  subscriptionRuntimePolicy,
  subscriptionImageAttachmentProvider,
  subscriptionFileAttachmentProvider,
  settingsLoaded,
  subscriptionUnavailableProvider,
  subscriptionPendingProvider,
  llmVendor,
  llmModel,
  llmRouteModalities,
  rolePresets,
  activePresetId,
  onSelectPreset,
  onBottomSend,
  onCancel,
  enableThinkingChat,
  reasoningAvailable,
  onToggleThinking,
  inputStatusRow,
  onOpenModelSettings,
  onOpenPermissions,
  onOpenApprovalQueue,
  pendingApprovals,
  askQuestions,
  onResolveAskQuestion,
  activeProject,
  workspaceProjects,
  onNewChatForProject,
  onRefreshProjects,
  onProjectError,
  projectSelectorOpen,
  onProjectSelectorOpenChange,
  workspaceChanges,
  onRevealChangedFile,
}: ChatComposerDockProps) {
  const { t } = useTranslation();

  // Keep allocateN stable so mention acceptance and memoized keyboard handlers do not rebuild on every render.
  const allocateN = useCallback(() => ++attachmentNCounter.current, [attachmentNCounter]);
  const {
    runtimeImageAttachmentProvider,
    runtimeFileAttachmentProvider,
    runtimeUnavailable,
    runtimePending,
    attachmentInputsReady,
    imagesEnabled,
    filesEnabled,
    draftHasUnsupportedAttachment,
    draftImagesRejectedByModel,
  } = resolveComposerRuntimeGates({
    subscriptionRuntimePolicy,
    subscriptionImageAttachmentProvider,
    subscriptionFileAttachmentProvider,
    settingsLoaded,
    subscriptionUnavailableProvider,
    subscriptionPendingProvider,
    attachments,
    llmVendor,
    llmModel,
    llmRouteModalities,
  });
  const composerInputDisabled = viewMode !== null || (hasApiKey === false && (
    runtimeUnavailable
    || runtimePending
    || !question.trimStart().startsWith("/")
  ));
  const composerSendDisabled = !attachmentInputsReady
    || composerInputDisabled
    || draftHasUnsupportedAttachment;
  return (
    <div
      className="relative z-30 w-full max-w-full min-w-0 overflow-visible"
      // The composer-dock anchor QuestionOverlay and ApprovalDock look up. The composer has one placement (bottom-docked); the
      // value is kept for them.
      data-composer-placement="bottom"
      // Which surface this whole dock subtree serves. The Composer's textarea
      // carries the same attribute for the field itself; here it covers the
      // queue panel and action bar too, so a test (or a stylesheet) can address
      // "the main dock's send button" without matching the side chat's, which
      // renders the very same test ids.
      data-composer-surface="main"
    >
      <div className={`${dockColumnClass} px-3`} data-testid="composer-queue-dock">
        <ApprovalWaitingBand pendingApprovals={pendingApprovals} />
        <MessageQueuePanel
          store={messageQueueStore}
          onSendNow={onMessageQueueSendNow}
          heldByApproval={pendingApprovals.length > 0}
        />
        {notices}
        <LatestTurnSummary changes={workspaceChanges} onReveal={onRevealChangedFile} />
      </div>
      <div className={`${dockColumnClass} flex flex-col overflow-x-hidden pb-1`}>
        {/* This conversation's notices — an attachment the composer refused,
            a provider swap mid-turn, a pre-turn compaction — take a row of
            their own, IN FLOW, above the selector/runtime strip and the
            composer card, at the composer's width. A notice that overlaid the
            strip painted over the project selector and the runtime pill and
            was clipped by them; in flow it pushes them down instead, the same
            rule the window's notice strip follows. */}
        {statusBar && (statusBar.visibleToast !== null || statusBar.persistent.length > 0) ? (
          <div
            className="mx-3 mb-2 min-w-0"
            data-testid="composer-toast-dock"
          >
            <StatusBar {...statusBar} />
          </div>
        ) : null}
        {/* ONE input box: textarea + the single InputActionBar (action row).
            The session line — model / permission / active / ring — is drawn
            UNDER the box by ComposerStatusRow, not inside it: what is inside
            the box is about the message being written. The window StatusBar
            is notifications-only.
            The shared surface paints the edge as an inset hairline so
            the dock's overflow handling cannot clip the composer edge. */}
        <div className={`relative mx-3 mb-2 ${hasApiKey === false || (emptyConversation && onNewChatForProject) ? "pt-9" : ""}`}>
          {/* Empty-state project selector — attached directly above the
              composer card, in the reserved strip it shares with the no-key
              chip. Offered only while the conversation is empty: a project is
              chosen before the first message. */}
          {emptyConversation && onNewChatForProject ? (
            <div
              className="absolute left-0 top-0 z-20"
              data-testid="composer-project-selector-slot"
            >
              <ComposerProjectSelector
                activeProject={activeProject}
                projects={workspaceProjects ?? (activeProject ? [activeProject] : [])}
                onSelectProject={onNewChatForProject}
                onRefreshProjects={onRefreshProjects}
                onProjectError={onProjectError}
                open={projectSelectorOpen}
                onOpenChange={onProjectSelectorOpenChange}
              />
            </div>
          ) : null}
          {/* No-key affordance — mirrored across the same reserved strip the
              project selector occupies. Absolutely positioned + popover-based,
              so it adds no layout height (it replaced a transcript card that
              did claim height).
              `hasApiKey` here is App's `effectiveLlmReady`, which already ORs in
              `llmReadyWithoutApiKey` — a keyless-ready session never shows it,
              and `null` (probe unresolved) stays silent. */}
          {hasApiKey === false ? (
            <div
              className="absolute right-0 top-0 z-20"
              data-testid="composer-api-key-chip-slot"
            >
              <ComposerApiKeyChip
                onOpenSettings={onOpenSettings}
                subscriptionRuntimePolicy={subscriptionRuntimePolicy}
                subscriptionUnavailableProvider={subscriptionUnavailableProvider}
                subscriptionPendingProvider={subscriptionPendingProvider}
              />
            </div>
          ) : null}
          <ComposerFrame>
        <Composer
          ref={composerRef}
          surface="main"
          text={question}
          onTextChange={setQuestion}
          promptHistory={promptHistory}
          attachments={attachments}
          onAttachmentsChange={setAttachments}
          allocateN={allocateN}
          saveClipboardImage={(b64) => window.ave.attach.saveClipboardImage(b64)}
          discardClipboardImage={(filePath) => window.ave.attach.discardClipboardImage(filePath)}
          openExternal={(p) => window.ave.attach.openExternal(p)}
          imagesEnabled={imagesEnabled}
          filesEnabled={filesEnabled}
          onDropFiles={onDropFiles}
          imageAttachmentLimits={subscriptionRuntimePolicy?.imageAttachmentLimits}
          onSend={onComposerSend}
          suggestedReplies={suggestedReplies}
          commandActions={commandActions}
          inlinePlugins={plugins}
          onSelectPlugin={onSelectPlugin}
          disabled={composerInputDisabled}
          sendDisabled={composerSendDisabled}
          onWarning={(message) => console.warn(message)}
          onImageAttachmentUnavailable={onImageAttachmentUnavailable}
          onImageAttachmentLimitExceeded={onImageAttachmentLimitExceeded}
          placeholder={computeComposerPlaceholder({
            hasApiKey,
            streaming,
            suggestedReplies,
            subscriptionUnavailable: runtimeUnavailable,
            subscriptionPending: runtimePending,
          })}
        />
        <InputActionBar
          plugins={plugins}
          onSelectPlugin={onSelectPlugin}
          onInsertSlashCommand={onInsertSlashCommand}
          onRunMcpPrompt={onRunMcpPrompt}
          onRunPluginPrompt={onRunPluginPrompt}
          loadCustomCommands={api.chatListCustomCommands}
          slashPickerOpen={slashPickerOpen}
          onSlashPickerOpenChange={onSlashPickerOpenChange}
          attachDisabled={
            attachments.length >= ATTACH_MAX_COUNT ||
            !attachmentInputsReady ||
            hasApiKey === false ||
            (!imagesEnabled && !filesEnabled)
          }
          attachDisabledReason={!attachmentInputsReady
            ? "runtime-pending"
            : (!imagesEnabled && !filesEnabled)
            ? "subscription-unsupported"
            : hasApiKey === false ? "no-api-key" : "limit"}
          attachDisabledSubscriptionProvider={
            runtimeImageAttachmentProvider ?? runtimeFileAttachmentProvider
          }
          onAttach={onAttach}
          rolePresets={rolePresets}
          activePresetId={activePresetId}
          onSelectPreset={onSelectPreset}
          isBusy={streaming}
          hasDraft={question.trim().length > 0 || attachments.length > 0}
          isSendDisabled={
            composerSendDisabled || (question.trim().length === 0 && attachments.length === 0)
          }
          onSend={onBottomSend}
          onCancel={() => {
            // ESC handler 와 동일: 큐를 inject + abort (멈춤 X, 입력으로 inject).
            onCancel();
          }}
        />
          </ComposerFrame>
          {/* Says why the send button went quiet, directly under the box that
              holds the images it is talking about. Without it a disabled send
              button is the whole message, and the composer stops responding to
              Enter for a reason nothing on screen states. */}
          {draftImagesRejectedByModel ? (
            <div
              role="status"
              aria-live="polite"
              className="mx-4 mt-1 text-xs text-warning"
              data-testid="composer-vision-unsupported-hint"
            >
              {t("app.visionNotSupported", { llmModel })} {imageInputRecoveryMessage(t)}
            </div>
          ) : null}
          <ComposerStatusRow
            statusRow={inputStatusRow}
            ringSlot={ringSlot}
            // The session's task list is a chip on this row, next to the
            // ring: it describes the work this conversation is doing, which
            // is what the row is for. Up in the queue dock it floated over an
            // empty toast reserve whenever there was nothing to notify.
            tasksSlot={<><SessionTasksPanel api={workflowApi} sessionId={currentSessionId} /><ShellTasksPanel api={api} sessionId={currentSessionId} composerRef={composerRef} /></>}
            /** The goal sits next to the plan for the same reason the plan sits here: it describes what this conversation is doing. */
            goalSlot={<SessionGoalPanel api={workflowApi} sessionId={currentSessionId} />}
            onOpenModelSettings={onOpenModelSettings}
            onOpenPermissions={onOpenPermissions}
            onOpenApprovalQueue={onOpenApprovalQueue}
            enableThinkingChat={enableThinkingChat}
            reasoningAvailable={reasoningAvailable}
            onToggleThinking={onToggleThinking}
          />
        </div>
      </div>
      <QuestionOverlay
        api={api}
        requests={askQuestions}
        onResolved={onResolveAskQuestion}
      />
    </div>
  );
}

/** Show credential setup only for resolved false readiness; keyless-ready and pending-probe states must not flash a login
 * prompt. */

/**
 * The dock strip for a turn parked on an approval. It sits in the tile whose
 * conversation asked, beside the queue it explains: the approval card is drawn
 * in that tile's own overlay lane, away from the composer, so the dock alone
 * would show a turn that has simply stopped moving and a queue that never
 * drains. Its frame follows the queue card below it; the icon carries the warning state.
 */
function ApprovalWaitingBand({ pendingApprovals }: { pendingApprovals: readonly ApprovalRequest[] }) {
  const { t } = useTranslation();
  if (pendingApprovals.length === 0) return null;
  const tools = [...new Set(pendingApprovals.map((req) => req.toolName))].join(", ");
  return (
    <div
      role="status"
      aria-live="polite"
      className={`${chatSurface()} mb-2 flex min-w-0 items-center gap-2 px-3 py-2 text-xs text-foreground`}
      data-testid="approval-waiting-band"
      data-tool-names={tools}
    >
      <ShieldQuestion className="h-3 w-3 shrink-0 text-warning" />
      <span className="min-w-0 truncate">{t("chatView.approvalWaitingBand", { tools })}</span>
    </div>
  );
}

interface ComposerApiKeyChipProps {
  subscriptionPendingProvider?: string;
  subscriptionRuntimePolicy?: SubscriptionRuntimeUiPolicy;
  onOpenSettings: (tab?: string) => void;
  subscriptionUnavailableProvider?: string;
}

export function ComposerApiKeyChip({
  onOpenSettings,
  subscriptionUnavailableProvider,
  subscriptionRuntimePolicy,
  subscriptionPendingProvider,
}: ComposerApiKeyChipProps) {
  const { t } = useTranslation();
  const subscriptionUnavailable = subscriptionRuntimePolicy
    ? subscriptionRuntimePolicy.chatUnavailable
    : subscriptionUnavailableProvider !== undefined;
  const subscriptionPending = subscriptionRuntimePolicy ? subscriptionRuntimePolicy.chatPending : subscriptionPendingProvider !== undefined;
  const subscriptionIssue = subscriptionUnavailable || subscriptionPending;
  const title = subscriptionPending
    ? t("subscriptionProvidersSection.statusChecking")
    : subscriptionUnavailable
    ? t("formatIpcError.subscriptionChatUnavailable")
    : t("chatView.noApiKeyTitle");

  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          data-testid={subscriptionIssue ? "composer-subscription-runtime-chip" : "composer-api-key-chip"}
          className="inline-flex items-center gap-1.5 rounded-full border border-border-subtle bg-secondary px-2.5 py-1 text-[11px] text-secondary-foreground transition-colors hover:bg-muted"
        >
          <KeyRound className="h-3 w-3 shrink-0 text-muted-foreground" aria-hidden="true" />
          {title}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        side="bottom"
        sideOffset={6}
        className="w-[17rem] p-1"
        data-testid="composer-api-key-popover"
      >
        <p className="px-2 pb-1 pt-1.5 text-[11px] leading-snug text-muted-foreground">
          {subscriptionIssue ? title : t("chatView.noApiKeyDescription")}
        </p>
        <button
          type="button"
          data-testid="composer-api-key-chip:settings"
          onClick={() => onOpenSettings("llm")}
          className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-[12px] text-secondary-foreground transition-colors hover:bg-muted"
        >
          <KeyRound className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          {t("chatView.openSettingsButton")}
        </button>
        {!subscriptionIssue ? <button
          type="button"
          data-testid="composer-api-key-chip:marketplace"
          onClick={() => onOpenSettings("marketplace")}
          className="flex w-full items-center gap-2 rounded-md px-2 py-2 text-left text-[12px] text-secondary-foreground transition-colors hover:bg-muted"
        >
          <Store className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          {t("chatView.openMarketplaceButton")}
        </button> : null}
      </PopoverContent>
    </Popover>
  );
}
