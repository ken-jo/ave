import { quitElectron } from "./seeded-electron.js";
import type { TestT } from "./i18n.js";
import { test, expect } from "./fixtures.js";
import { openInlineSettings, closeInlineSettings } from "./inline-settings.js";
import type { AveApi } from "../../../src/ui/renderer/types.js";
import { admitFixturePlugins } from "./admit-fixture-plugins.js";
import type { ElectronApplication, Page } from "playwright";
import { SUGGESTIONS_SESSION_ID } from "../../../src/shared/suggestions-session.js";
import { DEFAULT_LLM_VENDOR } from "../../../src/shared/llm-vendor-defaults.js";

// The card's action starts a turn, which needs a chosen model; built-in vendors no longer pick one.
test.use({ seedViewFixturePlugin: false, seedAlertPlugin: true, seedPermissionMode: "default",
  seedLlmVendors: { [DEFAULT_LLM_VENDOR]: { model: "gpt-5.4" } } });

async function raiseFixtureAlert(page: Page, t: TestT, key: string) {
  let settled = false;
  const pending = page.evaluate((key) => (window as unknown as { aveApi: AveApi }).aveApi.callPluginMethod("alert_fixture_raise", { key }), key)
    .then((value) => { settled = true; return { value }; }, (error: unknown) => { settled = true; return { error }; });
  const panel = page.getByTestId("tool-approval-panel");
  // Read without auto-waiting so a panel unmounted during polling cannot block the callback.
  const shownRequestId = () => panel.evaluateAll((elements) => elements[0]?.getAttribute("data-approval-request-id") ?? null);
  const newRequestShown = async (previous: string | null) => {
    const id = await shownRequestId();
    return id !== null && id !== previous;
  };
  let previousId: string | null = null;
  // The tool call, then the host-mediated raiseAlert effect. The effect card names the method in its arguments and shows
  // the exact grant identity (a payload digest, effect-enforcement.ts) as its approval scope.
  for (const effect of [null, "raiseAlert"]) {
    await expect.poll(async () => settled || await newRequestShown(previousId)).toBe(true);
    expect(settled, "Invocation completed before its expected approval").toBe(false);
    await expect(panel).toHaveAttribute("data-approval-tool-name", "alert_fixture_raise");
    const scopeLabel = panel.getByText(t("toolApprovalDialog.approvalScopePrefix") + ":", { exact: false });
    if (effect) {
      await expect(scopeLabel).toHaveText(new RegExp(`^${t("toolApprovalDialog.approvalScopePrefix")}: [a-f0-9]{64}$`, "u"));
      await expect(panel).toContainText(effect);
    } else await expect(scopeLabel).toHaveCount(0);
    previousId = await panel.getAttribute("data-approval-request-id");
    console.log("[alert-approval]", JSON.stringify({ key, request: effect ?? "tool-call", requestId: previousId }));
    await panel.getByRole("button", { name: t("toolApprovalDialog.allowOnce"), exact: true }).click();
  }
  await expect.poll(async () => settled || await newRequestShown(previousId)).toBe(true);
  expect(settled, "Unexpected additional approval after the two named requests").toBe(true);
  const result = await pending;
  if ("error" in result) throw result.error;
  return result.value;
}

// Alert cards belong to the Suggestions conversation (2009b9df6) and are drawn only where it is open; its sidebar row counts them.
async function openSuggestions(page: Page): Promise<void> {
  const row = page.getByTestId(`sidebar-session-${SUGGESTIONS_SESSION_ID}`);
  await expect(row.getByTestId(`sidebar-pending-count-${SUGGESTIONS_SESSION_ID}`)).toBeVisible();
  await row.click();
  await expect(row).toHaveAttribute("aria-current", "page");
}

// Seeded fixture files wait for the home trust review; admit them the way a user does before the plugin can load.
async function withAdmittedFixture(
  context: Parameters<typeof admitFixturePlugins>[0],
  body: (app: ElectronApplication, mainWindow: Page) => Promise<void>,
): Promise<void> {
  const { app, mainWindow } = await admitFixturePlugins(context);
  try { await body(app, mainWindow); } finally { await quitElectron(app); }
}

test("alert choices control declared delivery and stay inside plugin Settings", async ({ app: seededApp, mainWindow: seededWindow, aveHome, userDataDir, tempHome, t }, testInfo) => {
  test.setTimeout(120_000);
  await withAdmittedFixture({ app: seededApp, mainWindow: seededWindow, aveHome, userDataDir, tempHome }, async (app, mainWindow) => {
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
    await openSuggestions(mainWindow);
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
});

test("OS switches persist independently and dismissal closes the alert identity", async ({ app: seededApp, mainWindow: seededWindow, aveHome, userDataDir, tempHome, t }) => {
  await withAdmittedFixture({ app: seededApp, mainWindow: seededWindow, aveHome, userDataDir, tempHome }, async (app, mainWindow) => {
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
    await openSuggestions(mainWindow);
    await mainWindow.getByTestId("routine-card-dismiss").click();
    await expect(mainWindow.getByTestId("overlay-card-region")).not.toBeVisible();
    expect(await raise()).toMatchObject({ status: "closed" });
  });
});
