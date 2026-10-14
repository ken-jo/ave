import { MAIN_WINDOW_ROLE_QUERY_KEY } from "../../../shared/main-window-role.js";

/** Whether this renderer belongs to a secondary main window (see the shared key). */
export function isSecondaryMainWindow(search: string = window.location.search): boolean {
  return new URLSearchParams(search).get(MAIN_WINDOW_ROLE_QUERY_KEY) === "secondary";
}
