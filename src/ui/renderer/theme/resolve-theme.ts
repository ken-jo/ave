import { THEME_SURFACE_NAMES, THEME_TOKEN_NAMES, installedThemeCustomProperties } from "../../../shared/theme-tokens.js";
import type { ThemeBundle } from "./bundles/index.js";
import type { ResolvedShell } from "./types.js";

/**
 * Apply a ThemeBundle to the document root element.
 *
 * Sets:
 *   - `data-theme-bundle="<id>"` — activates the matching CSS block in styles.css
 *   - `data-shell="<light|dark>"` — drives color-scheme meta for native widgets
 *   - class `ave-bundle-<id>` — for test selectors / snapshot matching
 *   - for an installed theme (it has no CSS block), its tokens, surfaces,
 *     shadows and color-scheme as inline custom properties on :root
 *
 * Removes all prior `ave-bundle-*` classes before adding the new one.
 * Idempotent.
 */
export function applyBundleToDocument(bundle: ThemeBundle, doc: Document = document): void {
  const root = doc.documentElement;
  // Remove all prior bundle classes
  const toRemove = Array.from(root.classList).filter((c) => c.startsWith("ave-bundle-"));
  root.classList.remove(...toRemove);
  root.setAttribute("data-theme-bundle", bundle.id);
  root.setAttribute("data-shell", bundle.shell);
  root.classList.add(`ave-bundle-${bundle.id}`);
  // An installed theme has no `styles.css` block: its properties go on :root
  // inline. A compiled bundle clears them so its block applies again.
  const installed = bundle.surfaces
    ? installedThemeCustomProperties({ shell: bundle.shell, tokens: bundle.tokens, surfaces: bundle.surfaces })
    : {};
  for (const name of INSTALLED_THEME_PROPERTIES) {
    const value = installed[name];
    if (value === undefined) root.style.removeProperty(name);
    else root.style.setProperty(name, value);
  }
  if (bundle.surfaces) root.style.setProperty("color-scheme", bundle.shell);
  else root.style.removeProperty("color-scheme");
}

const INSTALLED_THEME_PROPERTIES = [
  ...THEME_TOKEN_NAMES.map((name) => `--${name}`),
  ...THEME_SURFACE_NAMES.map((name) => `--${name}`),
  "--shadow-e1", "--shadow-e2", "--shadow-e3", "--shadow-e4",
];

/**
 * Of a theme and its pair of the other shell (`systemPairOf`), the id whose
 * shell matches `prefers-color-scheme`; the dark one when the scheme cannot
 * be read. Called only while `followSystem` is on.
 */
export function resolveSystemPair(
  bundle: Pick<ThemeBundle, "id" | "shell">,
  pair: Pick<ThemeBundle, "id" | "shell">,
  win: Pick<Window, "matchMedia"> | undefined = typeof window !== "undefined" ? window : undefined,
): string {
  let light = false;
  try {
    light = win?.matchMedia?.("(prefers-color-scheme: light)").matches === true;
  } catch {
    /* matchMedia unavailable */
  }
  const wanted = light ? "light" : "dark";
  return bundle.shell === wanted ? bundle.id : pair.id;
}

/**
 * Derive the resolved shell ("light" | "dark") from a bundle.
 * Convenience wrapper for components that need the scalar shell value.
 */
export function bundleShell(bundle: ThemeBundle): ResolvedShell {
  return bundle.shell;
}
