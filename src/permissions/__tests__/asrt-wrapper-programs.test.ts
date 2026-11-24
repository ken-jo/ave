// windows-permission
// The Linux wrapper's own host programs are named by absolute paths, so its lookup never reaches a current directory.
import { afterEach, describe, expect, it } from "vitest";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { installProgramsOnPath } from "../../__tests__/support/planted-program.js";
import { decideSandboxGate } from "../../boot/steps/sandbox-gate.js";
import { buildSandboxConfig, checkAsrtDependencies } from "../asrt-sandbox.js";
import { classifySandboxDependencyErrors } from "../sandbox-start-failure.js";

const WRAPPER_PROGRAMS = ["bwrap", "socat", "rg"];
const hostPlatform = process.platform;

describe("asrt-sandbox wrapper program paths", () => {
  afterEach(() => setProcessPlatform(hostPlatform));

  it("pins online dependencies installed in a fully qualified PATH directory outside /usr/bin", async () => {
    const programs = installProgramsOnPath(WRAPPER_PROGRAMS, "linux");
    try {
      process.env.PATH = `:.:relative:${programs.dir}`;
      setProcessPlatform("linux");
      const config = buildSandboxConfig({ allowedDomains: [] });
      expect(config).toMatchObject({ bwrapPath: programs.program("bwrap"), socatPath: programs.program("socat"), ripgrep: { command: programs.program("rg") } });
      expect((await checkAsrtDependencies()).errors).toEqual([]);
    } finally {
      await programs.restore();
    }
  });

  it("reports missing online dependencies through the existing boot gate", async () => {
    const programs = installProgramsOnPath(WRAPPER_PROGRAMS, "linux");
    const cwd = process.cwd();
    try {
      process.chdir(programs.dir);
      setProcessPlatform("linux");
      process.env.PATH = ":.:relative:/ave-test-missing/bin";
      const { errors } = await checkAsrtDependencies();
      for (const program of WRAPPER_PROGRAMS) {
        expect(errors).toContainEqual(expect.stringMatching(new RegExp(`${program}.*PATH.*?/ave-test-missing/bin`, "u")));
      }
      expect(classifySandboxDependencyErrors("linux", errors)).toEqual(["missing-ripgrep", "missing-bwrap", "missing-socat"]);
      const input = { settingOn: true, depsOk: errors.length === 0, platform: "linux" as const };
      expect(decideSandboxGate({ ...input, explicitEnv: false })).toEqual({ action: "degrade", reason: "degrade-default-cannot-activate" });
      expect(decideSandboxGate({ ...input, explicitEnv: true })).toEqual({ action: "abort", reason: "abort-explicit-cannot-activate" });
    } finally {
      setProcessPlatform(hostPlatform);
      process.chdir(cwd);
      await programs.restore();
    }
  });

  it("leaves the macOS wrapper to its own programs", () => {
    setProcessPlatform("darwin");
    const config = buildSandboxConfig({ allowedDomains: [] });
    expect([config.bwrapPath, config.socatPath, config.ripgrep]).toEqual([undefined, undefined, undefined]);
  });
});
