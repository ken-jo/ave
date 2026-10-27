import { test, expect } from "@playwright/test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildE2eBaseSettings, builtMainExists, launchSeededElectron, teardownSeededElectron } from "./seeded-electron.js";
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
