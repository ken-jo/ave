import { test, expect } from "./fixtures.js";
import type { ElectronApplication, Page } from "playwright";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  setWindowSize, quitElectron,
  MAIN_ENTRY, buildE2eBaseSettings, buildE2eSecrets, buildIsolatedElectronEnv, buildLlmSettings, builtMainExists, launchElectron,
  teardownSeededElectron,
} from "./seeded-electron.js";
import { TEST_IDS } from "../../../src/shared/test-ids.js";
import { writePermissionSettingsFixture } from "../../../src/__tests__/support/permission-settings-fixture.js";

// One host terminal in a workspace pane, with its own pane chat, driven as a person drives it: real keys into a real shell, a real window
// that is resized, and one approved agent command. The loopback endpoint only supplies the model's tool request and records what the model
// was told; the shell, the PTY, the approval gate and the terminal view are the real ones.
// Agent typing needs bracketed paste, which the Windows host shells (cmd, pwsh) lack, so the scenario runs on macOS and Linux.

interface TerminalProbe {
  cols: number;
  rows: number;
  viewportY: number;
  baseY: number;
  lines: string[];
}

/** Find this pane's live xterm through the view that holds it, and keep it on the window with a log of every size it takes. */
async function installProbe(page: Page, tabId: string): Promise<void> {
  await page.evaluate((id) => {
    const host = document.querySelector(`[data-testid="surface-pane"][data-tab-id="${id}"] [data-testid="terminal-xterm-host"]`);
    if (!(host instanceof HTMLElement)) throw new Error("the terminal pane has no xterm host");
    const key = Object.keys(host).find((name) => name.startsWith("__reactFiber$"));
    type Fiber = { memoizedState: unknown; return: Fiber | null };
    type Hook = { memoizedState: unknown; next: Hook | null };
    type Xterm = { cols: number; rows: number; onResize(listener: (size: { cols: number; rows: number }) => void): unknown };
    let fiber = key ? (host as unknown as Record<string, Fiber | null>)[key] : null;
    let term: Xterm | null = null;
    while (fiber && !term) {
      let hook = fiber.memoizedState as Hook | null;
      for (let guard = 0; hook && typeof hook === "object" && "next" in hook && guard < 80 && !term; guard++) {
        const state = hook.memoizedState as { term?: Xterm } | null;
        if (state && typeof state === "object" && state.term && typeof state.term.cols === "number") term = state.term;
        hook = hook.next;
      }
      fiber = fiber.return;
    }
    if (!term) throw new Error("the terminal view holds no live xterm");
    const state = window as unknown as { reviewTerm: Xterm; reviewSizes: Array<[number, number, number]> };
    state.reviewTerm = term;
    state.reviewSizes = [[term.cols, term.rows, host.offsetWidth]];
    term.onResize(({ cols, rows }) => state.reviewSizes.push([cols, rows, host.offsetWidth]));
  }, tabId);
}

async function probe(page: Page): Promise<TerminalProbe> {
  return page.evaluate(() => {
    const term = (window as unknown as { reviewTerm: { cols: number; rows: number; buffer: { active: { length: number; viewportY: number; baseY: number;
      getLine(line: number): { translateToString(trim: boolean): string; isWrapped: boolean } | undefined } } } }).reviewTerm;
    const buffer = term.buffer.active;
    const lines: string[] = [];
    for (let index = 0; index < buffer.length; index++) {
      const line = buffer.getLine(index);
      if (!line) continue;
      // A wrapped row continues the logical line above it.
      if (line.isWrapped && lines.length > 0) lines[lines.length - 1] += line.translateToString(true);
      else lines.push(line.translateToString(true));
    }
    return { cols: term.cols, rows: term.rows, viewportY: buffer.viewportY, baseY: buffer.baseY, lines };
  });
}

if (process.platform !== "win32") test("a host terminal keeps its output, focus, links and controls through real use",
  // biome-ignore lint/correctness/noEmptyPattern: the test runner requires a destructured first parameter, and this test takes no fixture.
  async ({}, testInfo) => {
  test.setTimeout(240_000);
  expect(builtMainExists()).toBe(true);
  const root = mkdtempSync(join(tmpdir(), "ave-terminal-review-"));
  const userData = join(root, "user-data");
  const home = join(root, "home");
  const featureHome = join(home, ".ave");
  const workspace = join(root, "workspace");
  const tabId = "terminal:abcd1234-1";
  const parentId = "e3000000-bb11-4cc2-8dd3-eeeeeeeeeeee";
  const sideId = "a3000000-bb11-4cc2-8dd3-eeeeeeeeeeee";
  const model = "terminal-review-model";
  const shell = process.platform === "darwin" ? "/bin/zsh" : "/bin/bash";
  const acceptKey = process.platform === "darwin" ? "Meta+Enter" : "Control+Enter";
  // The last line has no newline: the shell pads the row before its prompt, and that padding is not output.
  const agentCommand = "printf 'agent-marker\\n'; sleep 6; printf 'agent-%s' done";
  const requestText = "Run the check in my terminal.";
  const toolResults: string[] = [];
  const appErrors: string[] = [];
  const send = (response: ServerResponse, delta: Record<string, unknown>, finish: string | null) => {
    response.write(`data: ${JSON.stringify({ id: "terminal-review", object: "chat.completion.chunk", created: 0, model,
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
    const results = messages.filter((message) => message.role === "tool").map((message) => typeof message.content === "string" ? message.content : JSON.stringify(message.content));
    const asked = messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes(requestText));
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    if (asked && results.length === 0) {
      send(response, { role: "assistant", tool_calls: [{ index: 0, id: "host-terminal-command", type: "function", function: {
        name: "terminal_run", arguments: JSON.stringify({ command: agentCommand, waitSeconds: 60 }),
      } }] }, null);
      send(response, {}, "tool_calls");
    } else {
      // The turn's second request carries what the model is told the command did. Any other request (a title, a summary) just gets words.
      if (asked) toolResults.push(...results);
      send(response, { role: "assistant", content: asked ? "The command finished." : "Noted." }, null);
      send(response, {}, "stop");
    }
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const linkUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/models`;
  let app: ElectronApplication | undefined;
  let page: Page | undefined;
  try {
    mkdirSync(userData, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    mkdirSync(home, { recursive: true });
    if (shell === "/bin/bash") writeFileSync(join(home, ".bash_profile"), "unset -f command_not_found_handle\n");
    // A short prompt, so a narrow window wraps the output and not the prompt.
    if (shell === "/bin/zsh") writeFileSync(join(home, ".zshrc"), "PROMPT='%# '\n");
    mkdirSync(join(featureHome, "sessions"), { recursive: true });
    mkdirSync(join(featureHome, "side-chat", "sessions"), { recursive: true });
    const settings = buildLlmSettings("openai-compatible", model);
    (settings.llm as { vendors: Record<string, { baseUrl?: string }> }).vendors["openai-compatible"].baseUrl =
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
    const terminal = { kind: "terminal", tabId, ordinal: 1, cwd: workspace, url: null, projectRoot: realpathSync(workspace) };
    writeFileSync(join(userData, "ave-settings.json"), JSON.stringify({
      ...settings,
      appearance: buildE2eBaseSettings(true, "en").appearance,
      system: { mainLayout: {
        version: 2, tree: { kind: "leaf", chatGroupId: "main" }, focusedId: "main",
        surfaces: { main: terminal }, openSurfaces: [terminal],
        panelOpenIds: [], thumbnailOpenIds: [], sideTabs: {},
      } },
    }));
    writeFileSync(join(userData, "ave-secrets.json"), JSON.stringify(buildE2eSecrets()), { mode: 0o600 });
    writeFileSync(join(featureHome, "sessions", `${parentId}.jsonl`), `${JSON.stringify({ role: "user", content: "Parent conversation" })}\n`);
    writeFileSync(join(featureHome, "sessions", `${parentId}.meta.json`), JSON.stringify({ title: "Parent conversation", projectRoot: realpathSync(workspace) }));
    writeFileSync(join(featureHome, "sessions", ".active-session.json"), JSON.stringify({
      mainActiveMode: "resume", mainActiveSessionId: parentId, updatedAt: new Date().toISOString(),
    }));
    writeFileSync(join(featureHome, "side-chat", "sessions", `${sideId}.jsonl`), `${JSON.stringify({ role: "user", content: "Terminal conversation" })}\n`);
    writeFileSync(join(featureHome, "side-chat", "sessions", `${sideId}.meta.json`), JSON.stringify({
      sessionKind: "main", title: "Terminal conversation", paneTabId: tabId, originSessionId: parentId, projectRoot: realpathSync(workspace),
    }));
    const bootLog = testInfo.outputPath("isolated-app-boot.log");
    const launch = async (): Promise<{ app: ElectronApplication; page: Page }> => {
      const started = await launchElectron({
        args: [MAIN_ENTRY, `--user-data-dir=${userData}`, "--no-sandbox"],
        // REVIEW_INHERITED stands for what a person's login environment carries (an agent socket, a toolchain path).
        env: buildIsolatedElectronEnv({ HOME: home, USERPROFILE: home, AVE_HOME: featureHome, AVE_DEV: "1", AVE_E2E: "1", NODE_ENV: "test",
          SHELL: shell, REVIEW_INHERITED: "from-the-app" }),
      });
      started.process().stdout?.on("data", (chunk) => appendFileSync(bootLog, chunk));
      started.process().stderr?.on("data", (chunk) => appendFileSync(bootLog, chunk));
      const first = await started.firstWindow();
      first.on("pageerror", (error) => appErrors.push(error.message));
      return { app: started, page: first };
    };
    ({ app, page } = await launch());
    const view = page;
    await setWindowSize(app, 1280, 860);
    await expect(view.getByTestId("main-toolbar").first()).toBeVisible({ timeout: 60_000 });
    writePermissionSettingsFixture(featureHome, JSON.stringify({ permissions: { additionalDirectories: [workspace] } }));
    await view.evaluate((projectRoot) => window.aveApi.updateSettings({ system: { projectSelection: { kind: "root", root: projectRoot } } }), realpathSync(workspace));
    await view.reload();
    await expect(view.getByTestId("main-toolbar").first()).toBeVisible({ timeout: 60_000 });
    await view.evaluate((id) => {
      const state = globalThis as unknown as { hostOutput: string };
      state.hostOutput = "";
      window.aveApi.terminal?.onData((event) => { if (event.tabId === id && event.lane === "manual") state.hostOutput += event.chunk; });
    }, tabId);
    const hostOutput = () => view.evaluate(() => (globalThis as unknown as { hostOutput: string }).hostOutput);
    await view.getByTestId(`sidebar-surface-${tabId}`).click();
    await view.getByTestId(`sidebar-session-${sideId}`).click();
    const pane = view.locator(`[data-testid="surface-pane"][data-tab-id="${tabId}"]`);
    const paneChat = view.locator(`[data-testid="pane-chat"][data-tab-id="${tabId}"]`);
    const header = view.locator('[data-testid="pane-header"]').filter({ has: view.getByTestId("terminal-pane-host-chip") });
    await expect(paneChat).toBeVisible();
    await expect(pane.locator(".xterm")).toBeVisible();
    const session = await view.evaluate(async ({ id, cwd }) => {
      const api = window.aveApi.terminal;
      if (!api) throw new Error("Terminal API is unavailable");
      const result = await api.spawn({ tabId: id, lane: "manual", purpose: "workspace", cwd });
      if (!result.ok) throw new Error(`Terminal fixture replay failed: ${result.reason}`);
      return result.session;
    }, { id: tabId, cwd: realpathSync(workspace) });
    const shellReady = () => view.evaluate(async (ref) => {
      const api = window.aveApi.terminal;
      if (!api) throw new Error("Terminal API is unavailable");
      const result = await api.listBlocks(ref);
      if (!result.ok) throw new Error(`Terminal fixture state unavailable: ${result.error}`);
      return { integrated: result.integrated, cwd: result.session.currentCwd };
    }, session);
    await expect.poll(shellReady).toEqual({ integrated: true, cwd: realpathSync(workspace) });
    await installProbe(view, tabId);
    /** Type a command at the prompt and wait for the shell to report it finished. */
    const run = async (command: string): Promise<void> => {
      await pane.locator(".xterm").click();
      await view.keyboard.type(command);
      await view.keyboard.press("Enter");
      await expect.poll(() => view.evaluate(async ({ ref, text }) => {
        const api = window.aveApi.terminal;
        if (!api) throw new Error("Terminal API is unavailable");
        const blocks = await api.listBlocks(ref);
        if (!blocks.ok) throw new Error(`Terminal blocks unavailable: ${blocks.error}`);
        return blocks.blocks.find((block) => block.command === text)?.status ?? null;
      }, { ref: session, text: command }), { timeout: 20_000 }).toBe("done");
    };

    // The user's shell has the application's environment, without Ave's own variables, and says which terminal it is.
    // biome-ignore lint/suspicious/noTemplateCurlyInString: shell parameter expansion, typed into the shell as written.
    await run("echo \"TP=$TERM_PROGRAM RI=$REVIEW_INHERITED AH=${AVE_HOME:-unset} AD=${AVE_DEV:-unset}\"");
    await expect.poll(hostOutput).toContain("TP=Ave RI=from-the-app AH=unset AD=unset");

    // A real window squeezed and widened again loses no line, and the shell is never told a size the user did not settle on.
    await run("for i in 1 2 3 4 5 6; do echo KEEP-line-$i-0123456789-0123456789-0123456789; done");
    const keep = (state: TerminalProbe): string[] => state.lines.filter((line) => line.startsWith("KEEP-line-"));
    // The shell reported the command finished; the view draws its last bytes a moment later.
    await expect.poll(async () => keep(await probe(view)).length).toBe(6);
    const kept = keep(await probe(view));
    /** The terminal's size once the layout around it has stopped moving: the same over several consecutive reads. */
    const settled = async (): Promise<TerminalProbe> => {
      const seen: number[] = [];
      await expect.poll(async () => {
        seen.push((await probe(view)).cols);
        return seen.length >= 4 && seen.slice(-4).every((cols) => cols === seen.at(-1));
      }, { intervals: [150], timeout: 15_000 }).toBe(true);
      return probe(view);
    };
    const wide = await settled();
    await view.evaluate(() => { (globalThis as unknown as { reviewSizes: unknown[] }).reviewSizes.length = 0; });
    // The width the terminal's host has in every frame the window paints, read in a task that runs after the paint.
    await view.evaluate(() => {
      const host = document.querySelector<HTMLElement>('[data-testid="terminal-xterm-host"]');
      if (!host) throw new Error("the terminal has no host element");
      // Starting from the width it has now: the window may be resized before the first frame after this is painted.
      const painted: number[] = [Math.round(host.getBoundingClientRect().width)];
      (globalThis as unknown as { reviewPainted: number[] }).reviewPainted = painted;
      const afterPaint = new MessageChannel();
      afterPaint.port1.onmessage = () => {
        painted.push(Math.round(host.getBoundingClientRect().width));
        requestAnimationFrame(() => afterPaint.port2.postMessage(null));
      };
      requestAnimationFrame(() => afterPaint.port2.postMessage(null));
    });
    await setWindowSize(app, 420, 860);
    await expect.poll(async () => (await probe(view)).cols, { timeout: 10_000 }).toBeLessThan(wide.cols);
    const narrow = await settled();
    expect(narrow.cols).toBeLessThan(60);
    // The narrow header keeps the tab's whole title and the chip's name; the chip's detail is what gave way, whole.
    const headerState = () => header.evaluate((element) => {
      const title = element.querySelector("h2");
      const chip = element.querySelector('[data-testid="terminal-pane-host-chip"]');
      const detail = chip?.querySelector('[data-testid="terminal-pane-host-chip-detail"]');
      const name = chip?.firstElementChild;
      if (!title || !chip || !detail || !name) throw new Error("the terminal pane header is missing a part");
      const chipBox = chip.getBoundingClientRect();
      return {
        // The title's own content against the box it is drawn in: wider means an ellipsis.
        titleCut: title.scrollWidth > title.clientWidth,
        chipName: name.textContent,
        chipInside: chipBox.right <= element.getBoundingClientRect().right,
        // Shown on the chip's one line, or wrapped below it and clipped.
        detailShown: detail.getBoundingClientRect().top < chipBox.bottom - 1 && detail.getBoundingClientRect().right <= chipBox.right + 0.5,
      };
    });
    await expect.poll(headerState).toEqual({ titleCut: false, chipName: "Host", chipInside: true, detailShown: false });
    await setWindowSize(app, 1280, 860);
    const back = await settled();
    // The same host width ends at the same columns, whichever width the terminal came from.
    expect(back.cols).toBe(wide.cols);
    await expect.poll(headerState).toEqual({ titleCut: false, chipName: "Host", chipInside: true, detailShown: true });
    const sizes = await view.evaluate(() => (globalThis as unknown as { reviewSizes: Array<[number, number, number]> }).reviewSizes);
    await testInfo.attach("terminal-sizes", { body: JSON.stringify(sizes), contentType: "application/json" });
    expect(keep(await probe(view))).toEqual(kept);
    // In every painted frame the terminal's host had the width it started with, the narrow layout's, or the one it came back to: no panel or
    // sidebar slid it through the widths between.
    const painted = (await view.evaluate(() => (globalThis as unknown as { reviewPainted: number[] }).reviewPainted))
      .filter((width, index, all) => width !== all[index - 1]);
    await testInfo.attach("terminal-host-widths", { body: JSON.stringify(painted), contentType: "application/json" });
    expect(painted).toHaveLength(3);
    expect(painted[2]).toBe(painted[0]);
    expect(painted[1]).toBeLessThan(painted[0] ?? 0);
    // So the terminal, and its shell, took the two widths the window settled on and none between. Its buffer is short, so every size it is
    // given is applied at once: nothing here is held back by a wait.
    expect(sizes.map(([cols]) => cols).filter((cols, index, all) => cols !== all[index - 1])).toEqual([narrow.cols, wide.cols]);

    // Find searches the real buffer, scrollback included, and the same terminal comes back after its tab was away.
    await run("for i in $(seq 1 120); do echo SCROLL-$i-END; done");
    await view.evaluate(() => { (globalThis as unknown as { reviewBefore: unknown; reviewTerm: unknown }).reviewBefore = (globalThis as unknown as { reviewTerm: unknown }).reviewTerm; });
    await view.getByTestId(`sidebar-session-${parentId}`).click();
    await expect(pane).toHaveCount(0);
    await view.getByTestId(`sidebar-surface-${tabId}`).click();
    await expect(pane.locator(".xterm")).toBeVisible();
    await installProbe(view, tabId);
    await settled();
    expect(await view.evaluate(() => (globalThis as unknown as { reviewBefore: unknown; reviewTerm: unknown }).reviewBefore === (globalThis as unknown as { reviewTerm: unknown }).reviewTerm)).toBe(true);
    await pane.locator(".xterm").click();
    await view.keyboard.press(process.platform === "darwin" ? "Meta+f" : "Control+f");
    const find = pane.getByTestId("terminal-find-bar");
    await expect(find).toBeVisible();
    await expect(find.getByTestId("terminal-find-input")).toBeFocused();
    await view.keyboard.type("SCROLL-7-END");
    // Once as the command's own output, far above the screen.
    await expect(find.getByTestId("terminal-find-status")).toHaveText("1 of 1");
    await view.keyboard.press("Escape");
    await expect(find).toHaveCount(0);
    await expect(pane.locator(".xterm-helper-textarea")).toBeFocused();

    // The command keys scroll to the row a command started on.
    // Find left the view on its match, far up; a key typed at the prompt brings it back to the bottom.
    await view.keyboard.press("Enter");
    await expect.poll(async () => { const state = await probe(view); return state.viewportY === state.baseY && state.baseY > 0; }).toBe(true);
    const bottom = (await probe(view)).viewportY;
    await view.keyboard.press(process.platform === "darwin" ? "Meta+ArrowUp" : "Control+ArrowUp");
    const jumped = await probe(view);
    expect(jumped.viewportY).toBeLessThan(bottom);
    expect(jumped.lines.join("\n")).toContain("SCROLL-1-END");
    await expect(pane.getByTestId("terminal-sticky-command")).toHaveCount(0);
    await view.keyboard.press(process.platform === "darwin" ? "Meta+ArrowDown" : "Control+ArrowDown");
    await expect.poll(async () => (await probe(view)).viewportY).toBe(bottom);
    await expect(pane.getByTestId("terminal-sticky-command")).toContainText("seq 1 120");

    // The card shows the exact command above its choices, and the accept key answers it from where the user is.
    await view.getByTestId(`sidebar-session-${sideId}`).click();
    const composer = paneChat.getByTestId("composer-textarea");
    // Typed at a person's pace: the agent may type into the terminal only once the user's own keys there have been quiet for a moment.
    await composer.pressSequentially(requestText, { delay: 70 });
    await composer.press("Enter");
    const approval = view.getByTestId(TEST_IDS.approvalDock).first();
    const card = approval.getByTestId("user-owned-surface-card");
    await expect(card).toBeVisible({ timeout: 30_000 });
    await expect(card.getByTestId("user-owned-surface-command")).toHaveText(agentCommand);
    const cardGeometry = await card.evaluate((element) => {
      const box = (testId: string) => {
        const found = element.querySelector(`[data-testid="${testId}"]`);
        if (!found) throw new Error(`the card has no ${testId}`);
        return found.getBoundingClientRect();
      };
      const cardBox = element.getBoundingClientRect();
      return { commandInside: box("user-owned-surface-command").top >= cardBox.top && box("user-owned-surface-command").height > 0,
        commandAboveChoices: box("user-owned-surface-command").bottom <= box("user-owned-surface-choice-form").top,
        confirmInside: box("user-owned-surface-confirm").bottom <= cardBox.bottom };
    });
    expect(cardGeometry).toEqual({ commandInside: true, commandAboveChoices: true, confirmInside: true });
    await expect(card.getByTestId("user-owned-surface-accept-keys")).toHaveText(process.platform === "darwin" ? "⌘↵" : "Ctrl+↵");
    await expect(view.getByTestId("permission-review-status-card").last()).toHaveText("Approval requiredterminal_run · Built-in");
    // From the composer, where the user's cursor is after asking, without touching the card, it confirms the selected choice.
    await composer.focus();
    await expect(composer).toBeFocused();
    await composer.press(acceptKey);
    await expect(card).toHaveCount(0, { timeout: 15_000 });

    // At a width where the chat floats over the terminal, the agent's strip and its two controls are on screen in the chat.
    await expect(pane.getByTestId("terminal-agent-control")).toBeVisible({ timeout: 20_000 });
    await expect.poll(hostOutput, { timeout: 20_000 }).toMatch(/agent-marker\r?\n/u);
    await setWindowSize(app, 420, 860);
    const mirrored = paneChat.getByTestId("pane-chat-terminal-agent-control");
    await expect(mirrored).toBeVisible();
    await expect(mirrored).toContainText("The agent is running an approved command");
    for (const control of ["pane-chat-terminal-take-over", "pane-chat-terminal-stop-agent"]) await expect(mirrored.getByTestId(control)).toBeInViewport({ ratio: 1 });
    await view.screenshot({ path: testInfo.outputPath("agent-strip-420.png") });
    await setWindowSize(app, 1280, 860);
    await expect(paneChat.getByTestId("pane-chat-terminal-agent-control")).toHaveCount(0);

    // The model is told the command's output as plain lines, with the fields an isolated shell's block has.
    await expect.poll(() => toolResults.length, { timeout: 40_000 }).toBeGreaterThan(0);
    const told = toolResults.at(-1) ?? "";
    const payload = JSON.parse(told.slice(told.indexOf("{"), told.lastIndexOf("}") + 1)) as { finished: boolean; block: Record<string, unknown> };
    expect(payload.finished).toBe(true);
    expect(payload.block).toMatchObject({ command: agentCommand, exitCode: 0, status: "done", truncated: false, output: "agent-marker\nagent-done\n" });
    expect(payload.block.outputChars).toBe("agent-marker\nagent-done\n".length);

    // A web address in the output opens in an Ave browser tab on a modifier-click, and not on a plain click.
    await run(`echo ${linkUrl}`);
    // The row's text sits under the layer that takes the pointer, so the pointer goes to where the address is drawn. The prompt drawn after the
    // output scrolls the screen one more row, so the address is located again until the pointer is found over it.
    const at = { x: 0, y: 0 };
    await expect(async () => {
      const box = await pane.locator(".xterm-rows > div").filter({ hasText: linkUrl }).last().boundingBox();
      if (!box) throw new Error("the address is not on screen");
      at.x = box.x + 60;
      at.y = box.y + box.height / 2;
      // The pointer arrives over the address from another cell, as a hand moves it.
      await view.mouse.move(at.x + 40, at.y - 60);
      await view.mouse.move(at.x, at.y, { steps: 6 });
      await expect(pane.getByTestId("terminal-link-tooltip")).toContainText(linkUrl, { timeout: 1_000 });
    }).toPass({ timeout: 15_000 });
    await view.mouse.click(at.x, at.y);
    await expect(view.locator('[data-testid="surface-pane"][data-surface-kind="browser"]')).toHaveCount(0);
    await view.keyboard.down(process.platform === "darwin" ? "Meta" : "Control");
    await view.mouse.click(at.x, at.y);
    await view.keyboard.up(process.platform === "darwin" ? "Meta" : "Control");
    await expect(view.locator('[data-testid="surface-pane"][data-surface-kind="browser"]')).toHaveCount(1, { timeout: 15_000 });

    // A shell that ended says so, and Restart starts a new one in the same tab with the old output still there.
    // The browser tab took half the window and the chat now floats over the whole terminal, so the user closes the chat to get at the shell.
    await view.getByTestId("pane-panel-slot").getByRole("button", { name: "Close side panel" }).click();
    await pane.locator(".xterm").click();
    await view.keyboard.type("exit");
    await view.keyboard.press("Enter");
    const ended = pane.getByTestId("terminal-ended");
    await expect(ended).toBeVisible({ timeout: 15_000 });
    await expect(ended.getByTestId("terminal-ended-chip")).toHaveText("Ended");
    await ended.getByTestId("terminal-restart").click();
    await expect(ended).toHaveCount(0, { timeout: 15_000 });
    await expect(pane.locator(".xterm-helper-textarea")).toBeFocused();
    expect((await probe(view)).lines.join("\n")).toContain("SCROLL-120-END");

    // Quitting and starting Ave again brings the tab back with what it showed, above a new shell, and that output is in one private file.
    await view.keyboard.type("echo PERSIST-$((40 + 2))-marker");
    await view.keyboard.press("Enter");
    await expect.poll(async () => (await probe(view)).lines.includes("PERSIST-42-marker"), { timeout: 20_000 }).toBe(true);
    await quitElectron(app);
    const keptDirectory = join(featureHome, "terminal-state");
    const keptFiles = readdirSync(keptDirectory);
    expect(keptFiles).toHaveLength(1);
    expect(statSync(keptDirectory).mode & 0o777).toBe(0o700);
    expect(statSync(join(keptDirectory, keptFiles[0] ?? "")).mode & 0o777).toBe(0o600);
    const holders: string[] = [];
    const walk = (at: string): void => {
      for (const entry of readdirSync(at, { withFileTypes: true })) {
        const path = join(at, entry.name);
        if (entry.isDirectory()) walk(path);
        else if (entry.isFile() && readFileSync(path).includes("PERSIST-42-marker")) holders.push(path);
      }
    };
    // Nowhere else under Ave's data or the app's own: no session, no log, no setting.
    walk(featureHome);
    walk(userData);
    expect(holders).toEqual([join(keptDirectory, keptFiles[0] ?? "")]);
    ({ app, page } = await launch());
    const again = page;
    await setWindowSize(app, 1280, 860);
    await expect(again.getByTestId("main-toolbar").first()).toBeVisible({ timeout: 60_000 });
    // The saved layout shows the tab in its pane again; nothing has to be opened.
    const restoredPane = again.locator(`[data-testid="surface-pane"][data-tab-id="${tabId}"]`);
    await expect(restoredPane.locator(".xterm")).toBeVisible();
    await installProbe(again, tabId);
    await expect.poll(async () => (await probe(again)).lines.some((line) => line.includes("Restored tab: this is a new shell."))).toBe(true);
    const restored = (await probe(again)).lines;
    const row = (text: string): number => restored.findIndex((line) => line.includes(text));
    // The first shell's output, the second shell's, then this run's notice: in the order they happened. The tab comes back as it was shown,
    // with what it said itself then (an earlier notice, the first shell's end) where it said it.
    expect(row("SCROLL-120-END")).toBeGreaterThan(-1);
    expect(row("PERSIST-42-marker")).toBeGreaterThan(row("SCROLL-120-END"));
    expect(restored.findLastIndex((line) => line.includes("Restored tab: this is a new shell."))).toBeGreaterThan(row("PERSIST-42-marker"));
    // And the shell below it is a live one.
    await restoredPane.locator(".xterm").click();
    await again.keyboard.type("echo ALIVE-$((1 + 1))");
    await again.keyboard.press("Enter");
    await expect.poll(async () => (await probe(again)).lines.includes("ALIVE-2"), { timeout: 20_000 }).toBe(true);
    // A reload of the window keeps what the tab shows as its document goes, as a quit does.
    await again.reload();
    await expect(again.getByTestId("main-toolbar").first()).toBeVisible({ timeout: 60_000 });
    await expect.poll(() => readFileSync(join(keptDirectory, keptFiles[0] ?? "")).includes("ALIVE-2"), { timeout: 20_000 }).toBe(true);
    expect(appErrors).toEqual([]);
  } finally {
    await testInfo.attach("host-tool-results", { body: JSON.stringify(toolResults, null, 2), contentType: "application/json" });
    if (app && page) await teardownSeededElectron({ app, page, userDataDir: userData, tempHome: home, aveHome: featureHome }, { terminate: true });
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(root, { recursive: true, force: true });
  }
});
