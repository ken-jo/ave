import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ElectronApplication, Page } from "playwright";
import { test, expect } from "./fixtures.js";
import { openInlineSettings } from "./inline-settings.js";
import { captureApprovalWorkingDirectory } from "../../../src/permissions/user-approval-store.js";
import { TEST_IDS } from "../../../src/shared/test-ids.js";

test.use({ seedViewFixturePlugin: false });

async function showShellRequest(app: ElectronApplication, page: Page, persistentAllowed: boolean) {
  const sessionId = await page.evaluate(async () => {
    const listed = await window.aveApi.chatSessions({ kind: "main" });
    if (!listed.current) throw new Error("Current conversation is unavailable");
    return listed.current;
  });
  await app.evaluate(({ BrowserWindow }, input) => {
    const window = BrowserWindow.getAllWindows().find((candidate) => candidate.isVisible());
    if (!window) throw new Error("Main window is unavailable");
    window.webContents.send("ave:approval:request", {
      id: `shell-rule-${input.persistentAllowed ? "ordinary" : "floor"}`,
      sessionId: input.sessionId,
      category: "tool",
      kind: "tool",
      toolName: "bash",
      toolCategory: "shell",
      source: "builtin",
      args: { command: input.persistentAllowed ? "npm test" : "cat ~/.aws/credentials" },
      reason: input.persistentAllowed ? "Command needs approval" : "Credential path requires a one-time decision",
      ruleVerdict: { level: input.persistentAllowed ? "medium" : "high", reason: "Host classification" },
      createdAt: Date.now(),
      requireExplicit: !input.persistentAllowed,
      persistentAllowAllowed: input.persistentAllowed,
      allowedChoices: input.persistentAllowed
        ? ["allow-once", "allow-always", "deny-once", "deny-always"]
        : ["allow-once", "deny-once"],
      shellRule: {
        dialect: "bash",
        exactRule: input.persistentAllowed ? "Bash(npm test)" : null,
        denyRule: "Bash(npm test)",
        denyAllowed: true,
        projectCwd: "/workspace/project",
        projectRoot: "/workspace/project",
        sessionAllowed: input.persistentAllowed,
        persistentAllowed: input.persistentAllowed,
      },
    });
  }, { sessionId, persistentAllowed });
}

for (const locale of ["en", "ko"] as const) {
  test.describe(`Shell permission rules (${locale})`, () => {
    test.use({ seedLocale: locale });

    // Owner 2026-10-25 (unified approval card): Deny ▾ | Allow for session ▾ | Allow once; a selected choice shows the exact rule it saves and Edit rule.
    test("shows the shared decision row with the exact rule and keeps credential requests one-time", async ({ app, mainWindow }, testInfo) => {
      await showShellRequest(app, mainWindow, true);
      const dock = mainWindow.getByTestId(TEST_IDS.approvalDock).first();
      await expect(dock.getByTestId("approval-shell-outside-sandbox")).toContainText(locale === "ko" ? "샌드박스 밖에서 실행" : "outside the sandbox");
      for (const testId of [TEST_IDS.denyButton, TEST_IDS.approveButton, TEST_IDS.allowSessionButton, "approval-deny-menu", "approval-allow-menu"]) {
        await expect(dock.getByTestId(testId)).toBeEnabled();
      }
      await dock.getByTestId("approval-allow-menu").click();
      await mainWindow.getByTestId("approval-choice-allow-project").click();
      await expect(dock.getByTestId("approval-rule-pattern")).toHaveText("Bash(npm test)");
      await expect(dock.getByTestId("approval-edit-rule")).toBeVisible();
      await mainWindow.screenshot({ path: testInfo.outputPath(`shell-rule-${locale}.png`) });

      await dock.getByTestId(TEST_IDS.denyButton).click();
      await showShellRequest(app, mainWindow, false);
      await expect(dock.getByTestId(TEST_IDS.allowSessionButton)).toBeDisabled();
      await dock.getByTestId("approval-allow-menu").click();
      for (const choice of ["allow-session", "allow-project", "allow-everywhere"]) {
        await expect(mainWindow.getByTestId(`approval-choice-${choice}`)).toHaveAttribute("data-disabled", "");
      }
      await mainWindow.keyboard.press("Escape");
      await mainWindow.screenshot({ path: testInfo.outputPath(`credential-floor-${locale}.png`) });
    });
  });
}

test("Settings loads and revokes a project rule through the real host bridge", async ({ app, mainWindow, userDataDir, aveHome }, testInfo) => {
  const project = join(userDataDir, "rules-project");
  mkdirSync(project, { recursive: true });
  const captured = captureApprovalWorkingDirectory(project);
  const rulesDirectory = join(aveHome, "permissions", "project-rules");
  mkdirSync(rulesDirectory, { recursive: true, mode: 0o700 });
  const file = join(rulesDirectory, `${captured.identity}.json`);
  writeFileSync(file, JSON.stringify({
    version: 1,
    projectRoot: captured.path,
    rules: [{ pattern: "Bash(npm run *)", action: "allow" }, { pattern: "Bash(npm test *)", action: "allow" }],
    updatedAt: new Date().toISOString(),
  }), { mode: 0o600 });

  const settings = await openInlineSettings(app, mainWindow, "permissions");
  const table = settings.getByTestId("permissions-rules-table");
  const row = table.locator('tr[data-rule-store="scoped"]').filter({ hasText: "Bash(npm test *)" });
  const inert = table.locator('tr[data-rule-store="scoped"]').filter({ hasText: "Bash(npm run *)" });
  await expect(inert.getByTestId("permissions-rule-invalid")).toContainText(/Not in force|적용되지 않음/);
  await inert.scrollIntoViewIfNeeded();
  await mainWindow.screenshot({ path: testInfo.outputPath("inert-project-rule.png") });
  await inert.getByRole("button").click();
  await expect(inert).toHaveCount(0);
  expect(JSON.parse(readFileSync(file, "utf8")).rules).toEqual([{ pattern: "Bash(npm test *)", action: "allow" }]);
  await expect(row).toBeVisible();
  await expect(row.getByTestId("permissions-shell-outside-sandbox")).toContainText(/outside the sandbox|샌드박스 밖 실행/);
  await expect(row).toContainText(captured.path);
  await row.scrollIntoViewIfNeeded();
  await expect(row).toBeInViewport();
  await mainWindow.screenshot({ path: testInfo.outputPath("project-rule-settings.png") });
  await row.getByRole("button").click();
  await expect(row).toHaveCount(0);
  expect(JSON.parse(readFileSync(file, "utf8")).rules).toEqual([]);
});
