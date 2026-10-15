/**
 * The main-area panel commands and their default chords — ONE table.
 *
 * The keydown handler binds off this table and the command palette lists the
 * same rows, so a command and its chord cannot be two different things in two
 * places. Changing a chord is changing its row here; the app has no per-user
 * keymap store yet, so these are the defaults every user gets.
 *
 * The chords follow the terminal tools the owner pointed at: cmux moves a
 * surface between panes with ⌥⌘⇧+arrow, reopens a closed one with ⌘⇧T and
 * jumps to the latest terminal asking for attention with ⌘⇧U; Warp maximizes
 * a pane with ⌘⇧Enter.
 * "⌘" is the platform's primary modifier (Ctrl off macOS).
 */
export type PanelCommandId =
  | "pane.moveLeft"
  | "pane.moveRight"
  | "pane.moveUp"
  | "pane.moveDown"
  | "pane.toggleMaximize"
  | "surface.reopenClosed"
  | "terminal.jumpToUnread";

interface PanelChord {
  /** `KeyboardEvent.key`, compared case-insensitively. */
  key: string;
  /** The platform's primary modifier: ⌘ on macOS, Ctrl elsewhere. */
  primary: boolean;
  shift: boolean;
  alt: boolean;
}

export interface PanelCommand {
  id: PanelCommandId;
  labelKey: string;
  chord: PanelChord;
  /** How the chord reads on macOS, for the palette row. */
  hint: string;
}

export const PANEL_COMMANDS: readonly PanelCommand[] = [
  { id: "pane.moveLeft", labelKey: "mainPanels.command.moveLeft", chord: { key: "ArrowLeft", primary: true, shift: true, alt: true }, hint: "⌥⌘⇧←" },
  { id: "pane.moveRight", labelKey: "mainPanels.command.moveRight", chord: { key: "ArrowRight", primary: true, shift: true, alt: true }, hint: "⌥⌘⇧→" },
  { id: "pane.moveUp", labelKey: "mainPanels.command.moveUp", chord: { key: "ArrowUp", primary: true, shift: true, alt: true }, hint: "⌥⌘⇧↑" },
  { id: "pane.moveDown", labelKey: "mainPanels.command.moveDown", chord: { key: "ArrowDown", primary: true, shift: true, alt: true }, hint: "⌥⌘⇧↓" },
  { id: "pane.toggleMaximize", labelKey: "mainPanels.command.toggleMaximize", chord: { key: "Enter", primary: true, shift: true, alt: false }, hint: "⌘⇧↩" },
  { id: "surface.reopenClosed", labelKey: "mainPanels.command.reopenClosed", chord: { key: "t", primary: true, shift: true, alt: false }, hint: "⌘⇧T" },
  { id: "terminal.jumpToUnread", labelKey: "mainPanels.command.jumpToUnread", chord: { key: "u", primary: true, shift: true, alt: false }, hint: "⌘⇧U" },
];

function matchesPanelChord(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
  chord: PanelChord,
  darwin: boolean,
): boolean {
  const primary = darwin ? event.metaKey : event.ctrlKey;
  // The other of meta/ctrl must be up, or ⌃⌘ chords would match too.
  const other = darwin ? event.ctrlKey : event.metaKey;
  return event.key.toLowerCase() === chord.key.toLowerCase()
    && primary === chord.primary
    && !other
    && event.shiftKey === chord.shift
    && event.altKey === chord.alt;
}

/** The command a keystroke asks for, or null. */
export function panelCommandFor(
  event: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
  darwin: boolean,
): PanelCommandId | null {
  return PANEL_COMMANDS.find((command) => matchesPanelChord(event, command.chord, darwin))?.id ?? null;
}
