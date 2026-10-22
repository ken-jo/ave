/**
 * The display label for a plugin UI extension — shared between the main-window
 * renderer, the main process (app menu, floating dock) and the plugin-shell
 * bundle.
 *
 * Every surface renders the same extension in the same session (the sidebar
 * entry and pane header in the main window, the app menu, the dock's slot
 * header), so a one-sided edit makes one surface call an extension something
 * the other does not. Same corrective pattern the sibling concern in
 * `plugin-ui-host.tsx` already documents for partition naming
 * (`shared/plugin-partition.ts`, #498).
 *
 * Pure — no DOM / Electron / node deps, and no import of the extension type, so
 * it stays importable from either bundle without pulling a bundle entry module
 * into the shared graph. The parameter is the minimum the derivation reads;
 * `PluginUiExtensionView` (plugin-ui-host.tsx) and its renderer alias
 * `PluginUiExtension` both satisfy it structurally, which `tsc` checks at each
 * call site.
 *
 * Each function takes the UI language explicitly rather than reading the
 * process-local one, so a React caller passes the hook's `locale` and re-renders
 * when it changes, and a main-process caller names the moment it resolved at.
 */
import { resolvePluginLocalizedText, type PluginTextLocales } from "./plugin-localized-text.js";

type ViewTextField = "displayName" | "title" | "description";

export interface PluginViewLabelSource {
  pluginId: string;
  extension: PluginViewTextSource;
}

/** The text fields of one `ui[]` entry. */
export interface PluginViewTextSource {
  displayName?: string;
  title: string;
  description?: string;
  locales?: PluginTextLocales<ViewTextField>;
}

/**
 * The short label: language by language — exact UI tag, its base language,
 * then the entry's own fields — the author-chosen `displayName` ahead of the
 * required `title`; the plugin id as the last resort.
 */
export function getPluginViewLabel(item: PluginViewLabelSource, locale: string): string {
  return resolvePluginLocalizedText(item.extension, item.extension.locales, locale, ["displayName", "title"])
    ?? item.pluginId;
}

/** The entry's `title` in `locale` (exact tag → base language → own field). */
export function getPluginViewTitle(extension: PluginViewTextSource, locale: string): string | undefined {
  return resolvePluginLocalizedText(extension, extension.locales, locale, ["title"]);
}

/** The entry's `description` in `locale`, or `undefined` when none is declared. */
export function getPluginViewDescription(extension: PluginViewTextSource, locale: string): string | undefined {
  return resolvePluginLocalizedText(extension, extension.locales, locale, ["description"]);
}
