import { describe, expect, it } from "vitest";
import { canOpenInDefaultApp, previewSupportsExternalOpen } from "../preview-external-open.js";

describe("passive preview default-app formats", () => {
  it.each(["book.xlsx", "book.xls", "table.csv", "table.tsv", "book.ods", "slides.pptx", "document.pdf",
    "notes.txt", "README.md", "data.json", "image.png", "image.jpeg", "image.webp",
    "C:\\workspace\\BOOK.XLSX"])("allows the passive preview format %s", (path) => {
    expect(previewSupportsExternalOpen(path)).toBe(true);
  });

  it.each(["run.command", "run.tool", "run.js", "run.mjs", "run.cjs", "run.wsf", "run.wsh", "run.jse", "run.vbs", "run.desktop",
    "run.sh", "run.ps1", "run.bat", "run.cmd", "run.exe", "run.py", "run.rb", "run.scpt", "run.workflow",
    "shortcut.lnk", "shortcut.url", "shortcut.webloc", "page.html", "page.xhtml", "image.svg", "data.xml", "no-extension", "folder.ts/no-extension",
    // Source code previews, but the default app is given only documents, media, plain data and zip.
    "source.ts", "source.tsx", "style.css", "report.pdf.exe"])
  ("requires separate picker authority for %s", (path) => {
    expect(previewSupportsExternalOpen(path)).toBe(false);
  });
});

describe("canOpenInDefaultApp", () => {
  it("decides by the last extension and refuses a name without one", () => {
    expect(canOpenInDefaultApp("/w/archive.exe.zip")).toBe(true);
    expect(canOpenInDefaultApp("C:\\w\\DATA.SQLITE")).toBe(true);
    for (const path of ["/w/report.pdf.exe", "/w/Makefile", "/w/notes.", "/w/a.svg", "/w/a.xml", "/w/a.html", "/w/a.py"]) {
      expect(canOpenInDefaultApp(path)).toBe(false);
    }
  });
});
