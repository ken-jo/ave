/**
 * Where a terminal block the user attaches lands: the composer they last
 * typed in.
 *
 * A window has one conversation composer per pane and a side-chat composer
 * per open side chat. Attaching a block from a terminal used to go to the
 * conversation beside it, always — wrong once the side chat is what the user
 * is talking to, and impossible for a terminal in a main pane, which has no
 * conversation beside it. The rule now:
 *
 *  - a side-panel terminal attaches to its own group's last-used composer
 *    (its side chat, or its conversation), else the group's conversation;
 *  - a main-pane terminal attaches to the window's last-used composer, else
 *    the focused pane's conversation, then any conversation on screen.
 *
 * A composer that cannot take text right now (a side chat behind another tab,
 * a conversation behind a routed view) is skipped.
 */
export type ComposerKind = "conversation" | "side-chat";

/**
 * What attaching text did: true, attached; false, the composer was full;
 * "no-composer", no composer the user can see could take it.
 */
export type AttachTextResult = boolean | "no-composer";

export interface ComposerTarget {
  groupId: string;
  kind: ComposerKind;
  /** Put `text` into the draft; false when it did not fit. */
  attach: (text: string) => boolean;
  /** Whether the user can see this composer now. */
  available: () => boolean;
  /** The composer's dock: focus landing inside it is "the user used it". */
  element: () => HTMLElement | null;
}

const targets = new Map<symbol, ComposerTarget>();
let lastUsed: symbol | null = null;
const lastUsedByGroup = new Map<string, symbol>();

function markUsed(key: symbol, target: ComposerTarget): void {
  lastUsed = key;
  lastUsedByGroup.set(target.groupId, key);
}

// One window listener: focus landing in a registered dock marks it used.
function onFocusIn(event: FocusEvent): void {
  const node = event.target;
  if (!(node instanceof Node)) return;
  for (const [key, target] of targets) {
    if (target.element()?.contains(node)) {
      markUsed(key, target);
      return;
    }
  }
}

/** Register a composer; returns the unregister function. */
export function registerComposerTarget(target: ComposerTarget): () => void {
  const key = Symbol(`${target.kind}:${target.groupId}`);
  if (targets.size === 0) document.addEventListener("focusin", onFocusIn, true);
  targets.set(key, target);
  return () => {
    if (!targets.delete(key)) return;
    if (lastUsed === key) lastUsed = null;
    if (lastUsedByGroup.get(target.groupId) === key) lastUsedByGroup.delete(target.groupId);
    if (targets.size === 0) document.removeEventListener("focusin", onFocusIn, true);
  };
}

function usable(key: symbol | null | undefined): ComposerTarget | null {
  if (!key) return null;
  const target = targets.get(key);
  return target && target.available() ? target : null;
}

function conversationOf(groupId: string): ComposerTarget | null {
  for (const target of targets.values()) {
    if (target.groupId === groupId && target.kind === "conversation" && target.available()) return target;
  }
  return null;
}

function anyConversation(): ComposerTarget | null {
  for (const target of targets.values()) if (target.kind === "conversation" && target.available()) return target;
  return null;
}

/**
 * Attach a terminal block's text. `fromGroup` is the group whose side panel
 * holds the terminal; omitted for a main-pane terminal, which falls back to
 * `focusedGroupId`'s conversation, then any conversation on screen.
 */
export function attachToComposer(text: string, from: { fromGroup: string } | { focusedGroupId: string }): AttachTextResult {
  const target = "fromGroup" in from
    ? usable(lastUsedByGroup.get(from.fromGroup)) ?? conversationOf(from.fromGroup)
    : usable(lastUsed) ?? conversationOf(from.focusedGroupId) ?? anyConversation();
  return target ? target.attach(text) : "no-composer";
}

/** Test-only. */
export function resetComposerTargetsForTest(): void {
  if (targets.size > 0) document.removeEventListener("focusin", onFocusIn, true);
  targets.clear();
  lastUsed = null;
  lastUsedByGroup.clear();
}
