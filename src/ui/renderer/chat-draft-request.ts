/** Surfaces outside the conversation (Settings) ask the window to open a new chat with a prepared composer draft; the
 * user reviews and sends it. */
const listeners = new Set<(draft: string) => void>();

export function requestNewChatDraft(draft: string): void {
  for (const listener of listeners) listener(draft);
}

export function onNewChatDraft(listener: (draft: string) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
