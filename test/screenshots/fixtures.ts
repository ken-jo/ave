import { type ElectronApplication, type Page } from 'playwright';
import { test as base, expect } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import {
  buildE2eBaseSettings,
  buildE2eSecrets,
  buildIsolatedElectronEnv,
  buildLlmSettings,
  launchElectron,
} from '../e2e/ui/seeded-electron.js';
import {
  seedExecutionMode,
  seedFixturePlugins,
  seedReviewerMode,
} from './plugin-seed.js';
import { PROVIDER_PING_SYSTEM_PROMPT } from '../../src/engine/turn/provider.js';
import { PERMISSION_REVIEWER_SYSTEM_PROMPT } from '../../src/shared/permission-reviewer-framework.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');

// Use a fixed viewport for consistent full-window capture proportions.
export const CAPTURE_VIEWPORT = { width: 1600, height: 1000 } as const;

export interface CaptureViewport {
  width: number;
  height: number;
}

// A local scripted provider makes in-flight conversation states deterministic without live credentials.

// The scripted model id is visible in captures even though request matching ignores it.
const SCRIPTED_PROVIDER_MODEL_ID = 'local-model';

type ScriptedPart =
  | { kind: 'reasoning'; text: string }
  | { kind: 'text'; text: string }
  | {
      kind: 'tool';
      id: string;
      name: string;
      input: Record<string, unknown>;
      // Rewrite only declared seeded-path fields because isolated absolute paths vary per run.
      seededPathFields?: readonly string[];
    };

// Classify shared-provider calls by their system prompt to distinguish turns and review requests.
type ScriptedCaller = 'assistant' | 'reviewer';

export interface ScriptedTurn {
  parts: readonly ScriptedPart[];
  // Caller mismatches fail rather than silently reorder the script.
  expect?: ScriptedCaller;
  chunkDelayMs?: number;
}

// Wrap transcript arrays so fixture registration cannot mistake them for value/options tuples.
export interface ScriptedScript {
  turns: readonly ScriptedTurn[];
}

export interface ScriptedProviderHandle {
  baseUrl: string;
  readonly violations: readonly string[];
  close(): Promise<void>;
}

function resolveSeededPaths(
  turns: readonly ScriptedTurn[],
  aveHome: string,
  seededCorpus: Readonly<Record<string, string>>,
): ScriptedTurn[] {
  return turns.map((turn) => ({
    ...turn,
    parts: turn.parts.map((part) => {
      if (part.kind !== 'tool' || !part.seededPathFields) return part;
      const input = { ...part.input };
      for (const field of part.seededPathFields) {
        const key = input[field];
        if (typeof key !== 'string' || !(key in seededCorpus)) {
          throw new Error(
            `scripted turn ${part.id}: "${field}" must name a seededCorpus entry (got ${JSON.stringify(key)})`,
          );
        }
        input[field] = path.join(aveHome, key);
      }
      return { ...part, input };
    }),
  }));
}

function sseData(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function chunk(delta: Record<string, unknown>, finishReason: string | null): string {
  return sseData({
    id: SCRIPTED_PROVIDER_MODEL_ID,
    object: 'chat.completion.chunk',
    created: 0,
    model: SCRIPTED_PROVIDER_MODEL_ID,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  });
}

function streamSegments(text: string): string[] {
  return text.match(/\s+|\S+/g) ?? [];
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// Use the compatible reasoning field that the stream adapter translates into host reasoning events.
async function writeTurn(
  res: http.ServerResponse,
  turn: ScriptedTurn,
): Promise<void> {
  const delay = turn.chunkDelayMs ?? 0;
  res.write(chunk({ role: 'assistant' }, null));
  let toolIndex = 0;
  let sawTool = false;
  for (const part of turn.parts) {
    if (part.kind === 'tool') {
      sawTool = true;
      res.write(
        chunk(
          {
            tool_calls: [
              {
                index: toolIndex,
                id: part.id,
                type: 'function',
                function: { name: part.name, arguments: JSON.stringify(part.input) },
              },
            ],
          },
          null,
        ),
      );
      toolIndex += 1;
      if (delay) await sleep(delay);
      continue;
    }
    const field = part.kind === 'reasoning' ? 'reasoning_content' : 'content';
    for (const segment of streamSegments(part.text)) {
      res.write(chunk({ [field]: segment }, null));
      if (delay) await sleep(delay);
    }
  }
  res.write(chunk({}, sawTool ? 'tool_calls' : 'stop'));
  res.write(
    sseData({
      id: SCRIPTED_PROVIDER_MODEL_ID,
      object: 'chat.completion.chunk',
      created: 0,
      model: SCRIPTED_PROVIDER_MODEL_ID,
      choices: [],
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    }),
  );
  res.write('data: [DONE]\n\n');
  res.end();
}

function systemPromptOf(body: unknown): string {
  const messages = (body as { messages?: Array<{ role?: string; content?: unknown }> }).messages;
  if (!Array.isArray(messages)) return '';
  const system = messages.find((m) => m.role === 'system');
  return typeof system?.content === 'string' ? system.content : '';
}

function callerOf(systemPrompt: string): ScriptedCaller {
  return systemPrompt === PERMISSION_REVIEWER_SYSTEM_PROMPT ? 'reviewer' : 'assistant';
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  const parts: Buffer[] = [];
  for await (const part of req) parts.push(part as Buffer);
  return Buffer.concat(parts).toString('utf-8');
}

// Bind to one ephemeral loopback origin; guarded provider requests cannot reach other targets.
async function startScriptedProvider(
  turns: readonly ScriptedTurn[],
): Promise<ScriptedProviderHandle> {
  const queue = [...turns];
  const violations: string[] = [];

  const server = http.createServer((req, res) => {
    void (async () => {
      const url = req.url ?? '';
      if (req.method === 'GET' && url.endsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ object: 'list', data: [{ id: SCRIPTED_PROVIDER_MODEL_ID, object: 'model' }] }));
        return;
      }
      if (req.method !== 'POST' || !url.endsWith('/chat/completions')) {
        violations.push(`unexpected request: ${req.method} ${url}`);
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: `scripted provider serves POST /chat/completions only (got ${req.method} ${url})` } }));
        return;
      }

      let body: unknown;
      try {
        body = JSON.parse(await readBody(req));
      } catch (err) {
        violations.push(`unparseable request body: ${(err as Error).message}`);
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { message: 'scripted provider received an unparseable body' } }));
        return;
      }

      const systemPrompt = systemPromptOf(body);
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });

      if (systemPrompt === PROVIDER_PING_SYSTEM_PROMPT) {
        await writeTurn(res, { parts: [{ kind: 'text', text: 'PONG' }] });
        return;
      }

      const caller = callerOf(systemPrompt);
      const turn = queue.shift();
      if (!turn) {
        const message = `scripted provider ran out of turns — an unscripted ${caller} request arrived`;
        violations.push(message);
        res.write(sseData({ error: { message } }));
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      if (turn.expect && turn.expect !== caller) {
        const message = `scripted provider expected a ${turn.expect} request, got ${caller}`;
        violations.push(message);
        res.write(sseData({ error: { message } }));
        res.write('data: [DONE]\n\n');
        res.end();
        return;
      }
      await writeTurn(res, turn);
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    violations,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// Reuse seeded settings shape while replacing the selected provider base URL.
function scriptedProviderSettings(
  baseUrl: string,
  locale: 'ko' | 'en',
): Record<string, unknown> {
  const built = buildLlmSettings('openai-compatible', SCRIPTED_PROVIDER_MODEL_ID) as {
    llm: { vendors: Record<string, Record<string, unknown>> } & Record<string, unknown>;
  };
  const vendors = {
    ...built.llm.vendors,
    'openai-compatible': { ...built.llm.vendors['openai-compatible'], baseUrl },
  };
  return {
    ...buildE2eBaseSettings(true, locale),
    llm: { ...built.llm, vendors },
  };
}


export type ScreenshotFixtures = {
  app: ElectronApplication;
  mainWindow: Page;
  userDataDir: string;
  // The isolated data home is an allowed tool root.
  aveHome: string;
  // Scripted captures require no refused requests; held unconsumed entries may be intentional.
  scriptedProvider: ScriptedProviderHandle | null;
};

export type ScreenshotOptions = {
  // Install only explicitly requested repository fixtures; default to an empty plugin registry.
  installPlugins: readonly string[];
  // Plugin seeding normally disables review; approval captures must explicitly keep it enabled.
  keepReviewer: boolean;
  // Null leaves the normal seeded provider; scripts supply one entry per model call.
  scriptedScript: ScriptedScript | null;
  // Plugin seeding owns reviewer defaults unless the scenario overrides them.
  reviewerMode: 'disabled' | 'rule' | 'llm' | 'strict' | null;
  // Foreground tool calls reach the reviewer only in auto execution mode.
  executionMode: 'default' | 'strict' | 'auto' | 'allow' | null;
  // Seed fabricated files inside the isolated allowed data home so captures never need real user content.
  seededCorpus: Readonly<Record<string, string>>;
  // Capture documentation images in their published locale.
  uiLocale: 'ko' | 'en';
  // Override the viewport for short subjects that would be unreadable in a scaled full-window capture.
  captureViewport: CaptureViewport | null;
};

// Launch isolated capture profiles with only the scenario's requested repository fixtures.
export const test = base.extend<ScreenshotFixtures & ScreenshotOptions>({
  installPlugins: [[], { option: true }],
  keepReviewer: [false, { option: true }],
  scriptedScript: [null, { option: true }],
  uiLocale: ['en', { option: true }],
  captureViewport: [null, { option: true }],
  reviewerMode: [null, { option: true }],
  executionMode: [null, { option: true }],
  seededCorpus: [{}, { option: true }],

  scriptedProvider: async ({ scriptedScript, aveHome, seededCorpus }, use) => {
    if (!scriptedScript) {
      await use(null);
      return;
    }
    const handle = await startScriptedProvider(
      resolveSeededPaths(scriptedScript.turns, aveHome, seededCorpus),
    );
    await use(handle);
    await handle.close();
  },

  // Keep profiles under the OS temp root so seeded tool paths remain inside default scope.
  userDataDir: async ({}, use) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ave-screenshot-'));
    await use(dir);
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
    }
  },

  aveHome: async ({ userDataDir }, use) => {
    const dir = path.join(userDataDir, 'ave-state');
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    await use(dir);
  },

  app: async ({ userDataDir, aveHome, installPlugins, keepReviewer, scriptedProvider, uiLocale, reviewerMode, executionMode, seededCorpus }, use) => {
    const mainEntry = path.join(REPO_ROOT, 'dist/src/main/main.js');
    if (!fs.existsSync(mainEntry)) {
      throw new Error(
        `Electron main entry not found at ${mainEntry}. Run 'bun run build' before capturing screenshots.`,
      );
    }

    const aveHomeForTest = aveHome;

    // Use the default responsive shell without a saved layout preference.
    fs.writeFileSync(
      path.join(userDataDir, 'ave-settings.json'),
      `${JSON.stringify(
        {
          ...(scriptedProvider
            ? scriptedProviderSettings(scriptedProvider.baseUrl, uiLocale)
            : buildE2eBaseSettings(true, uiLocale)),
        },
        null,
        2,
      )}\n`,
      'utf-8',
    );
    fs.writeFileSync(
      path.join(userDataDir, 'ave-secrets.json'),
      JSON.stringify(buildE2eSecrets(), null, 2) + '\n',
      { encoding: 'utf-8', mode: 0o600 },
    );
    if (reviewerMode) seedReviewerMode(aveHomeForTest, reviewerMode);
    if (executionMode) seedExecutionMode(aveHomeForTest, executionMode);
    await seedFixturePlugins(aveHomeForTest, installPlugins, {
      disableReviewer: !keepReviewer,
    });

    // Seed corpus after plugin installation because installation replaces the entire plugin directory.
    for (const [relative, contents] of Object.entries(seededCorpus)) {
      const target = path.join(aveHomeForTest, relative);
      fs.mkdirSync(path.dirname(target), { recursive: true, mode: 0o700 });
      fs.writeFileSync(target, contents, {
        encoding: 'utf-8',
        mode: 0o600,
      });
    }

    const app = await launchElectron({
      args: [mainEntry, `--user-data-dir=${userDataDir}`, '--no-sandbox'],
      env: buildIsolatedElectronEnv({
        HOME: userDataDir,
        USERPROFILE: userDataDir,
        AVE_DEV: '1',
        AVE_E2E: '1',
        AVE_HOME: aveHomeForTest,
        NODE_ENV: 'test',
        ELECTRON_DISABLE_SECURITY_WARNINGS: '1',
      }),
      timeout: 30_000,
    });
    app.process().stdout?.on('data', (d: Buffer) => process.stdout.write(`[electron:stdout] ${d}`));
    app.process().stderr?.on('data', (d: Buffer) => process.stdout.write(`[electron:stderr] ${d}`));
    await use(app);
    await app.close().catch(() => {});
  },

  mainWindow: async ({ app, captureViewport }, use) => {
    const win = await app.firstWindow();
    await win.setViewportSize(captureViewport ?? CAPTURE_VIEWPORT);
    await win.locator('[data-testid="main-toolbar"]').first().waitFor({
      state: 'visible',
      timeout: 60_000,
    });
    // Suppress state-dependent onboarding overlays that are outside capture subjects.
    await win.addStyleTag({
      content: '[data-overlay-source="proposal"]{display:none !important;}',
    });
    // Disable animation and caret blinking only in the capture harness for deterministic frames.
    await win.addStyleTag({
      content: `
        *, *::before, *::after {
          transition-duration: 0ms !important;
          animation-duration: 0ms !important;
          animation-delay: 0ms !important;
          caret-color: transparent !important;
        }
      `,
    });
    await use(win);
  },
});

export { expect };
export { REPO_ROOT };
