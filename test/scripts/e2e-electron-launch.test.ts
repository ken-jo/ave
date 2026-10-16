import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
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

describe("e2e Electron launches", () => {
  it("all go through the harness launcher", () => {
    const direct = SUITES.flatMap((suite) => sourceFiles(resolve(ROOT, suite)))
      .map((path) => relative(ROOT, path))
      .filter((path) => path !== HARNESS)
      .filter((path) => /_electron\b[^,}]*\bas\b|\b_electron\s*:|\belectron\.launch\(/.test(readFileSync(path, "utf8")));
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
