import path from 'node:path';
import fs from 'node:fs';
import { test, expect } from './fixtures.js';
import { scenarios } from './matrix.js';

// Keep one test per capture key so filtering and explicit skip reporting remain available.
const OUT_DIR = path.resolve(import.meta.dirname, 'out');

test.beforeAll(() => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
});

for (const [key, entry] of Object.entries(scenarios)) {
  // Skipped scenarios must not request launch fixtures or start an app.
  if (entry.skip) {
    const reason = entry.skip;
    test(`capture: ${key}`, () => {
      test.skip(true, reason);
    });
    continue;
  }

  // Bind per-scenario fixture options at describe scope, never inside a test body.
  test.describe(() => {
    if (entry.plugins && entry.plugins.length > 0) {
      test.use({ installPlugins: entry.plugins });
    }
    if (entry.keepReviewer) {
      test.use({ keepReviewer: true });
    }
    // Bind scripted-provider options at describe scope so conversational states exist before capture.
    if (entry.scriptedScript) {
      test.use({ scriptedScript: entry.scriptedScript });
    }
    if (entry.reviewerMode) {
      test.use({ reviewerMode: entry.reviewerMode });
    }
    if (entry.executionMode) {
      test.use({ executionMode: entry.executionMode });
    }
    if (entry.seededCorpus) {
      test.use({ seededCorpus: entry.seededCorpus });
    }
    if (entry.uiLocale) {
      test.use({ uiLocale: entry.uiLocale });
    }
    if (entry.captureViewport) {
      test.use({ captureViewport: entry.captureViewport });
    }

    test(`capture: ${key}`, async ({ app, mainWindow, scriptedProvider }) => {
    if (!entry.steps) {
      throw new Error(`scenario "${key}" has neither "skip" nor "steps" — matrix.ts entry is incomplete`);
    }

    await entry.steps({ app, page: mainWindow });

    const target = entry.locator ? mainWindow.locator(entry.locator).first() : mainWindow;
    if (entry.locator) {
      await expect(target as ReturnType<typeof mainWindow.locator>).toBeVisible({ timeout: 10_000 });
    }
    await target.screenshot({ path: path.join(OUT_DIR, `${key}.png`) });

    // Assert refused requests after capture to retain diagnostic artifacts.
    // Unconsumed script entries can be intentional when capturing a held in-flight turn.
    if (scriptedProvider) {
      expect(scriptedProvider.violations, 'scripted provider refused a request').toEqual([]);
    }
    });
  });
}
