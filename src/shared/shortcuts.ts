/** The keyboard shortcut registry and its accelerator grammar, shared by the main process (menu accelerators, the global
 * shortcut, settings validation) and the renderer (key handlers, hints, the settings page). Every binding Ave defines is a
 * row here; consumers read the binding by id instead of spelling the keys themselves. Runtime registration remains
 * authoritative for whether an OS-global accelerator actually binds. */

export interface ShortcutSettings {
  /** A null accelerator registers nothing even when enabled. */
  toggleWindow: string | null;
  enabled: boolean;
  /** The user's rebinds of registry rows: only rows that differ from their platform default are stored. */
  bindings: ShortcutBindings;
}

export interface ShortcutSettingsPatch {
  toggleWindow?: string | null;
  enabled?: boolean;
  /** Per row: an accelerator rebinds it, `null` resets it to its default. Rows left out keep their binding. */
  bindings?: Readonly<Record<string, string | null>>;
}

const MAX_ACCELERATOR_LEN = 128;

/** Reject ASCII controls; accelerators contain printable modifier/key tokens joined by plus signs. */
function hasControlChars(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const code = s.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** A lone modifier cannot bind. */
const MODIFIERS: ReadonlySet<string> = new Set([
  "command", "cmd", "control", "ctrl", "commandorcontrol", "cmdorctrl",
  "alt", "option", "altgr", "shift", "super", "meta",
]);

/** Reject malformed shape before persistence, keeping the prior value; this superset check does not prove runtime bindability. */
export function normalizeAccelerator(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const trimmed = input.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_ACCELERATOR_LEN) return null;
  if (hasControlChars(trimmed)) return null;
  const parts = trimmed.split("+").map((p) => p.trim());
  if (parts.some((p) => p.length === 0)) return null;
  const key = parts[parts.length - 1];
  if (MODIFIERS.has(key.toLowerCase())) return null;
  return trimmed;
}

/** `onDroppedBindings` hears every stored rebind the load gate discarded, so the store can log what it lost. */
export function normalizeShortcuts(
  input: unknown,
  fallback: ShortcutSettings,
  platform: ShortcutPlatform,
  onDroppedBindings: (dropped: readonly DroppedShortcutBinding[]) => void,
): ShortcutSettings {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { ...fallback, bindings: { ...fallback.bindings } };
  }
  const obj = input as { toggleWindow?: unknown; enabled?: unknown; bindings?: unknown };
  const loaded = loadShortcutBindings(obj.bindings, platform);
  if (loaded.dropped.length > 0) onDroppedBindings(loaded.dropped);
  const result: ShortcutSettings = { ...fallback, bindings: loaded.bindings };
  if (obj.toggleWindow === null) {
    result.toggleWindow = null;
  } else if (obj.toggleWindow !== undefined) {
    const accel = normalizeAccelerator(obj.toggleWindow);
    if (accel !== null) result.toggleWindow = accel;
  }
  if (typeof obj.enabled === "boolean") {
    result.enabled = obj.enabled;
  }
  return result;
}

// ── Accelerator grammar ─────────────────────────────────────────────────────────────────────────────────────────────

/** `darwin` resolves CommandOrControl to ⌘; every other platform resolves it to Ctrl. */
export type ShortcutPlatform = "darwin" | "other";

export function shortcutPlatformOf(platform: string): ShortcutPlatform {
  return platform === "darwin" ? "darwin" : "other";
}

interface ParsedAccelerator {
  commandOrControl: boolean;
  command: boolean;
  control: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

const MODIFIER_ALIASES: Readonly<Record<string, "commandOrControl" | "command" | "control" | "alt" | "shift">> = {
  commandorcontrol: "commandOrControl",
  cmdorctrl: "commandOrControl",
  command: "command",
  cmd: "command",
  super: "command",
  meta: "command",
  control: "control",
  ctrl: "control",
  alt: "alt",
  option: "alt",
  shift: "shift",
};

const NAMED_KEYS = [
  "Enter", "Tab", "Space", "Esc", "Backspace", "Delete", "Up", "Down", "Left", "Right",
  "Home", "End", "PageUp", "PageDown", "Plus",
] as const;
const NAMED_KEY_ALIASES: Readonly<Record<string, string>> = {
  ...Object.fromEntries(NAMED_KEYS.map((name) => [name.toLowerCase(), name])),
  return: "Enter",
  escape: "Esc",
};
const PUNCTUATION_KEYS: ReadonlySet<string> = new Set(["[", "]", ",", ".", "/", ";", "'", "`", "\\", "-", "="]);

/** Canonical key token, or null when the token is not one Ave can bind. */
function canonicalKeyToken(token: string): string | null {
  if (/^[a-z0-9]$/i.test(token)) return token.toUpperCase();
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(token)) return token.toUpperCase();
  if (PUNCTUATION_KEYS.has(token)) return token;
  return NAMED_KEY_ALIASES[token.toLowerCase()] ?? null;
}

function parseAccelerator(input: unknown): ParsedAccelerator | null {
  const shape = normalizeAccelerator(input);
  if (shape === null) return null;
  const parts = shape.split("+").map((part) => part.trim());
  const parsed: ParsedAccelerator = { commandOrControl: false, command: false, control: false, alt: false, shift: false, key: "" };
  for (const part of parts.slice(0, -1)) {
    const modifier = MODIFIER_ALIASES[part.toLowerCase()];
    if (!modifier || parsed[modifier]) return null;
    parsed[modifier] = true;
  }
  const key = canonicalKeyToken(parts[parts.length - 1]);
  if (key === null) return null;
  parsed.key = key;
  return parsed;
}

/** One spelling per accelerator, so stored bindings compare by string. Null for anything Ave cannot bind. */
export function canonicalAccelerator(input: unknown): string | null {
  const parsed = parseAccelerator(input);
  if (!parsed) return null;
  const parts: string[] = [];
  if (parsed.commandOrControl) parts.push("CommandOrControl");
  if (parsed.command) parts.push("Command");
  if (parsed.control) parts.push("Control");
  if (parsed.alt) parts.push("Alt");
  if (parsed.shift) parts.push("Shift");
  parts.push(parsed.key);
  return parts.join("+");
}

/** The physical chord an accelerator means on one platform. */
interface ResolvedChord {
  meta: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

function resolveChord(parsed: ParsedAccelerator, platform: ShortcutPlatform): ResolvedChord {
  return platform === "darwin"
    ? { meta: parsed.commandOrControl || parsed.command, ctrl: parsed.control, alt: parsed.alt, shift: parsed.shift, key: parsed.key }
    : { meta: parsed.command, ctrl: parsed.commandOrControl || parsed.control, alt: parsed.alt, shift: parsed.shift, key: parsed.key };
}

/** Equal for two accelerators that press the same keys on `platform` (`CommandOrControl+K` and `Command+K` on macOS). */
export function chordSignature(accelerator: string, platform: ShortcutPlatform): string | null {
  const parsed = parseAccelerator(accelerator);
  if (!parsed) return null;
  const chord = resolveChord(parsed, platform);
  return `${chord.meta ? "M" : ""}${chord.ctrl ? "C" : ""}${chord.alt ? "A" : ""}${chord.shift ? "S" : ""}+${chord.key}`;
}

/** Minimal shape of the fields read from a key event; DOM and React events both fit. `code` is optional so a test can
 * build an event from `key` alone. */
export interface ShortcutKeyEvent {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const CODE_PUNCTUATION: Readonly<Record<string, string>> = {
  BracketLeft: "[", BracketRight: "]", Comma: ",", Period: ".", Slash: "/", Semicolon: ";",
  Quote: "'", Backquote: "`", Backslash: "\\", Minus: "-", Equal: "=",
};

const MODIFIER_KEY_NAMES: ReadonlySet<string> = new Set(["Control", "Shift", "Alt", "Meta", "OS", "AltGraph", "CapsLock", "Fn", "Hyper", "Super"]);

/** The key token an event pressed. The layout's printed key wins, as in native menu accelerators and VS Code: ⌘A on
 * AZERTY is the key printed A, and ⌘K on Dvorak is the key printed K. The physical `code` is the fallback only when the
 * printed key is not a bindable ASCII token: Option turning ⌥S into "ß", a Hangul input source reporting a jamo, a dead
 * key, or Shift turning 1 into "!". */
function eventKeyToken(event: ShortcutKeyEvent): string | null {
  const key = event.key;
  if (key === " " || key === "Spacebar") return "Space";
  if (key === "ArrowUp") return "Up";
  if (key === "ArrowDown") return "Down";
  if (key === "ArrowLeft") return "Left";
  if (key === "ArrowRight") return "Right";
  if (key === "+") return "Plus";
  // ⌘⇧? is written Shift+/ in accelerators; "?" names it on every layout, wherever the layout puts it.
  if (key === "?") return "/";
  const printed = canonicalKeyToken(key);
  if (printed !== null) return printed;
  const code = event.code ?? "";
  const letter = /^Key([A-Z])$/.exec(code);
  if (letter) return letter[1];
  const digit = /^Digit([0-9])$/.exec(code);
  if (digit) return digit[1];
  return CODE_PUNCTUATION[code] ?? null;
}

/** Does `event` press exactly `accelerator` on `platform`? Every modifier must match, so ⌃⌘K is not ⌘K. */
export function matchesAccelerator(accelerator: string | null, event: ShortcutKeyEvent, platform: ShortcutPlatform): boolean {
  if (accelerator === null) return false;
  const parsed = parseAccelerator(accelerator);
  if (!parsed) return false;
  const chord = resolveChord(parsed, platform);
  return eventKeyToken(event) === chord.key
    && event.metaKey === chord.meta
    && event.ctrlKey === chord.ctrl
    && event.altKey === chord.alt
    && event.shiftKey === chord.shift;
}

export type RecordedAccelerator =
  | { kind: "pending" }
  | { kind: "unsupported" }
  | { kind: "accelerator"; accelerator: string };

/** Build an accelerator from a pressed chord. ⌘ is stored as CommandOrControl so a binding made on a Mac means Ctrl
 * elsewhere; ⌃ on a Mac stays Control. Off macOS the Windows/Super key is recorded as Command so the reserved-key check
 * can name it. */
export function acceleratorFromEvent(event: ShortcutKeyEvent, platform: ShortcutPlatform): RecordedAccelerator {
  if (MODIFIER_KEY_NAMES.has(event.key)) return { kind: "pending" };
  const key = eventKeyToken(event);
  if (key === null) return { kind: "unsupported" };
  const parts: string[] = [];
  if (platform === "darwin") {
    if (event.metaKey) parts.push("CommandOrControl");
    if (event.ctrlKey) parts.push("Control");
  } else {
    if (event.ctrlKey) parts.push("CommandOrControl");
    if (event.metaKey) parts.push("Command");
  }
  if (event.altKey) parts.push("Alt");
  if (event.shiftKey) parts.push("Shift");
  parts.push(key);
  return { kind: "accelerator", accelerator: parts.join("+") };
}

const DARWIN_KEY_GLYPHS: Readonly<Record<string, string>> = {
  Enter: "↩", Tab: "⇥", Esc: "⎋", Backspace: "⌫", Delete: "⌦", Up: "↑", Down: "↓", Left: "←", Right: "→",
  PageUp: "⇞", PageDown: "⇟", Home: "↖", End: "↘", Plus: "+",
};
const OTHER_KEY_LABELS: Readonly<Record<string, string>> = {
  Up: "↑", Down: "↓", Left: "←", Right: "→", Plus: "+",
};

/** The keycaps of an accelerator in the platform's own vocabulary: ⌃ ⌥ ⇧ ⌘ glyphs on macOS, Ctrl/Alt/Shift/Win words
 * elsewhere. Throws on a malformed accelerator: every caller formats a binding the registry or the store already
 * validated. */
export function acceleratorKeycaps(accelerator: string, platform: ShortcutPlatform): string[] {
  const parsed = parseAccelerator(accelerator);
  if (!parsed) throw new Error(`Malformed shortcut accelerator: ${JSON.stringify(accelerator)}`);
  const chord = resolveChord(parsed, platform);
  const caps: string[] = [];
  if (platform === "darwin") {
    if (chord.ctrl) caps.push("⌃");
    if (chord.alt) caps.push("⌥");
    if (chord.shift) caps.push("⇧");
    if (chord.meta) caps.push("⌘");
    caps.push(DARWIN_KEY_GLYPHS[chord.key] ?? chord.key);
    return caps;
  }
  if (chord.ctrl) caps.push("Ctrl");
  if (chord.alt) caps.push("Alt");
  if (chord.shift) caps.push("Shift");
  if (chord.meta) caps.push("Win");
  caps.push(OTHER_KEY_LABELS[chord.key] ?? chord.key);
  return caps;
}

/** One-line form for tooltips and palette rows: "⌥⌘S" on macOS, "Ctrl+Alt+S" elsewhere. */
export function formatAccelerator(accelerator: string, platform: ShortcutPlatform): string {
  return acceleratorKeycaps(accelerator, platform).join(platform === "darwin" ? "" : "+");
}

// ── Registry ────────────────────────────────────────────────────────────────────────────────────────────────────────

/** Where a shortcut is listened for. `app` fires anywhere in the window, `menu` is a native menu accelerator, `system` is
 * OS-wide; those three overlap every other scope. The rest fire only while their surface has focus. */
export const SHORTCUT_SCOPES = ["app", "menu", "workspace", "composer", "lists", "system"] as const;
export type ShortcutScope = (typeof SHORTCUT_SCOPES)[number];

const WINDOW_WIDE_SCOPES: ReadonlySet<ShortcutScope> = new Set(["app", "menu", "system"]);

export const SHORTCUT_SCOPE_LABEL_KEYS: Record<ShortcutScope, string> = {
  app: "shortcutsTab.scope.app",
  menu: "shortcutsTab.scope.menu",
  workspace: "shortcutsTab.scope.workspace",
  composer: "shortcutsTab.scope.composer",
  lists: "shortcutsTab.scope.lists",
  system: "shortcutsTab.scope.system",
};

interface ShortcutDefinitionBase {
  id: string;
  scope: ShortcutScope;
  labelKey: string;
  /** Who acts on the key: a renderer listener, a native menu item, or the OS (Electron roles, the global shortcut). */
  handledBy: "renderer" | "menu" | "os";
}

/** A row with keys of its own. `null` on a platform means the row does not exist there. Without `readOnly` the user can
 * rebind it. */
interface KeyedShortcut extends ShortcutDefinitionBase {
  defaults: { darwin: string | null; other: string | null };
  readOnly?: { reasonKey: string };
  layeredOn?: undefined;
}

/** A second meaning of another row's key in a narrower context; it always follows that row's binding. */
interface LayeredShortcut extends ShortcutDefinitionBase {
  defaults?: undefined;
  readOnly: { reasonKey: string };
  layeredOn: string;
}

export type ShortcutDefinition = KeyedShortcut | LayeredShortcut;

const both = (accelerator: string) => ({ darwin: accelerator, other: accelerator });
const EDIT = { reasonKey: "shortcutsTab.readOnly.edit" } as const;
const TYPING = { reasonKey: "shortcutsTab.readOnly.typing" } as const;
const LIST = { reasonKey: "shortcutsTab.readOnly.list" } as const;
const APPROVAL = { reasonKey: "shortcutsTab.readOnly.approval" } as const;

export const SHORTCUTS = [
  // App-wide (renderer)
  { id: "app.commandPalette", scope: "app", handledBy: "renderer", labelKey: "shortcuts.label.commandPalette", defaults: both("CommandOrControl+K") },
  { id: "app.search", scope: "app", handledBy: "renderer", labelKey: "shortcuts.label.search", defaults: both("CommandOrControl+F") },
  // ⌘[ / ⌘] on macOS, where Option-arrow is word-wise caret movement in text fields.
  { id: "app.viewBack", scope: "app", handledBy: "renderer", labelKey: "shortcuts.label.viewBack", defaults: { darwin: "CommandOrControl+[", other: "Alt+Left" } },
  { id: "app.viewForward", scope: "app", handledBy: "renderer", labelKey: "shortcuts.label.viewForward", defaults: { darwin: "CommandOrControl+]", other: "Alt+Right" } },
  { id: "project.openHome", scope: "app", handledBy: "renderer", labelKey: "mainToolbar.projectHome", defaults: both("CommandOrControl+0") },
  { id: "sidebar.toggleVisibility", scope: "app", handledBy: "renderer", labelKey: "mainToolbar.toggleSidebar", defaults: both("CommandOrControl+Shift+B") },
  { id: "pane.moveLeft", scope: "app", handledBy: "renderer", labelKey: "mainPanels.command.moveLeft", defaults: both("CommandOrControl+Alt+Shift+Left") },
  { id: "pane.moveRight", scope: "app", handledBy: "renderer", labelKey: "mainPanels.command.moveRight", defaults: both("CommandOrControl+Alt+Shift+Right") },
  { id: "pane.moveUp", scope: "app", handledBy: "renderer", labelKey: "mainPanels.command.moveUp", defaults: both("CommandOrControl+Alt+Shift+Up") },
  { id: "pane.moveDown", scope: "app", handledBy: "renderer", labelKey: "mainPanels.command.moveDown", defaults: both("CommandOrControl+Alt+Shift+Down") },
  { id: "pane.toggleMaximize", scope: "app", handledBy: "renderer", labelKey: "mainPanels.command.toggleMaximize", defaults: both("CommandOrControl+Shift+Enter") },
  { id: "surface.reopenClosed", scope: "app", handledBy: "renderer", labelKey: "mainPanels.command.reopenClosed", defaults: both("CommandOrControl+Shift+T") },
  { id: "terminal.jumpToUnread", scope: "app", handledBy: "renderer", labelKey: "mainPanels.command.jumpToUnread", defaults: both("CommandOrControl+Shift+U") },
  { id: "app.startTour", scope: "app", handledBy: "renderer", labelKey: "shortcuts.label.startTour", defaults: both("CommandOrControl+Shift+/") },
  { id: "app.devTools", scope: "app", handledBy: "renderer", labelKey: "shortcuts.label.devTools", defaults: both("CommandOrControl+Shift+D"), readOnly: { reasonKey: "shortcutsTab.readOnly.devOnly" } },
  { id: "chat.stopWithCopyKey", scope: "app", handledBy: "renderer", labelKey: "shortcuts.label.stopWithCopyKey", defaults: both("CommandOrControl+C"), readOnly: { reasonKey: "shortcutsTab.readOnly.copyKey" } },
  // Terminal habit on a Mac: ⌃C stops too.
  { id: "chat.stopWithControlC", scope: "app", handledBy: "renderer", labelKey: "shortcuts.label.stopWithCopyKey", defaults: { darwin: "Control+C", other: null }, readOnly: { reasonKey: "shortcutsTab.readOnly.copyKey" } },

  // Native menu
  { id: "menu.settings", scope: "menu", handledBy: "menu", labelKey: "shortcuts.label.openSettings", defaults: both("CommandOrControl+,") },
  { id: "menu.newWindow", scope: "menu", handledBy: "menu", labelKey: "be_main.menuNewWindow", defaults: both("CommandOrControl+Shift+N") },
  // Electron role items: their keys are the platform's standard editing keys.
  { id: "edit.undo", scope: "menu", handledBy: "os", labelKey: "be_main.menuUndo", defaults: both("CommandOrControl+Z"), readOnly: EDIT },
  { id: "edit.redo", scope: "menu", handledBy: "os", labelKey: "be_main.menuRedo", defaults: { darwin: "CommandOrControl+Shift+Z", other: "CommandOrControl+Y" }, readOnly: EDIT },
  { id: "edit.cut", scope: "menu", handledBy: "os", labelKey: "be_main.menuCut", defaults: both("CommandOrControl+X"), readOnly: EDIT },
  { id: "edit.copy", scope: "menu", handledBy: "os", labelKey: "be_main.menuCopy", defaults: both("CommandOrControl+C"), readOnly: EDIT },
  { id: "edit.paste", scope: "menu", handledBy: "os", labelKey: "be_main.menuPaste", defaults: both("CommandOrControl+V"), readOnly: EDIT },
  { id: "edit.pasteAndMatchStyle", scope: "menu", handledBy: "os", labelKey: "be_main.menuPasteAndMatchStyle", defaults: { darwin: "CommandOrControl+Alt+Shift+V", other: "CommandOrControl+Shift+V" }, readOnly: EDIT },
  { id: "edit.selectAll", scope: "menu", handledBy: "os", labelKey: "be_main.menuSelectAll", defaults: both("CommandOrControl+A"), readOnly: EDIT },
  { id: "window.reload", scope: "menu", handledBy: "os", labelKey: "shortcuts.label.reload", defaults: both("CommandOrControl+R"), readOnly: EDIT },
  { id: "app.quit", scope: "menu", handledBy: "os", labelKey: "shortcuts.label.quit", defaults: { darwin: "CommandOrControl+Q", other: null }, readOnly: EDIT },

  // Workspace rail (not while typing in a field)
  { id: "workspace.openReview", scope: "workspace", handledBy: "renderer", labelKey: "chatPreviewRail.launcher.review", defaults: both("Control+Shift+G") },
  { id: "workspace.openBrowser", scope: "workspace", handledBy: "renderer", labelKey: "chatPreviewRail.launcher.browser", defaults: both("CommandOrControl+T") },
  { id: "workspace.openFile", scope: "workspace", handledBy: "renderer", labelKey: "chatPreviewRail.launcher.file", defaults: both("CommandOrControl+P") },
  { id: "workspace.openSubagent", scope: "workspace", handledBy: "renderer", labelKey: "chatPreviewRail.launcher.subagent", defaults: both("CommandOrControl+Shift+A") },
  { id: "workspace.openSideChat", scope: "workspace", handledBy: "renderer", labelKey: "chatPreviewRail.launcher.sideChat", defaults: both("CommandOrControl+Alt+S") },
  { id: "workspace.addFolder", scope: "workspace", handledBy: "renderer", labelKey: "shortcuts.label.addFolder", defaults: both("CommandOrControl+O") },

  // Composer (while the message box has focus)
  { id: "composer.sendNow", scope: "composer", handledBy: "renderer", labelKey: "shortcuts.label.sendNow", defaults: both("CommandOrControl+Enter") },
  { id: "composer.backgroundCommand", scope: "composer", handledBy: "renderer", labelKey: "shortcuts.label.backgroundCommand", defaults: both("Control+B") },
  { id: "composer.guide", scope: "composer", handledBy: "renderer", labelKey: "shortcuts.label.guide", layeredOn: "app.commandPalette", readOnly: { reasonKey: "shortcutsTab.readOnly.layeredPalette" } },
  { id: "composer.send", scope: "composer", handledBy: "renderer", labelKey: "shortcuts.label.send", defaults: both("Enter"), readOnly: TYPING },
  { id: "composer.newline", scope: "composer", handledBy: "renderer", labelKey: "shortcuts.label.newline", defaults: both("Shift+Enter"), readOnly: TYPING },
  { id: "composer.stop", scope: "composer", handledBy: "renderer", labelKey: "shortcuts.label.stop", defaults: both("Esc"), readOnly: TYPING },
  { id: "composer.plainPaste", scope: "composer", handledBy: "renderer", labelKey: "shortcuts.label.plainPaste", defaults: both("CommandOrControl+Shift+V"), readOnly: { reasonKey: "shortcutsTab.readOnly.plainPaste" } },

  // Focused lists and cards
  { id: "queue.moveUp", scope: "lists", handledBy: "renderer", labelKey: "shortcuts.label.queueMoveUp", defaults: both("Alt+Up"), readOnly: LIST },
  { id: "queue.moveDown", scope: "lists", handledBy: "renderer", labelKey: "shortcuts.label.queueMoveDown", defaults: both("Alt+Down"), readOnly: LIST },
  { id: "tree.open", scope: "lists", handledBy: "renderer", labelKey: "sidebar.treeOpen", defaults: both("Enter"), readOnly: LIST },
  { id: "tree.openBeside", scope: "lists", handledBy: "renderer", labelKey: "sidebar.openInSplit", defaults: both("Alt+Enter"), readOnly: LIST },
  { id: "approval.allow", scope: "lists", handledBy: "renderer", labelKey: "shortcuts.label.approvalAllow", defaults: both("A"), readOnly: APPROVAL },
  { id: "approval.deny", scope: "lists", handledBy: "renderer", labelKey: "shortcuts.label.approvalDeny", defaults: both("D"), readOnly: APPROVAL },

  // OS-wide: its key is the user's own choice under Startup, so it has no default here.
  { id: "system.toggleWindow", scope: "system", handledBy: "os", labelKey: "shortcuts.label.toggleWindow", defaults: { darwin: null, other: null }, readOnly: { reasonKey: "shortcutsTab.readOnly.global" } },
] as const satisfies readonly ShortcutDefinition[];

export type ShortcutId = (typeof SHORTCUTS)[number]["id"];

/** The user's rebinds, keyed by shortcut id: only rows that differ from their platform default. */
export type ShortcutBindings = Partial<Record<ShortcutId, string>>;

const SHORTCUT_BY_ID: ReadonlyMap<string, ShortcutDefinition> = new Map(SHORTCUTS.map((entry) => [entry.id, entry as ShortcutDefinition]));

export function isShortcutId(id: unknown): id is ShortcutId {
  return typeof id === "string" && SHORTCUT_BY_ID.has(id);
}

export function shortcutDefinition(id: ShortcutId): ShortcutDefinition {
  const entry = SHORTCUT_BY_ID.get(id);
  if (!entry) throw new Error(`Unknown shortcut id: ${id}`);
  return entry;
}

export function isRebindableShortcut(id: ShortcutId): boolean {
  return shortcutDefinition(id).readOnly === undefined;
}

/** A row's platform default; a layered row reports the default of the row it follows. */
export function defaultAccelerator(id: ShortcutId, platform: ShortcutPlatform): string | null {
  const entry = shortcutDefinition(id);
  if (entry.layeredOn !== undefined) return defaultAccelerator(entry.layeredOn as ShortcutId, platform);
  return entry.defaults[platform];
}

/** What the user's settings contribute to resolution: their rebinds and the OS-wide toggle they set under Startup. */
export interface ShortcutResolutionInput {
  bindings: ShortcutBindings;
  toggleWindow: string | null;
  enabled: boolean;
}

export const NO_SHORTCUT_OVERRIDES: ShortcutResolutionInput = Object.freeze({ bindings: Object.freeze({}), toggleWindow: null, enabled: false });

/** The key a row answers to right now, or null when it has none on this platform. */
export function resolveShortcut(id: ShortcutId, input: ShortcutResolutionInput, platform: ShortcutPlatform): string | null {
  const entry = shortcutDefinition(id);
  if (entry.layeredOn !== undefined) return resolveShortcut(entry.layeredOn as ShortcutId, input, platform);
  if (id === "system.toggleWindow") return input.enabled ? input.toggleWindow : null;
  if (entry.readOnly === undefined) {
    const override = input.bindings[id];
    if (override !== undefined) return override;
  }
  return entry.defaults[platform];
}

export interface ResolvedShortcut {
  id: ShortcutId;
  definition: ShortcutDefinition;
  accelerator: string | null;
  rebindable: boolean;
  modified: boolean;
}

/** Every row that exists on `platform`, in registry order. A row with no key on this platform is left out, except the
 * OS-wide toggle, which is always listed so the user can see where it is set. */
export function resolveShortcuts(input: ShortcutResolutionInput, platform: ShortcutPlatform): ResolvedShortcut[] {
  const rows: ResolvedShortcut[] = [];
  for (const entry of SHORTCUTS) {
    const definition = entry as ShortcutDefinition;
    const id = entry.id as ShortcutId;
    if (definition.layeredOn === undefined && definition.defaults[platform] === null && id !== "system.toggleWindow") continue;
    const rebindable = definition.readOnly === undefined;
    rows.push({
      id,
      definition,
      accelerator: resolveShortcut(id, input, platform),
      rebindable,
      modified: rebindable && input.bindings[id] !== undefined,
    });
  }
  return rows;
}

function scopesOverlap(a: ShortcutScope, b: ShortcutScope): boolean {
  return a === b || WINDOW_WIDE_SCOPES.has(a) || WINDOW_WIDE_SCOPES.has(b);
}

/** Ids of rows that share a chord with another row whose scope overlaps theirs. Two fixed rows never count: they are
 * designed to coexist (Enter sends in the composer and opens a tree row) and the user could not change either. A layered
 * row is the same key by definition, so it is not a conflict either. */
export function conflictingShortcutIds(rows: readonly ResolvedShortcut[], platform: ShortcutPlatform): Set<ShortcutId> {
  const conflicts = new Set<ShortcutId>();
  const keyed = rows
    .filter((row) => row.accelerator !== null && row.definition.layeredOn === undefined)
    .map((row) => ({ row, signature: chordSignature(row.accelerator as string, platform) }));
  for (let i = 0; i < keyed.length; i++) {
    for (let j = i + 1; j < keyed.length; j++) {
      const a = keyed[i];
      const b = keyed[j];
      if (a.signature === null || a.signature !== b.signature) continue;
      if (!a.row.rebindable && !b.row.rebindable) continue;
      if (!scopesOverlap(a.row.definition.scope, b.row.definition.scope)) continue;
      conflicts.add(a.row.id);
      conflicts.add(b.row.id);
    }
  }
  return conflicts;
}

/** Keys the operating system keeps for itself. */
const OS_RESERVED: Record<ShortcutPlatform, readonly string[]> = {
  darwin: [
    "CommandOrControl+H", "CommandOrControl+Alt+H", "CommandOrControl+M", "CommandOrControl+Tab", "CommandOrControl+Shift+Tab",
    "CommandOrControl+Space", "Control+Space", "CommandOrControl+Alt+Space", "CommandOrControl+`", "CommandOrControl+Alt+Esc",
    "CommandOrControl+Shift+3", "CommandOrControl+Shift+4", "CommandOrControl+Shift+5", "Control+Up", "Control+Down",
    "Control+Left", "Control+Right", "CommandOrControl+Control+Q", "CommandOrControl+Control+F", "CommandOrControl+Control+Space",
  ],
  other: [
    "Alt+F4", "Alt+Tab", "Alt+Shift+Tab", "Alt+Esc", "Alt+Space", "Control+Esc", "Control+Shift+Esc", "Control+Alt+Delete",
  ],
};

export type ShortcutBindingRefusal =
  | { reason: "unknown-shortcut" }
  | { reason: "read-only" }
  | { reason: "malformed" }
  | { reason: "needs-modifier" }
  | { reason: "os-reserved" }
  | { reason: "fixed-key"; ownerId: ShortcutId };

/** Why `accelerator` cannot be bound to `id` on `platform`, or null when it can. The settings page shows the reason and
 * the store refuses the same patch, so neither side persists what the other would reject. Duplicating another rebindable
 * row's key is allowed: that is a conflict, shown with a badge, not a refusal. */
export function shortcutBindingRefusal(
  id: string,
  accelerator: string,
  platform: ShortcutPlatform,
  input: ShortcutResolutionInput,
): ShortcutBindingRefusal | null {
  if (!isShortcutId(id)) return { reason: "unknown-shortcut" };
  if (!isRebindableShortcut(id)) return { reason: "read-only" };
  const parsed = parseAccelerator(accelerator);
  if (!parsed || canonicalAccelerator(accelerator) !== accelerator) return { reason: "malformed" };
  const chord = resolveChord(parsed, platform);
  const functionKey = /^F\d+$/.test(chord.key);
  if (!chord.ctrl && !chord.meta && !chord.alt && !functionKey) return { reason: "needs-modifier" };
  // The Windows/Super key belongs to the shell off macOS.
  if (platform === "other" && chord.meta) return { reason: "os-reserved" };
  const signature = chordSignature(accelerator, platform);
  if (OS_RESERVED[platform].some((reserved) => chordSignature(reserved, platform) === signature)) return { reason: "os-reserved" };
  for (const row of resolveShortcuts(input, platform)) {
    if (row.rebindable || row.accelerator === null || row.definition.layeredOn !== undefined) continue;
    if (chordSignature(row.accelerator, platform) === signature) return { reason: "fixed-key", ownerId: row.id };
  }
  return null;
}

/** Load-boundary gate for persisted rebinds. A row this build no longer has, a row that became fixed, a key that became
 * reserved, or a value equal to the default is dropped and the rest kept, so one stale entry cannot discard the others. */
export function loadShortcutBindings(input: unknown, platform: ShortcutPlatform): { bindings: ShortcutBindings; dropped: DroppedShortcutBinding[] } {
  const bindings: ShortcutBindings = {};
  const dropped: DroppedShortcutBinding[] = [];
  if (input === undefined) return { bindings, dropped };
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    dropped.push({ id: "*", value: input, reason: "not-an-object" });
    return { bindings, dropped };
  }
  for (const [id, value] of Object.entries(input as Record<string, unknown>)) {
    if (!isShortcutId(id)) {
      dropped.push({ id, value, reason: "unknown-id" });
      continue;
    }
    if (typeof value !== "string") {
      dropped.push({ id, value, reason: "malformed" });
      continue;
    }
    const refusal = shortcutBindingRefusal(id, value, platform, NO_SHORTCUT_OVERRIDES);
    if (refusal !== null) {
      dropped.push({ id, value, reason: refusal.reason });
      continue;
    }
    if (value === defaultAccelerator(id, platform)) {
      dropped.push({ id, value, reason: "equals-default" });
      continue;
    }
    bindings[id] = value;
  }
  return { bindings, dropped };
}

/** A stored rebind the load gate discarded, and why. */
export interface DroppedShortcutBinding {
  id: string;
  value: unknown;
  reason: "not-an-object" | "unknown-id" | "malformed" | "equals-default" | ShortcutBindingRefusal["reason"];
}

export class ShortcutBindingsPatchError extends Error {
  readonly code = "invalid-shortcut-binding";

  constructor(message: string) {
    super(message);
    this.name = "ShortcutBindingsPatchError";
  }
}

/** The bindings after `patch`: an accelerator rebinds its row and `null` resets it; a rebind to the default is stored as
 * no override. Throws ShortcutBindingsPatchError on anything the settings page would have refused, since a refusal
 * here means a caller broke the contract. */
export function applyShortcutBindingsPatch(
  current: ShortcutSettings,
  patch: unknown,
  platform: ShortcutPlatform,
): ShortcutBindings {
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) {
    throw new ShortcutBindingsPatchError("shortcuts.bindings must map shortcut ids to an accelerator or null.");
  }
  const next: ShortcutBindings = { ...current.bindings };
  for (const [id, value] of Object.entries(patch as Record<string, unknown>)) {
    if (!isShortcutId(id)) throw new ShortcutBindingsPatchError(`Unknown shortcut id: ${id}`);
    if (value === null) {
      delete next[id];
      continue;
    }
    if (typeof value !== "string") throw new ShortcutBindingsPatchError(`shortcuts.bindings.${id} must be an accelerator or null.`);
    const refusal = shortcutBindingRefusal(id, value, platform, { ...current, bindings: next });
    if (refusal !== null) throw new ShortcutBindingsPatchError(`shortcuts.bindings.${id} refused (${refusal.reason}): ${value}`);
    if (value === defaultAccelerator(id, platform)) delete next[id];
    else next[id] = value;
  }
  return next;
}
