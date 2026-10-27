import { SHELL_RULE_CANONICAL_VERSION } from "../../shared/shell-rule-version.js";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../permissions/asrt-sandbox.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../permissions/asrt-sandbox.js")>(),
  wrapToolCommand: vi.fn(async (command: string) => ({ argv: ["/bin/bash", "-c", command], env: { ...process.env } })),
  cleanupAsrtSandboxAfterCommand: vi.fn(async () => {}),
  getDefaultSensitiveReadDenyPaths: () => [], getDefaultSensitiveWriteDenyPaths: () => [],
}));

import type { ToolExecutionContext } from "../base.js";
import { createShellCwdProbe, ShellCwdProbeFilter } from "../shell-cwd-probe.js";
import {
  clearShellSessionCwd,
  readShellSessionCwd,
  recordShellSessionCwd,
  withShellSessionCwd,
} from "../shell-session-cwd.js";
import { HookRunner } from "../../hooks/hook-runner.js";
import { BashAstValidator } from "../../main/bash-ast-validator.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { ToolExecutor } from "../executor.js";
import { preparedShellCwdProbe } from "../prepared-shell-invocation.js";
import { ToolRegistry } from "../registry.js";
import { _trackShellSessionCwdForTest, BashTool, spawnWithSandbox } from "../shell-tools.js";
import { prepareSandboxFixture } from "./support/prepared-shell.js";

const SHELL_TIMEOUT_SECONDS = 10;

describe("shell cwd probe filter", () => {
  const probe = createShellCwdProbe("cd .")!;
  const report = (path: string): Buffer => Buffer.from(`${probe.start}${path}${probe.end}`, "utf8");

  it("removes the report and keeps the surrounding stderr bytes", () => {
    const filter = new ShellCwdProbeFilter(probe);
    const out = Buffer.concat([
      filter.push(Buffer.concat([Buffer.from("warn: a\n"), report("/work/sub"), Buffer.from("late")])),
      filter.flush(),
    ]);
    expect(out.toString("utf8")).toBe("warn: a\nlate");
    expect(filter.reportedCwd).toBe("/work/sub");
  });

  it("finds a report split across every byte boundary", () => {
    const whole = Buffer.concat([Buffer.from("x"), report("/work/한글 dir"), Buffer.from("y")]);
    const filter = new ShellCwdProbeFilter(probe);
    const pieces: Buffer[] = [];
    for (const byte of whole) pieces.push(filter.push(Buffer.from([byte])));
    pieces.push(filter.flush());
    expect(Buffer.concat(pieces).toString("utf8")).toBe("xy");
    expect(filter.reportedCwd).toBe("/work/한글 dir");
  });

  it("releases held bytes that never became a report", () => {
    const filter = new ShellCwdProbeFilter(probe);
    const partial = probe.start.slice(0, 5);
    const first = filter.push(Buffer.from(`text${partial}`));
    expect(first.toString("utf8")).toBe("text");
    expect(filter.flush().toString("utf8")).toBe(partial);
    expect(filter.reportedCwd).toBeUndefined();
  });

  it("adopts the trap's final report over a forged earlier one and strips both", () => {
    const filter = new ShellCwdProbeFilter(probe);
    // A command that read the nonce with `trap -p` prints its own report first; the EXIT trap's real one always comes last.
    const stream = Buffer.concat([
      Buffer.from("a"), report("/forged"), Buffer.from("b\n"), report("/work/real"),
    ]);
    const pieces: Buffer[] = [];
    for (let at = 0; at < stream.length; at += 7) pieces.push(filter.push(stream.subarray(at, at + 7)));
    pieces.push(filter.flush());
    expect(Buffer.concat(pieces).toString("utf8")).toBe("ab\n");
    expect(filter.reportedCwd).toBe("/work/real");
  });

  it("ignores a report carrying another invocation's nonce", () => {
    const other = createShellCwdProbe("cd .")!;
    const filter = new ShellCwdProbeFilter(probe);
    const forged = `${other.start}/elsewhere${other.end}`;
    const out = Buffer.concat([filter.push(Buffer.from(forged)), filter.flush()]);
    expect(out.toString("utf8")).toBe(forged);
    expect(filter.reportedCwd).toBeUndefined();
  });
});

describe("shell cwd probe selection", () => {
  it("leaves commands that cannot change directory unwrapped", () => {
    expect(createShellCwdProbe("bash ./child.sh")).toBeUndefined();
    expect(createShellCwdProbe("ls ./cd-notes /tmp/pushd")).toBeUndefined();
  });

  it("wraps every command that names a directory builtin", () => {
    for (const command of ["cd sub", "make && pushd x", "(popd)", "builtin cd ..", "eval 'cd x'"]) {
      const probe = createShellCwdProbe(command);
      expect(probe?.script.endsWith(`EXIT; ${command}`)).toBe(true);
    }
  });
});

describe.skipIf(process.platform === "win32")("bash session working directory", () => {
  const sessionId = "shell-cwd-session";
  let root: string;
  let outside: string;

  const ctx = (): ToolExecutionContext => ({
    cwd: root,
    extraAllowedDirectories: [],
    metadata: { sessionId },
  });

  const run = async (input: { command: string; cwd?: string }) => {
    const effective = withShellSessionCwd(
      { ...input, timeoutSeconds: SHELL_TIMEOUT_SECONDS },
      { sessionId, root, allowedDirectories: [] },
    );
    return new BashTool().execute(effective, ctx());
  };

  const setup = (): void => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "ave-shell-cwd-root-")));
    outside = realpathSync(mkdtempSync(join(tmpdir(), "ave-shell-cwd-outside-")));
    mkdirSync(join(root, "sub", "deeper"), { recursive: true });
  };

  afterEach(() => {
    clearShellSessionCwd(sessionId);
    rmSync(root, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  });

  it("carries a cd into the next call and keeps the probe out of the output", async () => {
    setup();
    const first = await run({ command: "cd sub && echo moved >&2" });
    expect(first.isError).toBe(false);
    expect(first.output).toBe("moved");
    expect(first.output).not.toContain("ave-cwd-");
    expect(readShellSessionCwd(sessionId, root)).toBe(join(root, "sub"));

    const second = await run({ command: "pwd" });
    expect(second.output).toBe(join(root, "sub"));

    const relative = await run({ command: "pwd", cwd: "deeper" });
    expect(relative.output).toBe(join(root, "sub", "deeper"));
    // A per-call directory the command did not leave stays per-call.
    expect(readShellSessionCwd(sessionId, root)).toBe(join(root, "sub"));
  });

  it("preserves the exit status and still tracks a cd before a failure", async () => {
    setup();
    const result = await run({ command: "cd sub; exit 3" });
    expect(result.isError).toBe(true);
    expect(result.metadata?.returncode).toBe(3);
    expect(readShellSessionCwd(sessionId, root)).toBe(join(root, "sub"));
  });

  it("refuses a static cd outside the workspace before it runs", async () => {
    setup();
    await run({ command: "cd sub" });
    const refused = await run({ command: `cd ${JSON.stringify(outside)}` });
    expect(refused.isError).toBe(true);
    expect(readShellSessionCwd(sessionId, root)).toBe(join(root, "sub"));
  });

  it("resets to the workspace root with a notice when a run ends outside the allowed scope", async () => {
    setup();
    await run({ command: "cd sub" });
    // Path policy refuses every command form that could end outside before spawn; the post-run clamp is the second line, exercised directly.
    const escaped = _trackShellSessionCwdForTest(
      { output: "done", isError: false, metadata: { returncode: 0 }, reportedCwd: outside },
      join(root, "sub"),
      ctx(),
    );
    expect(escaped.output).toBe(`done\n\nShell working directory reset to ${root}: ${outside} is outside the workspace and allowed directories.`);
    expect(escaped.metadata.cwdReset).toBe(true);
    expect("reportedCwd" in escaped).toBe(false);
    expect(readShellSessionCwd(sessionId, root)).toBeUndefined();
    const next = await run({ command: "pwd" });
    expect(next.output).toBe(root);
  });

  it("drops a stored allowed directory once it is no longer allowed", async () => {
    setup();
    const granted = await new BashTool().execute(
      withShellSessionCwd(
        { command: `cd ${JSON.stringify(outside)}`, timeoutSeconds: SHELL_TIMEOUT_SECONDS },
        { sessionId, root, allowedDirectories: [outside] },
      ),
      { ...ctx(), extraAllowedDirectories: [outside] },
    );
    expect(granted.isError).toBe(false);
    expect(readShellSessionCwd(sessionId, root)).toBe(outside);
    const next = await run({ command: "pwd" });
    expect(next.output).toBe(root);
    expect(readShellSessionCwd(sessionId, root)).toBeUndefined();
  });

  it("returns to the default when a cd lands back on the workspace root", async () => {
    setup();
    await run({ command: "cd sub/deeper" });
    await run({ command: "cd ../.." });
    expect(readShellSessionCwd(sessionId, root)).toBeUndefined();
  });

  it("reports the final directory through the sandbox wrapper route", async () => {
    setup();
    const command = "cd sub && printf ok";
    const prepared = prepareSandboxFixture(command, root);
    expect(preparedShellCwdProbe(prepared).probe).toBeDefined();
    const result = await spawnWithSandbox(command, root, [root], SHELL_TIMEOUT_SECONDS, prepared);
    expect(result.output).toBe("ok");
    expect(result.reportedCwd).toBe(join(root, "sub"));
  });

  it("does not track background shells", async () => {
    setup();
    const result = await new BashTool().execute(
      { command: "cd sub", timeoutSeconds: SHELL_TIMEOUT_SECONDS, run_in_background: true },
      ctx(),
    );
    expect(result.isError).toBe(false);
    expect(readShellSessionCwd(sessionId, root)).toBeUndefined();
  });
});

describe.skipIf(process.platform === "win32")("executor session working directory", () => {
  let root: string;

  afterEach(() => {
    clearShellSessionCwd("exec-a");
    clearShellSessionCwd("exec-b");
    rmSync(root, { recursive: true, force: true });
  });

  it("binds the next call of the same session to the directory a cd left", async () => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "ave-shell-cwd-exec-")));
    mkdirSync(join(root, "sub"));
    const registry = new ToolRegistry();
    registry.register(new BashTool());
    const permissions = new PermissionManager(join(root, "permissions.json"));
    permissions.setRules([
      { pattern: "Bash(cd sub)", action: "allow", shellRuleVersion: SHELL_RULE_CANONICAL_VERSION },
      { pattern: "Bash(pwd)", action: "allow", shellRuleVersion: SHELL_RULE_CANONICAL_VERSION },
    ]);
    const hooks = new HookRunner();
    const preHookInputs = vi.spyOn(hooks, "runPreHooks");
    const executor = new ToolExecutor(
      registry, hooks, permissions, new BashAstValidator({ mode: "deny" }),
      undefined, undefined, undefined, () => true,
    );
    const started: Record<string, unknown>[] = [];
    const bash = async (sessionId: string, id: string, command: string) => {
      const [result] = await executor.executeAll(
        [{ id, name: "bash", input: { command } }],
        {
          sessionId,
          executionCwd: root,
          permissionContext: { trustOrigin: "user-keyboard" },
          callbacks: { onToolStart: (_name, input) => { started.push(input); } },
        },
      );
      return result!;
    };

    expect((await bash("exec-a", "cd-1", "cd sub")).is_error).toBeFalsy();
    const followUp = await bash("exec-a", "pwd-1", "pwd");
    expect(String(followUp.content)).toBe(join(root, "sub"));
    // The tool card and approval surfaces see the directory the call runs in.
    expect(started[1]).toMatchObject({ command: "pwd", cwd: join(root, "sub") });
    // PreToolUse hooks see the same directory as permissions and execution.
    expect(preHookInputs.mock.calls[1]?.[0]).toMatchObject({
      toolName: "bash",
      toolInput: { command: "pwd", cwd: join(root, "sub") },
    });
    const otherSession = await bash("exec-b", "pwd-2", "pwd");
    expect(String(otherSession.content)).toBe(root);
  });
});

describe("session cwd store", () => {
  it("ignores a record observed under another workspace root", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ave-shell-cwd-store-")));
    try {
      mkdirSync(join(root, "a"));
      recordShellSessionCwd("store-session", root, join(root, "a"));
      expect(readShellSessionCwd("store-session", root)).toBe(join(root, "a"));
      expect(readShellSessionCwd("store-session", join(root, "a"))).toBeUndefined();
    } finally {
      clearShellSessionCwd("store-session");
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("drops a stored directory that no longer exists", () => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ave-shell-cwd-gone-")));
    try {
      mkdirSync(join(root, "gone"));
      recordShellSessionCwd("gone-session", root, join(root, "gone"));
      rmSync(join(root, "gone"), { recursive: true });
      const input = withShellSessionCwd({ command: "pwd" }, { sessionId: "gone-session", root, allowedDirectories: [] });
      expect(input).toEqual({ command: "pwd" });
      expect(readShellSessionCwd("gone-session", root)).toBeUndefined();
    } finally {
      clearShellSessionCwd("gone-session");
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not track unattributed invocations", () => {
    recordShellSessionCwd(undefined, "/work", "/work/a");
    recordShellSessionCwd("unknown", "/work", "/work/a");
    expect(readShellSessionCwd("unknown", "/work")).toBeUndefined();
  });
});
