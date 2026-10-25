import type { ElectronApplication, Page } from "playwright";
import { test, expect } from "./fixtures.js";
import { makeTestT } from "./i18n.js";
import { TEST_IDS } from "../../../src/shared/test-ids.js";

test.use({ seedViewFixturePlugin: false });

async function showDomainRequest(app: ElectronApplication, page: Page) {
  const sessionId = await page.evaluate(async () => {
    const sessions = await window.aveApi.chatSessions({ kind: "main" });
    if (!sessions.current) throw new Error("Current conversation is unavailable");
    return sessions.current;
  });
  await app.evaluate(({ BrowserWindow }, sessionId) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => candidate.isVisible());
    if (!window) throw new Error("Main window is unavailable");
    window.webContents.send("ave:approval:request", {
      id: "sandbox-domain-request", sessionId, category: "tool", kind: "egress-host",
      toolName: "bash", toolCategory: "network", source: "builtin",
      args: { host: "downloads.example.com", port: 443 },
      reason: "A sandboxed command wants to connect to downloads.example.com:443.",
      createdAt: Date.now(), requireExplicit: true,
      allowedChoices: ["allow-once", "deny-once"],
      egressHost: { host: "downloads.example.com", port: 443, network: "public", scopes: ["once", "session", "project", "always"] },
    });
  }, sessionId);
}

for (const locale of ["en", "ko"] as const) {
  test.describe(`Sandbox domain approval (${locale})`, () => {
    test.use({ seedLocale: locale });

    test("offers domain choices on the existing dock", async ({ app, mainWindow }, testInfo) => {
      const t = makeTestT(locale);
      await showDomainRequest(app, mainWindow);
      const dock = mainWindow.getByTestId(TEST_IDS.approvalDock).first();
      await expect(dock).toBeVisible();
      await expect(dock).toContainText(t("egressApprovalCard.title"));
      await expect(dock.getByTestId("egress-approval-target")).toHaveText("downloads.example.com:443");
      await expect(dock.getByTestId("egress-approval-allow-once")).toHaveText(t("egressApprovalCard.allowOnce"));
      await expect(dock.getByTestId("egress-approval-allow-session")).toHaveText(t("egressApprovalCard.allowSession"));
      await expect(dock.getByTestId("egress-approval-allow-project")).toHaveText(t("egressApprovalCard.allowProject"));
      await expect(dock.getByTestId("egress-approval-allow-always")).toHaveText(t("egressApprovalCard.allowAlways"));
      await expect(dock.getByTestId("egress-approval-deny")).toBeFocused();
      await expect(dock.getByTestId("egress-approval-card").locator("button")).toHaveCount(5);
      await expect(dock.locator('input, textarea, [contenteditable="true"]')).toHaveCount(0);
      await mainWindow.screenshot({ path: testInfo.outputPath(`domain-approval-${locale}.png`) });
      await dock.getByTestId("egress-approval-deny").click();
      await expect(mainWindow.getByTestId("egress-approval-card")).toHaveCount(0);
    });
  });
}
