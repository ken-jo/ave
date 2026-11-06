import { test, expect } from './fixtures';

// Suggested replies must suppress the overlapping static placeholder.
test('composer placeholder renders one of the known hints at rest', async ({ mainWindow, t }) => {
  const textarea = mainWindow.locator('textarea').first();
  await textarea.waitFor({ state: 'visible', timeout: 10_000 });

  const placeholder = await textarea.getAttribute('placeholder');

  // Match catalog values for non-chip states; empty hints without suggestions are a regression.
  const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const knownHints = new RegExp(
    [
      // The renderer fills in the platform's paste modifier (utils/composer-placeholder.ts).
      t('composerPlaceholder.defaultHint', { pasteModifier: process.platform === 'darwin' ? '⌘' : 'Ctrl' }),
      t('composerPlaceholder.apiKeyMissing'),
      t('composerPlaceholder.streamingHint'),
    ]
      .map(escapeRegExp)
      .join('|'),
  );
  expect(placeholder).toMatch(knownHints);
});
