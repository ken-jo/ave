import { permissionSettingsPath } from "../../src/permissions/permission-settings-store.js";
import { VIEW_FIXTURE } from '../fixtures/e2e-plugins/view-fixture.js';
import {
  writeFixturePlugin,
  writeFixtureRegistry,
  type FixturePlugin,
} from '../fixtures/e2e-plugins/seed.js';
import path from 'node:path';
import fs from 'node:fs';

// Seed only repository fixtures; unknown plugin IDs must fail.
const SCREENSHOT_FIXTURE_PLUGINS: Readonly<Record<string, FixturePlugin>> = {
  [VIEW_FIXTURE.manifest.id]: VIEW_FIXTURE,
};

export function seedReviewerMode(
  aveHomeForTest: string,
  mode: 'disabled' | 'llm',
): void {
  const aveHomeSettingsPath = permissionSettingsPath(aveHomeForTest);
  let aveHomeSettings: Record<string, unknown> = {};
  try {
    // Read directly to avoid an existence-check race.
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
    },
  };
  fs.mkdirSync(path.dirname(aveHomeSettingsPath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(aveHomeSettingsPath, `${JSON.stringify(aveHomeSettings, null, 2)}\n`, {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

// Permissions require a complete version-1 document with a rules array.
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

// Local captures grant no host secrets and disable review unless explicitly requested.
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
