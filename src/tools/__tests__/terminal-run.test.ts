/**
 * terminal_run: type one approved command into a terminal the user can see.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTerminalRunTool,
  isCanonicalTerminalRunTool,
  terminalCommandScopeOf,
  type TerminalRunToolDeps,
  type TypeTerminalCommand,
} from "../terminal-run.js";
import {
  TerminalBlockTracker,
  registerTerminalBlockTracker,
  __resetTerminalBlocksForTest,
} from "../../main/terminal/terminal-blocks.js";
import { APPROVAL_MEMORY_SCOPE_METADATA_KEY } from "../approval-memory-context.js";
import { sha256Hex } from "../../lib/hex-digest-equal.js";
import type { ApprovalMemoryScope } from "../../shared/permissions-events.js";
import type { ToolExecutionContext } from "../types.js";
import { TERMINAL_TEST_NONCE, terminalMarker } from "../../__tests__/support/terminal-markers.js";

const WINDOW = 1;
const NONCE = TERMINAL_TEST_NONCE;
const mark = terminalMarker;
/** A shell that finished a command and shows an empty prompt in `cwd`. */
const promptIn = (cwd: string): string => `${mark("D;0")}${mark(`P;Cwd=${encodeURIComponent(cwd)}`)}${mark("A")}$ ${mark("B")}`;

function readyTracker(cwd = "/repo"): TerminalBlockTracker {
  const tracker = new TerminalBlockTracker({ nonce: NONCE });
  tracker.recordOutput(promptIn(cwd));
  return tracker;
}

/** What the shell prints for one command it ran: the block, then the next prompt. */
function runOutput(command: string, output: string, exit: number, cwd = "/repo"): string {
  return `${command}\r\n${mark(`C;cmdline_url=${encodeURIComponent(command)}`)}${output}${promptIn(cwd).replace(mark("D;0"), mark(`D;${exit}`))}`;
}

function depsWith(overrides: Partial<TerminalRunToolDeps> = {}): TerminalRunToolDeps & { typed: Array<[string, number, string]> } {
  const typed: Array<[string, number, string]> = [];
  const typeCommand: TypeTerminalCommand = (tabId, windowId, line) => {
    typed.push([tabId, windowId, line]);
    return { ok: true, firstBlockId: 1 };
  };
  return {
    windowIdForHostedSession: (sessionId) => (sessionId === "main" ? WINDOW : null),
    liveOriginSessionId: (sessionId) => (sessionId === "child" ? "main" : undefined),
    activeTerminalTabId: () => "terminal:aaaaaaaa-1",
    typeCommand,
    typed,
    ...overrides,
  };
}

const ctxFor = (scope: ApprovalMemoryScope | undefined, sessionId = "main", signal?: AbortSignal) => ({
  cwd: "/workspace",
  extraAllowedDirectories: [],
  metadata: {
    sessionId,
    ...(scope === undefined ? {} : { [APPROVAL_MEMORY_SCOPE_METADATA_KEY]: scope }),
  },
  ...(signal ? { abortSignal: signal } : {}),
}) as unknown as ToolExecutionContext;

function body(output: string): Record<string, unknown> {
  const lines = output.split("\n");
  expect(lines[0]).toBe('<terminal-output trust="untrusted-terminal-data">');
  expect(lines.at(-1)).toBe("</terminal-output>");
  return JSON.parse(lines[2]!) as Record<string, unknown>;
}

afterEach(() => {
  __resetTerminalBlocksForTest();
  vi.useRealTimers();
});

describe("terminal_run", () => {
  it("is a canonical builtin in the shell category", () => {
    const tool = createTerminalRunTool(depsWith());
    expect(tool).toMatchObject({ name: "terminal_run", source: "builtin", category: "shell" });
    expect(tool.isReadOnly({ command: "ls" })).toBe(false);
    expect(isCanonicalTerminalRunTool(tool)).toBe(true);
    expect(isCanonicalTerminalRunTool({ ...tool })).toBe(false);
  });

  describe("target, sealed before approval", () => {
    it("defaults to the window's active terminal and seals its id and directory", async () => {
      registerTerminalBlockTracker("terminal:aaaaaaaa-1", readyTracker("/repo/app"), WINDOW);
      const tool = createTerminalRunTool(depsWith());
      await expect(Promise.resolve(tool.approvalMemoryScope!({ command: "npm test" }, { cwd: "/workspace", sessionId: "main" }))).resolves.toEqual({
        kind: "terminal-command",
        commandSha256: sha256Hex("npm test"),
        tabId: "terminal:aaaaaaaa-1",
        cwd: "/repo/app",
      });
    });

    it("prefers an explicit tabId, then the conversation's bound terminal, over the active one", async () => {
      registerTerminalBlockTracker("terminal:aaaaaaaa-1", readyTracker(), WINDOW);
      registerTerminalBlockTracker("terminal:aaaaaaaa-2", readyTracker("/two"), WINDOW);
      registerTerminalBlockTracker("terminal:aaaaaaaa-3", readyTracker("/three"), WINDOW);
      const tool = createTerminalRunTool(depsWith({ boundTerminalTabId: () => "terminal:aaaaaaaa-2" }));
      expect(await tool.approvalMemoryScope!({ command: "ls" }, { cwd: "/workspace", sessionId: "main" })).toMatchObject({ tabId: "terminal:aaaaaaaa-2", cwd: "/two" });
      expect(await tool.approvalMemoryScope!({ command: "ls", tabId: "terminal:aaaaaaaa-3" }, { cwd: "/workspace", sessionId: "main" }))
        .toMatchObject({ tabId: "terminal:aaaaaaaa-3", cwd: "/three" });
    });

    it("a sub-agent reaches its parent's window", async () => {
      registerTerminalBlockTracker("terminal:aaaaaaaa-1", readyTracker(), WINDOW);
      const tool = createTerminalRunTool(depsWith());
      expect(await tool.approvalMemoryScope!({ command: "ls" }, { cwd: "/workspace", sessionId: "child" })).toMatchObject({ tabId: "terminal:aaaaaaaa-1" });
    });

    it("fails clearly when there is no terminal to name, and never picks one itself", async () => {
      registerTerminalBlockTracker("terminal:aaaaaaaa-1", readyTracker(), WINDOW);
      const tool = createTerminalRunTool(depsWith({ activeTerminalTabId: () => undefined }));
      await expect(Promise.resolve().then(() => tool.approvalMemoryScope!({ command: "ls" }, { cwd: "/workspace", sessionId: "main" })))
        .rejects.toThrow(/no terminal is bound to this conversation or shown in its window; pass tabId/);
    });

    it("refuses another window's terminal exactly like a missing one, and a session with no window", async () => {
      registerTerminalBlockTracker("terminal:bbbbbbbb-1", readyTracker(), 2);
      const tool = createTerminalRunTool(depsWith());
      await expect(Promise.resolve().then(() => tool.approvalMemoryScope!({ command: "ls", tabId: "terminal:bbbbbbbb-1" }, { cwd: "/workspace", sessionId: "main" })))
        .rejects.toThrow(/no terminal with tabId "terminal:bbbbbbbb-1"/);
      await expect(Promise.resolve().then(() => tool.approvalMemoryScope!({ command: "ls" }, { cwd: "/workspace", sessionId: "routine" })))
        .rejects.toThrow(/this session has no terminals/);
    });
  });

  describe("busy terminal", () => {
    it.each([
      ["a command is running", (t: TerminalBlockTracker) => t.recordOutput(`vim\r\n${mark("C;cmdline_url=vim")}~\r\n`), /command or full-screen program is running/],
      ["the user typed at the prompt", (t: TerminalBlockTracker) => t.recordOutput("git sta"), /holds text the user typed/],
      ["the shell exited", (t: TerminalBlockTracker) => t.recordExit(), /shell has exited/],
    ])("refuses before any approval when %s", async (_label, mutate, reason) => {
      const tracker = readyTracker();
      mutate(tracker);
      registerTerminalBlockTracker("terminal:aaaaaaaa-1", tracker, WINDOW);
      const tool = createTerminalRunTool(depsWith());
      await expect(Promise.resolve().then(() => tool.approvalMemoryScope!({ command: "ls" }, { cwd: "/workspace", sessionId: "main" })))
        .rejects.toThrow(reason);
    });

    it("refuses a shell without command markers", async () => {
      registerTerminalBlockTracker("terminal:aaaaaaaa-1", new TerminalBlockTracker({ nonce: NONCE }), WINDOW);
      const tool = createTerminalRunTool(depsWith());
      await expect(Promise.resolve().then(() => tool.approvalMemoryScope!({ command: "ls" }, { cwd: "/workspace", sessionId: "main" })))
        .rejects.toThrow(/reports no command markers/);
    });

    it("reports a terminal that became busy while the card was open, typing nothing", async () => {
      registerTerminalBlockTracker("terminal:aaaaaaaa-1", readyTracker(), WINDOW);
      const deps = depsWith({
        typeCommand: () => ({ ok: false, reason: "command-running", message: "a command is running in the foreground of the terminal" }),
      });
      const tool = createTerminalRunTool(deps);
      const scope = await tool.approvalMemoryScope!({ command: "ls" }, { cwd: "/workspace", sessionId: "main" });
      const result = await tool.execute({ command: "ls" }, ctxFor(scope));
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.output as string).error).toMatch(/nothing was typed into terminal terminal:aaaaaaaa-1: a command is running/);
    });
  });

  describe("text that would act as keys", () => {
    it.each([
      ["a newline", "ls\nrm -rf ~"],
      ["a carriage return", "ls\rrm -rf ~"],
      ["a tab", "ls\t"],
      ["an escape sequence", "echo \u001b[200~hi\u001b[201~"],
      ["Ctrl-C", "ls\u0003"],
      ["a C1 control", "ls\u009b31m"],
      ["a bidirectional override", "echo \u202esafe"],
      ["a zero-width space", "rm\u200b -rf build"],
      ["history expansion", "echo !!"],
      ["quick substitution", "^ls^rm"],
      ["an open quote", "echo \"unterminated"],
      ["a trailing backslash", "echo hi \\"],
      ["a here-document", "cat <<EOF"],
    ])("refuses %s before any approval is asked", async (_label, command) => {
      registerTerminalBlockTracker("terminal:aaaaaaaa-1", readyTracker(), WINDOW);
      const deps = depsWith();
      const tool = createTerminalRunTool(deps);
      await expect(Promise.resolve().then(() => tool.approvalMemoryScope!({ command }, { cwd: "/workspace", sessionId: "main" }))).rejects.toThrow();
      const result = await tool.execute({ command }, ctxFor(undefined));
      expect(result.isError).toBe(true);
      expect(deps.typed).toEqual([]);
    });

    it("accepts ordinary one-line commands, including a test's ! and a != comparison", async () => {
      registerTerminalBlockTracker("terminal:aaaaaaaa-1", readyTracker(), WINDOW);
      const tool = createTerminalRunTool(depsWith());
      for (const command of ["npm test -- --watch=false", "[ ! -f x ] && echo missing", "test \"$a\" != b", "git log --oneline | head -5", "echo 'it''s'"]) {
        await expect(Promise.resolve(tool.approvalMemoryScope!({ command }, { cwd: "/workspace", sessionId: "main" }))).resolves.toMatchObject({ kind: "terminal-command" });
      }
    });
  });

  describe("execute", () => {
    it("types the exact command into the sealed terminal and returns its finished block", async () => {
      const tracker = readyTracker();
      registerTerminalBlockTracker("terminal:aaaaaaaa-1", tracker, WINDOW);
      const deps = depsWith({
        typeCommand: (_tabId, _windowId, line) => {
          // The shell echoes and runs it a moment later.
          setTimeout(() => tracker.recordOutput(runOutput(line, "3 passed\r\n", 0)), 5);
          return { ok: true, firstBlockId: 1 };
        },
      });
      const typeSpy = vi.spyOn(deps, "typeCommand");
      const tool = createTerminalRunTool(deps);
      const scope = await tool.approvalMemoryScope!({ command: "npm test" }, { cwd: "/workspace", sessionId: "main" });
      const result = await tool.execute({ command: "npm test" }, ctxFor(scope));
      expect(result.isError).toBe(false);
      expect(typeSpy).toHaveBeenCalledWith("terminal:aaaaaaaa-1", WINDOW, "npm test");
      const parsed = body(result.output as string);
      expect(parsed).toMatchObject({ tabId: "terminal:aaaaaaaa-1", typed: true, finished: true });
      expect(parsed.block).toMatchObject({ id: 1, command: "npm test", exitCode: 0, status: "done", cwd: "/repo", output: "3 passed\n" });
    });

    it("keeps typing into the sealed terminal when the user switches terminals while the card is open", async () => {
      registerTerminalBlockTracker("terminal:aaaaaaaa-1", readyTracker(), WINDOW);
      registerTerminalBlockTracker("terminal:aaaaaaaa-2", readyTracker(), WINDOW);
      let active = "terminal:aaaaaaaa-1";
      const deps = depsWith({ activeTerminalTabId: () => active });
      const tool = createTerminalRunTool(deps);
      const scope = await tool.approvalMemoryScope!({ command: "ls" }, { cwd: "/workspace", sessionId: "main" });
      active = "terminal:aaaaaaaa-2";
      await tool.execute({ command: "ls", waitSeconds: 0 }, ctxFor(scope));
      expect(deps.typed).toEqual([["terminal:aaaaaaaa-1", WINDOW, "ls"]]);
    });

    it("refuses when the terminal's shell moved to another directory after approval", async () => {
      const tracker = readyTracker("/repo");
      registerTerminalBlockTracker("terminal:aaaaaaaa-1", tracker, WINDOW);
      const deps = depsWith();
      const tool = createTerminalRunTool(deps);
      const scope = await tool.approvalMemoryScope!({ command: "rm -rf build" }, { cwd: "/workspace", sessionId: "main" });
      tracker.recordOutput(runOutput("cd /", "", 0, "/"));
      const result = await tool.execute({ command: "rm -rf build" }, ctxFor(scope));
      expect(result.isError).toBe(true);
      expect(JSON.parse(result.output as string).error).toMatch(/moved from \/repo to \/ after approval; nothing was typed/);
      expect(deps.typed).toEqual([]);
    });

    it("refuses a call whose authorized scope is missing or names another command", async () => {
      registerTerminalBlockTracker("terminal:aaaaaaaa-1", readyTracker(), WINDOW);
      const deps = depsWith();
      const tool = createTerminalRunTool(deps);
      const other = await tool.approvalMemoryScope!({ command: "ls" }, { cwd: "/workspace", sessionId: "main" });
      for (const scope of [undefined, other]) {
        const result = await tool.execute({ command: "rm -rf build" }, ctxFor(scope));
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.output as string).error).toMatch(/not authorized for a terminal; nothing was typed/);
      }
      expect(deps.typed).toEqual([]);
    });

    it("returns a still-running block when the wait ends first", async () => {
      vi.useFakeTimers();
      const tracker = readyTracker();
      registerTerminalBlockTracker("terminal:aaaaaaaa-1", tracker, WINDOW);
      const deps = depsWith({
        typeCommand: (_tabId, _windowId, line) => {
          tracker.recordOutput(`${line}\r\n${mark(`C;cmdline_url=${encodeURIComponent(line)}`)}building…\r\n`);
          return { ok: true, firstBlockId: 1 };
        },
      });
      const tool = createTerminalRunTool(deps);
      const scope = await tool.approvalMemoryScope!({ command: "make" }, { cwd: "/workspace", sessionId: "main" });
      const pending = tool.execute({ command: "make", waitSeconds: 2 }, ctxFor(scope));
      await vi.advanceTimersByTimeAsync(2_000);
      const parsed = body((await pending).output as string);
      expect(parsed).toMatchObject({ finished: false, block: { id: 1, status: "running", output: "building…\n" } });
      expect(parsed.note).toMatch(/terminal_read \(tabId terminal:aaaaaaaa-1, blockId 1\)/);
    });

    it("rejects a wait outside the policy bounds", async () => {
      registerTerminalBlockTracker("terminal:aaaaaaaa-1", readyTracker(), WINDOW);
      const tool = createTerminalRunTool(depsWith());
      await expect(Promise.resolve().then(() => tool.approvalMemoryScope!({ command: "ls", waitSeconds: 101 }, { cwd: "/workspace", sessionId: "main" })))
        .rejects.toThrow(/waitSeconds must be an integer from 0 to 100/);
    });
  });

  it("the authorization step reads the sealed target and refuses an invocation without one", () => {
    const scope = { kind: "terminal-command", commandSha256: "x", tabId: "terminal:aaaaaaaa-1", cwd: "/repo" } as const;
    expect(terminalCommandScopeOf({ kind: "key", key: "k", scope })).toBe(scope);
    expect(() => terminalCommandScopeOf({ kind: "args" })).toThrow(/without its sealed terminal target/);
    expect(() => terminalCommandScopeOf(undefined)).toThrow(/without its sealed terminal target/);
  });
});
