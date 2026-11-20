// Portions adapted from microsoft/vscode src/vs/base/browser/ui/list/listWidget.ts @ 6659689e6b03ec062f5b7bcea9850b4c59045807, Copyright (c) Microsoft Corporation, MIT License.
/*
 * Adapted parts: the keyboard controller's row moves (previous, next, page, first, last), the rule for which keys can
 * start type navigation (`mightProducePrintableCharacter`) and the type navigation controller (the typed word, its 800 ms
 * reset, the search that starts after the focused row for a new word and at it while the word grows, and prefix matching
 * with a contiguous-match fallback). The list widget, its event pipeline and its services are not used: these are plain
 * functions and one small class that a list component calls from its own key handler.
 */

/** The part of a keyboard event the navigation rules read. */
export interface ListKeyEvent {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  /** True while an input method is composing; such keys never navigate. */
  isComposing?: boolean;
}

/**
 * Whether a key press can add to a type-navigation word. Modifier chords never do. The original tests key codes for
 * letters, digits and punctuation; here the pressed character itself is tested, which also admits letters of other
 * scripts. Space is not a word character, so it keeps its own meaning in the list.
 */
export function mightProducePrintableCharacter(event: ListKeyEvent): boolean {
  if (event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return false;
  return [...event.key].length === 1 && event.key.trim().length === 1;
}

/**
 * The row a navigation key moves focus to, or null when the key is not a navigation key. Moves stop at the ends and never
 * wrap. `pageSize` is the number of rows a page move travels (at least one).
 */
export function listNavigationTarget(key: string, focusedIndex: number, length: number, pageSize: number): number | null {
  if (length === 0) return null;
  const from = Math.max(0, Math.min(focusedIndex, length - 1));
  const page = Math.max(1, Math.floor(pageSize));
  switch (key) {
    case "ArrowUp": return Math.max(0, from - 1);
    case "ArrowDown": return Math.min(length - 1, from + 1);
    case "PageUp": return Math.max(0, from - page);
    case "PageDown": return Math.min(length - 1, from + page);
    case "Home": return 0;
    case "End": return length - 1;
    default: return null;
  }
}

/** How long after the last typed character the word is forgotten. */
export const TYPE_NAVIGATION_RESET_MS = 800;

function matchesPrefix(word: string, label: string): boolean {
  return label.length >= word.length && label.slice(0, word.length).toLowerCase() === word.toLowerCase();
}

/** The fallback after prefix matching: the word, when longer than one character, found as one unbroken run in the label. */
function matchesContiguously(word: string, label: string): boolean {
  return [...word].length > 1 && label.toLowerCase().includes(word.toLowerCase());
}

/**
 * Type-to-navigate for a list of labelled rows. Feed it each printable key with the labels in display order and the
 * focused row; it returns the row to focus, or -1 when no label matches the word typed so far.
 */
export class TypeNavigationController {
  private state: "idle" | "typing" = "idle";
  private word = "";
  private timer: ReturnType<typeof setTimeout> | null = null;

  /** True from the first typed character until the reset; while typing, every printable key belongs to the word. */
  get typing(): boolean {
    return this.state === "typing";
  }

  input(character: string, labels: ReadonlyArray<string | undefined>, focusedIndex: number): number {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.clear(), TYPE_NAVIGATION_RESET_MS);
    this.word += character;
    const start = Math.max(0, focusedIndex);
    // A new word looks from the row after the focused one, so repeating a letter walks through its matches; a growing
    // word keeps the focused row while it still matches.
    const delta = this.state === "idle" ? 1 : 0;
    this.state = "typing";
    for (let i = 0; i < labels.length; i += 1) {
      const index = (start + i + delta) % labels.length;
      const label = labels[index];
      if (label === undefined) continue;
      if (matchesPrefix(this.word, label) || matchesContiguously(this.word, label)) return index;
    }
    return -1;
  }

  clear(): void {
    if (this.timer !== null) clearTimeout(this.timer);
    this.timer = null;
    this.word = "";
    this.state = "idle";
  }
}
