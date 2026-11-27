import { isElementShown } from "./browser-observation-preview.js";

/** Side-panel blocks use the group's last composer, then its main composer; main-pane blocks use the window's last
 * composer, then the pane's own chat. */
export type ComposerKind = "conversation" | "side-chat";

/** What attaching text did: true, attached; false, the composer was full; "no-composer", no composer the user can see could
 * take it. */
export type AttachTextResult = boolean | "no-composer";

export interface ComposerTarget {
  groupId: string;
  kind: ComposerKind;
  /** Put `text` into the draft; false when it did not fit. */
  attach: (text: string) => boolean;
  attachImage?: (base64: string, canCommit?: () => boolean) => Promise<boolean>;
  getSessionIdentity?: () => symbol | undefined;
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

/** The chat docked to a surface pane (the terminal's own conversation), when the user can see its composer. */
function sideChatOf(groupId: string | undefined): [symbol, ComposerTarget] | null {
  if (groupId === undefined) return null;
  for (const entry of targets) {
    const target = entry[1];
    if (target.groupId === groupId && target.kind === "side-chat" && target.available()) return entry;
  }
  return null;
}

function anyConversation(): ComposerTarget | null {
  for (const target of targets.values()) if (target.kind === "conversation" && target.available()) return target;
  return null;
}

/** Attach a terminal block's text. `fromGroup` is the group whose side panel holds the terminal; omitted for a main-pane
 * terminal, which goes to the last composer the user used, else the chat docked to its own pane (`ownChatGroup`) when that is
 * open, else `focusedGroupId`'s conversation, then any conversation on screen. */
export function attachToComposer(text: string, from: { fromGroup: string } | { focusedGroupId: string; ownChatGroup?: string }): AttachTextResult {
  const target = "fromGroup" in from
    ? usable(lastUsedByGroup.get(from.fromGroup)) ?? conversationOf(from.fromGroup)
    : usable(lastUsed) ?? sideChatOf(from.ownChatGroup)?.[1] ?? conversationOf(from.focusedGroupId) ?? anyConversation();
  return target ? target.attach(text) : "no-composer";
}

/** Captures use the same visible composer slots as other content handed over by a host surface. */
export async function attachImageToComposer(base64: string, groupId?: string): Promise<AttachTextResult> {
  const target = groupId === undefined
    ? usable(lastUsed) ?? anyConversation()
    : usable(lastUsedByGroup.get(groupId)) ?? conversationOf(groupId);
  return target?.attachImage ? target.attachImage(base64) : "no-composer";
}

export function pinPaneChatImageTarget(paneChatGroupId: string, sourceCurrent: () => boolean):
  ((base64: string) => Promise<boolean>) | null {
  const registration = sideChatOf(paneChatGroupId);
  if (!registration) return null;
  const [key, target] = registration;
  const dock = target.element();
  const attachImage = target.attachImage;
  const sessionIdentity = target.getSessionIdentity?.();
  if (!attachImage || sessionIdentity === undefined || !dock || !isElementShown(dock)) return null;

  let current = true;
  const canCommit = () => {
    current &&= sourceCurrent() && targets.get(key) === target && target.getSessionIdentity?.() === sessionIdentity
      && target.available() && target.element() === dock && isElementShown(dock);
    return current;
  };
  return async (base64) => canCommit() && attachImage(base64, canCommit);
}

/** Test-only. */
export function resetComposerTargetsForTest(): void {
  if (targets.size > 0) document.removeEventListener("focusin", onFocusIn, true);
  targets.clear();
  lastUsed = null;
  lastUsedByGroup.clear();
}
