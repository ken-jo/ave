import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { describe, expect, it } from "vitest";

// Every Playwright Electron launch in the e2e and screenshot suites goes
// through `launchElectron` (test/e2e/ui/seeded-electron.ts), which puts
// `--use-mock-keychain` in front on macOS. A spec that calls Playwright's
// launcher directly would open the owner's login Keychain and prompt them.
const ROOT = process.cwd();
const HARNESS = "test/e2e/ui/seeded-electron.ts";
const SUITES = ["test/e2e", "test/screenshots"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.(ts|mts|mjs|js)$/.test(name) ? [path] : [];
  });
}

/**
 * Playwright's Electron launcher is `_electron` (imported, destructured, or
 * reached through the module namespace as `pw._electron`); any mention of the
 * identifier outside the harness, or any `electron.launch(` call, is a launch
 * that skips the harness's switches.
 */
const DIRECT_LAUNCH = /\b_electron\b|\b_?electron\.launch\(/;

describe("e2e Electron launches", () => {
  it.each([
    ['import { _electron as electron } from "playwright";\nawait electron.launch({ args });'],
    ['import { _electron } from "playwright";\nawait _electron.launch({ args });'],
    ['import * as pw from "playwright";\nawait pw._electron.launch({ args });'],
    ["const { _electron: electron } = await import('playwright');"],
  ])("flags a direct launch: %s", (source) => {
    expect(DIRECT_LAUNCH.test(source)).toBe(true);
  });

  it("does not flag the harness launcher or an app.evaluate callback", () => {
    expect(DIRECT_LAUNCH.test('import { launchElectron } from "./seeded-electron.js";\nawait launchElectron({ args });')).toBe(false);
    expect(DIRECT_LAUNCH.test("await app.evaluate((_main, cards) => cards.length, []);")).toBe(false);
  });

  it("all go through the harness launcher", () => {
    const direct = SUITES.flatMap((suite) => sourceFiles(resolve(ROOT, suite)))
      // Compared in the posix spelling HARNESS uses, so Windows's `\` paths
      // still exclude the harness itself.
      .map((path) => relative(ROOT, path).split(sep).join("/"))
      .filter((path) => path !== HARNESS)
      .filter((path) => DIRECT_LAUNCH.test(readFileSync(path, "utf8")));
    expect(direct).toEqual([]);
  });

  it("puts the mock keychain switch in front of every launch on macOS", () => {
    const harness = readFileSync(resolve(ROOT, HARNESS), "utf8");
    expect(harness).toContain(
      'export const E2E_CHROMIUM_SWITCHES: readonly string[] = process.platform === "darwin" ? ["--use-mock-keychain"] : [];',
    );
    expect(harness).toMatch(/return electron\.launch\(\{ \.\.\.options, args: \[\.\.\.E2E_CHROMIUM_SWITCHES, /);
  });
});
