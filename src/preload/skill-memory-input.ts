type Source = "chat" | "routine" | "work-board";

interface OwnerInput {
  element: HTMLTextAreaElement;
  text: string;
}

const edits: Partial<Record<Source, OwnerInput>> = {};
const admission = new WeakSet<HTMLTextAreaElement>();
const TYPING_INPUT = /^(?:insertText|insertCompositionText|insertLineBreak|insertParagraph|deleteContentBackward|deleteContentForward|deleteWordBackward|deleteWordForward)$/u;

function sourceOf(element: HTMLTextAreaElement): Source | undefined {
  const source = element.dataset.skillMemorySource;
  return source === "chat" || source === "routine" || source === "work-board" ? source : undefined;
}

/** Observe the real textarea before renderer state updates, without making clipboard text part of the IPC protocol. */
export function installSkillMemoryInputTracking(doc = globalThis.document): void {
  if (!doc) return;
  doc.addEventListener("beforeinput", event => {
    const input = event as InputEvent;
    const target = input.target;
    if (!(target instanceof HTMLTextAreaElement) || !input.isTrusted) return;
    const source = sourceOf(target);
    if (!source) return;
    const held = edits[source];
    if (TYPING_INPUT.test(input.inputType)
      && (target.value === "" || (held?.element === target && held.text === target.value))) {
      admission.add(target);
    } else {
      delete edits[source];
      admission.delete(target);
    }
  }, true);
  doc.addEventListener("input", event => {
    const input = event as InputEvent;
    const target = input.target;
    if (!(target instanceof HTMLTextAreaElement) || !input.isTrusted) return;
    const source = sourceOf(target);
    if (!source) return;
    if (admission.delete(target) && TYPING_INPUT.test(input.inputType)) edits[source] = { element: target, text: target.value };
    else delete edits[source];
  }, true);
}

export function consumeSkillMemoryOwnerInput(source: Source, text: unknown): boolean {
  const held = edits[source];
  delete edits[source];
  return typeof text === "string" && text.length > 0 && held?.element.isConnected === true
    && held.element.value === held.text && held.text.trim() === text;
}
