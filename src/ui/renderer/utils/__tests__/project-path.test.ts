import { describe, expect, it } from "vitest";
import { componentsUnderRoot, isInsideRoot, prefixesUnderRoot } from "../project-path.js";

const NFC_ROOT = "/p/프로젝트".normalize("NFC");
const NFD_PATH = "/p/프로젝트/문서/메모.md".normalize("NFD");

describe("project-path", () => {
  it("compares an NFC root with NFD paths and hands back the path's own spelling", () => {
    expect(isInsideRoot(NFC_ROOT, NFD_PATH)).toBe(true);
    expect(componentsUnderRoot(NFC_ROOT, NFD_PATH)).toEqual(["문서".normalize("NFD"), "메모.md".normalize("NFD")]);
    expect(prefixesUnderRoot(NFC_ROOT, NFD_PATH)).toEqual([
      "/p/프로젝트/문서".normalize("NFD"),
      NFD_PATH,
    ]);
    expect(prefixesUnderRoot(NFC_ROOT, NFC_ROOT)).toEqual([]);
  });

  it("refuses siblings, parents and `..` segments", () => {
    expect(isInsideRoot("/work", "/workshop/a")).toBe(false);
    expect(isInsideRoot("/work/app", "/work")).toBe(false);
    expect(isInsideRoot("/work", "/work/../etc")).toBe(false);
    expect(componentsUnderRoot("/work", "/elsewhere")).toBeNull();
  });

  it("matches Windows spellings by drive case and either separator", () => {
    expect(prefixesUnderRoot("C:\\Work", "c:\\work\\src\\a.ts")).toEqual(["c:\\work\\src", "c:\\work\\src\\a.ts"]);
    expect(isInsideRoot("C:\\Work", "D:\\Work\\a.ts")).toBe(false);
    expect(isInsideRoot("/", "/etc")).toBe(true);
  });
});
