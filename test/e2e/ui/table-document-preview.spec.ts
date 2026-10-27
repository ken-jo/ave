import { writePermissionSettingsFixture } from "../../../src/__tests__/support/permission-settings-fixture.js";
import { test, expect, type Page } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { builtMainExists, launchSeededElectron } from "./seeded-electron.js";
import { openDocumentSessionFiles, openDocumentSessionFile, teardownDocumentPreview } from "./document-preview-flow.js";
import { PREVIEW_DOCUMENT_LIMITS } from "../../../src/shared/preview-document.js";
import { cyclicWorkbook, offsetWorkbook } from "../../../src/__tests__/support/table-document-fixtures.js";

/**
 * The grid is the only vertical scroller between itself and the side panel:
 * every `overflow: auto|scroll` ancestor up to the panel fits its content.
 */
async function gridScrollState(page: Page): Promise<{ gridScrolls: boolean; outerScrollers: string[] }> {
  return page.getByTestId("chat-side-panel-table-grid").evaluate((grid) => {
    const outerScrollers: string[] = [];
    for (let e = grid.parentElement; e && e.dataset.testid !== "chat-side-panel"; e = e.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 1) {
        outerScrollers.push(`${e.dataset.testid ?? e.className} ${e.clientHeight}/${e.scrollHeight}`);
      }
    }
    return { gridScrolls: grid.scrollHeight > grid.clientHeight + 1, outerScrollers };
  });
}

/** Height of the grid's horizontal scrollbar (0 when its columns fit or the bar overlays). */
async function gridHorizontalBarPx(page: Page): Promise<number> {
  return page.getByTestId("chat-side-panel-table-grid").evaluate((grid) => {
    const style = getComputedStyle(grid);
    const borders = parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
    return Math.round((grid as HTMLElement).offsetHeight - grid.clientHeight - borders);
  });
}

/**
 * macOS overlays scrollbars; Windows, Linux and macOS with "always show" draw
 * classic ones that take height from the rows. Force classic 10px bars on the
 * grid so the size math is checked against a bar that takes room.
 */
const CLASSIC_GRID_SCROLLBARS = `
  .ave-table-grid { scrollbar-color: auto !important; }
  .ave-table-grid::-webkit-scrollbar { width: 10px; height: 10px; }
  .ave-table-grid::-webkit-scrollbar-thumb { background: gray; }
`;

test("table previews show bounded counts, late source rows and explicit parser refusals", async () => {
  expect(builtMainExists(), "Build the app before checking table previews").toBe(true);
  const cache = join(process.cwd(), ".cache");
  mkdirSync(cache, { recursive: true });
  const dir = mkdtempSync(join(cache, "table-preview-ui-"));
  // Newest last: the launcher's tool-activity list shows only the five newest
  // calls, and the content-tab check below opens records.csv and wide.csv from it.
  const names = ["offset.xlsx", "broken.csv", "cyclic.xls", "wide-one-row.csv", "wide.csv", "records.csv"];
  const paths = names.map((name) => join(dir, name));
  const at = (name: string) => join(dir, name);
  writeFileSync(at("records.csv"), Array.from({ length: PREVIEW_DOCUMENT_LIMITS.maxRows + 2 }, (_, row) => `${row},value`).join("\n"));
  writeFileSync(at("offset.xlsx"), offsetWorkbook("xlsx"));
  writeFileSync(at("broken.csv"), 'a,b\n"unterminated,2');
  writeFileSync(at("cyclic.xls"), cyclicWorkbook());
  // 14 columns overflow the side panel's width, so the grid draws a horizontal bar.
  const wideRow = (row: number) => Array.from({ length: 14 }, (_, col) => `r${row}c${col}`).join(",");
  writeFileSync(at("wide.csv"), [0, 1, 2].map(wideRow).join("\n"));
  writeFileSync(at("wide-one-row.csv"), wideRow(0));
  const now = Date.now() - 10_000;
  const ctx = await launchSeededElectron({
    sessionTitle: "table preview validation",
    historyRows: [
      { role: "user", content: "Inspect these table files.", createdAt: now },
      { role: "assistant", content: "", createdAt: now + 100,
        toolCalls: paths.map((path, index) => ({ id: `table-${index}`, name: "read_file", input: { path } })),
      },
      ...paths.map((path, index) => ({
        role: "tool_result", toolUseId: `table-${index}`, toolName: "read_file",
        content: `File: ${path}`, createdAt: now + 200 + index,
      })),
      { role: "assistant", content: "The files are available in the workspace panel.", createdAt: now + 300 },
    ],
  });
  try {
    // This is the existing additional-directory grant, read fresh by preview IPC.
    writePermissionSettingsFixture(ctx.aveHome, JSON.stringify({ permissions: { additionalDirectories: [dir] } }));
    await ctx.page.setViewportSize({ width: 1280, height: 860 });
    await ctx.page.addStyleTag({ content: CLASSIC_GRID_SCROLLBARS });
    await openDocumentSessionFiles(ctx.page, dir);
    await openDocumentSessionFile(ctx.page, "records.csv");
    const preview = ctx.page.getByTestId("chat-side-panel-table-preview");
    await expect(preview).toContainText("최소");
    await expect(ctx.page.getByTestId("chat-side-panel-table-truncated")).toContainText("검사하지 않았습니다");
    await expect(ctx.page.getByTestId("chat-side-panel-table-grid")).toBeVisible();
    // A long sheet scrolls inside the grid only; the panel around it does not.
    expect(await gridScrollState(ctx.page)).toEqual({ gridScrolls: true, outerScrollers: [] });
    const boundedScreenshot = test.info().outputPath("bounded-table.png");
    await ctx.page.screenshot({ path: boundedScreenshot });
    await test.info().attach("bounded-table.png", { contentType: "image/png", path: boundedScreenshot });

    await openDocumentSessionFile(ctx.page, "offset.xlsx");
    await expect(ctx.page.getByTestId("chat-side-panel-table-grid")).toContainText("late value");
    await expect(ctx.page.getByTestId("chat-side-panel-table-grid")).toContainText("10001");
    // Two rows fit, so nothing scrolls at all.
    expect(await gridScrollState(ctx.page)).toEqual({ gridScrolls: false, outerScrollers: [] });

    await openDocumentSessionFile(ctx.page, "cyclic.xls");
    await expect(ctx.page.getByTestId("chat-side-panel-table-loading")).toBeVisible();
    await openDocumentSessionFile(ctx.page, "records.csv");
    await expect(ctx.page.getByTestId("chat-side-panel-table-grid")).toBeVisible();
    await expect(preview).toContainText("최소");

    await openDocumentSessionFile(ctx.page, "broken.csv");
    await expect(ctx.page.getByTestId("chat-side-panel-file-error")).toContainText("손상");

    await openDocumentSessionFile(ctx.page, "cyclic.xls");
    await expect(ctx.page.getByTestId("chat-side-panel-file-error")).toContainText("시간이나 메모리");
    const refusalScreenshot = test.info().outputPath("parser-refusal.png");
    await ctx.page.screenshot({ path: refusalScreenshot });
    await test.info().attach("parser-refusal.png", { contentType: "image/png", path: refusalScreenshot });

    // A short wide sheet: its rows fit, so the horizontal bar gets room of its
    // own instead of pushing the last row into a vertical scroll.
    for (const name of ["wide.csv", "wide-one-row.csv"]) {
      await openDocumentSessionFile(ctx.page, name);
      await expect(ctx.page.getByTestId("chat-side-panel-table-grid")).toContainText("r0c0");
      await expect.poll(() => gridHorizontalBarPx(ctx.page)).toBe(10);
      await expect.poll(() => gridScrollState(ctx.page)).toEqual({ gridScrolls: false, outerScrollers: [] });
    }

    // The same invariant in a content tab (a tool-activity row opens the file
    // in its own tab). The preview list never shows file targets
    // (ChatSidePanel filters FILE_TARGET_KINDS out of it), so it has no table host.
    const openInContentTab = async (name: string) => {
      await ctx.page.getByTestId("chat-side-panel-tab-strip").getByRole("button", { name: "탭 닫기" }).click();
      await ctx.page.locator('[data-testid^="tool-activity-item-"]').filter({ hasText: name }).click();
      await expect(ctx.page.getByTestId("chat-side-panel-content-view").getByTestId("chat-side-panel-table-grid")).toBeVisible();
    };
    await openInContentTab("records.csv");
    expect(await gridScrollState(ctx.page)).toEqual({ gridScrolls: true, outerScrollers: [] });
    await openInContentTab("wide.csv");
    await expect.poll(() => gridScrollState(ctx.page)).toEqual({ gridScrolls: false, outerScrollers: [] });
  } finally {
    await teardownDocumentPreview(ctx);
    rmSync(dir, { recursive: true, force: true });
  }
});
