import { test, expect } from "./fixtures.js";
import { openInlineSettings } from "./inline-settings.js";
import { TOOL_TIMEOUT_POLICY } from "../../../src/shared/tool-timeout-policy.js";

test("quits with settings open after an external model update", async ({ app, mainWindow }) => {
  test.setTimeout(TOOL_TIMEOUT_POLICY.shutdownCleanupMs + 60_000);
  await mainWindow.evaluate(async () => {
    const window = globalThis as unknown as { aveApi: { updateSettings(patch: unknown): Promise<unknown> } };
    await window.aveApi.updateSettings({ llm: { provider: "openai", vendors: { openai: { model: "gpt-6.1-sol", enableThinking: true, thinkingBudgetTokens: 64_000 } } } });
  });
  await openInlineSettings(app, mainWindow, "llm");
  await mainWindow.evaluate(async () => {
    const window = globalThis as unknown as { aveApi: { updateSettings(patch: unknown): Promise<unknown> } };
    await window.aveApi.updateSettings({ llm: { vendors: { openai: { model: "o3-mini" } } } });
  });
  const child = app.process();
  let shutdownOutput = "";
  child.stdout?.on("data", (chunk: Buffer) => { shutdownOutput += chunk.toString(); });
  const startedAt = Date.now();
  let exitedAfterMs: number | undefined;
  child.once("exit", () => { exitedAfterMs = Date.now() - startedAt; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      app.close().then(() => "closed"),
      new Promise<string>((resolve) => { timer = setTimeout(() => resolve("shutdown deadline exceeded"), TOOL_TIMEOUT_POLICY.shutdownCleanupMs + 5_000); }),
    ]);
    console.log("shutdown completion", { exitedAfterMs, driverClosedAfterMs: Date.now() - startedAt, exitCode: child.exitCode });
    expect(result, `exitCode=${child.exitCode} signal=${child.signalCode}`).toBe("closed");
    expect(child.exitCode).toBe(0);
    expect(shutdownOutput).not.toMatch(/shutdown cleanup (?:timed out|failed)/);
  } finally {
    if (timer) clearTimeout(timer);
    // A failed exit assertion still owns its process; do not leave it running after the test.
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});
