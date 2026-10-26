import { test, expect } from "@playwright/test";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  buildE2eBaseSettings, buildLlmSettings, launchSeededElectron, teardownSeededElectron,
  type SeededElectronContext,
} from "./seeded-electron.js";

const SESSION_ID = "e2000000-bb11-4cc2-8dd3-eeeeeeeeeeee";
const TURN_ID = "summary-user-turn";
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

async function setupChanges() {
  context = await launchSeededElectron({
    sessionId: SESSION_ID,
    settings: { ...buildLlmSettings(), ...buildE2eBaseSettings(true, "en") },
    historyRows: [
      { role: "user", content: "Update the workspace files.", meta: { messageId: TURN_ID } },
      { role: "assistant", content: "The workspace files are ready.", meta: { messageId: "summary-answer" } },
      { role: "user", content: "Keep the queued instruction in this turn.", meta: { messageId: "queued-guidance-row", hostInjectionId: "queued-guidance-batch" } },
      { role: "assistant", content: "The queued instruction is complete.", meta: { messageId: "queued-answer" } },
    ],
  });
  const page = context.page;
  await expect(page.getByText("The workspace files are ready.", { exact: true })).toBeVisible();
  const saved = await page.evaluate(async () => {
    const api = (window as unknown as { aveApi: {
      setApiKey: (vendor: string, key: string) => Promise<{ ok: boolean }>;
      hasApiKey: (vendor: string) => Promise<boolean>;
    } }).aveApi;
    return (await api.setApiKey("openai", "sk-e2e-openai")).ok && await api.hasApiKey("openai");
  });
  expect(saved).toBe(true);
  const root = join(realpathSync(context.aveHome), "workspace");
  const checkpointDir = join(context.aveHome, "code-checkpoints");
  mkdirSync(checkpointDir, { recursive: true, mode: 0o700 });
  const before = "original first\nunchanged middle\noriginal third\n";
  const after = "updated first\nunchanged middle\nupdated third\n";
  const changes = Array.from({ length: 9 }, (_, index) => {
    const path = join(root, "src", index === 0 ? "Composer.tsx" : `source-${index}.ts`);
    mkdirSync(dirname(path), { recursive: true });
    const oldText = index === 0 ? before : "old\n";
    const newText = index === 0 ? after : "new\n";
    writeFileSync(path, newText);
    const encoded = Buffer.from(oldText).toString("base64");
    const image = `image-${randomUUID()}.json`;
    writeFileSync(join(checkpointDir, image), `${JSON.stringify(encoded)}\n`, { mode: 0o600 });
    return { path, before: image, beforeHash: createHash("sha256").update(oldText).digest("hex"),
      storageBytes: Buffer.byteLength(encoded) + 3, mode: 0o644,
      afterHash: createHash("sha256").update(newText).digest("hex"), addedLines: index === 0 ? 2 : 1, removedLines: index === 0 ? 2 : 1 };
  });
  writeFileSync(join(checkpointDir, "turns.json"), JSON.stringify({ version: 2, turns: [{
    sessionId: SESSION_ID, messageId: TURN_ID, unavailable: false, consumed: false, changes,
  }] }), { mode: 0o600 });
  await page.reload();
  await expect(page.getByTestId("latest-turn-summary")).toBeVisible();
  return { page, path: changes[0]!.path, after };
}

for (const width of [900, 1243]) {
  test(`compact turn summary reveals Files and inserts a native hunk reference at ${width}px`, async ({}, testInfo) => {
    const { page, path, after } = await setupChanges();
    await page.setViewportSize({ width, height: 768 });
    const summary = page.getByTestId("latest-turn-summary");
    const frame = page.getByTestId("composer-frame").first();
    await expect(summary.getByTestId("latest-turn-summary-file")).toHaveCount(5);
    await expect(summary).toContainText("9 files");
    await expect(summary).toContainText("+10");
    await expect(summary).toContainText("−10");
    await expect(summary).toContainText("4 more files");
    await expect(summary.locator("[data-diff-kind]")).toHaveCount(0);
    await expect(summary.getByRole("alert")).toHaveCount(0);
    await expect(page.getByTestId("turn-change-review")).toHaveCount(0);
    const summaryBox = (await summary.boundingBox())!;
    const frameBox = (await frame.boundingBox())!;
    expect(summaryBox.y + summaryBox.height).toBeLessThanOrEqual(frameBox.y);
    expect(frameBox.y + frameBox.height).toBeLessThan(768);
    await page.screenshot({ path: testInfo.outputPath(`summary-${width}.png`) });
    await summary.getByRole("button", { name: "Show more", exact: true }).click();
    const workspace = page.getByTestId("chat-side-panel-file-browser");
    await expect(workspace).toBeVisible();
    await expect(workspace.getByTestId("chat-side-panel-file-filter-changed")).toHaveAttribute("aria-pressed", "true");
    const selectedRow = workspace.locator('[role="treeitem"][aria-selected="true"]');
    await expect(selectedRow).toContainText("Composer.tsx");
    if (await workspace.getAttribute("data-file-layout") === "single") await selectedRow.click();
    const detail = page.getByTestId("turn-change-detail");
    await expect(detail).toBeVisible();
    const hunk = detail.getByRole("button", { name: "Reference hunk 2 in src/Composer.tsx, lines 3–3", exact: true });
    await expect(hunk).toBeEnabled();
    await hunk.focus();
    await page.keyboard.press("Enter");
    const textarea = page.locator('[data-testid="composer-textarea"][data-composer-surface="main"]');
    await expect(textarea).toHaveValue("[File #1]");
    await hunk.click();
    await expect(textarea).toHaveValue("[File #1]");
    await expect(page.getByText("@src/Composer.tsx:3-3", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Remove reference src/Composer.tsx:3-3", exact: true })).toBeVisible();
    expect(readFileSync(path, "utf8")).toBe(after);
    const geometry = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth }));
    expect(geometry.scrollWidth).toBeLessThanOrEqual(geometry.width);
    await page.screenshot({ path: testInfo.outputPath(`files-reference-${width}.png`) });
  });
}
