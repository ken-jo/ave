// windows-permission
// The Linux wrapper's own host programs are named by absolute paths, so its lookup never reaches a current directory.
import { afterEach, describe, expect, it } from "vitest";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { installProgramsOnPath } from "../../__tests__/support/planted-program.js";
import { buildSandboxConfig } from "../asrt-sandbox.js";

const WRAPPER_PROGRAMS = ["bwrap", "socat", "rg"];
const hostPlatform = process.platform;

describe("asrt-sandbox wrapper program paths", () => {
  afterEach(() => setProcessPlatform(hostPlatform));

  it("keeps fixed wrapper paths when other programs are ahead of /usr/bin on PATH", async () => {
    const programs = installProgramsOnPath(WRAPPER_PROGRAMS, "linux");
    try {
      process.env.PATH = `${programs.dir}:/usr/bin`;
      setProcessPlatform("linux");
      const config = buildSandboxConfig({ allowedDomains: [] });
      expect(config).toMatchObject({ bwrapPath: "/usr/bin/bwrap", socatPath: "/usr/bin/socat", ripgrep: { command: "/usr/bin/rg" } });
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
