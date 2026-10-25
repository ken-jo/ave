/** Share IDs only when multiple surfaces need them; component-local IDs remain literals. */
export const TEST_IDS = {
  allowSessionButton: "allow-session-button",
  approvalDock: "approval-dock",
  approvalDockQueueDepth: "approval-dock-queue-depth",
  approvalReviewDetails: "approval-review-details",
  approveButton: "approve-button",
  panePanelToggle: "pane-panel-toggle",
  paneThumbnailToggle: "pane-thumbnail-toggle",
  chatSidePanel: "chat-side-panel",
  chatViewRoot: "chat-view-root",
  composer: "composer",
  composerInputBar: "composer-input-bar",
  composerTextarea: "composer-textarea",
  denyButton: "deny-button",
  llmModelSelect: "llm-model-select",
  openPermanentDenySettings: "open-permanent-deny-settings",
  pluginInstallNetworkAccess: "plugin-install-network-access",
  questionOverlay: "question-overlay",
  reviewerPromptPanel: "reviewer-prompt-panel",
  routeCanvas: "route-canvas",
  settingsMobileBack: "settings-mobile-back",
  settingsPageTitle: "settings-page-title",
  slashPickerTrigger: "slash-picker-trigger",
  spotlightTourCard: "spotlight-tour:card",
  tokenCostBadge: "token-cost-badge",
  viewPathBack: "view-path-back",
} as const;

export type TestId = (typeof TEST_IDS)[keyof typeof TEST_IDS];

export function chatSidePanelLauncherTestId(kind: string): string {
  return `chat-side-panel-launcher-${kind}`;
}

export function execModeTestId(mode: string): string {
  return `exec-mode-${mode}`;
}

export function testIdSelector(id: TestId): string {
  return `[data-testid="${id}"]`;
}

/** Portaled modal dialogs are window-wide. */
const MODAL_DIALOG_SELECTORS = [
  '[role="dialog"][data-state="open"]',
  '[role="alertdialog"][data-state="open"]',
] as const;
export const MODAL_DIALOG_SELECTOR = MODAL_DIALOG_SELECTORS.join(", ");

/** Blocking dialogs, approvals, and questions pause queueing and tours; composer-local checks must use blockingSurfaceCovers rather than the whole document. */
export const BLOCKING_SURFACE_SELECTOR = [
  // Exclude the tour dialog from the blocking set or it would queue behind itself.
  ...MODAL_DIALOG_SELECTORS.map(
    (selector) => `${selector}:not(${testIdSelector(TEST_IDS.spotlightTourCard)})`,
  ),
  testIdSelector(TEST_IDS.approvalDock),
  testIdSelector(TEST_IDS.questionOverlay),
].join(", ");
