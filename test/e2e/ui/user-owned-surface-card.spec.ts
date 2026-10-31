import { test, expect } from "./fixtures.js";
import { CHANNELS } from "../../../src/contract/app-contract.js";

// These renderer fixtures verify the shared selector. Native gate and invocation suites own consent and session-state authority.
test.use({ seedViewFixturePlugin: false });

for (const surface of ["browser", "host-terminal"] as const) {
  test(`the ${surface} session card starts at ask and exposes all three choices`, async ({ app, mainWindow }, testInfo) => {
    const sessionId = await mainWindow.evaluate(async () => (await window.aveApi.chatSessions({ kind: "main" })).current);
    if (!sessionId) throw new Error("Current conversation unavailable");
    await app.evaluate(({ BrowserWindow }, input) => {
      const window = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed() && candidate.isVisible());
      if (!window) throw new Error("Visible window unavailable");
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
