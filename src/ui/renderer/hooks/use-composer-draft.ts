import { useCallback, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { isComposerDraftEmpty, type ComposerDraft } from "../state/composer-draft-store.js";
import { isAppMessageOrigin } from "../../../shared/mcp-app-message-source.js";

/** Text and provenance share one lifetime, including edits, clears and draft restoration. */
export function useComposerDraft() {
  const [draft, replaceDraft] = useState<ComposerDraft>({ text: "" });
  const draftRef = useRef(draft);
  const setDraft: Dispatch<SetStateAction<ComposerDraft>> = useCallback((update) => {
    const next = typeof update === "function" ? update(draftRef.current) : update;
    draftRef.current = next;
    replaceDraft(next);
  }, []);
  const setQuestion: Dispatch<SetStateAction<string>> = useCallback((update) => {
    setDraft((current) => {
      const text = typeof update === "function" ? update(current.text) : update;
      return text.length === 0 ? { text: "", ...(current.pendingAppDrafts ? { pendingAppDrafts: current.pendingAppDrafts } : {}) } : { ...current, text };
    });
  }, [setDraft]);
  const stageAppMessage = useCallback((text: string, source: string) => {
    if (!isAppMessageOrigin(source)) throw new Error("Invalid app draft source");
    setDraft((current) => !isComposerDraftEmpty(current)
      ? { ...current, pendingAppDrafts: [{ text, appSource: source }] }
      : { ...current, text, appSource: source });
  }, [setDraft]);
  const acceptPendingAppDraft = useCallback(() => {
    setDraft((current) => {
      const next = current.pendingAppDrafts?.[0];
      return next ? { ...next } : current;
    });
  }, [setDraft]);
  const dismissPendingAppDraft = useCallback(() => {
    setDraft((current) => {
      const { pendingAppDrafts: _pending, ...rest } = current;
      return rest;
    });
  }, [setDraft]);
  return { draft, draftRef, setDraft, setQuestion, stageAppMessage, acceptPendingAppDraft, dismissPendingAppDraft };
}
