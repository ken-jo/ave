/**
 * The installed-content IPC (blueprint P3): the `ave-content:` handler is
 * registered with the IPC handlers, before any window loads (a frame binds
 * its scheme loaders when it commits); nothing is loaded until the renderer
 * or an asset request first asks, the load runs once, and a failed load
 * answers "unavailable" (IPC) or 404 (assets) instead of throwing.
 */
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
  protocolHandle: vi.fn(),
}));

vi.mock("electron", () => ({
  ipcMain: { handle: (channel: string, handler: (event: unknown, ...args: unknown[]) => unknown) => electron.handlers.set(channel, handler) },
  protocol: { handle: electron.protocolHandle },
}));

vi.mock("../gated.js", () => ({
  auditUnauthorized: vi.fn(),
  UNAUTHORIZED_FRAME: { ok: false, error: "unauthorized" },
  validateHostRendererSender: () => true,
}));

import { CHANNELS } from "../../contract/app-contract.js";
import type { IpcDeps } from "../types.js";
import { getLocale, isInstalledLocale, registerInstalledLocales, setInstalledCatalogLoader, setLocale, translate } from "../../i18n/index.js";
import { loadLocaleMessages, messages as catalogs } from "../../i18n/messages/index.js";
import type { ParsedContent } from "../../marketplace/content/kinds.js";
import { deriveAgentPluginComponents } from "../../marketplace/content/agent-plugin-components.js";
import { ContentStore, type StagedContent } from "../../marketplace/content/store.js";
import type { PackagePlan } from "../../marketplace/resolve/descriptor.js";
import { EMPTY_MARKETPLACE_POLICY } from "../../marketplace/sources/policy.js";
import { treeDigest } from "../../marketplace/resolve/plugin-ladder.js";
import { setInstalledThemeIds } from "../../shared/plugin-theme-cache.js";
import { loadInstalledContent, registerMarketplaceContentHandlers } from "../domains/marketplace-content.js";

const TOKEN = "t0123456789abcdef0123456789abcdef";
/** No installed package here has an MCP server: the runtime only registers its lease source. */
const LEASE_ONLY_MCP = { registerGenerationLeaseSource: () => undefined };
const content = { themes: [], languages: [], fonts: [], routineTemplates: [], broken: [] };
const port = {
  installed: () => content,
  languageMessages: (locale: string) => {
    if (locale !== "fr") throw new Error(`${locale} is not installed`);
    return { "app.title": "Ave" };
  },
  servedFile: () => null,
};
const runtime = (service: typeof port) => ({
  store: {} as ContentStore,
  service,
  reload: async () => {},
  removeAgentPluginData: async () => {},
  componentApprovals: async () => ({ mcpServers: [], hooks: [] }),
  callsInFlight: () => false,
});
const installedDeps = (templates: unknown[] = []) => ({
  pluginBundleLifecycle: { listRoutineTemplates: () => templates },
} as unknown as IpcDeps);

type SchemeHandler = (request: { url: string; headers: Headers; referrer: string }) => Promise<Response>;
const assetRequest = (url: string) => ({ url, headers: new Headers({ origin: "null" }), referrer: "" });
const schemeHandler = (): SchemeHandler => {
  expect(electron.protocolHandle).toHaveBeenCalledWith("ave-content", expect.any(Function));
  return electron.protocolHandle.mock.calls[0]![1] as SchemeHandler;
};

describe("registerMarketplaceContentHandlers", () => {
  beforeEach(() => {
    electron.handlers.clear();
    electron.protocolHandle.mockClear();
  });

  it("registers the scheme handler up front and loads once, on the first request", async () => {
    const load = vi.fn(async () => runtime(port));
    registerMarketplaceContentHandlers(installedDeps(), TOKEN, load);
    schemeHandler();
    expect(load).not.toHaveBeenCalled();

    const installed = electron.handlers.get(CHANNELS.marketplaceContent.installed)!;
    const languageMessages = electron.handlers.get(CHANNELS.marketplaceContent.languageMessages)!;
    await expect(installed({})).resolves.toEqual({ ok: true, content });
    await expect(languageMessages({}, "fr")).resolves.toEqual({ ok: true, messages: { "app.title": "Ave" } });
    await expect(languageMessages({}, "de")).resolves.toMatchObject({ ok: false, error: "language-not-installed" });
    await expect(languageMessages({}, 42)).resolves.toEqual({ ok: false, error: "invalid-locale" });
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("includes active extension routine templates in the installed view", async () => {
    const template = { id: "daily", title: "Daily review", packageName: "orion-api", version: "1.0.0", sourceKind: "extension" };
    registerMarketplaceContentHandlers(installedDeps([template]), TOKEN, async () => runtime(port));
    await expect(electron.handlers.get(CHANNELS.marketplaceContent.installed)!({})).resolves.toMatchObject({
      ok: true, content: { routineTemplates: [template] },
    });
    expect(content.routineTemplates).toEqual([]);
  });

  it("serves an asset request through the same load, even before the renderer asks", async () => {
    const servedFile = vi.fn(() => null);
    const load = vi.fn(async () => runtime({ ...port, servedFile }));
    registerMarketplaceContentHandlers(installedDeps(), TOKEN, load);
    const response = await schemeHandler()(assetRequest(`ave-content://${TOKEN}/font/harbor-serif/files/a.woff2`));
    expect(response.status).toBe(404);
    expect(servedFile).toHaveBeenCalledWith("font", "harbor-serif", "files/a.woff2");
    // Without the launch token the request never reaches the store.
    servedFile.mockClear();
    expect((await schemeHandler()(assetRequest("ave-content://font/harbor-serif/files/a.woff2"))).status).toBe(404);
    expect((await schemeHandler()(assetRequest(`ave-content://t${"f".repeat(32)}/font/harbor-serif/files/a.woff2`))).status).toBe(404);
    expect(servedFile).not.toHaveBeenCalled();
    await electron.handlers.get(CHANNELS.marketplaceContent.installed)!({});
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("answers unavailable when the store cannot be loaded", async () => {
    registerMarketplaceContentHandlers({} as IpcDeps, TOKEN, async () => {
      throw new Error("ledger unreadable");
    });
    await expect(electron.handlers.get(CHANNELS.marketplaceContent.installed)!({})).resolves.toEqual({ ok: false, error: "installed-content-unavailable" });
    await expect(electron.handlers.get(CHANNELS.marketplaceContent.languageMessages)!({}, "fr")).resolves.toEqual({ ok: false, error: "installed-content-unavailable" });
    expect((await schemeHandler()(assetRequest(`ave-content://${TOKEN}/font/harbor-serif/files/a.woff2`))).status).toBe(404);
  });
});

describe("loadInstalledContent", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ave-installed-content-"));
  });
  afterEach(async () => {
    registerInstalledLocales([]);
    setInstalledCatalogLoader(null);
    setInstalledThemeIds([]);
    setLocale("en");
    await rm(root, { recursive: true, force: true });
  });

  /** Install `content` from `files` the way the install path does, without a git source. */
  async function install(kind: "language" | "skill" | "agent-plugin", name: string, files: Record<string, unknown>, content: ParsedContent, into?: ContentStore) {
    const list = Object.entries(files).map(([path, value]) => ({ path, data: Buffer.from(typeof value === "string" ? value : JSON.stringify(value)) }));
    const plan = { sourceId: "acme", sourceOrigin: "custom", snapshotCommit: "a".repeat(40), versionCommit: "a".repeat(40), packagePath: `${kind}s/${name}`, kind, name, version: "1.0.0", minAppVersion: "0.12.0" } as PackagePlan;
    const staged = { plan, files: list, contentSha256: treeDigest(list.map((file) => ({ ...file, executable: false }))), content, minAppVersion: "0.12.0", hostProtocol: null } as StagedContent;
    const store = into ?? (await ContentStore.open({ root, english: {}, activation: { activate: async () => ({ retired: Promise.resolve() }), deactivate: async () => {}, approveComponents: async () => {} } }));
    await store.install(staged);
  }

  it("applies what the store holds to this process: locales, their catalogs, theme ids and the selected language", async () => {
    const language = { locale: "fr", nativeName: "Français", englishName: "French" };
    // A real interface key: the loader checks the package against the compiled English catalog.
    const key = Object.keys(catalogs.en).find((candidate) => !candidate.startsWith("be_") && !catalogs.en[candidate]!.includes("{"))!;
    const messages = { [key]: "Envoyer" };
    await install("language", "french", { "language.json": language, "messages.json": messages }, { kind: "language", ...language, messages, missingKeys: [] });
    const settingsService = { get: () => ({ language: "fr" }) };

    const { service } = await loadInstalledContent({ settingsService, getAppWindows: () => [], mcpManager: LEASE_ONLY_MCP } as unknown as IpcDeps, TOKEN, root);
    expect(service.installed().languages.map((item) => item.locale)).toEqual(["fr"]);
    expect(isInstalledLocale("fr")).toBe(true);
    expect(await loadLocaleMessages("fr")).toMatchObject(messages);
    expect(getLocale()).toBe("fr");
    expect(translate("fr", key)).toBe("Envoyer");
  });

  it("lists nothing and applies nothing for an empty store", async () => {
    const { service } = await loadInstalledContent({ settingsService: { get: () => ({ language: "en" }) }, getAppWindows: () => [], mcpManager: LEASE_ONLY_MCP } as unknown as IpcDeps, TOKEN, root);
    expect(service.installed()).toEqual({ themes: [], languages: [], fonts: [], routineTemplates: [], broken: [] });
    expect(isInstalledLocale("fr")).toBe(false);
  });

  it("hands installed skills and agents to their stores, and reload applies an install made after load", async () => {
    const skillStore = { setInstalledPackages: vi.fn(), setInstalledAgentPlugins: vi.fn(), userSkillFile: async () => null };
    const agentProfileStore = { setInstalledPackages: vi.fn(), setInstalledAgentPlugins: vi.fn() };
    const deps = { settingsService: { get: () => ({ language: "en" }) }, skillStore, agentProfileStore, getAppWindows: () => [], mcpManager: LEASE_ONLY_MCP } as unknown as IpcDeps;
    const loaded = await loadInstalledContent(deps, TOKEN, root);
    expect(skillStore.setInstalledPackages).toHaveBeenLastCalledWith([]);
    expect(agentProfileStore.setInstalledPackages).toHaveBeenLastCalledWith([]);
    expect(skillStore.setInstalledAgentPlugins).toHaveBeenLastCalledWith([]);
    expect(agentProfileStore.setInstalledAgentPlugins).toHaveBeenLastCalledWith([]);

    await install("skill", "review", { "SKILL.md": "---\nname: review\ndescription: Reviews.\n---\nReview the change.\n" }, { kind: "skill", name: "review", description: "Reviews." }, loaded.store);
    await loaded.reload();
    expect(skillStore.setInstalledPackages).toHaveBeenLastCalledWith([{ kind: "skill", name: "review", dir: expect.stringContaining("review") }]);
    expect(agentProfileStore.setInstalledPackages).toHaveBeenLastCalledWith([]);
  });

  it("publishes verified agent plugin instructions on reload and removes them on uninstall", async () => {
    const skillStore = { setInstalledPackages: vi.fn(), setInstalledAgentPlugins: vi.fn() };
    const agentProfileStore = { setInstalledPackages: vi.fn(), setInstalledAgentPlugins: vi.fn() };
    const personaPromptStore = { setInstalledAgentPlugins: vi.fn() };
    const deps = { settingsService: { get: () => ({ language: "en" }) }, skillStore, agentProfileStore, personaPromptStore, getAppWindows: () => [], mcpManager: LEASE_ONLY_MCP } as unknown as IpcDeps;
    const loaded = await loadInstalledContent(deps, TOKEN, root);
    const files = {
      "plugin.json": JSON.stringify({ $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json", name: "writer-plugin", version: "1.0.0", description: "Writing tools" }),
      "skills/draft/SKILL.md": "---\nname: draft\ndescription: Draft text\n---\nDraft the text.",
      "ai.agent-connector.ave/agents/review/AGENTS.md": "---\nname: review\ndescription: Review text\n---\nReview the text.",
    };
    const bytes = Object.entries(files).map(([path, value]) => ({ path, data: Buffer.from(value) }));
    const components = deriveAgentPluginComponents(bytes);
    await install("agent-plugin", "writer-plugin", files, { kind: "agent-plugin", components, files: bytes }, loaded.store);
    await loaded.reload();
    expect(skillStore.setInstalledAgentPlugins).toHaveBeenLastCalledWith([
      expect.objectContaining({ name: "writer-plugin", version: "1.0.0", content: expect.objectContaining({ components }) }),
    ]);
    expect(agentProfileStore.setInstalledAgentPlugins).toHaveBeenLastCalledWith([
      expect.objectContaining({ name: "writer-plugin" }),
    ]);
    expect(personaPromptStore.setInstalledAgentPlugins).toHaveBeenLastCalledWith([
      expect.objectContaining({ name: "writer-plugin" }),
    ]);
    await loaded.store.uninstall("agent-plugin", "writer-plugin", EMPTY_MARKETPLACE_POLICY);
    await loaded.reload();
    expect(skillStore.setInstalledAgentPlugins).toHaveBeenLastCalledWith([]);
    expect(agentProfileStore.setInstalledAgentPlugins).toHaveBeenLastCalledWith([]);
    expect(personaPromptStore.setInstalledAgentPlugins).toHaveBeenLastCalledWith([]);
  });
});
