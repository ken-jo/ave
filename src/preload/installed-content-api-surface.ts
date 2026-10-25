/** Installed-content capabilities are host-only; plugin and public frames receive none. */
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
