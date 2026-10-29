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
    await expect(page.getByTestId("sidebar-card")).toHaveAttribute("data-surface", "bare");
    await expect(conversation).toHaveCount(0);
    await expect(browser).toHaveCount(0);
    await expect(terminal).toHaveCount(0);
    await page.getByTestId("sidebar-group-features").click();
    const terminalMenu = page.getByTestId("sidebar-terminal");
    await page.mouse.move(1100, 700);
    await terminalMenu.focus();
    await expect(card).toContainText(/터미널|Terminal/);
    await expect(terminalMenu).not.toHaveAttribute("title");
    await expect.poll(() => terminalMenu.evaluate((entry) => {
      const id = entry.getAttribute("aria-describedby");
      return id ? document.getElementById(id)?.textContent : null;
    })).toMatch(/터미널|Terminal/);
    await page.screenshot({ path: testInfo.outputPath("collapsed-keyboard-preview.png") });
    await page.keyboard.press("Escape");
    await expect(card).toBeHidden();
    await page.getByTestId("sidebar-group-features").click();
    await page.getByTestId("sidebar-web").focus();
    await expect(card).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(card).toBeHidden();
  } finally {
    await teardownSeededElectron(ctx, { terminate: true });
  }
});
