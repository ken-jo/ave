import { expect, test } from "@playwright/test";
import { launchSeededElectron, teardownSeededElectron } from "./seeded-electron.js";

test.use({ trace: "on" });

test("host reports replay in a report block and retain the conversation title", async () => {
  const ctx = await launchSeededElectron({ sessionTitle: "", historyRows: [
    { role: "user", content: "Inspect both sites" },
    { role: "assistant", content: "Starting the inspection" },
    { role: "user", content: "Host instruction: review the child report before ending the turn",
      meta: { hostInjectionId: "report-delivery", displayText: "Both pages inspected", subAgentReport: { title: "Page audit" } } },
  ] });
  try {
    const report = ctx.page.getByTestId("subagent-report-entry");
    await expect(report).toContainText("Both pages inspected");
    await expect(report).toContainText("Page audit");
    await expect(report.getByTestId("user-message-actions")).toHaveCount(0);
    await expect(ctx.page.getByText("Host instruction: review the child report before ending the turn", { exact: true })).toHaveCount(0);
    const sessions = await ctx.page.evaluate(() => window.aveApi.chatSessions());
    expect(sessions.sessions.find((session) => session.id === sessions.current)?.title).toBe("Inspect both sites");
    await test.info().attach("subagent-report.png", { body: await ctx.page.screenshot(), contentType: "image/png" });
  } finally {
    await teardownSeededElectron(ctx);
  }
});
