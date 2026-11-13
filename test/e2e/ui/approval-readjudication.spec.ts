import type { ElectronApplication, Page } from "playwright";
import { test, expect } from "./fixtures.js";
import { setWindowSize } from "./seeded-electron.js";
import { TEST_IDS } from "../../../src/shared/test-ids.js";

test.use({ seedViewFixturePlugin: false });

async function showRequest(app: ElectronApplication, page: Page, hostEvidence: boolean, id: string): Promise<void> {
  const sessionId = await page.evaluate(async () => {
    const result = await window.aveApi.chatSessions({ kind: "main" });
    if (!result.current) throw new Error("Current conversation is unavailable");
    return result.current;
  });
  await app.evaluate(({ BaseWindow, webContents }, input) => {
    const target = BaseWindow.getAllWindows().filter((candidate) => !candidate.isDestroyed())
      .sort((a, b) => b.getSize()[0] * b.getSize()[1] - a.getSize()[0] * a.getSize()[1])[0];
    if (!target) throw new Error("Main window is unavailable");
    const chrome = webContents.getAllWebContents().find((contents) => contents === Reflect.get(target, "webContents"));
    if (!chrome || chrome.isDestroyed()) throw new Error("Main window UI is unavailable");
    const evidence = {
      pluginId: "fixture-plugin", artifactSha256: "a".repeat(64), signerKeyId: "trusted-production",
      staticReason: "write-path-not-declared",
    };
    chrome.send("ave:approval:request", {
      id: input.id, sessionId: input.sessionId, category: "tool", kind: "tool",
      toolName: "fixture_write", toolCategory: "write", source: "plugin", sourcePluginId: evidence.pluginId,
      trustOrigin: "user-keyboard", args: input.hostEvidence ? { operation: "save" } : { operation: "save", readjudication: evidence },
      reason: "write path not declared", ruleVerdict: { level: "high", reason: "write path not declared" },
      persistentAllowAllowed: true, exactRecordAllowed: true, persistentApprovalCwd: "/workspace/project",
      requireExplicit: true, createdAt: Date.now(),
      ...(input.hostEvidence ? { readjudication: evidence } : {}),
    });
  }, { sessionId, hostEvidence, id });
}

for (const locale of ["en", "ko"] as const) {
  test.describe(`Human evidence re-adjudication (${locale})`, () => {
    test.use({ seedLocale: locale });

    test("offers explicit opt-in and exact scope without accepting plugin evidence", async ({ app, mainWindow, t }, testInfo) => {
      await setWindowSize(app, 460, 841);
      await showRequest(app, mainWindow, true, `eligible-${locale}`);
      const panel = mainWindow.getByTestId("tool-approval-panel");
      await expect(panel).toHaveAttribute("data-approval-request-id", `eligible-${locale}`);
      const optIn = panel.getByTestId("approval-readjudication-opt-in");
      await expect(optIn).not.toBeChecked();
      await expect(panel.getByText(t("toolApprovalDialog.readjudicationLabel"), { exact: true })).toBeVisible();
      await expect(panel.getByTestId("approval-readjudication")).toContainText(t("toolApprovalDialog.readjudicationNote"));
      await expect(panel.getByTestId("approval-readjudication-evidence")).toContainText("trusted-production");
      await optIn.click();
      await expect(optIn).toBeChecked();
      await panel.getByTestId("approval-allow-menu").click();
      await mainWindow.getByTestId("approval-choice-allow-project").click();
      await expect(panel.getByTestId(TEST_IDS.allowSessionButton)).toHaveAttribute("data-choice", "allow-project");
      const geometry = await panel.evaluate((element) => ({ client: element.clientWidth, scroll: element.scrollWidth }));
      expect(geometry.scroll).toBeLessThanOrEqual(geometry.client);
      await mainWindow.screenshot({ path: testInfo.outputPath(`readjudication-${locale}.png`) });

      await panel.getByTestId(TEST_IDS.denyButton).click();
      await expect(panel).toHaveCount(0);
      await showRequest(app, mainWindow, false, `self-report-${locale}`);
      await expect(panel).toHaveAttribute("data-approval-request-id", `self-report-${locale}`);
      await expect(panel.getByTestId("approval-readjudication-opt-in")).toHaveCount(0);
      await expect(panel.getByTestId(TEST_IDS.approveButton)).toBeEnabled();
      await expect(panel.getByTestId(TEST_IDS.denyButton)).toBeEnabled();
      await mainWindow.screenshot({ path: testInfo.outputPath(`readjudication-self-report-${locale}.png`) });
    });
  });
}
