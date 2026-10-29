import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import childProcess, { ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { BashAstValidator } from "../../main/bash-ast-validator.js";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { shellQuote } from "../../lib/shell-resolver.js";
import { backgroundShellManager, createBashKillTool } from "../shell-tools.js";

describe("ToolExecutor background shell session control", () => {
  let dir: string;
  let executor: ToolExecutor;
  let permissions: PermissionManager;
  let child: ChildProcess;
  let shellId: string;

  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), "ave-shell-session-")));
    child = new ChildProcess();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    // No process is spawned: only the child's signal boundary is replaced.
    vi.spyOn(child, "kill").mockReturnValue(true);
    shellId = backgroundShellManager.register({
      sessionId: "owner",
      command: "owned background command",
      child,
      startedAt: new Date().toISOString(),
    });
    const registry = new ToolRegistry();
    registry.register(createBashKillTool());
    permissions = new PermissionManager(join(dir, "permissions.json"));
    permissions.setMode("allow");
    executor = new ToolExecutor(
      registry,
      undefined,
      permissions,
      new BashAstValidator({ mode: "deny" }),
      undefined,
      undefined,
      undefined,
      () => true,
    );
  });

  afterEach(async () => {
    backgroundShellManager.disposeSession("owner");
    child.stdout?.destroy();
    child.stderr?.destroy();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    syncBuiltinESMExports();
    await cleanupTmpDir(dir);
  });

  async function kill(sessionId: string, extraInput: Record<string, unknown> = {}) {
    const results = await executor.executeAll(
      [{ id: "kill-shell", name: "bash_kill", input: { shellId, ...extraInput } }],
      {
        sessionId,
        executionCwd: dir,
        permissionContext: { trustOrigin: "user-keyboard" },
      },
    );
    return results[0]!;
  }

  it("lets the owning session terminate its shell without a command argument", async () => {
    child.stdout?.emit("data", Buffer.from("remaining output"));
    const result = await kill("owner");

    expect(result.is_error).toBeFalsy();
    expect(JSON.parse(String(result.content))).toMatchObject({
      shellId,
      status: "killed",
      output: "remaining output",
    });
    expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
    expect(backgroundShellManager.read("owner", shellId)?.status).toBe("killed");
  });

  it("rejects another session without signaling or consuming the owner's output", async () => {
    child.stdout?.emit("data", Buffer.from("owner-only output"));
    const result = await kill("other-session");

    expect(result.is_error).toBe(true);
    expect(String(result.content)).toContain("no background shell with that id");
    expect(child.kill).not.toHaveBeenCalled();
    expect(backgroundShellManager.read("owner", shellId)).toMatchObject({
      status: "running",
      output: "owner-only output",
    });
  });

  it("still requires permission before signaling an owned shell", async () => {
    permissions.setMode("strict");
    const result = await kill("owner");

    expect(result.is_error).toBe(true);
    expect(child.kill).not.toHaveBeenCalled();
    expect(backgroundShellManager.read("owner", shellId)?.status).toBe("running");
  });

  it.each(["command", "cmd", "script", "shellCommand"])(
    "ignores read-looking command data in %s during owned session control",
    async (field) => {
      // Quoted so bash keeps a Windows path's backslashes and names the file.
      const result = await kill("owner", {
        [field]: `cat ${shellQuote(join(homedir(), ".ssh", "id_rsa"))}`,
      });

      expect(result.is_error).toBeFalsy();
      expect(JSON.parse(String(result.content))).toMatchObject({ shellId, status: "killed" });
      expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
      expect(backgroundShellManager.read("owner", shellId)?.status).toBe("killed");
    },
  );

  it.each(["command", "cmd", "script", "shellCommand"])(
    "ignores protected-looking command data in %s while signaling only the owning shell",
    async (field) => {
      mkdirSync(join(dir, ".git"));
      const target = join(dir, ".git", "config");
      writeFileSync(target, "unchanged-control-file");
      const spawn = vi.spyOn(childProcess, "spawn").mockImplementation(() => { throw new Error("Unexpected executable spawn"); });
      syncBuiltinESMExports();
      const result = await kill("owner", { [field]: "echo changed > .git/config" });
      expect(result.is_error).toBeFalsy();
      expect(JSON.parse(String(result.content))).toMatchObject({ shellId, status: "killed" });
      expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
      expect(backgroundShellManager.read("owner", shellId)?.status).toBe("killed");
      expect(spawn).not.toHaveBeenCalled();
      expect(readFileSync(target, "utf8")).toBe("unchanged-control-file");
    },
  );

  it.each(["command", "cmd", "script", "shellCommand"])(
    "does not expand command data in %s during session control",
    async (field) => {
      const target = join(dir, "untouched.txt");
      writeFileSync(target, "unchanged-variable-target");
      vi.stubEnv("UNRESOLVED_SESSION_WRITE_TARGET", target);
      const spawn = vi.spyOn(childProcess, "spawn").mockImplementation(() => { throw new Error("Unexpected executable spawn"); });
      syncBuiltinESMExports();
      const result = await kill("owner", { [field]: "echo changed > $UNRESOLVED_SESSION_WRITE_TARGET" });
      expect(result.is_error, String(result.content)).toBeFalsy();
      expect(JSON.parse(String(result.content))).toMatchObject({ shellId, status: "killed" });
      expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGKILL");
      expect(backgroundShellManager.read("owner", shellId)?.status).toBe("killed");
      expect(spawn).not.toHaveBeenCalled();
      expect(readFileSync(target, "utf8")).toBe("unchanged-variable-target");
    },
  );
});
