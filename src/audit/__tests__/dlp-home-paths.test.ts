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
  it("preserves a distinct sibling path", () => {
    expect(redactFsPath(`${nativeHome}-sibling\\output`)).toBe(`${nativeHome}-sibling\\output`);
  });
});
