import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildE2eBaseSettings, builtMainExists, launchSeededElectron, teardownSeededElectron } from "./seeded-electron.js";
import * as XLSX from "xlsx";
import { offsetWorkbook } from "../../../src/__tests__/support/table-document-fixtures.js";
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

test("workbook panel edits raw values inline and reloads external changes", async () => {
  test.setTimeout(120_000);
  expect(builtMainExists()).toBe(true);
  mkdirSync(join(process.cwd(), ".cache"), { recursive: true });
  const directory = mkdtempSync(join(process.cwd(), ".cache", "xlsx-panel-ui-"));
  const path = join(directory, "panel-values.xlsx");
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, {
    A10001: { t: "s", v: "Existing cell" },
    B10002: { t: "n", v: 12 },
    "!ref": "A10001:B10002",
  }, "Values");
  writeFileSync(path, XLSX.write(workbook, { type: "buffer", bookType: "xlsx" }));
  const now = Date.now() - 10_000;
  const ctx = await launchSeededElectron({
    sessionTitle: "Workbook cell editing",
    settings: { ...buildE2eBaseSettings(true, "en"),
      features: { ...(buildE2eBaseSettings(true, "en").features as Record<string, unknown>), osToolSandbox: true },
      permissions: { additionalDirectories: [directory] } },
    historyRows: [
      { role: "user", content: "Inspect workbook values.", createdAt: now },
      { role: "assistant", content: "", createdAt: now + 1,
        toolCalls: [{ id: "panel-workbook-read", name: "read_file", input: { path } }] },
      { role: "tool_result", toolUseId: "panel-workbook-read", toolName: "read_file", content: `File: ${path}`, createdAt: now + 2 },
    ],
  });
  try {
    writeFileSync(join(ctx.aveHome, "settings.json"), JSON.stringify({
      ...buildE2eBaseSettings(true, "en"),
      features: { ...(buildE2eBaseSettings(true, "en").features as Record<string, unknown>), osToolSandbox: true },
      permissions: { additionalDirectories: [directory] },
    }));
    await ctx.app.evaluate(({ dialog }) => {
      const state = globalThis as typeof globalThis & { workbookConfirmations?: string[] };
      state.workbookConfirmations = [];
      dialog.showMessageBox = (async (...args: unknown[]) => {
        const options = args[args.length - 1] as { message?: string; detail?: string };
        state.workbookConfirmations!.push(`${options.message ?? ""}\n${options.detail ?? ""}`);
        throw new Error("Unexpected workbook confirmation");
      }) as typeof dialog.showMessageBox;
    });
    await ctx.page.setViewportSize({ width: 960, height: 860 });
    await ctx.page.getByTestId(TEST_IDS.panePanelToggle).click();
    await ctx.page.locator('[data-testid^="tool-activity-item-"]').filter({ hasText: "panel-values.xlsx" }).click();
    const grid = ctx.page.getByTestId("chat-side-panel-table-grid");
    await expect(grid).toContainText("12");
    await expect(ctx.page.getByTestId("xlsx-cell-editor")).toHaveCount(0);
    expect(await ctx.app.evaluate(() =>
      (globalThis as typeof globalThis & { workbookConfirmations: string[] }).workbookConfirmations)).toEqual([]);

    await grid.getByRole("gridcell", { name: "12", exact: true }).dblclick();
    const editor = ctx.page.getByTestId("xlsx-cell-editor");
    await expect(editor).toBeVisible();
    await expect(editor.locator("xpath=..")).toHaveAttribute("role", "gridcell");
    await expect(editor.getByRole("combobox", { name: "Value type" })).toHaveValue("number");
    const input = editor.getByRole("textbox", { name: "Cell value" });
    await expect(input).toHaveValue("12");
    await input.fill("84");
    const cdp = await ctx.page.context().newCDPSession(ctx.page);
    try {
      await cdp.send("Performance.enable");
      const screenshot = await cdp.send("Page.captureScreenshot", { format: "png", fromSurface: true });
      const screenshotPath = test.info().outputPath("workbook-inline-narrow.png");
      writeFileSync(screenshotPath, Buffer.from(screenshot.data, "base64"));
      await test.info().attach("workbook-inline-narrow", { path: screenshotPath, contentType: "image/png" });
      const layout = await cdp.send("Runtime.evaluate", {
        expression: `(() => {
          const editor = document.querySelector('[data-testid="xlsx-cell-editor"]');
          const grid = document.querySelector('[data-testid="chat-side-panel-table-grid"]');
          const preview = document.querySelector('[data-testid="chat-side-panel-table-preview"]');
          const geometry = (element) => element ? {
            box: element.getBoundingClientRect().toJSON(), clientWidth: element.clientWidth,
            scrollWidth: element.scrollWidth, clientHeight: element.clientHeight, scrollHeight: element.scrollHeight,
          } : null;
          return { viewport: { width: innerWidth, height: innerHeight }, editorParentRole: editor?.parentElement?.getAttribute('role'),
            editor: geometry(editor), grid: geometry(grid), preview: geometry(preview) };
        })()`,
        returnByValue: true,
      });
      const layoutPath = test.info().outputPath("workbook-inline-layout.json");
      writeFileSync(layoutPath, JSON.stringify(layout.result.value, null, 2));
      await test.info().attach("workbook-inline-layout", { path: layoutPath, contentType: "application/json" });
      const metricsPath = test.info().outputPath("workbook-inline-metrics.json");
      writeFileSync(metricsPath, JSON.stringify(await cdp.send("Performance.getMetrics"), null, 2));
      await test.info().attach("workbook-inline-metrics", { path: metricsPath, contentType: "application/json" });
    } finally { await cdp.detach(); }
    const editorBounds = await editor.boundingBox();
    const inputBounds = await input.boundingBox();
    expect(editorBounds).not.toBeNull();
    expect(inputBounds).not.toBeNull();
    expect(inputBounds!.width).toBeGreaterThan(20);
    expect(inputBounds!.x + inputBounds!.width).toBeLessThanOrEqual(editorBounds!.x + editorBounds!.width + 1);
    await input.press("Enter");
    await expect(ctx.page.getByTestId("xlsx-saved")).toHaveText("Saved");
    await expect(grid.getByRole("gridcell", { name: "84", exact: true })).toBeVisible();
    await expect(ctx.page.getByTestId("chat-side-panel-table-recalculation")).toHaveText("Needs recalculation");
    expect(XLSX.read(readFileSync(path), { type: "buffer" }).Sheets.Values!.B10002!.v).toBe(84);
    expect(await ctx.app.evaluate(() =>
      (globalThis as typeof globalThis & { workbookConfirmations: string[] }).workbookConfirmations)).toEqual([]);
    const savedScreenshot = test.info().outputPath("workbook-panel-saved.png");
    await ctx.page.screenshot({ path: savedScreenshot });
    await test.info().attach("workbook-panel-saved", { path: savedScreenshot, contentType: "image/png" });

    const savedBytes = readFileSync(path);
    const savedCell = grid.getByRole("gridcell", { name: "84", exact: true });
    await savedCell.click();
    await savedCell.press("Enter");
    await expect(input).toHaveValue("84");
    await input.fill("95");
    await input.press("Escape");
    await expect(editor).toHaveCount(0);
    expect(readFileSync(path).equals(savedBytes)).toBe(true);

    await savedCell.dblclick();
    await expect(input).toHaveValue("84");
    await input.fill("96");
    const external = XLSX.read(savedBytes, { type: "buffer" });
    external.Sheets.Values!.B10002!.v = 99;
    writeFileSync(path, XLSX.write(external, { type: "buffer", bookType: "xlsx" }));
    const externalBytes = readFileSync(path);
    await input.press("Enter");
    await expect(ctx.page.getByRole("alert")).toContainText("changed outside");
    expect(readFileSync(path).equals(externalBytes)).toBe(true);
    await ctx.page.getByRole("button", { name: "Reload", exact: true }).click();
    await expect(grid.getByRole("gridcell", { name: "99", exact: true })).toBeVisible();
    await expect(editor).toHaveCount(0);
    await grid.getByRole("gridcell", { name: "99", exact: true }).dblclick();
    await expect(input).toHaveValue("99");
    await input.press("Escape");
    expect(readFileSync(path).equals(externalBytes)).toBe(true);
    expect(await ctx.app.evaluate(() =>
      (globalThis as typeof globalThis & { workbookConfirmations: string[] }).workbookConfirmations)).toEqual([]);
    const screenshot = test.info().outputPath("workbook-panel-reloaded.png");
    await ctx.page.screenshot({ path: screenshot });
    await test.info().attach("workbook-panel-reloaded", { path: screenshot, contentType: "image/png" });
  } finally {
    await teardownSeededElectron(ctx, { terminate: true });
    rmSync(directory, { recursive: true, force: true });
  }
});
