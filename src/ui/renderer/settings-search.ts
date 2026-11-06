import { SETTINGS_TAB_LABEL_KEYS, type SettingsTab } from "../../shared/settings-tabs.js";

interface SettingsSearchEntry {
  tab: SettingsTab;
  section: string;
  title: string;
  labels: readonly string[];
}

const SETTINGS_SEARCH_ENTRIES: readonly SettingsSearchEntry[] = [
  {"tab":"llm","section":"llm-providers","title":"llmTab.providerConfig","labels":[]},
  {"tab":"llm","section":"llm-thinking","title":"llmTab.thinkingTitle","labels":["llmTab.reasoningEffortLabel","llmTab.reasoningEffortAriaLabel"]},
  {"tab":"llm","section":"llm-fallback","title":"llmTab.fallbackTitle","labels":[]},
  {"tab":"llm","section":"llm-pricing-overrides","title":"llmTab.pricingOverridesTitle","labels":[]},
  {"tab":"llm","section":"llm-model-catalog","title":"llmTab.modelCatalogTitle","labels":["llmTab.pageTitle"]},
  {"tab":"appearance","section":"appearance-language","title":"settings.appearance.language.title","labels":[]},
  {"tab":"appearance","section":"appearance-theme","title":"appearanceTab.schemeTitle","labels":["appearanceTab.mode","appearanceTab.scheme.dark","appearanceTab.scheme.light"]},
  {"tab":"appearance","section":"appearance-font","title":"appearanceTab.fontSectionTitle","labels":["appearanceTab.fontFamilyLabel","appearanceTab.fontFamilyRadioGroupLabel","appearanceTab.fontSizeLabel","appearanceTab.fontSizeRadioGroupLabel"]},
  {"tab":"appearance","section":"appearance-terminal","title":"appearanceTab.terminalTitle","labels":["appearanceTab.terminalFamily","appearanceTab.terminalSize","appearanceTab.terminalLineHeight"]},
  {"tab":"chat","section":"chat-optimization","title":"chatTab.conversationOptimizationTitle","labels":["chatTab.autoCompactLabel"]},
  {"tab":"chat","section":"chat-stream-smoothing","title":"chatTab.streamSmoothingTitle","labels":[]},
  {"tab":"chat","section":"chat-processing-display","title":"chatTab.processingDisplayTitle","labels":["chatTab.processingDisplayAriaLabel"]},
  {"tab":"chat","section":"chat-experimental","title":"chatTab.experimentalTitle","labels":["chatTab.idleRefreshLabel","chatTab.idleMemoryConsolidationLabel","chatTab.subAgentWakeLabel","chatTab.subAgentMaxRoundsLabel"]},
  {"tab":"chat","section":"chat-privacy","title":"chatTab.privacyTitle","labels":["privacyTab.piiRedactTitle","privacyTab.piiRedactToggleLabel"]},
  {"tab":"chat","section":"chat-documents","title":"documentSettings.title","labels":["documentSettings.direct","documentSettings.link","documentEngine.title"]},
  {"tab":"web","section":"web-search-engine","title":"webTab.searchEngineTitle","labels":[]},
  {"tab":"web","section":"web-api-key","title":"webTab.apiKeyTitle","labels":["webTab.apiKeyLabel"]},
  {"tab":"web","section":"web-view-flow","title":"appearanceTab.webViewSectionTitle","labels":["appearanceTab.webViewCurrentLabel","appearanceTab.webViewRadioGroupLabel"]},
  {"tab":"startup","section":"startup-shortcut","title":"startupTab.shortcutSectionTitle","labels":["startupTab.shortcutEnabledLabel","startupTab.shortcutAcceleratorLabel"]},
  {"tab":"startup","section":"startup-launch","title":"startupTab.launchSectionTitle","labels":["startupTab.launchAtStartupLabel","startupTab.launchMinimizedLabel"]},
  {"tab":"startup","section":"startup-rendering","title":"startupTab.renderingSectionTitle","labels":["startupTab.hardwareAccelerationLabel"]},
  {"tab":"startup","section":"startup-corp-ca","title":"startupTab.corpCaSectionTitle","labels":["startupTab.corpCaEnabledLabel","startupTab.corpCaCommonNameLabel","startupTab.corpCaDebugLabel"]},
  {"tab":"startup","section":"startup-system-behavior","title":"generalTab.systemBehaviorTitle","labels":["generalTab.hideToTrayLabel","generalTab.quitLabel","startupTab.shutdownTimeoutLabel"]},
  {"tab":"permissions","section":"permissions-os-sandbox","title":"permissionsTab.osSandboxTitle","labels":["permissionsTab.osSandboxCheckboxAriaLabel","permissionsTab.osSandboxShellLabel","permissionsTab.workerConfinementCheckboxAriaLabel","permissionsTab.workerConfinementLabel","permissionsTab.pageTitle","permissionsTab.closeBannerAriaLabel","permissionsTab.exactDenyDraftTitle","permissionsTab.hookQuarantineTitle"]},
  {"tab":"permissions","section":"permissions-policy-summary","title":"permissionsTab.currentPolicySummaryTitle","labels":["permissionsTab.reviewerModeFaultTitle"]},
  {"tab":"permissions","section":"permissions-policy","title":"permissionsTab.policyTitle","labels":["permissionsTab.policyAriaLabel","permissionsTab.frameworkSystemPromptTitle"]},
  {"tab":"permissions","section":"permissions-approval-dialog","title":"permissionsTab.approvalDialogTitle","labels":["permissionsTab.approvalDialogCheckboxAriaLabel","permissionsTab.adminManagedTitle","permissionsTab.ownerAwayAutoSkipLabel"]},
  {"tab":"permissions","section":"permissions-network","title":"permissionsTab.networkTitle","labels":[]},
  {"tab":"permissions","section":"permissions-rules","title":"permissionsTab.unifiedRulesTitle","labels":["permissionsTab.exactApprovalLabel"]},
  {"tab":"permissions","section":"permissions-directories","title":"permissionsTab.directoriesTitle","labels":["permissionsTab.directoryWarningTitle"]},
  {"tab":"permissions","section":"permissions-audit-log","title":"permissionsTab.auditLogTitle","labels":[]},
  {"tab":"permissions","section":"permissions-judge","title":"permissionJudge.title","labels":[]},
  {"tab":"permissions","section":"permissions-work-board-approvals","title":"workBoard.approvalSurfaceTitle","labels":[]},
  {"tab":"remote-surfaces","section":"remote-tailnet","title":"remoteSurfacesTab.tailnetSectionTitle","labels":["tailnetAccessTab.inviteTitle","tailnetAccessTab.inviteDurationLabel","tailnetAccessTab.createdInvitationTitle","tailnetAccessTab.pairingsTitle","tailnetAccessTab.shareTitle","tailnetAccessTab.sharePermissionLabel","tailnetAccessTab.shareDurationLabel"]},
  {"tab":"remote-surfaces","section":"remote-tailnet-observer","title":"tailnetSetup.sectionTitle","labels":["tailnetObserver.enabledLabel","tailnetObserver.appCapabilityLabel","tailnetObserver.capabilityLabel","tailnetObserver.portLabel","tailnetObserver.pairedSharingLabel"]},
  {"tab":"remote-surfaces","section":"remote-telegram","title":"telegramConnection.sectionTitle","labels":["telegramConnection.botLabel","telegramConnection.ownerUserIdLabel","telegramConnection.connectDialogTitle","telegramConnection.botTokenLabel","telegramConnection.pairingCodeTitle","telegramConnection.approvalDurationLabel"]},
  {"tab":"remote-surfaces","section":"remote-local-api","title":"localApiSurfaces.sectionTitle","labels":["localApiSurfaces.localApiLabel","localApiSurfaces.a2aLoopbackLabel","localApiSurfaces.a2aRemoteRoutingLabel","localApiSurfaces.a2aRemoteReceiverLabel"]},
  {"tab":"roles","section":"roles-agents","title":"rolesTab.sectionAgents","labels":["rolesTab.keepLatestLabel","rolesTab.savingLabel","rolesTab.upgradeMarkersTitle","rolesTab.mergingLabel","rolesTab.mergedTitle"]},
  {"tab":"roles","section":"roles-memory","title":"rolesTab.sectionMemory","labels":["rolesTab.consolidatingLongTermMemoryLabel"]},
  {"tab":"roles","section":"roles-preferences","title":"rolesTab.sectionPreferences","labels":["rolesTab.refreshingLabel","rolesTab.savingLabel"]},
  {"tab":"roles","section":"roles-presets","title":"rolesTab.sectionRoles","labels":[]},
  {"tab":"roles","section":"roles-preview","title":"rolesTab.sectionPreview","labels":[]},
  {"tab":"usage","section":"usage-workspace","title":"generalTab.workspaceTitle","labels":["generalTab.refreshStatsAriaLabel","generalTab.statsGroupAriaLabel","generalTab.marketplaceLabel"]},
  {"tab":"audit","section":"audit-stats","title":"auditTab.statsTitle","labels":[]},
  {"tab":"audit","section":"audit-filter","title":"auditTab.filterTitle","labels":[]},
  {"tab":"audit","section":"audit-bundle","title":"auditTab.bundleSectionTitle","labels":[]},
  {"tab":"audit","section":"audit-log-file","title":"auditTab.logSectionTitle","labels":[]},
  {"tab":"audit","section":"audit-crash","title":"auditTab.crashSectionTitle","labels":["auditTab.crashColSize"]},
  {"tab":"audit","section":"audit-telemetry","title":"auditTab.telemetrySectionTitle","labels":["auditTab.telemetryEnabledLabel","auditTab.telemetryEndpointLabel","auditTab.telemetryCrashReportingLabel","auditTab.telemetryCrashEndpointLabel","auditTab.telemetrySentryDsnLabel"]},
  {"tab":"plugin-config","section":"plugin-config-installed","title":"pluginConfigTab.pageTitle","labels":["pluginConfigTab.activeLabel","pluginConfigTab.inactiveLabel","pluginConfigTab.envVarsLabel"]},
  {"tab":"plugin-config","section":"plugin-config-performance","title":"pluginPerfTab.sectionTitle","labels":["pluginPerfTab.chartLabel","pluginPerfTab.chartAriaLabel"]},
  {"tab":"marketplace","section":"marketplace-maintenance","title":"gitMarketplace.maintenance.title","labels":[]},
  {"tab":"about","section":"about-system-info","title":"generalTab.systemInfoTitle","labels":["generalTab.osLabel","generalTab.appVersionLabel","generalTab.techStackLabel","generalTab.dataPathLabel","generalTab.copyDataPathAriaLabel"]},
  {"tab":"remote-surfaces","section":"remote-messaging-connections","title":"settingsContent.tabRemoteSurfaces","labels":[]},
  {"tab":"usage","section":"usage-summary","title":"usageDashboard.title","labels":[]},
  {"tab":"audit","section":"audit-results","title":"auditTab.resultsTitle","labels":[]},
  {"tab":"mcp","section":"mcp-servers","title":"mcpTab.pageTitle","labels":[]},
  {"tab":"marketplace","section":"marketplace-inventory","title":"gitMarketplace.title","labels":[]},
];

/** Match the visible section title and setting labels in the current locale. */
export function searchSettings(query: string, translate: (key: string) => string): readonly SettingsSearchEntry[] {
  const term = query.trim().toLocaleLowerCase();
  if (!term) return [];
  return SETTINGS_SEARCH_ENTRIES.filter((entry) => [SETTINGS_TAB_LABEL_KEYS[entry.tab], entry.title, ...entry.labels].some((key) => translate(key).toLocaleLowerCase().includes(term)));
}
