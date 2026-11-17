import { test, expect } from "./fixtures.js";
import { CHANNELS } from "../../../src/contract/app-contract.js";
import { withPageWindow } from "./renderer-events.js";

// These renderer fixtures verify the shared selector. Native gate and invocation suites own consent and session-state authority.
test.use({ seedViewFixturePlugin: false });

for (const surface of ["browser", "host-terminal"] as const) {
  test(`the ${surface} session card starts at ask and exposes all three choices`, async ({ app, mainWindow }, testInfo) => {
    const sessionId = await mainWindow.evaluate(async () => (await window.aveApi.chatSessions({ kind: "main" })).current);
    if (!sessionId) throw new Error("Current conversation unavailable");
    await withPageWindow(app, mainWindow, (window, input) => {
      window.webContents.send(input.channel, {
        id: `surface-selector-${input.surface}`, sessionId: input.sessionId, category: "tool", kind: "tool",
        toolName: input.surface === "browser" ? "browser_click" : "terminal_run",
        toolCategory: "write", source: "builtin", trustOrigin: "user-keyboard",
        userOwnedSurface: input.surface,
        args: input.surface === "browser" ? { tabId: "tab-2", ref: "e1" } : { command: "printf 'ready\\n'" },
        reason: "Choose how agent actions use this surface during the conversation.",
        createdAt: Date.now(), requireExplicit: true,
      });
    }, { surface, sessionId, channel: CHANNELS.approval.request });
    const card = mainWindow.getByTestId("user-owned-surface-card");
    await expect(card).toBeVisible();
    if (surface === "host-terminal") {
      // The command is on the card before the details are opened, inside the card's box and above the choices.
      await expect(card.getByTestId("user-owned-surface-review-details")).not.toHaveAttribute("open", "");
      const command = card.getByTestId("user-owned-surface-command");
      await expect(command).toBeVisible();
      await expect(command).toHaveText("printf 'ready\\n'");
      const geometry = await card.evaluate((element) => {
        const box = (testId: string) => {
          const found = element.querySelector(`[data-testid="${testId}"]`);
          if (!found) throw new Error(`the card has no ${testId}`);
          return found.getBoundingClientRect();
        };
        const cardBox = element.getBoundingClientRect();
        const commandBox = box("user-owned-surface-command");
        return { inside: commandBox.top >= cardBox.top && commandBox.bottom <= cardBox.bottom && commandBox.height > 0, aboveChoices: commandBox.bottom <= box("user-owned-surface-choice-form").top,
          confirmInside: box("user-owned-surface-confirm").bottom <= cardBox.bottom };
      });
      expect(geometry).toEqual({ inside: true, aboveChoices: true, confirmInside: true });
    } else {
      await expect(card.getByTestId("user-owned-surface-command-block")).toHaveCount(0);
    }
    await card.getByTestId("user-owned-surface-review-details").locator("summary").click();
    await expect(card.getByTestId("user-owned-surface-details-content")).toContainText(/browser and host terminal|브라우저와 호스트 터미널/);
    await expect(card.getByTestId("user-owned-surface-ask")).toBeChecked();
    await card.getByTestId("user-owned-surface-allow").check();
    await expect(card.getByTestId("user-owned-surface-allow")).toBeChecked();
    await card.getByTestId("user-owned-surface-auto").check();
    await expect(card.getByTestId("user-owned-surface-auto")).toBeChecked();
    await card.getByTestId("user-owned-surface-ask").check();
    await expect(card.getByTestId("user-owned-surface-confirm")).toBeVisible();
    await expect(card.getByTestId("user-owned-surface-dismiss")).toBeVisible();
    const screenshot = testInfo.outputPath(`${surface}-session-choice.png`);
    await mainWindow.screenshot({ path: screenshot });
    await testInfo.attach(`${surface}-session-choice`, { path: screenshot, contentType: "image/png" });
  });
}
