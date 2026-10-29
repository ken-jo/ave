import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { buildLlmSettings, builtMainExists, launchSeededElectron, teardownSeededElectron } from "./seeded-electron.js";

// Exercise the actual entry wiring and portal placement in both sidebar forms.
test("previews sidebar entries on hover and supports keyboard focus in the collapsed rail", async ({}, testInfo) => {
  expect(builtMainExists(), "Build the app before running the preview flow").toBe(true);
  const sessionId = "e2000000-bb11-4cc2-8dd3-eeeeeeeeeeee";
  const message = "The build target is ready for review.";
  const promptConfig = testInfo.outputPath("starship.toml");
  mkdirSync(dirname(promptConfig), { recursive: true });
  writeFileSync(promptConfig, "[gcloud]\ndisabled = true\n[aws]\ndisabled = true\n[username]\ndisabled = true\n");
  const ctx = await launchSeededElectron({
    launchEnv: { STARSHIP_CONFIG: promptConfig, PS1: "❯ ", PROMPT: "❯ " },
    sessionId,
    sessionTitle: "Build review",
    historyRows: [{ role: "user", content: "Review the build" }, { role: "assistant", content: message }],
    settings: {
      ...buildLlmSettings(),
      system: {
        sidebarState: "expanded",
        mainLayout: {
          version: 1, tree: { kind: "leaf", chatGroupId: "main" }, focusedId: "main", surfaces: {}, panelOpenIds: [],
          sideTabs: { main: [
            { tabId: "browser:abc12345-1", kind: "browser", ordinal: 1, url: "http://127.0.0.1:1/", cwd: null },
            { tabId: "terminal:abc12345-2", kind: "terminal", ordinal: 1, url: null, cwd: null },
          ] },
        },
      },
    },
  });
  try {
    const { page } = ctx;
    const conversation = page.getByTestId(`sidebar-session-${sessionId}`);
    const browser = page.getByTestId("sidebar-surface-browser:abc12345-1");
    const terminal = page.getByTestId("sidebar-surface-terminal:abc12345-2");
    const card = page.getByTestId("sidebar-preview");
    await expect(conversation).toBeVisible();
    await conversation.hover();
    await expect(card).toContainText("Build review");
    await expect(card).toContainText(message);
    const sidebarBounds = (await page.getByTestId("primary-sidebar").boundingBox())!;
    expect((await card.boundingBox())!.x).toBeGreaterThanOrEqual(sidebarBounds.x + sidebarBounds.width);
    await page.screenshot({ path: testInfo.outputPath("expanded-conversation-preview.png") });
    await page.keyboard.press("Escape");
    await expect(card).toBeHidden();
    await browser.hover();
    await expect(card).toBeVisible();
    await expect(card.locator("img")).toHaveCount(0);
    await terminal.hover();
    await expect(card).toContainText(/터미널|Terminal/);
    await expect(card.locator("img")).toHaveCount(0);
    await terminal.click();
    await expect(card).toBeHidden();
    await page.getByTestId("sidebar-collapse-toggle").click();
    await expect(conversation).toBeVisible();
    await conversation.focus();
    await expect(card).toContainText(message);
    const collapsedEntryBounds = (await conversation.boundingBox())!;
    const collapsedCardBounds = (await card.boundingBox())!;
    expect(collapsedCardBounds.x).toBeGreaterThanOrEqual(collapsedEntryBounds.x + collapsedEntryBounds.width);
    expect(collapsedCardBounds.x).toBeLessThanOrEqual(collapsedEntryBounds.x + collapsedEntryBounds.width + 30);
    const descriptionId = await card.getAttribute("id");
    await expect(conversation).toHaveAttribute("aria-describedby", descriptionId!);
    await page.screenshot({ path: testInfo.outputPath("collapsed-keyboard-preview.png") });
    await page.keyboard.press("Escape");
    await expect(card).toBeHidden();
    await expect(conversation).not.toHaveAttribute("aria-describedby");
    await browser.focus();
    await expect(card).toBeVisible();
    await terminal.focus();
    await expect(card).toContainText(/터미널|Terminal/);
    await page.keyboard.press("Escape");
    await expect(card).toBeHidden();
  } finally {
    await teardownSeededElectron(ctx, { terminate: true });
  }
});
