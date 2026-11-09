import { expect, test } from "@playwright/test";
import { createServer, type ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { TEST_IDS } from "../../../src/shared/test-ids.js";
import { buildLlmSettings, launchSeededElectron, teardownSeededElectron, setWindowSize } from "./seeded-electron.js";
import { browserHostIdentity, browserTargetId, inspectBrowserTarget } from "./browser-native-target.js";

test.use({ trace: "on" });
test("parked agent click preserves the composer throughout native dispatch", () => exerciseParkedClick(false));
test("presented agent click preserves the composer throughout native dispatch", () => exerciseParkedClick(false, false, false, true));
test("@os-focus parked agent click preserves native composer focus", () => exerciseParkedClick(true));
test("@os-focus presented agent click preserves native composer focus", () => exerciseParkedClick(true, false, false, true));
test("visible user takeover invalidates control before a resumed parked click", () => exerciseParkedClick(false, true));
test("@os-focus visible user takeover restores native keyboard ownership before agent resume", () => exerciseParkedClick(true, true));
if (process.platform === "darwin") {
  test("@os-focus native pointer takeover routes OS keystrokes before the agent resumes", () => exerciseParkedClick(true, true, true));
}

interface PressSample {
  label: string;
  windowFocused: boolean;
  focusedFrame: number | undefined;
  hostFrame: number;
  targetId: number;
  focusedContentsId: number | null;
  editor: { active: string; draft: string; blurs: number; sameElement: boolean };
}

async function exerciseParkedClick(foreground: boolean, takeover = false, osTyping = false, presented = false): Promise<void> {
  const model = "static-editor-press-fixture";
  let phase = 0,
    url = "",
    tabId = "",
    ref = "";
  let prepareSnapshot: (() => void) | undefined;
  let release: (() => void) | undefined;
  let finish: (() => void) | undefined;
  let firstClickComplete = false;
  let attemptWhilePaused: (() => void) | undefined;
  let pausedResult = "";
  let resumeAgent: (() => void) | undefined;
  let resumedClick: (() => void) | undefined;
  let ctx: Awaited<ReturnType<typeof launchSeededElectron>> | undefined;
  const results: string[] = [];
  const send = (res: ServerResponse, delta: Record<string, unknown>, reason: string | null) =>
    res.write(
      `data: ${JSON.stringify({ id: "probe", object: "chat.completion.chunk", created: 0, model, choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`,
    );
  const tool = (res: ServerResponse, name: string, args: Record<string, unknown>) => {
    send(
      res,
      {
        role: "assistant",
        tool_calls: [{ index: 0, id: `probe-${phase}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
      },
      null,
    );
    send(res, {}, "tool_calls");
    res.end("data: [DONE]\n\n");
  };
  const server = createServer(async (req, res) => {
    if (req.method === "GET" && req.url === "/page") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end(
        '<!doctype html><title>Editor press probe</title><body style="padding:40px"><button onclick="document.body.dataset.trusted=String(event.isTrusted);document.body.dataset.activation=String(navigator.userActivation.isActive);document.body.dataset.clicks=String(+(document.body.dataset.clicks||0)+1)">Probe action</button><input id="page-editor" aria-label="Page editor"></body>',
      );
      return;
    }
    if (req.method === "GET" && req.url === "/v1/models") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: model }] }));
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(Buffer.from(c));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const last = body.messages?.findLast((x: { role: string }) => x.role === "tool")?.content;
    const text = typeof last === "string" ? last : JSON.stringify(last ?? "");
    if (phase > 0) results.push(text);

    phase++;
    res.writeHead(200, { "content-type": "text/event-stream" });
    if (phase === 1) {
      tool(res, "browser_tab_new", { url });
      return;
    }
    if (phase === 2) {
      tabId = /"tabId"\s*:\s*"(tab-\d+)"/.exec(text)?.[1] ?? "";
      prepareSnapshot = () => tool(res, "browser_snapshot", { tabId, interactive: true });
      res.flushHeaders();
      return;
    }
    if (phase === 3) {
      ref = /button "Probe action"[^\n]*\[ref=(e\d+)\]/.exec(text)?.[1] ?? "";
      release = () => tool(res, "browser_click", { tabId, ref });
      res.flushHeaders();
      return;
    }
    if (phase === 4) {
      firstClickComplete = true;
      if (takeover) {
        attemptWhilePaused = () => tool(res, "browser_click", { tabId, ref });
        res.flushHeaders();
        return;
      }
    }
    if (takeover && phase === 5) {
      pausedResult = text;
      resumeAgent = () => tool(res, "browser_snapshot", { tabId, interactive: true });
      res.flushHeaders();
      return;
    }
    if (takeover && phase === 6) {
      const renewedRef = /button "Probe action"[^\n]*\[ref=(e\d+)\]/.exec(text)?.[1] ?? "";
      resumedClick = () => tool(res, "browser_click", { tabId, ref: renewedRef });
      res.flushHeaders();
      return;
    }
    finish = () => {
      send(res, { role: "assistant", content: "Probe complete." }, null);
      send(res, {}, "stop");
      res.end("data: [DONE]\n\n");
    };
    res.flushHeaders();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const address = server.address();
  if (!address || typeof address === "string") throw Error("fixture address");
  url = `http://127.0.0.1:${address.port}/page`;
  const settings = buildLlmSettings("openai-compatible", model);
  (settings.llm as { vendors: Record<string, { baseUrl?: string }> }).vendors["openai-compatible"].baseUrl =
    `http://127.0.0.1:${address.port}/v1`;
  let approve = true;
  let approvals: Promise<void> | undefined;
  try {
    ctx = await launchSeededElectron({
      sessionTitle: "Editor press probe",
      settings,
      historyRows: [],
      launchArgs: ["--use-mock-keychain"],
      launchEnv: foreground ? { AVE_NATIVE_FIXTURE_MODE: "foreground" } : undefined,
    });
    await setWindowSize(ctx.app, 1200, 800);
    const host = await browserHostIdentity(ctx.app, ctx.page);
    await ctx.app.evaluate(({ app, BrowserWindow, webContents }, input) => {
      const owner = BrowserWindow.fromId(input.windowId);
      if (!owner || owner.webContents.id !== input.chromeId) throw new Error("Fixture owner window unavailable");
      const state = globalThis as unknown as { pressProbe: PressSample[] };
      state.pressProbe = [];
      app.on("web-contents-created", (_e, wc) => {
        const send = wc.debugger.sendCommand.bind(wc.debugger);
        const sample = async (label: string) => ({
          label,
          ts: Date.now(),
          targetId: wc.id,
          focusedContentsId: webContents.getFocusedWebContents()?.id ?? null,
          windowFocused: owner.isFocused(),
          focusedFrame: owner.webContents.focusedFrame?.frameTreeNodeId,
          hostFrame: owner.webContents.mainFrame.frameTreeNodeId,
          editor: await owner.webContents.executeJavaScript(
            "({ active: document.activeElement?.id, draft: document.getElementById('press-editor')?.value, blurs: window.pressEditorState?.blurs, events: window.pressEditorState?.events, sameElement: document.activeElement === window.pressEditorState?.element })",
          ),
        });
        wc.debugger.sendCommand = async (method, args = {}) => {
          const interesting =
            wc.getURL() === input.url && (method.startsWith("Input.") || method === "DOM.getNodeForLocation" || method.startsWith("Emulation.setFocus"));
          if (interesting) state.pressProbe.push(await sample(`before:${method}:${args.type ?? args.enabled ?? ""}`));
          try {
            return await send(method, args);
          } finally {
            if (interesting) state.pressProbe.push(await sample(`after:${method}:${args.type ?? args.enabled ?? ""}`));
          }
        };
      });
    }, { ...host, url });
    const { app, page } = ctx;
    await page.evaluate(async () => {
      await window.aveApi.setApiKey("openai-compatible", "sk-e2e-loopback-editor");
      const mode = await window.ave.permission.setMode("allow");
      if (!mode.ok) throw Error("fixture mode unavailable");
      const review = await window.ave.permission.reviewerDispatch("mode disabled");
      if (!review.ok) throw Error("fixture reviewer mode unavailable");
    });
    const composer = page.getByTestId("pane-cell:main").getByTestId("composer-textarea");
    await composer.fill("Click Probe action on the fixture page.");
    await composer.press("Enter");
    approvals = (async () => {
      while (approve) {
        for (const button of [
          page
            .getByTestId("browser-site-approval-card")
            .getByRole("button", { name: /^(Allow this site|이 사이트만 허용)$/ })
            .first(),
          page.getByTestId(TEST_IDS.approvalDock).getByTestId(TEST_IDS.approveButton).first(),
        ]) {
          if (await button.isVisible())
            try {
              await button.click({ timeout: 800 });
            } catch (e) {
              if (await button.isVisible()) throw e;
            }
        }
        await page.waitForTimeout(75);
      }
    })();
    await expect.poll(() => prepareSnapshot !== undefined, { timeout: 60_000 }).toBe(true);
    // Establish a real once-visible viewport before parking the guest.
    const toggle = page.getByTestId(TEST_IDS.panePanelToggle);
    if ((await toggle.getAttribute("aria-pressed")) !== "true") await toggle.click();
    await expect.poll(async () => (await inspectBrowserTarget(app, host.windowId, url)).attached).toBe(true);
    const targetId = await browserTargetId(ctx.app, url);
    expect(await inspectBrowserTarget(ctx.app, host.windowId, url)).toMatchObject({ id: targetId, type: "window", embedded: false });
    prepareSnapshot?.();
    await expect.poll(() => release !== undefined, { timeout: 30_000 }).toBe(true);

    expect(ref).toMatch(/^e\d+$/);
    if (!presented) await page.getByTestId("chat-side-panel-close").click();
    await expect(toggle).toHaveAttribute("aria-pressed", String(presented));
    await expect.poll(async () => (await inspectBrowserTarget(app, host.windowId, url)).attached).toBe(presented);
    approve = false;
    await approvals;
    if (foreground) {
      await ctx.app.evaluate(({ app, BrowserWindow }, windowId) => {
        app.focus({ steal: true });
        const owner = BrowserWindow.fromId(windowId);
        if (!owner) throw new Error("Fixture owner window unavailable");
        owner.focus();
        owner.webContents.focus();
      }, host.windowId);
      await expect
        .poll(() => app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((window) => window.isFocused())))
        .toBe(true);
    }
    await page.evaluate(() => {
      const editor = document.querySelector<HTMLTextAreaElement>('[data-testid="composer-textarea"]');
      if (!editor) throw Error("Missing composer");
      editor.id = "press-editor";
      const state = {
        element: editor,
        blurs: 0,
        events: [] as { type: string; ts: number; draft: string; active: string | undefined }[],
      };
      (window as unknown as { pressEditorState: typeof state }).pressEditorState = state;
      editor.addEventListener("blur", () => {
        state.blurs++;
        state.events.push({ type: "blur", ts: Date.now(), draft: editor.value, active: document.activeElement?.tagName });
      });
      editor.focus();
    });
    await page.keyboard.type("unfinished rename draft");
    const before = await page.evaluate(() => ({
      active: document.activeElement?.id,
      draft: (document.getElementById("press-editor") as HTMLTextAreaElement)?.value,
      blurs: (window as unknown as { pressEditorState: { blurs: number } }).pressEditorState.blurs,
      layout: [...document.querySelectorAll<HTMLElement>('[data-testid="web-surface-frame"]')].map((e) => ({
        rect: e.getBoundingClientRect().toJSON(),
        visibility: getComputedStyle(e).visibility,
        opacity: getComputedStyle(e).opacity,
        pointer: getComputedStyle(e).pointerEvents,
      })),
    }));
    expect(before).toMatchObject({ active: "press-editor", draft: "unfinished rename draft", blurs: 0 });
    release?.();
    await expect.poll(() => firstClickComplete, { timeout: 30_000 }).toBe(true);
    const after = await page.evaluate(() => ({
      active: document.activeElement?.id,
      draft: (document.getElementById("press-editor") as HTMLTextAreaElement)?.value,
      blurs: (window as unknown as { pressEditorState: { blurs: number } }).pressEditorState.blurs,
      sameElement:
        document.activeElement === (window as unknown as { pressEditorState: { element: HTMLElement } }).pressEditorState.element,
    }));
    const native = await ctx.app.evaluate(async ({ webContents, BrowserWindow }, input) => ({
      measurements: (globalThis as unknown as { pressProbe: PressSample[] }).pressProbe,
      guests: await Promise.all(
        webContents
          .getAllWebContents()
          .filter((w) => w.getURL() === input.url)
          .map(async (w) => ({
            url: w.getURL(),
            id: w.id,
            windowFocused: BrowserWindow.fromId(input.windowId)?.isFocused(),
            clicks: await w.executeJavaScript("document.body.dataset.clicks"),
            trusted: await w.executeJavaScript("document.body.dataset.trusted"),
            activation: await w.executeJavaScript("document.body.dataset.activation"),
            viewport: await w.executeJavaScript("({width:innerWidth,height:innerHeight,visibility:document.visibilityState})"),
          })),
      ),
    }), { url, windowId: host.windowId });
    const evidence = { before, after, ...native, toolResults: results };

    await test
      .info()
      .attach("parked-click-focus.json", { body: JSON.stringify(evidence, null, 2), contentType: "application/json" });
    expect(native.guests).toHaveLength(1);
    expect(native.guests[0]?.clicks).toBe("1");
    expect(native.guests[0]?.trusted).toBe("true");
    expect(native.guests[0]?.activation).toBe("true");
    expect(native.guests[0]?.id).toBe(targetId);
    expect(results.some((result) => /"error"\s*:/.test(result))).toBe(false);
    const beforePress = native.measurements.find((sample) => sample.label === "before:Input.dispatchTouchEvent:touchStart");
    const afterPress = native.measurements.find((sample) => sample.label === "after:Input.dispatchTouchEvent:touchStart");
    expect(native.measurements.filter((sample) => sample.label === "before:Input.dispatchTouchEvent:touchStart")).toHaveLength(1);
    expect(beforePress?.focusedFrame).toEqual(expect.any(Number));
    expect(beforePress?.focusedFrame).toBe(beforePress?.hostFrame);
    expect(beforePress?.windowFocused).toBe(foreground);
    expect(afterPress?.windowFocused).toBe(foreground);
    expect(beforePress).toMatchObject({
      editor: { active: "press-editor", draft: "unfinished rename draft", blurs: 0, sameElement: true },
    });
    expect(afterPress).toMatchObject({
      editor: { active: "press-editor", draft: "unfinished rename draft", blurs: 0, sameElement: true },
    });
    expect(afterPress?.focusedFrame).toBe(beforePress?.focusedFrame);
    expect(afterPress?.focusedContentsId).toBe(beforePress?.focusedContentsId);
    expect(beforePress?.targetId).toBe(targetId);
    expect(afterPress?.targetId).toBe(targetId);
    expect(after).toMatchObject({ active: "press-editor", draft: "unfinished rename draft", blurs: 0, sameElement: true });
    expect(await inspectBrowserTarget(app, host.windowId, url)).toMatchObject({ id: targetId, attached: presented });
    if (takeover) {
      const control = () => page.evaluate(async target => {
        const tabs = window.aveApi.browserTabs;
        if (!tabs) throw new Error("Native browser control API unavailable");
        const control = (await tabs.getState()).tabs.find(tab => tab.tabId === target);
        if (!control) throw new Error("Native browser control target unavailable");
        return control;
      }, tabId);
      const beforeTakeover = await control();
      expect(beforeTakeover).toMatchObject({ mode: "agent-active", rendererTabId: expect.any(String) });
      const rendererTabId = beforeTakeover.rendererTabId;
      if (!rendererTabId) throw new Error("Native browser renderer identity unavailable");
      await toggle.click();
      await expect.poll(async () => (await inspectBrowserTarget(app, host.windowId, url)).attached).toBe(true);
      if (osTyping) {
        const point = await ctx.app.evaluate(async ({ BrowserWindow, webContents }, input) => {
          const owner = BrowserWindow.fromId(input.windowId);
          const target = webContents.fromId(input.targetId);
          if (!owner || !target) throw new Error("Visible native target unavailable");
          type NativeView = { children: NativeView[]; webContents?: { id: number }; getBounds(): { x: number; y: number } };
          const find = (view: NativeView, x: number, y: number): { x: number; y: number } | undefined => {
            const bounds = view.getBounds();
            const origin = { x: x + bounds.x, y: y + bounds.y };
            if (view.webContents?.id === target.id) return origin;
            for (const child of view.children) {
              const found = find(child, origin.x, origin.y);
              if (found) return found;
            }
            return undefined;
          };
          const origin = find(owner.contentView as NativeView, 0, 0);
          if (!origin) throw new Error("Native target is not attached");
          const rect = await target.executeJavaScript("(()=>{const rect=document.getElementById('page-editor').getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2}})()");
          const content = owner.getContentBounds();
          return { x: Math.round(content.x + origin.x + rect.x * target.getZoomFactor()), y: Math.round(content.y + origin.y + rect.y * target.getZoomFactor()) };
        }, { windowId: host.windowId, targetId });
        await promisify(execFile)("/usr/bin/osascript", ["-e", 'on run argv\ntell application "System Events" to click at {(item 1 of argv as integer), (item 2 of argv as integer)}\nend run', String(point.x), String(point.y)]);
      } else {
        const focus = await page.evaluate(async target => {
          const tabs = window.aveApi.browserTabs;
          if (!tabs) throw new Error("Native browser focus API unavailable");
          return tabs.nativeSurface({ action: "focus", tabId: target.rendererTabId, webContentsId: target.targetId });
        }, { rendererTabId, targetId });
        expect(focus.ok).toBe(true);
      }
      await expect.poll(async () => (await control()).mode).toBe("human-paused");
      const paused = await control();
      expect(paused.generation).toBeGreaterThan(beforeTakeover.generation);
      expect(await browserTargetId(ctx.app, url)).toBe(targetId);
      attemptWhilePaused?.();
      await expect.poll(() => resumeAgent !== undefined).toBe(true);
      expect(pausedResult).toMatch(/"error"\s*:/);
      expect(pausedResult).toContain("paused");
      expect(await ctx.app.evaluate(async ({ webContents }, id) => {
        const target = webContents.fromId(id);
        if (!target) throw new Error("Paused native target unavailable");
        return target.executeJavaScript("document.body.dataset.clicks");
      }, targetId)).toBe("1");
      await ctx.app.evaluate(async ({ webContents }, id) => {
        const page = webContents.fromId(id);
        if (!page) throw new Error("Native takeover target unavailable");
        await page.executeJavaScript("document.getElementById('page-editor').focus()");
      }, targetId);
      if (foreground) {
        await expect.poll(async () => (await inspectBrowserTarget(app, host.windowId, url)).focusedContentsId).toBe(targetId);
      }
      if (osTyping) {
        await promisify(execFile)("/usr/bin/osascript", ["-e", 'on run argv\ntell application "System Events" to keystroke item 1 of argv\nend run', "PAGEKEYS"]);
      } else {
        await ctx.app.evaluate(({ webContents }, id) => {
          const target = webContents.fromId(id);
          if (!target) throw new Error("Native takeover target unavailable");
          target.sendInputEvent({ type: "keyDown", keyCode: "P" });
          target.sendInputEvent({ type: "char", keyCode: "P" });
          target.sendInputEvent({ type: "keyUp", keyCode: "P" });
        }, targetId);
      }
      await expect.poll(() => app.evaluate(async ({ webContents }, id) => {
        const target = webContents.fromId(id);
        if (!target) throw new Error("Native takeover target unavailable");
        return target.executeJavaScript("document.getElementById('page-editor').value");
      }, targetId)).toBe(osTyping ? "PAGEKEYS" : "P");
      await expect(composer).toHaveValue("unfinished rename draft");
      const resumed = await page.evaluate(async tab => {
        const tabs = window.aveApi.browserTabs;
        if (!tabs) throw new Error("Native browser resume API unavailable");
        return tabs.resume(tab);
      }, rendererTabId);
      expect(resumed.ok).toBe(true);
      const resumedControl = await control();
      expect(resumedControl.generation).toBeGreaterThan(paused.generation);
      expect(resumedControl).toMatchObject({ mode: "agent-active", owner: beforeTakeover.owner });
      await page.getByTestId("chat-side-panel-close").click();
      await expect.poll(async () => (await inspectBrowserTarget(app, host.windowId, url)).attached).toBe(false);
      await composer.focus();
      await page.evaluate(() => { (window as unknown as { pressEditorState: { blurs: number } }).pressEditorState.blurs = 0; });
      resumeAgent?.();
      await expect.poll(() => resumedClick !== undefined).toBe(true);
      resumedClick?.();
      await expect.poll(() => finish !== undefined).toBe(true);
      if (foreground) {
        await expect.poll(async () => (await inspectBrowserTarget(app, host.windowId, url)).focusedContentsId).toBe(host.chromeId);
      }
      if (osTyping) {
        await promisify(execFile)("/usr/bin/osascript", ["-e", 'on run argv\ntell application "System Events" to keystroke item 1 of argv\nend run', "HOSTKEYS"]);
      } else {
        await page.keyboard.type("HOSTKEYS");
      }
      await expect(composer).toHaveValue("unfinished rename draftHOSTKEYS");
      const finalEditor = await page.evaluate(() => ({
        active: document.activeElement?.id,
        blurs: (window as unknown as { pressEditorState: { blurs: number } }).pressEditorState.blurs,
        sameElement: document.activeElement === (window as unknown as { pressEditorState: { element: HTMLElement } }).pressEditorState.element,
      }));
      expect(finalEditor).toEqual({ active: "press-editor", blurs: 0, sameElement: true });
      const finalPage = await ctx.app.evaluate(async ({ webContents }, id) => {
        const target = webContents.fromId(id);
        if (!target) throw new Error("Native resumed target unavailable");
        return target.executeJavaScript("({clicks:document.body.dataset.clicks,trusted:document.body.dataset.trusted,activation:document.body.dataset.activation,value:document.getElementById('page-editor').value})");
      }, targetId);
      expect(finalPage).toEqual({ clicks: "2", trusted: "true", activation: "true", value: osTyping ? "PAGEKEYS" : "P" });
      expect(await browserTargetId(ctx.app, url)).toBe(targetId);
      const finalRouting = await inspectBrowserTarget(ctx.app, host.windowId, url);
      expect(finalRouting).toMatchObject({ id: targetId, attached: false, focusedHostFrame: finalRouting.hostFrame });
      expect(await control()).toMatchObject({ mode: "agent-active", generation: resumedControl.generation, owner: beforeTakeover.owner });
      expect(results.filter(result => /"error"\s*:/.test(result))).toEqual([pausedResult]);
    }
    finish?.();
    finish = undefined;
  } finally {
    approve = false;
    if (approvals) await approvals.catch(() => {});
    finish?.();
    if (ctx) await teardownSeededElectron(ctx);
    await new Promise<void>((r) => server.close(() => r()));
  }
}
