import { test, expect } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { builtMainExists, launchSeededElectron } from "./seeded-electron.js";
import { openDocumentSessionFiles, openDocumentSessionFile, teardownDocumentPreview } from "./document-preview-flow.js";
import { pdfFixture, presentationFixture } from "../../../src/__tests__/support/page-document-fixtures.js";

test("document pages render, navigate and refuse malformed files through the real host", async () => {
  expect(builtMainExists()).toBe(true);
  const cache = join(process.cwd(), ".cache");
  mkdirSync(cache, { recursive: true });
  const directory = mkdtempSync(join(cache, "page-preview-ui-"));
  const names = ["slides.pptx", "pages.pdf", "broken.pdf"];
  writeFileSync(join(directory, names[0]!), presentationFixture());
  writeFileSync(join(directory, names[1]!), pdfFixture());
  writeFileSync(join(directory, names[2]!), "%PDF-broken");
  const now = Date.now() - 10_000;
  const ctx = await launchSeededElectron({
    sessionTitle: "document page previews",
    historyRows: [
      { role: "user", content: "Inspect these documents.", createdAt: now },
      { role: "assistant", content: "", createdAt: now + 1,
        toolCalls: names.map((name, index) => ({ id: `page-${index}`, name: "read_file", input: { path: join(directory, name) } })) },
      ...names.map((name, index) => ({ role: "tool_result", toolUseId: `page-${index}`, toolName: "read_file",
        content: `File: ${join(directory, name)}`, createdAt: now + 2 + index })),
      { role: "assistant", content: "Open a document in the workspace panel.", createdAt: now + 10 },
    ],
  });
  try {
    writeFileSync(join(ctx.aveHome, "settings.json"), JSON.stringify({ permissions: { additionalDirectories: [directory] } }));
    await ctx.page.setViewportSize({ width: 1280, height: 860 });
    await openDocumentSessionFiles(ctx.page, directory);
    await openDocumentSessionFile(ctx.page, "slides.pptx");
    const preview = ctx.page.getByTestId("chat-side-panel-page-preview");
    await expect(preview).toContainText("First & safe");
    await expect(preview).toContainText("개요");
    await preview.getByRole("button", { name: "다음", exact: true }).click();
    await expect(preview).toContainText("Last slide");
    const outlineScreenshot = test.info().outputPath("document-outline.png");
    await ctx.page.screenshot({ path: outlineScreenshot });
    await test.info().attach("document-outline", { path: outlineScreenshot, contentType: "image/png" });
    await openDocumentSessionFile(ctx.page, "pages.pdf");
    await expect(ctx.page.getByTestId("chat-side-panel-pdf-page")).toBeVisible();
    await expect.poll(() => ctx.page.getByTestId("chat-side-panel-pdf-page").evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
    await expect(preview).toContainText("First PDF page");
    await preview.getByRole("button", { name: "다음", exact: true }).click();
    await expect(preview).toContainText("Second PDF page");
    await expect.poll(() => ctx.page.getByTestId("chat-side-panel-pdf-page").evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth > 0)).toBe(true);
    const screenshot = test.info().outputPath("document-pages.png");
    await ctx.page.screenshot({ path: screenshot });
    await test.info().attach("document-pages", { path: screenshot, contentType: "image/png" });
    await openDocumentSessionFile(ctx.page, "broken.pdf");
    await expect(ctx.page.getByTestId("chat-side-panel-file-error")).toContainText("손상");
  } finally {
    await teardownDocumentPreview(ctx);
    rmSync(directory, { recursive: true, force: true });
  }
});
