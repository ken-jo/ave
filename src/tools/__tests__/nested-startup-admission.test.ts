import { chmodSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { checkShellPermission } from "../../__tests__/support/permission-lane.js";
import { shellQuote } from "../../lib/shell-resolver.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { __resetActiveSandboxCapabilityForTest, __resetSandboxRequestedAtBootForTest, setShellSandboxRequestedAtBoot } from "../../permissions/sandbox-capability.js";
import { withCurrentShellRuleVersion } from "../../shared/shell-rule-version.js";
import { runWithToolExecutionCwd } from "../execution-context.js";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { BashTool } from "../shell-tools.js";
import { userPermissionContext } from "./tool-context-fixture.js";

const STARTUP_MARKER_CASES = [
  { program: "python3", command: "python3 -I -S ordinary.py", startup: "python3._pth" },
  { program: "zsh", command: "zsh -c 'printf ready'", startup: ".zshenv" },
  { program: "pwsh", command: "pwsh -File ordinary.ps1", startup: "Microsoft.PowerShell_profile.ps1" },
] as const;

afterEach(() => {
  __resetActiveSandboxCapabilityForTest();
  __resetSandboxRequestedAtBootForTest();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("nested startup admission before native execution", () => {
  it.each(STARTUP_MARKER_CASES)("never launches PATH startup marker $program with a saved headless exact rule", async ({ program, command, startup }) => {
    const cwd = mkdtempSync(join(tmpdir(), "nested-startup-marker-"));
    try {
      const bin = join(cwd, "bin");
      mkdirSync(bin);
      const marker = join(cwd, "HIDDEN_STARTUP_EXECUTED");
      // Recording executables observe the spawn boundary independently of the
      // classifier. Native runtime path-init behavior has separate probes.
      const executable = join(bin, program);
      writeFileSync(executable, `#!/bin/sh\nprintf HIDDEN_STARTUP_EXECUTED > ${shellQuote(marker)}\n`, { mode: 0o700 });
      chmodSync(executable, 0o700);
      writeFileSync(`${executable}.cmd`, `@echo off\r\necho HIDDEN_STARTUP_EXECUTED>"${marker}"\r\n`);
      writeFileSync(join(bin, startup), "STARTUP_INPUT\n");
      writeFileSync(join(cwd, "ordinary.py"), "print('ready')\n");
      writeFileSync(join(cwd, "ordinary.ps1"), "Write-Output ready\n");
      vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH ?? ""}`);
      vi.stubEnv("HOME", cwd);
      vi.stubEnv("ZDOTDIR", bin);
      vi.stubEnv("AVE_HOME", join(cwd, "state"));
      __resetActiveSandboxCapabilityForTest();
      setShellSandboxRequestedAtBoot(false);
      const manager = new PermissionManager(join(cwd, "permissions.json"));
      manager.setMode("allow");
      manager.setRules([withCurrentShellRuleVersion({ pattern: `Bash(${command})`, action: "allow" })]);
      expect(checkShellPermission(manager, cwd, "nested-startup-marker", command, "bash", false, true))
        .toMatchObject({ decision: "deny", layer: 2 });
      const tool = new BashTool();
      const execute = vi.spyOn(tool, "execute");
      const registry = new ToolRegistry();
      registry.register(tool);
      const approval = { requestAndWait: vi.fn() };
      const executor = new ToolExecutor(registry, undefined, manager, undefined, approval as never);
      const [result] = await runWithToolExecutionCwd(cwd, () => executor.executeAll(
        [{ id: `nested-startup-marker-${program}`, name: "bash", input: { command, timeoutSeconds: 1 } }],
        { sessionId: `nested-startup-marker-${program}`, permissionContext: userPermissionContext({ headless: true }) },
      ));
      expect(result!.is_error).toBe(true);
      expect(execute).not.toHaveBeenCalled();
      expect(approval.requestAndWait).not.toHaveBeenCalled();
      expect(existsSync(marker)).toBe(false);
    } finally { await cleanupTmpDir(cwd); }
  });
});
