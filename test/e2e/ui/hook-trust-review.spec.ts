import fs from "node:fs";
import path from "node:path";
import { test, expect } from "./fixtures.js";
import { openInlineSettings } from "./inline-settings.js";

test("hook trust review requires the current hash and supports explicit disable", async ({ app, mainWindow, tempHome, t }, testInfo) => {
  const hooksDir = path.join(tempHome, ".config", "ave", "hooks");
  fs.mkdirSync(hooksDir, { recursive: true, mode: 0o700 });
  const hookPath = path.join(hooksDir, "pre-review.sh");
  fs.writeFileSync(hookPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });

  const page = await openInlineSettings(app, mainWindow, "permissions");
  const panel = page.getByTestId("hook-trust-review");
  const row = panel.getByTestId("hook-trust-row").filter({ hasText: "pre-review.sh" });
  await expect(row).toBeVisible();
  await expect(row.getByTestId("hook-trust-state")).toContainText(t("permissionsTab.hookStateNew"));
  await expect(row).toContainText(t("permissionsTab.hookSourceUser"));

  const shownHash = await row.getByTestId("hook-trust-hash").textContent();
  if (shownHash === null) throw new Error("Hook review must show the current hash");
  fs.appendFileSync(hookPath, "# changed after review\n");
  await row.getByTestId("hook-trust-accept").click();
  await expect(panel.getByRole("alert")).toHaveText(t("permissionsTab.hookReviewStale"));
  await expect(row.getByTestId("hook-trust-hash")).not.toHaveText(shownHash);

  await row.getByTestId("hook-trust-accept").click();
  await expect(row.getByTestId("hook-trust-state")).toContainText(t("permissionsTab.hookStateTrusted"));
  const lock = JSON.parse(fs.readFileSync(path.join(hooksDir, ".lockfile.json"), "utf8")) as {
    hooks: Array<{ fileName: string; sha256: string }>;
  };
  const trusted = lock.hooks.find((hook) => hook.fileName === "pre-review.sh");
  if (!trusted) throw new Error("Reviewed hook must be recorded in the lockfile");
  expect(trusted?.sha256).toMatch(/^[a-f0-9]{64}$/);
  await expect(row.getByTestId("hook-trust-hash")).toContainText(trusted.sha256);

  await row.getByTestId("hook-trust-disable").click();
  await expect(row.getByTestId("hook-trust-state")).toContainText(t("permissionsTab.hookStateDisabled"));
  expect(fs.existsSync(hookPath)).toBe(false);
  expect(fs.existsSync(path.join(hooksDir, ".disabled", "pre-review.sh"))).toBe(true);
  const screenshotPath = testInfo.outputPath("hook-trust-review.png");
  await panel.screenshot({ path: screenshotPath });
  await testInfo.attach("hook-trust-review", { path: screenshotPath, contentType: "image/png" });
});
