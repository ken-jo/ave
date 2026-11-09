import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { launchBaseEnv, windowsProfileEnv } from "../e2e/ui/windows-e2e-profile.js";

// The shared launcher substitutes keychain access to prevent real prompts.
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

// Scan direct launches and aliases so callers cannot bypass the shared launcher.
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
      // This harness requires POSIX process behavior.
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
    expect(harness).toMatch(/args: \[\.\.\.E2E_CHROMIUM_SWITCHES, \.\.\.runtimeArgs, \.\.\.\(options\?\.args \?\? \[\]\)\]/);
    expect(harness).toContain('executablePath && !options?.executablePath');
    expect(harness).toContain('"lib/server/electron/loader.js"');
  });

  it("gives every launch the explicit E2E runtime env, over the spec's own env", () => {
    const harness = readFileSync(resolve(ROOT, HARNESS), "utf8");
    expect(harness).toContain(
      'export const E2E_RUNTIME_ENV = Object.freeze({ AVE_E2E: "1", NODE_ENV: "test" });',
    );
    expect(harness).toContain("env: { ...baseEnv, ...E2E_RUNTIME_ENV },");
  });
});

describe("Windows e2e launch env", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("puts APPDATA inside the overridden profile on win32 only", () => {
    const profile = mkdtempSync(join(tmpdir(), "ave-e2e-win-profile-"));
    dirs.push(profile);
    expect(windowsProfileEnv(profile, "win32")).toEqual({ APPDATA: join(profile, "AppData", "Roaming") });
    expect(existsSync(join(profile, "AppData", "Roaming"))).toBe(true);
    expect(windowsProfileEnv(profile, "linux")).toEqual({});
    expect(windowsProfileEnv(undefined, "win32")).toEqual({});
  });

  it("never passes LOCALAPPDATA on win32, inherited or spec-supplied", () => {
    const inherited = { PATH: "p", LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local", UNSET: undefined };
    expect(launchBaseEnv(inherited, "win32")).toEqual({ PATH: "p" });
    expect(launchBaseEnv({ APPDATA: "a", LocalAppData: "spec" }, "win32")).toEqual({ APPDATA: "a" });
    expect(launchBaseEnv({ LOCALAPPDATA: "l" }, "linux")).toEqual({ LOCALAPPDATA: "l" });
  });

  it("builds every launch env through both", () => {
    const harness = readFileSync(resolve(ROOT, HARNESS), "utf8");
    expect(harness).toContain("const baseEnv = launchBaseEnv(options?.env ?? process.env);");
    expect(harness).toContain("...safeProcessEnv(), ...windowsProfileEnv(overrides.USERPROFILE), ...overrides");
  });
});
