import { Activity, Bot, Folder, Globe, MessageSquare, Table, Terminal, type LucideIcon } from "lucide-react";
import { getPluginViewLabel, toViewKey } from "../api-client.js";
import { t } from "../../../i18n/runtime.js";
import type { WorkspaceTabKind } from "../preview/workspace-tabs.js";
import type { PluginUiExtension } from "../types.js";
import type { InstanceViewKey } from "../../../shared/view-key.js";
import type { ShortcutId } from "../../../shared/shortcuts.js";

export interface QuickAction {
  id: string;
  label: string;
  run: () => void | Promise<void>;
}

/**
 * The workspace-rail launcher (§6.10.3): each `WorkspaceTabKind` with its label, icon and the registry shortcut that
 * opens it. The empty-state launcher and the tab-bar "+" menu render one row per entry and the panel's key handler binds
 * off the same table. Order here is the render order in the launcher.
 */
export interface WorkspaceLauncherItem {
  kind: WorkspaceTabKind;
  labelKey: string;
  /** The registry row that opens this kind, or null when no key is bound. */
  shortcutId: ShortcutId | null;
  icon: LucideIcon;
}

export const WORKSPACE_TAB_LAUNCHER: readonly WorkspaceLauncherItem[] = [
  { kind: "preview", labelKey: "chatPreviewRail.launcher.review", shortcutId: "workspace.openReview", icon: Table },
  { kind: "terminal", labelKey: "chatPreviewRail.launcher.terminal", shortcutId: null, icon: Terminal },
  { kind: "browser", labelKey: "chatPreviewRail.launcher.browser", shortcutId: "workspace.openBrowser", icon: Globe },
  { kind: "file-browser", labelKey: "chatPreviewRail.launcher.file", shortcutId: "workspace.openFile", icon: Folder },
  { kind: "subagent", labelKey: "chatPreviewRail.launcher.subagent", shortcutId: "workspace.openSubagent", icon: Bot },
  { kind: "activity", labelKey: "chatPreviewRail.launcher.activity", shortcutId: null, icon: Activity },
  { kind: "side-chat", labelKey: "chatPreviewRail.launcher.sideChat", shortcutId: "workspace.openSideChat", icon: MessageSquare },
];

/** Build the default quick-action list from app state. Kept separate from SlashPicker so App can build the actions without
 * pulling the picker — and its menu bridge — into the startup path. */
export function buildQuickActions({
  setActiveView,
  openSettings,
  handleNewChat,
  openNewSurface,
  pluginViews,
  locale,
}: {
  setActiveView: (key: string) => void;
  openSettings: () => void;
  handleNewChat: () => void | Promise<void>;
  /** Open a NEW terminal or web page in the focused pane. */
  openNewSurface: (view: InstanceViewKey) => void;
  pluginViews: PluginUiExtension[];
  /** The UI language plugin labels resolve against. */
  locale: string;
}): QuickAction[] {
  return [
    { id: "home",       label: t("commandActions.goHome"),        run: () => setActiveView("home") },
    { id: "work-board", label: t("commandActions.viewWorkBoard"), run: () => setActiveView("work-board") },
    { id: "routines",   label: t("commandActions.viewRoutines"),  run: () => setActiveView("routines") },
    { id: "settings",  label: t("commandActions.openSettings"), run: openSettings },
    { id: "new-chat",  label: t("commandActions.newChat"),      run: handleNewChat },
    { id: "new-terminal-panel", label: t("mainPanels.newTerminalPanel"), run: () => openNewSurface("terminal") },
    { id: "new-web-panel",      label: t("mainPanels.newWebPanel"),      run: () => openNewSurface("web") },
    ...pluginViews.map((i) => {
      const viewKey = toViewKey(i);
      const pluginLabel = getPluginViewLabel(i, locale);
      return {
        id: `v:${viewKey}`,
        label: t("commandActions.openPlugin", { pluginLabel }),
        run: () => setActiveView(viewKey),
      };
    }),
  ];
}
