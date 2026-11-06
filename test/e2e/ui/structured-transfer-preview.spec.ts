import { test, expect } from "@playwright/test";
import {
  setWindowSize,
  builtMainExists,
  launchSeededElectron,
  teardownSeededElectron,
} from "./seeded-electron.js";
import { TEST_IDS, chatSidePanelLauncherTestId } from "../../../src/shared/test-ids.js";

test("changed files distinguish completed and cancelled transfer destinations", async () => {
  expect(builtMainExists(), "Build the app before checking the transfer UI").toBe(true);
  const now = Date.now() - 10_000;
  const ctx = await launchSeededElectron({
    sessionTitle: "structured transfer preview",
    historyRows: [
      { role: "user", content: "Copy the assets and extract the archive.", createdAt: now },
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { id: "copy", name: "copy_path", source: "builtin", category: "write", input: { sourcePath: "original-assets", destinationPath: "copied-assets" } },
          { id: "extract", name: "extract_archive", source: "builtin", category: "write", input: { archivePath: "original-assets.tar", destinationPath: "unpacked-assets" } },
          { id: "cancelled", name: "copy_path", source: "builtin", category: "write", input: { sourcePath: "original-assets", destinationPath: "cancelled-assets" } },
        ],
        createdAt: now + 100,
      },
      {
        role: "tool_result", toolUseId: "copy", toolName: "copy_path",
        content: JSON.stringify({ ok: true, summary: { sourcePath: "original-assets", destinationPath: "copied-assets", files: 0, directories: 1, bytesWritten: 0 } }),
        createdAt: now + 200,
      },
      {
        role: "tool_result", toolUseId: "extract", toolName: "extract_archive",
        content: JSON.stringify({ ok: true, summary: { sourcePath: "original-assets.tar", destinationPath: "unpacked-assets", files: 0, directories: 1, bytesWritten: 0, archiveFormat: "tar" } }),
        createdAt: now + 300,
      },
      {
        role: "tool_result", toolUseId: "cancelled", toolName: "copy_path", isError: true, toolDisplay: { cancelled: true },
        content: JSON.stringify({ ok: false, code: "cancelled", cleanup: "removed", message: "Transfer cancelled" }),
        createdAt: now + 350,
      },
      { role: "assistant", content: "Two transfers completed and one was cancelled.", createdAt: now + 400 },
    ],
  });
  try {
    await setWindowSize(ctx.app, 1280, 860);
    const toggle = ctx.page.getByTestId(TEST_IDS.panePanelToggle);
    await expect(toggle).toBeVisible({ timeout: 20_000 });
    await toggle.click();
    await ctx.page.getByTestId(chatSidePanelLauncherTestId("file-browser")).click();
    // The one project tree (315307c02) files transfer destinations under "Changed"; "Session" lists only files the session read.
    const changedFilter = ctx.page.getByTestId("chat-side-panel-file-filter-changed");
    await changedFilter.click();
    await expect(changedFilter).toHaveAttribute("aria-pressed", "true");
    const files = ctx.page.getByTestId("chat-side-panel-file-tree");
    await expect(files).toBeVisible();
    await expect(files).toContainText("copied-assets");
    await expect(files).toContainText("unpacked-assets");
    await expect(files).not.toContainText("original-assets");
    const cancelledRow = files.getByRole("treeitem").filter({ hasText: "cancelled-assets" });
    await expect(cancelledRow.getByTestId("chat-side-panel-file-state")).toHaveText("중단됨");
    const screenshotPath = test.info().outputPath("structured-transfer-destinations.png");
    await ctx.page.screenshot({ path: screenshotPath });
    await test.info().attach("structured-transfer-destinations.png", {
      contentType: "image/png",
      path: screenshotPath,
    });
  } finally {
    await teardownSeededElectron(ctx);
  }
});
