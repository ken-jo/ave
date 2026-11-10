import type { AgentSpawnEvent } from "../../../src/shared/subagent-events.js";
import { TEST_IDS } from "../../../src/shared/test-ids.js";
import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { test, expect } from "@playwright/test";
import { mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildLlmSettings, builtMainExists, launchSeededElectron, setWindowSize, teardownSeededElectron } from "./seeded-electron.js";

// Seed the owning stores and read through real IPC; the renderer gets no replacement API.
test("nests persisted sub-agent conversations at native window sizes and keeps orphans reachable", async ({ browserName: _browserName }, testInfo) => {
  expect(builtMainExists()).toBe(true);
  const parentId = "e2000000-bb11-4cc2-8dd3-eeeeeeeeeeee";
  const childId = "sub-aaaaaaaa-11111111-1111-4111-8111-111111111111";
  const orphanId = "sub-bbbbbbbb-22222222-2222-4222-8222-222222222222";
  const crossProjectId = "sub-cccccccc-33333333-3333-4333-8333-333333333333";
  const model = "sidebar-nesting-model";
  const childInstruction = "hold-sidebar-child-until-layout-checked";
  let spawnIssued = false;
  let heldChild: ServerResponse | undefined;
  const send = (response: ServerResponse, delta: Record<string, unknown>, finish: string | null) => {
    response.write(`data: ${JSON.stringify({ id: "sidebar-nesting", object: "chat.completion.chunk", created: 0, model,
      choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
  };
  const finish = (response: ServerResponse) => {
    send(response, { role: "assistant", content: "Running research completed." }, null);
    send(response, {}, "stop");
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
    const body = JSON.parse(Buffer.concat(chunks).toString()) as { messages: { role: string; content?: unknown }[] };
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    if (body.messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes(childInstruction))) {
      heldChild = response;
      response.flushHeaders();
      return;
    }
    if (!spawnIssued && body.messages.some((message) => message.role === "user" && JSON.stringify(message.content).includes("Start one running research child."))) {
      spawnIssued = true;
      send(response, { role: "assistant", tool_calls: [{ index: 0, id: "sidebar-running-research", type: "function", function: {
        name: "agent_spawn", arguments: JSON.stringify({ title: "Running research", instructions: childInstruction }),
      } }] }, null);
      send(response, {}, "tool_calls");
      response.end("data: [DONE]\n\n");
      return;
    }
    finish(response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const settings = buildLlmSettings("openai-compatible", model);
  (settings.llm as { vendors: Record<string, { baseUrl?: string }> }).vendors["openai-compatible"].baseUrl =
    `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  settings.system = { sidebarState: "expanded" };
  let ctx: Awaited<ReturnType<typeof launchSeededElectron>> | undefined;
  try {
    ctx = await launchSeededElectron({
      homePrefix: join(homedir(), "sidebar-subagent-e2e-"),
      sessionId: parentId,
      sessionTitle: "Parent conversation",
      historyRows: [{ role: "user", content: "Delegate research" }],
      settings,
    });
    const childStore = join(ctx.aveHome, "subagent", "sessions");
    mkdirSync(childStore, { recursive: true });
    for (const [id, originSessionId, title, projectRoot] of [
      [childId, parentId, "Nested research", undefined],
      [orphanId, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", "Orphan research", undefined],
      [crossProjectId, parentId, "Other project research", join(ctx.tempHome, "other-project")],
    ]) {
      writeFileSync(join(childStore, `${id}.jsonl`), `${JSON.stringify({ role: "assistant", content: `${title} result` })}\n`);
      writeFileSync(join(childStore, `${id}.meta.json`), JSON.stringify({ sessionKind: "subagent", originSessionId, subAgentTitle: title, spawnId: id, projectRoot }));
    }
    await ctx.page.reload();
    const { page } = ctx;
    const parent = page.getByTestId(`sidebar-row-session-${parentId}`);
    const child = page.getByTestId(`sidebar-row-session-${childId}`);
    const orphan = page.getByTestId(`sidebar-row-session-${orphanId}`);
    const crossProject = page.getByTestId(`sidebar-row-session-${crossProjectId}`);
    await expect(parent).toHaveAttribute("aria-expanded", "true");
    await expect(child).toBeVisible();
    await expect(page.getByTestId(`sidebar-conversation-glyph-${parentId}`)).toBeVisible();
    await expect(orphan).toBeVisible();
    await expect(crossProject).toBeVisible();
    const measurements = [];
    for (const width of [1280, 1024]) {
      await setWindowSize(ctx.app, width, 800);
      const layout = await page.evaluate(({ parentId, childId, orphanId, crossProjectId }) => {
        const rows = [...document.querySelectorAll<HTMLElement>('[role="treeitem"][data-tree-key^="session:"]')];
        const read = (id: string) => {
          const element = document.querySelector<HTMLElement>(`[data-testid="sidebar-row-session-${id}"]`);
          const title = document.querySelector<HTMLElement>(`[data-testid="sidebar-conversation-title-${id}"]`);
          if (!element || !title) throw new Error(`missing-session-row: ${id}`);
          const rect = element.getBoundingClientRect();
          const titleRect = title.getBoundingClientRect();
          return { id, index: rows.indexOf(element), level: Number(element.getAttribute("aria-level")), x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom, titleX: titleRect.x, titleWidth: titleRect.width };
        };
        const glyph = document.querySelector<HTMLElement>(`[data-testid="sidebar-conversation-glyph-${parentId}"]`);
        const toggle = document.querySelector<HTMLElement>(`[data-testid="sidebar-session-toggle-${parentId}"]`);
        if (!glyph || !toggle) throw new Error("missing-parent-controls");
        const glyphRect = glyph.getBoundingClientRect();
        const toggleRect = toggle.getBoundingClientRect();
        const controls = { glyphVisibility: getComputedStyle(glyph).visibility, glyphWidth: glyphRect.width, glyphRight: glyphRect.right, toggleX: toggleRect.x, toggleWidth: toggleRect.width };
        return { controls, viewport: { width: innerWidth, height: innerHeight }, parent: read(parentId), child: read(childId), orphan: read(orphanId), crossProject: read(crossProjectId) };
      }, { parentId, childId, orphanId, crossProjectId });
      expect(layout.viewport.width).toBe(width);
      expect(layout.controls.glyphVisibility).toBe("visible");
      expect(layout.controls.glyphWidth).toBeGreaterThan(0);
      expect(layout.controls.toggleWidth).toBeGreaterThan(0);
      expect(layout.controls.toggleX).toBeGreaterThanOrEqual(layout.controls.glyphRight);
      expect(layout.child.index).toBe(layout.parent.index + 1);
      expect(layout.child.level).toBe(layout.parent.level + 1);
      expect(layout.child.titleX).toBeGreaterThan(layout.parent.titleX);
      expect(layout.child.y).toBeGreaterThanOrEqual(layout.parent.bottom);
      expect(layout.child.titleWidth).toBeGreaterThan(0);
      expect(layout.child.right).toBeLessThanOrEqual(layout.viewport.width);
      expect(layout.child.bottom).toBeLessThanOrEqual(layout.viewport.height);
      expect(layout.orphan.level).toBe(layout.parent.level);
      expect(layout.crossProject.level).toBe(layout.parent.level);
      measurements.push(layout);
      await page.screenshot({ path: testInfo.outputPath(`nesting-${width}.png`) });
    }
    const measurementsPath = testInfo.outputPath("layout-measurements.json");
    writeFileSync(measurementsPath, JSON.stringify(measurements, null, 2));
    await testInfo.attach("layout-measurements.json", { path: measurementsPath, contentType: "application/json" });
    await page.getByTestId(`sidebar-session-toggle-${parentId}`).click();
    await expect(child).toHaveCount(0);
    await parent.focus();
    await page.keyboard.press("ArrowRight");
    await expect(child).toBeVisible();
    await page.keyboard.press("ArrowRight");
    await expect(child).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("subagent-conversation-dialog")).toContainText("Nested research result");
    await page.keyboard.press("Escape");
    await page.getByTestId(`sidebar-session-${orphanId}`).click();
    await expect(page.getByTestId("subagent-conversation-dialog")).toContainText("Orphan research result");
    await page.keyboard.press("Escape");
    await page.evaluate(async () => {
      await window.aveApi.setApiKey("openai-compatible", "sk-e2e-loopback-sidebar");
      const mode = await window.ave.permission.setMode("strict");
      if (!mode.ok) throw new Error("Could not select strict tool approval");
      const state = window as unknown as { sidebarSpawnEvents: AgentSpawnEvent[] };
      state.sidebarSpawnEvents = [];
      window.aveApi.onAgentSpawnEvent((event) => state.sidebarSpawnEvents.push(event));
    });
    const composer = page.locator('[data-composer-surface="main"] [data-testid="composer-textarea"]');
    const beforeSpawnFiles = new Set(readdirSync(childStore).filter((file) => file.endsWith(".jsonl")));
    await composer.fill("Start one running research child.");
    await composer.press("Enter");
    const approval = page.getByTestId(TEST_IDS.approvalDock).first();
    await expect(approval.getByTestId(TEST_IDS.approveButton)).toBeVisible();
    await approval.getByTestId(TEST_IDS.approveButton).click();
    await expect.poll(() => heldChild !== undefined).toBe(true);
    const childResponse = heldChild;
    if (!childResponse) throw new Error("Missing running child model response");
    const createdFiles = readdirSync(childStore).filter((file) => file.endsWith(".jsonl") && !beforeSpawnFiles.has(file));
    expect(createdFiles).toHaveLength(1);
    const [createdFile] = createdFiles;
    if (!createdFile) throw new Error("Missing newly created child transcript");
    const runningId = createdFile.slice(0, -".jsonl".length);
    expect(JSON.parse(readFileSync(join(childStore, `${runningId}.meta.json`), "utf8"))).toMatchObject({
      sessionKind: "subagent", originSessionId: parentId, subAgentTitle: "Running research",
    });
    const active = await page.evaluate(async (id) => {
      const result = await window.aveApi.chatSessions({ families: ["main", "subagent"], limit: 100,
        sidebar: { rootLimit: 100, expandedParentIds: [id] } });
      if (!result.sidebar) throw new Error("Missing authoritative sidebar projection");
      return result.sidebar.rows.filter((row) => row.running && row.family === "subagent");
    }, parentId);
    expect(active.map((row) => row.id)).toEqual([runningId]);
    const start = await page.evaluate(() => (window as unknown as { sidebarSpawnEvents: AgentSpawnEvent[] }).sidebarSpawnEvents.find((event) => event.type === "start"));
    expect(start).toMatchObject({ parentSessionId: parentId, title: "Running research" });
    expect(start).not.toHaveProperty("childSessionId");
    const running = page.getByTestId(`sidebar-row-session-${runningId}`);
    await expect(running).toBeVisible();
    await expect(running).toHaveAttribute("data-responding", "true");
    await expect(running).toHaveAttribute("aria-level", String(Number(await parent.getAttribute("aria-level")) + 1));
    await page.screenshot({ path: testInfo.outputPath("nesting-running.png") });
    await page.evaluate(async (sessionId) => {
      const updated = await window.aveApi.chatSessionUpdate({ sessionId, archived: true });
      if (!updated.ok) throw new Error("Could not archive the running branch parent");
      window.dispatchEvent(new Event("online"));
    }, parentId);
    await expect(parent).toHaveAttribute("data-archived", "true");
    await expect(parent).toHaveAttribute("data-session-context", "true");
    await expect(running).toHaveAttribute("data-responding", "true");
    await expect(running).toHaveAttribute("aria-level", String(Number(await parent.getAttribute("aria-level")) + 1));
    await page.screenshot({ path: testInfo.outputPath("nesting-archived-context.png") });
    await page.evaluate(async (sessionId) => {
      const updated = await window.aveApi.chatSessionUpdate({ sessionId, archived: false });
      if (!updated.ok) throw new Error("Could not restore the running branch parent");
      window.dispatchEvent(new Event("online"));
    }, parentId);
    await expect(parent).not.toHaveAttribute("data-archived");
    await expect(parent).not.toHaveAttribute("data-session-context");
    finish(childResponse);
    heldChild = undefined;
    await expect(running).not.toHaveAttribute("data-responding");

    const collapsedParentId = "e3000000-bb11-4cc2-8dd3-eeeeeeeeeeee";
    const offPageChildId = "sub-aaaaaaaa-55555555-5555-4555-8555-555555555555";
    const mainStore = join(ctx.aveHome, "sessions");
    for (let index = 0; index < 100; index += 1) {
      const id = `${index.toString(16).padStart(8, "0")}-1111-4111-8111-111111111111`;
      const path = join(mainStore, `${id}.jsonl`);
      writeFileSync(path, `${JSON.stringify({ role: "user", content: `Recent history ${index}` })}\n`);
      utimesSync(path, new Date("2020-01-01"), new Date("2020-01-01"));
    }
    writeFileSync(join(mainStore, `${collapsedParentId}.jsonl`), `${JSON.stringify({ role: "user", content: "Older delegated work" })}\n`);
    writeFileSync(join(mainStore, `${collapsedParentId}.meta.json`), JSON.stringify({ title: "Collapsed parent" }));
    const offPagePath = join(childStore, `${offPageChildId}.jsonl`);
    writeFileSync(offPagePath, `${JSON.stringify({ role: "assistant", content: "Off-page child result" })}\n`);
    writeFileSync(join(childStore, `${offPageChildId}.meta.json`), JSON.stringify({ sessionKind: "subagent", originSessionId: collapsedParentId, subAgentTitle: "Off-page child", spawnId: offPageChildId }));
    utimesSync(offPagePath, new Date("2000-01-01"), new Date("2000-01-01"));
    const initialPage = await page.evaluate(() => window.aveApi.chatSessions({ families: ["main", "subagent"], limit: 100 }));
    expect(initialPage.sessions).toHaveLength(100);
    expect(initialPage.sessions.map((row) => row.id)).not.toContain(offPageChildId);
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    const collapsedParent = page.getByTestId(`sidebar-row-session-${collapsedParentId}`);
    const offPageChild = page.getByTestId(`sidebar-row-session-${offPageChildId}`);
    await expect(collapsedParent).toHaveAttribute("aria-expanded", "false");
    await expect(offPageChild).toHaveCount(0);
    await page.getByTestId(`sidebar-session-toggle-${collapsedParentId}`).click();
    await expect(offPageChild).toBeVisible();
    await expect(offPageChild).toHaveAttribute("aria-level", String(Number(await collapsedParent.getAttribute("aria-level")) + 1));
    await page.screenshot({ path: testInfo.outputPath("nesting-expanded-off-page.png") });
  } finally {
    heldChild?.destroy();
    if (ctx) await teardownSeededElectron(ctx, { terminate: true });
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  }
});
