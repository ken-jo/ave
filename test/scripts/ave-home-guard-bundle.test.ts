// Test-only home guards must not reach production bundles, even with test variables set.
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { afterAll, describe, expect, it } from "vitest";

const repo = process.cwd();
const node = process.env.AVE_TEST_NODE_EXEC_PATH ?? process.execPath;
const scratch = mkdtempSync(join(tmpdir(), "ave-home-bundle-"));

afterAll(() => rmSync(scratch, { recursive: true, force: true }));

async function bundle(): Promise<string> {
  const result = await build({
    absWorkingDir: repo,
    stdin: {
      contents: [
        'export { aveHome } from "./src/shared/ave-home.ts";',
        'export { AVE_HOME_ISOLATION_GUARD_ACTIVE, checkAdminPolicyPath, checkSandboxStampTargets } from "./src/shared/ave-home-test-guard.ts";',
      ].join("\n"),
      resolveDir: repo,
      loader: "ts",
    },
    bundle: true,
    format: "esm",
    platform: "node",
    target: ["node22"],
    minifySyntax: true,
    write: false,
    logLevel: "silent",
  });
  return result.outputFiles[0]!.text;
}

describe("the Ave home guard in a production bundle", () => {
  it("bundles the app's no-op seam, not the test runner's guard", async () => {
    const text = await bundle();
    expect(text).not.toContain("refusing to");
    expect(text).not.toContain("ave-home-isolation-guard");
    expect(text).not.toContain("userInfo");
    expect(text).not.toContain("realProgramData");
    expect(text).not.toContain("realAccountHome");
    expect(text).not.toContain("constrain the test's deny/allow targets");
  });

  it("resolves the home as usual in a process that inherited VITEST and test variables", async () => {
    const file = join(scratch, "ave-home.mjs");
    writeFileSync(file, await bundle());
    const home = join(scratch, "home");
    const run = (extra: Record<string, string>) => spawnSync(
      node,
      ["--input-type=module", "-e", `const m = await import(${JSON.stringify(pathToFileURL(file).href)}); m.checkAdminPolicyPath("C:/ProgramData/Ave/policy.json"); m.checkSandboxStampTargets(["C:/Users/example/.curlrc", "C:/ProgramData/Ave/policy.json"]); console.log(JSON.stringify([m.aveHome(), m.AVE_HOME_ISOLATION_GUARD_ACTIVE]));`],
      {
        encoding: "utf8",
        timeout: 15_000,
        env: {
          PATH: process.env.PATH ?? "",
          SystemRoot: process.env.SystemRoot ?? "",
          ELECTRON_RUN_AS_NODE: "1",
          HOME: home,
          USERPROFILE: home,
          NODE_ENV: "production",
          ...extra,
        },
      },
    );
    for (const vitest of ["1", "0", "true"]) {
      const result = run({ VITEST: vitest });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual([join(home, ".ave"), false]);
    }
    const withRun = run({ VITEST: "1", AVE_TEST_RUN_HOME: join(scratch, "run"), AVE_TEST_SANDBOX_BASE: join(scratch, "sbx") });
    expect(withRun.status, withRun.stderr).toBe(0);
    expect(JSON.parse(withRun.stdout)).toEqual([join(home, ".ave"), false]);
  });

  it("is the guard in this test process, through the test configuration alone", async () => {
    const seam = await import("../../src/shared/ave-home-test-guard.js");
    expect(seam.AVE_HOME_ISOLATION_GUARD_ACTIVE).toBe(true);
  });

  it("keeps native stamping out of the plugin child module graph", async () => {
    const { MAIN_BUNDLE_EXTERNALS } = await import("../../scripts/lib/main-bundle-externals.mjs");
    const result = await build({
      absWorkingDir: repo,
      entryPoints: ["src/plugins/isolation/plugin-child-main.ts"],
      bundle: true,
      format: "esm",
      platform: "node",
      write: false,
      metafile: true,
      external: [...MAIN_BUNDLE_EXTERNALS],
      logLevel: "silent",
    });
    const inputs = Object.keys(result.metafile!.inputs);
    expect(inputs).not.toContain("src/permissions/asrt-sandbox.ts");
    expect(inputs.filter((path) => path.includes("sandbox-runtime"))).toEqual([]);
    const imports = Object.values(result.metafile!.outputs).flatMap((output) => output.imports);
    expect(imports.filter((entry) => /sandbox-runtime|srt-win/.test(entry.path))).toEqual([]);
  });
});
