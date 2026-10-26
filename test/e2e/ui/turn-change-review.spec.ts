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
  const page = context.page;
  await expect(page.getByText("Both source lines were updated.", { exact: true })).toBeVisible();
  await page.getByTestId("iab-status-permission").click();
  await page.getByTestId("permission-quick-picker-option:allow").click();
  await expect(page.getByTestId("permission-quick-picker")).toBeHidden();
  await expect(page.getByTestId("iab-status-permission")).toHaveAttribute("data-mode", "allow");
  const toggle = page.getByRole("button", { name: "Review latest turn changes", exact: true });
  await toggle.focus();
  await page.keyboard.press("Enter");
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(page.getByRole("button", { name: `Reject hunk 1 in ${path}`, exact: true })).toBeVisible();
  return { page, path, before, after };
}

test("keyboard hunk decisions preserve independent edits and reload persisted status", async ({}, testInfo) => {
  const { page, path } = await setupReview();
  const reject = page.getByRole("button", { name: `Reject hunk 1 in ${path}`, exact: true });
  await reject.focus();
  await page.keyboard.press("Space");
  await expect(page.getByRole("status").filter({ hasText: "Hunk rejected." })).toBeFocused();
  await expect(page.getByRole("region", { name: "Review latest turn changes", exact: true })).toHaveAttribute("aria-busy", "false");
  await expect(reject).toBeDisabled();
  expect(readFileSync(path, "utf8")).toBe("original first\nunchanged middle\nupdated last\n");
  const accept = page.getByRole("button", { name: `Accept hunk 2 in ${path}`, exact: true });
  await accept.focus();
  await page.keyboard.press("Enter");
  await expect(page.getByRole("status").filter({ hasText: "Hunk accepted." })).toBeFocused();
  await expect(page.getByRole("region", { name: "Review latest turn changes", exact: true })).toHaveAttribute("aria-busy", "false");
  await expect(accept).toBeDisabled();
  await expect(page.getByText("Accepted", { exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("turn-review-decisions.png") });
  await page.reload();
  await page.getByRole("button", { name: "Review latest turn changes", exact: true }).click();
  await expect(page.getByText("Rejected", { exact: true })).toBeVisible();
  await expect(page.getByText("Accepted", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: `Accept hunk 1 in ${path}`, exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: `Reject hunk 2 in ${path}`, exact: true })).toBeDisabled();
  expect(readFileSync(path, "utf8")).toBe("original first\nunchanged middle\nupdated last\n");
});

test("an external file change refuses rejection without a force option", async ({}, testInfo) => {
  const { page, path } = await setupReview();
  writeFileSync(path, "independent external edit\n");
  await page.getByRole("button", { name: `Reject hunk 1 in ${path}`, exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "The file changed since this turn. Nothing was reverted." })).toBeVisible();
  expect(readFileSync(path, "utf8")).toBe("independent external edit\n");
  await expect(page.getByRole("button", { name: /force/i })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("turn-review-conflict.png") });
});
