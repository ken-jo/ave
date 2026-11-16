import { BROWSER_PAGE_PROMPT_LIMIT, type BrowserPagePrompt, type BrowserPromptAnswer } from "../../shared/browser-workspace.js";

type PromptOf<K extends BrowserPagePrompt["kind"]> = Extract<BrowserPagePrompt, { kind: K }>;
type AnswerOf<K extends BrowserPagePrompt["kind"]> = Extract<BrowserPromptAnswer, { kind: K }>;

interface Pending { readonly prompt: BrowserPagePrompt; settle(answer: BrowserPromptAnswer | null): void }

/**
 * Questions pages are waiting on, per guest, oldest first. A question ends with the user's answer or with `null`: the
 * document that asked went away, the guest closed, or the page asked more than a tab holds. Askers treat `null` as the
 * refusal for their kind and remember nothing from it.
 */
export class BrowserPagePrompts {
  private readonly pending = new Map<number, Pending[]>();
  private next = 1;
  constructor(private readonly changed: () => void) {}

  /** `details` is the prompt as its asker describes it; the queue assigns the id. */
  ask<K extends BrowserPagePrompt["kind"]>(guestId: number, kind: K, details: Omit<PromptOf<K>, "id" | "kind">): Promise<AnswerOf<K> | null> {
    const queue = this.pending.get(guestId) ?? [];
    if (queue.length >= BROWSER_PAGE_PROMPT_LIMIT) return Promise.resolve(null);
    return new Promise((resolve) => {
      const entry: Pending = {
        prompt: { ...details, kind, id: `prompt-${this.next++}` } as unknown as BrowserPagePrompt,
        settle: (answer) => resolve(answer as AnswerOf<K> | null),
      };
      this.pending.set(guestId, [...queue, entry]);
      this.changed();
    });
  }

  list(guestId: number): readonly BrowserPagePrompt[] {
    return (this.pending.get(guestId) ?? []).map((entry) => entry.prompt);
  }

  /** False when the prompt is gone or the answer is for another kind of question. */
  answer(guestId: number, promptId: string, answer: BrowserPromptAnswer): boolean {
    const queue = this.pending.get(guestId) ?? [];
    const entry = queue.find((candidate) => candidate.prompt.id === promptId);
    if (!entry || entry.prompt.kind !== answer.kind) return false;
    this.remove(guestId, queue.filter((candidate) => candidate !== entry));
    entry.settle(answer);
    this.changed();
    return true;
  }

  /** The asking document is gone: its questions end unanswered. `only` limits this to some kinds. */
  dismissGuest(guestId: number, only?: (prompt: BrowserPagePrompt) => boolean): void {
    const queue = this.pending.get(guestId);
    if (!queue?.length) return;
    const dismissed = only ? queue.filter((entry) => only(entry.prompt)) : queue;
    if (dismissed.length === 0) return;
    this.remove(guestId, queue.filter((entry) => !dismissed.includes(entry)));
    for (const entry of dismissed) entry.settle(null);
    this.changed();
  }

  private remove(guestId: number, rest: Pending[]): void {
    if (rest.length) this.pending.set(guestId, rest);
    else this.pending.delete(guestId);
  }
}
