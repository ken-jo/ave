/**
 * Narrow host-renderer bridge for installed content packages (blueprint P3):
 * the themes, languages and fonts the settings pickers list, and the catalog
 * of an installed language. Plugin frames and public surfaces never receive it.
 */
import { ipcRenderer } from "electron";
import { CHANNELS } from "../contract/app-contract.js";
import {
  parseInstalledContentResult,
  parseLanguageMessagesResult,
  type InstalledContentApi,
  type InstalledContentResult,
  type LanguageMessagesResult,
} from "../shared/installed-content.js";

const UNAVAILABLE = Object.freeze({ ok: false, error: "installed-content-unavailable" }) as { ok: false; error: string };

/** Build the private `window.aveApi.installedContent` namespace. */
export function buildInstalledContentApiSurface(): InstalledContentApi {
  return Object.freeze({
    async installed(): Promise<InstalledContentResult> {
      try {
        return parseInstalledContentResult(await ipcRenderer.invoke(CHANNELS.marketplaceContent.installed)) ?? UNAVAILABLE;
      } catch {
        return UNAVAILABLE;
      }
    },

    async languageMessages(locale: string): Promise<LanguageMessagesResult> {
      try {
        return parseLanguageMessagesResult(await ipcRenderer.invoke(CHANNELS.marketplaceContent.languageMessages, locale)) ?? UNAVAILABLE;
      } catch {
        return UNAVAILABLE;
      }
    },
  });
}
