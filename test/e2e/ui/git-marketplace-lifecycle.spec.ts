import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import type { ElectronApplication } from 'playwright';
import { test as base, expect } from './fixtures.js';
import { captureCommandMenus, capturedCommandMenus, menuRowIds } from './command-menu.js';
import { closeInlineSettings, openInlineSettings } from './inline-settings.js';
import {
  createFixtureRepo,
  removeFixtureRepo,
  startGitHttpServer,
  type FixtureRepo,
  type GitHttpServer,
} from '../../../src/marketplace/__tests__/fixtures/git-http-server.js';
import { jsonText } from '../../../src/marketplace/__tests__/fixtures/package-files.js';
import { deriveAgentPluginComponents } from '../../../src/marketplace/content/agent-plugin-components.js';
import { agentPluginsDocument } from '../../../src/plugins/__tests__/test-helpers.js';
import { moonstoneBundle } from '../../../src/ui/renderer/theme/bundles/moonstone.js';
import type {
  CatalogView,
  GitMarketplaceResult,
  InstallPlanView,
  InstallResultView,
  InstalledKeyView,
  PackageKind,
  SourceView,
  UpdatePlanView,
} from '../../../src/shared/git-marketplace.js';
import type { McpGovernancePolicy } from '../../../src/mcp/types.js';
import type { InstalledContentResult } from '../../../src/shared/installed-content.js';
import { TEST_IDS, testIdSelector } from '../../../src/shared/test-ids.js';
import { scrubDiagnosticSecrets } from '../../../src/shared/dlp.js';

/** Exercise local marketplace add/install/update/remove through preload and UI, reading results through app surfaces rather than disk.
 * The fixture server runs locally with an isolated governance policy; its shell-script transport excludes Windows. */

const SOURCE_ID = 'harbor-tools';
/** The first release that knows the served host protocol. */
const MIN_APP_VERSION = '0.11.0';
const AUTHORITY = { capabilities: [], requires: { minAppVersion: MIN_APP_VERSION, hostProtocol: '2' } };
const READ_GRANT = { kind: 'hostDirectory' as const, segments: ['certs'], why: 'Read certificate bundles' };
const WRITE_GRANT = { kind: 'userChosenDirectory' as const, configKey: 'workspace', why: 'Store project data' };
const SURFACES = {
  'surface-sunken': '228 30% 97%',
  surface: '0 0% 100%',
  'surface-raised': '0 0% 100%',
  'surface-overlay': '0 0% 100%',
  'border-subtle': '228 24% 94%',
  'border-strong': '228 18% 84%',
};

/** The packages the marketplace lists, one of each kind, as `[kind, name, path]`. */
const PACKAGES: ReadonlyArray<readonly [PackageKind, string, string]> = [
  ['plugin', 'harbor-panel', 'plugins/harbor-panel'],
  ['agent-plugin', 'harbor-kit', 'agent-plugins/harbor-kit'],
  ['mcp', 'harbor-notes', 'mcp/harbor-notes'],
  ['skill', 'harbor-review', 'skills/harbor-review'],
  ['agent', 'harbor-guide', 'agents/harbor-guide'],
  ['theme', 'harbor', 'themes/harbor'],
  ['font', 'harbor-sans', 'fonts/harbor-sans'],
  ['language', 'harbor-french', 'languages/harbor-french'],
  ['provider', 'harbor-llm', 'providers/harbor-llm'],
  ['messaging-connection', 'harbor-chat', 'messaging/harbor-chat'],
];

/** A minimal MCP server over stdio: it answers initialize, lists one tool and calls it. */
const MCP_SERVER = `import { createInterface } from "node:readline";
const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
createInterface({ input: process.stdin }).on("line", (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined) return;
  if (request.method === "initialize") {
    send({ id: request.id, result: { protocolVersion: request.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "harbor-notes", version: process.env.HARBOR_VERSION } } });
  } else if (request.method === "tools/list") {
    send({ id: request.id, result: { tools: [{ name: "harbor_notes_ping", description: "Answer pong.", inputSchema: { type: "object", properties: {} } }] } });
  } else if (request.method === "tools/call") {
    send({ id: request.id, result: { content: [{ type: "text", text: "pong" }] } });
  } else {
    send({ id: request.id, error: { code: -32601, message: "method not found" } });
  }
});
`;

/** Runs the server with the Node the app passes as its first argument (`$NODE`, the app binary in Node mode). */
const MCP_LAUNCHER = '#!/bin/sh\nELECTRON_RUN_AS_NODE=1\nexport ELECTRON_RUN_AS_NODE\nexec "$1" "$(dirname "$0")/index.mjs"\n';

const WOFF2 = `wOF2${'\u0000'.repeat(60)}`;

/** `~/.ave/governance/mcp-policy.json` approving the MCP package at the path it installs to. */
function governancePolicy(aveHome: string): McpGovernancePolicy {
  return {
    version: '1.0',
    defaultPolicy: 'deny',
    servers: [
      {
        id: 'harbor-notes',
        name: 'Harbor Notes',
        status: 'approved',
        approvedBy: 'e2e',
        approvedAt: '2026-09-25T00:00:00.000Z',
        transport: 'stdio',
        allowedCommands: [join(aveHome, 'mcp', 'harbor-notes', 'server', 'run.sh')],
        requiredAuth: 'none',
        tlsRequired: false,
        allowedCapabilities: ['tools'],
        maxTools: 5,
        toolNamePrefix: 'harbor_notes',
        connectionTimeoutMs: 30_000,
        maxConcurrentRequests: 4,
      },
    ],
    globalRules: {
      maxServersTotal: 10,
      blockedUrlPatterns: [],
      allowedUrlPatterns: [],
      policyRefreshIntervalMs: 30 * 60 * 1000,
    },
  };
}

/** The shared fixtures, with the governance policy written before the app starts. */
const test = base.extend({
  userDataDir: async ({ userDataDir, aveHome }, use) => {
    // The fixture's AVE_HOME (see fixtures.ts).
    mkdirSync(join(aveHome, 'governance'), { recursive: true });
    writeFileSync(join(aveHome, 'governance', 'mcp-policy.json'), `${JSON.stringify(governancePolicy(aveHome), null, 2)}\n`);
    await use(userDataDir);
  },
});

type Entry = { path: string; mode: string; content: string };

/** A package's `ave-package.json`. */
const descriptorText = (kind: PackageKind, name: string, version: string, payload: Record<string, unknown>) =>
  jsonText({ schemaVersion: 2, kind, name, version, minAppVersion: MIN_APP_VERSION,
    ...(kind === 'plugin' ? { hostProtocol: '2' } : {}), payload });

/** The whole repository tree at `version`: every package publishes that version. */
function marketplaceTree(version: string): Entry[] {
  const file = (path: string, content: string, mode = '100644'): Entry => ({ path, mode, content });
  const agentRoot = 'agent-plugins/harbor-kit';
  const agentFiles = [
    file(`${agentRoot}/plugin.json`, jsonText({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json',
      name: 'harbor-kit', version, description: 'Harbor writing tools.',
    })),
    file(`${agentRoot}/skills/harbor-check/SKILL.md`, `---\nname: harbor-check\ndescription: Check harbor work (${version}).\n---\nReview the current work.\n`),
    file(`${agentRoot}/ai.agent-connector.ave/prompts/harbor-draft.md`, `---\nname: harbor-draft\ndescription: Draft harbor notes (${version}).\nkind: template\n---\nDraft notes from {args}.\n`),
    file(`${agentRoot}/ai.agent-connector.ave/routines.json`, jsonText({
      version: 1,
      templates: [{
        id: 'harbor-daily', title: `Daily harbor notes (${version})`, description: 'Prepare harbor notes.',
        trigger: 'schedule', schedule: { repeat: { kind: 'cron', expression: '0 9 * * *' } },
        execution: 'llm-session', prePrompt: `Prepare harbor notes for ${version}.`,
      }],
    })),
    file(`${agentRoot}/mcp.json`, jsonText({
      $schema: 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json',
      mcpServers: { notes: { type: 'stdio', command: 'node', args: ['${PLUGIN_ROOT}/server/index.mjs'], env: { HARBOR_VERSION: version } } },
    })),
    file(`${agentRoot}/ai.agent-connector.ave/hooks.json`, jsonText({
      version: 1, hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: ['node', '${PLUGIN_ROOT}/server/hook.mjs'] }] }] },
    })),
    file(`${agentRoot}/server/hook.mjs`, "process.stdout.write(JSON.stringify({ action: 'allow' }));\n"),
    file(`${agentRoot}/server/index.mjs`, MCP_SERVER.replaceAll('harbor-notes', 'harbor-kit').replaceAll('harbor_notes_ping', 'harbor_kit_ping')),
  ];
  const agentComponents = deriveAgentPluginComponents(agentFiles.map(({ path, content }) => ({
    path: path.slice(agentRoot.length + 1), data: Buffer.from(content),
  })), { name: 'harbor-kit', version });
  const pluginAuthority = {
    ...AUTHORITY,
    sandbox: {
      read: [READ_GRANT],
      ...(version === '1.0.0' ? {} : { write: [WRITE_GRANT] }),
    },
  };
  const plugin = agentPluginsDocument({
    id: 'harbor-panel',
    name: 'Harbor Panel',
    version,
    description: 'A plugin the marketplace E2E installs.',
    entry: 'dist/index.js',
    ...pluginAuthority,
    prompts: [{ id: 'panel_draft', path: 'assets/prompts/panel-draft.md' }],
    routineTemplates: [{ id: 'panel_daily', path: 'assets/routines/templates.json' }],
    configSchema: { properties: { workspace: { type: 'string' } } },
    tools: [
      {
        name: 'harbor_panel_ping',
        description: 'Answer pong.',
        inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      },
    ],
  });
  return [
    file('README.md', 'A marketplace the Ave end-to-end test serves.\n'),
    file('marketplace.json', jsonText({
      schemaVersion: 2,
      name: SOURCE_ID,
      displayName: 'Harbor Tools',
      packages: PACKAGES.map(([kind, name, path]) => ({ kind, name, path })),
    })),

    file('plugins/harbor-panel/ave-package.json', descriptorText('plugin', 'harbor-panel', version, { authority: pluginAuthority, artifact: { tree: 'plugins/harbor-panel' } })),
    file('plugins/harbor-panel/plugin.json', jsonText(plugin)),
    file('plugins/harbor-panel/dist/index.js', 'export default function createPlugin() {\n  return { handlers: { harbor_panel_ping: async () => "pong" }, start() {}, stop() {} };\n}\n'),
    file('plugins/harbor-panel/assets/prompts/panel-draft.md', `---\nname: panel-draft\ndescription: Draft panel notes (${version}).\nkind: template\n---\nDraft panel notes from {args}.\n`),
    file('plugins/harbor-panel/assets/routines/templates.json', jsonText({ version: 1, templates: [{
      id: 'panel-daily', title: `Daily panel notes (${version})`, description: 'Prepare panel notes.',
      trigger: 'schedule', schedule: { repeat: { kind: 'cron', expression: '0 9 * * *' } },
      execution: 'llm-session', prePrompt: `Prepare panel notes for ${version}.`,
    }] })),

    file(`${agentRoot}/ave-package.json`, descriptorText('agent-plugin', 'harbor-kit', version, { manifest: 'plugin.json', components: agentComponents })),
    ...agentFiles,

    file('mcp/harbor-notes/ave-package.json', descriptorText('mcp', 'harbor-notes', version, {
      server: { transport: 'stdio', command: 'server/run.sh', args: ['$NODE'], env: { HARBOR_VERSION: version } },
    })),
    file('mcp/harbor-notes/server/run.sh', MCP_LAUNCHER, '100755'),
    file('mcp/harbor-notes/server/index.mjs', MCP_SERVER),

    file('skills/harbor-review/ave-package.json', descriptorText('skill', 'harbor-review', version, { entry: 'SKILL.md' })),
    file('skills/harbor-review/SKILL.md', `---\nname: harbor-review\ndescription: Review a harbor change (${version}).\n---\nRead the diff first.\n`),

    file('agents/harbor-guide/ave-package.json', descriptorText('agent', 'harbor-guide', version, { entry: 'AGENTS.md' })),
    file('agents/harbor-guide/AGENTS.md', `---\nname: harbor-guide\ndescription: Guides harbor work (${version}).\n---\nAnswer briefly.\n`),

    file('themes/harbor/ave-package.json', descriptorText('theme', 'harbor', version, { entry: 'theme.json' })),
    file('themes/harbor/theme.json', jsonText({
      name: 'Harbor',
      description: `Harbor light (${version}).`,
      shell: 'light',
      highContrast: false,
      tokens: moonstoneBundle.tokens,
      surfaces: SURFACES,
    })),

    file('fonts/harbor-sans/ave-package.json', descriptorText('font', 'harbor-sans', version, { entry: 'font.json' })),
    file('fonts/harbor-sans/font.json', jsonText({ family: 'Harbor Sans', license: 'LICENSE', faces: [{ file: 'files/HarborSans.woff2', weight: '100 900' }] })),
    file('fonts/harbor-sans/LICENSE', 'SIL Open Font License 1.1\n'),
    file('fonts/harbor-sans/files/HarborSans.woff2', WOFF2),

    file('languages/harbor-french/ave-package.json', descriptorText('language', 'harbor-french', version, { locale: 'fr', entry: 'language.json', messages: 'messages.json' })),
    file('languages/harbor-french/language.json', jsonText({ locale: 'fr', nativeName: 'Français', englishName: 'French' })),
    file('languages/harbor-french/messages.json', jsonText({ 'settingsContent.tabMarketplace': version === '1.0.0' ? 'Marché' : 'Place de marché' })),

    file('providers/harbor-llm/ave-package.json', descriptorText('provider', 'harbor-llm', version, { entry: 'provider.json' })),
    file('providers/harbor-llm/provider.json', jsonText({
      providerId: 'harbor-llm',
      label: 'Harbor LLM',
      baseUrl: 'https://api.harbor.example/v1',
      defaultModel: 'harbor-1',
      modelOptions: ['harbor-1', 'harbor-1-mini'],
      requiresApiKey: true,
    })),

    file('messaging/harbor-chat/ave-package.json', descriptorText('messaging-connection', 'harbor-chat', version, { entry: 'connection.json' })),
    file('messaging/harbor-chat/connection.json', jsonText({
      connectionId: 'harbor-chat',
      label: 'Harbor Chat',
      summary: 'Talk to Ave from Harbor Chat.',
      pairing: 'one-time-code',
      credentials: [{ key: 'botToken', label: 'Bot token', secret: true }],
    })),
  ];
}

type Call =
  | { method: 'listSources'; args: [] }
  | { method: 'listCatalog'; args: [{ installedOnly?: boolean; sourceId?: string }] }
  | { method: 'planInstall'; args: [{ sourceId: string; kind: PackageKind; name: string }] }
  | { method: 'planUpdate'; args: [{ sourceId: string; kind: PackageKind; name: string }] }
  | { method: 'executeInstall'; args: [string] }
  | { method: 'uninstall'; args: [InstalledKeyView & { removeData?: boolean }] };

/** One call on `window.aveApi.gitMarketplace`; a failed result fails the test with its code and message. */
async function call<T>(page: Page, request: Call): Promise<T> {
  const result = await page.evaluate(
    ({ method, args }) => (window as unknown as { aveApi: { gitMarketplace: Record<string, (...a: unknown[]) => Promise<unknown>> } })
      .aveApi.gitMarketplace[method]!(...args),
    request,
  ) as GitMarketplaceResult<T>;
  if (!result.ok) throw new Error(`${request.method} failed: ${result.code}: ${result.message}`);
  return result.value;
}

const installedContent = (page: Page) =>
  page.evaluate(() => (window as unknown as { aveApi: { installedContent: { installed(): Promise<InstalledContentResult> } } }).aveApi.installedContent.installed());

/** The command menu's row ids, as the renderer builds the menu now. */
async function commandMenuIds(app: ElectronApplication, page: Page): Promise<string[]> {
  await captureCommandMenus(app);
  await page.locator(testIdSelector(TEST_IDS.slashPickerTrigger)).click();
  await expect.poll(async () => (await capturedCommandMenus(app)).length).toBe(1);
  const [payload] = await capturedCommandMenus(app);
  return menuRowIds(payload!);
}

test.describe('git marketplace lifecycle', () => {
  test.skip(process.platform === 'win32', 'the fixture MCP server is a shell script');
  test.use({ seedViewFixturePlugin: false });
  test.setTimeout(240_000);

  let served: string;
  let server: GitHttpServer;
  let repo: FixtureRepo;

  test.beforeAll(async () => {
    served = mkdtempSync(join(tmpdir(), 'ave-e2e-marketplace-'));
    server = await startGitHttpServer({ root: served });
    repo = createFixtureRepo(served, 'harbor-tools');
    repo.commit({ 'README.md': 'A marketplace the Ave end-to-end test serves.\n' }, 'start');
    repo.commitEntries(marketplaceTree('1.0.0'), 'publish 1.0.0');
  });

  test.afterAll(async () => {
    await server?.close();
    if (repo) await removeFixtureRepo(repo);
    if (served) rmSync(served, { recursive: true, force: true });
  });

  test('adds a local marketplace, installs and updates one package of each kind, and removes the source', async ({ app, mainWindow, t }) => {
    const keys = PACKAGES.map(([kind, name]) => ({ sourceId: SOURCE_ID, kind, name }));
    const installed = async () =>
      (await call<CatalogView>(mainWindow, { method: 'listCatalog', args: [{ installedOnly: true }] })).entries
        .map((entry) => `${entry.key.kind}/${entry.key.name}@${JSON.stringify(entry.state)}`)
        .sort();

    // Add the marketplace through the tab.
    const settings = await openInlineSettings(app, mainWindow, 'marketplace');
    await expect(settings.getByTestId('git-marketplace')).toBeVisible();
    await settings.getByTestId('git-marketplace:add-menu').click();
    await settings.getByRole('menuitem', { name: t('gitMarketplace.addMarketplace') }).click();
    await settings.getByTestId('git-marketplace:add:url').fill(server.url('harbor-tools'));
    await settings.getByTestId('git-marketplace:add:check').click();
    const preview = settings.getByTestId('git-marketplace:add:preview');
    await expect(preview).toContainText('Harbor Tools', { timeout: 60_000 });
    await expect(settings.getByTestId('git-marketplace:add:error')).toHaveCount(0);
    await expect(settings.getByTestId('git-marketplace:add:id')).toHaveValue(SOURCE_ID);
    await settings.getByTestId('git-marketplace:add:confirm').click();
    await expect(settings.getByTestId('git-marketplace:add')).toHaveCount(0, { timeout: 30_000 });
    for (const key of keys) {
      await expect(settings.getByTestId(`git-marketplace:card:${key.sourceId}:${key.kind}:${key.name}`)).toBeVisible();
    }

    // Install every kind.
    for (const key of keys) {
      let plan = await call<InstallPlanView>(mainWindow, { method: 'planInstall', args: [key] });
      expect(plan, key.name).toMatchObject({ version: '1.0.0', action: { action: 'install' }, runsCode: key.kind === 'plugin' || key.kind === 'mcp' || key.kind === 'agent-plugin' });
      if (key.kind === 'plugin') {
        expect(plan.authority?.filesystem).toEqual([{ access: 'read', target: 'certs', why: READ_GRANT.why }]);
        await settings.getByTestId(`git-marketplace:card:${key.sourceId}:${key.kind}:${key.name}`).getByTestId('git-marketplace:card:state').click();
        const sheet = await mainWindow.getByTestId('git-marketplace:sheet');
        await sheet.getByTestId('git-marketplace:plan').click();
        await expect(sheet.getByTestId('git-marketplace:review')).toContainText(`read: certs — ${READ_GRANT.why}`);
        await sheet.getByTestId('git-marketplace:sheet:close').click();
        plan = await call<InstallPlanView>(mainWindow, { method: 'planInstall', args: [key] });
      }
      if (key.kind === 'agent-plugin') {
        expect(plan.components).toMatchObject({
          skills: [{ name: 'harbor-check' }], prompts: [{ name: 'harbor-draft' }],
          routineTemplates: [{ id: 'harbor-daily' }], mcpServers: { notes: { transport: 'stdio' } },
          hooks: [{ event: 'pre' }],
        });
        await settings.getByTestId(`git-marketplace:card:${key.sourceId}:${key.kind}:${key.name}`).getByTestId('git-marketplace:card:state').click();
        const sheet = mainWindow.getByTestId('git-marketplace:sheet');
        await sheet.getByTestId('git-marketplace:plan').click();
        await sheet.getByTestId('git-marketplace:mcp-consent:notes').getByRole('checkbox').click();
        await expect(sheet.getByTestId('git-marketplace:review')).toContainText('On this machine:');
        await sheet.getByTestId('git-marketplace:hook-consent:0').getByRole('checkbox').click();
        await test.info().attach('agent-plugin-install-review', { body: await sheet.screenshot(), contentType: 'image/png' });
        await sheet.getByTestId('git-marketplace:confirm').click();
        await expect(sheet.getByTestId('git-marketplace:done')).toBeVisible({ timeout: 60_000 });
        await sheet.getByTestId('git-marketplace:sheet:close').click();
      } else {
        const result = await call<InstallResultView>(mainWindow, { method: 'executeInstall', args: [plan.planId] });
        expect(result, key.name).toMatchObject({ key, version: '1.0.0', action: { action: 'install' }, connectionWarning: null });
        if (key.kind === 'plugin') expect(result.rungs.find((rung) => rung.outcome === 'used')?.rung).toBe('tree');
      }
    }
    expect(await installed()).toEqual(keys.map((key) => `${key.kind}/${key.name}@${JSON.stringify({ state: 'installed', version: '1.0.0' })}`).sort());
    await expect(settings.getByTestId(`git-marketplace:card:${SOURCE_ID}:theme:harbor`).getByTestId('git-marketplace:card:state')).toBeVisible();

    // The app took each one in.
    const content = await installedContent(mainWindow);
    expect(content.ok).toBe(true);
    if (!content.ok) return;
    expect(content.content.broken).toEqual([]);
    expect(content.content.themes.map((theme) => theme.id)).toContain('harbor');
    expect(content.content.languages.map((language) => language.locale)).toContain('fr');
    expect(content.content.fonts.map((font) => font.family)).toContain('Harbor Sans');
    expect(content.content.routineTemplates).toEqual(expect.arrayContaining([
      expect.objectContaining({ packageName: 'harbor-kit', id: 'harbor-daily' }),
      expect.objectContaining({ packageName: 'harbor-panel', id: 'panel-daily', sourceKind: 'extension' }),
    ]));
    await closeInlineSettings(app, settings);
    const menu = await commandMenuIds(app, mainWindow);
    // Governance registers the server's tool under the policy's prefix.
    expect(menu).toContain('mcp:harbor-notes:mcp_harbor_notes_harbor_notes_ping');
    expect(menu).toContain('skill:harbor-review');
    expect(menu).toContain('skill:agent-plugin:harbor-kit:harbor-check');
    expect(menu).toContain('plugin-prompt:agent-plugin:harbor-kit:harbor-draft');
    expect(menu).toContain('plugin-prompt:extension:harbor-panel:panel-draft');
    expect(menu.some((id) => id.includes('harbor_kit_ping'))).toBe(true);

    // Publish 1.1.0 and update every kind to it.
    repo.commitEntries(marketplaceTree('1.1.0'), 'publish 1.1.0');
    await mainWindow.evaluate(() => (window as unknown as { aveApi: { gitMarketplace: { refreshSources(id: string): Promise<unknown> } } }).aveApi.gitMarketplace.refreshSources('harbor-tools'));
    expect(await installed()).toEqual(keys.map((key) => `${key.kind}/${key.name}@${JSON.stringify({ state: 'update', from: '1.0.0', to: '1.1.0' })}`).sort());
    for (const key of keys) {
      const plan = await call<UpdatePlanView>(mainWindow, { method: 'planUpdate', args: [key] });
      expect(plan, key.name).toMatchObject({ from: '1.0.0', version: '1.1.0', action: { action: 'replace', direction: 'upgrade' }, needsConfirmation: key.kind === 'plugin' });
      if (key.kind === 'agent-plugin') {
        expect(plan.componentsDelta?.changed).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'mcp', name: 'notes' })]));
        const updateSettings = await openInlineSettings(app, mainWindow, 'marketplace');
        await updateSettings.getByTestId(`git-marketplace:card:${key.sourceId}:${key.kind}:${key.name}`).getByTestId('git-marketplace:card:state').click();
        const sheet = mainWindow.getByTestId('git-marketplace:sheet');
        // The package's files changed, its server declaration among them (code), so each component's approval is asked again with the full review (§18.7.3), not the one-row form.
        await expect(sheet.getByTestId('git-marketplace:code-free')).toHaveCount(0);
        await expect(sheet.getByTestId('git-marketplace:consent-row:mcpServer:notes')).toContainText('mcp.json');
        for (const field of ['mcpServer:notes', 'hook:0']) {
          const consent = sheet.getByTestId(`git-marketplace:consent-approve:${field}`);
          await expect(consent).not.toBeChecked();
          await consent.click();
        }
        await test.info().attach('agent-plugin-update-review', { body: await sheet.screenshot(), contentType: 'image/png' });
        await sheet.getByTestId('git-marketplace:confirm').click();
        await expect(sheet.getByTestId('git-marketplace:done')).toBeVisible({ timeout: 60_000 });
        await sheet.getByTestId('git-marketplace:sheet:close').click();
        await closeInlineSettings(app, updateSettings);
      } else if (key.kind === 'plugin') {
        expect(plan.authorityDelta?.added.filesystem).toEqual([{ access: 'write', target: 'config.workspace', why: WRITE_GRANT.why }]);
        const updateSettings = await openInlineSettings(app, mainWindow, 'marketplace');
        await updateSettings.getByTestId(`git-marketplace:card:${key.sourceId}:${key.kind}:${key.name}`).getByTestId('git-marketplace:card:state').click();
        const sheet = await mainWindow.getByTestId('git-marketplace:sheet');
        await expect(sheet.getByTestId('git-marketplace:review')).toContainText(`write: config.workspace — ${WRITE_GRANT.why}`);
        await sheet.getByTestId('git-marketplace:confirm').click();
        await expect(sheet.getByTestId('git-marketplace:done')).toBeVisible({ timeout: 60_000 });
        await sheet.getByTestId('git-marketplace:sheet:close').click();
        await closeInlineSettings(app, updateSettings);
      } else {
        const result = await call<InstallResultView>(mainWindow, { method: 'executeInstall', args: [plan.planId] });
        expect(result, key.name).toMatchObject({ key, version: '1.1.0', connectionWarning: null });
      }
    }
    expect(await installed()).toEqual(keys.map((key) => `${key.kind}/${key.name}@${JSON.stringify({ state: 'installed', version: '1.1.0' })}`).sort());
    const updated = await installedContent(mainWindow);
    expect(updated.ok && updated.content.themes.find((theme) => theme.id === 'harbor')?.description).toBe('Harbor light (1.1.0).');
    expect(updated.ok && updated.content.routineTemplates.find((template) => template.packageName === 'harbor-kit')?.version).toBe('1.1.0');
    expect(updated.ok && updated.content.routineTemplates.find((template) => template.packageName === 'harbor-panel')?.version).toBe('1.1.0');

    // Remove the source through the tab: its packages stay installed, bound to it.
    const again = await openInlineSettings(app, mainWindow, 'marketplace');
    await again.getByTestId('git-marketplace:open-sources').click();
    await again.getByTestId(`git-marketplace:source:${SOURCE_ID}:remove`).click();
    await again.getByTestId('git-marketplace:sources:confirm').click();
    await expect(again.getByTestId(`git-marketplace:source:${SOURCE_ID}`)).toHaveCount(0, { timeout: 30_000 });
    expect((await call<CatalogView>(mainWindow, { method: 'listCatalog', args: [{}] })).entries.filter((entry) => entry.key.sourceId === SOURCE_ID)).toEqual([]);
    expect(await installed()).toHaveLength(keys.length);

    // And they still uninstall.
    for (const key of keys) {
      await call(mainWindow, { method: 'uninstall', args: [{ ...key, ...(key.kind === 'mcp' || key.kind === 'agent-plugin' ? { removeData: true } : {}) }] });
    }
    expect(await installed()).toEqual([]);
    await closeInlineSettings(app, again);
  });
});

test.describe('git marketplace target confirmations (design §18.5)', () => {
  // A user's build: no dev flag, so an http marketplace on this computer is asked about.
  test.use({ seedViewFixturePlugin: false, devFlag: false });
  test.setTimeout(120_000);

  let served: string;
  let server: GitHttpServer;
  let repo: FixtureRepo;

  test.beforeAll(async () => {
    served = mkdtempSync(join(tmpdir(), 'ave-e2e-marketplace-http-'));
    server = await startGitHttpServer({ root: served });
    repo = createFixtureRepo(served, 'harbor-tools');
    repo.commit({ 'README.md': 'A marketplace served over plain http on this computer.\n' }, 'start');
    repo.commitEntries(marketplaceTree('1.0.0'), 'publish 1.0.0');
  });

  test.afterAll(async () => {
    await server?.close();
    if (repo) await removeFixtureRepo(repo);
    if (served) rmSync(served, { recursive: true, force: true });
  });

  test('asks before adding an http marketplace on this computer, then shows its badge', async ({ app, mainWindow, t }) => {
    const settings = await openInlineSettings(app, mainWindow, 'marketplace');
    await settings.getByTestId('git-marketplace:add-menu').click();
    await settings.getByRole('menuitem', { name: t('gitMarketplace.addMarketplace') }).click();
    await settings.getByTestId('git-marketplace:add:url').fill(server.url('harbor-tools'));
    await settings.getByTestId('git-marketplace:add:check').click();

    // The confirmation comes before any request: the fixture has seen nothing.
    const warnings = settings.getByTestId('git-marketplace:add:warnings');
    await expect(warnings).toBeVisible({ timeout: 30_000 });
    await expect(warnings).toContainText(t('gitMarketplace.warning.unencrypted', { host: '127.0.0.1' }));
    await expect(warnings).toContainText(t('gitMarketplace.warning.thisComputer', { host: '127.0.0.1', address: '127.0.0.1' }));
    expect(server.seen).toEqual([]);
    await test.info().attach('http-source-confirmation', { body: await warnings.screenshot(), contentType: 'image/png' });

    await settings.getByTestId('git-marketplace:add:warnings:continue').click();
    const preview = settings.getByTestId('git-marketplace:add:preview');
    await expect(preview).toContainText('Harbor Tools', { timeout: 60_000 });
    await expect(settings.getByTestId('git-marketplace:add:badge:unencrypted')).toHaveText(t('gitMarketplace.badge.unencrypted'));
    await expect(settings.getByTestId('git-marketplace:add:badge:this-computer')).toHaveText(t('gitMarketplace.badge.thisComputer'));
    await settings.getByTestId('git-marketplace:add:confirm').click();
    await expect(settings.getByTestId('git-marketplace:add')).toHaveCount(0, { timeout: 30_000 });

    // The cards and the source's row carry the badge, with the risk in its tooltip.
    const card = settings.getByTestId(`git-marketplace:card:${SOURCE_ID}:skill:harbor-review`);
    await expect(card).toBeVisible();
    await expect(settings.getByTestId(`git-marketplace:card:${SOURCE_ID}:harbor-review:badge:unencrypted`)).toHaveAttribute('title', t('gitMarketplace.badge.unencrypted.tooltip'));
    await settings.getByTestId('git-marketplace:open-sources').click();
    const badge = settings.getByTestId(`git-marketplace:source:${SOURCE_ID}:badge:unencrypted`);
    await expect(badge).toHaveText(t('gitMarketplace.badge.unencrypted'));
    await expect(settings.getByTestId(`git-marketplace:source:${SOURCE_ID}:badge:this-computer`)).toBeVisible();
    await test.info().attach('http-source-badges', { body: await settings.getByTestId(`git-marketplace:source:${SOURCE_ID}`).screenshot(), contentType: 'image/png' });
    const sources = await call<SourceView[]>(mainWindow, { method: 'listSources', args: [] });
    expect(sources.find((item) => item.id === SOURCE_ID)?.acknowledged).toEqual(['unencrypted', 'this-computer']);
    await closeInlineSettings(app, settings);
  });
});

test.describe('git marketplace folder source (design §18.4)', () => {
  // A user's build: a folder needs no dev flag, and no git at all.
  test.use({ seedViewFixturePlugin: false, devFlag: false });
  test.setTimeout(120_000);

  const FOLDER_ID = 'team-folder';
  let parent: string;
  let folder: string;
  const descriptor = (version: string) => `${JSON.stringify({ schemaVersion: 2, kind: 'skill', name: 'folder-notes', version, minAppVersion: '0.12.0', payload: { entry: 'SKILL.md' } })}\n`;
  const write = (files: Record<string, string>) => {
    for (const [path, text] of Object.entries(files)) {
      mkdirSync(join(folder, path, '..'), { recursive: true });
      writeFileSync(join(folder, path), text);
    }
  };

  test.beforeAll(() => {
    // tmpdir is reached through a link on macOS (/var → /private/var): the preview says where it resolved.
    parent = mkdtempSync(join(tmpdir(), 'ave-e2e-marketplace-folder-'));
    folder = join(parent, 'team-market');
    write({
      'marketplace.json': `${JSON.stringify({ schemaVersion: 2, name: 'team-folder', displayName: 'Team Folder', packages: [{ kind: 'skill', name: 'folder-notes', path: 'skills/folder-notes' }] })}\n`,
      'skills/folder-notes/ave-package.json': descriptor('1.0.0'),
      'skills/folder-notes/SKILL.md': 'Write notes.\n',
    });
  });

  test.afterAll(() => {
    if (parent) rmSync(parent, { recursive: true, force: true });
  });

  test('adds a folder marketplace with Choose folder…, installs a skill, and offers the edited skill as an update after Refresh', async ({ app, mainWindow, t }) => {
    // Main's folder dialog answers this folder; Show in Finder records what it was asked to show.
    await app.evaluate(({ dialog, shell }, chosen) => {
      (globalThis as { __revealed?: string[] }).__revealed = [];
      dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [chosen] })) as typeof dialog.showOpenDialog;
      shell.showItemInFolder = (path: string) => {
        (globalThis as { __revealed?: string[] }).__revealed!.push(path);
      };
    }, folder);

    const settings = await openInlineSettings(app, mainWindow, 'marketplace');
    await settings.getByTestId('git-marketplace:add-menu').click();
    await settings.getByRole('menuitem', { name: t('gitMarketplace.addMarketplace') }).click();
    await settings.getByTestId('git-marketplace:add:choose-folder').click();
    const preview = settings.getByTestId('git-marketplace:add:preview');
    await expect(preview).toContainText('Team Folder', { timeout: 30_000 });
    await expect(settings.getByTestId('git-marketplace:add:error')).toHaveCount(0);
    await expect(settings.getByTestId('git-marketplace:add:folder-pickup')).toHaveText(t('gitMarketplace.add.folderPickup'));
    await expect(settings.getByTestId('git-marketplace:add:badge:local-folder')).toHaveText(t('gitMarketplace.badge.localFolder'));
    if (process.platform === 'darwin') await expect(settings.getByTestId('git-marketplace:add:resolved-from')).toContainText(folder);
    await settings.getByTestId('git-marketplace:add:id').fill(FOLDER_ID);
    await settings.getByTestId('git-marketplace:add:confirm').click();
    await expect(settings.getByTestId('git-marketplace:add')).toHaveCount(0, { timeout: 30_000 });

    const key = { sourceId: FOLDER_ID, kind: 'skill' as const, name: 'folder-notes' };
    await expect(settings.getByTestId(`git-marketplace:card:${FOLDER_ID}:skill:folder-notes`)).toBeVisible();
    await expect(settings.getByTestId(`git-marketplace:card:${FOLDER_ID}:folder-notes:badge:local-folder`)).toBeVisible();
    const plan = await call<InstallPlanView>(mainWindow, { method: 'planInstall', args: [key] });
    expect(plan).toMatchObject({ version: '1.0.0', snapshotCommit: expect.stringMatching(/^local-[0-9a-f]{64}$/u) });
    await call<InstallResultView>(mainWindow, { method: 'executeInstall', args: [plan.planId] });

    // Edit the skill in the folder; Refresh on its row reads it again.
    write({ 'skills/folder-notes/SKILL.md': 'Write better notes.\n', 'skills/folder-notes/ave-package.json': descriptor('1.1.0') });
    await settings.getByTestId('git-marketplace:open-sources').click();
    const row = settings.getByTestId(`git-marketplace:source:${FOLDER_ID}`);
    await expect(row.getByTestId(`git-marketplace:source:${FOLDER_ID}:folder`)).toContainText(t('gitMarketplace.sources.folderKind'));
    await expect(row.getByTestId(`git-marketplace:source:${FOLDER_ID}:badge:local-folder`)).toBeVisible();
    await row.getByRole('button', { name: t('gitMarketplace.sources.refresh') }).click();
    await expect(row.getByRole('button', { name: t('gitMarketplace.sources.refresh') })).toBeEnabled({ timeout: 30_000 });

    await row.getByTestId(`git-marketplace:source:${FOLDER_ID}:reveal`).click();
    await expect.poll(() => app.evaluate(() => (globalThis as { __revealed?: string[] }).__revealed ?? [])).toHaveLength(1);
    const [revealed] = await app.evaluate(() => (globalThis as { __revealed?: string[] }).__revealed ?? []);
    const sources = await call<SourceView[]>(mainWindow, { method: 'listSources', args: [] });
    expect(revealed).toBe(sources.find((item) => item.id === FOLDER_ID)?.path);

    const installedNow = await call<CatalogView>(mainWindow, { method: 'listCatalog', args: [{ installedOnly: true }] });
    expect(installedNow.entries.find((entry) => entry.key.name === 'folder-notes')?.state).toEqual({ state: 'update', from: '1.0.0', to: '1.1.0' });
    // Back to the packages: the card offers the update.
    await settings.getByTestId('git-marketplace:open-sources').click();
    await expect(settings.getByTestId(`git-marketplace:card:${FOLDER_ID}:skill:folder-notes`).getByTestId('git-marketplace:card:state'))
      .toHaveText(t('gitMarketplace.state.update', { version: '1.1.0' }), { timeout: 30_000 });
    await test.info().attach('folder-source-update', { body: await settings.getByTestId('git-marketplace').screenshot(), contentType: 'image/png' });
    await call(mainWindow, { method: 'uninstall', args: [key] });
    await closeInlineSettings(app, settings);
  });

  test('previews the folder Choose folder… chose when its name looks like a token, never the folder its masked name names (§18.9)', async ({ app, mainWindow, t }) => {
    // Assembled here so no whole token sits in the source.
    const token = `glp${'at-'}${'abcd1234'.repeat(3)}`;
    const chosen = join(parent, token);
    const sibling = join(parent, scrubDiagnosticSecrets(token));
    cpSync(folder, chosen, { recursive: true });
    // A Windows name cannot hold the mask's `:`: there the masked text names no folder, and only the chosen one is read.
    if (process.platform !== 'win32') {
      cpSync(folder, sibling, { recursive: true });
      writeFileSync(join(sibling, 'marketplace.json'), readFileSync(join(sibling, 'marketplace.json'), 'utf8').replace('Team Folder', 'Different Folder'));
    }
    try {
      await app.evaluate(({ dialog }, path) => {
        dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [path] })) as typeof dialog.showOpenDialog;
      }, chosen);
      const settings = await openInlineSettings(app, mainWindow, 'marketplace');
      await settings.getByTestId('git-marketplace:add-menu').click();
      await settings.getByRole('menuitem', { name: t('gitMarketplace.addMarketplace') }).click();
      await settings.getByTestId('git-marketplace:add:choose-folder').click();
      const preview = settings.getByTestId('git-marketplace:add:preview');
      await expect(preview).toContainText('Team Folder', { timeout: 30_000 });
      await expect(preview).not.toContainText('Different Folder');
      // The tab only ever held the masked name.
      expect(await mainWindow.locator('body').innerText()).not.toContain(token);
      await test.info().attach('folder-pick-token-name', { body: await settings.getByTestId('git-marketplace:add').screenshot(), contentType: 'image/png' });
      await mainWindow.keyboard.press('Escape');
      await expect(settings.getByTestId('git-marketplace:add')).toHaveCount(0);
      await closeInlineSettings(app, settings);
    } finally {
      rmSync(chosen, { recursive: true, force: true });
      rmSync(sibling, { recursive: true, force: true });
    }
  });
});
