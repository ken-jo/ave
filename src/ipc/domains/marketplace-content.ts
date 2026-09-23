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
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { CHANNELS } from "../../contract/app-contract.js";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, registerInstalledLocales, setInstalledCatalogLoader } from "../../i18n/index.js";
import { messages } from "../../i18n/messages/index.js";
import { createLogger } from "../../lib/logger.js";
import { InstalledContentService } from "../../marketplace/content/service.js";
import { ContentStore, type ContentActivation } from "../../marketplace/content/store.js";
import type { ParsedContent } from "../../marketplace/content/kinds.js";
import type { LedgerEntry } from "../../marketplace/content/ledger.js";
import { MarketplaceError } from "../../marketplace/errors.js";
import { installContentAssetProtocolHandler } from "../../main/content-asset-protocol.js";
import { applyBootLocale } from "../../boot/services.js";
import { installedFontStack, type InstalledContentResult } from "../../shared/installed-content.js";
import { isMarketplaceEligibleLLMVendor } from "../../shared/llm-vendor-defaults.js";
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
 *
 * A settings write that fails throws, so the store undoes the install (or
 * keeps the package on uninstall). Once the write has landed, what follows —
 * the reviewer rewire, the provider refresh, the broadcast — is logged when it
 * fails, never thrown: settings already changed, and undoing the ledger would
 * leave them describing a package that is not installed.
 */
export function createContentActivation(deps: IpcDeps): ContentActivation {
  const settings = deps.settingsService;
  const afterPersist = async (what: string, finishError: { message: string } | null, broadcast = false) => {
    if (finishError) log.warn({ err: finishError.message }, `${what}: settings saved, refresh failed`);
    if (!broadcast) return;
    try {
      await broadcastSettingsSnapshot(deps);
    } catch (error) {
      log.warn({ err: errorMessage(error) }, `${what}: settings saved, broadcast failed`);
    }
  };
  /**
   * Run a settings write with the vendor's saved key set aside: the key is
   * removed before the write, so it never sits next to an address it was not
   * entered for, and put back if the write fails, so a failed install costs
   * the user nothing.
   */
  const withoutVendorKey = async <T>(vendorId: string, write: () => Promise<T>): Promise<T> => {
    const secretKey = `llm.apiKey.${vendorId}`;
    let saved: string | null = null;
    let present = true;
    try {
      saved = settings.getSecret(secretKey);
      present = saved !== null;
    } catch (error) {
      // A key that cannot be decrypted is unusable anyway: remove it, with nothing to put back.
      log.warn({ err: errorMessage(error) }, `the saved ${vendorId} key cannot be read; removing it`);
    }
    if (present) await settings.deleteSecret(secretKey);
    try {
      return await write();
    } catch (error) {
      if (saved !== null) {
        await settings.setSecret(secretKey, saved).catch((restoreError: unknown) => {
          log.error({ err: errorMessage(restoreError) }, `could not restore the ${vendorId} key after a failed settings write`);
        });
      }
      throw error;
    }
  };
  const connectionsWithout = (connectionId: string) =>
    settings.get("marketplace").installedMessagingConnections.filter((entry) => entry.connectionId !== connectionId);
  /** A first install may not take an id the settings already hold from another path (design §15.1). */
  const assertUnclaimed = (content: ParsedContent) => {
    const marketplace = settings.get("marketplace");
    const held =
      content.kind === "provider"
        ? "vendor" in content
          ? marketplace.installedProviderIds.includes(content.vendor.providerId)
          : marketplace.installedProviderPresets.some((preset) => preset.providerId === content.preset.providerId)
        : content.kind === "messaging-connection" &&
          marketplace.installedMessagingConnections.some((entry) => entry.connectionId === content.connection.connectionId);
    if (held) throw new MarketplaceError("PACKAGE_ID_CONFLICT", "settings already hold this id from another install; remove it there first");
  };

  return {
    async activate(content: ParsedContent, entry: LedgerEntry, previous: LedgerEntry | null) {
      if (!previous) assertUnclaimed(content);
      if (content.kind === "provider" && "vendor" in content) {
        const { providerId, defaultModel, baseUrl } = content.vendor;
        const installed = settings.get("marketplace").installedProviderIds;
        const vendor = { ...(defaultModel ? { model: defaultModel } : {}), ...(baseUrl ? { baseUrl } : {}) };
        const write = () =>
          settings.patch({
            marketplace: { installedProviderIds: installed.includes(providerId) ? installed : [...installed, providerId] },
            ...(Object.keys(vendor).length > 0 ? { llm: { vendors: { [providerId]: vendor } } } : {}),
          });
        // A key the user saved for the vendor was entered for the address it had then: moving the
        // address drops the key, as a preset whose base URL changes does, so it never reaches the new host.
        const moves = baseUrl !== undefined && settings.get("llm").vendors[providerId]?.baseUrl !== baseUrl;
        const { finishError } = await mutateMarketplaceProviderPresets(deps, () => (moves ? withoutVendorKey(providerId, write) : write()));
        await afterPersist(`activating ${entry.name}`, finishError);
      } else if (content.kind === "provider") {
        const { finishError } = await mutateMarketplaceProviderPresets(deps, () => settings.installMarketplaceProviderPreset(content.preset));
        await afterPersist(`activating ${entry.name}`, finishError);
      } else if (content.kind === "messaging-connection") {
        await settings.patch({ marketplace: { installedMessagingConnections: [...connectionsWithout(content.connection.connectionId), content.connection] } });
        await afterPersist(`activating ${entry.name}`, null, true);
      }
      // Themes, languages and fonts are read from the loaded store; selecting one is the user's.
    },
    async deactivate(entry: LedgerEntry, content: ParsedContent | null) {
      const appearance = settings.get("appearance");
      const what = `deactivating ${entry.name}`;
      if (entry.kind === "provider") {
        // The provider id is the package name; a vendor package unlocked a built-in vendor. Its key
        // goes with it: it may have been entered for the address the package set, and must not reach
        // the vendor's own host if the vendor is turned on again another way.
        const { finishError } = await mutateMarketplaceProviderPresets(deps, () =>
          isMarketplaceEligibleLLMVendor(entry.name)
            ? withoutVendorKey(entry.name, () =>
                settings.patch({ marketplace: { installedProviderIds: settings.get("marketplace").installedProviderIds.filter((id) => id !== entry.name) } }),
              )
            : settings.uninstallMarketplaceProviderPreset(entry.name),
        );
        await afterPersist(what, finishError);
        return;
      }
      if (entry.kind === "messaging-connection") {
        await settings.patch({ marketplace: { installedMessagingConnections: connectionsWithout(entry.name) } });
      } else if (entry.kind === "theme" && appearance.bundleId === entry.name) {
        await settings.patch({ appearance: { ...appearance, bundleId: DEFAULT_BUNDLE_ID } });
      } else if (
        content?.kind === "language" &&
        appearance.language === content.locale &&
        !(SUPPORTED_LOCALES as readonly string[]).includes(content.locale)
      ) {
        // A compiled locale's package only overlays it: the compiled catalog still renders it.
        await settings.patch({ appearance: { ...appearance, language: DEFAULT_LOCALE } });
      } else if (entry.kind === "font" && appearance.font?.family === installedFontStack(entry.name)) {
        await settings.patch({ appearance: { ...appearance, font: { ...appearance.font, family: "system" } } });
      } else {
        return;
      }
      await afterPersist(what, null, true);
    },
  };
}

type InstalledContentPort = Pick<InstalledContentService, "installed" | "languageMessages" | "servedFile">;

/**
 * Open the store and apply what it holds to this process. A ledger that
 * cannot be read leaves every installed package unapplied (and logged)
 * rather than stopping the app.
 */
export async function loadInstalledContent(deps: IpcDeps, assetToken: string, root: string = contentPackagesRoot()): Promise<InstalledContentPort> {
  const store = await ContentStore.open({
    root,
    english: messages.en,
    activation: createContentActivation(deps),
  });
  const service = new InstalledContentService(store, assetToken);
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
 * a test that registers every handler, reads nothing under `~/.ave/packages`.
 * The `ave-content:` handler is registered here, before any window loads,
 * because a frame binds its custom-scheme loaders when it commits: a handler
 * added after the page loaded answers `ERR_UNKNOWN_URL_SCHEME` to that page.
 * An asset request waits for the same load.
 */
export function registerMarketplaceContentHandlers(
  deps: IpcDeps,
  // Drawn once per launch: the host of every `ave-content:` URL (see content-asset-protocol.ts).
  assetToken: string = `t${randomBytes(16).toString("hex")}`,
  load: () => Promise<InstalledContentPort> = () => loadInstalledContent(deps, assetToken),
): void {
  let ready: Promise<InstalledContentPort | null> | null = null;
  const loaded = () =>
    (ready ??= load().catch((error: unknown) => {
      log.error({ err: errorMessage(error) }, "installed content could not be loaded");
      return null;
    }));
  installContentAssetProtocolHandler(protocol, assetToken, async (kind, name, path) => (await loaded())?.servedFile(kind, name, path) ?? null);

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
    if (typeof locale !== "string") return { ok: false, error: "invalid-locale" };
    const service = await loaded();
    if (!service) return { ok: false, error: "installed-content-unavailable" };
    try {
      return { ok: true, messages: service.languageMessages(locale) };
    } catch (error) {
      return { ok: false, error: "language-not-installed", message: errorMessage(error) };
    }
  });
}
