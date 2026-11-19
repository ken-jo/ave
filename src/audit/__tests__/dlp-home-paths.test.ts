import { describe, expect, it, vi } from "vitest";
import { win32 } from "node:path";
import { pathToFileURL } from "node:url";
const fixture = vi.hoisted(() => ({ home: `D:/fixtures/${"long-root/".repeat(18)}home` }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const overrides = { homedir: () => fixture.home, platform: () => "win32" as const };
  return { ...actual, ...overrides, default: { ...actual, ...overrides } };
});
import { redactFsPath, redactHomePathsInText } from "../dlp-filter.js";
describe("home paths with mixed Windows spellings", () => {
  const nativeHome = win32.normalize(fixture.home);
  it.each([nativeHome, nativeHome.toUpperCase(), fixture.home, fixture.home.toUpperCase(), fixture.home.replace("fixtures/", "fixtures\\")])("redacts a home prefix in a path: %s", (home) => {
    expect(redactFsPath(`${home}\\private\\output`)).toBe("<home>\\private\\output");
    expect(redactHomePathsInText(`Target ${home}\\private\\output`)).toBe("Target [home]\\private\\output");
  });
  it("redacts native and standard file URL forms", () => {
    expect(redactFsPath(`file://${nativeHome}\\private`)).toBe("file://<home>/private");
    expect(redactHomePathsInText(`Target file://${nativeHome}\\private`)).toBe("Target file://[home]\\private");
    expect(redactFsPath(`${pathToFileURL(fixture.home)}/private`)).toBe("file://<home>/private");
  });
  const spellings = [nativeHome, nativeHome.toUpperCase(), fixture.home, fixture.home.toUpperCase(), fixture.home.replace("fixtures/", "fixtures\\")];
  const siblings = [...new Set(spellings.flatMap(home => ["2", ".bak", "-x"].flatMap(suffix => [
    `${home}${suffix}\\Output`, `${home}${suffix}/Output`, `file://${home}${suffix}\\Output`, `${pathToFileURL(home + suffix)}/Output`,
  ])))];
  it.each(siblings)("preserves a sibling component in both redactors: %s", (sibling) => {
    expect(redactFsPath(sibling)).toBe(sibling);
    expect(redactHomePathsInText(`Target ${sibling}`)).toBe(`Target ${sibling}`);
  });
  it.each(spellings)("redacts the bare home and preserves descendant spelling: %s", (home) => {
    expect(redactFsPath(home)).toBe("<home>");
    expect(redactHomePathsInText(`Target ${home}`)).toBe("Target [home]");
    const suffix = "\\MixedCase/FiLe.TXT";
    expect(redactFsPath(home + suffix)).toBe(`<home>${suffix}`);
    expect(redactHomePathsInText(`Target ${home}${suffix}`)).toBe(`Target [home]${suffix}`);
    for (const url of [`file://${home}`, pathToFileURL(home).toString()]) {
      expect(redactFsPath(url)).toBe("file://<home>");
      expect(redactHomePathsInText(`Target ${url}`)).toBe("Target file://[home]");
      expect(redactHomePathsInText(`Target ${url}${suffix}`)).toBe(`Target file://[home]${suffix}`);
    }
  });
  it.each([" ", "\t", "\n", '"', "'", "[", "]", "{", "}", ",", ";", "(", ")", "<", ">"])("redacts a home followed by a text delimiter: %j", (delimiter) => {
    expect(redactHomePathsInText(`Target ${nativeHome}${delimiter}rest`)).toBe(`Target [home]${delimiter}rest`);
  });
});
