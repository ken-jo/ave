import { _electron as electron, type ElectronApplication, type Page,
} from "playwright";
import { once } from "node:events";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { expect } from "@playwright/test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { LLM_VENDOR_DEFAULTS, type LLMVendor,
} from "../../../src/shared/llm-vendor-defaults.js";
import { DEFAULT_APPEARANCE } from "../../../src/shared/appearance-settings.js";
import { cleanupTmpDir } from "../../../src/__tests__/support/tmp-dir-teardown.js";
import { MAIN_CHAT_GROUP_ID } from "../../../src/contract/app-contract.js";
import { launchBaseEnv, windowsProfileEnv } from "./windows-e2e-profile.js";
export { withNativeFocusDiagnostics } from "./native-focus.js";
import { resolveE2eExecutable } from "./background-electron.js";
import { sendRendererEvent, withPageWindow } from "./renderer-events.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const electronProcesses = new WeakMap<ElectronApplication, ReturnType<ElectronApplication["process"]>>();
const closedElectronProcesses = new WeakSet<ReturnType<ElectronApplication["process"]>>();
export const REPO_ROOT = resolve(HERE, "../../..");
export const MAIN_ENTRY = resolve(REPO_ROOT, "dist/src/main/main.js");

type JsonObject = Record<string, unknown>;

export type LaunchEnv = Record<string, string | undefined>;

const SAFE_PROCESS_ENV_KEYS = [
  "PATH",
  "TMPDIR",
  "TEMP",
  "TMP",
  "LANG",
  "LC_ALL",
  "DISPLAY",
  "XAUTHORITY",
  "WAYLAND_DISPLAY",
  "DBUS_SESSION_BUS_ADDRESS",
  "XDG_RUNTIME_DIR",
  "CI",
  "GITHUB_ACTIONS",
  "RUNNER_TEMP",
  "RUNNER_TOOL_CACHE",
  "PLAYWRIGHT_BROWSERS_PATH",
] as const;

function safeProcessEnv(): LaunchEnv {
  const env: LaunchEnv = {};
  for (const key of SAFE_PROCESS_ENV_KEYS) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return env;
}

/** Chromium switches every e2e Electron launch gets. On macOS, safeStorage otherwise opens the login Keychain item "Ave Safe Storage", whose ACL
 * does not match a test Electron, and macOS prompts the machine's owner mid-run. The mock keychain keeps e2e off the owner's Keychain entirely. */
export const E2E_CHROMIUM_SWITCHES: readonly string[] = process.platform === "darwin" ? ["--use-mock-keychain"] : [];

/** The E2E runtime signal every e2e launch carries (`isE2eTestRuntime` in src/boot/dev-flags.ts). Among other things it keeps the app from claiming the OS
 * `ave://` handler (src/main/ave-protocol-registration.ts), so a spec never depends on the launch being unpackaged to leave the installed app's deep links alone. */
export const E2E_RUNTIME_ENV = Object.freeze({ AVE_E2E: "1", NODE_ENV: "test" });

/** The only way an e2e spec launches Electron (test/scripts/e2e-electron-launch.test.ts keeps it that way): Playwright's launch with {@link
 * E2E_CHROMIUM_SWITCHES} in front and {@link E2E_RUNTIME_ENV} over the spec's env (Playwright's default env is `process.env`, so a spec that passes none keeps it), through {@link launchBaseEnv}. */
export async function launchElectron(options: Parameters<typeof electron.launch>[0]): ReturnType<typeof electron.launch> {
  const baseEnv = launchBaseEnv(options?.env ?? process.env);
  const executablePath = resolveE2eExecutable(options);
  // A custom runtime path bypasses automatic loader injection; preserve startup coordination and background rendering switches.
  const runtimeArgs = executablePath && !options?.executablePath
    ? ["-r", resolve(dirname(createRequire(import.meta.url).resolve("playwright-core/package.json")), "lib/server/electron/loader.js")]
    : [];
  const app = await electron.launch({
    ...options,
    executablePath,
    args: [...E2E_CHROMIUM_SWITCHES, ...runtimeArgs, ...(options?.args ?? [])],
    env: { ...baseEnv, ...E2E_RUNTIME_ENV },
  });
  // The automation object releases its native implementation on close; retain the process before a spec closes or restarts it.
  const child = app.process();
  electronProcesses.set(app, child);
  child.once("close", () => closedElectronProcesses.add(child));
  return app;
}

/** The allow-listed parent env plus `overrides`; an `undefined` override removes the key. A Windows USERPROFILE override also gets its own
 * APPDATA. */
export function buildIsolatedElectronEnv(overrides: LaunchEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries({ ...safeProcessEnv(), ...windowsProfileEnv(overrides.USERPROFILE), ...overrides })) {
    if (value !== undefined) env[key] = value;
  }
  return env;
}

export function buildE2eBaseSettings(onboardingCompleted = true, locale: "ko" | "en" = "ko",
): JsonObject {
  return {
    marketplace: {
      updateCheckEnabled: false,
      updateCheckIntervalMs: 0,
    },
    updates: {
      autoCheckEnabled: false,
    },
    features: {
      onboardingCompleted,
    },
    // Pin the UI locale while retaining the shared appearance defaults.
    appearance: {
      ...DEFAULT_APPEARANCE,
      language: locale,
    },
  };
}

/** Secrets to seed into `ave-secrets.json` so the host reports a usable LLM key at boot (`ave:settings:has-api-key` → `getSecret("llm.apiKey.<provider>")`), which enables the chat composer. Before #1201 a fixture-key path resolved this implicitly; that path is gone, so e2e seeds an explicit key for every vendor (covers
 * whichever `llm.provider` a spec ends up with; default azure-foundry). Electron is launched unpackaged for these fixtures, so boot explicitly selects the development secret policy. The canonical document therefore uses the development-only plaintext encoding without weakening packaged behavior when OS encryption is unavailable. */
export function buildE2eSecrets(liveOpenRouterKey?: string): {
  version: 1;
  entries: Record<string, { encoding: "plain-development"; value: string }>;
} {
  const entries: Record<string, { encoding: "plain-development"; value: string }> = {};
  for (const vendor of Object.keys(LLM_VENDOR_DEFAULTS)) {
    entries[`llm.apiKey.${vendor}`] = {
      encoding: "plain-development",
      value: `sk-e2e-${vendor}`,
    };
  }
  // Live-model opt-in only. Every other vendor keeps its fake key, so a spec that wanders off openrouter still fails offline instead of spending money.
  if (liveOpenRouterKey) {
    entries["llm.apiKey.openrouter"] = {
      encoding: "plain-development",
      value: liveOpenRouterKey,
    };
  }
  return { version: 1, entries };
}

export type SeededElectronContext = {
  app: ElectronApplication;
  page: Page;
  userDataDir: string;
  tempHome: string;
  aveHome: string;
};

export function builtMainExists(): boolean {
  return existsSync(MAIN_ENTRY);
}

export function buildLlmSettings(
  vendor: LLMVendor = "openai",
  model?: string,
): JsonObject {
  const vendors = Object.fromEntries(
    Object.entries(LLM_VENDOR_DEFAULTS).map(([id, defaults]) => [
      id,
      {
        model: defaults.model,
        enableThinking: defaults.enableThinking,
        thinkingBudgetTokens: defaults.thinkingBudgetTokens,
      },
    ]),
  ) as unknown as Record<LLMVendor, JsonObject>;
  vendors[vendor] = {
    ...vendors[vendor],
    model: model ?? LLM_VENDOR_DEFAULTS[vendor].model,
  };

  return {
    ...buildE2eBaseSettings(true),
    llm: {
      provider: vendor,
      vendors,
      streamSmoothing: "none",
      fallbackChain: [],
    },
  };
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toPersistedHistoryRow(row: JsonObject): JsonObject {
  const {
    createdAt,
    displayText,
    importedTrigger,
    toolDisplay,
    turnSummary,
    checkpointMeta,
    systemNotice,
    meta,
    ...message
  } = row;
  const nextMeta: JsonObject = isJsonObject(meta) ? { ...meta } : {};
  for (const [key, value] of Object.entries({
    createdAt,
    displayText,
    importedTrigger,
    toolDisplay,
    turnSummary,
    checkpointMeta,
    systemNotice,
  })) {
    if (value !== undefined) nextMeta[key] = value;
  }
  return Object.keys(nextMeta).length > 0
    ? { ...message, meta: nextMeta }
    : message;
}

export async function launchSeededElectron(opts: {
  historyRows: JsonObject[];
  sessionId?: string;
  sessionTitle?: string;
  settings?: JsonObject;
  seedApiKey?: boolean;
  userDataPrefix?: string;
  homePrefix?: string;
  launchEnv?: LaunchEnv;
  launchArgs?: readonly string[];
  prepareHome?: (aveHome: string) => void | Promise<void>;
  onLaunched?: (app: ElectronApplication) => void;
}): Promise<SeededElectronContext> {
  const sessionId = opts.sessionId ?? "e2000000-bb11-4cc2-8dd3-eeeeeeeeeeee";
  const userDataDir = mkdtempSync(
    resolve(tmpdir(), opts.userDataPrefix ?? "ave-seeded-e2e-user-data-"),
  );
  const tempHome = mkdtempSync(
    resolve(tmpdir(), opts.homePrefix ?? "ave-seeded-e2e-home-"),
  );
  const aveHome = resolve(tempHome, ".ave");

  let app: ElectronApplication | undefined;
  try {
    writeFileSync(
      resolve(userDataDir, "ave-settings.json"),
      `${JSON.stringify(opts.settings ?? buildLlmSettings(), null, 2)}\n`,
      "utf-8",
    );
    if (opts.seedApiKey) {
      writeFileSync(resolve(userDataDir, "ave-secrets.json"), `${JSON.stringify(buildE2eSecrets())}\n`, { encoding: "utf-8", mode: 0o600 });
    }

    const sessionsDir = resolve(aveHome, "sessions");
    mkdirSync(sessionsDir, { recursive: true });
    writeFileSync(
      resolve(sessionsDir, `${sessionId}.jsonl`),
      `${opts.historyRows.map((row) => JSON.stringify(toPersistedHistoryRow(row))).join("\n")}\n`,
      "utf-8",
    );
    writeFileSync(
      resolve(sessionsDir, `${sessionId}.meta.json`),
      `${JSON.stringify({ title: opts.sessionTitle ?? "Seeded e2e session" }, null, 2)}\n`,
      "utf-8",
    );
    writeFileSync(
      resolve(sessionsDir, ".active-session.json"),
      `${JSON.stringify(
        {
          mainActiveMode: "resume",
          mainActiveSessionId: sessionId,
          updatedAt: new Date().toISOString(),
        },
        null,
        2,
      )}\n`,
      "utf-8",
    );

    await opts.prepareHome?.(aveHome);
    app = await launchElectron({
      args: [MAIN_ENTRY, `--user-data-dir=${userDataDir}`, "--no-sandbox", ...(opts.launchArgs ?? [])],
      env: buildIsolatedElectronEnv({
        HOME: tempHome,
        USERPROFILE: tempHome,
        AVE_HOME: aveHome,
        AVE_DEV: "1",
        AVE_E2E: "1",
        AVE_MAIN_ENTRY: MAIN_ENTRY,
        NODE_ENV: "test",
        ELECTRON_DISABLE_SECURITY_WARNINGS: "1",
        ...(opts.launchEnv ?? {}),
      }),
      timeout: 30_000,
    });
    opts.onLaunched?.(app);

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

    const page = await app.firstWindow();
    await page.locator('[data-testid="main-toolbar"]').first().waitFor({
      state: "visible",
      timeout: 60_000,
    });

    return { app, page, userDataDir, tempHome, aveHome };
  } catch (error) {
    if (app) await quitElectron(app);
    try {
      await removeSeededElectronDirectories(userDataDir, tempHome);
    } catch (cleanupError) {
      throw new AggregateError([error, cleanupError], "Seeded Electron startup and cleanup failed");
    }
    throw error;
  }
}

/** Keep automation through native cleanup and require process and inherited-pipe closure. */
export async function quitElectron(app: ElectronApplication): Promise<void> {
  const child = electronProcesses.get(app);
  if (!child) throw new Error("The native process was not registered at launch");
  const closed = closedElectronProcesses.has(child) ? Promise.resolve() : once(child, "close").then(() => {});
  const isRunning = child.exitCode === null && child.signalCode === null;
  // Explicitly terminated fixtures still drain inherited pipes without reopening disposed automation.
  if (!isRunning) {
    await closed;
    return;
  }
  const exited = once(child, "exit").then(() => {});
  const stopped = Promise.all([exited, closed]);
  const readyToExit = app.evaluate(({ app: runtimeApp }) => new Promise<void>((resolve) => {
    runtimeApp.once("will-quit", () => resolve());
    runtimeApp.quit();
  })).catch((error: unknown) => {
    if (child.exitCode === null && child.signalCode === null) console.warn("Native quit response failed before process exit", error);
    return exited;
  });
  await Promise.race([readyToExit, stopped]);
  if (child.exitCode === null && child.signalCode === null) {
    // Native exit can overtake an in-flight context request, but never substitutes for pipe closure.
    await Promise.race([app.close(), exited]);
  }
  await stopped;
  if (child.exitCode !== 0 || child.signalCode !== null) {
    throw new Error(`Native application quit failed: exit=${child.exitCode}, signal=${child.signalCode}`);
  }
}

export async function teardownSeededElectron(
  ctx: SeededElectronContext,
  options: { terminate?: boolean } = {},
): Promise<void> {
  // Terminate only the owned fixture when the spec does not exercise runtime shutdown.
  const child = electronProcesses.get(ctx.app);
  if (!child) throw new Error("The native process was not registered at launch");
  if (options.terminate && !closedElectronProcesses.has(child)) {
    const isRunning = child.exitCode === null && child.signalCode === null;
    const exited = isRunning ? once(child, "exit") : Promise.resolve();
    if (!child.pid) throw new Error("The native process has no identity");
    // Native launches own a process group. End its descendants too so inherited pipes can close.
    if (process.platform === "win32") {
      if (isRunning) {
        try {
          await new Promise<void>((resolve, reject) => {
            execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, (error) => error ? reject(error) : resolve());
          });
        } catch (error) {
          await new Promise<void>((resolve) => setImmediate(resolve));
          if (child.exitCode === null && child.signalCode === null) throw error;
        }
      }
    } else {
      try { process.kill(-child.pid, "SIGKILL"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    }
    await exited;
  }
  await quitElectron(ctx.app);
  await removeSeededElectronDirectories(ctx.userDataDir, ctx.tempHome);
}

async function removeSeededElectronDirectories(userDataDir: string, tempHome: string): Promise<void> {
  const results = await Promise.allSettled([
    cleanupTmpDir(userDataDir),
    Promise.resolve().then(() => {
      makeTreeWritableSync(tempHome);
      return cleanupTmpDir(tempHome);
    }),
  ]);
  const errors = results.flatMap(result => result.status === "rejected" ? [result.reason] : []);
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, "Seeded Electron directory cleanup failed");
}

export function makeTreeWritableSync(root: string): void {
  try {
    chmodSync(root, 0o700);
  } catch {
    return;
  }
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (entry.isDirectory()) makeTreeWritableSync(resolve(root, entry.name));
  }
}

export async function sendRendererStreamEvent(
  app: ElectronApplication,
  page: Page,
  event: JsonObject,
): Promise<void> {
  // Every chat stream frame names its group; the preload drops unlabelled frames (public-surface.ts subscribeForChatGroup).
  const labelled = { chatGroupId: MAIN_CHAT_GROUP_ID, ...event };
  await sendRendererEvent(app, page, "ave:chat:stream", labelled);
}

/** Resize the app's first page-owned native window to `w` x `h` content pixels, including inactive background windows.
 * Reject below-minimum sizes before resizing, then wait up to five seconds for native content and renderer dimensions to agree within one pixel. */
export async function setWindowSize(
  app: ElectronApplication,
  w: number,
  h: number,
  page?: Page,
): Promise<void> {
  if (!Number.isInteger(w) || !Number.isInteger(h) || w <= 0 || h <= 0) {
    throw new Error(`Invalid window content size: ${w}x${h}`);
  }
  const mainPage = page ?? await app.firstWindow();
  const bounds = await withPageWindow(app, mainPage, (target) => target.getBounds());
  const workArea = await app.evaluate(({ screen }, bounds) => screen.getDisplayMatching(bounds).workArea, bounds);
  const { workAreaContentLimit } = await withPageWindow(app, mainPage, (target, size) => {
    const bounds = target.getBounds();
    const content = target.getContentBounds();
    const outerWidth = size.w + bounds.width - content.width;
    const outerHeight = size.h + bounds.height - content.height;
    const [minWidth, minHeight] = target.getMinimumSize();
    if (outerWidth < minWidth || outerHeight < minHeight) {
      throw new Error(`Requested content ${size.w}x${size.h} is below window minimum ${minWidth}x${minHeight} (outer size ${outerWidth}x${outerHeight}); no test minimum-size override is available`);
    }
    target.setPosition(size.workArea.x, size.workArea.y);
    target.setContentSize(size.w, size.h);
    const workAreaContentLimit = [size.workArea.width - (bounds.width - content.width), size.workArea.height - (bounds.height - content.height)];
    return { workAreaContentLimit };
  }, { w, h, workArea });
  let actual: { content: number[]; renderer: { width: number; height: number } } | undefined;
  // Renderer CSS pixels and native content pixels agree only at zoom factor 1.
  try {
    await expect.poll(async () => {
      actual = undefined;
      const measured = await withPageWindow(app, mainPage, async (target) => {
        const chrome = target.webContents;
        if (chrome.isDestroyed()) throw new Error("Main window UI changed during resize");
        const content = target.getContentSize();
        let timer: ReturnType<typeof setTimeout> | undefined;
        const renderer = await Promise.race([
          chrome.executeJavaScript("({ width: window.innerWidth, height: window.innerHeight })") as Promise<{ width: number; height: number }>,
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => reject(new Error("Renderer size probe timed out")), 1_000);
          }),
        ]).finally(() => clearTimeout(timer));
        return { content, renderer };
      });
      actual = measured;
      return Math.abs(measured.renderer.width - w) <= 1
        && Math.abs(measured.renderer.height - h) <= 1
        && Math.abs(measured.content[0] - w) <= 1
        && Math.abs(measured.content[1] - h) <= 1;
    }, { timeout: 5_000, message: `Wait for window content ${w}x${h}` }).toBe(true);
  } catch (cause) {
    const nativeMismatch = actual && (Math.abs(actual.content[0] - w) > 1 || Math.abs(actual.content[1] - h) > 1);
    const rendererMismatch = actual && (Math.abs(actual.renderer.width - w) > 1 || Math.abs(actual.renderer.height - h) > 1);
    const limitedRequest = [Math.min(w, workAreaContentLimit[0]), Math.min(h, workAreaContentLimit[1])];
    const clampedByWorkArea = actual && nativeMismatch && (w > workAreaContentLimit[0] || h > workAreaContentLimit[1])
      && Math.abs(actual.content[0] - limitedRequest[0]) <= 1
      && Math.abs(actual.content[1] - limitedRequest[1]) <= 1;
    const facts = [nativeMismatch && "native mismatch", rendererMismatch && "renderer mismatch", clampedByWorkArea && "clamped by work area"]
      .filter(Boolean).join("; ") || "resize probe failed (no current sample)";
    throw new Error(`Window resize failed: ${facts}; requested ${w}x${h}; actual content ${actual?.content.join("x") ?? "unavailable"}; renderer ${JSON.stringify(actual?.renderer) ?? "unavailable"}; display work area ${workArea.width}x${workArea.height} at ${workArea.x},${workArea.y}`, { cause });
  }
}
