import { test, expect } from "@playwright/test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { builtMainExists, launchSeededElectron } from "./seeded-electron.js";
import { openDocumentSessionFiles, openDocumentSessionFile, teardownDocumentPreview } from "./document-preview-flow.js";
import { openInlineSettings } from "./inline-settings.js";
import { wordDocumentFixture, textDocumentFixture } from "../../../src/__tests__/support/structured-document-fixtures.js";

test("optional engine absence keeps document outlines and an explicit installation surface", async () => {
  expect(builtMainExists()).toBe(true);
  const cache = join(process.cwd(), ".cache");
  mkdirSync(cache, { recursive: true });
  const directory = mkdtempSync(join(cache, "document-engine-ui-"));
  const names = ["report.docx", "report.odt", "report.hwpx"];
  writeFileSync(join(directory, names[0]!), wordDocumentFixture());
  writeFileSync(join(directory, names[1]!), textDocumentFixture());
  writeFileSync(join(directory, names[2]!), "A missing engine must not parse this as text.");
  const now = Date.now() - 10_000;
  const ctx = await launchSeededElectron({ sessionTitle: "optional document engine",
    historyRows: [
      { role: "user", content: "Inspect these local documents.", createdAt: now },
      { role: "assistant", content: "", createdAt: now + 1,
        toolCalls: names.map((name, index) => ({ id: `document-${index}`, name: "read_file", input: { path: join(directory, name) } })) },
      ...names.map((name, index) => ({ role: "tool_result", toolUseId: `document-${index}`, toolName: "read_file",
        content: `File: ${join(directory, name)}`, createdAt: now + 2 + index })),
      { role: "assistant", content: "Open a document in the panel.", createdAt: now + 10 },
    ],
  });
  try {
    writeFileSync(join(ctx.aveHome, "settings.json"), JSON.stringify({ permissions: { additionalDirectories: [directory] } }));
    await ctx.page.setViewportSize({ width: 1280, height: 860 });
    await openDocumentSessionFiles(ctx.page, directory);
    await openDocumentSessionFile(ctx.page, "report.docx");
    const preview = ctx.page.getByTestId("chat-side-panel-page-preview");
    await expect(preview).toContainText("First & safe");
    await expect(preview).toContainText("문서 텍스트 개요");
    await expect(preview.getByTestId("document-preview-live-strip")).toHaveCount(0);
    await expect(preview.locator("input, textarea, [contenteditable=true]")).toHaveCount(0);
    const outlineScreenshot = test.info().outputPath("document-engine-absent-outline.png");
    await ctx.page.screenshot({ path: outlineScreenshot });
    await test.info().attach("document-engine-absent-outline", { path: outlineScreenshot, contentType: "image/png" });
    await openDocumentSessionFile(ctx.page, "report.odt");
    await expect(preview).toContainText("Heading");
    await openDocumentSessionFile(ctx.page, "report.hwpx");
    await expect(preview.getByTestId("chat-side-panel-file-error")).toContainText("문서 엔진이 설치되지 않았습니다");
    await openInlineSettings(ctx.app, ctx.page, "chat");
    const installation = ctx.page.getByTestId("document-engine-install");
    await installation.scrollIntoViewIfNeeded();
    await expect(installation).toContainText("문서 엔진 설치");
    await expect(installation).toContainText("선택 사항");
    await expect(installation.getByTestId("document-engine-size")).toContainText("MiB");
    await expect(installation.getByRole("button", { name: "다운로드 및 설치" })).toBeEnabled();
    const screenshot = test.info().outputPath("document-engine-install.png");
    await installation.screenshot({ path: screenshot });
    await test.info().attach("document-engine-install", { path: screenshot, contentType: "image/png" });
  } finally {
    await teardownDocumentPreview(ctx);
    rmSync(directory, { recursive: true, force: true });
  }
});
