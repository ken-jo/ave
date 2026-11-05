import { mkdirSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test as base, expect } from "./fixtures.js";

const MEMORY_ID = "68d0be17-3e57-4ce0-8c85-9955fdb0a152";
const SOURCE_SESSION_ID = "43710b94-5bfb-4efc-b7c3-bef127b0ad26";
const SOURCE_MESSAGE_ID = "payment-timeout-source";
const TITLE = "Payment timeout is ten seconds";
const QUOTE = "The gateway now times out after ten seconds. Remember that.";
const BEFORE = "The payment timeout is eight seconds.";
const AFTER = "The payment timeout is ten seconds.";
const AT = "2026-11-04T09:00:00.000Z";

const test = base.extend({
  aveHome: async ({ tempHome }, use) => {
    const aveHome = join(tempHome, ".ave");
    const memories = join(aveHome, "memories");
    const sessions = join(aveHome, "sessions");
    mkdirSync(memories, { recursive: true, mode: 0o700 });
    mkdirSync(sessions, { recursive: true, mode: 0o700 });
    const metadata = {
      v: 1, id: MEMORY_ID, scope: { type: "global" }, kind: "fact", state: "active",
      source: "assistant", createdAt: AT,
      origin: { v: 1, sessionId: SOURCE_SESSION_ID, messageId: SOURCE_MESSAGE_ID, store: "main" },
    };
    writeFileSync(join(memories, "payment-timeout.md"), [
      "<!-- ave:kind=memory -->",
      `<!-- ave:memory-meta:${Buffer.from(JSON.stringify(metadata)).toString("base64url")} -->`,
      `# ${TITLE}\n\n${AFTER}\n`,
    ].join("\n"), { mode: 0o600 });
    utimesSync(join(memories, "payment-timeout.md"), new Date(AT), new Date(AT));
    const idleAt = new Date(Date.now() - 38 * 24 * 60 * 60 * 1000).toISOString();
    writeFileSync(join(memories, "retired-reference.md"), [
      "<!-- ave:kind=memory -->",
      `<!-- ave:memory-meta:${Buffer.from(JSON.stringify({
        v: 1, id: "39c71802-a1a5-4b7b-aee1-841458e40a25", scope: { type: "global" },
        kind: "reference", state: "active", source: "user", createdAt: idleAt,
      })).toString("base64url")} -->`,
      "# Retired callback reference\n\nAn older reference.\n",
    ].join("\n"), { mode: 0o600 });
    utimesSync(join(memories, "retired-reference.md"), new Date(idleAt), new Date(idleAt));
    const messages = [
      { role: "user", meta: { messageId: SOURCE_MESSAGE_ID }, content: QUOTE },
      ...Array.from({ length: 24 }, (_, index) => [
        { role: "assistant", meta: { messageId: `answer-${index}` }, content: `Later response ${index}. ${"Additional context. ".repeat(20)}` },
        { role: "user", meta: { messageId: `question-${index}` }, content: `Continue discussion ${index}.` },
      ]).flat(),
    ];
    writeFileSync(join(sessions, `${SOURCE_SESSION_ID}.jsonl`), messages.map((message) => JSON.stringify(message)).join("\n") + "\n", { mode: 0o600 });
    writeFileSync(join(sessions, `${SOURCE_SESSION_ID}.meta.json`), JSON.stringify({
      title: "Payment gateway investigation", updatedAt: AT,
    }), { mode: 0o600 });
    writeFileSync(join(memories, "history.jsonl"), [
      { v: 1, memoryId: MEMORY_ID, at: "2026-11-03T09:00:00.000Z", op: "created", actor: "assistant" },
      { v: 1, memoryId: MEMORY_ID, at: AT, op: "updated", actor: "assistant", before: BEFORE, after: AFTER, sessionId: SOURCE_SESSION_ID },
    ].map((row) => JSON.stringify(row)).join("\n") + "\n", { mode: 0o600 });
    writeFileSync(join(memories, "usage.jsonl"), ["injected", "searched", "read"].map((via, index) => JSON.stringify({
      v: 1, memoryId: MEMORY_ID, via, sessionId: SOURCE_SESSION_ID, store: "main",
      anchorMessageId: SOURCE_MESSAGE_ID, at: `2026-11-04T09:0${index}:00.000Z`,
    })).join("\n") + "\n", { mode: 0o600 });
    await use(aveHome);
  },
});

test("shows live origin, history and filtered uses at wide and narrow sizes", async ({ app, mainWindow }, testInfo) => {
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed() && candidate.isVisible());
    if (!window) throw new Error("Memory panel window unavailable");
    window.setContentSize(1280, 860);
    window.webContents.send("ave:view:activate", { viewKey: "memory" });
  });
  const panel = mainWindow.getByTestId("memory-search-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByRole("region", { name: "Memory scopes" })).toBeVisible();
  await expect(panel.getByRole("button", { name: "Tell Ave in a new conversation" })).toBeVisible();
  await expect(panel.getByRole("complementary", { name: "Global memories" })).toBeVisible();
  await expect(panel.getByRole("button", { name: /Retired callback reference.*Unused for 38 days/ })).toBeVisible();
  await expect(panel.getByTestId("memory-recent-strip")).toContainText("Payment gateway investigation");
  await mainWindow.screenshot({ path: testInfo.outputPath("memory-empty-global.png"), animations: "disabled" });
  await panel.getByRole("tabpanel", { name: /Memories/ }).getByRole("button", { name: TITLE, exact: false }).click();
  await expect(panel.getByText(QUOTE, { exact: true })).toBeVisible();
  await expect(panel.getByText("Payment gateway investigation", { exact: false }).first()).toBeVisible();
  await mainWindow.screenshot({ path: testInfo.outputPath("memory-origin-wide.png"), animations: "disabled" });

  await panel.getByRole("tab", { name: /Change history/ }).click();
  await expect(panel.locator("del")).toHaveText(BEFORE);
  await expect(panel.locator("ins")).toHaveText(AFTER);
  await mainWindow.screenshot({ path: testInfo.outputPath("memory-history-wide.png"), animations: "disabled" });

  await panel.getByRole("tab", { name: /Use log/ }).click();
  await panel.getByRole("button", { name: /^Searched/ }).click();
  const usage = panel.getByRole("tabpanel", { name: /Use log/ }).locator("ul");
  await expect(usage.getByRole("button")).toHaveCount(1);
  await expect(usage).toContainText("Searched");
  await mainWindow.screenshot({ path: testInfo.outputPath("memory-use-filter-wide.png"), animations: "disabled" });

  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed() && candidate.isVisible());
    if (!window) throw new Error("Memory panel window unavailable");
    window.setContentSize(760, 860);
  });
  await expect(panel.getByRole("button", { name: "Back to memories" })).toBeVisible();
  await mainWindow.screenshot({ path: testInfo.outputPath("memory-detail-narrow.png"), animations: "disabled" });
  expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
  await panel.getByRole("button", { name: "Back to memories" }).click();
  await expect(panel.getByRole("tabpanel", { name: /Memories/ }).getByRole("button", { name: TITLE, exact: false })).toBeVisible();
  await panel.getByRole("tabpanel", { name: /Memories/ }).getByRole("button", { name: TITLE, exact: false }).click();
  await panel.getByRole("tab", { name: "Overview" }).click();
  await panel.getByRole("button", { name: "View conversation" }).click();
  await expect(panel).not.toBeVisible();
  await expect(mainWindow.locator('[data-chat-entry-index="0"]').getByText(QUOTE, { exact: true })).toBeInViewport();
  await expect(mainWindow.locator('[data-chat-entry-index="48"]')).not.toBeInViewport();
  await mainWindow.screenshot({ path: testInfo.outputPath("memory-source-message.png"), animations: "disabled" });
});

test("starts a conversation from the empty project memory state", async ({ app, mainWindow }) => {
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed() && candidate.isVisible());
    if (!window) throw new Error("Memory panel window unavailable");
    window.webContents.send("ave:view:activate", { viewKey: "memory" });
  });
  const panel = mainWindow.getByTestId("memory-search-panel");
  await expect(panel.getByRole("complementary", { name: "Global memories" })).toContainText(TITLE);
  await panel.getByRole("button", { name: "Tell Ave in a new conversation" }).click();
  await expect(panel).not.toBeVisible();
});

test("shows an unavailable deleted origin consistently in the list and detail", async ({ app, mainWindow, aveHome }) => {
  unlinkSync(join(aveHome, "sessions", `${SOURCE_SESSION_ID}.jsonl`));
  unlinkSync(join(aveHome, "sessions", `${SOURCE_SESSION_ID}.meta.json`));
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed() && candidate.isVisible());
    if (!window) throw new Error("Memory panel window unavailable");
    window.webContents.send("ave:view:activate", { viewKey: "memory" });
  });
  const panel = mainWindow.getByTestId("memory-search-panel");
  const row = panel.getByRole("tabpanel", { name: /Memories/ }).getByRole("button", { name: TITLE, exact: false });
  await expect(row).toContainText("The source conversation is unavailable or was deleted.");
  await row.click();
  await expect(panel.getByRole("region", { name: "Learned in" })).toContainText("The source conversation is unavailable or was deleted.");
});

test("shows only a failure when the usage log cannot be read", async ({ app, mainWindow, aveHome }, testInfo) => {
  const usagePath = join(aveHome, "memories", "usage.jsonl");
  unlinkSync(usagePath);
  mkdirSync(usagePath);
  await app.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed() && candidate.isVisible());
    if (!window) throw new Error("Memory panel window unavailable");
    window.webContents.send("ave:view:activate", { viewKey: "memory" });
  });
  const panel = mainWindow.getByTestId("memory-search-panel");
  const failure = "Could not load memory summaries. Reopen the panel to retry.";
  await expect(panel.getByRole("alert")).toHaveText(failure);
  await expect(panel).toHaveText(failure);
  await expect(panel.getByRole("button", { name: "Tell Ave in a new conversation" })).toHaveCount(0);
  await mainWindow.screenshot({ path: testInfo.outputPath("memory-summary-failed.png"), animations: "disabled" });
});
