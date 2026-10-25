/** Locations include settings tabs and surface instances, but exclude chat sessions and external marketplace navigation. */
import { Brain, CalendarDays, Globe, KanbanSquare, KeyRound, Repeat2, Terminal, type LucideIcon } from "lucide-react";
import {
  SETTINGS_TAB_LABEL_KEYS,
  normalizeSettingsTab,
  type SettingsTab,
} from "../../../shared/settings-tabs.js";
import { parseViewKey, type BuiltinViewKey, type InlineViewKey } from "../../../shared/view-key.js";
import type { TranslateFn } from "../../../i18n/translate.js";
import type { ProjectIdentity } from "../../../shared/project-identity.js";

export interface ViewLocation {
  view: InlineViewKey;
  /** Only meaningful when `view === "settings"`; absent everywhere else. */
  settingsTab?: SettingsTab;
  /** Only meaningful for an instance view (`terminal`, `web`): the surface (tab) id it shows. Two panes may each show a
   * terminal, but never the same one — the one-pane-per-location rule compares this too. */
  surface?: string;
}

/**
 * Build a location from the two pieces of app state that carry it, dropping
 * the settings tab when it cannot apply. Without that drop, leaving Settings
 * and coming back would compare unequal against an otherwise identical
 * location and push a duplicate history entry.
 */
export function toViewLocation(view: InlineViewKey, settingsTab: string): ViewLocation {
  return view === "settings"
    ? { view, settingsTab: normalizeSettingsTab(settingsTab) }
    : { view };
}

export function sameViewLocation(a: ViewLocation, b: ViewLocation): boolean {
  return a.view === b.view && a.settingsTab === b.settingsTab && a.surface === b.surface;
}

/** One crumb. `target` is absent on the last one — you cannot navigate to where you already are, so it renders as text
 * rather than a control. */
export interface BreadcrumbSegment {
  key: string;
  label: string;
  target?: ViewLocation;
}

export interface BreadcrumbDeps {
  t: TranslateFn;
  /** Resolves a plugin view key to its display title. */
  pluginViewLabel: (viewKey: string) => string | undefined;
  /**
   * The project the current conversation belongs to, or absent for a plain
   * conversation. The same fact the sidebar sorts sessions by: a session
   * whose project is the workspace default is a plain chat, so callers pass
   * only a NAMED project here.
   */
  sessionProject?: Pick<ProjectIdentity, "projectName">;
}

/**
 * The path for a location, deepest last.
 *
 * Every label comes from an existing catalogue key — the sidebar's own labels
 * for built-ins, `SETTINGS_TAB_LABEL_KEYS` for settings pages (the same map
 * the settings panel labels its nav with), and the plugin's declared title.
 * Nothing here invents a name for a place, so the path cannot describe a
 * destination differently from the control that reaches it.
 */
export function viewLocationBreadcrumb(
  location: ViewLocation,
  deps: BreadcrumbDeps,
): BreadcrumbSegment[] {
  const { t } = deps;

  if (location.view === "settings") {
    const tab = location.settingsTab ?? "llm";
    return [
      { key: "settings", label: t(BUILTIN_LABEL_KEYS.settings), target: { view: "settings", settingsTab: "llm" } },
      { key: `settings:${tab}`, label: t(SETTINGS_TAB_LABEL_KEYS[tab]) },
    ];
  }

  const parsed = parseViewKey(location.view);
  if (parsed?.kind === "plugin") {
    return [
      { key: "plugins", label: t("sidebar.pluginsLabel") },
      {
        key: location.view,
        // Fall back to the plugin id when the view list has not loaded yet: a raw id is honest, an empty crumb is not.
        label: deps.pluginViewLabel(location.view) ?? parsed.pluginId,
      },
    ];
  }

  if (location.view === "home") {
    // There is no "home": the conversation surface is either the plain conversations list or a project, the two tabs the
    // sidebar already names. Neither crumb carries a target — this IS where the user is.
    const project = deps.sessionProject;
    return project
      ? [
        { key: "projects", label: t("sidebar.projectsTab") },
        { key: "home", label: project.projectName },
      ]
      : [{ key: "home", label: t("sidebar.chatsTab") }];
  }

  // Settings, plugins and home returned above; what is left is a built-in.
  return [{ key: location.view, label: t(BUILTIN_LABEL_KEYS[location.view as keyof typeof BUILTIN_LABEL_KEYS]) }];
}

/**
 * A built-in view that is a PLACE of its own — everything but the conversation
 * surface, which is the pane's other kind of content and is named by the
 * session it holds rather than by a view. These are the views that become a
 * pane body with the frame's header carrying their name.
 */
export type PaneViewKey = Exclude<BuiltinViewKey, "home">;

/** Built-in view → the label its own sidebar entry already uses. Reused rather than restated so a renamed destination
 * cannot be one thing in the rail, a second in the path, and a third in the pane header that carries it. */
export const BUILTIN_LABEL_KEYS: Record<PaneViewKey, string> = {
  settings: "mainToolbar.settings",
  "work-board": "mainToolbar.workBoard",
  routines: "mainToolbar.routines",
  insights: "mainToolbar.insights",
  starred: "mainToolbar.insights",
  memory: "mainToolbar.memory",
  terminal: "chatPreviewRail.tab.terminal",
  web: "chatPreviewRail.tab.browser",
};

/** Sidebar and pane headers share one glyph map; routable views still need a glyph even when absent from the sidebar. */
export const BUILTIN_VIEW_ICONS: Record<PaneViewKey, LucideIcon> = {
  settings: KeyRound,
  "work-board": KanbanSquare,
  routines: Repeat2,
  insights: CalendarDays,
  starred: CalendarDays,
  memory: Brain,
  terminal: Terminal,
  web: Globe,
};
