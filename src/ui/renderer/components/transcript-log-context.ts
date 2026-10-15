/**
 * Whether a component renders inside the main chat transcript's `role="log"`.
 *
 * The log is itself a polite live region that reads additions and text
 * changes. A live region nested inside it is read twice or swallowed,
 * depending on the screen reader, so status cards that are their own live
 * region elsewhere (the side chat and side panel share the transcript
 * renderer without a log) drop their live attributes inside it.
 */
import { createContext, useContext } from "react";

export const TranscriptLogContext = createContext(false);

/** Live-region attributes for a status element, or none inside the transcript log. */
export function useStatusLiveRegion(): { role?: "status"; "aria-live"?: "polite" } {
  return useContext(TranscriptLogContext) ? {} : { role: "status", "aria-live": "polite" };
}
