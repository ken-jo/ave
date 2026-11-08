/** The panel commands the palette lists and the app-wide key handler binds; their keys live in the shortcut registry. */
import {
  matchesResolvedShortcut,
  shortcutDefinition,
  type ShortcutKeyEvent,
  type ShortcutPlatform,
  type ShortcutResolutionInput,
} from "../../../shared/shortcuts.js";
import { getShortcutSettings, isShortcutCaptureActive } from "../hooks/use-shortcuts.js";

const PANEL_COMMAND_IDS = [
  "project.openHome",
  "sidebar.toggleVisibility",
  "pane.moveLeft",
  "pane.moveRight",
  "pane.moveUp",
  "pane.moveDown",
  "pane.toggleMaximize",
  "surface.reopenClosed",
  "terminal.jumpToUnread",
] as const;

export type PanelCommandId = (typeof PANEL_COMMAND_IDS)[number];

export interface PanelCommand {
  id: PanelCommandId;
  labelKey: string;
}

export const PANEL_COMMANDS: readonly PanelCommand[] = PANEL_COMMAND_IDS.map((id) => ({ id, labelKey: shortcutDefinition(id).labelKey }));

/** The command a keystroke asks for, or null. */
export function panelCommandFor(
  event: ShortcutKeyEvent,
  darwin: boolean,
  input: ShortcutResolutionInput = getShortcutSettings(),
): PanelCommandId | null {
  if (isShortcutCaptureActive()) return null;
  const platform: ShortcutPlatform = darwin ? "darwin" : "other";
  return PANEL_COMMAND_IDS.find((id) => matchesResolvedShortcut(id, event, input, platform)) ?? null;
}
