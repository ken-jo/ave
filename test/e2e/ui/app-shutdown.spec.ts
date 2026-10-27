import { test, expect } from "./fixtures.js";
import { openInlineSettings } from "./inline-settings.js";

test("quits with settings open after an external model update", async ({ app, mainWindow }) => {
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
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const result = await Promise.race([
      app.close().then(() => "closed"),
      new Promise<string>((resolve) => { timer = setTimeout(() => resolve("shutdown deadline exceeded"), 15_000); }),
    ]);
    expect(result).toBe("closed");
    expect(child.exitCode).toBe(0);
  } finally {
    if (timer) clearTimeout(timer);
    // A failed exit assertion still owns its process; do not leave it running after the test.
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
});
