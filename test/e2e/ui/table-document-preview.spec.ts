import { test, expect } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { builtMainExists, launchSeededElectron, teardownSeededElectron } from "./seeded-electron.js";
import { PREVIEW_DOCUMENT_LIMITS } from "../../../src/shared/preview-document.js";
import { cyclicWorkbook, offsetWorkbook } from "../../../src/__tests__/support/table-document-fixtures.js";
import { TEST_IDS, chatSidePanelLauncherTestId } from "../../../src/shared/test-ids.js";

test("table previews show bounded counts, late source rows and explicit parser refusals", async () => {
  expect(builtMainExists(), "Build the app before checking table previews").toBe(true);
  const cache = join(process.cwd(), ".cache");
  mkdirSync(cache, { recursive: true });
  const dir = mkdtempSync(join(cache, "table-preview-ui-"));
  const paths = ["records.csv", "offset.xlsx", "broken.csv", "cyclic.xls"].map((name) => join(dir, name));
  writeFileSync(paths[0]!, Array.from({ length: PREVIEW_DOCUMENT_LIMITS.maxRows + 2 }, (_, row) => `${row},value`).join("\n"));
  writeFileSync(paths[1]!, offsetWorkbook("xlsx"));
  writeFileSync(paths[2]!, 'a,b\n"unterminated,2');
  writeFileSync(paths[3]!, cyclicWorkbook());
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
    writeFileSync(join(ctx.aveHome, "settings.json"), JSON.stringify({ permissions: { additionalDirectories: [dir] } }));
    await ctx.page.setViewportSize({ width: 1280, height: 860 });
    await ctx.page.getByTestId(TEST_IDS.panePanelToggle).click();
    await ctx.page.getByTestId(chatSidePanelLauncherTestId("file-browser")).click();
    await ctx.page.getByTestId("chat-side-panel-file-source-session").click();
    const file = (name: string) => ctx.page.getByTestId("chat-side-panel-file-tree-file").filter({ hasText: name });
    await file("records.csv").click();
    const preview = ctx.page.getByTestId("chat-side-panel-table-preview");
    await expect(preview).toContainText("최소");
    await expect(ctx.page.getByTestId("chat-side-panel-table-truncated")).toContainText("검사하지 않았습니다");
    await expect(ctx.page.getByTestId("chat-side-panel-table-grid")).toBeVisible();
    const boundedScreenshot = test.info().outputPath("bounded-table.png");
    await ctx.page.screenshot({ path: boundedScreenshot });
    await test.info().attach("bounded-table.png", { contentType: "image/png", path: boundedScreenshot });

    await file("offset.xlsx").click();
    await expect(ctx.page.getByTestId("chat-side-panel-table-grid")).toContainText("late value");
    await expect(ctx.page.getByTestId("chat-side-panel-table-grid")).toContainText("10001");

    await file("cyclic.xls").click();
    await expect(ctx.page.getByTestId("chat-side-panel-table-loading")).toBeVisible();
    await file("records.csv").click();
    await expect(ctx.page.getByTestId("chat-side-panel-table-grid")).toBeVisible();
    await expect(preview).toContainText("최소");

    await file("broken.csv").click();
    await expect(ctx.page.getByTestId("chat-side-panel-file-error")).toContainText("손상");

    await file("cyclic.xls").click();
    await expect(ctx.page.getByTestId("chat-side-panel-file-error")).toContainText("시간이나 메모리");
    const refusalScreenshot = test.info().outputPath("parser-refusal.png");
    await ctx.page.screenshot({ path: refusalScreenshot });
    await test.info().attach("parser-refusal.png", { contentType: "image/png", path: refusalScreenshot });
  } finally {
    await teardownSeededElectron(ctx);
    rmSync(dir, { recursive: true, force: true });
  }
});
