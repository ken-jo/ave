import { describe, expect, it } from "vitest";
import { previewSupportsExternalOpen } from "../preview-external-open.js";

describe("passive preview default-app formats", () => {
  it.each(["book.xlsx", "book.xls", "table.csv", "table.tsv", "book.ods", "slides.pptx", "document.pdf",
    "source.ts", "source.tsx", "notes.txt", "README.md", "data.json", "style.css", "image.png", "image.jpeg", "image.webp",
    "C:\\workspace\\BOOK.XLSX"])("allows the passive preview format %s", (path) => {
    expect(previewSupportsExternalOpen(path)).toBe(true);
  });

  it.each(["run.command", "run.tool", "run.js", "run.mjs", "run.cjs", "run.wsf", "run.wsh", "run.jse", "run.vbs", "run.desktop",
    "run.sh", "run.ps1", "run.bat", "run.cmd", "run.exe", "run.py", "run.rb", "run.scpt", "run.workflow",
    "shortcut.lnk", "shortcut.url", "shortcut.webloc", "page.html", "page.xhtml", "image.svg", "data.xml", "no-extension", "folder.ts/no-extension"])
  ("requires separate picker authority for %s", (path) => {
    expect(previewSupportsExternalOpen(path)).toBe(false);
  });
});
