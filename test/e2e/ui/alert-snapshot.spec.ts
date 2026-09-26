import { expect, test } from "@playwright/test";
import { ALERTS, OVERLAY_V1 } from "../../../src/shared/ipc-channels.js";
import type { AlertCard } from "../../../src/shared/alerts-types.js";
import { buildE2eBaseSettings, launchSeededElectron, teardownSeededElectron } from "./seeded-electron.js";

test("an older alert snapshot cannot undo a live withdrawal or refresh", async ({}, testInfo) => {
  const ctx = await launchSeededElectron({ historyRows: [], settings: buildE2eBaseSettings(true, "en") });
  try {
    await ctx.app.context().tracing.start({ screenshots: true, snapshots: true });
    await ctx.app.evaluate(({ ipcMain }, channel) => {
      const state = globalThis as unknown as { resolveAlertSnapshot?: (cards: unknown[]) => void };
      ipcMain.removeHandler(channel);
      // Hold the response to exercise the supported cross-channel ordering deterministically.
      ipcMain.handle(channel, () => new Promise((resolve) => { state.resolveAlertSnapshot = resolve; }));
    }, ALERTS.listOpen);
    await ctx.page.reload();
    await expect.poll(() => ctx.app.evaluate(() =>
      typeof (globalThis as unknown as { resolveAlertSnapshot?: unknown }).resolveAlertSnapshot,
    )).toBe("function");

    const card = (id: string, title: string): AlertCard => ({
      id: `alert:${id}`,
      source: { kind: "alert", pluginId: "fixturemail", kindId: "reply", alertId: id },
      pluginDisplayName: "Fixture Mail",
      title, summary: "Old snapshot summary", pendingPrompt: "A pending alert prompt.",
      primaryActionLabel: "Review mail",
      running: false, priority: "normal", createdAt: new Date().toISOString(),
    });
    const withdrawn = { ...card("withdrawn", "Withdrawn mail"), priority: "high" as const };
    const old = card("refreshed", "Current mail");
    const refreshed = { ...old, summary: "Latest live summary" };
    const control = { ...card("control", "Snapshot control"), priority: "low" as const };
    await ctx.app.evaluate(({ BrowserWindow }, payload) => {
      const win = BrowserWindow.getAllWindows().find((window) => !window.isDestroyed() && window.isVisible());
      if (!win) throw new Error("No visible window");
      win.webContents.send(payload.channels.dismiss, payload.withdrawnId);
      win.webContents.send(payload.channels.show, payload.refreshed);
    }, { channels: OVERLAY_V1, withdrawnId: withdrawn.id, refreshed });
    // Both pushes share a transport: seeing the second also observes the dismissal.
    await expect(ctx.page.getByText(refreshed.summary, { exact: true })).toBeVisible();

    await ctx.app.evaluate((_electron, cards) => {
      const state = globalThis as unknown as { resolveAlertSnapshot?: (cards: unknown[]) => void };
      if (!state.resolveAlertSnapshot) throw new Error("No pending alert snapshot");
      state.resolveAlertSnapshot(cards);
    }, [old, withdrawn, control]);
    // The untouched control proves the snapshot was processed before assertions.
    await expect(ctx.page.getByTestId("routine-card-indicator")).toHaveText("2/2");
    await expect(ctx.page.getByText(refreshed.summary, { exact: true })).toBeVisible();
    await expect(ctx.page.getByText(withdrawn.title, { exact: true })).toHaveCount(0);
    await ctx.page.getByTestId("overlay-card-prev").click();
    await expect(ctx.page.getByText(control.title, { exact: true })).toBeVisible();
    await ctx.page.getByTestId("overlay-card-next").click();
    await expect(ctx.page.getByText(refreshed.summary, { exact: true })).toBeVisible();
    await ctx.page.screenshot({ path: testInfo.outputPath("alert-snapshot.png") });
    await ctx.app.context().tracing.stop({ path: testInfo.outputPath("alert-snapshot-trace.zip") });
  } finally {
    await teardownSeededElectron(ctx);
  }
});
