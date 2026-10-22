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
        ? ["allow-once", "allow-always", "allow-session", "deny-once", "deny-always"]
        : ["allow-once", "deny-once"],
      shellRule: {
        suggestedPattern: input.persistentAllowed ? "Bash(npm test *)" : null,
        projectCwd: "/workspace/project",
        sessionAllowed: input.persistentAllowed,
        persistentAllowed: input.persistentAllowed,
      },
    });
  }, { sessionId, persistentAllowed });
}

for (const locale of ["en", "ko"] as const) {
  test.describe(`Shell permission rules (${locale})`, () => {
    test.use({ seedLocale: locale });

    test("shows the editable rule and keeps credential requests one-time", async ({ app, mainWindow }, testInfo) => {
      await showShellRequest(app, mainWindow, true);
      const dock = mainWindow.getByTestId(TEST_IDS.approvalDock).first();
      const pattern = dock.getByTestId("approval-shell-rule-pattern");
      await expect(pattern).toHaveValue("Bash(npm test *)");
      await expect(dock.getByTestId("approval-allow-session")).toBeEnabled();
      await expect(dock.getByTestId("approval-deny-always")).toBeEnabled();
      await dock.getByTestId("approval-shell-rule-scope").selectOption("user");
      await pattern.fill("Bash(npm test)");
      await expect(dock.getByTestId(TEST_IDS.allowAlwaysButton)).toBeEnabled();
      await mainWindow.screenshot({ path: testInfo.outputPath(`shell-rule-${locale}.png`) });
      await pattern.fill("Bash(node *)");
      await expect(dock.getByTestId(TEST_IDS.allowAlwaysButton)).toBeDisabled();
      await expect(dock.getByTestId("approval-allow-session")).toBeEnabled();

      await dock.getByTestId(TEST_IDS.denyButton).click();
      await showShellRequest(app, mainWindow, false);
      await expect(dock.getByTestId(TEST_IDS.allowAlwaysButton)).toBeDisabled();
      await expect(dock.getByTestId("approval-allow-session")).toHaveCount(0);
      await expect(dock.getByTestId("approval-shell-rule-pattern")).toHaveValue("");
      await mainWindow.screenshot({ path: testInfo.outputPath(`credential-floor-${locale}.png`) });
    });
  });
}

test("Settings loads and revokes a project rule through the real host bridge", async ({ app, mainWindow, userDataDir }, testInfo) => {
  const project = join(userDataDir, "rules-project");
  mkdirSync(project, { recursive: true });
  const captured = captureApprovalWorkingDirectory(project);
  const rulesDirectory = join(userDataDir, "ave-state", "permissions", "project-rules");
  mkdirSync(rulesDirectory, { recursive: true, mode: 0o700 });
  const file = join(rulesDirectory, `${captured.identity}.json`);
  writeFileSync(file, JSON.stringify({
    version: 1,
    projectRoot: captured.path,
    rules: [{ pattern: "Bash(npm test *)", action: "allow" }],
    updatedAt: new Date().toISOString(),
  }), { mode: 0o600 });

  const settings = await openInlineSettings(app, mainWindow, "permissions");
  const table = settings.getByTestId("permissions-rules-table");
  const row = table.locator('tr[data-rule-store="scoped"]').filter({ hasText: "Bash(npm test *)" });
  await expect(row).toBeVisible();
  await expect(row).toContainText(captured.path);
  await mainWindow.screenshot({ path: testInfo.outputPath("project-rule-settings.png") });
  await row.getByRole("button").click();
  await expect(row).toHaveCount(0);
  expect(JSON.parse(readFileSync(file, "utf8")).rules).toEqual([]);
});
