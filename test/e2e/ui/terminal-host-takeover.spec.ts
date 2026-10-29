import { test, expect } from "./fixtures.js";
import type { ElectronApplication, Page } from "playwright";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAIN_ENTRY, buildE2eBaseSettings, buildE2eSecrets, buildIsolatedElectronEnv, buildLlmSettings, builtMainExists, launchElectron,
  teardownSeededElectron,
} from "./seeded-electron.js";
import { TEST_IDS } from "../../../src/shared/test-ids.js";

// A workspace terminal's own pane chat asks to run one command in that host shell. A person approves it on the card, the agent types it,
// the user takes over mid-command, and only output from the agent's period returns to the model. The loopback endpoint only supplies
// the model's tool request; the shell, PTY, approval gate and control lease are the real ones.
// Agent typing needs bracketed paste, which the Windows host shells (cmd, pwsh) lack; there the host path refuses before typing.
if (process.platform !== "win32") test("the user takes over an approved host command and only the agent's period reaches the model", async ({}, testInfo) => {
  test.setTimeout(180_000);
  expect(builtMainExists()).toBe(true);
  const root = mkdtempSync(join(tmpdir(), "ave-terminal-host-takeover-"));
  const userData = join(root, "user-data");
  const home = join(root, "home");
  const featureHome = join(home, ".ave");
  const tabId = "terminal:abcd1234-1";
  const parentId = "e2000000-bb11-4cc2-8dd3-eeeeeeeeeeee";
  const sideId = "a2000000-bb11-4cc2-8dd3-eeeeeeeeeeee";
  const model = "terminal-host-model";
  // The post-sleep line is assembled by printf so its text never appears in the command itself.
  const agentCommand = "printf 'agent-period-marker\\n'; sleep 30; printf 'agent-%s\\n' after-sleep";
  const userSentinel = "user-period-secret-sentinel";
  const toolResults: string[] = [];
  let modelCalls = 0;
  const appErrors: string[] = [];
  const send = (response: ServerResponse, delta: Record<string, unknown>, finish: string | null) => {
    response.write(`data: ${JSON.stringify({ id: "terminal-host", object: "chat.completion.chunk", created: 0, model,
      choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  };
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: model, object: "model" }] }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
    let body = "";
    for await (const chunk of request) body += String(chunk);
    const messages = (JSON.parse(body) as { messages: Array<{ role: string; content: unknown }> }).messages;
    for (const message of messages) if (message.role === "tool") toolResults.push(JSON.stringify(message.content));
    modelCalls += 1;
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    if (modelCalls === 1) {
      send(response, { role: "assistant", tool_calls: [{ index: 0, id: "host-terminal-command", type: "function", function: {
        name: "terminal_run", arguments: JSON.stringify({ command: agentCommand, waitSeconds: 60 }),
      } }] }, null);
      send(response, {}, "tool_calls");
    } else {
      send(response, { role: "assistant", content: "The user took over the terminal." }, null);
      send(response, {}, "stop");
    }
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  let app: ElectronApplication | undefined;
  let page: Page | undefined;
  try {
    mkdirSync(userData, { recursive: true });
    mkdirSync(join(featureHome, "sessions"), { recursive: true });
    mkdirSync(join(featureHome, "side-chat", "sessions"), { recursive: true });
    const settings = buildLlmSettings("openai-compatible", model);
    (settings.llm as { vendors: Record<string, { baseUrl?: string }> }).vendors["openai-compatible"].baseUrl =
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    writeFileSync(join(userData, "ave-settings.json"), JSON.stringify({
      ...settings,
      appearance: buildE2eBaseSettings(true, "en").appearance,
      system: { mainLayout: {
        version: 1, tree: { kind: "leaf", chatGroupId: "main" }, focusedId: "main",
        surfaces: { main: { kind: "terminal", tabId, ordinal: 1, cwd: null, url: null } },
        panelOpenIds: [], thumbnailOpenIds: [], sideTabs: {},
      } },
    }));
    writeFileSync(join(userData, "ave-secrets.json"), JSON.stringify(buildE2eSecrets()), { mode: 0o600 });
    writeFileSync(join(featureHome, "sessions", `${parentId}.jsonl`), `${JSON.stringify({ role: "user", content: "Parent conversation" })}\n`);
    writeFileSync(join(featureHome, "sessions", `${parentId}.meta.json`), JSON.stringify({ title: "Parent conversation" }));
    writeFileSync(join(featureHome, "sessions", ".active-session.json"), JSON.stringify({
      mainActiveMode: "resume", mainActiveSessionId: parentId, updatedAt: new Date().toISOString(),
    }));
    writeFileSync(join(featureHome, "side-chat", "sessions", `${sideId}.jsonl`), `${JSON.stringify({ role: "user", content: "Terminal conversation" })}\n`);
    writeFileSync(join(featureHome, "side-chat", "sessions", `${sideId}.meta.json`), JSON.stringify({
      sessionKind: "main", title: "Terminal conversation", paneTabId: tabId, originSessionId: parentId,
    }));
    app = await launchElectron({
      args: [MAIN_ENTRY, `--user-data-dir=${userData}`, "--no-sandbox"],
      env: buildIsolatedElectronEnv({ HOME: home, USERPROFILE: home, AVE_HOME: featureHome, AVE_DEV: "1", AVE_E2E: "1", NODE_ENV: "test",
        ...(existsSync("/bin/zsh") ? { SHELL: "/bin/zsh" } : {}) }),
    });
    page = await app.firstWindow();
    page.on("pageerror", (error) => appErrors.push(error.message));
    await page.setViewportSize({ width: 1280, height: 860 });
    await expect(page.getByTestId("main-toolbar").first()).toBeVisible({ timeout: 60_000 });
    await page.evaluate((id) => {
      const state = window as unknown as { hostOutput: string };
      state.hostOutput = "";
      window.aveApi.terminal!.onData((event) => { if (event.tabId === id && event.lane === "manual") state.hostOutput += event.chunk; });
    }, tabId);
    const hostOutput = () => page!.evaluate(() => (window as unknown as { hostOutput: string }).hostOutput);
    // The restored pane chat observes its own agent terminal activity: its live strip never shows a subscription error.
    const observationFailed = page.getByTestId("terminal-observation-live-strip").filter({ hasText: "Agent terminal activity could not be displayed" });
    await page.getByTestId(`sidebar-surface-${tabId}`).click();
    await page.getByTestId(`sidebar-session-${sideId}`).click();
    const pane = page.locator(`[data-testid="surface-pane"][data-tab-id="${tabId}"]`);
    const paneChat = page.locator(`[data-testid="pane-chat"][data-tab-id="${tabId}"]`);
    await expect(paneChat).toBeVisible();
    // The pane's one header row: the host chip names the exposure, its tooltip states it in full.
    // The chip is portaled into the pane's header row, which sits above the surface pane.
    const chip = page.locator('[data-testid="pane-header"]').getByTestId("terminal-pane-host-chip");
    await expect(chip).toHaveText("Host · commands need approval");
    await expect(chip).toHaveAttribute("title", /My terminal \(host\) · Agent commands need your approval/);
    await expect(pane.locator(".xterm")).toBeVisible();
    await expect(observationFailed).toHaveCount(0);

    const composer = paneChat.getByTestId("composer-textarea");
    await composer.fill("Run the slow check in my terminal.");
    await composer.press("Enter");
    const approval = page.getByTestId(TEST_IDS.approvalDock).first();
    await expect(approval.getByTestId(TEST_IDS.approveButton)).toBeVisible({ timeout: 30_000 });
    await expect(approval).toContainText("your real shell");
    await expect(observationFailed).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("host-approval-card.png") });
    await approval.getByTestId(TEST_IDS.approveButton).click();

    const agentStrip = pane.getByTestId("terminal-agent-control");
    await expect(agentStrip).toBeVisible({ timeout: 20_000 });
    // Enter was pressed and the command printed its own line (the echoed command text has a literal backslash after the marker, never a line end).
    await expect(agentStrip).toContainText("The agent is running an approved command", { timeout: 20_000 });
    await expect.poll(hostOutput, { timeout: 20_000 }).toMatch(/agent-period-marker\r?\n/u);
    await expect(pane.getByTestId("terminal-take-over-hint")).toHaveText("Typing takes over.");
    await expect(observationFailed).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("host-agent-typing.png") });

    await agentStrip.getByTestId("terminal-take-over").click();
    const userStrip = pane.getByTestId("terminal-user-control");
    await expect(userStrip).toBeVisible();
    await expect(agentStrip).toHaveCount(0);
    // The agent's command is still running in the user's period: interrupt it and run something private.
    await pane.locator(".xterm").click();
    await page.keyboard.press("Control+C");
    await page.keyboard.type(`echo ${userSentinel}`);
    await page.keyboard.press("Enter");
    await expect.poll(async () => (await hostOutput()).split(userSentinel).length, { timeout: 10_000 }).toBeGreaterThanOrEqual(3);
    await expect(pane.locator(".xterm-rows")).toContainText(userSentinel);
    await expect(observationFailed).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("host-user-takeover.png") });

    await expect.poll(() => modelCalls, { timeout: 30_000 }).toBe(2);
    const result = toolResults.join("\n");
    // The span itself carries the agent's output (not just the command text echoed back).
    expect(result).toContain('\\"output\\":\\"agent-period-marker\\\\r\\\\n\\"');
    expect(result).toContain('\\"interrupted\\":\\"take-over\\"');
    expect(result).not.toContain("agent-after-sleep");
    expect(result).not.toContain(userSentinel);

    // Hand back needs a quiet, empty attested prompt; it resumes nothing.
    await expect(async () => {
      await userStrip.getByTestId("terminal-hand-back").click();
      await expect(userStrip).toHaveCount(0, { timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
    await expect(pane.getByTestId("terminal-agent-control")).toHaveCount(0);
    expect(appErrors).toEqual([]);
  } finally {
    if (app && page) await teardownSeededElectron({ app, page, userDataDir: userData, tempHome: home, aveHome: featureHome }, { terminate: true });
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
