/**
 * One signal for "files under a project may have changed on disk". Every file list and open file in the renderer listens to
 * it and asks main again, replacing what it shows; nothing is merged from the event itself. The chat streams raise it when a
 * tool or a turn finishes, a code rewind raises it when it has restored files, the window raises it when it gets focus back
 * (the user may have changed files in another app), and a refresh button raises it directly.
 */
export type WorkspaceFilesChangeReason = "tool" | "turn" | "checkpoint" | "focus" | "manual";

type Listener = (reason: WorkspaceFilesChangeReason) => void;

const listeners = new Set<Listener>();

export function notifyWorkspaceFilesChanged(reason: WorkspaceFilesChangeReason): void {
  for (const listener of [...listeners]) listener(reason);
}

function handleWindowFocus(): void {
  notifyWorkspaceFilesChanged("focus");
}

/** Listen for the signal; the window focus source is attached while anything listens. Returns the unsubscribe. */
export function subscribeWorkspaceFilesChanged(listener: Listener): () => void {
  if (listeners.size === 0) window.addEventListener("focus", handleWindowFocus);
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) window.removeEventListener("focus", handleWindowFocus);
  };
}

/** Raise the signal for the chat stream frames after which files may differ: a finished tool call and a finished turn. */
export function notifyWorkspaceFilesChangedByStream(event: { type: string }): void {
  if (event.type === "tool_end") notifyWorkspaceFilesChanged("tool");
  else if (event.type === "done") notifyWorkspaceFilesChanged("turn");
}

/**
 * Wrap a re-query so signals that arrive in a burst cost one query at a time: a request made while one is running is
 * remembered and runs once more when it ends, so the last answer is always newer than the last signal. `run` must not reject.
 */
export function coalesceRefresh(run: () => Promise<void>): () => void {
  let running = false;
  let again = false;
  const start = (): void => {
    running = true;
    void run().then(() => {
      running = false;
      if (!again) return;
      again = false;
      start();
    });
  };
  return () => {
    if (running) again = true;
    else start();
  };
}
