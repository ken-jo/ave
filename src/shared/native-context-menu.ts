export const NATIVE_CONTEXT_MENU_COMMANDS = [
  "action.open-system",
  "action.copy-url",
  "action.copy-path",
  "workspace.open",
  "workspace.reveal",
  "workspace.copy-path",
  "workspace.copy-relative-path",
  "project.new-chat",
  "project.pin",
  "project.unpin",
  "project.edit",
  "project.reveal",
  "project.archive",
  "project.unarchive",
  "project.add",
  "project.remove",
  "conversation.open",
  "conversation.pin",
  "conversation.unpin",
  "conversation.rename",
  "conversation.mark-unread",
  "conversation.mark-read",
  "conversation.archive",
  "conversation.unarchive",
  "conversation.share",
  "conversation.copy",
  "conversation.delete",
  "conversation.import",
  "message.copy",
  "message.edit",
  "message.fork",
  "message.returnHere",
  "command.activate",
  "command.copy",
  "view.open",
  "view.open-in-new-pane",
] as const;

export type NativeContextMenuCommand = (typeof NATIVE_CONTEXT_MENU_COMMANDS)[number];

export type NativeContextMenuKind =
  | "action-item"
  | "workspace-entry"
  | "project"
  | "conversation"
  | "message"
  | "command-item"
  | "view-row";

export interface NativeContextMenuPayload {
  requestId: string;
  x: number;
  y: number;
  kind: NativeContextMenuKind;
  commands: NativeContextMenuCommand[];
}

export interface NativeContextMenuAction {
  requestId: string;
  command: NativeContextMenuCommand;
}

export const NATIVE_CONTEXT_MENU_COMMANDS_BY_KIND = {
  "action-item": ["action.open-system", "action.copy-url", "action.copy-path"],
  "workspace-entry": [
    "workspace.open",
    "workspace.reveal",
    "workspace.copy-path",
    "workspace.copy-relative-path",
  ],
  // Empty-area commands belong to the list kind because they create items rather than target a row.
  project: [
    "project.new-chat",
    "project.pin",
    "project.unpin",
    "project.edit",
    "project.reveal",
    "project.archive",
    "project.unarchive",
    "project.add",
    "project.remove",
  ],
  conversation: [
    "conversation.open",
    "conversation.pin",
    "conversation.unpin",
    "conversation.rename",
    "conversation.mark-unread",
    "conversation.mark-read",
    "conversation.archive",
    "conversation.unarchive",
    "conversation.share",
    "conversation.copy",
    "conversation.delete",
    "conversation.import",
  ],
  message: ["message.copy", "message.edit", "message.fork", "message.returnHere"],
  "command-item": ["command.activate", "command.copy"],
  // View commands differ by destination; the menu exposes the otherwise hidden modifier shortcut.
  "view-row": ["view.open", "view.open-in-new-pane"],
} as const satisfies Record<NativeContextMenuKind, readonly NativeContextMenuCommand[]>;

/** Renderer-owned rows use opaque IDs; main renders sanitized labels and echoes selection IDs. */
export interface NativeMenuItem {
  /** Opaque to main: echoed back on click and resolved by the renderer. */
  id: string;
  label: string;
  /** macOS draws this under the label; other platforms ignore it. */
  sublabel?: string;
  accelerator?: string;
  enabled?: boolean;
  /** A present value draws a radio item; absence draws a plain command. */
  checked?: boolean;
  submenu?: NativeMenuItem[];
}

interface NativeMenuSection {
  items: NativeMenuItem[];
}

export interface DynamicNativeMenuPayload {
  requestId: string;
  x: number;
  y: number;
  sections: NativeMenuSection[];
}

export interface DynamicNativeMenuAction {
  requestId: string;
  id: string;
}

const NATIVE_MENU_LABEL_MAX = 120;
export const NATIVE_MENU_MAX_DEPTH = 2;
export const NATIVE_MENU_MAX_ITEMS = 400;

/** Untrusted labels must neutralize line separators, bidi controls, and mnemonic markers, then cap visible length. */
export function sanitizeNativeMenuLabel(raw: string): string {
  const flattened = raw.replace(
    /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u202a-\u202e\u2028\u2029\u2066-\u2069]/g,
    " ",
  );
  const collapsed = flattened.replace(/\s+/g, " ").trim();
  // Count code points before escaping ampersands to avoid split surrogates or revived mnemonics.
  const capped = collapsed.length > NATIVE_MENU_LABEL_MAX
    ? `${Array.from(collapsed).slice(0, NATIVE_MENU_LABEL_MAX - 1).join("")}\u2026`
    : collapsed;
  // A doubled ampersand renders literally without binding a mnemonic.
  return capped.replace(/&/g, "&&");
}
