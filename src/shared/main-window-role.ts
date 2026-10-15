/**
 * How a main window's renderer learns it is not the primary window.
 *
 * Main loads a secondary window's `index.html` with `?<key>=secondary`
 * (`loadMainInterface` in `src/main/main-window.ts`); the primary loads the
 * bare document. The renderer reads it once (`isSecondaryMainWindow` in
 * `src/ui/renderer/utils/main-window-role.ts`): a secondary window's first
 * tile is its own conversation, so it must not resume the primary window's
 * main-active session.
 */
export const MAIN_WINDOW_ROLE_QUERY_KEY = "aveWindow";
