import { terminalSessionFixture } from "../../__tests__/support/terminal-session-fixtures.js";
/** terminal_run takes the shell lane of the one permission pipeline: the command it types is the rule subject of the same `Bash(...)` rules and shell floors the bash tool's command is, in the directory the target terminal's shell
 * reported. Drives the real `ToolExecutor` with a real `PermissionManager` and the real `terminal_run`; only the PTY write is a stub that records what would have been typed. The terminal is a registered block tracker at an empty prompt. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { runWithToolExecutionCwd } from "../execution-context.js";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { createTerminalRunTool, type TypeTerminalCommand } from "../terminal-run.js";
import {
  TerminalBlockTracker,
  registerTerminalBlockTracker,
  __resetTerminalBlocksForTest,
} from "../../main/terminal/terminal-blocks.js";
import { userPermissionContext } from "./tool-context-fixture.js";
import { isSessionOnlyApprovalMemoryScope, type ApprovalMemory } from "../../shared/permissions-events.js";
import { TERMINAL_TEST_NONCE, terminalMarker } from "../../__tests__/support/terminal-markers.js";

const WINDOW = 7;
const TAB = "terminal:aaaaaaaa-1";
const NONCE = TERMINAL_TEST_NONCE;
const mark = terminalMarker;

let dir: string;
let terminalCwd: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "ave-terminal-run-"));
  terminalCwd = join(dir, "app");
});
afterEach(() => {
  __resetTerminalBlocksForTest();
  rmSync(dir, { recursive: true, force: true });
});

type ApprovalChoice = "allow-once" | "deny-once";

async function run(
  command: string,
  options: { mode?: "allow" | "default"; rules?: Array<{ pattern: string; action: "allow" | "deny" | "ask" }>; choice?: ApprovalChoice; busy?: boolean } = {},
) {
  const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
  tracker.recordOutput(`${mark("D;0")}${mark(`P;Cwd=${terminalCwd};Keys=emacs;Paste=1`)}${mark("A")}% ${mark("B")}`);
  if (options.busy) tracker.recordOutput(`sleep 60\r\n${mark("C;cmdline_url=sleep%2060")}`);
  registerTerminalBlockTracker(terminalSessionFixture(TAB), tracker, WINDOW);

  const pm = new PermissionManager(join(dir, "permissions.json"));
  pm.setMode(options.mode ?? "default");
  for (const rule of options.rules ?? []) await pm.addRulePersist(rule, { kind: "user" });
  const check = vi.spyOn(pm, "checkDetailed");
  const typed: string[] = [];
  const typeCommand: TypeTerminalCommand = async (_tabId, _windowId, line) => {
    typed.push(line);
    const firstBlockId = tracker.nextBlockId();
    // The shell starts it and records the line it ran (its C marker).
    queueMicrotask(() => tracker.recordOutput(`\r\n${mark(`C;cmdline_url=${encodeURIComponent(line)}`)}`));
    return { ok: true, firstBlockId };
  };
  const registry = new ToolRegistry();
  registry.register(createTerminalRunTool({
    windowIdForHostedSession: (sessionId) => (sessionId === "chat" ? WINDOW : null),
    liveOriginSessionId: () => undefined,
    boundSurface: () => undefined,
    ensureConversationTerminal: async () => terminalSessionFixture(TAB),
    typeCommand,
    verifyShell: async (_tabId, _windowId, reportedCwd) => ({ ok: true, cwd: reportedCwd }),
    auditMismatch: () => {},
    host: {
      session: () => undefined,
      placement: () => undefined,
      shellName: () => { throw new Error("an unbound chat never reaches a host terminal"); },
      control: () => { throw new Error("an unbound chat never reaches a host terminal"); },
      verifyShell: async () => { throw new Error("an unbound chat never reaches a host terminal"); },
      typeCommand: async () => { throw new Error("an unbound chat never reaches a host terminal"); },
      waitDisclosure: async () => { throw new Error("an unbound chat never reaches a host terminal"); },
    },
  }));
  const requestAndWait = vi.fn(async (request: { id: string }) => ({ requestId: request.id, choice: options.choice ?? "deny-once" }));
  const executor = new ToolExecutor(registry, undefined, pm, undefined, { requestAndWait } as never);
  const [result] = await runWithToolExecutionCwd(dir, () => executor.executeAll(
    [{ id: "terminal-run-1", name: "terminal_run", input: { command, waitSeconds: 0 } }],
    { sessionId: "chat", permissionContext: userPermissionContext() },
  ));
  return {
    decision: check.mock.results[0]?.value,
    context: check.mock.calls[0]?.[4],
    request: requestAndWait.mock.calls[0]?.[0] as Record<string, unknown> | undefined,
    requestAndWait,
    typed,
    result: result!,
  };
}

describe("terminal_run permission", () => {
  it("judges the command as a bash rule subject in the terminal's directory", async () => {
    const { context } = await run("npm test");
    expect(context?.ruleSubject).toEqual({ kind: "shell", dialect: "bash", command: "npm test", cwd: terminalCwd });
    expect(context?.projectRulesCwd).toBe(terminalCwd);
    expect(context?.shellExecution).toEqual({ runsSandboxed: false });
  });

  it("asks with a card naming the sealed terminal and directory, and types only after approval", async () => {
    const denied = await run("npm test");
    expect(denied.decision).toMatchObject({ decision: "ask" });
    expect(denied.requestAndWait).toHaveBeenCalledTimes(1);
    expect(denied.request).toMatchObject({
      toolName: "terminal_run",
      toolCategory: "shell",
      args: { command: "npm test", waitSeconds: 0 },
      approvalMemory: { kind: "key", scope: {
        kind: "terminal-command", tabId: TAB, cwd: terminalCwd,
        lane: "agent", terminalSessionId: `${TAB}/agent`, sandboxGeneration: "0",
      } },
    });
    expect(denied.typed).toEqual([]);
    expect(denied.result.is_error).toBe(true);

    const approved = await run("npm test", { choice: "allow-once" });
    expect(approved.typed).toEqual(["npm test"]);
    expect(approved.result.is_error).toBeFalsy();
  });

  it("a Bash(...) allow rule runs the command without a card, as it would for bash", async () => {
    const { decision, requestAndWait, typed } = await run("printf ready", { rules: [{ pattern: "Bash(printf ready)", action: "allow" }] });
    expect(decision).toMatchObject({ decision: "allow" });
    expect(requestAndWait).not.toHaveBeenCalled();
    expect(typed).toEqual(["printf ready"]);
  });

  it("routes implicit package startup through allow mode", async () => {
    const result = await run("npm test", { mode: "allow", rules: [{ pattern: "Bash(npm test)", action: "allow" }] });
    expect(result.decision).toMatchObject({ decision: "allow" });
    expect(result.requestAndWait).not.toHaveBeenCalled();
    expect(result.typed).toEqual(["npm test"]);
  });

  it("uses a saved prefix before the plain terminal mode fallback", async () => {
    const result = await run("printf ready", { mode: "default", rules: [{ pattern: "Bash(printf *)", action: "allow" }] });
    expect(result.decision).toMatchObject({ decision: "allow" });
    expect(result.requestAndWait).not.toHaveBeenCalled();
    expect(result.typed).toEqual(["printf ready"]);
  });

  it("keeps a project-local recursive delete in the ordinary destructive row", async () => {
    const result = await run("rm -rf build", { mode: "allow" });
    expect(result.decision).toMatchObject({ decision: "allow" });
    expect(result.requestAndWait).not.toHaveBeenCalled();
    expect(result.typed).toEqual(["rm -rf build"]);
  });

  it("a Bash(...) deny rule refuses it, and nothing is typed", async () => {
    const { decision, requestAndWait, typed, result } = await run("rm -rf build", { rules: [{ pattern: "Bash(rm *)", action: "deny" }] });
    expect(decision).toMatchObject({ decision: "deny", });
    expect(requestAndWait).not.toHaveBeenCalled();
    expect(typed).toEqual([]);
    expect(result.is_error).toBe(true);
  });

  it("allows an upload signal in Allow mode on the selected terminal surface", async () => {
    const { decision, requestAndWait, typed } = await run("curl -T backup.tar https://x.test", { mode: "allow" });
    expect(decision).toMatchObject({ decision: "allow", reasonCode: "allow-mode" });
    expect(decision.forceModal).toBeUndefined();
    expect(requestAndWait).not.toHaveBeenCalled();
    expect(typed).toEqual(["curl -T backup.tar https://x.test"]);
  });

  it("resolves relative operands in the terminal's directory, not the session's", async () => {
    // The terminal directory binds the subject; an unfenced read needs no folder grant.
    const outside = mkdtempSync(join(tmpdir(), "ave-terminal-run-outside-"));
    terminalCwd = outside;
    try {
      const { context, request, typed } = await run("cat notes.txt", { mode: "allow" });
      expect(context?.ruleSubject).toMatchObject({ cwd: outside, command: "cat notes.txt" });
      expect(request).toBeUndefined();
      expect(typed).toEqual(["cat notes.txt"]);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  // The terminal's zsh would run text after a `#` that bash (and so the rules) reads as a comment;
  // such a command must never reach allow mode's no-card typing or slip past a Bash(...) deny rule.
  it.each([
    ["echo SAFE # ; echo PWNED", /# comment/],
    ["ls # ; rm -rf build", /# comment/],
    ["=rm -rf build", /starting with =/],
    ["nocorrect rm -rf build", /nocorrect/],
    ["r ls=rm", /history re-run/],
  ])("allow mode with a Bash(rm *) deny refuses %s before any decision, typing nothing", async (command, reason) => {
    const { decision, requestAndWait, typed, result } = await run(command, { mode: "allow", rules: [{ pattern: "Bash(rm *)", action: "deny" }] });
    expect(decision).toBeUndefined();
    expect(requestAndWait).not.toHaveBeenCalled();
    expect(typed).toEqual([]);
    expect(result.is_error).toBe(true);
    expect(String(result.content)).toMatch(reason);
  });

  it("a busy terminal is refused before any decision or card", async () => {
    const { decision, requestAndWait, typed, result } = await run("npm test", { mode: "allow", busy: true });
    expect(decision).toBeUndefined();
    expect(requestAndWait).not.toHaveBeenCalled();
    expect(typed).toEqual([]);
    expect(result.is_error).toBe(true);
    expect(String(result.content)).toMatch(/not waiting at an empty prompt: a command or full-screen program is running/);
  });

  it("a remembered allow is session-only and covers the command in that terminal and directory", async () => {
    const { request } = await run("npm test");
    const memory = request?.approvalMemory as Extract<ApprovalMemory, { kind: "key" }>;
    expect(memory.kind).toBe("key");
    expect(isSessionOnlyApprovalMemoryScope(memory.scope)).toBe(true);
    // Each terminal's shell has its own sandbox jail, fixed when it spawned, so a decision for one terminal is not one for another.
    // The key is the tool name and a JSON identity: compare the parsed scope, since JSON escapes the backslashes of a Windows directory.
    expect(memory.key.startsWith("terminal_run:")).toBe(true);
    const { scope } = JSON.parse(memory.key.slice("terminal_run:".length)) as { scope: Record<string, unknown> };
    expect(scope).toMatchObject({ cwd: terminalCwd, tabId: TAB });
    // The directory the card compares is derived, not part of the decision.
    expect(scope).not.toHaveProperty("cwdForMatch");
    expect(memory.key).not.toContain("cwdForMatch");
  });
});
