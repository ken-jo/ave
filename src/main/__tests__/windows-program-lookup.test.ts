// windows-native: the Windows job runs this file from config/windows-native-tests.txt.
// The process-wide Windows setting that stops a bare program name from being looked up in the current directory.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdtempSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { win32SystemBinary } from "../../shared/windows-system-path.js";

const VARIABLE = "NoDefaultCurrentDirectoryInExePath";

function firstImport(entry: string): string | undefined {
  const source = readFileSync(join(import.meta.dirname, "..", "..", entry), "utf8");
  return /^import\s+(?:[^"']*from\s+)?["']([^"']+)["']/mu.exec(source)?.[1];
}

describe("windows program lookup", () => {
  it.each(["main.ts", "headless-host.ts"])("is the first import of %s", (entry) => {
    expect(firstImport(entry)).toBe("./main/bare-program-lookup.js");
  });

  it.runIf(process.platform === "win32")("sets the variable when the module loads", async () => {
    const previous = process.env[VARIABLE];
    delete process.env[VARIABLE];
    try {
      vi.resetModules();
      await import("../bare-program-lookup.js");
      expect(process.env[VARIABLE]).toBe("1");
    } finally {
      if (previous === undefined) delete process.env[VARIABLE];
      else process.env[VARIABLE] = previous;
    }
  });

  describe.runIf(process.platform === "win32")("a program planted in the current directory", () => {
    const PROBE = "ave-planted-probe";
    let planted: string;
    const cwd = process.cwd();
    const previous = process.env[VARIABLE];
    beforeAll(() => {
      planted = realpathSync(mkdtempSync(join(tmpdir(), "ave-program-lookup-")));
      copyFileSync(win32SystemBinary("hostname.exe"), join(planted, `${PROBE}.exe`));
      process.chdir(planted);
    });
    afterAll(async () => {
      process.chdir(cwd);
      if (previous === undefined) delete process.env[VARIABLE];
      else process.env[VARIABLE] = previous;
      await cleanupTmpDir(planted);
    });
    const launch = () => spawnSync(PROBE, [], { windowsHide: true, env: { SystemRoot: process.env.SystemRoot, PATH: win32SystemBinary("") } });

    it("runs without the variable (control)", () => {
      delete process.env[VARIABLE];
      expect(launch().status).toBe(0);
    });

    it("never runs with the variable in this process, even when the child environment omits it", () => {
      process.env[VARIABLE] = "1";
      expect((launch().error as NodeJS.ErrnoException | undefined)?.code).toBe("ENOENT");
    });
  });
});
