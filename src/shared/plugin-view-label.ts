/** Shared labels keep all plugin surfaces consistent; explicit locale inputs let callers resolve and update at the right moment. */
import { resolvePluginLocalizedText, type PluginTextLocales } from "./plugin-localized-text.js";

type ViewTextField = "displayName" | "title" | "description";

export interface PluginViewLabelSource {
  pluginId: string;
  extension: PluginViewTextSource;
}

export interface PluginViewTextSource {
  displayName?: string;
  title: string;
  description?: string;
  locales?: PluginTextLocales<ViewTextField>;
}

/** Within each locale, prefer displayName over title; try exact tag, base language, own fields, then plugin ID. */
export function getPluginViewLabel(item: PluginViewLabelSource, locale: string): string {
  return resolvePluginLocalizedText(item.extension, item.extension.locales, locale, ["displayName", "title"])
    ?? item.pluginId;
}

export function getPluginViewTitle(extension: PluginViewTextSource, locale: string): string | undefined {
  return resolvePluginLocalizedText(extension, extension.locales, locale, ["title"]);
}

export function getPluginViewDescription(extension: PluginViewTextSource, locale: string): string | undefined {
  return resolvePluginLocalizedText(extension, extension.locales, locale, ["description"]);
}
