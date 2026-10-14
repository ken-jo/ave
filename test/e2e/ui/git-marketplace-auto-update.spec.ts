import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Page } from '@playwright/test';
import { test, expect } from './fixtures.js';
import { closeInlineSettings, openInlineSettings } from './inline-settings.js';
import {
  createFixtureRepo,
  removeFixtureRepo,
  startGitHttpServer,
  type FixtureRepo,
  type GitHttpServer,
} from '../../../src/marketplace/__tests__/fixtures/git-http-server.js';
import { jsonText } from '../../../src/marketplace/__tests__/fixtures/package-files.js';
import { agentPluginsDocument } from '../../../src/plugins/__tests__/test-helpers.js';
import type {
  CatalogView,
  GitMarketplaceResult,
  InstallPlanView,
  SourcePreviewResultView,
  SourceView,
  UpdateStatusView,
} from '../../../src/shared/git-marketplace.js';

/**
 * Automatic updates end to end (design §18.7, §18.10 F): the built app runs
 * its real update scheduler (`AVE_E2E_MARKETPLACE_SCHEDULER=1`) against a
 * marketplace served over HTTP by a local `git http-backend`. A skill whose
 * new release changes nothing the user agreed to applies by itself; an
 * extension whose new release asks for a new network host is held for
 * review and stays at its installed version.
 *
 * The source is custom and plain http, so automatic updates are off for it
 * until the user turns them on, which first accepts `unencrypted-updates`:
 * the Updates card does both.
 */

const SOURCE_ID = 'harbor-tools';
const MIN_APP_VERSION = '0.11.0';

type Entry = { path: string; mode: string; content: string };

/** The repository at `version`; from 1.0.1 the extension also reaches `upload.example.com`. */
function marketplaceTree(version: string): Entry[] {
  const file = (path: string, content: string): Entry => ({ path, mode: '100644', content });
  const authority = {
    capabilities: [],
    ...(version === '1.0.0' ? {} : { networkAccess: { allowedDomains: ['upload.example.com'], reasoning: 'Uploads drafts.' } }),
    requires: { minAppVersion: MIN_APP_VERSION, hostProtocol: '2' },
  };
  const plugin = agentPluginsDocument({
    id: 'harbor-panel',
    name: 'Harbor Panel',
    version,
    description: 'An extension whose update asks for more.',
    entry: 'dist/index.js',
    ...authority,
    tools: [{ name: 'harbor_panel_ping', description: 'Answer pong.', inputSchema: { type: 'object', properties: {}, additionalProperties: false } }],
  });
  return [
    file('marketplace.json', jsonText({
      schemaVersion: 2,
      name: SOURCE_ID,
      displayName: 'Harbor Tools',
      packages: [
        { kind: 'plugin', name: 'harbor-panel', path: 'plugins/harbor-panel' },
        { kind: 'skill', name: 'harbor-review', path: 'skills/harbor-review' },
      ],
    })),
    file('plugins/harbor-panel/ave-package.json', jsonText({
      schemaVersion: 2, kind: 'plugin', name: 'harbor-panel', version, minAppVersion: MIN_APP_VERSION, hostProtocol: '2',
      payload: { authority, artifact: { tree: 'plugins/harbor-panel' } },
    })),
    file('plugins/harbor-panel/plugin.json', jsonText(plugin)),
    file('plugins/harbor-panel/dist/index.js', 'export default function createPlugin() {\n  return { handlers: { harbor_panel_ping: async () => "pong" }, start() {}, stop() {} };\n}\n'),
    file('skills/harbor-review/ave-package.json', jsonText({
      schemaVersion: 2, kind: 'skill', name: 'harbor-review', version, minAppVersion: MIN_APP_VERSION, payload: { entry: 'SKILL.md' },
    })),
    file('skills/harbor-review/SKILL.md', `---\nname: harbor-review\ndescription: Review a harbor change (${version}).\n---\nRead the diff first.\n`),
  ];
}

/** One call on `window.aveApi.gitMarketplace`; a failed result fails the test with its code and message. */
async function call<T>(page: Page, method: string, ...args: unknown[]): Promise<T> {
  const result = await page.evaluate(
    ({ method, args }) => (window as unknown as { aveApi: { gitMarketplace: Record<string, (...a: unknown[]) => Promise<unknown>> } })
      .aveApi.gitMarketplace[method]!(...args),
    { method, args },
  ) as GitMarketplaceResult<T>;
  if (!result.ok) throw new Error(`${method} failed: ${result.code}: ${result.message}`);
  return result.value;
}

test.describe('git marketplace automatic updates', () => {
  test.use({ seedViewFixturePlugin: false, launchEnv: { AVE_E2E_MARKETPLACE_SCHEDULER: '1' } });
  test.setTimeout(180_000);

  let served: string;
  let server: GitHttpServer;
  let repo: FixtureRepo;

  test.beforeAll(async () => {
    served = mkdtempSync(join(tmpdir(), 'ave-e2e-auto-update-'));
    server = await startGitHttpServer({ root: served });
    repo = createFixtureRepo(served, SOURCE_ID);
    repo.commit({ 'README.md': 'A marketplace whose packages update by themselves.\n' }, 'start');
    repo.commitEntries(marketplaceTree('1.0.0'), 'publish 1.0.0');
  });

  test.afterAll(async () => {
    await server?.close();
    if (repo) await removeFixtureRepo(repo);
    if (served) rmSync(served, { recursive: true, force: true });
  });

  test('applies a consent-free update by itself and holds one that asks for more for review', async ({ app, mainWindow, t }) => {
    const preview = await call<SourcePreviewResultView>(mainWindow, 'previewSource', { input: server.url(SOURCE_ID), auth: 'none' });
    if (preview.type !== 'marketplace') throw new Error(`expected a marketplace preview, got ${preview.type}`);
    await call<SourceView>(mainWindow, 'addSource', { previewId: preview.previewId, id: SOURCE_ID });
    for (const [kind, name] of [['plugin', 'harbor-panel'], ['skill', 'harbor-review']] as const) {
      const plan = await call<InstallPlanView>(mainWindow, 'planInstall', { sourceId: SOURCE_ID, kind, name });
      await call(mainWindow, 'executeInstall', plan.planId);
    }

    // A custom source over http is off by default; turning it on accepts unencrypted-updates first.
    const settings = await openInlineSettings(app, mainWindow, 'marketplace');
    const sourceRow = settings.getByTestId(`git-marketplace:updates:source:${SOURCE_ID}`);
    await expect(sourceRow).toBeVisible({ timeout: 30_000 });
    await sourceRow.getByTestId(`git-marketplace:updates:source-switch:${SOURCE_ID}`).selectOption('on');
    await expect(sourceRow.getByTestId('git-marketplace:updates:unencrypted')).toContainText(t('gitMarketplace.warning.unencryptedUpdates', { source: 'Harbor Tools' }));
    await sourceRow.getByTestId('git-marketplace:updates:unencrypted:continue').click();
    await expect(sourceRow.getByTestId(`git-marketplace:updates:source-switch:${SOURCE_ID}`)).toHaveValue('on', { timeout: 30_000 });

    // Publish 1.0.1 and press Check now: the skill applies, the extension waits for review.
    repo.commitEntries(marketplaceTree('1.0.1'), 'publish 1.0.1');
    await settings.getByTestId('git-marketplace:updates:check').click();
    await expect.poll(async () => (await call<UpdateStatusView>(mainWindow, 'updateStatus')).packages
      .map((update) => `${update.key.kind}/${update.key.name}:${update.state}`).sort(), { timeout: 60_000 })
      .toEqual(['plugin/harbor-panel:needs-review', 'skill/harbor-review:applied']);
    const status = await call<UpdateStatusView>(mainWindow, 'updateStatus');
    expect(status.packages.find((update) => update.key.kind === 'plugin')?.reasons).toEqual(['consent-changed']);

    const installed = await call<CatalogView>(mainWindow, 'listCatalog', { installedOnly: true });
    expect(installed.entries.map((entry) => `${entry.key.kind}/${entry.key.name}@${JSON.stringify(entry.state)}`).sort()).toEqual([
      `plugin/harbor-panel@${JSON.stringify({ state: 'update', from: '1.0.0', to: '1.0.1' })}`,
      `skill/harbor-review@${JSON.stringify({ state: 'installed', version: '1.0.1' })}`,
    ]);

    // The card says both, and the notice names the automatic update.
    await expect(settings.getByTestId(`git-marketplace:updates:recent:${SOURCE_ID}:skill:harbor-review`)).toContainText('1.0.0 → 1.0.1');
    const held = settings.getByTestId(`git-marketplace:updates:row:${SOURCE_ID}:plugin:harbor-panel`);
    await expect(held.getByTestId('git-marketplace:updates:state')).toHaveText(t('gitMarketplace.updates.state.needsReview'));
    await expect(held.getByTestId('git-marketplace:updates:reasons')).toHaveText(t('gitMarketplace.updates.reason.consentChanged'));
    await expect(settings.getByTestId(`git-marketplace:boot-notice:auto-updated:${SOURCE_ID}:skill:harbor-review`)).toBeVisible();
    await test.info().attach('auto-update-card', { body: await settings.getByTestId('git-marketplace:updates').screenshot(), contentType: 'image/png' });

    // The review shows what changes, and installs only when the user confirms.
    await held.getByTestId('git-marketplace:updates:review').click();
    const sheet = mainWindow.getByTestId('git-marketplace:sheet');
    await expect(sheet.getByTestId('git-marketplace:consent-row:authority.networkAccess')).toContainText('upload.example.com');
    await sheet.getByTestId('git-marketplace:confirm').click();
    await expect(sheet.getByTestId('git-marketplace:done')).toBeVisible({ timeout: 60_000 });
    await sheet.getByTestId('git-marketplace:sheet:close').click();
    await closeInlineSettings(app, settings);
  });
});
