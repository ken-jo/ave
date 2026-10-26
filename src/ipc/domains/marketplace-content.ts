// Load installed content lazily during renderer hydration; settings own activation and removal defaults.
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
import { AgentPluginHookRuntime } from "../../marketplace/content/agent-plugin-hook-runtime.js";
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
import type { ComponentConsent, HookComponentConsent, McpComponentConsent } from "../../shared/git-marketplace.js";
import { auditUnauthorized, UNAUTHORIZED_FRAME, validateHostRendererSender } from "../gated.js";
import type { IpcDeps } from "../types.js";
import { broadcastSettingsSnapshot, mutateMarketplaceProviderPresets } from "./settings.js";
import { broadcastPromptsUpdated } from "../prompt-broadcast.js";
import { agentPluginDataRoot, assertAgentPluginPackageName } from "../../marketplace/content/agent-plugin-data.js";
import { removePluginTreeNowOrAtBoot } from "../../plugins/installed-entry-fs.js";
import { bundledCredentialKey } from "../../mcp/bundled-credential.js";

const log = createLogger("marketplace-content");

function contentPackagesRoot(home: string = aveHome()): string {
  return join(home, "packages");
}

// Migrate existing package activations without retaining obsolete compiled theme or locale registrations.
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

// Use normal settings paths for activation; failed writes roll the store back to the prior install.
export function createContentActivation(deps: IpcDeps, mcpRuntime?: AgentPluginMcpRuntime, hookRuntime?: AgentPluginHookRuntime): ContentActivation {
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
  const connectionsWithout = (connectionId: string) =>
    settings.get("marketplace").installedMessagingConnections.filter((entry) => entry.connectionId !== connectionId);
  const heldBySettings = (content: ParsedContent): boolean => {
    const marketplace = settings.get("marketplace");
    return content.kind === "provider"
      ? "vendor" in content
        ? marketplace.installedProviderIds.includes(content.vendor.providerId)
        : marketplace.installedProviderPresets.some((preset) => preset.providerId === content.preset.providerId)
      : content.kind === "messaging-connection" && marketplace.installedMessagingConnections.some((entry) => entry.connectionId === content.connection.connectionId);
  };

  const activateAgentPlugin = async (content: ParsedContent & { kind: "agent-plugin" }, entry: LedgerEntry, dir: string | undefined, componentConsents: readonly ComponentConsent[]) => {
    if (!mcpRuntime || !dir) throw new Error("agent plugin MCP activation requires its installed directory and runtime");
    if (content.components.hooks.length > 0 && !hookRuntime) throw new Error("agent plugin hook activation requires its hook runner");
    const item = { name: entry.name, version: entry.version, generationId: entry.origin.contentSha256, dir, content };
    if (componentConsents.some((consent) => "kind" in consent && consent.kind === "extension")) {
      throw new Error("an extension component consent does not apply to an agent plugin");
    }
    const hookConsents = componentConsents.filter((consent): consent is HookComponentConsent => "kind" in consent && consent.kind === "hook");
    const mcpConsents = componentConsents.filter((consent): consent is McpComponentConsent => !("kind" in consent));
    if (hookConsents.length > 0 && !hookRuntime) throw new Error("hook consent requires the hook runner");
    const hooks = hookRuntime ? await hookRuntime.activate(item, hookConsents) : { rollback: async () => undefined, retired: Promise.resolve() };
    let servers: { retired: Promise<void> };
    try { servers = await mcpRuntime.activate(item, mcpConsents); }
    catch (error) { await hooks.rollback(); throw error; }
    return { retired: Promise.all([hooks.retired, servers.retired]).then(() => undefined) };
  };

  return {
    async approveComponents(entry: LedgerEntry, content: ParsedContent & { kind: "agent-plugin" }, dir: string, consents: readonly ComponentConsent[]) {
      await activateAgentPlugin(content, entry, dir, consents);
    },
    async activate(content: ParsedContent, entry: LedgerEntry, previous: LedgerEntry | null, adopt: boolean, dir?: string, componentConsents: readonly ComponentConsent[] = []) {
      if (content.kind === "agent-plugin") return activateAgentPlugin(content, entry, dir, componentConsents);
      if (componentConsents.length > 0) throw new Error("component consent applies only to an agent plugin");
      if (!previous && heldBySettings(content)) {
        if (adopt) return { retired: Promise.resolve() };
        throw new MarketplaceError("PACKAGE_ID_CONFLICT", "settings already hold this id from another install; remove it there first");
      }
      if (!previous && (content.kind === "skill" || content.kind === "agent")) {
        const held = content.kind === "skill" ? await deps.skillStore?.userSkillFile(entry.name) : await deps.agentProfileStore?.userProfileFile(entry.name);
        if (held) throw new MarketplaceError("PACKAGE_ID_CONFLICT", `${held} already defines ${content.kind} ${entry.name}; rename or remove it first`);
      }
      if (content.kind === "provider" && "vendor" in content) {
        // Bundled vendor configuration belongs to Settings, independent of package metadata.
        return { retired: Promise.resolve() };
      } else if (content.kind === "provider") {
        const { finishError } = await mutateMarketplaceProviderPresets(deps, () => settings.installMarketplaceProviderPreset(content.preset));
        await afterPersist(`activating ${entry.name}`, finishError);
      } else if (content.kind === "messaging-connection") {
        await settings.patch({ marketplace: { installedMessagingConnections: [...connectionsWithout(content.connection.connectionId), content.connection] } });
        await afterPersist(`activating ${entry.name}`, null, true);
      }
      // Reload passive content before retiring the replaced install's files.
      return { retired: Promise.resolve() };
    },
    async deactivate(entry: LedgerEntry, content: ParsedContent | null) {
      if (entry.kind === "agent-plugin") {
        if (!mcpRuntime) throw new Error("agent plugin MCP deactivation requires its runtime");
        await mcpRuntime.deactivate(entry.name);
        await hookRuntime?.deactivate(entry.name);
        return;
      }
      const appearance = settings.get("appearance");
      const what = `deactivating ${entry.name}`;
      if (entry.kind === "provider") {
        const { finishError } = await mutateMarketplaceProviderPresets(deps, () =>
          isMarketplaceEligibleLLMVendor(entry.name)
            ? settings.patch({ marketplace: { installedProviderIds: settings.get("marketplace").installedProviderIds.filter((id) => id !== entry.name) } })
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

export interface InstalledContentRuntime {
  store: ContentStore;
  service: InstalledContentPort;
  reload(): Promise<void>;
  removeAgentPluginData(name: string, serverNames: readonly string[]): Promise<void>;
  componentApprovals(name: string): Promise<AgentPluginComponentApprovals>;
  callsInFlight(name: string): boolean;
}

interface AgentPluginComponentApprovals {
  mcpServers: Array<{ name: string; approvalDigest: string | null; approved: boolean; recordDigest: string | null }>;
  hooks: Array<{ index: number; approvalDigest: string | null; approved: boolean; recordDigest: string | null }>;
}

export async function removeAgentPluginData(settings: Pick<IpcDeps["settingsService"], "deleteSecret">, name: string, serverNames: readonly string[]): Promise<void> {
  assertAgentPluginPackageName(name);
  const operations = serverNames.map((server) => settings.deleteSecret(
    bundledCredentialKey({ kind: "agent-plugin", name }, server)));
  // Servers may outlive uninstall; tombstone their data for the pre-confinement boot sweep.
  const dataRoot = agentPluginDataRoot();
  operations.push(removePluginTreeNowOrAtBoot(join(dataRoot, name), dataRoot, (path) => rm(path, { recursive: true, force: true })).then(() => undefined));
  const results = await Promise.allSettled(operations);
  const failures = results.filter((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failures.length > 0) throw new AggregateError(failures.map((result) => result.reason), "agent plugin data removal failed");
}

async function applyInMain(deps: IpcDeps, service: InstalledContentService, view: InstalledContentView, mcpRuntime: AgentPluginMcpRuntime, hookRuntime?: AgentPluginHookRuntime): Promise<void> {
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
  // Publish the installed set even without servers to retire stale sign-ins; failed loads cannot vouch for completeness.
  deps.mcpManager.registerBundledCredentialSource("agent-plugin", {
    installedPackages: async () => (view.broken.length === 0
      ? new Set(service.installedAgentPluginRuntime().map((item) => item.name)) : undefined),
    list: () => service.installedAgentPluginRuntime().flatMap((item) => Object.entries(item.content.components.mcpServers).map(([serverName, server]) => ({
      packageName: item.name, serverName, transport: server.transport,
      ...(server.transport === "stdio" ? { command: server.command, args: server.args, env: server.env,
        apiKeyEnv: server.apiKeyEnv } : { url: server.url, apiKeyHeader: server.apiKeyHeader }),
      ...(server.auth ? { auth: server.auth } : {}),
    }))),
    reconnect: async (packageName, serverName) => {
      const item = service.installedAgentPluginRuntime().find((installed) => installed.name === packageName);
      if (!item || !Object.hasOwn(item.content.components.mcpServers, serverName)) throw new Error("bundled MCP component is no longer installed");
      await mcpRuntime.reconnect(item);
    },
  });
  await mcpRuntime.sync(service.installedAgentPluginRuntime());
  if (service.installedAgentPluginRuntime().some((item) => item.content.components.hooks.length > 0) && !hookRuntime) {
    throw new Error("installed agent plugin hooks require the hook runner");
  }
  await hookRuntime?.sync(service.installedAgentPluginRuntime());
  broadcastPromptsUpdated(deps);
}

// An unreadable ledger leaves packages unapplied and logs the failure without stopping the app.
export async function loadInstalledContent(deps: IpcDeps, assetToken: string, root: string = contentPackagesRoot()): Promise<InstalledContentRuntime> {
  const mcpRuntime = new AgentPluginMcpRuntime(deps.mcpManager);
  const hookRuntime = deps.scriptHookManager ? new AgentPluginHookRuntime(deps.scriptHookManager) : undefined;
  const store = await ContentStore.open({
    root,
    english: messages.en,
    activation: createContentActivation(deps, mcpRuntime, hookRuntime),
  });
  const swept = await store.sweep();
  if (swept.length > 0) log.info({ count: swept.length }, "removed install directories no installed package names");
  const service = new InstalledContentService(store, assetToken, (kind, name, version) => {
    const decision = revocationRegistry.evaluate(kind, name, version);
    return decision.kind === "block" ? `revoked by ${decision.sourceId}: ${decision.reason}` : null;
  });
  await applyInMain(deps, service, await service.reload(), mcpRuntime, hookRuntime);
  await applyBootLocale(deps.settingsService);
  return {
    store,
    service,
    async reload() {
      await applyInMain(deps, service, await service.reload(), mcpRuntime, hookRuntime);
    },
    async removeAgentPluginData(name, serverNames) {
      await removeAgentPluginData(deps.settingsService, name, serverNames);
    },
    async componentApprovals(name) {
      return { mcpServers: await mcpRuntime.approvals(name), hooks: (await hookRuntime?.approvals(name)) ?? [] };
    },
    callsInFlight(name) {
      return mcpRuntime.hasCallsInFlight(name) || (hookRuntime?.hasCallsInFlight(name) ?? false);
    },
  };
}

// Register the asset scheme before windows load; lazy store reads keep unused processes out of package storage.
export function registerMarketplaceContentHandlers(
  deps: IpcDeps,
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
