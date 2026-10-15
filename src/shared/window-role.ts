/**
 * Which main window a renderer is: the primary one (the first opened, which
 * holds the primary conversation — `main/app-state.ts`) or a secondary one.
 *
 * Main passes it into each main window through `additionalArguments`; the
 * preload exposes it as `window.__aveWindowRole`. The renderer needs it for
 * what is one-per-app rather than one-per-window: the saved main-area layout
 * belongs to the primary window. Windows have no identity across launches, so
 * a role is the only honest key there is.
 */
export const WINDOW_ROLE_ARG_PREFIX = "--ave-window-role=";

export type WindowRole = "primary" | "secondary";

export function normalizeWindowRole(value: unknown): WindowRole | null {
  return value === "primary" || value === "secondary" ? value : null;
}
