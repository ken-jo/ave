import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { areProjectWriteTargetsInside } from "../project-write-scope.js";

const ORIGINAL_PLATFORM = process.platform;

describe("Windows automatic project write scope", () => {
  beforeEach(() => setProcessPlatform("win32"));
  afterEach(() => setProcessPlatform(ORIGINAL_PLATFORM));

  const contains = (filePath: string, canonicalPath = filePath) =>
    areProjectWriteTargetsInside([{ filePath, canonicalPath }], ["c:/proj"], ["c:/proj"]);

  it("folds target separators and case like project roots", () => {
    expect(contains("C:\\Proj\\a.txt", "c:/proj/a.txt")).toBe(true);
  });

  it("does not accept a sibling sharing the project prefix", () => {
    expect(contains("c:\\proj2\\a.txt")).toBe(false);
  });

  it.each(["\\\\server\\share\\a.txt", "\\\\?\\c:\\proj\\a.txt", "c:proj\\a.txt", "\\proj\\a.txt"])(
    "does not auto-allow an ambiguous or network path %s", (filePath) => {
      expect(contains(filePath, "c:/proj/a.txt")).toBe(false);
    },
  );

  it("checks canonical containment as well as lexical containment", () => {
    expect(contains("c:\\proj\\a.txt", "c:/outside/a.txt")).toBe(false);
    expect(contains("c:\\outside\\a.txt", "c:/proj/a.txt")).toBe(false);
    expect(contains("c:\\proj\\a.txt", "//server/share/a.txt")).toBe(false);
  });

  it.each(["c:a.txt", "c:", "\\\\server\\share\\a.txt", "\\\\?\\c:\\proj\\a.txt", "\\proj\\a.txt", "/proj/a.txt"])(
    "checks original declarations before resolution erases ambiguous syntax %s", (declaredPath) => {
      expect(areProjectWriteTargetsInside([
        { filePath: "c:\\proj\\a.txt", canonicalPath: "c:/proj/a.txt" },
      ], ["c:/proj"], ["c:/proj"], [declaredPath])).toBe(false);
    },
  );

  it("accepts ordinary relative declarations resolved inside the project", () => {
    expect(areProjectWriteTargetsInside([
      { filePath: "c:\\proj\\a.txt", canonicalPath: "c:/proj/a.txt" },
    ], ["c:/proj"], ["c:/proj"], ["a.txt"])).toBe(true);
  });

  it("requires every target and at least one target", () => {
    expect(areProjectWriteTargetsInside([], ["c:/proj"], ["c:/proj"])).toBe(false);
    expect(areProjectWriteTargetsInside([
      { filePath: "c:\\proj\\a.txt", canonicalPath: "c:/proj/a.txt" },
      { filePath: "c:\\proj2\\b.txt", canonicalPath: "c:/proj2/b.txt" },
    ], ["c:/proj"], ["c:/proj"])).toBe(false);
  });
});
