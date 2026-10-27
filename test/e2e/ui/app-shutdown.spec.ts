import type { ElectronApplication } from "playwright";
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
  expectCleanShutdown(await closeAndObserve(app));
});

test.describe("forced cleanup control", () => {
  test.use({ launchEnv: { AVE_SHUTDOWN_CLEANUP_TIMEOUT_MS: "1" } });

  test("rejects a zero-code forced exit with a cleanup diagnostic", async ({ app, mainWindow }) => {
    await openInlineSettings(app, mainWindow, "llm");
    const result = await closeAndObserve(app);
    expect(result.exitCode).toBe(0);
    expect(result.output).toMatch(/shutdown cleanup timed out/);
    expect(() => expectCleanShutdown(result)).toThrow(/shutdown cleanup/);
  });
});

function expectCleanShutdown(result: Awaited<ReturnType<typeof closeAndObserve>>): void {
  expect(result.completion, result.output).toBe("closed");
  expect(result.exitCode, result.output).toBe(0);
  expect(result.output).not.toMatch(/shutdown cleanup (?:timed out|failed)/);
}

async function closeAndObserve(app: ElectronApplication) {
  const child = app.process();
  let output = "";
  const capture = (chunk: Buffer): void => { output += chunk.toString(); };
  child.stdout?.on("data", capture);
  child.stderr?.on("data", capture);
  // 'close' follows 'exit' and drains both pipes, including the final error diagnostic.
  const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
  const startedAt = Date.now();
  let exitedAfterMs: number | undefined;
  child.once("exit", () => { exitedAfterMs = Date.now() - startedAt; });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const completion = await Promise.race([
      app.close().then(async () => { await closed; return "closed"; }),
      new Promise<string>((resolve) => { timer = setTimeout(() => resolve("shutdown deadline exceeded"), TOOL_TIMEOUT_POLICY.shutdownCleanupMs + 5_000); }),
    ]);
    console.log("shutdown completion", { exitedAfterMs, driverClosedAfterMs: Date.now() - startedAt, exitCode: child.exitCode, output });
    return { completion, exitCode: child.exitCode, output };
  } finally {
    if (timer) clearTimeout(timer);
    child.stdout?.off("data", capture);
    child.stderr?.off("data", capture);
    // A failed exit assertion still owns its process; do not leave it running after the test.
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
}
