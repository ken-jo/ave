import { VIEW_FIXTURE } from '../fixtures/e2e-plugins/view-fixture.js';
import {
  writeFixturePlugin,
  writeFixtureRegistry,
  type FixturePlugin,
} from '../fixtures/e2e-plugins/seed.js';
import path from 'node:path';
import fs from 'node:fs';

/**
 * Plugin side-loader for the screenshot harness.
 *
 * It installs only the fixture plugins under `test/fixtures/e2e-plugins`, so a
 * capture reads nothing outside this repository: no sibling plugin checkout,
 * no built bundle from elsewhere, no interpreter from the operator's own
 * `~/.ave`. A scenario that names a plugin this table does not hold fails the
 * run rather than capturing an empty frame. Keys whose subject is another
 * plugin repository's own UI are out of scope (see
 * `PLUGIN_REPOSITORY_KEYS_OUT_OF_SCOPE` in matrix.ts).
 */
const SCREENSHOT_FIXTURE_PLUGINS: Readonly<Record<string, FixturePlugin>> = {
  [VIEW_FIXTURE.manifest.id]: VIEW_FIXTURE,
};

/**
 * Write `permissions.reviewer.mode` into the isolated profile's
 * `~/.ave/settings.json`.
 *
 * `disabled` carries the `disabledMigratedAt` marker because without it
 * `migrateLegacyDisabledMode` rewrites `disabled` -> `strict` (defer every
 * HIGH) at load, which is the opposite of what the caller asked for — see
 * src/permissions/permission-settings-store.ts.
 */
export function seedReviewerMode(
  aveHomeForTest: string,
  mode: 'disabled' | 'rule' | 'llm' | 'strict',
): void {
  const aveHomeSettingsPath = path.join(aveHomeForTest, 'settings.json');
  let aveHomeSettings: Record<string, unknown> = {};
  try {
    // Read directly and treat ENOENT like malformed JSON — avoids the
    // exists-then-read TOCTOU race (CodeQL js/file-system-race).
    aveHomeSettings = JSON.parse(fs.readFileSync(aveHomeSettingsPath, 'utf-8')) as Record<string, unknown>;
  } catch {
    aveHomeSettings = {};
  }
  const existingPerms =
    (aveHomeSettings.permissions as Record<string, unknown> | undefined) ?? {};
  aveHomeSettings.permissions = {
    ...existingPerms,
    reviewer: {
      mode,
      ...(mode === 'disabled' ? { disabledMigratedAt: new Date().toISOString() } : {}),
    },
  };
  fs.mkdirSync(path.dirname(aveHomeSettingsPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(aveHomeSettingsPath, `${JSON.stringify(aveHomeSettings, null, 2)}\n`, {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

/**
 * Write the permission execution mode into the isolated profile's
 * `permissions.json`.
 *
 * The WHOLE `PermissionsFile` shape is written on purpose: `readPermissionsFile`
 * discards the file unless `version === 1` and `rules` is an array, and a
 * discarded file leaves the manager on `default` — a partial seed would look
 * like it worked while the mode never changed.
 */
export function seedExecutionMode(
  aveHomeForTest: string,
  mode: 'default' | 'strict' | 'auto' | 'allow',
): void {
  fs.mkdirSync(aveHomeForTest, { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    path.join(aveHomeForTest, 'permissions.json'),
    `${JSON.stringify({ version: 1, rules: [], mode, updatedAt: new Date().toISOString() }, null, 2)}\n`,
    { encoding: 'utf-8', mode: 0o600 },
  );
}

/**
 * Install the requested fixture plugins into the isolated `~/.ave/plugins/`
 * and write the registry, so the host loads them as local-dev installs at
 * boot. A local-dev install holds no host-secret grant (design §10.3).
 *
 * The LLM permission reviewer is disabled unless `disableReviewer` is false:
 * a plugin panel's mount-time tool call would otherwise open the approval
 * dock over the panel. `plugin-permission-grant` keeps it on, because that
 * dock is its capture target. `disabled` carries the migration marker; see
 * `seedReviewerMode`.
 *
 * @param pluginIds fixture plugin ids to install (an empty list writes an empty registry).
 */
export async function seedFixturePlugins(
  aveHomeForTest: string,
  pluginIds: readonly string[],
  opts: { disableReviewer?: boolean } = {},
): Promise<void> {
  const unknown = pluginIds.filter((id) => !Object.hasOwn(SCREENSHOT_FIXTURE_PLUGINS, id));
  if (unknown.length > 0) {
    throw new Error(
      `[screenshots] no in-repository fixture plugin for: ${unknown.join(', ')} `
        + `(known: ${Object.keys(SCREENSHOT_FIXTURE_PLUGINS).join(', ')})`,
    );
  }
  fs.mkdirSync(path.join(aveHomeForTest, 'plugins'), { recursive: true, mode: 0o700 });
  if (pluginIds.length > 0 && (opts.disableReviewer ?? true)) {
    seedReviewerMode(aveHomeForTest, 'disabled');
  }
  const entries = [];
  for (const id of pluginIds) {
    entries.push(await writeFixturePlugin(aveHomeForTest, SCREENSHOT_FIXTURE_PLUGINS[id]!));
  }
  writeFixtureRegistry(aveHomeForTest, entries);
}
