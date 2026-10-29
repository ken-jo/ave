import { terminalSessionFixture } from "../../__tests__/support/terminal-session-fixtures.js";
/** terminal_run: type one approved command into the invoking conversation's isolated terminal. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HostTerminalControlState } from "../../shared/terminal-session.js";
import type { HostTerminalDisclosure } from "../../main/terminal/host-terminal-control.js";
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

import { TERMINAL_CALLBACK_COMMANDS, TERMINAL_PRINT_DATA_COMMANDS, TERMINAL_PRINT_FORMAT_COMMANDS, TERMINAL_PRINT_TARGET_COMMANDS, TERMINAL_PRINTF_DATA_COMMANDS, TERMINAL_PRINTF_UNCHECKED_COMMANDS, TERMINAL_REGISTRY_COMMANDS } from "../../__tests__/support/terminal-registry-commands.js";
import { terminalCommandTextProblem } from "../../shared/terminal-command-text.js";
import { getLocale, setLocale } from "../../i18n/runtime.js";
import { loadLocaleMessages } from "../../i18n/messages/index.js";
import { t } from "../../i18n/index.js";

describe("terminal executable registries", () => {
  it.each(TERMINAL_REGISTRY_COMMANDS)("refuses mutation: %s", (command) => {
    expect(terminalCommandTextProblem(command)).not.toBeNull();
  });
});

describe("terminal shell callbacks", () => {
  it.each(TERMINAL_CALLBACK_COMMANDS)("refuses callback execution or assignment: %s", (command) => {
    expect(terminalCommandTextProblem(command)).not.toBeNull();
  });

  it.each([
    "mapfile -t -n1 lines < list",
    "readarray -tn1 lines < list",
    "mapfile -dC lines < list",
    "readarray -d C lines < list",
    "mapfile -- lines < list",
    "printf '%%n %s' PATH",
    "printf '%d' 42",
    "printf '%.2f' 1.25",
    "printf -v 'values[0]' '%s' value",
  ])("allows data without callback evaluation: %s", (command) => {
    expect(terminalCommandTextProblem(command)).toBeNull();
  });
});

describe("terminal formatted output", () => {
  it.each(TERMINAL_PRINT_DATA_COMMANDS)("allows print data after option operands: %s", (command) => {
    expect(terminalCommandTextProblem(command)).toBeNull();
  });

  it.each(TERMINAL_PRINT_FORMAT_COMMANDS)("refuses formatted print after option operands: %s", (command) => {
    expect(terminalCommandTextProblem(command)).toBe("unchecked-construct");
  });

  it.each(TERMINAL_PRINT_TARGET_COMMANDS)("refuses unsafe parsed print targets: %s", (command) => {
    expect(terminalCommandTextProblem(command)).toBe("shell-state");
  });

  it.each(TERMINAL_PRINTF_DATA_COMMANDS)("allows numeric and text operands in their consumed positions: %s", (command) => {
    expect(terminalCommandTextProblem(command)).toBeNull();
  });

  it.each(TERMINAL_PRINTF_UNCHECKED_COMMANDS)("refuses unchecked format evaluation: %s", (command) => {
    expect(terminalCommandTextProblem(command)).toBe("shell-state");
  });
});

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
    typed.push([tabId.tabId, windowId, line]);
    return { ok: true, firstBlockId: 1 };
  };
  return {
    windowIdForHostedSession: (sessionId) => (sessionId === "main" ? WINDOW : null),
    liveOriginSessionId: (sessionId) => (sessionId === "child" ? "main" : undefined),
    boundSurface: () => undefined,
    ensureConversationTerminal: async (sessionId) => terminalSessionFixture(sessionId === "child" ? "terminal:child" : "terminal:aaaaaaaa-1"),
    typeCommand,
    // The operating system agrees with whatever the markers report.
    verifyShell: async (_tabId, _windowId, reportedCwd) => ({ ok: true, cwd: reportedCwd }),
    auditMismatch: (mismatch) => { mismatches.push(mismatch); },
    // No host terminal is available unless a test provides one.
    host: {
      session: () => undefined,
      shellName: () => undefined,
      control: () => undefined,
      verifyShell: async () => ({ ok: false, reason: "no-terminal", message: "no host terminal" }),
      typeCommand: async () => ({ ok: false, reason: "no-terminal", message: "no host terminal" }),
      waitDisclosure: async () => undefined,
    },
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
    it("resolves the conversation terminal and seals its id and directory", async () => {
      registerTerminalBlockTracker(terminalSessionFixture("terminal:aaaaaaaa-1"), readyTracker("/repo/app"), WINDOW);
      const tool = createTerminalRunTool(depsWith());
      await expect(Promise.resolve(tool.approvalMemoryScope!({ command: "npm test" }, { cwd: "/workspace", sessionId: "main" }))).resolves.toEqual({
        kind: "terminal-command",
        lane: "agent", terminalSessionId: "terminal:aaaaaaaa-1/agent", sandboxGeneration: "0",
        commandSha256: sha256Hex("npm test"),
        tabId: "terminal:aaaaaaaa-1",
        cwd: "/repo/app",
        cwdForMatch: "/repo/app",
      });
    });

    it("refuses an unavailable bound host terminal without falling back to an isolated terminal", async () => {
      const ensureConversationTerminal = vi.fn(async () => terminalSessionFixture("terminal:aaaaaaaa-1"));
      const deps = depsWith({ boundSurface: () => ({ kind: "terminal", tabId: "terminal:host" }), ensureConversationTerminal });
      const tool = createTerminalRunTool(deps);
      await expect(tool.approvalMemoryScope!({ command: "ls", tabId: "terminal:aaaaaaaa-1" }, { cwd: "/workspace", sessionId: "main" }))
        .rejects.toThrow(/only into this pane chat's own terminal/);
      for (const tabId of [undefined, "terminal:host"]) {
        await expect(tool.approvalMemoryScope!({ command: "ls", ...(tabId ? { tabId } : {}) }, { cwd: "/workspace", sessionId: "main" }))
          .rejects.toThrow(/not available for agent commands/);
      }
      expect(ensureConversationTerminal).not.toHaveBeenCalled();
      expect(deps.typed).toEqual([]);
    });

    it("refuses a host session returned by the conversation backend", async () => {
      const deps = depsWith({ ensureConversationTerminal: async () => terminalSessionFixture("terminal:host", "manual") });
      const tool = createTerminalRunTool(deps);
      await expect(tool.approvalMemoryScope!({ command: "ls" }, { cwd: "/workspace", sessionId: "main" })).rejects.toThrow(/requires an isolated agent terminal/);
      expect(deps.typed).toEqual([]);
    });

    it("uses the isolated conversation terminal for a browser pane", async () => {
      registerTerminalBlockTracker(terminalSessionFixture("terminal:aaaaaaaa-1"), readyTracker(), WINDOW);
      const tool = createTerminalRunTool(depsWith({ boundSurface: () => ({ kind: "browser", tabId: "browser:page" }) }));
      expect(await tool.approvalMemoryScope!({ command: "ls" }, { cwd: "/workspace", sessionId: "main" })).toMatchObject({ tabId: "terminal:aaaaaaaa-1" });
    });

    it("passes the actual child session and main-derived cwd without borrowing its parent's terminal or pane", async () => {
      registerTerminalBlockTracker(terminalSessionFixture("terminal:child"), readyTracker("/child"), WINDOW);
      registerTerminalBlockTracker(terminalSessionFixture("terminal:aaaaaaaa-1"), readyTracker("/parent"), WINDOW);
      const ensureConversationTerminal = vi.fn(async (sessionId: string) => terminalSessionFixture(sessionId === "child" ? "terminal:child" : "terminal:aaaaaaaa-1"));
      const boundSurface = vi.fn((_windowId: number, sessionId: string) => sessionId === "main" ? { kind: "terminal" as const, tabId: "terminal:host" } : undefined);
      const tool = createTerminalRunTool(depsWith({ ensureConversationTerminal, boundSurface }));
      expect(await tool.approvalMemoryScope!({ command: "ls" }, { cwd: "/workspace/child", sessionId: "child" })).toMatchObject({ tabId: "terminal:child", cwd: "/child" });
      expect(boundSurface).toHaveBeenCalledWith(WINDOW, "child");
      expect(ensureConversationTerminal).toHaveBeenCalledWith("child", WINDOW, "/workspace/child");
      await expect(tool.approvalMemoryScope!({ command: "ls", tabId: "terminal:aaaaaaaa-1" }, { cwd: "/workspace", sessionId: "child" })).rejects.toThrow(/cannot target a host terminal or another conversation/);
    });

    it("refuses host and foreign terminal IDs even in the same window, and sessions without a window", async () => {
      registerTerminalBlockTracker(terminalSessionFixture("terminal:host", "manual"), readyTracker(), WINDOW);
      registerTerminalBlockTracker(terminalSessionFixture("terminal:foreign"), readyTracker(), WINDOW);
      const deps = depsWith();
      const tool = createTerminalRunTool(deps);
      for (const tabId of ["terminal:host", "terminal:foreign", "terminal:missing"]) {
        await expect(tool.approvalMemoryScope!({ command: "ls", tabId }, { cwd: "/workspace", sessionId: "main" })).rejects.toThrow(/cannot target a host terminal or another conversation/);
      }
      await expect(tool.approvalMemoryScope!({ command: "ls" }, { cwd: "/workspace", sessionId: "routine" })).rejects.toThrow(/this session has no terminals/);
      expect(deps.typed).toEqual([]);
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
      registerTerminalBlockTracker(terminalSessionFixture("terminal:aaaaaaaa-1"), tracker, WINDOW);
      const tool = createTerminalRunTool(depsWith());
      await expect(Promise.resolve().then(() => tool.approvalMemoryScope!({ command: "ls" }, { cwd: "/workspace", sessionId: "main" })))
        .rejects.toThrow(reason);
    });

    it("tells a shell still drawing its first prompt to retry, and fish that it is unsupported", async () => {
      const starting = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
      starting.recordOutput(`${mark("P;Cwd=/repo;Keys=emacs;Paste=1")}${mark("A")}$ `);
      registerTerminalBlockTracker(terminalSessionFixture("terminal:aaaaaaaa-1"), starting, WINDOW);
      const tool = createTerminalRunTool(depsWith());
      const scopeOf = () => Promise.resolve().then(() => tool.approvalMemoryScope!({ command: "ls" }, { cwd: "/workspace", sessionId: "main" }));
      await expect(scopeOf()).rejects.toThrow(/still starting.*retry in a moment/);
      const fish = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: false });
      fish.recordOutput(`${mark("P;Cwd=/repo;Keys=emacs;Paste=1")}${mark("A")}$ `);
      registerTerminalBlockTracker(terminalSessionFixture("terminal:aaaaaaaa-1"), fish, WINDOW);
      await expect(scopeOf()).rejects.toThrow(/\(fish\).*needs zsh or bash/);
    });

    it("refuses a shell without command markers", async () => {
      registerTerminalBlockTracker(terminalSessionFixture("terminal:aaaaaaaa-1"), new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true }), WINDOW);
      const tool = createTerminalRunTool(depsWith());
      await expect(Promise.resolve().then(() => tool.approvalMemoryScope!({ command: "ls" }, { cwd: "/workspace", sessionId: "main" })))
        .rejects.toThrow(/reports no command markers/);
    });

    it("reports a terminal that became busy while the card was open, typing nothing", async () => {
      registerTerminalBlockTracker(terminalSessionFixture("terminal:aaaaaaaa-1"), readyTracker(), WINDOW);
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
      registerTerminalBlockTracker(terminalSessionFixture("terminal:aaaaaaaa-1"), readyTracker(), WINDOW);
      const deps = depsWith();
      const tool = createTerminalRunTool(deps);
      await expect(Promise.resolve().then(() => tool.approvalMemoryScope!({ command }, { cwd: "/workspace", sessionId: "main" }))).rejects.toThrow();
      const result = await tool.execute({ command }, ctxFor(undefined));
      expect(result.isError).toBe(true);
      expect(deps.typed).toEqual([]);
    });

    // Each of these reads differently to the permission rules (bash) than to the terminal's interactive zsh, hides from the card, or outlives the command in the user's shell.
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
      ["a zsh glob qualifier that runs code", "ls *(e:'touch pwned':)", /cannot check/],
      ["a zsh glob qualifier that calls a command", "ls *(+rm)", /cannot check/],
      ["a parenthesized glob in a redirect target", "echo x > @(a|b)", /cannot check/],
      ["state changes inside a redirect target's substitution", "echo x > \"$(alias ls=rm)\"", /change the shell/],
      // Prompt expansion prints the prompt's B marker; listings print state.
      ["zsh prompt expansion of PS1", "print -rP -- \"$PS1\" | base64", /shell's own state/],
      ["bash prompt expansion of PS1", "echo \"${PS1@P}\" | base64", /shell's own state/],
      ["prompt expansion in the background", "(sleep 3; print -rP -- \"$PS1\") &", /shell's own state/],
      ["print -P of prompt escapes", "print -P '%~'", /shell's own state/],
      ["echo -P", "echo -nP x", /shell's own state/],
      ["a ${@P} transformation of any variable", "echo \"${x@P}\"", /shell's own state/],
      ["a ${@A} declaration dump", "echo \"${x@A}\"", /shell's own state/],
      ["reading PS1", "echo $PS1", /shell's own state/],
      ["reading PS1 through printf", "printf '%s' \"$PS1\"", /shell's own state/],
      ["reading PROMPT_COMMAND", "echo ${PROMPT_COMMAND}", /shell's own state/],
      ["reading the prompt length", "echo ${#PS1}", /shell's own state/],
      ["reading the precmd hooks", "echo $precmd_functions", /shell's own state/],
      ["reading a line-editor setting", "echo $zle_bracketed_paste", /shell's own state/],
      ["a bare export", "export", /shell's own state/],
      ["export -p", "export -p", /cannot check/],
      ["readonly -p", "readonly -p", /cannot check/],
      ["integer, listing", "integer", /shell's own state/],
      ["compgen -v", "compgen -v", /shell's own state/],
      ["vared", "vared x", /shell's own state/],
      ["print -z onto the line editor's stack", "print -z rm -rf build", /shell's own state/],
      ["print -s onto the history", "print -s rm -rf build", /shell's own state/],
      ["history", "history", /history/],
      ["a bare set", "set", /change the shell/],
      ["typeset -p", "typeset -p", /cannot check/],
      ["declare -p", "declare -p", /cannot check/],
      ["a printf option from a variable", "printf $o PATH x", /change the shell/],
      ["print -v PATH", "print -v PATH x", /change the shell/],
      ["printf -v into a name from a variable", "printf -v \"$v\" '%s' x", /change the shell/],
      ["history expansion in double quotes", "echo \"hi !x\"", /history expansion/],
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
      ["an array read callback", "mapfile -C 'PATH=/tmp; :' -c1 lines < list", /change the shell/],
      ["a clustered array read callback", "readarray -tC'PATH=/tmp; :' -c1 lines < list", /change the shell/],
      ["a numeric format assignment", "printf '%d' 'PATH=0'", /change the shell/],
      ["a variable subscript callback", "printf -v 'values[$(echo callback-ran)]' '%s' value", /change the shell/],
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
      registerTerminalBlockTracker(terminalSessionFixture("terminal:aaaaaaaa-1"), readyTracker(), WINDOW);
      const deps = depsWith();
      const tool = createTerminalRunTool(deps);
      await expect(Promise.resolve().then(() => tool.approvalMemoryScope!({ command }, { cwd: "/workspace", sessionId: "main" }))).rejects.toThrow(reason);
      expect(deps.typed).toEqual([]);
    });

    it("accepts quoted #, mid-word #, non-ASCII words and command-scoped variables", async () => {
      registerTerminalBlockTracker(terminalSessionFixture("terminal:aaaaaaaa-1"), readyTracker(), WINDOW);
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
        "read -p message answer",
        "printf '%s\\n' PATH",
        "getopts ab opt",
        "echo ${x#p}",
        "echo ${x##p}",
        "echo \"${x%%p}\" ${y:-${z#q}}",
        "[[ $a == b ]]",
        "test \"$a\" = b",
        "echo '$=x' \\=x \"=x\" a=b $'$+x'",
        "ls >| out",
        "git commit -m 'done!'",
        "echo 'hello!'",
        "echo $'wow!' \\!x",
        "printf '%s\\n' \"$HOME\" \"$x\"",
        "printf -v out '%s' \"$x\"",
        "print -r -- \"$x\"",
        "export FOO=1 BAR",
        "echo $PATH $PSX",
      ]) {
        await expect(Promise.resolve(tool.approvalMemoryScope!({ command }, { cwd: "/workspace", sessionId: "main" }))).resolves.toMatchObject({ kind: "terminal-command" });
      }
    });

    it("accepts ordinary one-line commands, including a test's ! and a != comparison", async () => {
      registerTerminalBlockTracker(terminalSessionFixture("terminal:aaaaaaaa-1"), readyTracker(), WINDOW);
      const tool = createTerminalRunTool(depsWith());
      for (const command of ["npm test -- --watch=false", "[ ! -f x ] && echo missing", "test \"$a\" != b", "git log --oneline | head -5", "echo 'it''s'"]) {
        await expect(Promise.resolve(tool.approvalMemoryScope!({ command }, { cwd: "/workspace", sessionId: "main" }))).resolves.toMatchObject({ kind: "terminal-command" });
      }
    });
  });

  describe("execute", () => {
    it("includes the full Linux window when changed Git protection refuses typing", async () => {
      const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
      Object.defineProperty(process, "platform", { value: "linux", configurable: true });
      try {
        registerTerminalBlockTracker(terminalSessionFixture("terminal:aaaaaaaa-1"), readyTracker(), WINDOW);
        const deps = depsWith({ typeCommand: async () => ({ ok: false, reason: "cwd-unverified", message: t("sandboxPolicy.terminalChanged") }) });
        const tool = createTerminalRunTool(deps);
        const scope = await tool.approvalMemoryScope!({ command: "git status" }, { cwd: "/workspace", sessionId: "main" });
        const result = await tool.execute({ command: "git status" }, ctxFor(scope));
        expect(result.isError).toBe(true);
        expect(JSON.parse(result.output as string)).toMatchObject({
          error: expect.stringContaining(t("sandboxPolicy.terminalChanged")),
          sandboxNotice: t("sandboxPolicy.terminalWindow"),
        });
        expect(deps.typed).toEqual([]);
      } finally { Object.defineProperty(process, "platform", descriptor); }
    });

    it("types the exact command into the sealed terminal and returns its finished block", async () => {
      const tracker = readyTracker();
      registerTerminalBlockTracker(terminalSessionFixture("terminal:aaaaaaaa-1"), tracker, WINDOW);
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
      expect(typeSpy).toHaveBeenCalledWith(expect.objectContaining({ tabId: "terminal:aaaaaaaa-1", lane: "agent", terminalSessionId: "terminal:aaaaaaaa-1/agent" }), WINDOW, "npm test", "/repo", undefined);
      const parsed = body(result.output as string);
      expect(parsed).toMatchObject({ tabId: "terminal:aaaaaaaa-1", typed: true, finished: true });
      expect(parsed.block).toMatchObject({ id: 1, command: "npm test", exitCode: 0, status: "done", cwd: "/repo", output: "3 passed\n" });
    });

    it("keeps typing into the sealed terminal when the user switches terminals while the card is open", async () => {
      vi.useFakeTimers();
      registerTerminalBlockTracker(terminalSessionFixture("terminal:aaaaaaaa-1"), readyTracker(), WINDOW);
      registerTerminalBlockTracker(terminalSessionFixture("terminal:aaaaaaaa-2"), readyTracker(), WINDOW);
      const deps = depsWith();
      const tool = createTerminalRunTool(deps);
      const scope = await tool.approvalMemoryScope!({ command: "ls" }, { cwd: "/workspace", sessionId: "main" });
      const pending = tool.execute({ command: "ls", waitSeconds: 0 }, ctxFor(scope));
      await vi.runAllTimersAsync();
      await pending;
      expect(deps.typed).toEqual([["terminal:aaaaaaaa-1", WINDOW, "ls"]]);
    });

    it("refuses an approved isolated command if the actual conversation becomes host-bound", async () => {
      registerTerminalBlockTracker(terminalSessionFixture("terminal:aaaaaaaa-1"), readyTracker(), WINDOW);
      let hostBound = false;
      const deps = depsWith({ boundSurface: () => hostBound ? { kind: "terminal", tabId: "terminal:host" } : undefined });
      const tool = createTerminalRunTool(deps);
      const scope = await tool.approvalMemoryScope!({ command: "ls" }, { cwd: "/workspace", sessionId: "main" });
      hostBound = true;
      const result = await tool.execute({ command: "ls" }, ctxFor(scope));
      expect(result.isError).toBe(true);
      expect(result.output).toContain("isolated approval no longer applies");
      expect(deps.typed).toEqual([]);
    });

    it("rejects a parent's sealed command when invoked by its child", async () => {
      registerTerminalBlockTracker(terminalSessionFixture("terminal:aaaaaaaa-1"), readyTracker(), WINDOW);
      registerTerminalBlockTracker(terminalSessionFixture("terminal:child"), readyTracker(), WINDOW);
      const deps = depsWith();
      const tool = createTerminalRunTool(deps);
      const scope = await tool.approvalMemoryScope!({ command: "ls" }, { cwd: "/workspace", sessionId: "main" });
      const result = await tool.execute({ command: "ls" }, ctxFor(scope, "child"));
      expect(result.isError).toBe(true);
      expect(result.output).toContain("approved agent terminal changed");
      expect(deps.typed).toEqual([]);
    });

    it("fails as not verified when the shell never reports starting the typed command", async () => {
      vi.useFakeTimers();
      registerTerminalBlockTracker(terminalSessionFixture("terminal:aaaaaaaa-1"), readyTracker(), WINDOW);
      const deps = depsWith();
      const tool = createTerminalRunTool(deps);
      const scope = await tool.approvalMemoryScope!({ command: "ls" }, { cwd: "/workspace", sessionId: "main" });
      const pending = tool.execute({ command: "ls", waitSeconds: 0 }, ctxFor(scope));
      await vi.runAllTimersAsync();
      const result = await pending;
      expect(deps.typed).toEqual([["terminal:aaaaaaaa-1", WINDOW, "ls"]]);
      expect(result.isError).toBe(true);
      expect(body(result.output as string)).toMatchObject({ typed: true, finished: false, error: expect.stringContaining("terminal:aaaaaaaa-1") });
      expect(body(result.output as string)).not.toHaveProperty("block");
    });

    it("reports, audits and fails a run whose shell record names another command than the approved one", async () => {
      const tracker = readyTracker();
      registerTerminalBlockTracker(terminalSessionFixture("terminal:aaaaaaaa-1"), tracker, WINDOW);
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
        tabId: "terminal:aaaaaaaa-1", lane: "agent", terminalSessionId: "terminal:aaaaaaaa-1/agent",
        approvedSha256: sha256Hex("echo hi"),
        ranSha256: sha256Hex("[200~echo hi~"),
      }]);
    });

    it.each(["en", "ko"])("keeps the handler and explains its removal in %s", async (locale) => {
      const previous = getLocale();
      try {
        await loadLocaleMessages(locale);
        setLocale(locale);
        const tracker = readyTracker("/repo");
        tracker.recordOutput(promptIn("/repo").replace("NotFound=0", "NotFound=1"));
        registerTerminalBlockTracker(terminalSessionFixture("terminal:aaaaaaaa-1"), tracker, WINDOW);
        const deps = depsWith();
        const tool = createTerminalRunTool(deps);
        const request = () => Promise.resolve().then(() => tool.approvalMemoryScope!({ command: "ls" }, { cwd: "/workspace", sessionId: "main" }));
        await expect(request()).rejects.toThrow("unset -f command_not_found_handle");
        await expect(request()).rejects.toThrow("unfunction command_not_found_handler");
        await expect(request()).rejects.toThrow(locale === "ko" ? "사용자에게" : "Ask the user");
        expect(deps.typed).toEqual([]);
        expect(tracker.promptState()).toBe("not-found-handler");
      } finally { setLocale(previous); }
    });

    it("refuses before any card when the operating system disagrees with the terminal's markers", async () => {
      registerTerminalBlockTracker(terminalSessionFixture("terminal:aaaaaaaa-1"), readyTracker("/repo"), WINDOW);
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
      registerTerminalBlockTracker(terminalSessionFixture("terminal:aaaaaaaa-1"), readyTracker("/repo"), WINDOW);
      const tool = createTerminalRunTool(depsWith({ verifyShell: async () => ({ ok: true, cwd: "/private/Repo" }) }));
      await expect(Promise.resolve(tool.approvalMemoryScope!({ command: "ls" }, { cwd: "/workspace", sessionId: "main" })))
        .resolves.toMatchObject({ cwd: "/repo", cwdForMatch: process.platform === "linux" ? "/private/Repo" : "/private/repo" });
    });

    it("rejects the old approval when the isolated shell incarnation or sandbox generation changes", async () => {
      for (const changed of [{ terminalSessionId: "replacement" }, { sandboxGeneration: "1" }]) {
        const tracker = readyTracker("/repo");
        registerTerminalBlockTracker(terminalSessionFixture("terminal:aaaaaaaa-1"), tracker, WINDOW);
        let info = terminalSessionFixture("terminal:aaaaaaaa-1");
        const deps = depsWith({ ensureConversationTerminal: async () => info });
        const tool = createTerminalRunTool(deps);
        const scope = await tool.approvalMemoryScope!({ command: "ls" }, { cwd: "/workspace", sessionId: "main" });
        info = { ...info, ...changed };
        const result = await tool.execute({ command: "ls" }, ctxFor(scope));
        expect(result.isError).toBe(true);
        expect(deps.typed).toEqual([]);
      }
    });

    it("refuses when the terminal's shell moved to another directory after approval", async () => {
      const tracker = readyTracker("/repo");
      registerTerminalBlockTracker(terminalSessionFixture("terminal:aaaaaaaa-1"), tracker, WINDOW);
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
      registerTerminalBlockTracker(terminalSessionFixture("terminal:aaaaaaaa-1"), readyTracker(), WINDOW);
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
      registerTerminalBlockTracker(terminalSessionFixture("terminal:aaaaaaaa-1"), tracker, WINDOW);
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
      expect(parsed.continuation).toEqual({ tabId: "terminal:aaaaaaaa-1", terminalSessionId: "terminal:aaaaaaaa-1/agent", blockId: 1 });
    });

    it("rejects a wait outside the policy bounds", async () => {
      registerTerminalBlockTracker(terminalSessionFixture("terminal:aaaaaaaa-1"), readyTracker(), WINDOW);
      const tool = createTerminalRunTool(depsWith());
      await expect(Promise.resolve().then(() => tool.approvalMemoryScope!({ command: "ls", waitSeconds: 101 }, { cwd: "/workspace", sessionId: "main" })))
        .rejects.toThrow(/waitSeconds must be an integer from 0 to 100/);
    });
  });

  it("the authorization step reads the sealed target and refuses an invocation without one", () => {
    const scope = { kind: "terminal-command", lane: "agent", terminalSessionId: "terminal:aaaaaaaa-1/agent", sandboxGeneration: "0", commandSha256: "x", tabId: "terminal:aaaaaaaa-1", cwd: "/repo", cwdForMatch: "/repo" } as const;
    expect(terminalCommandScopeOf({ kind: "key", key: "k", scope })).toBe(scope);
    expect(() => terminalCommandScopeOf({ kind: "args" })).toThrow(/without its sealed terminal target/);
    expect(() => terminalCommandScopeOf(undefined)).toThrow(/without its sealed terminal target/);
  });
});

describe("terminal_run into a pane chat's own host terminal", () => {
  const HOST = "terminal:0000c0de-1";
  let hostDir: string;
  let identity: { dev: bigint; ino: bigint };
  beforeEach(() => {
    hostDir = realpathSync(mkdtempSync(join(tmpdir(), "ave-terminal-run-host-")));
    const stat = statSync(hostDir, { bigint: true });
    identity = { dev: stat.dev, ino: stat.ino };
  });
  afterEach(() => {
    __resetTerminalBlocksForTest();
    rmSync(hostDir, { recursive: true, force: true });
  });

  function hostDeps(options: { control?: HostTerminalControlState; bound?: () => string | undefined; span?: Partial<HostTerminalDisclosure>; tracker?: TerminalBlockTracker; shell?: string } = {}) {
    const session = terminalSessionFixture(HOST, "manual");
    const tracker = options.tracker ?? readyTracker(hostDir);
    registerTerminalBlockTracker(session, tracker, WINDOW);
    const hostTyped: Array<[string, string, string]> = [];
    const control = { value: options.control ?? { mode: "available" as const, generation: 4 } };
    const ensureConversationTerminal = vi.fn(async () => terminalSessionFixture("terminal:aaaaaaaa-1"));
    const deps = depsWith({
      ensureConversationTerminal,
      // Only the exact pane chat "main" is bound; its sub-agent "child" is not.
      boundSurface: (_windowId, sessionId) => {
        const tabId = sessionId === "main" ? (options.bound ?? (() => HOST))() : undefined;
        return tabId === undefined ? undefined : { kind: "terminal", tabId };
      },
      host: {
        session: (tabId) => (tabId === HOST ? session : undefined),
        shellName: () => options.shell ?? "zsh",
        control: () => control.value,
        verifyShell: async (_ref, _windowId, reportedCwd) => ({ ok: true, cwd: reportedCwd }),
        typeCommand: async (_ref, _windowId, sessionId, line, cwd, bound) => {
          hostTyped.push([sessionId, line, cwd]);
          if (!bound()) return { ok: false, reason: "no-terminal", message: "unbound" };
          return { ok: true, firstBlockId: 2 };
        },
        waitDisclosure: async (_ref, _windowId, sessionId, blockId) => sessionId === "main" && blockId === 2 ? {
          requestingSessionId: "main", command: "npm test", cwd: hostDir, blockId: 2, state: "done", exitCode: 0, output: "approved output\n", truncated: false,
          ...options.span,
        } : undefined,
      },
    });
    return { deps, tool: createTerminalRunTool(deps), hostTyped, control, tracker, ensureConversationTerminal };
  }

  it("seals the bound host target, shell, physical directory identity and control generation, without touching an isolated terminal", async () => {
    const { tool, ensureConversationTerminal } = hostDeps();
    const scope = await tool.approvalMemoryScope!({ command: "npm test" }, { cwd: "/workspace", sessionId: "main" });
    expect(scope).toEqual({
      kind: "terminal-command", lane: "manual", commandSha256: sha256Hex("npm test"), tabId: HOST, terminalSessionId: `${HOST}/manual`,
      sessionId: "main", shell: "zsh", cwd: hostDir, physicalCwd: hostDir, cwdDevice: identity.dev.toString(), cwdInode: identity.ino.toString(),
      controlGeneration: 4, cwdForMatch: expect.any(String),
    });
    expect(ensureConversationTerminal).not.toHaveBeenCalled();
    // The pane chat's sub-agent is not the pane chat: it gets its own isolated terminal.
    registerTerminalBlockTracker(terminalSessionFixture("terminal:aaaaaaaa-1"), readyTracker(), WINDOW);
    expect(await tool.approvalMemoryScope!({ command: "npm test" }, { cwd: "/workspace", sessionId: "child" })).toMatchObject({ lane: "agent", tabId: "terminal:aaaaaaaa-1" });
    expect(ensureConversationTerminal).toHaveBeenCalledWith("child", WINDOW, "/workspace");
  });

  it("refuses a startup question before the first marked prompt, a taken-over terminal and an unsupported shell, with clear reasons", async () => {
    const starting = new TerminalBlockTracker({ nonce: NONCE, marksPromptEnd: true });
    starting.recordOutput("zsh compinit: insecure directories, run compaudit for list.\r\nIgnore insecure directories and continue [y] or abort compinit [n]? ");
    await expect(hostDeps({ tracker: starting }).tool.approvalMemoryScope!({ command: "npm test" }, { cwd: "/workspace", sessionId: "main" }))
      .rejects.toThrow(t("be_terminalRun.hostNoPromptYet", { tabId: HOST }));
    __resetTerminalBlocksForTest();
    await expect(hostDeps({ control: { mode: "taken-over", generation: 5 } }).tool.approvalMemoryScope!({ command: "npm test" }, { cwd: "/workspace", sessionId: "main" }))
      .rejects.toThrow(/must hand it back/);
    __resetTerminalBlocksForTest();
    await expect(hostDeps({ shell: "fish" }).tool.approvalMemoryScope!({ command: "npm test" }, { cwd: "/workspace", sessionId: "main" }))
      .rejects.toThrow(/need zsh or bash/);
  });

  it("returns only the lease's own span, never the terminal's scrollback", async () => {
    const tracker = readyTracker(hostDir);
    tracker.recordOutput(runOutput("cat secrets", "HOST-SCROLLBACK-SECRET\n", 0, hostDir));
    const { tool, hostTyped } = hostDeps({ tracker });
    const scope = await tool.approvalMemoryScope!({ command: "npm test" }, { cwd: "/workspace", sessionId: "main" });
    const result = await tool.execute({ command: "npm test" }, ctxFor(scope));
    expect(result.isError).toBeFalsy();
    expect(hostTyped).toEqual([["main", "npm test", hostDir]]);
    expect(body(result.output)).toMatchObject({ terminal: "host", typed: true, finished: true, block: { id: 2, output: "approved output\n", exitCode: 0 } });
    expect(result.output).not.toContain("HOST-SCROLLBACK-SECRET");
    expect(result.output).not.toContain("sandboxNotice");
  });

  it("reports an interrupted span without an exit code, and a mismatched command without any output", async () => {
    const interrupted = hostDeps({ span: { state: "interrupted", interruption: "take-over", exitCode: null, output: "partial" } });
    const scope = await interrupted.tool.approvalMemoryScope!({ command: "npm test" }, { cwd: "/workspace", sessionId: "main" });
    const stopped = body((await interrupted.tool.execute({ command: "npm test" }, ctxFor(scope))).output);
    expect(stopped).toMatchObject({ finished: false, interrupted: "take-over", block: { output: "partial" } });
    expect(stopped.block).not.toHaveProperty("exitCode");
    expect(stopped).not.toHaveProperty("continuation");
    __resetTerminalBlocksForTest();
    const mismatched = hostDeps({ span: { state: "interrupted", interruption: "command-mismatch", output: "" } });
    const sealed = await mismatched.tool.approvalMemoryScope!({ command: "npm test" }, { cwd: "/workspace", sessionId: "main" });
    const result = await mismatched.tool.execute({ command: "npm test" }, ctxFor(sealed));
    expect(result.isError).toBe(true);
    expect(mismatched.deps.mismatches).toEqual([expect.objectContaining({ lane: "manual", tabId: HOST, approvedSha256: sha256Hex("npm test") })]);
  });

  it.each([
    ["another conversation consumes it", (scope: ApprovalMemoryScope) => ({ scope, sessionId: "child" }), /another conversation/],
    ["the control generation moved", (scope: ApprovalMemoryScope) => ({ scope: { ...scope, controlGeneration: 3 } as ApprovalMemoryScope }), /control of terminal/],
    ["the incarnation was replaced", (scope: ApprovalMemoryScope) => ({ scope: { ...scope, terminalSessionId: "retired" } as ApprovalMemoryScope }), /replaced, closed or moved/],
    ["the shell kind differs", (scope: ApprovalMemoryScope) => ({ scope: { ...scope, shell: "bash" } as ApprovalMemoryScope }), /shell changed/],
    ["the directory was replaced on disk", (scope: ApprovalMemoryScope) => ({ scope: { ...scope, cwdInode: "1" } as ApprovalMemoryScope }), /replaced on disk/],
  ])("types nothing when %s after approval", async (_label, change, reason) => {
    const { tool, hostTyped } = hostDeps();
    const sealed = await tool.approvalMemoryScope!({ command: "npm test" }, { cwd: "/workspace", sessionId: "main" });
    const { scope, sessionId } = change(sealed!) as { scope: ApprovalMemoryScope; sessionId?: string };
    const result = await tool.execute({ command: "npm test" }, ctxFor(scope, sessionId));
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(reason);
    expect(hostTyped).toEqual([]);
  });

  it("types nothing once the pane chat binding is gone, and the typing protocol rechecks it", async () => {
    let bound: string | undefined = HOST;
    const { tool, hostTyped } = hostDeps({ bound: () => bound });
    const scope = await tool.approvalMemoryScope!({ command: "npm test" }, { cwd: "/workspace", sessionId: "main" });
    bound = "terminal:other-1";
    const result = await tool.execute({ command: "npm test" }, ctxFor(scope));
    expect(result.isError).toBe(true);
    expect(result.output).toMatch(/no longer this terminal's pane chat/);
    expect(hostTyped).toEqual([]);
  });
});
