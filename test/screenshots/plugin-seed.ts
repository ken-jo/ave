import path from 'node:path';
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import {
  hashReceiptFiles,
  listFilesRecursive,
  writeInstallReceipt,
} from '../../src/plugins/plugin-install-receipt.js';

/**
 * Whether this run may use the machine's pre-provisioned Python venvs.
 *
 * Off by default: a worker-backed plugin needs a real interpreter, and
 * building one inside an isolated profile would mean a network install per
 * capture. On, three things change together — the manifest keeps its `python`
 * block (here), `fixtures.ts` hardlinks the matching venv in, and `matrix.ts`
 * stops skipping the scenarios that need a live worker. One flag read in one
 * place, because two of those three silently produce a plugin that loads and
 * then tears itself down.
 */
export const REAL_PYTHON_CAPTURES = process.env.AVE_SCREENSHOT_REAL_PYTHON === '1';

/**
 * REAL plugin side-loader for the screenshot harness.
 *
 * Unlike `test/e2e/ui/fixtures.ts`'s `seedE2ePlugins`, which overwrites every
 * `ui[].entry` with an inert `"E2E Plugin UI"` stub (it only tests host-side
 * lifecycle wiring), this copies the plugin repo's REAL built `dist/` tree into
 * the isolated `~/.ave/plugins/<id>/` so the plugin's actual UI bundle renders
 * inside the plugin webview. That is the whole point of the harness: capture
 * real plugin screens, not placeholder text.
 *
 * The plugin repos live as siblings of this app repo (or of any linked git
 * worktree) at `../ave-plugin-<slug>/`. Their `dist/` is NOT committed, so a
 * fresh clone has to be built once (`bun install && bun run build` in that repo)
 * before the harness can seed it; the harness copies the already-built bundle
 * verbatim and never builds. A repo with no `dist/` is reported as missing and
 * the scenario that asked for it captures nothing meaningful.
 *
 * Receipt verification (`plugin-install-receipt.ts`, enforced unconditionally
 * at load since the receipt-check-bypass removal) only validates the files it
 * lists — extra unlisted files in the plugin dir are not flagged — so the
 * receipt lists `plugin.json` + the host entry + every declared UI entry, while
 * the full `dist/` tree is copied so the UI bundle's own relative imports and
 * sibling assets resolve.
 */


/** Manifest shape we read the few fields we care about off of. */
interface PluginManifest {
  id?: unknown;
  version?: unknown;
  entry?: unknown;
  pluginAccess?: unknown;
  ui?: Array<{ entry?: unknown; kind?: unknown }>;
}

export interface SeededPluginEntry {
  id: string;
  manifestPath: string;
  enabled: boolean;
  installSource: 'local-dev';
  approvedPluginAccess?: unknown;
}

/**
 * Resolve where the sibling plugin repos live. Mirrors the resolution used by
 * `test/e2e/ui/fixtures.ts` so the two harnesses find the same checkouts:
 * `AVE_E2E_PLUGIN_SOURCE_ROOT` override → this repo's parent → any linked git
 * worktree's parent, picking the first dir that actually contains a plugin repo.
 */
export function resolvePluginSourceRoot(repoRoot: string, probeSlug = 'ave-plugin-local-indexer'): string {
  if (process.env.AVE_E2E_PLUGIN_SOURCE_ROOT) {
    return path.resolve(process.env.AVE_E2E_PLUGIN_SOURCE_ROOT);
  }
  const candidates = [path.resolve(repoRoot, '..')];
  try {
    const output = execSync('git worktree list --porcelain', {
      cwd: repoRoot,
      stdio: ['ignore', 'pipe', 'ignore'],
    }).toString();
    for (const line of output.split('\n')) {
      if (!line.startsWith('worktree ')) continue;
      candidates.push(path.dirname(line.slice('worktree '.length).trim()));
    }
  } catch {
    /* non-git checkout — fall back to repoRoot/.. */
  }
  const unique = [...new Set(candidates)];
  return (
    unique.find((c) => fs.existsSync(path.join(c, probeSlug, 'plugin.json'))) ?? unique[0]
  );
}

/** Map a manifest id (e.g. "local-indexer") to its sibling repo slug. */
function repoSlugForPlugin(id: string, sourceRoot: string): string | null {
  // Most repos are `ave-plugin-<id>`; lyra-mail/ep follow the same rule.
  const candidates = [`ave-plugin-${id}`, id];
  for (const slug of candidates) {
    if (fs.existsSync(path.join(sourceRoot, slug, 'plugin.json'))) return slug;
  }
  // Fall back: scan every ave-plugin-* dir and match on manifest id.
  try {
    for (const name of fs.readdirSync(sourceRoot)) {
      if (!name.startsWith('ave-plugin-')) continue;
      const mp = path.join(sourceRoot, name, 'plugin.json');
      if (!fs.existsSync(mp)) continue;
      try {
        const m = JSON.parse(fs.readFileSync(mp, 'utf-8')) as PluginManifest;
        if (m.id === id) return name;
      } catch {
        /* skip unparseable */
      }
    }
  } catch {
    /* sourceRoot unreadable */
  }
  return null;
}

/** Recursively copy a directory tree (built dist). */
function copyDir(src: string, dest: string): void {
  fs.mkdirSync(dest, { recursive: true, mode: 0o700 });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d);
    } else if (entry.isFile()) {
      fs.copyFileSync(s, d);
    }
  }
}

export interface SeedRealPluginsResult {
  /** Plugin ids successfully seeded. */
  seeded: string[];
  /** Plugin ids requested but not found on disk (skipped, not fatal). */
  missing: string[];
}

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
 * Copy the REAL built bundles of the requested plugins into the isolated
 * `~/.ave/plugins/` and write the registry + receipts so the host loads them
 * as local-dev installs at boot. A local-dev install holds no host-secret
 * grant (design §10.3), so a panel that reads the host's LLM key shows its
 * no-key state.
 *
 * @param pluginIds manifest ids to install (e.g. ["local-indexer", "meeting"]).
 */
export async function seedRealPlugins(
  repoRoot: string,
  aveHomeForTest: string,
  pluginIds: readonly string[],
  opts: { disableReviewer?: boolean } = {},
): Promise<SeedRealPluginsResult> {
  const disableReviewer = opts.disableReviewer ?? true;
  const pluginsRoot = path.join(aveHomeForTest, 'plugins');
  const cacheRoot = path.join(pluginsRoot, '.cache');
  fs.mkdirSync(pluginsRoot, { recursive: true, mode: 0o700 });

  // Disable the LLM permission reviewer for plugin-panel captures.
  //
  // A plugin UI panel calls its read-category tools (index_documents,
  // meeting_list_preps, vega_helper_list_detectors, …) on mount. The default
  // reviewer is `mode:"llm"` following the active chat vendor; with the harness's
  // placeholder `plain:sk-e2e-*` key the reviewer LLM call errors, and
  // `fallbackOnError` classifies the invocation HIGH → a deferred "Approve Tool
  // Execution" modal covers the whole window, so the panel's own UI never
  // renders. Seeding `reviewer.mode:"disabled"` (post-#664 pass-through-LOW
  // semantics) makes those mount-time read calls classify LOW and run without a
  // modal, so the plugin's real panel paints. The `disabledMigratedAt` marker is
  // REQUIRED — without it `migrateLegacyDisabledMode` rewrites `disabled` →
  // `strict` (defer-all-HIGH) at load and the modal returns
  // (src/permissions/permission-settings-store.ts).
  // When `disableReviewer` is false the reviewer is left at its default (llm),
  // which — with the placeholder key — defers the plugin's mount-time read tool
  // to the "Approve Tool Execution" modal. That modal IS the capture target for
  // the `plugin-permission-grant` docs key, so that one scenario opts out here.
  if (disableReviewer) {
    seedReviewerMode(aveHomeForTest, 'disabled');
  }

  const sourceRoot = resolvePluginSourceRoot(repoRoot);
  const entries: SeededPluginEntry[] = [];
  const seeded: string[] = [];
  const missing: string[] = [];

  for (const pluginId of pluginIds) {
    const slug = repoSlugForPlugin(pluginId, sourceRoot);
    const sourceDir = slug ? path.join(sourceRoot, slug) : null;
    const sourceManifest = sourceDir ? path.join(sourceDir, 'plugin.json') : null;
    const sourceDist = sourceDir ? path.join(sourceDir, 'dist') : null;
    if (!sourceDir || !sourceManifest || !fs.existsSync(sourceManifest)) {
      console.warn(`[screenshots] plugin source missing, not seeded: ${pluginId} (looked under ${sourceRoot})`);
      missing.push(pluginId);
      continue;
    }
    if (!sourceDist || !fs.existsSync(sourceDist)) {
      console.warn(`[screenshots] plugin dist not built, not seeded: ${pluginId} (run 'bun run build' in ${sourceDir})`);
      missing.push(pluginId);
      continue;
    }

    const manifest = JSON.parse(fs.readFileSync(sourceManifest, 'utf-8')) as PluginManifest;
    if (typeof manifest.id !== 'string' || typeof manifest.version !== 'string') {
      console.warn(`[screenshots] invalid plugin manifest, not seeded: ${sourceManifest}`);
      missing.push(pluginId);
      continue;
    }

    const pluginDir = path.join(pluginsRoot, manifest.id);
    fs.rmSync(pluginDir, { recursive: true, force: true });
    fs.mkdirSync(pluginDir, { recursive: true, mode: 0o700 });

    // Write the manifest with the `python` field stripped BY DEFAULT. Same
    // reasoning as test/e2e/ui/fixtures.ts (`delete base.python`): a
    // host-managed Python block makes the runtime require a lockfile +
    // provisioned interpreter at lifecycle start. For a plugin whose worker is
    // OPTIONAL to its UI that lets the panel render its empty state; but a
    // worker-backed plugin (local-indexer) hard-requires `pythonExecutable` in
    // its own `startInternal` and throws without it regardless of the manifest,
    // so with the block stripped it degrades to a Doctor entry and never shows
    // a live panel.
    //
    // OPT-IN real Python (AVE_SCREENSHOT_REAL_PYTHON=1): keep the `python`
    // block and copy the requirements lockfile next to the manifest so the
    // host's PythonRuntimeBootstrapper resolves it at lifecycle start (it then
    // cache-hits the pre-provisioned venv that fixtures.ts hardlinks into the
    // isolated runtime — no network, no build). This lets the worker start for
    // real and the live panel render. The worker script itself already ships in
    // the copied `dist/worker/` tree. The receipt is computed against whichever
    // manifest shape is written here.
    const seededManifest = { ...(manifest as Record<string, unknown>) };
    const pythonBlock = (manifest as { python?: { requirementsLock?: unknown } }).python;
    if (!REAL_PYTHON_CAPTURES || !pythonBlock) {
      delete seededManifest.python;
    }
    // Drop manifest fields the host's current schema does not yet accept
    // (e.g. `onboarding`, ahead of the host schema on some plugins). They are
    // orthogonal to UI capture; leaving them would fail manifest validation at
    // load and the plugin would never render. Remove here so the panel mounts.
    // Gate so we can verify whether the host now accepts the field.
    if (!process.env.AVE_SCREENSHOT_KEEP_ONBOARDING) {
      delete seededManifest.onboarding;
    }
    const pluginJsonPath = path.join(pluginDir, 'plugin.json');
    fs.writeFileSync(pluginJsonPath, `${JSON.stringify(seededManifest, null, 2)}\n`, 'utf-8');
    // Copy the ENTIRE built dist tree so UI bundle imports/assets resolve.
    copyDir(sourceDist, path.join(pluginDir, 'dist'));
    // Real-Python opt-in: copy the requirements lockfile so the host can resolve
    // it (it lives at the plugin repo root, not under dist/, so the dist copy
    // above does not include it). It MUST be added to the install receipt below
    // — the host now rejects a payload that contains any unlisted file.
    if (REAL_PYTHON_CAPTURES && pythonBlock && typeof pythonBlock.requirementsLock === 'string') {
      const lockSrc = path.join(sourceDir, pythonBlock.requirementsLock);
      if (fs.existsSync(lockSrc)) {
        fs.copyFileSync(lockSrc, path.join(pluginDir, pythonBlock.requirementsLock));
      } else {
        console.warn(`[screenshots] real-python: lockfile missing, worker will not start: ${lockSrc}`);
      }
    }

    // Receipt: list plugin.json + the entire copied dist tree so the integrity
    // check passes for the real files (matches what the host wrote at copy).
    // The host now rejects an installed payload that contains any file NOT in
    // the receipt, so EVERY seeded file must be listed — including the
    // real-python requirements lockfile copied above.
    const receiptFiles = ['plugin.json'];
    for (const file of await listFilesRecursive(path.join(pluginDir, 'dist'))) {
      receiptFiles.push(`dist/${file}`);
    }
    if (REAL_PYTHON_CAPTURES && pythonBlock && typeof pythonBlock.requirementsLock === 'string'
      && fs.existsSync(path.join(pluginDir, pythonBlock.requirementsLock))) {
      receiptFiles.push(pythonBlock.requirementsLock);
    }
    await writeInstallReceipt(cacheRoot, {
      schemaVersion: 3,
      pluginId: manifest.id,
      version: manifest.version,
      installSource: 'local-dev',
      artifactSha256: null,
      signerKeyId: null,
      admission: null,
      installedAt: new Date().toISOString(),
      files: await hashReceiptFiles(pluginDir, receiptFiles),
    });

    entries.push({
      id: manifest.id,
      manifestPath: `${manifest.id}/plugin.json`,
      enabled: true,
      installSource: 'local-dev',
      approvedPluginAccess: manifest.pluginAccess,
    });
    seeded.push(manifest.id);
  }

  fs.writeFileSync(
    path.join(pluginsRoot, 'registry.json'),
    `${JSON.stringify({ version: 1, plugins: entries }, null, 2)}\n`,
    'utf-8',
  );

  return { seeded, missing };
}
