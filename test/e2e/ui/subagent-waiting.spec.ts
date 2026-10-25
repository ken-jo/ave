import { test, expect } from "./fixtures.js";
import type { AgentSpawnEvent } from "../../../src/shared/subagent-events.js";
import { TEST_IDS } from "../../../src/shared/test-ids.js";


test("budget-suspended sub-agent renders waiting in the workspace rail", async ({
  app,
  mainWindow,
  t,
}) => {
  await expect(mainWindow.getByTestId(TEST_IDS.chatViewRoot)).toBeVisible();
  await mainWindow.getByTestId(TEST_IDS.panePanelToggle).click();
  const rail = mainWindow.getByTestId("chat-side-panel-motion");
  await expect(rail).toHaveCSS("opacity", "1");

  const events = [
    {
      spawnId: "spawn-budget-waiting",
      type: "start",
      taskState: "TASK_STATE_SUBMITTED",
      title: "Budget suspended agent",
      instructions: "Continue until the assigned round budget.",
    },
    {
      spawnId: "spawn-budget-waiting",
      type: "done",
      taskState: "TASK_STATE_INPUT_REQUIRED",
      status: "waiting",
      title: "Budget suspended agent",
      summary: "Partial work is ready to resume.",
      toolCallCount: 2,
      childSessionId: "child-budget-waiting",
      suspension: {
        reason: "budget",
        resumeId: "child-budget-waiting",
      },
    },
  ] satisfies Array<Omit<AgentSpawnEvent, "parentSessionId">>;
  // Frames must name this tile's conversation to pass ownership filtering.
  const parentSessionId = await mainWindow.evaluate(
    async () => (await (window as unknown as {
      aveApi: { chatSessions: () => Promise<{ current: string }> };
    }).aveApi.chatSessions()).current,
  );
  await app.evaluate(({ BrowserWindow }, injectedEvents) => {
    const win = BrowserWindow.getAllWindows().find((candidate) => !candidate.isDestroyed());
    if (!win) throw new Error("agent-spawn-e2e-window-missing");
    for (const event of injectedEvents) {
      win.webContents.send("ave:agent-spawn:event", event);
    }
  }, events.map((event) => ({ ...event, parentSessionId })));

  await expect(rail).toHaveAttribute("aria-hidden", "false");
  const row = mainWindow.getByTestId("chat-side-panel-subagent-row");
  await expect(row).toBeVisible({ timeout: 10_000 });
  await expect(row).toBeInViewport();
  await expect(row).toContainText("Budget suspended agent");
  await expect(row).toContainText(t("subAgentCard.statusWaiting"));
  await expect(row).not.toContainText(t("subAgentCard.statusDone"));
  await expect(row.getByText(t("subAgentCard.statusWaiting"))).toHaveClass(/text-warning/);
  const opacityAtCapture = await rail.evaluate((element) => getComputedStyle(element).opacity);
  expect(opacityAtCapture).toBe("1");

  await test.info().attach("subagent-budget-waiting-rail.png", {
    body: await mainWindow.screenshot(),
    contentType: "image/png",
  });
});
