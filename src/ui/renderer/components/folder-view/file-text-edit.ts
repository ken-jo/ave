/** Editing a project file's text in the folder view. Main reads the file for editing and saves it back only if it still
 * holds what the edit started from; this module holds the text in between.
 *
 * A draft lives here, outside any component, keyed by the file's path: choosing another file or closing the viewer does not
 * drop what the person typed, and coming back to the file shows it again. It ends when they save or discard it. */
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";
import type { WorkspaceReadForEditResult, WorkspaceSaveEditResult } from "../../../../ipc/domains/workspace.js";
import { notifyWorkspaceFilesChanged } from "../../utils/workspace-files-signal.js";

interface Draft {
  /** Hash of the file's bytes when it was read; a save names it, and main refuses if the file has changed since. */
  baseHash: string;
  original: string;
  text: string;
}

const drafts = new Map<string, Draft>();
// A path whose read or save has not answered yet. It lives with the drafts, not with a mounted view: leaving the file and
// coming back while a save is on its way must find the text still locked, and the answer must find the draft it belongs to.
const pending = new Set<string>();
const listeners = new Set<() => void>();

function publish(): void {
  for (const listener of [...listeners]) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Test seam: forget every draft. */
export function _resetFileTextDraftsForTest(): void {
  drafts.clear();
  pending.clear();
  publish();
}

type Refusal = Extract<WorkspaceReadForEditResult, { ok: false }>["error"] | Extract<WorkspaceSaveEditResult, { ok: false }>["error"];

function refusalKey(error: Refusal, fallback: string): string {
  switch (error) {
    case "changed": return "folderView.editChanged";
    case "too-large": return "folderView.editTooLarge";
    case "not-text": return "folderView.editNotText";
    case "mixed-line-endings": return "folderView.editMixedEndings";
    case "not-editable":
    case "not-a-file": return "folderView.editNotEditable";
    case "denied": return "folderView.editDenied";
    case "not-found": return "folderView.openRefusedChanged";
    case "network-target":
    case "outside-project": return "folderView.openRefusedOutside";
    case "user-keyboard-required": return "folderView.openRefusedGesture";
    case "sensitive-path":
    case "path-not-allowed":
    case "root-not-registered": return "folderView.openRefusedScope";
    default: return fallback;
  }
}

export interface FileTextEdit {
  /** The text being edited, or null while the file is only shown. */
  text: string | null;
  dirty: boolean;
  /** A read or a save is on its way; the text is not editable until it answers. */
  busy: boolean;
  /** Start editing. Call straight from a click or key handler: its first statement is the IPC call that reports the gesture. */
  begin: () => void;
  change: (text: string) => void;
  /** Save the text. Call straight from a click or key handler, as `begin`. */
  save: () => void;
  discard: () => void;
}

/**
 * The edit state of one file. `report` receives the i18n key of what an action could not do, or null when an action starts.
 */
export function useFileTextEdit(projectRoot: string, path: string, report: (messageKey: string | null) => void): FileTextEdit {
  const draft = useSyncExternalStore(subscribe, () => drafts.get(path));
  const busy = useSyncExternalStore(subscribe, () => pending.has(path));
  // An answer for a file the viewer has left still updates that file's draft, but says nothing on the file now shown.
  const shown = useRef(path);
  useEffect(() => { shown.current = path; }, [path]);
  const settle = useCallback((from: string, messageKey: string | null) => {
    pending.delete(from);
    publish();
    if (shown.current === from && messageKey !== null) report(messageKey);
  }, [report]);

  const begin = (): void => {
    if (pending.has(path)) return;
    const request = window.ave.workspace.readForEdit(projectRoot, path);
    report(null);
    pending.add(path);
    publish();
    void request.then((result) => {
      if (result.ok) drafts.set(path, { baseHash: result.hash, original: result.text, text: result.text });
      settle(path, result.ok ? null : refusalKey(result.error, "folderView.editOpenFailed"));
    }, () => settle(path, "folderView.editOpenFailed"));
  };

  const save = (): void => {
    const sent = drafts.get(path);
    if (sent === undefined || pending.has(path)) return;
    const request = window.ave.workspace.saveEdit(projectRoot, path, sent.baseHash, sent.text);
    report(null);
    pending.add(path);
    publish();
    void request.then((result) => {
      if (result.ok) {
        // The text was locked from the moment the save left, so the draft still is exactly what was saved.
        drafts.delete(path);
        // Every list and open file asks main again, so the viewer, the trees and the turn review show the saved file.
        notifyWorkspaceFilesChanged("manual");
      }
      settle(path, result.ok ? null : refusalKey(result.error, "folderView.editFailed"));
    }, () => settle(path, "folderView.editFailed"));
  };

  return {
    text: draft?.text ?? null,
    dirty: draft !== undefined && draft.text !== draft.original,
    busy,
    begin,
    change: (text) => {
      const current = drafts.get(path);
      // The text is locked while a save is on its way, whichever view the typing comes from.
      if (current === undefined || current.text === text || pending.has(path)) return;
      drafts.set(path, { ...current, text });
      publish();
    },
    save,
    discard: () => {
      report(null);
      if (pending.has(path) || !drafts.delete(path)) return;
      publish();
      // The file may have changed while the draft covered it (a refused save says so); show what is on disk now.
      notifyWorkspaceFilesChanged("manual");
    },
  };
}
