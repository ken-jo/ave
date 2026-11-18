// Portions adapted from microsoft/vscode src/vs/base/common/objects.ts @ 6659689e6b03ec062f5b7bcea9850b4c59045807, Copyright (c) Microsoft Corporation, MIT License.
import { customProviderWire } from "../../shared/custom-provider.js";
import { DEFAULT_GLASS_TINT } from "../../shared/appearance-settings.js";
import { FONT_SIZE_SCALE_DEFAULT } from "../../shared/appearance-font.js";

/** Structural comparison preserves array order and ignores object key insertion order. */
export function settingValuesEqual(one: unknown, other: unknown): boolean {
  if (one === other) return true;
  if (one === null || one === undefined || other === null || other === undefined) return false;
  if (typeof one !== typeof other || typeof one !== "object") return false;
  if (Array.isArray(one) !== Array.isArray(other)) return false;
  if (Array.isArray(one) && Array.isArray(other)) {
    return one.length === other.length && one.every((value, index) => settingValuesEqual(value, other[index]));
  }
  const first = one as Record<string, unknown>;
  const second = other as Record<string, unknown>;
  const keys = Object.keys(first).sort();
  return settingValuesEqual(keys, Object.keys(second).sort()) && keys.every((key) => settingValuesEqual(first[key], second[key]));
}

export interface SettingControlDefinition { path: string; label: string }

/** The settings each section owns; the rendered section supplies searchable labels and descriptions. */
export const SECTION_SETTING_CONTROLS: Readonly<Record<string, readonly SettingControlDefinition[]>> = {
  "llm-providers": [{ path: "llm.provider", label: "llmTab.providerConfig" }],
  "llm-compaction": [{ path: "llm.compactionModelSelection", label: "compactionSettings.model" }],
  "llm-fallback": [{ path: "llm.fallbackChain", label: "llmTab.fallbackTitle" }],
  "llm-pricing-overrides": [{ path: "llm.pricingOverrides", label: "llmTab.pricingOverridesTitle" }],
  "llm-model-catalog": [{ path: "llm.modelCatalogRefresh", label: "llmTab.modelCatalogTitle" }],
  "appearance-language": [{ path: "appearance.language", label: "settings.appearance.language.title" }],
  "appearance-theme": [{ path: "appearance.mode", label: "appearanceTab.mode" }, { path: "appearance.darkScheme", label: "appearanceTab.scheme.dark" }, { path: "appearance.lightScheme", label: "appearanceTab.scheme.light" }, { path: "appearance.glassTint", label: "appearanceTab.glassTintLabel" }],
  "appearance-font": [{ path: "appearance.font.family", label: "appearanceTab.fontFamilyLabel" }, { path: "appearance.font.sizeScale", label: "appearanceTab.fontSizeLabel" }],
  "appearance-terminal": [{ path: "appearance.terminalFont.family", label: "appearanceTab.terminalFamily" }, { path: "appearance.terminalFont.size", label: "appearanceTab.terminalSize" }, { path: "appearance.terminalFont.lineHeight", label: "appearanceTab.terminalLineHeight" }, { path: "appearance.terminal.scrollback", label: "appearanceTab.terminalScrollback" }, { path: "appearance.terminal.cursorStyle", label: "appearanceTab.terminalCursor" }, { path: "appearance.terminal.copyOnSelect", label: "appearanceTab.terminalCopyOnSelect" }, { path: "appearance.terminal.optionAsMeta", label: "appearanceTab.terminalOptionAsMeta" }, { path: "appearance.terminal.shell", label: "appearanceTab.terminalShell" }],
  "appearance-zoom": [{ path: "appearance.zoomLevel", label: "appearanceTab.zoom" }],
  "chat-optimization": [{ path: "chat.autoCompact", label: "chatTab.autoCompactLabel" }],
  "chat-documents": [{ path: "documents.openMode", label: "documentSettings.title" }],
  "chat-stream-smoothing": [{ path: "llm.streamSmoothing", label: "chatTab.streamSmoothingTitle" }],
  "chat-processing-display": [{ path: "chat.processingDisplayLevel", label: "chatTab.processingDisplayTitle" }],
  "chat-experimental": [{ path: "features.idlePreferenceRefresh", label: "chatTab.idleRefreshLabel" }, { path: "features.idleMemoryConsolidation", label: "chatTab.idleMemoryConsolidationLabel" }, { path: "features.subAgentAutonomousWake", label: "chatTab.subAgentWakeLabel" }, { path: "chat.subAgentMaxRounds", label: "chatTab.subAgentMaxRoundsLabel" }],
  "chat-privacy": [{ path: "privacy.piiRedactEnabled", label: "privacyTab.piiRedactToggleLabel" }],
  "chat-signals": [{ path: "system.signalTurnFinished", label: "accessibilitySignals.turnFinished" }, { path: "system.signalApprovalNeeded", label: "accessibilitySignals.approvalNeeded" }, { path: "system.signalTurnFailed", label: "accessibilitySignals.turnFailed" }],
  "notifications-delivery": [{ path: "alerts.osNotificationsEnabled", label: "alerts.osMaster" }],
  "web-search-engine": [{ path: "webSearch.provider", label: "webTab.searchEngineTitle" }],
  "web-view-flow": [{ path: "webView.preferredFlow", label: "appearanceTab.webViewSectionTitle" }],
  "startup-shortcut": [{ path: "shortcuts.enabled", label: "startupTab.shortcutEnabledLabel" }, { path: "shortcuts.toggleWindow", label: "startupTab.shortcutAcceleratorLabel" }],
  "startup-launch": [{ path: "system.launchAtStartup", label: "startupTab.launchAtStartupLabel" }, { path: "system.launchMinimized", label: "startupTab.launchMinimizedLabel" }],
  "startup-rendering": [{ path: "system.hardwareAcceleration", label: "startupTab.hardwareAccelerationLabel" }],
  "startup-corp-ca": [{ path: "system.corpCaEnabled", label: "startupTab.corpCaEnabledLabel" }, { path: "system.corpCaCommonName", label: "startupTab.corpCaCommonNameLabel" }, { path: "system.corpCaDebugLog", label: "startupTab.corpCaDebugLabel" }],
  "startup-system-behavior": [{ path: "system.closeBehavior", label: "generalTab.systemBehaviorTitle" }, { path: "system.shutdownCleanupTimeoutMs", label: "startupTab.shutdownTimeoutLabel" }],
  "permissions-os-sandbox": [{ path: "features.osToolSandbox", label: "permissionsTab.osSandboxShellLabel" }, { path: "features.pluginWorkerConfinement", label: "permissionsTab.workerConfinementLabel" }, { path: "features.windowsShellLocalNetworkAccess", label: "permissionsTab.windowsShellLocalNetworkLabel" }],
  "permissions-network": [{ path: "features.shellEgressAsk", label: "permissionsTab.networkTitle" }],
  "permissions-approval-dialog": [{ path: "permissions.ownerAwayAutoSkipMinutes", label: "permissionsTab.ownerAwayAutoSkipLabel" }],
  "permissions-work-board-approvals": [{ path: "workBoard.toolApprovalSurface", label: "workBoard.approvalSurfaceTitle" }],
  "remote-local-api": [{ path: "system.localApiServer", label: "localApiSurfaces.localApiLabel" }, { path: "features.a2aLoopbackServer", label: "localApiSurfaces.a2aLoopbackLabel" }, { path: "features.a2aRemoteRouting", label: "localApiSurfaces.a2aRemoteRoutingLabel" }, { path: "features.a2aRemoteReceiver", label: "localApiSurfaces.a2aRemoteReceiverLabel" }],
  "roles-agents": [{ path: "homeDocs.keepLatest", label: "rolesTab.keepLatestLabel" }],
  "audit-telemetry": [{ path: "telemetry.level", label: "auditTab.telemetryLevelLabel" }],
  "marketplace-maintenance": [{ path: "marketplace.updateCheckEnabled", label: "gitMarketplace.maintenance.updateCheck" }, { path: "marketplace.offlineCacheEnabled", label: "gitMarketplace.maintenance.offlineCache" }],
  "about-updates": [{ path: "updates.autoCheckEnabled", label: "aboutUpdates.autoCheck" }],
};

function settingValueAt(settings: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((value, segment) => value !== null && typeof value === "object" ? (value as Record<string, unknown>)[segment] : undefined, settings);
}

/** Optional stored overrides use their owning policy's effective defaults. */
export function effectiveSettingValue(settings: unknown, path: string): unknown {
  const value = settingValueAt(settings, path);
  if (value !== undefined) return value;
  if (/^llm\.vendors\.[^.]+\.(baseUrl|vertexProject|vertexLocation)$/.test(path)) return "";
  if (/^llm\.vendors\.[^.]+\.wire$/.test(path)) return customProviderWire(undefined);
  if (path === "telemetry.endpoint" || path === "telemetry.crashReportEndpoint") return "";
  if (path === "appearance.glassTint") return DEFAULT_GLASS_TINT;
  if (path === "appearance.font.family") return "system";
  if (path === "appearance.font.sizeScale") return FONT_SIZE_SCALE_DEFAULT;
  return undefined;
}

export function settingPatch(path: string, value: unknown): Record<string, unknown> {
  const segments = path.split(".");
  if (segments.length < 2 || segments.some((part) => !/^[a-zA-Z][a-zA-Z0-9-]*$/.test(part) || ["constructor", "prototype", "__proto__"].includes(part))) throw new Error("Invalid setting id");
  return segments.reduceRight<Record<string, unknown>>((child, part, index) => ({ [part]: index === segments.length - 1 ? value : child }), {});
}
