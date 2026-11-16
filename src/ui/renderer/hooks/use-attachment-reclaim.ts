import { useCallback, useEffect, useRef, useState } from "react";
import type { Attachment } from "../types/attachments.js";

/** The path an attachment holds an authorization for in main: an image's file (a clipboard image is a temp file this app
 * wrote) and a picked or dropped file. An `@file` mention, a pasted text and a resource hold none. */
function heldPath(attachment: Attachment): string | null {
  if (attachment.kind === "image") return attachment.path;
  if (attachment.kind === "file" && attachment.reference !== true) return attachment.path;
  return null;
}

export interface AttachmentReclaim {
  /** Keep what leaves the composer while `send` is in flight. A send clears the composer before main has answered, and a
   * refused send puts the draft back with its attachments, which must still be openable then. Returns `send` itself. */
  holdDuring: <T>(send: Promise<T>) => Promise<T>;
}

/**
 * Gives back to main what a composer's attachments hold, once they are gone for good: when a chip is removed (by its
 * button or by deleting its marker), when the message carrying them was sent, when the conversation changes, and when the
 * composer's owner unmounts. Main then drops the path authorization and deletes the clipboard image it wrote.
 *
 * Driven by the attachment list itself, so every way an attachment can leave is covered without each one having to
 * remember to release.
 */
export function useAttachmentReclaim(attachments: readonly Attachment[]): AttachmentReclaim {
  /** Attachment id → held path, for the attachments in the composer now. */
  const presentRef = useRef(new Map<string, string>());
  /** The same, for attachments that left and have not been released yet. */
  const departedRef = useRef(new Map<string, string>());
  // State, not a ref: a send that settles must run the effect below again, after the commit that may have put a refused
  // draft back. A send starts in the same synchronous step that empties the composer, so both land in one render.
  const [sendsInFlight, setSendsInFlight] = useState(0);

  useEffect(() => {
    const present = new Map<string, string>();
    for (const attachment of attachments) {
      const held = heldPath(attachment);
      if (held !== null) present.set(attachment.id, held);
    }
    for (const [id, held] of presentRef.current) {
      if (!present.has(id)) departedRef.current.set(id, held);
    }
    // Back in the composer (a refused send restored its draft): still in use.
    for (const id of present.keys()) departedRef.current.delete(id);
    presentRef.current = present;
    if (sendsInFlight > 0 || departedRef.current.size === 0) return;
    const paths = [...departedRef.current.values()];
    departedRef.current.clear();
    void window.ave.attach.release(paths);
  }, [attachments, sendsInFlight]);

  useEffect(() => () => {
    const paths = [...presentRef.current.values(), ...departedRef.current.values()];
    presentRef.current.clear();
    departedRef.current.clear();
    if (paths.length > 0) void window.ave.attach.release(paths);
  }, []);

  const holdDuring = useCallback(<T,>(send: Promise<T>): Promise<T> => {
    setSendsInFlight((count) => count + 1);
    const settle = () => setSendsInFlight((count) => count - 1);
    send.then(settle, settle);
    return send;
  }, []);

  return { holdDuring };
}
