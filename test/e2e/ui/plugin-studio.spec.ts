import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test, expect } from "./fixtures.js";
import { closeInlineSettings, openInlineSettings } from "./inline-settings.js";

test("form to review to local package install", async ({ app, mainWindow, userDataDir, t }, testInfo) => {
  const mcpDir = join(userDataDir, "ave-state", "mcp");
  await mkdir(mcpDir, { recursive: true });
  await writeFile(join(mcpDir, "servers.json"), JSON.stringify({ servers: [{ id: "sample-connector", transport: "stdio",
    command: "uvx", args: ["studio-sample==1.0.0"], env: { STUDIO_SAMPLE: "visible-value" },
    auth: "api-key", apiKey: "stored-key-value", apiKeyEnv: "STUDIO_KEY" }] }));
  const page = await openInlineSettings(app, mainWindow, "marketplace");
  await page.getByTestId("git-marketplace:add-menu").click();
  await page.getByRole("menuitem", { name: t("pluginStudio.createTitle") }).click();
  await expect(page.getByTestId("plugin-studio")).toBeVisible();
  await page.getByTestId("plugin-studio:name").fill("team-kit");
  await page.getByTestId("plugin-studio:version").fill("1.0.0");
  await page.getByTestId("plugin-studio:description").fill("A team plugin");
  await page.getByTestId("plugin-studio:select:connector:sample-connector").click();
  await page.getByTestId("plugin-studio:create").click();
  await expect(page.getByTestId("plugin-studio:review")).toBeVisible();
  await expect(page.getByTestId("plugin-studio:confirm-arg:sample-connector:0")).toBeVisible();
  await page.getByTestId("plugin-studio:confirm-arg:sample-connector:0").click();
  await page.getByTestId("plugin-studio:confirm-env:sample-connector:STUDIO_SAMPLE").click();
  await page.getByTestId("plugin-studio:confirm-connector:sample-connector").click();
  await expect(page.getByTestId("plugin-studio:review")).toContainText("mcp.json");
  await expect(page.getByTestId("plugin-studio:install")).toBeDisabled();
  await page.getByText(t("pluginStudio.readConfirm")).click();
  await page.getByTestId("plugin-studio:mark-reviewed").click();
  await expect(page.getByTestId("plugin-studio:install")).toBeEnabled();
  await expect(page.getByTestId("plugin-studio:review")).toContainText("plugin.json");
  await page.screenshot({ path: testInfo.outputPath("plugin-studio-review.png") });
  await page.getByTestId("plugin-studio:install").click();
  await expect(page.getByTestId("plugin-studio:package-sheet")).toBeVisible();
  await expect(page.getByTestId("plugin-studio:package-sheet")).toContainText("A team plugin");
  await page.getByTestId("plugin-studio:install-confirm").click();
  await expect(page.getByTestId("plugin-studio:package-sheet")).toHaveCount(0);
  await expect.poll(async () => {
    const ledger = JSON.parse(await readFile(join(userDataDir, "ave-state", "packages", "ledger.json"), "utf8")) as { packages: Array<{ name: string; origin: { sourceId: string | null } }> };
    return ledger.packages.find((entry) => entry.name === "team-kit")?.origin.sourceId;
  }).toBeNull();
  const mcp = await readFile(join(userDataDir, "ave-state", "packages", "agent-plugin", "team-kit", "1.0.0", "mcp.json"), "utf8");
  expect(mcp).toContain("studio-sample==1.0.0");
  expect(mcp).toContain("visible-value");
  expect(mcp).not.toContain("stored-key-value");
  const manifest = JSON.parse(await readFile(join(userDataDir, "ave-state", "packages", "agent-plugin", "team-kit", "1.0.0", "plugin.json"), "utf8")) as {
    extensions: { "ai.agent-connector.ave": { mcpAuth: Record<string, unknown> } };
  };
  expect(manifest.extensions["ai.agent-connector.ave"].mcpAuth).toEqual({ "sample-connector": { auth: "api-key", apiKeyEnv: "STUDIO_KEY" } });
  expect(JSON.stringify(manifest)).not.toContain("stored-key-value");
  await closeInlineSettings(app, page);
});

test("imported hooks appear as review-only needs-input items", async ({ app, mainWindow, userDataDir, t }) => {
  const source = join(userDataDir, "legacy-hook-package");
  await mkdir(join(source, ".claude-plugin"), { recursive: true });
  await mkdir(join(source, "server"), { recursive: true });
  await writeFile(join(source, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "hook-review", version: "1.0.0",
    description: "A hook import", hooks: { SessionStart: [{ hooks: [{ type: "command", command: "node",
      args: ["./server/hook.js"] }] }] } }));
  await writeFile(join(source, "server", "hook.js"), "process.stdout.write('ready');\n");
  await app.evaluate(({ dialog }, path) => {
    Object.assign(dialog, { showOpenDialog: async () => ({ canceled: false, filePaths: [path] }) });
  }, source);
  const page = await openInlineSettings(app, mainWindow, "marketplace");
  await page.getByTestId("git-marketplace:add-menu").click();
  await page.getByRole("menuitem", { name: t("pluginStudio.createTitle") }).click();
  await page.getByTestId("plugin-studio:import").click();
  await expect(page.getByTestId("plugin-studio:pending-hook:0")).toContainText(t("pluginStudio.needsAdaptation"));
  await expect(page.getByTestId("plugin-studio:review")).toContainText(t("pluginStudio.needsInput"));
  await expect(page.getByTestId("plugin-studio:review")).toContainText("hooks.SessionStart[0].hooks[0]");
  await expect(page.getByTestId("plugin-studio:install")).toBeDisabled();
  await closeInlineSettings(app, page);
});
