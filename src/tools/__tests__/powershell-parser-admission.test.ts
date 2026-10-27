import { chmodSync, existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import * as childProcess from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { shellQuote } from "../../lib/shell-resolver.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { runWithToolExecutionCwd } from "../execution-context.js";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { PowerShellTool } from "../shell-tools.js";
import { userPermissionContext } from "./tool-context-fixture.js";

vi.mock("node:child_process", { spy: true });

describe("native parser executable admission", () => {
  it("never runs a PATH-shadowing shell before an explicit tool deny", async () => {
    const directory = mkdtempSync(join(tmpdir(), "shell-parser-path-"));
    const marker = join(directory, "shadow-ran");
    const shadow = join(directory, "pwsh");
    writeFileSync(shadow, `#!/bin/sh\nprintf ran > ${shellQuote(marker)}\nprintf '{}'\n`, { mode: 0o700 });
    chmodSync(shadow, 0o700);
    writeFileSync(`${shadow}.cmd`, `@echo off\r\necho ran>"${marker}"\r\necho {}\r\n`);
    const originalPath = process.env.PATH ?? "";
    vi.stubEnv("PATH", `${directory}${delimiter}${originalPath}`);
    const spawned = vi.mocked(childProcess.spawn);
    spawned.mockClear();
    try {
      const manager = new PermissionManager(join(directory, "permissions.json"));
      manager.setRules([{ pattern: "powershell", action: "deny" }]);
      const tool = new PowerShellTool();
      const execution = vi.spyOn(tool, "execute");
      const registry = new ToolRegistry();
      registry.register(tool);
      const approval = { requestAndWait: vi.fn() };
      const executor = new ToolExecutor(registry, undefined, manager, undefined, approval as never);
      const [result] = await runWithToolExecutionCwd(directory, () => executor.executeAll(
        [{ id: "denied-parser", name: "powershell", input: { command: "Write-Output ready", timeoutSeconds: 1 } }],
        { sessionId: "denied-parser", permissionContext: userPermissionContext() },
      ));
      expect(result.is_error).toBe(true);
      expect(execution).not.toHaveBeenCalled();
      expect(approval.requestAndWait).not.toHaveBeenCalled();
      expect(existsSync(marker)).toBe(false);
      expect(spawned.mock.calls.some(([program]) => program === "pwsh" || program === shadow || program === `${shadow}.cmd`)).toBe(false);
    } finally {
      spawned.mockClear();
      vi.unstubAllEnvs();
      await cleanupTmpDir(directory);
    }
  });
});
