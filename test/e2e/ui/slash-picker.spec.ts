import { test, expect } from './fixtures.js';
import { TEST_IDS, testIdSelector } from "../../../src/shared/test-ids.js";
import { captureCommandMenus, capturedCommandMenus } from "./command-menu.js";

// Record native menu payloads at IPC; renderer locators cannot inspect the OS menu.

const payloads = capturedCommandMenus;

test('command button: both the click and Cmd/Ctrl+K raise the menu', async ({ app, mainWindow }) => {
  const trigger = mainWindow.locator(testIdSelector(TEST_IDS.slashPickerTrigger));
  await expect(trigger).toBeVisible({ timeout: 60_000 });
  await captureCommandMenus(app);

  await trigger.click();
  await expect.poll(() => payloads(app).then((p) => p.length)).toBe(1);

  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await mainWindow.keyboard.press(`${mod}+k`);
  await expect.poll(() => payloads(app).then((p) => p.length)).toBe(2);

  // Anchor to the button so shortcut invocation does not depend on a pointer.
  const box = await trigger.boundingBox();
  const [first] = await payloads(app);
  expect(Math.abs(first!.x - Math.round(box!.x))).toBeLessThanOrEqual(2);
  expect(Math.abs(first!.y - Math.round(box!.y + box!.height))).toBeLessThanOrEqual(2);
});

test('command button: the persona and every list sit behind their own submenus', async ({ app, mainWindow }) => {
  const trigger = mainWindow.locator(testIdSelector(TEST_IDS.slashPickerTrigger));
  await expect(trigger).toBeVisible({ timeout: 60_000 });
  await captureCommandMenus(app);
  await trigger.click();
  await expect.poll(() => payloads(app).then((p) => p.length)).toBe(1);

  const [payload] = await payloads(app);
  // Native menus cannot filter while typing; categories provide navigation and omit empty groups.
  expect(payload!.sections).toHaveLength(1);
  const [categories] = payload!.sections;
  expect(categories!.items[0]!.id).toBe('category:persona');
  expect(categories!.items.every((row) => (row.submenu?.length ?? 0) > 0)).toBe(true);

  const commands = categories!.items.find((row) => row.id === 'category:command');
  expect(commands).toBeDefined();
  expect(commands!.submenu!.some((row) => row.id === 'command:/new')).toBe(true);

  // Main drops leaves without a resolvable id or a single-line label.
  const leaves = categories!.items.flatMap((row) => row.submenu ?? []);
  expect(leaves.every((row) => row.id.length > 0 && row.label.trim().length > 0)).toBe(true);
  expect(leaves.every((row) => !row.label.includes('\n'))).toBe(true);
});
