import { test, expect } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { buildE2eBaseSettings, buildLlmSettings, launchSeededElectron, teardownSeededElectron, type SeededElectronContext } from "./seeded-electron";

const SESSION_ID = "e2000000-bb11-4cc2-8dd3-eeeeeeeeeeee";
const MESSAGE_ID = "rewind-user-row";
let ctx: SeededElectronContext;
test.afterEach(async () => { if (ctx) await teardownSeededElectron(ctx); });

async function setup() {
  ctx = await launchSeededElectron({
    sessionId: SESSION_ID,
    settings: { ...buildLlmSettings(), ...buildE2eBaseSettings(true, "en") },
    historyRows: [
      { role: "user", content: "Update the source file.", meta: { messageId: MESSAGE_ID } },
      { role: "assistant", content: "The source file is updated.", meta: { messageId: "rewind-answer-row" } },
    ],
  });
  const source = join(realpathSync(ctx.tempHome), "source.txt");
  const created = join(realpathSync(ctx.tempHome), "created.txt");
  const original = Buffer.from("original\r\n한글\n");
  const after = "agent edit\n";
  writeFileSync(source, after); writeFileSync(created, after);
  mkdirSync(join(ctx.aveHome, "code-checkpoints"), { mode: 0o700 });
  writeFileSync(join(ctx.aveHome, "code-checkpoints/turns.json"), JSON.stringify([{
    sessionId: SESSION_ID, messageId: MESSAGE_ID, unavailable: false,
    changes: [
      { path: source, before: original.toString("base64"), mode: 0o644, afterHash: createHash("sha256").update(after).digest("hex") },
      { path: created, before: null, mode: 0o600, afterHash: createHash("sha256").update(after).digest("hex") },
    ],
  }]), { mode: 0o600 });
  await expect(ctx.page.getByText("The source file is updated.", { exact: true })).toBeVisible();
  await ctx.page.getByText("Update the source file.", { exact: true }).hover();
  await ctx.page.getByTitle("Return here", { exact: true }).click();
  return { source, created, original, page: ctx.page };
}

test("code-only restore preserves conversation and restores file bytes and absence", async ({}, testInfo) => {
  const { source, created, original, page } = await setup();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toContainText("Bash and other shell side effects are not tracked");
  await expect(dialog).toContainText("64 MiB");
  await expect(dialog.getByRole("button", { name: "Restore conversation only", exact: true })).toBeVisible();
  await expect(dialog.getByRole("button", { name: "Restore conversation and code", exact: true })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("rewind-choices.png") });
  await dialog.getByRole("button", { name: "Restore code only", exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(readFileSync(source)).toEqual(original);
  expect(existsSync(created)).toBe(false);
  await expect(page.getByText("The source file is updated.", { exact: true })).toBeVisible();
});

test("combined restore refuses external changes and conversation-only remains available", async () => {
  const { source, created, page } = await setup();
  writeFileSync(source, "external change");
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Restore conversation and code", exact: true }).click();
  await expect(page.getByText(source, { exact: false })).toBeVisible();
  expect(readFileSync(source, "utf8")).toBe("external change");
  expect(existsSync(created)).toBe(true);
  await expect(page.getByText("The source file is updated.", { exact: true })).toBeVisible();
  await expect(dialog).toBeHidden();
  await page.getByText("Update the source file.", { exact: true }).hover();
  await page.getByTitle("Return here", { exact: true }).click();
  await dialog.getByRole("button", { name: "Restore conversation only", exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("The source file is updated.", { exact: true })).toBeHidden();
  expect(readFileSync(source, "utf8")).toBe("external change");
  expect(existsSync(created)).toBe(true);
});

test("combined restore cuts the conversation after restoring code", async () => {
  const { source, created, original, page } = await setup();
  await page.getByRole("dialog").getByRole("button", { name: "Restore conversation and code", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeHidden();
  await expect(page.getByText("The source file is updated.", { exact: true })).toBeHidden();
  expect(readFileSync(source)).toEqual(original);
  expect(existsSync(created)).toBe(false);
});
