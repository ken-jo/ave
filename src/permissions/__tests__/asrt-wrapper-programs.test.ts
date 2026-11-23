// The Linux wrapper's own host programs are named by absolute paths, so its lookup never reaches a current directory.
import { afterEach, describe, expect, it } from "vitest";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { installProgramsOnPath, withPlantedProgram } from "../../__tests__/support/planted-program.js";
import { buildSandboxConfig } from "../asrt-sandbox.js";

const WRAPPER_PROGRAMS = ["bwrap", "socat", "rg"];
const hostPlatform = process.platform;

describe("asrt-sandbox wrapper program paths", () => {
  afterEach(() => setProcessPlatform(hostPlatform));

  it("keeps fixed paths instead of programs planted in the cwd or reached through empty or relative PATH entries", async () => {
    await withPlantedProgram(WRAPPER_PROGRAMS, () => {
      setProcessPlatform("linux");
      const config = buildSandboxConfig({ allowedDomains: [] });
      expect(config).toMatchObject({ bwrapPath: "/usr/bin/bwrap", socatPath: "/usr/bin/socat", ripgrep: { command: "/usr/bin/rg" } });
    });
  });

  it.runIf(hostPlatform !== "win32")("names the programs found in fully qualified PATH folders", async () => {
    const programs = installProgramsOnPath(WRAPPER_PROGRAMS);
    try {
      setProcessPlatform("linux");
      const config = buildSandboxConfig({ allowedDomains: [] });
      expect(config).toMatchObject({ bwrapPath: programs.program("bwrap"), socatPath: programs.program("socat"), ripgrep: { command: programs.program("rg") } });
    } finally {
      await programs.restore();
    }
  });

  it("leaves the macOS wrapper to its own programs", () => {
    setProcessPlatform("darwin");
    const config = buildSandboxConfig({ allowedDomains: [] });
    expect([config.bwrapPath, config.socatPath, config.ripgrep]).toEqual([undefined, undefined, undefined]);
  });
});
