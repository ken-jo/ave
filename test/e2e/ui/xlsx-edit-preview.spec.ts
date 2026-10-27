import { test, expect } from "@playwright/test";
import type { WebContents } from "electron";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash, randomBytes } from "node:crypto";
import JSZip from "jszip";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { buildE2eBaseSettings, buildLlmSettings, builtMainExists, launchSeededElectron, teardownSeededElectron } from "./seeded-electron.js";
import * as XLSX from "xlsx";
import { offsetWorkbook } from "../../../src/__tests__/support/table-document-fixtures.js";
import { CHANNELS } from "../../../src/contract/app-contract.js";
import { pluginPartitionName } from "../../../src/shared/plugin-partition.js";
import { TEST_IDS } from "../../../src/shared/test-ids.js";

test("edited workbook shows a recalculation badge through the real viewer", async () => {
  expect(builtMainExists()).toBe(true);
  const cache = join(process.cwd(), ".cache");
  mkdirSync(cache, { recursive: true });
  const directory = mkdtempSync(join(cache, "xlsx-edit-ui-"));
  const path = join(directory, "budget.xlsx");
  const request = join(directory, "edits.json");
  writeFileSync(path, offsetWorkbook("xlsx"));
  writeFileSync(request, JSON.stringify({ sheet: 0, edits: [{ cell: "B10002", value: 43 }] }));
  const edit = spawnSync(process.execPath,
    [join(process.cwd(), "dist/skill-scripts/edit-xlsx.cjs"), path, request],
    { encoding: "utf8", env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" } });
  expect(edit.status, edit.stderr).toBe(0);
  const now = Date.now() - 10_000;
  const ctx = await launchSeededElectron({
    sessionTitle: "Workbook editing",
    settings: buildE2eBaseSettings(),
    historyRows: [
      { role: "user", content: "Inspect the edited workbook.", createdAt: now },
      { role: "assistant", content: "", createdAt: now + 1,
        toolCalls: [{ id: "workbook-read", name: "read_file", input: { path } }] },
      { role: "tool_result", toolUseId: "workbook-read", toolName: "read_file", content: `File: ${path}`, createdAt: now + 2 },
      { role: "assistant", content: "The workbook requests recalculation.", createdAt: now + 3 },
    ],
  });
  try {
    writeFileSync(join(ctx.aveHome, "settings.json"), JSON.stringify({ permissions: { additionalDirectories: [directory] } }));
    await ctx.page.setViewportSize({ width: 1280, height: 860 });
    await ctx.page.getByTestId(TEST_IDS.panePanelToggle).click();
    await ctx.page.locator('[data-testid^="tool-activity-item-"]').filter({ hasText: "budget.xlsx" }).click();
    await expect(ctx.page.getByTestId("chat-side-panel-table-grid")).toContainText("43");
    await expect(ctx.page.getByTestId("chat-side-panel-table-recalculation")).toHaveText("재계산 필요");
    const screenshot = test.info().outputPath("workbook-recalculation.png");
    await ctx.page.screenshot({ path: screenshot });
    await test.info().attach("workbook-recalculation", { path: screenshot, contentType: "image/png" });
  } finally {
    await teardownSeededElectron(ctx, { terminate: true });
    rmSync(directory, { recursive: true, force: true });
  }
});

test("plugin webview asset navigation cannot reach workbook reads or observation acknowledgements", async () => {
  test.setTimeout(120_000);
  expect(builtMainExists()).toBe(true);
  mkdirSync(join(process.cwd(), ".cache"), { recursive: true });
  const directory = mkdtempSync(join(process.cwd(), ".cache", "xlsx-frame-ipc-"));
  const workbookPath = join(directory, "frame-values.xlsx");
  const hostPath = join(directory, "webview-host.html");
  const preloadPath = join(directory, "ipc-probe-preload.cjs");
  writeFileSync(workbookPath, offsetWorkbook("xlsx"));
  writeFileSync(hostPath, "<!doctype html><html><body></body></html>");
  // The test-owned preload models a renderer that can invoke raw host channels.
  writeFileSync(preloadPath, `const { contextBridge, ipcRenderer } = require("electron");
contextBridge.exposeInMainWorld("workbookIpcProbe", {
  invoke: (channel, args) => ipcRenderer.invoke(channel, ...args)
});`);
  const originalBytes = readFileSync(workbookPath);
  const settings = buildE2eBaseSettings(true, "en");
  const ctx = await launchSeededElectron({
    sessionTitle: "Workbook frame isolation", historyRows: [],
    settings: { ...settings,
      features: { ...(settings.features as Record<string, unknown>), osToolSandbox: true },
      permissions: { additionalDirectories: [directory] } },
  });
  try {
    writeFileSync(join(ctx.aveHome, "settings.json"), JSON.stringify({ ...settings,
      features: { ...(settings.features as Record<string, unknown>), osToolSandbox: true },
      permissions: { additionalDirectories: [directory] } }));
    const preview = await ctx.page.evaluate((path) => window.ave.preview.readDocument(path, 0, "e2000000-bb11-4cc2-8dd3-eeeeeeeeeeee"), workbookPath);
    if (!preview.ok) throw new Error(`Expected a host preview, got ${preview.error}`);
    expect(preview.observation?.targetId).toMatch(/^[a-f0-9-]{36}$/);
    const htmlUrl = pathToFileURL(join(process.cwd(), "dist/src/plugin-ui-shell.html")).href;
    const scriptUrl = pathToFileURL(join(process.cwd(), "dist/src/plugin-ui-shell.js")).href;
    const partition = pluginPartitionName(basename(directory));
    const proof = await ctx.app.evaluate(async ({ BrowserWindow, session }, input) => {
      const pluginSession = session.fromPartition(input.partition);
      const preloadId = pluginSession.registerPreloadScript({ type: "frame", filePath: input.preloadPath });
      const host = new BrowserWindow({ show: false,
        webPreferences: { webviewTag: true, contextIsolation: true, nodeIntegration: false, sandbox: true } });
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        await host.loadFile(input.hostPath);
        const attached = new Promise<WebContents>((resolve, reject) => {
          deadline = setTimeout(() => reject(new Error("Guest shell did not load")), 15_000);
          host.webContents.once("did-attach-webview", (_event, guest) => {
            guest.once("did-finish-load", () => { clearTimeout(deadline); resolve(guest); });
            guest.once("did-fail-load", (_event, code, description, _url, mainFrame) => {
              if (mainFrame) { clearTimeout(deadline); reject(new Error(`Guest shell load failed: ${code} ${description}`)); }
            });
          });
        });
        await host.webContents.executeJavaScript(`(() => {
          const guest = document.createElement('webview');
          guest.setAttribute('partition', ${JSON.stringify(input.partition)});
          guest.setAttribute('src', ${JSON.stringify(input.htmlUrl)});
          document.body.appendChild(guest);
        })()`);
        const guest = await attached;
        const invoke = (channel: string, ...args: unknown[]) => guest.executeJavaScript(
          `window.workbookIpcProbe.invoke(${JSON.stringify(channel)}, ${JSON.stringify(args)})`);
        const rawAck = { action: "rendered", targetId: input.targetId, sessionId: "e2000000-bb11-4cc2-8dd3-eeeeeeeeeeee", seq: 0 };
        const html = { url: guest.getURL(), type: guest.getType(),
          read: await invoke(input.readChannel, input.workbookPath, 0), ack: await invoke(input.ackChannel, rawAck),
          open: await invoke(input.openChannel, input.workbookPath) };
        const navigated = new Promise<void>((resolve, reject) => {
          deadline = setTimeout(() => reject(new Error("Guest script navigation did not finish")), 15_000);
          guest.once("did-finish-load", () => { clearTimeout(deadline); resolve(); });
          guest.once("did-fail-load", (_event, code, description, _url, mainFrame) => {
            if (mainFrame) { clearTimeout(deadline); reject(new Error(`Guest script load failed: ${code} ${description}`)); }
          });
        });
        await guest.executeJavaScript(`setTimeout(() => location.assign(${JSON.stringify(input.scriptUrl)}), 0); true`);
        await navigated;
        const script = { url: guest.getURL(), type: guest.getType(),
          read: await invoke(input.readChannel, input.workbookPath, 0), ack: await invoke(input.ackChannel, rawAck),
          readFile: await invoke(input.readFileChannel, input.workbookPath), open: await invoke(input.openChannel, input.workbookPath) };
        return { html, script, partition: input.partition, guestUsesPluginSession: guest.session === pluginSession,
          guestUsesDefaultSession: guest.session === session.defaultSession, guestFrameIsMain: guest.mainFrame.parent === null,
          hostType: host.webContents.getType(), hostUsesDefaultSession: host.webContents.session === session.defaultSession };
      } finally {
        clearTimeout(deadline);
        if (!host.isDestroyed()) host.destroy();
        pluginSession.unregisterPreloadScript(preloadId);
      }
    }, { hostPath, preloadPath, htmlUrl, scriptUrl, partition, workbookPath, targetId: preview.observation!.targetId,
      readChannel: CHANNELS.preview.readDocument, readFileChannel: CHANNELS.preview.readFile, ackChannel: CHANNELS.preview.observationAck,
      openChannel: CHANNELS.attach.openExternal });
    expect(proof.html).toMatchObject({ url: htmlUrl, type: "webview", read: { ok: false, error: "unauthorized" },
      ack: { ok: false, error: "unauthorized" }, open: { ok: false, error: "unauthorized" } });
    expect(proof.script).toMatchObject({ url: scriptUrl, type: "webview", read: { ok: false, error: "unauthorized" },
      ack: { ok: false, error: "unauthorized" }, readFile: { ok: false, error: "unauthorized" }, open: { ok: false, error: "unauthorized" } });
    expect(proof).toMatchObject({ guestUsesPluginSession: true, guestUsesDefaultSession: false, guestFrameIsMain: true,
      hostType: "window", hostUsesDefaultSession: true });
    expect(readFileSync(workbookPath).equals(originalBytes)).toBe(true);
    const evidence = test.info().outputPath("workbook-plugin-frame-ipc.json");
    writeFileSync(evidence, JSON.stringify(proof, null, 2));
    await test.info().attach("workbook-plugin-frame-ipc", { path: evidence, contentType: "application/json" });
  } finally {
    await teardownSeededElectron(ctx, { terminate: true });
    rmSync(directory, { recursive: true, force: true });
  }
});

test("approved agent edits stream into the read-only workbook panel", async () => {
  test.setTimeout(180_000);
  expect(builtMainExists()).toBe(true);
  mkdirSync(join(process.cwd(), ".cache"), { recursive: true });
  const directory = mkdtempSync(join(process.cwd(), ".cache", "xlsx-agent-live-"));
  const path = join(directory, "live-values.xlsx");
  const requestPath = join(directory, "edits.json");
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, {
    A10001: { t: "s", v: "Existing cell" }, B10002: { t: "n", v: 12 }, "!ref": "A10001:B10002",
  }, "Values");
  const archive = await JSZip.loadAsync(XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
  archive.file("xl/media/observation-fixture.bin", randomBytes(9 * 1024 * 1024));
  const originalBytes = await archive.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  writeFileSync(path, originalBytes);
  writeFileSync(requestPath, JSON.stringify({ sheet: 0, edits: [{ cell: "A10001", value: "Agent changed" }, { cell: "B10002", value: 84 }] }));
  let releaseEdit: (() => void) | undefined;
  let shellCommand = "";
  let modelCalls = 0;
  const toolResults: unknown[] = [];
  type ProvisionalFrame = { values: string[]; visible: boolean; snapshotReceived: boolean; frameTime: number };
  const provisionalFrames: Array<ProvisionalFrame & { sourceHash: string }> = [];
  let prepublicationProof: (ProvisionalFrame & { sourceHash: string; originalHash: string }) | undefined;
  const model = "document-observation-model";
  const send = (response: ServerResponse, delta: Record<string, unknown>, finish: string | null) => {
    response.write(`data: ${JSON.stringify({ id: "document-observation", object: "chat.completion.chunk", created: 0,
      model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  };
  const sendTool = (response: ServerResponse, id: string, name: string, args: Record<string, unknown>) => {
    send(response, { role: "assistant", tool_calls: [{ index: 0, id, type: "function",
      function: { name, arguments: JSON.stringify(args) } }] }, null);
    send(response, {}, "tool_calls");
    response.end("data: [DONE]\n\n");
  };
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: model, object: "model" }] }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages?: Array<{ role: string; content: unknown }> };
    toolResults.push(...(body.messages ?? []).filter((message) => message.role === "tool"));
    modelCalls += 1;
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    if (modelCalls === 1) { sendTool(response, "agent-open-workbook", "open_document", { path }); return; }
    if (modelCalls === 2) {
      releaseEdit = () => sendTool(response, "agent-edit-workbook", process.platform === "win32" ? "powershell" : "bash",
        { command: shellCommand, cwd: directory });
      response.flushHeaders();
      return;
    }
    send(response, { role: "assistant", content: "Workbook updated." }, null);
    send(response, {}, "stop");
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const settings = buildLlmSettings("openai-compatible", model);
  settings.appearance = buildE2eBaseSettings(true, "en").appearance;
  (settings.llm as { vendors: Record<string, { baseUrl?: string }> }).vendors["openai-compatible"].baseUrl =
    `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  settings.features = { ...(settings.features as Record<string, unknown>), osToolSandbox: true };
  const ctx = await launchSeededElectron({ sessionTitle: "Agent document observation", settings, historyRows: [] });
  try {
    writeFileSync(join(ctx.aveHome, "settings.json"), JSON.stringify({ permissions: { additionalDirectories: [directory],
      reviewer: { interactive: { autoApprove: "off" } } } }));
    const runtime = await ctx.app.evaluate(() => process.execPath);
    const argv = [runtime, join(process.cwd(), "dist/skill-scripts/edit-xlsx.cjs"), path, requestPath];
    const quoted = process.platform === "win32"
      ? argv.map((value) => `'${value.replaceAll("'", "''")}'`)
      : argv.map((value) => `'${value.replaceAll("'", "'\\''")}'`);
    shellCommand = process.platform === "win32"
      ? `$env:ELECTRON_RUN_AS_NODE='1'; & ${quoted.join(" ")}` : `ELECTRON_RUN_AS_NODE=1 ${quoted.join(" ")}`;
    await ctx.page.evaluate(async () => {
      await window.aveApi.setApiKey("openai-compatible", "sk-e2e-loopback-document");
      const mode = await window.ave.permission.setMode("strict");
      if (!mode.ok) throw new Error("Could not select strict tool approval");
      const state = window as unknown as { observedDocumentEvents: unknown[] };
      state.observedDocumentEvents = [];
      window.ave.preview.onDocumentObservation((events) => state.observedDocumentEvents.push(...events));
    });
    await ctx.page.exposeFunction("captureProvisionalDocumentFrame", (frame: ProvisionalFrame) => {
      const sourceHash = createHash("sha256").update(readFileSync(path)).digest("hex");
      const originalHash = createHash("sha256").update(originalBytes).digest("hex");
      provisionalFrames.push({ ...frame, sourceHash });
      if (!prepublicationProof && frame.visible && !frame.snapshotReceived && sourceHash === originalHash
        && JSON.stringify(frame.values) === JSON.stringify(["Agent changed", "84"])) {
        prepublicationProof = { ...frame, sourceHash, originalHash };
      }
    });
    await ctx.page.evaluate(() => {
      const proofWindow = window as unknown as {
        captureProvisionalDocumentFrame: (frame: { values: string[]; visible: boolean; snapshotReceived: boolean; frameTime: number }) => Promise<void>;
        observedDocumentEvents: Array<{ kind: string }>;
      };
      let scheduled = false;
      const capture = () => {
        if (scheduled) return;
        scheduled = true;
        requestAnimationFrame((frameTime) => {
          scheduled = false;
          const cells = Array.from(document.querySelectorAll<HTMLElement>(
            '[data-testid="chat-side-panel-table-grid"] [data-testid="document-cell-change"][data-advisory="true"]'));
          if (cells.length !== 2) return;
          const visible = cells.every((cell) => {
            const rect = cell.getBoundingClientRect();
            const style = getComputedStyle(cell);
            const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
            return rect.width > 0 && rect.height > 0 && cell.getClientRects().length > 0
              && style.visibility !== "hidden" && style.display !== "none" && !cell.closest("[inert]")
              && (hit === cell || cell.contains(hit));
          });
          void proofWindow.captureProvisionalDocumentFrame({ values: cells.map((cell) =>
            cell.querySelector('[data-testid="document-cell-value"]')?.textContent?.trim() ?? ""),
            visible, frameTime, snapshotReceived: proofWindow.observedDocumentEvents.some((event) => event.kind === "snapshot") });
        });
      };
      const observer = new MutationObserver(capture);
      observer.observe(document.body, { subtree: true, childList: true, characterData: true,
        attributes: true, attributeFilter: ["data-advisory"] });
    });
    await ctx.page.setViewportSize({ width: 960, height: 860 });
    const composer = ctx.page.locator('[data-composer-surface="main"] [data-testid="composer-textarea"]');
    await composer.fill("Observe agent workbook edits.");
    await composer.press("Enter");
    const openApproval = ctx.page.getByTestId(TEST_IDS.approvalDock).first();
    await expect(openApproval).toContainText("open_document", { timeout: 20_000 });
    await openApproval.getByTestId(TEST_IDS.approveButton).click();
    const grid = ctx.page.getByTestId("chat-side-panel-table-grid");
    await expect(grid).toContainText("12", { timeout: 30_000 });
    await expect(ctx.page.getByTestId("chat-side-panel-table-preview")
      .getByRole("button", { name: "Open in default app", exact: true })).toBeVisible();
    await expect.poll(() => typeof releaseEdit).toBe("function");
    await expect(grid.getByRole("gridcell", { name: "12", exact: true })).toBeVisible();
    await grid.getByRole("gridcell", { name: "12", exact: true }).dblclick();
    await expect(ctx.page.getByTestId("xlsx-cell-editor")).toHaveCount(0);
    expect(await ctx.page.evaluate(() => "editXlsx" in window.ave.preview)).toBe(false);
    releaseEdit!();
    const approval = ctx.page.getByTestId(TEST_IDS.approvalDock).first();
    await expect(approval.getByTestId(TEST_IDS.approveButton)).toBeVisible({ timeout: 20_000 });
    expect(readFileSync(path)).toEqual(originalBytes);
    await approval.getByTestId(TEST_IDS.approveButton).click();
    await expect.poll(() => prepublicationProof, { timeout: 30_000 }).toBeDefined();
    expect(prepublicationProof!.values).toEqual(["Agent changed", "84"]);
    expect(prepublicationProof!.sourceHash).toBe(prepublicationProof!.originalHash);
    expect(prepublicationProof!.visible).toBe(true);
    expect(prepublicationProof!.snapshotReceived).toBe(false);
    const provisionalPath = test.info().outputPath("agent-document-prepublication.json");
    writeFileSync(provisionalPath, JSON.stringify(prepublicationProof, null, 2));
    await test.info().attach("agent-document-prepublication", { path: provisionalPath, contentType: "application/json" });
    const provisionalScreenshot = test.info().outputPath("agent-document-provisional.png");
    await ctx.page.screenshot({ path: provisionalScreenshot });
    await test.info().attach("agent-document-provisional", { path: provisionalScreenshot, contentType: "image/png" });
    await expect.poll(() => modelCalls, { timeout: 30_000 }).toBeGreaterThanOrEqual(3);
    const published = XLSX.read(readFileSync(path), { type: "buffer" }).Sheets.Values!;
    expect(published.B10002!.v, JSON.stringify(toolResults)).toBe(84);
    await expect(grid.getByRole("gridcell", { name: "84", exact: true })).toBeVisible({ timeout: 30_000 });
    await expect(grid).toContainText("Agent changed");
    await expect(ctx.page.getByTestId("chat-side-panel-table-recalculation")).toHaveText("Needs recalculation");
    await expect(ctx.page.getByTestId("chat-main-column").getByText("Workbook updated.", { exact: true })).toBeVisible();
    const actual = XLSX.read(readFileSync(path), { type: "buffer" }).Sheets.Values!;
    expect(actual.A10001!.v).toBe("Agent changed");
    expect(actual.B10002!.v).toBe(84);
    expect(readFileSync(`${path}.ave-bak`)).toEqual(originalBytes);
    const events = await ctx.page.evaluate(() =>
      (window as unknown as { observedDocumentEvents: Array<{ actor: string; kind: string; advisory?: boolean; seq: number }> }).observedDocumentEvents);
    expect(events.every((event) => event.actor === "agent")).toBe(true);
    expect(events.filter((event) => event.kind === "element" && event.advisory).length).toBeGreaterThanOrEqual(2);
    const snapshot = events.find((event) => event.kind === "snapshot");
    expect(snapshot).toBeDefined();
    expect(events.some((event) => event.kind === "element" && event.advisory && event.seq < snapshot!.seq)).toBe(true);
    const evidence = test.info().outputPath("agent-document-events.json");
    writeFileSync(evidence, JSON.stringify(events, null, 2));
    await test.info().attach("agent-document-events", { path: evidence, contentType: "application/json" });
    const cdp = await ctx.page.context().newCDPSession(ctx.page);
    try {
      const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
      const screenshotPath = test.info().outputPath("agent-document-live-narrow.png");
      writeFileSync(screenshotPath, Buffer.from(screenshot.data, "base64"));
      await test.info().attach("agent-document-live-narrow", { path: screenshotPath, contentType: "image/png" });
      const layout = await cdp.send("Runtime.evaluate", { expression: `(() => {
        const grid = document.querySelector('[data-testid="chat-side-panel-table-grid"]');
        const preview = document.querySelector('[data-testid="chat-side-panel-table-preview"]');
        return { viewport: { width: innerWidth, height: innerHeight },
          grid: grid?.getBoundingClientRect().toJSON(), preview: preview?.getBoundingClientRect().toJSON(),
          inputs: preview?.querySelectorAll('input,textarea,select').length };
      })()`, returnByValue: true });
      const layoutPath = test.info().outputPath("agent-document-layout.json");
      writeFileSync(layoutPath, JSON.stringify(layout.result.value, null, 2));
      await test.info().attach("agent-document-layout", { path: layoutPath, contentType: "application/json" });
      expect(layout.result.value.inputs).toBe(0);
      expect(layout.result.value.grid.width).toBeLessThanOrEqual(layout.result.value.preview.width + 1);
    } finally { await cdp.detach(); }
  } catch (error) {
    const diagnostic = {
      toolResults, modelCalls, provisionalFrames, backup: existsSync(`${path}.ave-bak`),
      bytes: existsSync(path) ? readFileSync(path).length : null,
      events: await ctx.page.evaluate(() => (window as unknown as { observedDocumentEvents: unknown[] }).observedDocumentEvents).catch(() => []),
    };
    const failurePath = test.info().outputPath("agent-document-failure.json");
    writeFileSync(failurePath, JSON.stringify(diagnostic, null, 2));
    await test.info().attach("agent-document-failure", { path: failurePath, contentType: "application/json" });
    await ctx.page.screenshot({ path: test.info().outputPath("agent-document-failure.png") }).catch(() => {});
    throw error;
  } finally {
    await teardownSeededElectron(ctx, { terminate: true });
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});

test("approved native edits highlight lines in the read-only code viewer", async () => {
  test.setTimeout(120_000);
  expect(builtMainExists()).toBe(true);
  mkdirSync(join(process.cwd(), ".cache"), { recursive: true });
  const directory = mkdtempSync(join(process.cwd(), ".cache", "code-agent-live-"));
  const path = join(directory, "live-observation.ts");
  const original = Array.from({ length: 18 }, (_,index) => `export const value${index + 1} = ${index + 1};`).join("\n") + "\n";
  const oldText = "export const value11 = 11;\nexport const value12 = 12;";
  const newText = "export const value11 = 21;\nexport const value12 = 22;";
  writeFileSync(path, original);
  const model = "text-observation-model";
  let modelCalls = 0;
  const toolResults: unknown[] = [];
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/v1/models") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ object: "list", data: [{ id: model, object: "model" }] }));
      return;
    }
    if (request.method !== "POST" || request.url !== "/v1/chat/completions") { response.writeHead(404).end(); return; }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { messages?: Array<{ role: string; content: unknown }> };
    toolResults.push(...(body.messages ?? []).filter((message) => message.role === "tool"));
    modelCalls += 1;
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const send = (delta: Record<string, unknown>, finish: string | null) => response.write(`data: ${JSON.stringify({
      id: "text-observation", object: "chat.completion.chunk", created: 0, model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    })}\n\n`);
    if (modelCalls <= 2) {
      send({ role: "assistant", tool_calls: [{ index: 0, id: `text-observation-${modelCalls}`, type: "function",
        function: { name: modelCalls === 1 ? "read_file" : "edit_file",
          arguments: JSON.stringify(modelCalls === 1 ? { path } : { path, oldText, newText }) } }] }, null);
      send({}, "tool_calls");
    } else { send({ role: "assistant", content: "Code updated." }, null); send({}, "stop"); }
    response.end("data: [DONE]\n\n");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const settings = buildLlmSettings("openai-compatible", model);
  settings.appearance = buildE2eBaseSettings(true, "en").appearance;
  (settings.llm as { vendors: Record<string, { baseUrl?: string }> }).vendors["openai-compatible"].baseUrl =
    `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const now = Date.now() - 10_000;
  const ctx = await launchSeededElectron({ sessionTitle: "Agent code observation", settings,
    historyRows: [
      { role: "user", content: "Inspect the code file.", createdAt: now },
      { role: "assistant", content: "", createdAt: now + 1,
        toolCalls: [{ id: "existing-code-read", name: "read_file", input: { path } }] },
      { role: "tool_result", toolUseId: "existing-code-read", toolName: "read_file", content: original, createdAt: now + 2 },
      { role: "assistant", content: "The code is ready to inspect.", createdAt: now + 3 },
    ] });
  try {
    writeFileSync(join(ctx.aveHome, "settings.json"), JSON.stringify({ permissions: { additionalDirectories: [directory],
      reviewer: { interactive: { autoApprove: "off" } } } }));
    await ctx.page.setViewportSize({ width: 960, height: 860 });
    await ctx.page.getByTestId(TEST_IDS.panePanelToggle).click();
    await ctx.page.locator('[data-testid^="tool-activity-item-"]').filter({ hasText: "live-observation.ts" }).click();
    const preview = ctx.page.getByTestId("chat-side-panel-file-preview");
    await expect(preview).toContainText("export const value11 = 11;");
    await expect(preview.getByTestId("document-preview-header")).toHaveCount(1);
    await expect(preview.getByRole("button", { name: "Open in default app", exact: true })).toBeVisible();
    await expect(preview.getByTestId("document-preview-live-strip")).toHaveCount(0);
    await ctx.page.evaluate(async () => {
      await window.aveApi.setApiKey("openai-compatible", "sk-e2e-loopback-text");
      const mode = await window.ave.permission.setMode("strict");
      if (!mode.ok) throw new Error("Could not select strict tool approval");
      const state = window as unknown as { observedTextEvents: unknown[] };
      state.observedTextEvents = [];
      window.ave.preview.onDocumentObservation((events) => state.observedTextEvents.push(...events));
    });
    const composer = ctx.page.locator('[data-composer-surface="main"] [data-testid="composer-textarea"]');
    await composer.fill("Update the two constants and show the agent changes.");
    await composer.press("Enter");
    const readApproval = ctx.page.getByTestId(TEST_IDS.approvalDock).first();
    await expect(readApproval).toContainText("read_file", { timeout: 20_000 });
    await readApproval.getByTestId(TEST_IDS.approveButton).click();
    const editApproval = ctx.page.getByTestId(TEST_IDS.approvalDock).first();
    await expect(editApproval).toContainText("edit_file", { timeout: 20_000 });
    expect(readFileSync(path, "utf8")).toBe(original);
    await editApproval.getByTestId(TEST_IDS.approveButton).click();
    await expect(preview.getByTestId("document-line-change")).toHaveCount(2, { timeout: 30_000 });
    await expect(preview.getByTestId("document-line-change").filter({ hasText: "value11" })).toContainText("export const value11 = 21;");
    await expect(preview.getByTestId("document-line-change").filter({ hasText: "value12" })).toContainText("export const value12 = 22;");
    await expect(preview.getByTestId("document-preview-live-strip")).toContainText("Agent");
    await expect(preview.getByTestId("document-preview-footer")).toContainText("TypeScript");
    await expect(preview.getByTestId("document-preview-footer")).toContainText("18");
    await expect(preview.locator("input,textarea,select")).toHaveCount(0);
    await expect(ctx.page.getByTestId("chat-main-column").getByText("Code updated.", { exact: true })).toBeVisible();
    expect(readFileSync(path, "utf8"), JSON.stringify(toolResults)).toBe(original.replace(oldText, newText));
    const events = await ctx.page.evaluate(() =>
      (window as unknown as { observedTextEvents: Array<{ actor: string; kind: string; element?: { kind: string; line: number }; before: unknown; after: unknown }> }).observedTextEvents);
    expect(events.every((event) => event.actor === "agent")).toBe(true);
    expect(events.filter((event) => event.kind === "element").map((event) => ({ element: event.element, before: event.before, after: event.after })))
      .toEqual([
        { element: { kind: "line", line: 11 }, before: "export const value11 = 11;", after: "export const value11 = 21;" },
        { element: { kind: "line", line: 12 }, before: "export const value12 = 12;", after: "export const value12 = 22;" },
      ]);
    const eventPath = test.info().outputPath("agent-code-events.json");
    writeFileSync(eventPath, JSON.stringify(events, null, 2));
    await test.info().attach("agent-code-events", { path: eventPath, contentType: "application/json" });
    const cdp = await ctx.page.context().newCDPSession(ctx.page);
    try {
      const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
      const screenshotPath = test.info().outputPath("agent-code-live-narrow.png");
      writeFileSync(screenshotPath, Buffer.from(screenshot.data, "base64"));
      await test.info().attach("agent-code-live-narrow", { path: screenshotPath, contentType: "image/png" });
      const layout = await cdp.send("Runtime.evaluate", { expression: `(() => {
        const preview = document.querySelector('[data-testid="chat-side-panel-file-preview"]');
        const header = preview?.querySelector('[data-testid="document-preview-header"]');
        const current = preview?.querySelector('[data-testid="document-line-change"][data-current="true"]');
        return { viewport: { width: innerWidth, height: innerHeight },
          preview: preview?.getBoundingClientRect().toJSON(), header: header?.getBoundingClientRect().toJSON(),
          inputs: preview?.querySelectorAll('input,textarea,select').length,
          current: current?.getBoundingClientRect().toJSON(), agentColor: getComputedStyle(document.documentElement).getPropertyValue('--agent') };
      })()`, returnByValue: true });
      const layoutPath = test.info().outputPath("agent-code-layout.json");
      writeFileSync(layoutPath, JSON.stringify(layout.result.value, null, 2));
      await test.info().attach("agent-code-layout", { path: layoutPath, contentType: "application/json" });
      expect(layout.result.value.inputs).toBe(0);
      expect(layout.result.value.header.height).toBeLessThanOrEqual(48);
      expect(layout.result.value.header.width).toBeLessThanOrEqual(layout.result.value.preview.width + 1);
      expect(layout.result.value.current.width).toBeGreaterThan(0);
      expect(layout.result.value.agentColor.trim()).not.toBe("");
    } finally { await cdp.detach(); }
  } finally {
    await teardownSeededElectron(ctx, { terminate: true });
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    rmSync(directory, { recursive: true, force: true });
  }
});
