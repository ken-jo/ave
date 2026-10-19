/**
 * terminal_run: type one approved command into a terminal the user can see.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createTerminalRunTool,
  isCanonicalTerminalRunTool,
  terminalCommandScopeOf,
  type TerminalRunToolDeps,
  type TerminalCommandMismatch,
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
const promptIn = (cwd: string): string => `${mark("D;0")}${mark(`P;Cwd=${encodeURIComponent(cwd)};Keys=emacs;Paste=1`)}${mark("A")}$ ${mark("B")}`;

function readyTracker(cwd = "/repo"): TerminalBlockTracker {
  const tracker = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
  tracker.recordOutput(promptIn(cwd));
  return tracker;
}

/** What the shell prints for one command it ran: the block, then the next prompt. */
function runOutput(command: string, output: string, exit: number, cwd = "/repo"): string {
  return `${command}\r\n${mark(`C;cmdline_url=${encodeURIComponent(command)}`)}${output}${promptIn(cwd).replace(mark("D;0"), mark(`D;${exit}`))}`;
}

function depsWith(overrides: Partial<TerminalRunToolDeps> = {}): TerminalRunToolDeps & {
  typed: Array<[string, number, string]>;
  mismatches: TerminalCommandMismatch[];
} {
  const typed: Array<[string, number, string]> = [];
  const mismatches: TerminalCommandMismatch[] = [];
  const typeCommand: TypeTerminalCommand = async (tabId, windowId, line) => {
    typed.push([tabId, windowId, line]);
    return { ok: true, firstBlockId: 1 };
  };
  return {
    windowIdForHostedSession: (sessionId) => (sessionId === "main" ? WINDOW : null),
    liveOriginSessionId: (sessionId) => (sessionId === "child" ? "main" : undefined),
    activeTerminalTabId: () => "terminal:aaaaaaaa-1",
    boundSurface: () => undefined,
    typeCommand,
    // The operating system agrees with whatever the markers report.
    verifyShell: async (_tabId, _windowId, reportedCwd) => ({ ok: true, cwd: reportedCwd }),
    auditMismatch: (mismatch) => { mismatches.push(mismatch); },
    typed,
    mismatches,
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
        cwdForMatch: "/repo/app",
      });
    });

    it("prefers an explicit tabId, then the conversation's bound terminal, over the active one", async () => {
      registerTerminalBlockTracker("terminal:aaaaaaaa-1", readyTracker(), WINDOW);
      registerTerminalBlockTracker("terminal:aaaaaaaa-2", readyTracker("/two"), WINDOW);
      registerTerminalBlockTracker("terminal:aaaaaaaa-3", readyTracker("/three"), WINDOW);
      const asked: Array<[number, string]> = [];
      const tool = createTerminalRunTool(depsWith({
        boundSurface: (windowId, hostSessionId) => {
          asked.push([windowId, hostSessionId]);
          return { kind: "terminal", tabId: "terminal:aaaaaaaa-2" };
        },
      }));
      expect(await tool.approvalMemoryScope!({ command: "ls" }, { cwd: "/workspace", sessionId: "main" })).toMatchObject({ tabId: "terminal:aaaaaaaa-2", cwd: "/two" });
      expect(await tool.approvalMemoryScope!({ command: "ls", tabId: "terminal:aaaaaaaa-3" }, { cwd: "/workspace", sessionId: "main" }))
        .toMatchObject({ tabId: "terminal:aaaaaaaa-3", cwd: "/three" });
      // A sub-agent of the pane chat types into the same bound terminal: the binding is its host's.
      expect(await tool.approvalMemoryScope!({ command: "ls" }, { cwd: "/workspace", sessionId: "child" })).toMatchObject({ tabId: "terminal:aaaaaaaa-2" });
      expect(asked).toEqual([[WINDOW, "main"], [WINDOW, "main"]]);
    });

    it("refuses a chat bound to a page instead of typing into the active terminal", async () => {
      registerTerminalBlockTracker("terminal:aaaaaaaa-1", readyTracker(), WINDOW);
      const deps = depsWith({ boundSurface: () => ({ kind: "browser", tabId: "browser:aaaaaaaa-4" }) });
      const tool = createTerminalRunTool(deps);
      await expect(Promise.resolve().then(() => tool.approvalMemoryScope!({ command: "ls" }, { cwd: "/workspace", sessionId: "main" })))
        .rejects.toThrow(/bound to a page, not a terminal; pass tabId/);
      // A terminal it names explicitly is still reachable.
      expect(await tool.approvalMemoryScope!({ command: "ls", tabId: "terminal:aaaaaaaa-1" }, { cwd: "/workspace", sessionId: "main" }))
        .toMatchObject({ tabId: "terminal:aaaaaaaa-1" });
      expect(deps.typed).toEqual([]);
    });

    it("fails a chat whose bound terminal is gone, never falling back to the active one", async () => {
      registerTerminalBlockTracker("terminal:aaaaaaaa-1", readyTracker(), WINDOW);
      const tool = createTerminalRunTool(depsWith({ boundSurface: () => ({ kind: "terminal", tabId: "terminal:aaaaaaaa-9" }) }));
      await expect(Promise.resolve().then(() => tool.approvalMemoryScope!({ command: "ls" }, { cwd: "/workspace", sessionId: "main" })))
        .rejects.toThrow(/no terminal with tabId "terminal:aaaaaaaa-9"/);
    });

    it("types into the window's active terminal from a chat bound to nothing", async () => {
      registerTerminalBlockTracker("terminal:aaaaaaaa-1", readyTracker(), WINDOW);
      const tool = createTerminalRunTool(depsWith({ boundSurface: () => undefined }));
      expect(await tool.approvalMemoryScope!({ command: "ls" }, { cwd: "/workspace", sessionId: "main" })).toMatchObject({ tabId: "terminal:aaaaaaaa-1" });
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
      ["the user typed at the prompt", (t: TerminalBlockTracker) => t.recordOutput("git sta"), /holds text they typed/],
      ["the shell exited", (t: TerminalBlockTracker) => t.recordExit(), /shell has exited/],
    ])("refuses before any approval when %s", async (_label, mutate, reason) => {
      const tracker = readyTracker();
      mutate(tracker);
      registerTerminalBlockTracker("terminal:aaaaaaaa-1", tracker, WINDOW);
      const tool = createTerminalRunTool(depsWith());
      await expect(Promise.resolve().then(() => tool.approvalMemoryScope!({ command: "ls" }, { cwd: "/workspace", sessionId: "main" })))
        .rejects.toThrow(reason);
    });

    it("tells a shell still drawing its first prompt to retry, and fish that it is unsupported", async () => {
      const starting = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
      starting.recordOutput(`${mark("P;Cwd=/repo;Keys=emacs;Paste=1")}${mark("A")}$ `);
      registerTerminalBlockTracker("terminal:aaaaaaaa-1", starting, WINDOW);
      const tool = createTerminalRunTool(depsWith());
      const scopeOf = () => Promise.resolve().then(() => tool.approvalMemoryScope!({ command: "ls" }, { cwd: "/workspace", sessionId: "main" }));
      await expect(scopeOf()).rejects.toThrow(/still starting.*retry in a moment/);
      const fish = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: false });
      fish.recordOutput(`${mark("P;Cwd=/repo;Keys=emacs;Paste=1")}${mark("A")}$ `);
      registerTerminalBlockTracker("terminal:aaaaaaaa-1", fish, WINDOW);
      await expect(scopeOf()).rejects.toThrow(/\(fish\).*needs zsh or bash/);
    });

    it("refuses a shell without command markers", async () => {
      registerTerminalBlockTracker("terminal:aaaaaaaa-1", new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true }), WINDOW);
      const tool = createTerminalRunTool(depsWith());
      await expect(Promise.resolve().then(() => tool.approvalMemoryScope!({ command: "ls" }, { cwd: "/workspace", sessionId: "main" })))
        .rejects.toThrow(/reports no command markers/);
    });

    it("reports a terminal that became busy while the card was open, typing nothing", async () => {
      registerTerminalBlockTracker("terminal:aaaaaaaa-1", readyTracker(), WINDOW);
      const deps = depsWith({
        typeCommand: async () => ({ ok: false, reason: "command-running", message: "a command is running in the foreground of the terminal" }),
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

    // Each of these reads differently to the permission rules (bash) than to
    // the terminal's interactive zsh, hides from the card, or outlives the
    // command in the user's shell.
    it.each([
      ["a # comment zsh may run as text", "echo SAFE # ; echo PWNED", /# comment/],
      ["a # comment hiding an rm", "ls # ; rm -rf build", /# comment/],
      ["a comment after an operator", "ls;#x", /# comment/],
      ["a comment after a word", "a #b", /# comment/],
      ["a comment directly after ;", "a;#b", /# comment/],
      ["a comment after a quoted expansion", "echo \"${x#p}\" # ; rm -rf build", /# comment/],
      ["a comment after an expansion holding a quoted brace", "echo ${x:-\"}\"} # ; rm -rf build", /# comment/],
      ["a comment after an ANSI-C quote holding an escaped quote", "echo $'\\'' # x '", /# comment/],
      ["an =command path lookup", "=rm -rf build", /starting with =/],
      ["an =command behind builtin", "builtin =rm x", /starting with =/],
      ["nocorrect", "nocorrect rm -rf build", /nocorrect/],
      ["noglob", "noglob ls *", /noglob/],
      ["the r history re-run", "r ls=rm", /r\/fc history re-run/],
      ["the fc history re-run", "fc -e - ls", /r\/fc history re-run/],
      // Found by terminal-command-differential.test.ts: zsh ran something else.
      ["a zsh =path argument", "ls =rm", /zsh and bash run differently/],
      ["a zsh =path argument behind command", "command echo =ls", /zsh and bash run differently/],
      ["a zsh =path redirect target", "echo x > =ls", /zsh and bash run differently/],
      ["a zsh =path loop value", "for f in =ls; do echo $f; done", /zsh and bash run differently/],
      ["a == outside [[", "[ a == b ]", /zsh and bash run differently/],
      ["a zsh $= split flag", "echo $=x", /zsh and bash run differently/],
      ["a zsh $+ set flag in double quotes", "echo \"$+x\"", /zsh and bash run differently/],
      ["a zsh ${~} glob flag", "echo ${~x}", /zsh and bash run differently/],
      ["a zsh $^ flag", "echo $^x", /zsh and bash run differently/],
      ["zsh repeat", "repeat 2 rm x", /zsh and bash run differently/],
      ["the zsh - precommand modifier", "- rm x", /zsh and bash run differently/],
      ["an assignment after command", "command FOO=1 npm test", /zsh and bash run differently/],
      ["redirections alone (zsh runs cat)", "> out.txt", /zsh and bash run differently/],
      ["an input redirection alone (zsh runs a pager)", "< a.txt", /zsh and bash run differently/],
      ["redirections alone after an operator", "ls && 2>/dev/null", /zsh and bash run differently/],
      ["the zsh >! clobber", "ls >! out", /zsh and bash run differently/],
      ["a combining grapheme joiner", "rm\u034f -rf build", /invisible or blank-looking/],
      ["a hangul choseong filler", "ls \u115f", /invisible or blank-looking/],
      ["a hangul filler", "ls \u3164", /invisible or blank-looking/],
      ["a mongolian variation selector", "ls\u180b", /invisible or blank-looking/],
      ["a variation selector", "ls\ufe0f", /invisible or blank-looking/],
      ["a tag character", "ls\u{e0041}", /invisible or blank-looking/],
      ["the braille blank", "ls \u2800; rm x", /invisible or blank-looking/],
      ["a no-break space", "ls\u00a0-la", /invisible or blank-looking/],
      ["an ideographic space", "ls\u3000-la", /invisible or blank-looking/],
      ["a combining overlay on ASCII", "rm\u0336 -rf build", /invisible or blank-looking/],
      ["a long run of padding", `echo safe${" ".repeat(4000)}; rm -rf build`, /whitespace characters in a row/],
      ["a PROMPT_COMMAND hook", "PROMPT_COMMAND='curl x|sh'", /change the shell/],
      ["a precmd hook", "precmd_functions+=(f)", /change the shell/],
      ["a preexec hook", "preexec_functions=(f)", /change the shell/],
      ["a prompt", "PS1='$(id)'", /change the shell/],
      ["a PS4 trace prompt", "PS4=x", /change the shell/],
      ["a function definition", "f(){ :; }", /change the shell/],
      ["a function shadowing ls", "ls() { rm -rf build; }", /change the shell/],
      ["a PATH export", "export PATH=/tmp:$PATH", /change the shell/],
      ["an IFS assignment", "IFS=x", /change the shell/],
      ["an alias", "alias ls=rm", /change the shell/],
      ["a DEBUG trap", "trap 'rm -rf build' DEBUG", /change the shell/],
      ["a zsh hook", "add-zsh-hook precmd f", /change the shell/],
      ["an option change", "setopt nointeractivecomments", /change the shell/],
      ["sourced code", "source ./x.sh", /change the shell/],
      ["an exported function", "export -f f", /cannot check/],
      ["state changes inside a substitution", "echo $(alias ls=rm)", /change the shell/],
      ["an alias behind time", "time alias ls=rm", /change the shell/],
      ["printf -v PATH", "printf -v PATH x", /change the shell/],
      ["printf -vPATH", "printf -vPATH x", /change the shell/],
      ["read PATH", "read PATH", /change the shell/],
      ["read -r IFS", "read -r IFS", /change the shell/],
      ["zsh read of a prompt variable", "read 'PS1?go'", /change the shell/],
      ["mapfile PATH", "mapfile PATH", /change the shell/],
      ["readarray -t IFS", "readarray -t IFS", /change the shell/],
      ["getopts into PATH", "getopts a PATH", /change the shell/],
      ["read into a name from a variable", "read \"$v\"", /change the shell/],
      ["printf -v into a name from a variable", "printf -v \"$v\" x", /change the shell/],
      ["umask", "umask 000", /change the shell/],
      ["ulimit", "ulimit -n 10", /change the shell/],
      ["zsh sched", "sched +1 ls", /change the shell/],
      ["stty", "stty -echo", /change the shell/],
      ["history edits", "history -c", /change the shell/],
      ["a TMOUT assignment", "TMOUT=1", /change the shell/],
      ["a command name from a variable", "c=alias; $c ls=rm", /cannot check/],
      ["an alias behind command -p", "command -p alias ls=rm", /change the shell/],
      ["a typeset of a prompt", "typeset -g PS1=x", /cannot check/],
      ["a case statement", "case x in a) alias ls=rm;; esac", /cannot check/],
      ["an arithmetic command", "(( x++ ))", /cannot check/],
      ["the marker nonce", "echo $__ave_nonce", /shell-integration names/],
      ["a shell-integration function", "__ave_precmd", /shell-integration names/],
    ])("refuses %s before any approval is asked", async (_label, command, reason) => {
      registerTerminalBlockTracker("terminal:aaaaaaaa-1", readyTracker(), WINDOW);
      const deps = depsWith();
      const tool = createTerminalRunTool(deps);
      await expect(Promise.resolve().then(() => tool.approvalMemoryScope!({ command }, { cwd: "/workspace", sessionId: "main" }))).rejects.toThrow(reason);
      expect(deps.typed).toEqual([]);
    });

    it("accepts quoted #, mid-word #, non-ASCII words and command-scoped variables", async () => {
      registerTerminalBlockTracker("terminal:aaaaaaaa-1", readyTracker(), WINDOW);
      const tool = createTerminalRunTool(depsWith());
      for (const command of [
        "echo 'a # b'",
        "echo \"#hash\"",
        "echo a#b",
        "git log --grep=\\#12",
        "echo \uc548\ub155 && ls \ubb38\uc11c",
        "echo caf\u00e9",
        "PATH=/opt/bin:$PATH make",
        "FOO=1 npm test",
        "export FOO=1",
        "echo $((1 + 2))",
        "echo ${#x}",
        "echo $'it\\'s' ok",
        "read -r line",
        "read -p prompt answer",
        "printf '%s\\n' PATH",
        "getopts ab opt",
        "echo ${x#p}",
        "echo ${x##p}",
        "echo \"${x%%p}\" ${y:-${z#q}}",
        "[[ $a == b ]]",
        "test \"$a\" = b",
        "echo '$=x' \\=x \"=x\" a=b $'$+x'",
        "ls >| out",
      ]) {
        await expect(Promise.resolve(tool.approvalMemoryScope!({ command }, { cwd: "/workspace", sessionId: "main" }))).resolves.toMatchObject({ kind: "terminal-command" });
      }
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
        typeCommand: async (_tabId, _windowId, line) => {
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
      expect(typeSpy).toHaveBeenCalledWith("terminal:aaaaaaaa-1", WINDOW, "npm test", "/repo");
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

    it("reports, audits and fails a run whose shell record names another command than the approved one", async () => {
      const tracker = readyTracker();
      registerTerminalBlockTracker("terminal:aaaaaaaa-1", tracker, WINDOW);
      const deps = depsWith({
        // A line editor that read part of the paste as keys ran something else.
        typeCommand: async () => {
          setTimeout(() => tracker.recordOutput(runOutput("[200~echo hi~", "zsh: bad pattern\r\n", 1)), 5);
          return { ok: true, firstBlockId: 1 };
        },
      });
      const tool = createTerminalRunTool(deps);
      const scope = await tool.approvalMemoryScope!({ command: "echo hi" }, { cwd: "/workspace", sessionId: "main" });
      const result = await tool.execute({ command: "echo hi" }, ctxFor(scope));
      expect(result.isError).toBe(true);
      const parsed = body(result.output as string);
      expect(parsed).toMatchObject({ typed: true, block: { command: "[200~echo hi~" } });
      expect(String(parsed.error)).toContain("terminal:aaaaaaaa-1");
      expect(deps.mismatches).toEqual([{
        sessionId: "main",
        tabId: "terminal:aaaaaaaa-1",
        approvedSha256: sha256Hex("echo hi"),
        ranSha256: sha256Hex("[200~echo hi~"),
      }]);
    });

    it("refuses before any card when the operating system disagrees with the terminal's markers", async () => {
      registerTerminalBlockTracker("terminal:aaaaaaaa-1", readyTracker("/repo"), WINDOW);
      for (const message of [
        "the terminal reported \"/repo\" as its directory, but its shell is in \"/etc\"",
        "the terminal's foreground process is \"python3\", not its zsh shell",
      ]) {
        const deps = depsWith({ verifyShell: async () => ({ ok: false, reason: "cwd-mismatch", message }) });
        const tool = createTerminalRunTool(deps);
        await expect(Promise.resolve().then(() => tool.approvalMemoryScope!({ command: "ls" }, { cwd: "/workspace", sessionId: "main" })))
          .rejects.toThrow(message);
        expect(deps.typed).toEqual([]);
      }
    });

    it("takes the directory the card compares from the operating system", async () => {
      registerTerminalBlockTracker("terminal:aaaaaaaa-1", readyTracker("/repo"), WINDOW);
      const tool = createTerminalRunTool(depsWith({ verifyShell: async () => ({ ok: true, cwd: "/private/Repo" }) }));
      await expect(Promise.resolve(tool.approvalMemoryScope!({ command: "ls" }, { cwd: "/workspace", sessionId: "main" })))
        .resolves.toMatchObject({ cwd: "/repo", cwdForMatch: process.platform === "linux" ? "/private/Repo" : "/private/repo" });
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
        typeCommand: async (_tabId, _windowId, line) => {
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
    const scope = { kind: "terminal-command", commandSha256: "x", tabId: "terminal:aaaaaaaa-1", cwd: "/repo", cwdForMatch: "/repo" } as const;
    expect(terminalCommandScopeOf({ kind: "key", key: "k", scope })).toBe(scope);
    expect(() => terminalCommandScopeOf({ kind: "args" })).toThrow(/without its sealed terminal target/);
    expect(() => terminalCommandScopeOf(undefined)).toThrow(/without its sealed terminal target/);
  });
});
