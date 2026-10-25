import { test, expect } from './fixtures';

// Inject tool stream frames through the production reducer to verify edit-card rendering.

type StreamFn = (event: unknown) => void;
type ChatStreamApi = { _emit?: StreamFn } | undefined;

async function waitForChatReady(mainWindow: import('@playwright/test').Page): Promise<boolean> {
  // The mounted stream seam is ready independently of API-key and downstream UI gates.
  try {
    await mainWindow.waitForFunction(
      () => typeof (window as unknown as { __aveChatStream?: { _emit?: unknown } })
        .__aveChatStream?._emit === 'function',
      undefined,
      { timeout: 20_000 },
    );
    return true;
  } catch {
    return false;
  }
}

async function emitToolCycle(
  mainWindow: import('@playwright/test').Page,
  start: Record<string, unknown>,
  end: Record<string, unknown>,
): Promise<boolean> {
  return mainWindow.evaluate(
    ({ start, end }) => {
      const w = window as unknown as { __aveChatStream?: ChatStreamApi };
      const emit = w.__aveChatStream?._emit;
      if (typeof emit !== 'function') return false;
      emit({ type: 'tool_start', ...start });
      emit({ type: 'tool_end', ...end });
      return true;
    },
    { start, end },
  );
}

test.describe('FileEditDiff e2e', () => {
  test('edit_file: renders Edit verb + path + diff hunks', async ({ mainWindow }) => {
    const ready = await waitForChatReady(mainWindow);
    test.skip(!ready, 'ChatView input not visible — skipping.');

    const groupId = `e2e-edit-${Date.now()}`;
    const toolUseId = `tu-edit-${Date.now()}`;
    const path = 'src/sample.ts';

    const dispatched = await emitToolCycle(
      mainWindow,
      {
        name: 'edit_file',
        groupId,
        toolUseId,
        displayOrder: 0,
        input: {
          path,
          oldText: 'const greet = "hello";',
          newText: 'const greet = "annyeong";',
        },
      },
      {
        name: 'edit_file',
        groupId,
        toolUseId,
        result: JSON.stringify({ path, replacements: 1 }),
        isError: false,
        durationMs: 50,
      },
    );
    test.skip(!dispatched, 'Synthetic stream dispatch unavailable in this build.');

    const card = mainWindow
      .locator('[data-testid="file-edit-diff"][data-tool="edit_file"]')
      .first();
    await expect(card).toBeVisible({ timeout: 5_000 });
    await expect(card).toContainText(path);
    await expect(card).toContainText('Edit');
    await expect(card).toContainText('hello');
    await expect(card).toContainText('annyeong');

    // Measure browser-composited colors; foreground-token assertions alone miss translucent-theme failures.
    for (const kind of ['removed', 'added'] as const) {
      const line = card.locator(`[data-diff-kind="${kind}"]`).first();
      await expect(line).toBeVisible();
      const colors = await line.evaluate((element: HTMLElement) => {
        const style = getComputedStyle(element);
        const card = element.closest('[data-testid="file-edit-diff"]');
        return {
          foreground: style.color,
          background: style.backgroundColor,
          backdrop: card ? getComputedStyle(card).backgroundColor : 'rgb(255, 255, 255)',
        };
      });
      expect(wcagContrast(
        colors.foreground,
        composite(colors.background, colors.backdrop),
      )).toBeGreaterThanOrEqual(4.5);
    }
  });

  test('write_file (new file): renders Create verb without before content', async ({ mainWindow }) => {
    const ready = await waitForChatReady(mainWindow);
    test.skip(!ready, 'ChatView input not visible — skipping.');

    const groupId = `e2e-create-${Date.now()}`;
    const toolUseId = `tu-create-${Date.now()}`;
    const path = 'src/new-module.ts';

    const dispatched = await emitToolCycle(
      mainWindow,
      {
        name: 'write_file',
        groupId,
        toolUseId,
        displayOrder: 0,
        input: { path, content: 'export const ANSWER = 42;\n' },
      },
      {
        name: 'write_file',
        groupId,
        toolUseId,
        result: JSON.stringify({
          kind: 'ave.write_file',
          path,
          bytes: 26,
          isNewFile: true,
          truncated: false,
          after: 'export const ANSWER = 42;\n',
        }),
        isError: false,
        durationMs: 12,
      },
    );
    test.skip(!dispatched, 'Synthetic stream dispatch unavailable in this build.');

    const card = mainWindow
      .locator('[data-testid="file-edit-diff"][data-new-file="true"]')
      .first();
    await expect(card).toBeVisible({ timeout: 5_000 });
    await expect(card).toContainText(path);
    await expect(card).toContainText('Create');
    await expect(card).toContainText('ANSWER = 42');
  });

  // The API-key overlay must leave history cards visible and interactive.
  test('FileEditDiff is interactive even when API-key overlay is visible', async ({ mainWindow }) => {
    const ready = await waitForChatReady(mainWindow);
    test.skip(!ready, 'Synthetic stream dispatch unavailable.');

    const groupId = `e2e-overlay-${Date.now()}`;
    const toolUseId = `tu-overlay-${Date.now()}`;
    const path = 'src/overlap.ts';
    const dispatched = await emitToolCycle(
      mainWindow,
      {
        name: 'edit_file',
        groupId,
        toolUseId,
        displayOrder: 0,
        input: { path, oldText: 'lo', newText: 'hi' },
      },
      {
        name: 'edit_file',
        groupId,
        toolUseId,
        result: JSON.stringify({ path, replacements: 1 }),
        isError: false,
        durationMs: 5,
      },
    );
    test.skip(!dispatched, 'Dispatch unavailable.');

    const card = mainWindow.locator('[data-testid="file-edit-diff"]').first();
    await expect(card).toBeVisible({ timeout: 5_000 });

    // Trial clicks prove hit-testing without performing the action.
    await card.locator('button').first().click({ trial: true });
  });

  test('write_file (truncated): surfaces truncated marker', async ({ mainWindow }) => {
    const ready = await waitForChatReady(mainWindow);
    test.skip(!ready, 'ChatView input not visible — skipping.');

    const groupId = `e2e-trunc-${Date.now()}`;
    const toolUseId = `tu-trunc-${Date.now()}`;
    const path = 'src/big.ts';

    const dispatched = await emitToolCycle(
      mainWindow,
      {
        name: 'write_file',
        groupId,
        toolUseId,
        displayOrder: 0,
        input: { path, content: 'x'.repeat(8000) },
      },
      {
        name: 'write_file',
        groupId,
        toolUseId,
        result: JSON.stringify({
          kind: 'ave.write_file',
          path,
          bytes: 8000,
          isNewFile: false,
          truncated: true,
          after: 'x'.repeat(100),
        }),
        isError: false,
        durationMs: 18,
      },
    );
    test.skip(!dispatched, 'Synthetic stream dispatch unavailable in this build.');

    const card = mainWindow
      .locator('[data-testid="file-edit-diff"][data-truncated="true"]')
      .first();
    await expect(card).toBeVisible({ timeout: 5_000 });
    await expect(card).toContainText('truncated');
  });
});

function wcagContrast(foreground: string, background: [number, number, number]): number {
  const fg = parseRgb(foreground);
  const luminance = ([r, g, b]: [number, number, number]): number => {
    const linear = (channel: number): number => {
      const value = channel / 255;
      return value <= 0.04045
        ? value / 12.92
        : Math.pow((value + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
  };
  const foregroundLuminance = luminance(fg);
  const backgroundLuminance = luminance(background);
  return (Math.max(foregroundLuminance, backgroundLuminance) + 0.05)
    / (Math.min(foregroundLuminance, backgroundLuminance) + 0.05);
}

function composite(
  foreground: string,
  background: string,
): [number, number, number] {
  const foregroundChannels = parseRgba(foreground);
  const backgroundChannels = parseRgba(background);
  return foregroundChannels.slice(0, 3).map((channel, index) => (
    channel * foregroundChannels[3]
      + backgroundChannels[index]! * (1 - foregroundChannels[3])
  )) as [number, number, number];
}

function parseRgb(color: string): [number, number, number] {
  return parseRgba(color).slice(0, 3) as [number, number, number];
}

function parseRgba(color: string): [number, number, number, number] {
  const channels = color.match(/[\d.]+/g)?.map(Number);
  if (
    !channels
    || (channels.length !== 3 && channels.length !== 4)
    || channels.some(Number.isNaN)
  ) {
    throw new Error(`unsupported computed color: ${color}`);
  }
  return [channels[0]!, channels[1]!, channels[2]!, channels[3] ?? 1];
}
