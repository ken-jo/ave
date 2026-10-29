import { test, expect } from "@playwright/test";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildE2eBaseSettings, buildLlmSettings, builtMainExists, launchSeededElectron, teardownSeededElectron } from "./seeded-electron.js";
import { TEST_IDS } from "../../../src/shared/test-ids.js";
import type { AgentObservationEvent } from "../../../src/shared/agent-observation.js";

// The host executes a real command; the loopback endpoint only supplies its model tool request.
for (const locale of ["en", "ko"] as const) {
test(`agent shell output streams locally while user terminal commands stay outside observation [${locale}]`, async () => {
  test.setTimeout(180_000);
  expect(builtMainExists()).toBe(true);
  mkdirSync(join(process.cwd(), ".cache"), { recursive: true });
  const directory = mkdtempSync(join(process.cwd(), ".cache", "agent-terminal-observation-"));
  const model = "terminal-observation-model";
  const shellCommand = process.platform === "win32"
    ? "Write-Output 'agent first line'; Start-Sleep -Seconds 8; Write-Output 'agent final line'; exit 7"
    : "printf 'agent first line\\n'; sleep 8; printf 'agent final line\\n'; exit 7";
  let modelCalls = 0;
  const appErrors: string[] = [];
  const send = (response: ServerResponse, delta: Record<string, unknown>, finish: string | null) => {
    response.write(`data: ${JSON.stringify({ id: "terminal-observation", object: "chat.completion.chunk", created: 0, model,
      choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  };
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: model, object: "model" }] }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
    for await (const _chunk of request) { /* Drain the model request before replying. */ }
    modelCalls += 1;
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    if (modelCalls === 1) {
      send(response, { role: "assistant", tool_calls: [{ index: 0, id: "agent-terminal-command", type: "function", function: {
        name: process.platform === "win32" ? "powershell" : "bash", arguments: JSON.stringify({ command: shellCommand, cwd: directory }),
      } }] }, null);
      send(response, {}, "tool_calls");
    } else {
      send(response, { role: "assistant", content: "The observed command exited with code 7." }, null);
      send(response, {}, "stop");
    }
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const settings = buildLlmSettings("openai-compatible", model);
  settings.appearance = buildE2eBaseSettings(true, locale).appearance;
  (settings.llm as { vendors: Record<string, { baseUrl?: string }> }).vendors["openai-compatible"].baseUrl =
    `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  settings.features = { ...(settings.features as Record<string, unknown>), osToolSandbox: true };
  let ctx: Awaited<ReturnType<typeof launchSeededElectron>> | undefined;
  try {
    ctx = await launchSeededElectron({ sessionTitle: "Agent terminal activity", settings, historyRows: [] });
    ctx.page.on("pageerror", (error) => appErrors.push(error.message));
    ctx.page.on("crash", () => appErrors.push("Renderer process crashed"));
    writeFileSync(join(ctx.aveHome, "settings.json"), JSON.stringify({ permissions: { additionalDirectories: [directory],
      reviewer: { interactive: { autoApprove: "off" } } } }));
    await ctx.page.setViewportSize({ width: 1280, height: 860 });
    await ctx.page.getByTestId(TEST_IDS.panePanelToggle).click();
    await expect(ctx.page.getByTestId(TEST_IDS.chatSidePanel)).toBeVisible();
    await ctx.page.getByTestId("chat-side-panel-add-tab").click();
    await ctx.page.getByTestId("chat-side-panel-launcher-menu-terminal").click();
    await expect(ctx.page.getByTestId("terminal-host-badge")).toHaveText(locale === "en" ? "My terminal (host) · No agent access" : "내 터미널 (호스트) · 에이전트 접근 없음");
    const hostScreenshot = test.info().outputPath(`host-terminal-${locale}.png`);
    await ctx.page.screenshot({ path: hostScreenshot });
    await test.info().attach(`host-terminal-${locale}`, { path: hostScreenshot, contentType: "image/png" });
    await ctx.page.evaluate(async () => {
      await window.aveApi.setApiKey("openai-compatible", "sk-e2e-loopback-terminal");
      const mode = await window.ave.permission.setMode("strict");
      if (!mode.ok) throw new Error("Could not select strict tool approval");
      const state = window as unknown as { terminalObservationEvents: AgentObservationEvent[]; userTerminalOutput: string };
      state.terminalObservationEvents = [];
      state.userTerminalOutput = "";
      window.ave.preview.onAgentObservation((events) => state.terminalObservationEvents.push(...events));
      const terminal = window.aveApi.terminal;
      if (!terminal) throw new Error("Terminal API is unavailable");
      terminal.onData((event) => { if (event.tabId === "terminal:aabbccdd-1" && event.lane === "manual") state.userTerminalOutput += event.chunk; });
    });
    const manual = await ctx.page.evaluate(async (cwd) => {
      const terminal = window.aveApi.terminal;
      if (!terminal) throw new Error("Terminal API is unavailable");
      const spawned = await terminal.spawn({ tabId: "terminal:aabbccdd-1", lane: "manual", cwd });
      if (!spawned.ok) throw new Error(`User terminal did not start: ${spawned.reason}`);
      const typed = await terminal.input(spawned.session, "echo user-only-terminal-marker\r");
      if (!typed.ok) throw new Error(`User terminal input failed: ${typed.error}`);
      return spawned.session;
    }, directory);
    await expect.poll(() => ctx!.page.evaluate(() =>
      (window as unknown as { userTerminalOutput: string }).userTerminalOutput)).toContain("user-only-terminal-marker");
    await expect(ctx.page.getByTestId("terminal-observation-live-strip")).toHaveCount(0);
    expect(await ctx.page.evaluate(() => (window as unknown as { terminalObservationEvents: AgentObservationEvent[] }).terminalObservationEvents
      .filter((event) => event.source === "terminal" && event.kind === "snapshot").some((event) => event.after.commands.length > 0))).toBe(false);
    await ctx.page.evaluate(async () => {
      const terminal = window.aveApi.terminal;
      if (!terminal) throw new Error("Terminal API is unavailable");
      const killed = await terminal.kill("terminal:aabbccdd-1");
      if (!killed.ok) throw new Error(`User terminal close failed: ${killed.error}`);
    });
    expect(manual.lane).toBe("manual");
    const composer = ctx.page.locator('[data-composer-surface="main"] [data-testid="composer-textarea"]');
    await composer.fill("Run the terminal observation check.");
    await composer.press("Enter");
    const approval = ctx.page.getByTestId(TEST_IDS.approvalDock).first();
    await expect(approval.getByTestId(TEST_IDS.approveButton)).toBeVisible({ timeout: 20_000 });
    await approval.getByTestId(TEST_IDS.approveButton).click();
    const transcript = ctx.page.getByTestId("chat-transcript-log");
    await expect(transcript.getByTestId("terminal-observation-status")).toHaveText(locale === "en" ? "Agent running" : "에이전트 실행 중", { timeout: 30_000 });
    const executionEvidence = await ctx.page.evaluate(async () => {
      const state = window as unknown as { terminalObservationEvents: AgentObservationEvent[] };
      const observed = state.terminalObservationEvents.filter((event) => event.source === "terminal" && event.kind === "snapshot")
        .flatMap((event) => event.after.commands).findLast((command) => command.toolUseId === "agent-terminal-command");
      if (!observed) throw new Error("Missing authenticated command observation");
      const capability = await window.ave.permission.sandboxCapability();
      return { observedSandbox: observed.sandbox, nativeCapability: {
        platform: capability.platform, enabled: capability.enabled, potentialKind: capability.kind,
        runtimeAvailable: capability.runtime?.available ?? false, runtimeKind: capability.runtime?.kind ?? "none",
        shell: capability.shell, confines: capability.confines,
      } };
    });
    if (executionEvidence.observedSandbox.mode === "unconfined") {
      await expect(transcript.getByTestId("terminal-approved-host-identity")).toHaveText(locale === "en" ? "Agent (approved host command)" : "에이전트 (승인된 호스트 명령)");
      await expect(transcript.getByTestId("terminal-isolated-identity")).toHaveCount(0);
    } else {
      expect(["isolated", "disposable"]).toContain(executionEvidence.observedSandbox.mode);
      await expect(transcript.getByTestId("terminal-isolated-identity")).toHaveText(locale === "en" ? "Agent (isolated)" : "에이전트 (격리)");
      await expect(transcript.getByTestId("terminal-approved-host-identity")).toHaveCount(0);
    }
    const executionEvidencePath = test.info().outputPath(`shell-execution-domain-${locale}.json`);
    writeFileSync(executionEvidencePath, JSON.stringify(executionEvidence, null, 2));
    await test.info().attach("shell-execution-domain", { path: executionEvidencePath, contentType: "application/json" });
    await expect(ctx.page.getByTestId(TEST_IDS.chatSidePanel).getByTestId("terminal-observation-content")).toHaveCount(0);
    const row = ctx.page.getByTestId("terminal-observation-command-row").first();
    await row.locator("summary").click();
    await expect(row.getByTestId("terminal-observation-output")).toContainText("agent first line", { timeout: 5_000 });
    await expect(ctx.page.getByTestId("terminal-observation-status")).toHaveText(locale === "en" ? "Agent running" : "에이전트 실행 중");
    const runningScreenshot = test.info().outputPath(`agent-terminal-running-${locale}.png`);
    await ctx.page.screenshot({ path: runningScreenshot });
    await test.info().attach("agent-terminal-running", { path: runningScreenshot, contentType: "image/png" });
    await expect(ctx.page.getByTestId("terminal-observation-status")).toHaveText(locale === "en" ? "Agent execution finished" : "에이전트 실행 완료", { timeout: 30_000 });
    await expect(row.getByTestId("terminal-observation-output")).toContainText("agent final line");
    await expect(row).toContainText(locale === "en" ? "Exit 7" : "종료 코드 7");
    await expect(ctx.page.getByTestId("terminal-observation-command-row")).toHaveCount(1);
    await expect(ctx.page.getByTestId("terminal-observation-content")).not.toContainText("user-only-terminal-marker");
    await expect(ctx.page.getByTestId("terminal-observation-content").locator("input, textarea, button")).toHaveCount(0);
    const events = await ctx.page.evaluate(() =>
      (window as unknown as { terminalObservationEvents: AgentObservationEvent[] }).terminalObservationEvents);
    const terminal = events.filter((event) => event.source === "terminal");
    expect(terminal.every((event) => event.actor === "agent")).toBe(true);
    expect(terminal.some((event) => event.kind === "snapshot" && event.after.commands.some((command) =>
      command.status === "running" && command.outputTail.includes("agent first line")))).toBe(true);
    expect(terminal.some((event) => event.kind === "snapshot" && event.after.commands.some((command) =>
      command.status === "failed" && command.exitCode === 7 && command.durationMs >= 8_000))).toBe(true);
    expect(JSON.stringify(terminal)).not.toContain("user-only-terminal-marker");
    const evidence = test.info().outputPath("agent-terminal-events.json");
    writeFileSync(evidence, JSON.stringify(terminal, null, 2));
    await test.info().attach("agent-terminal-events", { path: evidence, contentType: "application/json" });
    const finalScreenshot = test.info().outputPath(`agent-terminal-completed-${locale}.png`);
    await ctx.page.screenshot({ path: finalScreenshot });
    await test.info().attach("agent-terminal-completed", { path: finalScreenshot, contentType: "image/png" });
    expect(appErrors).toEqual([]);
  } finally {
    if (ctx) await teardownSeededElectron(ctx, { terminate: true });
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
}
