/**
 * Installed content packages (blueprint P3). Covers:
 * ave:marketplace:content:installed, ave:marketplace:content:language-messages,
 * the `ave-content:` asset scheme, and how content takes effect in main.
 *
 * The store under `~/.ave/packages` is loaded once, on the renderer's first
 * request at boot: installed languages join the main process's locale
 * registry (dialogs, menus and notifications use them too), installed theme
 * ids become valid plugin theme broadcasts, and fonts and theme previews are
 * served through the asset scheme. Installing and removing packages comes with the install IPC
 * (blueprint 6.1); the activation below is what those calls run.
 */
import { ipcMain, protocol } from "electron";
import { join } from "node:path";
import { CHANNELS } from "../../contract/app-contract.js";
import { DEFAULT_LOCALE, registerInstalledLocales, setInstalledCatalogLoader } from "../../i18n/index.js";
import { messages } from "../../i18n/messages/index.js";
import { createLogger } from "../../lib/logger.js";
import { InstalledContentService } from "../../marketplace/content/service.js";
import { ContentStore, type ContentActivation } from "../../marketplace/content/store.js";
import type { ParsedContent } from "../../marketplace/content/kinds.js";
import type { LedgerEntry } from "../../marketplace/content/ledger.js";
import { installContentAssetProtocolHandler } from "../../main/content-asset-protocol.js";
import { applyBootLocale } from "../../boot/services.js";
import { installedFontStack, type InstalledContentResult } from "../../shared/installed-content.js";
import { aveHome } from "../../shared/ave-home.js";
import { setInstalledThemeIds } from "../../shared/plugin-theme-cache.js";
import { DEFAULT_BUNDLE_ID } from "../../shared/theme-bundles.js";
import { errorMessage } from "../../shared/error-message.js";
import { auditUnauthorized, UNAUTHORIZED_FRAME, validateHostRendererSender } from "../gated.js";
import type { IpcDeps } from "../types.js";
import { broadcastSettingsSnapshot, mutateMarketplaceProviderPresets } from "./settings.js";

const log = createLogger("marketplace-content");

/** `~/.ave/packages` (design §2). */
function contentPackagesRoot(home: string = aveHome()): string {
  return join(home, "packages");
}

/**
 * How installed content takes effect in this app. Providers go through the
 * same preset path the settings IPC uses and messaging connections through
 * the same settings field (blueprint 3.5); removing a theme, language or font
 * that is selected puts its setting back to the default.
 */
export function createContentActivation(deps: IpcDeps): ContentActivation {
  const settings = deps.settingsService;
  const throwOnFinishError = ({ finishError }: { finishError: { message: string } | null }) => {
    if (finishError) throw new Error(finishError.message);
  };
  const connectionsWithout = (connectionId: string) =>
    settings.get("marketplace").installedMessagingConnections.filter((entry) => entry.connectionId !== connectionId);

  return {
    async activate(content: ParsedContent) {
      if (content.kind === "provider") {
        throwOnFinishError(await mutateMarketplaceProviderPresets(deps, () => settings.installMarketplaceProviderPreset(content.preset)));
      } else if (content.kind === "messaging-connection") {
        await settings.patch({ marketplace: { installedMessagingConnections: [...connectionsWithout(content.connection.connectionId), content.connection] } });
        await broadcastSettingsSnapshot(deps);
      }
      // Themes, languages and fonts are read from the loaded store; selecting one is the user's.
    },
    async deactivate(entry: LedgerEntry, content: ParsedContent | null) {
      const appearance = settings.get("appearance");
      if (entry.kind === "provider") {
        throwOnFinishError(await mutateMarketplaceProviderPresets(deps, () => settings.uninstallMarketplaceProviderPreset(entry.name)));
        return;
      }
      if (entry.kind === "messaging-connection") {
        await settings.patch({ marketplace: { installedMessagingConnections: connectionsWithout(entry.name) } });
      } else if (entry.kind === "theme" && appearance.bundleId === entry.name) {
        await settings.patch({ appearance: { ...appearance, bundleId: DEFAULT_BUNDLE_ID } });
      } else if (content?.kind === "language" && appearance.language === content.locale) {
        await settings.patch({ appearance: { ...appearance, language: DEFAULT_LOCALE } });
      } else if (content?.kind === "font" && appearance.font?.family === installedFontStack(content.family)) {
        await settings.patch({ appearance: { ...appearance, font: { ...appearance.font, family: "system" } } });
      } else {
        return;
      }
      await broadcastSettingsSnapshot(deps);
    },
  };
}

type InstalledContentPort = Pick<InstalledContentService, "installed" | "languageMessages" | "servedFile">;

/**
 * Open the store and apply what it holds to this process. A ledger that
 * cannot be read leaves every installed package unapplied (and logged)
 * rather than stopping the app.
 */
async function loadInstalledContent(deps: IpcDeps): Promise<InstalledContentPort> {
  const store = await ContentStore.open({
    root: contentPackagesRoot(),
    englishKeys: new Set(Object.keys(messages.en)),
    activation: createContentActivation(deps),
  });
  const service = new InstalledContentService(store);
  const view = await service.reload();
  for (const broken of view.broken) log.warn(broken, "installed content package not applied");
  registerInstalledLocales(view.languages);
  setInstalledCatalogLoader(async (locale) => service.languageMessages(locale));
  setInstalledThemeIds(view.themes.map((theme) => theme.id));
  // Settings were read before the ledger: apply an installed language the user selected.
  await applyBootLocale(deps.settingsService);
  return service;
}

/**
 * The store loads on the first request, which the renderer makes while it
 * boots (theme and language hydration): a process that never asks, such as
 * a test that registers every handler, reads nothing under `~/.ave/packages`
 * and installs no scheme handler. The `ave-content:` handler is in place
 * before the first answer lists a font, so no font URL is ever unserved.
 */
export function registerMarketplaceContentHandlers(
  deps: IpcDeps,
  load: () => Promise<InstalledContentPort> = () => loadInstalledContent(deps),
): void {
  let ready: Promise<InstalledContentPort | null> | null = null;
  const loaded = () =>
    (ready ??= load()
      .then((service) => {
        installContentAssetProtocolHandler(protocol, (kind, name, path) => service.servedFile(kind, name, path));
        return service;
      })
      .catch((error: unknown) => {
        log.error({ err: errorMessage(error) }, "installed content could not be loaded");
        return null;
      }));

  ipcMain.handle(CHANNELS.marketplaceContent.installed, async (event): Promise<InstalledContentResult | typeof UNAUTHORIZED_FRAME> => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(deps.auditLogger, CHANNELS.marketplaceContent.installed, event);
      return UNAUTHORIZED_FRAME;
    }
    const service = await loaded();
    if (!service) return { ok: false, error: "installed-content-unavailable" };
    return { ok: true, content: service.installed() };
  });

  ipcMain.handle(CHANNELS.marketplaceContent.languageMessages, async (event, locale: unknown) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(deps.auditLogger, CHANNELS.marketplaceContent.languageMessages, event);
      return UNAUTHORIZED_FRAME;
    }
    const service = await loaded();
    if (!service || typeof locale !== "string") return { ok: false, error: "installed-content-unavailable" };
    try {
      return { ok: true, messages: service.languageMessages(locale) };
    } catch (error) {
      return { ok: false, error: "language-not-installed", message: errorMessage(error) };
    }
  });
}
