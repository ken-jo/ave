/**
 * Installed content packages (blueprint P3). Covers:
 * ave:marketplace:content:installed, ave:marketplace:content:language-messages,
 * the `ave-content:` asset scheme, and how content takes effect in main.
 *
 * The store under `~/.ave/packages` is loaded once, on the renderer's first
 * request at boot: installed languages join the main process's locale
 * registry (dialogs, menus and notifications use them too), installed theme
 * ids become valid plugin theme broadcasts, and fonts and theme previews are
 * served through the asset scheme. Installing and removing packages comes with
 * the install IPC; the activation below is what those calls run.
 */
import { ipcMain, protocol } from "electron";
import { randomBytes } from "node:crypto";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { CHANNELS } from "../../contract/app-contract.js";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES, registerInstalledLocales, setInstalledCatalogLoader } from "../../i18n/index.js";
import { messages } from "../../i18n/messages/index.js";
import { createLogger } from "../../lib/logger.js";
import { InstalledContentService } from "../../marketplace/content/service.js";
import { AgentPluginMcpRuntime } from "../../marketplace/content/agent-plugin-mcp-runtime.js";
import { ContentStore, type ContentActivation } from "../../marketplace/content/store.js";
import type { ParsedContent } from "../../marketplace/content/kinds.js";
import type { LedgerEntry } from "../../marketplace/content/ledger.js";
import { MarketplaceError } from "../../marketplace/errors.js";
import { legacySelectedThemes, type LegacyActivations } from "../../marketplace/migration/legacy-content.js";
import { installContentAssetProtocolHandler } from "../../main/content-asset-protocol.js";
import { applyBootLocale } from "../../boot/services.js";
import { revocationRegistry } from "../../plugins/revocation/revocation-registry.js";
import { installedFontStack, type InstalledContentResult, type InstalledContentView } from "../../shared/installed-content.js";
import { isMarketplaceEligibleLLMVendor } from "../../shared/llm-vendor-defaults.js";
import { aveHome } from "../../shared/ave-home.js";
import { setInstalledThemeIds } from "../../shared/plugin-theme-cache.js";
import { DEFAULT_BUNDLE_ID } from "../../shared/theme-bundles.js";
import { errorMessage } from "../../shared/error-message.js";
import type { McpComponentConsent } from "../../shared/git-marketplace.js";
import { auditUnauthorized, UNAUTHORIZED_FRAME, validateHostRendererSender } from "../gated.js";
import type { IpcDeps } from "../types.js";
import { broadcastSettingsSnapshot, mutateMarketplaceProviderPresets } from "./settings.js";
import { broadcastPromptsUpdated } from "../prompt-broadcast.js";
import { openFeatureNamespace } from "../../main/storage/feature-namespace.js";
import { bundledCredentialKey } from "../../mcp/bundled-credential.js";

const log = createLogger("marketplace-content");

/** `~/.ave/packages` (design §2). */
function contentPackagesRoot(home: string = aveHome()): string {
  return join(home, "packages");
}

/**
 * The settings side of the first-boot content migration (design §16.3): the
 * activations the server marketplace left in settings, and the removal of the
 * theme ids and locales installed packages provide once it has adopted them.
 */
export function legacyContentSettings(deps: IpcDeps): {
  activations: LegacyActivations;
  release(provided: { themes: readonly string[]; locales: readonly string[] }): Promise<void>;
} {
  const settings = deps.settingsService;
  const marketplace = settings.get("marketplace");
  return {
    activations: {
      themes: [...marketplace.installedThemeBundleIds, ...legacySelectedThemes(settings.get("appearance"))],
      locales: [...marketplace.installedLanguagePacks],
      providers: [...marketplace.installedProviderIds, ...marketplace.installedProviderPresets.map((preset) => preset.providerId)],
    },
    async release(provided) {
      const current = settings.get("marketplace");
      await settings.patch({
        marketplace: {
          installedThemeBundleIds: current.installedThemeBundleIds.filter((id) => !provided.themes.includes(id)),
          installedLanguagePacks: current.installedLanguagePacks.filter((locale) => !provided.locales.includes(locale)),
        },
      });
      await broadcastSettingsSnapshot(deps);
    },
  };
}

/**
 * How installed content takes effect in this app. Providers go through the
 * same preset path the settings IPC uses and messaging connections through
 * the same settings field; removing a theme, language or font
 * that is selected puts its setting back to the default.
 *
 * A settings write that fails throws, so the store undoes the install (or
 * keeps the package on uninstall). Once the write has landed, what follows —
 * the reviewer rewire, the provider refresh, the broadcast — is logged when it
 * fails, never thrown: settings already changed, and undoing the ledger would
 * leave them describing a package that is not installed.
 */
export function createContentActivation(deps: IpcDeps, mcpRuntime?: AgentPluginMcpRuntime): ContentActivation {
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
  /** Whether the settings already hold this package's id from another path (design §15.1). */
  const heldBySettings = (content: ParsedContent): boolean => {
    const marketplace = settings.get("marketplace");
    return content.kind === "provider"
      ? "vendor" in content
        ? marketplace.installedProviderIds.includes(content.vendor.providerId)
        : marketplace.installedProviderPresets.some((preset) => preset.providerId === content.preset.providerId)
      : content.kind === "messaging-connection" && marketplace.installedMessagingConnections.some((entry) => entry.connectionId === content.connection.connectionId);
  };

  return {
    async activate(content: ParsedContent, entry: LedgerEntry, previous: LedgerEntry | null, adopt: boolean, dir?: string, approvedMcpServers: readonly McpComponentConsent[] = []) {
      if (content.kind === "agent-plugin") {
        if (!mcpRuntime || !dir) throw new Error("agent plugin MCP activation requires its installed directory and runtime");
        await mcpRuntime.activate({ name: entry.name, version: entry.version, generationId: entry.origin.contentSha256, dir, content }, approvedMcpServers);
        return;
      }
      if (approvedMcpServers.length > 0) throw new Error("MCP component consent applies only to an agent plugin");
      if (!previous && heldBySettings(content)) {
        // Adopting a legacy activation (design §16.3): the settings already describe it, so they stay as they are.
        if (adopt) return;
        throw new MarketplaceError("PACKAGE_ID_CONFLICT", "settings already hold this id from another install; remove it there first");
      }
      if (!previous && (content.kind === "skill" || content.kind === "agent")) {
        const held = content.kind === "skill" ? await deps.skillStore?.userSkillFile(entry.name) : await deps.agentProfileStore?.userProfileFile(entry.name);
        // The user's own file wins in the store, so the package would never apply; replacing it is theirs to do.
        if (held) throw new MarketplaceError("PACKAGE_ID_CONFLICT", `${held} already defines ${content.kind} ${entry.name}; rename or remove it first`);
      }
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
      // Themes, languages, fonts, skills and agents are read from the loaded store; selecting one is the user's.
    },
    async deactivate(entry: LedgerEntry, content: ParsedContent | null) {
      if (entry.kind === "agent-plugin") {
        if (!mcpRuntime) throw new Error("agent plugin MCP deactivation requires its runtime");
        await mcpRuntime.deactivate(entry.name);
        return;
      }
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

/** The loaded store, its service, and the reload an install or uninstall runs. */
export interface InstalledContentRuntime {
  store: ContentStore;
  service: InstalledContentPort;
  /** Re-read the store and apply it in main again. */
  reload(): Promise<void>;
  removeAgentPluginData(name: string, serverNames: readonly string[]): Promise<void>;
}

export async function removeAgentPluginData(settings: Pick<IpcDeps["settingsService"], "deleteSecret">, name: string, serverNames: readonly string[]): Promise<void> {
  if (!/^[a-z][a-z0-9-]*$/u.test(name)) throw new Error("invalid agent plugin package name");
  const operations = serverNames.map((server) => settings.deleteSecret(
    bundledCredentialKey({ kind: "agent-plugin", name }, server)));
  operations.push(rm(join(openFeatureNamespace("agent-plugin-data").dir, name), { recursive: true, force: true }));
  const results = await Promise.allSettled(operations);
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failures.length > 0) throw new AggregateError(failures.map((result) => result.reason), "agent plugin data removal failed");
}

/** Apply the loaded content to this process: locales, theme ids, and the skill and agent stores. */
async function applyInMain(deps: IpcDeps, service: InstalledContentService, view: InstalledContentView, mcpRuntime: AgentPluginMcpRuntime): Promise<void> {
  for (const broken of view.broken) log.warn(broken, "installed content package not applied");
  registerInstalledLocales(view.languages);
  setInstalledCatalogLoader(async (locale) => service.languageMessages(locale));
  setInstalledThemeIds(view.themes.map((theme) => theme.id));
  const instructions = service.installedInstructions();
  deps.skillStore?.setInstalledPackages(instructions.filter((item) => item.kind === "skill"));
  deps.agentProfileStore?.setInstalledPackages(instructions.filter((item) => item.kind === "agent"));
  const agentPlugins = service.installedAgentPlugins();
  deps.skillStore?.setInstalledAgentPlugins(agentPlugins);
  deps.agentProfileStore?.setInstalledAgentPlugins(agentPlugins);
  deps.personaPromptStore?.setInstalledAgentPlugins(agentPlugins);
  if (service.installedAgentPluginRuntime().some((item) => Object.keys(item.content.components.mcpServers).length > 0)) {
    deps.mcpManager.registerBundledCredentialSource("agent-plugin", {
      list: () => service.installedAgentPluginRuntime().flatMap((item) => Object.entries(item.content.components.mcpServers).map(([serverName, server]) => ({
        packageName: item.name, serverName, transport: server.transport,
        ...(server.transport === "stdio" ? { command: server.command, apiKeyEnv: server.apiKeyEnv } : { url: server.url, apiKeyHeader: server.apiKeyHeader }),
        ...(server.auth ? { auth: server.auth } : {}),
      }))),
      reconnect: async (packageName, serverName) => {
        const item = service.installedAgentPluginRuntime().find((installed) => installed.name === packageName);
        if (!item || !Object.hasOwn(item.content.components.mcpServers, serverName)) throw new Error("bundled MCP component is no longer installed");
        await mcpRuntime.reconnect(item);
      },
    });
  }
  await mcpRuntime.sync(service.installedAgentPluginRuntime());
  broadcastPromptsUpdated(deps);
}

/**
 * Open the store and apply what it holds to this process. A ledger that
 * cannot be read leaves every installed package unapplied (and logged)
 * rather than stopping the app.
 */
export async function loadInstalledContent(deps: IpcDeps, assetToken: string, root: string = contentPackagesRoot()): Promise<InstalledContentRuntime> {
  const mcpRuntime = new AgentPluginMcpRuntime(deps.mcpManager);
  const store = await ContentStore.open({
    root,
    english: messages.en,
    activation: createContentActivation(deps, mcpRuntime),
  });
  const service = new InstalledContentService(store, assetToken, (kind, name, version) => {
    const decision = revocationRegistry.evaluate(kind, name, version);
    return decision.kind === "block" ? `revoked by ${decision.sourceId}: ${decision.reason}` : null;
  });
  await applyInMain(deps, service, await service.reload(), mcpRuntime);
  // Settings were read before the ledger: apply an installed language the user selected.
  await applyBootLocale(deps.settingsService);
  return {
    store,
    service,
    async reload() {
      await applyInMain(deps, service, await service.reload(), mcpRuntime);
    },
    async removeAgentPluginData(name, serverNames) {
      await removeAgentPluginData(deps.settingsService, name, serverNames);
    },
  };
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
  load: () => Promise<InstalledContentRuntime> = () => loadInstalledContent(deps, assetToken),
): () => Promise<InstalledContentRuntime | null> {
  let ready: Promise<InstalledContentRuntime | null> | null = null;
  const loaded = () =>
    (ready ??= load().catch((error: unknown) => {
      log.error({ err: errorMessage(error) }, "installed content could not be loaded");
      return null;
    }));
  installContentAssetProtocolHandler(protocol, assetToken, async (kind, name, path) => (await loaded())?.service.servedFile(kind, name, path) ?? null);

  ipcMain.handle(CHANNELS.marketplaceContent.installed, async (event): Promise<InstalledContentResult | typeof UNAUTHORIZED_FRAME> => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(deps.auditLogger, CHANNELS.marketplaceContent.installed, event);
      return UNAUTHORIZED_FRAME;
    }
    const runtime = await loaded();
    if (!runtime) return { ok: false, error: "installed-content-unavailable" };
    if (!deps.pluginBundleLifecycle) throw new Error("installed content requires the extension generation lifecycle");
    const content = runtime.service.installed();
    return { ok: true, content: {
      ...content,
      routineTemplates: [...content.routineTemplates, ...deps.pluginBundleLifecycle.listRoutineTemplates()],
    } };
  });

  ipcMain.handle(CHANNELS.marketplaceContent.languageMessages, async (event, locale: unknown) => {
    if (!validateHostRendererSender(event)) {
      auditUnauthorized(deps.auditLogger, CHANNELS.marketplaceContent.languageMessages, event);
      return UNAUTHORIZED_FRAME;
    }
    if (typeof locale !== "string") return { ok: false, error: "invalid-locale" };
    const runtime = await loaded();
    if (!runtime) return { ok: false, error: "installed-content-unavailable" };
    try {
      return { ok: true, messages: runtime.service.languageMessages(locale) };
    } catch (error) {
      return { ok: false, error: "language-not-installed", message: errorMessage(error) };
    }
  });

  return loaded;
}
