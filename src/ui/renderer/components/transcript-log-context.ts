/** Suppress nested live-region attributes inside the transcript log to avoid duplicate or swallowed screen-reader
 * announcements. */
import { createContext, useContext } from "react";

export const TranscriptLogContext = createContext(false);

/** Live-region attributes for a status element, or none inside the transcript log. */
export function useStatusLiveRegion(): { role?: "status"; "aria-live"?: "polite" } {
  return useContext(TranscriptLogContext) ? {} : { role: "status", "aria-live": "polite" };
}
