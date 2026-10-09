import type { Page } from "playwright";
import type { TestT } from "./i18n.js";
import { test, expect } from "./fixtures.js";
import { openInlineSettings, closeInlineSettings } from "./inline-settings.js";
import type { AveApi } from "../../../src/ui/renderer/types.js";

test.use({ seedViewFixturePlugin: false, seedAlertPlugin: true, seedPermissionMode: "default" });

async function raiseFixtureAlert(page: Page, t: TestT, key: string) {
  let settled = false;
  const pending = page.evaluate((key) => (window as unknown as { aveApi: AveApi }).aveApi.callPluginMethod("alert_fixture_raise", { key }), key)
    .then((value) => { settled = true; return { value }; }, (error: unknown) => { settled = true; return { error }; });
  const panel = page.getByTestId("tool-approval-panel");
  let previousId: string | null = null;
  for (const scope of [null, "raiseAlert"]) {
    await expect.poll(async () => settled || (await panel.isVisible() && await panel.getAttribute("data-approval-request-id") !== previousId)).toBe(true);
    expect(settled, "Invocation completed before its expected approval").toBe(false);
    await expect(panel).toHaveAttribute("data-approval-tool-name", "alert_fixture_raise");
    const scopeLabel = panel.getByText(t("toolApprovalDialog.approvalScopePrefix") + ":", { exact: false });
    if (scope) await expect(scopeLabel).toHaveText(t("toolApprovalDialog.approvalScopePrefix") + ": " + scope);
    else await expect(scopeLabel).toHaveCount(0);
    previousId = await panel.getAttribute("data-approval-request-id");
    console.log("[alert-approval]", JSON.stringify({ key, scope: scope ?? "tool-call", requestId: previousId }));
    await panel.getByRole("button", { name: t("toolApprovalDialog.allowOnce"), exact: true }).click();
  }
  await expect.poll(async () => settled || (await panel.isVisible() && await panel.getAttribute("data-approval-request-id") !== previousId)).toBe(true);
  expect(settled, "Unexpected additional approval after the two named requests").toBe(true);
  const result = await pending;
  if ("error" in result) throw result.error;
  return result.value;
}

test("alert choices control declared delivery and stay inside plugin Settings", async ({ app, mainWindow, t }, testInfo) => {
  test.setTimeout(120_000);
  const rows = () => mainWindow.evaluate(() => (window as unknown as { aveApi: AveApi }).aveApi.alerts!.listKinds());
  await expect.poll(async () => (await rows()).some((row) => row.kindKey === "alert-fixture:reply")).toBe(true);
  expect((await rows()).find((row) => row.kindKey === "alert-fixture:reply")!.choice).toMatchObject({ enabled: false, seenByUser: false });
  await openInlineSettings(app, mainWindow, "plugin-config");
  const section = mainWindow.getByTestId("plugin-alerts:alert-fixture");
  await section.scrollIntoViewIfNeeded();
  await expect(section).toBeVisible();
  expect(await section.evaluate((element) => element.closest('[data-settings-section]')?.getAttribute('data-settings-section'))).toBe("plugin-config-installed");
  const enabled = section.getByRole("switch", { name: t("alerts.enabledLabel", { label: "Messages needing your reply and review" }) });
  await expect(enabled).not.toBeChecked();
  await expect(enabled).toBeEnabled();
  await enabled.click();
  await expect(enabled).toBeChecked();
  await section.screenshot({ path: testInfo.outputPath("alerts-settings.png") });
  await closeInlineSettings(app, mainWindow);
  const raise = (key: string) => raiseFixtureAlert(mainWindow, t, key);
  const accepted = await raise("fixture-one") as { status: string; alertId: string };
  expect(accepted.status).toBe("raised");
  expect(accepted).toMatchObject({ delivered: { card: true, osNotification: false, toast: false } });
  const audit = await mainWindow.evaluate((alertId) => (window as unknown as { aveApi: AveApi }).aveApi.audit.search({ textSearch: alertId }), accepted.alertId) as { entries: Array<{ input: string }> };
  const raisedAudit = audit.entries.find((entry) => entry.input.includes("alert.raised"));
  expect(raisedAudit?.input).toContain(accepted.alertId);
  expect(raisedAudit?.input).not.toContain("Quarterly review");
  expect(raisedAudit?.input).not.toContain("fixture-message-42");
  expect(raisedAudit?.input).not.toContain("fixture-one");
  const card = mainWindow.getByTestId("overlay-card-region");
  await expect(card).toBeVisible();
  await expect(card.getByTestId("overlay-card-summary")).toContainText("Quarterly review");
  await expect(card).not.toContainText("fixture-message-42");
  const open = await mainWindow.evaluate(() => (window as unknown as { aveApi: AveApi }).aveApi.alerts!.listOpen());
  expect(open).toHaveLength(1);
  expect(open[0]!.pendingPrompt).toContain('source="overlay:alert-fixture--reply"');
  expect(open[0]!.pendingPrompt).toContain("<untrusted-messageId>fixture-message-42</untrusted-messageId>");
  expect(await raise("fixture-one")).toMatchObject({ status: "refreshed", alertId: accepted.alertId });
  await expect(mainWindow.getByTestId("overlay-card-primary-action")).toHaveCount(1);
  await mainWindow.getByTestId("overlay-card-primary-action").click();
  await expect(card).not.toBeVisible();
  await expect(mainWindow.getByText("overlay:alert-fixture--reply", { exact: true })).toBeVisible();
  const cancel = mainWindow.getByRole("button", { name: t("bottomActionRow.cancelButton"), exact: true });
  if (await cancel.isVisible()) await cancel.click();
  await expect(cancel).not.toBeVisible();
  expect(await raise("fixture-one")).toMatchObject({ status: "closed" });
  await openInlineSettings(app, mainWindow, "plugin-config");
  await section.scrollIntoViewIfNeeded(); await enabled.click(); await expect(enabled).not.toBeChecked();
  await closeInlineSettings(app, mainWindow);
  expect(await raise("fixture-disabled")).toMatchObject({ status: "disabled_by_user" });
  await expect(card).not.toBeVisible();
});

test("OS switches persist independently and dismissal closes the alert identity", async ({ app, mainWindow, t }) => {
  await openInlineSettings(app, mainWindow, "plugin-config");
  const section = mainWindow.getByTestId("plugin-alerts:alert-fixture");
  await section.scrollIntoViewIfNeeded();
  const enabled = section.getByRole("switch", { name: t("alerts.enabledLabel", { label: "Messages needing your reply and review" }) });
  await expect(enabled).toBeEnabled(); await enabled.click(); await expect(enabled).toBeChecked();
  const os = section.getByRole("switch", { name: t("alerts.osLabel", { label: "Messages needing your reply and review" }) });
  await expect(os).toBeEnabled(); await os.click(); await expect(os).toBeChecked();
  const master = mainWindow.getByRole("switch", { name: t("alerts.osMaster") });
  await master.scrollIntoViewIfNeeded();
  if (await master.isChecked()) await master.click();
  await expect(master).not.toBeChecked();
  await expect(master).toBeEnabled(); await master.click(); await expect(master).toBeChecked();
  const state = await mainWindow.evaluate(() => (window as unknown as { aveApi: AveApi }).aveApi.getSettings());
  expect(state.alerts.osNotificationsEnabled).toBe(true);
  expect(state.alerts.kinds["alert-fixture:reply"]).toMatchObject({ enabled: true, osNotification: true });
  await closeInlineSettings(app, mainWindow);
  const raise = () => raiseFixtureAlert(mainWindow, t, "dismissed-fixture");
  expect(await raise()).toMatchObject({ status: "raised" });
  await mainWindow.getByTestId("routine-card-dismiss").click();
  await expect(mainWindow.getByTestId("overlay-card-region")).not.toBeVisible();
  expect(await raise()).toMatchObject({ status: "closed" });
});
