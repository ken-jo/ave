import { spawnSync } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { describe, expect, it } from "vitest";
import { windowsPowerShellEnv } from "../windows-powershell-env.js";
import { windowsPowerShellEnv as scriptWindowsPowerShellEnv } from "../../../scripts/lib/windows-powershell-env.mjs";

const BUILDERS = [windowsPowerShellEnv, scriptWindowsPowerShellEnv];

describe("internal Windows PowerShell environment", () => {
  it("removes module search paths case-insensitively and preserves other keys without mutation", () => {
    const env = Object.freeze({ PSModulePath: "first", PSMODULEPATH: "second", pSmOdUlEpAtH: "third", Path: "tools", KEEP: "value", EMPTY: "", UNSET: undefined });
    for (const build of BUILDERS) {
      expect(build(env)).toEqual({ Path: "tools", KEEP: "value", EMPTY: "", UNSET: undefined });
      expect(env.PSModulePath).toBe("first");
    }
  });

  it.skipIf(process.platform !== "win32")("autoloads the native security module despite an inherited incompatible module", (context) => {
    const probe = spawnSync("pwsh.exe", ["-NoProfile", "-NonInteractive", "-Command", "$PSHOME"], {
      encoding: "utf8", windowsHide: true, timeout: 15_000,
    });
    if (probe.error && "code" in probe.error && probe.error.code === "ENOENT") context.skip("pwsh is not installed");
    expect(probe.error).toBeUndefined();
    expect(probe.status, probe.stderr).toBe(0);
    const moduleSource = join(probe.stdout.trim(), "Modules", "Microsoft.PowerShell.Security");
    if (!existsSync(join(moduleSource, "Microsoft.PowerShell.Security.psd1"))) {
      context.skip("the running pwsh installation has no Microsoft.PowerShell.Security module");
    }
    const root = mkdtempSync(join(tmpdir(), "ave-module-path-"));
    try {
      cpSync(moduleSource, join(root, "Microsoft.PowerShell.Security"), { recursive: true });
      const inherited = Object.entries(process.env).find(([key]) => key.toLowerCase() === "psmodulepath")?.[1];
      const polluted = { ...process.env, PSModulePath: [root, inherited].filter(Boolean).join(";") };
      const executable = win32.join(process.env.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
      // Read only: querying this fixture directory forces the security module to autoload.
      const args = ["-NoProfile", "-NonInteractive", "-Command", "$ErrorActionPreference = 'Stop'; Get-Acl -LiteralPath $env:TEMP | Out-Null; 'native-module-ok'"];
      const old = spawnSync(executable, args, { env: polluted, encoding: "utf8", windowsHide: true, timeout: 15_000 });
      expect(old.error).toBeUndefined();
      expect(old.status).not.toBe(0);
      expect(old.stderr).toContain("CouldNotAutoloadMatchingModule");
      for (const build of BUILDERS) {
        const fixed = spawnSync(executable, args, { env: build(polluted), encoding: "utf8", windowsHide: true, timeout: 15_000 });
        expect(fixed.error).toBeUndefined();
        expect(fixed.status, fixed.stderr).toBe(0);
        expect(fixed.stdout.trim()).toBe("native-module-ok");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
