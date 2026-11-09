import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
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
  const ctx = await launchSeededElectron({
    homePrefix: join(homedir(), "sidebar-subagent-e2e-"),
    sessionId: parentId,
    sessionTitle: "Parent conversation",
    historyRows: [{ role: "user", content: "Delegate research" }],
    settings: { ...buildLlmSettings(), system: { sidebarState: "expanded" } },
  });
  try {
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
        return { viewport: { width: innerWidth, height: innerHeight }, parent: read(parentId), child: read(childId), orphan: read(orphanId), crossProject: read(crossProjectId) };
      }, { parentId, childId, orphanId, crossProjectId });
      expect(layout.viewport.width).toBe(width);
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
  } finally {
    await teardownSeededElectron(ctx, { terminate: true });
  }
});
