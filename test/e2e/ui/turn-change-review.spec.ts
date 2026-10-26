import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  buildE2eBaseSettings, buildLlmSettings, launchSeededElectron, teardownSeededElectron,
  type SeededElectronContext,
} from "./seeded-electron.js";

const SESSION_ID = "e2000000-bb11-4cc2-8dd3-eeeeeeeeeeee";
const TURN_ID = "review-user-turn";
let context: SeededElectronContext | undefined;

test.afterEach(async () => {
  if (!context) return;
  const child = context.app.process();
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit");
    child.kill("SIGKILL");
    await exited;
  }
  await teardownSeededElectron(context);
  context = undefined;
});

async function setupReview() {
  context = await launchSeededElectron({
    sessionId: SESSION_ID,
    settings: { ...buildLlmSettings(), ...buildE2eBaseSettings(true, "en") },
    historyRows: [
      { role: "user", content: "Update both source lines.", meta: { messageId: TURN_ID } },
      { role: "assistant", content: "Both source lines were updated.", meta: { messageId: "review-answer" } },
    ],
  });
  const page = context.page;
  await expect(page.getByText("Both source lines were updated.", { exact: true })).toBeVisible();
  const keySaved = await page.evaluate(async () => {
    const api = (window as unknown as {
      aveApi: {
        setApiKey: (vendor: string, key: string) => Promise<{ ok: boolean }>;
        hasApiKey: (vendor: string) => Promise<boolean>;
      };
    }).aveApi;
    const result = await api.setApiKey("openai", "sk-e2e-openai");
    return result.ok && await api.hasApiKey("openai");
  });
  expect(keySaved).toBe(true);
  await page.reload();
  await expect(page.getByText("Both source lines were updated.", { exact: true })).toBeVisible();
  const textarea = page.locator('[data-testid="composer-textarea"][data-composer-surface="main"]');
  await expect(textarea).toBeEnabled();
  await expect(textarea).not.toHaveAttribute("placeholder", "Please set up your API key first...");
  const path = join(realpathSync(context.aveHome), "workspace", "review-source.txt");
  const before = "original first\nunchanged middle\noriginal last\n";
  const after = "updated first\nunchanged middle\nupdated last\n";
  writeFileSync(path, after);
  const checkpointDir = join(context.aveHome, "code-checkpoints");
  mkdirSync(checkpointDir, { recursive: true, mode: 0o700 });
  writeFileSync(join(checkpointDir, "turns.json"), JSON.stringify([{
    sessionId: SESSION_ID, messageId: TURN_ID, unavailable: false, consumed: false,
    changes: [{ path, before: Buffer.from(before).toString("base64"), mode: 0o644, afterHash: createHash("sha256").update(after).digest("hex") }],
  }]), { mode: 0o600 });
  const toggle = page.getByRole("button", { name: "Review latest turn changes", exact: true });
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("button", { name: "Reference hunk 1 in review-source.txt, lines 1–1", exact: true })).toBeVisible();
  return { page, path, before, after };
}

for (const width of [900, 1243]) {
  test(`readonly review references current lines above the composer at ${width}px`, async ({}, testInfo) => {
    const { page, path, after } = await setupReview();
    await page.setViewportSize({ width, height: 768 });
    const review = page.getByTestId("turn-change-review");
    const frame = page.getByTestId("composer-frame").first();
    const region = page.getByRole("region", { name: "Review latest turn changes", exact: true });
    const reviewBox = (await review.boundingBox())!;
    const frameBox = (await frame.boundingBox())!;
    expect(reviewBox.y + reviewBox.height).toBeLessThanOrEqual(frameBox.y);
    expect(Math.abs(reviewBox.x - frameBox.x)).toBeLessThanOrEqual(2);
    expect(Math.abs(reviewBox.width - frameBox.width)).toBeLessThanOrEqual(2);
    expect(reviewBox.height).toBeLessThanOrEqual(242);
    await expect(page.getByRole("button", { name: /^(Accept|Reject) hunk/ })).toHaveCount(0);
    await expect(region).not.toContainText(path);
    const hunk = page.getByRole("button", { name: "Reference hunk 1 in review-source.txt, lines 1–1", exact: true });
    await hunk.focus();
    await page.keyboard.press("Enter");
    const textarea = page.locator('[data-testid="composer-textarea"][data-composer-surface="main"]');
    await expect(textarea).toHaveValue("[File #1]");
    await expect(page.getByTestId("attachment-chip")).toContainText("review-source.txt:1-1");
    expect(readFileSync(path, "utf8")).toBe(after);
    await page.screenshot({ path: testInfo.outputPath(`turn-review-reference-${width}.png`) });
    await page.getByRole("button", { name: "Reference review-source.txt, lines 1–3", exact: true }).click();
    await expect(textarea).toHaveValue(/\[File #2\]/);
    await page.reload();
    const toggle = page.getByRole("button", { name: "Review latest turn changes", exact: true });
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await toggle.click();
    await expect(page.getByRole("button", { name: "Reference hunk 1 in review-source.txt, lines 1–1", exact: true })).toBeVisible();
    expect(readFileSync(path, "utf8")).toBe(after);
  });
}
