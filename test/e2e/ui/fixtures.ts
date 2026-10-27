import { type ElectronApplication, type Page,
} from "playwright";
import { test as base, expect } from "@playwright/test";
import path from "node:path";
import { tmpdir } from "node:os";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildE2eBaseSettings,
  buildE2eSecrets,
  buildIsolatedElectronEnv,
  launchElectron,
  makeTreeWritableSync,
} from "./seeded-electron";
import { makeTestT, type TestT } from "./i18n.js";

import { ALERT_FIXTURE_MANIFEST, ALERT_FIXTURE_SOURCE } from "./alert-fixture.js";
import { VIEW_FIXTURE } from "../../fixtures/e2e-plugins/view-fixture.js";
import {
  writeFixturePlugin,
  writeFixtureRegistry,
  type FixtureManifest,
  type FixtureRegistryEntry,
} from "../../fixtures/e2e-plugins/seed.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));

type LaunchEnv = Record<string, string | undefined>;

async function seedE2ePlugins(
  aveHome: string,
  seedTogglePlugin: boolean,
  seedViewFixturePlugin: boolean,
  seedAlertPlugin: boolean,
): Promise<void> {
  const entries: FixtureRegistryEntry[] = [];
  if (seedAlertPlugin) {
    entries.push(await writeFixturePlugin(aveHome, {
      manifest: ALERT_FIXTURE_MANIFEST,
      files: { [ALERT_FIXTURE_MANIFEST.entry]: ALERT_FIXTURE_SOURCE },
    }));
  }
  if (seedTogglePlugin) {
    entries.push(await writeFixturePlugin(aveHome, {
      manifest: {
        id: "e2e-toggle-plugin",
        name: "E2E Toggle Plugin",
        version: "0.0.0",
        description:
          "Minimal plugin used by plugin active/inactive E2E coverage.",
        entry: "dist/hostPlugin.js",
        requires: { minAppVersion: "0.12.0", hostProtocol: "4" },
        tools: [
          {
            name: "e2e_toggle_ping",
            description: "E2E toggle smoke tool",
            inputSchema: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
            _meta: {
              ui: { visibility: ["model", "app"] },
            },
          },
        ],
      } as FixtureManifest,
      files: {
        "dist/hostPlugin.js": `export default function createPlugin() {
  return {
    handlers: { e2e_toggle_ping: async () => "pong" },
    start() {},
    stop() {}
  };
}\n`,
      },
    }));
  }
  if (seedViewFixturePlugin) {
    entries.push(await writeFixturePlugin(aveHome, VIEW_FIXTURE));
  }
  writeFixtureRegistry(aveHome, entries);
}

/** Shared fixture: launches the built Electron main process with an isolated userData dir so E2E runs do not pollute local state. */
export type ElectronFixtures = {
  app: ElectronApplication;
  mainWindow: Page;
  userDataDir: string;
  tempHome: string;
  aveHome: string;
  /** i18n catalog binding for locale-agnostic assertions (see ./i18n.ts). */
  t: TestT;
};
export type ElectronOptions = {
  launchEnv: LaunchEnv;
  onboardingCompleted: boolean;
  seedTogglePlugin: boolean;
  seedAlertPlugin: boolean;
  seedPermissionMode: "default" | "allow" | undefined;
  seedViewFixturePlugin: boolean;
  seedApiKey: boolean;
  /** Raw persisted provider id, including an id a newer build has retired. */
  seedLlmProvider: string;
  seedLocale: "ko" | "en";
  /** Explicit saved sandbox preference; undefined exercises production defaults. */
  seedOsToolSandbox: boolean | undefined;
  /** Launch with `AVE_DEV=1` (the default). A spec that checks what a user's build asks for (an http or loopback marketplace's confirmations, design
   * §18.2.2) turns it off; without it, the seeded `local-dev` fixture plugins do not load, so such a spec also sets `seedViewFixturePlugin: false`. */
  devFlag: boolean;
};

export const test = base.extend<ElectronFixtures & ElectronOptions>({
  launchEnv: [{}, { option: true }],
  onboardingCompleted: [true, { option: true }],
  seedTogglePlugin: [false, { option: true }],
  seedAlertPlugin: [false, { option: true }],
  seedPermissionMode: [undefined, { option: true }],
  seedViewFixturePlugin: [true, { option: true }],
  // Seed a usable LLM key so the composer is enabled (see buildE2eSecrets). Specs that assert the no-key / key-toggle state override with `test.use({ seedApiKey: false })`.
  seedApiKey: [true, { option: true }],
  seedLlmProvider: ["", { option: true }],
  // UI locale to seed. Defaults to 'en'; the production default; so ./fixtures specs exercise the English render path; their assertions go through the `t` fixture so they resolve
  // whatever is seeded. Specs that need Korean override with `test.use({ seedLocale: 'ko' })`; specs with their own harness pin their locale via a module-scoped `makeTestT(...)`.
  seedLocale: ["en", { option: true }],
  seedOsToolSandbox: [undefined, { option: true }],
  devFlag: [true, { option: true }],

  userDataDir: async ({}, use) => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "ave-e2e-"));
    await use(dir);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  },

  tempHome: async ({}, use) => {
    const dir = fs.mkdtempSync(path.join(tmpdir(), "ave-e2e-home-"));
    await use(dir);
    makeTreeWritableSync(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  },

  aveHome: async ({ tempHome }, use) => {
    const dir = path.join(tempHome, ".ave");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    await use(dir);
  },

  app: async (
    {
      userDataDir,
      tempHome,
      aveHome,
      launchEnv,
      onboardingCompleted,
      seedTogglePlugin,
      seedViewFixturePlugin,
      seedAlertPlugin,
      seedPermissionMode,
      seedApiKey,
      seedLlmProvider,
      seedLocale,
      seedOsToolSandbox,
      devFlag,
    },
    use,
  ) => {
    const repoRoot = path.resolve(HERE, "../../..");
    const mainEntry = path.join(repoRoot, "dist/src/main/main.js");
    if (!fs.existsSync(mainEntry)) {
      throw new Error(
        `Electron main entry not found at ${mainEntry}. Run 'bun run build' before 'playwright test'.`,
      );
    }
    /* Isolate Ave user-data state under the per-test temp dir so encrypted secret blobs from a previous dev run on `~/.ave/secrets/` do not bleed into the test (their Keychain key may have rotated, decryption fails, bootstrap dies). Resolved via the shared `aveHome()` helper. Permission mode for the profile. The default is `default`, under which a real model's first path-bearing tool call parks the turn on an approval card; nobody answers it headlessly, so a live spec that needs tools to actually RUN never gets past the first one. Export AVE_E2E_PERMISSION_MODE=allow to exercise the tool path end to end. */
    const permissionMode = seedPermissionMode ?? process.env.AVE_E2E_PERMISSION_MODE?.trim();
    if (permissionMode) {
      // The WHOLE PermissionsFile shape. `readPermissionsFile` discards the file unless `version === 1` and `rules` is an array, and a
      // discarded file silently falls back to `default`; so a partial seed looks like it worked while the app never leaves the default mode.
      fs.writeFileSync(
        path.join(aveHome, "permissions.json"),
        JSON.stringify(
          { version: 1, rules: [], mode: permissionMode, updatedAt: new Date().toISOString() },
          null,
          2,
        ) + "\n",
        { encoding: "utf-8", mode: 0o600 },
      );
    }
    const baseSettings = buildE2eBaseSettings(onboardingCompleted, seedLocale);
    if (seedOsToolSandbox !== undefined) {
      baseSettings.features = { ...(baseSettings.features as object), osToolSandbox: seedOsToolSandbox };
    }
    const initialSettings = seedLlmProvider
      ? { ...baseSettings, llm: { provider: seedLlmProvider } }
      : baseSettings;
    fs.writeFileSync(
      path.join(userDataDir, "ave-settings.json"),
      JSON.stringify(
        initialSettings,
        null,
        2,
      ) + "\n",
      "utf-8",
    );
    // Live-model opt-in. With no key exported this is undefined and every spec stays offline on the fake seeded credentials, so
    // the normal suite is unaffected; with one, the profile is pinned to OpenRouter and the app under test talks to a real provider.
    const liveKey = process.env.AVE_SMOKE_OPENROUTER_KEY?.trim();
    if (liveKey) {
      const settings = JSON.parse(
        fs.readFileSync(path.join(userDataDir, "ave-settings.json"), "utf-8"),
      ) as { llm?: { provider?: string; vendors?: Record<string, unknown> } };
      settings.llm = {
        ...settings.llm,
        provider: "openrouter",
        vendors: {
          ...(settings.llm?.vendors ?? {}),
          openrouter: {
            // Cheap router target by default. The app ships `anthropic/claude-sonnet-4.6`, but Ave sends no `maxOutputTokens` (adapter.ts; "vendor SDK defaults govern"), so
            // OpenRouter pre-authorizes that model's full 65536-token output and a credit-limited key is rejected 402 on every turn. Override with AVE_SMOKE_MODEL to reproduce that.
            model: process.env.AVE_SMOKE_MODEL?.trim() || "openrouter/auto",
            baseUrl: "https://openrouter.ai/api/v1",
          },
        },
      };
      fs.writeFileSync(
        path.join(userDataDir, "ave-settings.json"),
        JSON.stringify(settings, null, 2) + "\n",
        "utf-8",
      );
    }
    if (seedApiKey) {
      // Seed an at-rest LLM key secret so `has-api-key` is true at boot and the composer is enabled. Written to the same userData dir as the settings file (SettingsService resolves both from
      // options.userDataPath). Use owner-only mode 0o600 to match production SettingsService.saveSecrets, so the seeded file is never group/world-readable before the app's own permission migration runs.
      fs.writeFileSync(
        path.join(userDataDir, "ave-secrets.json"),
        JSON.stringify(buildE2eSecrets(liveKey), null, 2) + "\n",
        { encoding: "utf-8", mode: 0o600 },
      );
    }
    await seedE2ePlugins(
      aveHome,
      seedTogglePlugin,
      seedViewFixturePlugin,
      seedAlertPlugin,
    );
    const app = await launchElectron({
      args: [mainEntry, `--user-data-dir=${userDataDir}`, "--no-sandbox"],
      env: buildIsolatedElectronEnv({
        ...launchEnv,
        HOME: tempHome,
        USERPROFILE: tempHome,
        ...(devFlag ? { AVE_DEV: "1" } : {}),
        AVE_E2E: "1",
        AVE_HOME: aveHome,
        NODE_ENV: "test",
        ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
      }),
      timeout: 30_000,
    });
    // Capture main-process console output to help diagnose CI crashes.
    app
      .process()
      .stdout?.on("data", (d: Buffer) =>
        process.stdout.write(`[electron:stdout] ${d}`),
      );
    app
      .process()
      .stderr?.on("data", (d: Buffer) =>
        process.stdout.write(`[electron:stderr] ${d}`),
      );
    await use(app);
    await app.close().catch(() => {});
  },

  mainWindow: async ({ app }, use) => {
    const win = await app.firstWindow();
    // The app first loads a data: splash URL, then boots and replaces it with the real index.html. Wait for the top action bar root via data-testid; this is the first
    // persistent element after React mounts and survives view changes. Locale-independent: previously we matched on Korean header text, which would break the moment the UI is localized.
    await win.locator('[data-testid="main-toolbar"]').first().waitFor({
      state: "visible",
      timeout: 60_000,
    });
    // Neutralize the plugin onboarding proposal card. With onboardingCompleted seeded true the host treats the harness as a returning user, so the gate is open at boot and a seeded repository plugin (e.g. meeting) yields a proposal on every run. No spec
    // asserts it, and a card in the floating lane takes pointer events the specs aim elsewhere; so hide it globally. CSS applies even if it mounts after this point, and specs that need it can scope it back in. Keeps the harness locale/onboarding-state agnostic.
    await win.addStyleTag({
      content: '[data-overlay-source="proposal"]{display:none !important;}',
    });
    await use(win);
  },

  // Catalog binding for locale-agnostic assertions, bound to the seeded locale.
  t: async ({ seedLocale }, use) => {
    await use(makeTestT(seedLocale));
  },
});

export { expect };
