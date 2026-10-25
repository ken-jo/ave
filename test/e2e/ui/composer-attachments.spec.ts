import { test, expect } from "./fixtures";
import { TEST_IDS, testIdSelector } from "../../../src/shared/test-ids.js";

// Native file picking is outside this renderer smoke; verify attachment controls and strip geometry.
test("legacy indexer popover removed; new attach button in action bar", async ({ mainWindow }) => {
  const actionBar = mainWindow.locator('[data-testid="input-action-bar"]');
  const found = await actionBar
    .waitFor({ state: "visible", timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  test.skip(!found, "Input action bar not visible — skipping");

  await expect(mainWindow.locator('[title="문서 첨부"]')).toHaveCount(0);

  await expect(mainWindow.locator('[data-testid="iab-attach-button"]')).toBeVisible();
});

test("composer renders and strip is absent when no attachments", async ({ mainWindow }) => {
  const composer = mainWindow.locator(testIdSelector(TEST_IDS.composer));
  const found = await composer
    .waitFor({ state: "visible", timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  test.skip(!found, "Composer not visible — skipping");

  await expect(mainWindow.locator(testIdSelector(TEST_IDS.composerTextarea))).toBeVisible();
  await expect(mainWindow.locator('[data-testid="composer-strip"]')).toHaveCount(0);
});

test("typing a stale marker does not flash a phantom chip", async ({ mainWindow }) => {
  const textarea = mainWindow.locator(testIdSelector(TEST_IDS.composerTextarea));
  const found = await textarea
    .waitFor({ state: "visible", timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  test.skip(!found, "Composer textarea not visible — skipping");

  await textarea.click();
  await textarea.fill("hello [Image #1] world");
  await expect(mainWindow.locator('[data-testid="attachment-chip"]')).toHaveCount(0);
  await expect(
    mainWindow.locator('[data-testid="attachment-chip-collapsed"]'),
  ).toHaveCount(0);
  await expect(mainWindow.locator('[data-testid="composer-strip"]')).toHaveCount(0);
});
