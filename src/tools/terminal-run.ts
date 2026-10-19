/**
 * `terminal_run` LLM tool — run one command in a terminal the user can see.
 *
 * The command is typed into the terminal's shell and Enter is pressed, as if
 * the user had typed it: it appears and runs in the visible terminal, under
 * the terminal's own OS sandbox (pty-manager.ts), and its output is recorded
 * as a command block like any other. The tool waits (bounded) for that block
 * and returns it through the same frame as `terminal_read`.
 *
 *   { command }                   the chat's bound terminal, else the one the user is looking at
 *   { command, tabId }            a named terminal of this window (from terminal_read)
 *   { command, waitSeconds }      how long to wait for the command to finish (0: return at once)
 *
 * TARGET. Resolved once, before any approval is asked, and sealed into the
 * invocation's approval scope (`terminal-command`): an explicit tabId wins,
 * then the terminal the conversation is bound to (when the host binds one),
 * then the window's active terminal. With none of them — or a tabId this
 * window does not have — the call fails and names the way out; it never
 * picks a terminal on its own. Execute types into the SEALED terminal, and
 * refuses when its shell has since moved to another directory: switching
 * terminals or `cd`-ing while the card is open cannot redirect an approval.
 *
 * PERMISSION. Category `shell`, so the call takes the shell lane of the one
 * pipeline the `bash` tool takes: the invocation runner's shape-based shell
 * checks (path containment and the structural validator read the `command`
 * argument), and the permission manager's `Bash(...)` deny/ask/allow rules
 * and credential-exfiltration and sensitive-path floors, which read this
 * command as their rule subject in the terminal's directory
 * (invocation-authorization.ts). Not auto-allowed means an approval card.
 * A remembered decision covers this exact command in this directory, for
 * this app session only.
 *
 * BUSY TERMINAL. The shell's own command markers decide (terminal-blocks.ts
 * `promptState`): the command is typed only at an empty prompt. A running
 * command or full-screen program, a prompt holding the user's unfinished
 * typing or a keystroke too recent to have been echoed, a shell between
 * prompts, an exited shell, a shell with no markers at all, or one that marks
 * no end of prompt (fish) is refused with the reason — before the card when
 * it is already so, and again at execute time.
 *
 * TEXT. One line of plain characters that zsh and bash both run exactly as
 * shown and as the rules read it (terminal-command-text.ts): no newline, tab,
 * ESC or other control or invisible character, no long whitespace run, no
 * history expansion, no `#` comment or zsh-only construct, nothing that
 * changes the shell for the user's later commands, nothing left open.
 */
import { createDynamicTool, type Tool, type ToolPolicyContext } from "./base.js";
import type { ToolExecutionContext, ToolExecutionResult } from "./types.js";
import { getWindowTerminalBlockTracker, type TerminalBlockTracker } from "../main/terminal/terminal-blocks.js";
import type { TerminalBlock } from "../shared/terminal-blocks.js";
import type { ApprovalMemory, ApprovalMemoryScope } from "../shared/permissions-events.js";
import {
  MAX_TERMINAL_COMMAND_CHARS,
  MAX_TERMINAL_COMMAND_WHITESPACE_RUN,
  terminalCommandTextProblem,
  type TerminalCommandTextProblem,
} from "../shared/terminal-command-text.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import { sha256Hex } from "../lib/hex-digest-equal.js";
import { canonicalizePathForMatch, caseFoldForMatch } from "../permissions/sensitive-paths.js";
import { t } from "../i18n/index.js";
import { authorizedApprovalMemoryScope } from "./approval-memory-context.js";
import { resolveSessionWindowId, type SessionWindowScopeDeps } from "./session-window-scope.js";
import { fenceTerminalData, terminalToolFailure, withOutputBudget } from "./terminal-read.js";

const TERMINAL_RUN_TOOL_NAME = "terminal_run";

const DEFAULT_WAIT_SECONDS = TOOL_TIMEOUT_POLICY.terminalRunWaitDefaultMs / 1000;
const MAX_WAIT_SECONDS = TOOL_TIMEOUT_POLICY.terminalRunWaitMaxMs / 1000;

/** What typing a command into a terminal reports (pty-manager `typeTerminalCommand`). */
export type TypeTerminalCommand = (
  tabId: string,
  ownerWindowId: number,
  line: string,
) => { ok: true; firstBlockId: number } | { ok: false; reason: string; message: string };

export interface TerminalRunToolDeps extends SessionWindowScopeDeps {
  /** The terminal tab the user is looking at in a window, if a terminal is the active surface. */
  activeTerminalTabId: (windowId: number) => string | undefined;
  /**
   * The terminal a conversation is bound to (a chat docked beside that
   * terminal), when the host binds conversations to terminals. Consulted
   * before the active terminal; a bound tab that is gone fails the call.
   */
  boundTerminalTabId?: (sessionId: string) => string | undefined;
  /** Type one line into a terminal and press Enter. */
  typeCommand: TypeTerminalCommand;
}

/** The tools this module created — the only ones the authorization step treats as terminal commands. */
const canonicalTerminalRunTools = new WeakSet<object>();

/** True for a `terminal_run` this module created (never a lookalike registered under the name). */
export function isCanonicalTerminalRunTool(tool: unknown): boolean {
  return typeof tool === "object" && tool !== null && canonicalTerminalRunTools.has(tool);
}

export type TerminalCommandScope = Extract<ApprovalMemoryScope, { kind: "terminal-command" }>;

/**
 * The terminal target sealed into a `terminal_run` invocation's approval
 * memory. Every canonical `terminal_run` invocation has one (its
 * `approvalMemoryScope` returns one or refuses the call), so its absence is a
 * pipeline contract violation and throws.
 */
export function terminalCommandScopeOf(memory: ApprovalMemory | undefined): TerminalCommandScope {
  if (memory?.kind !== "key" || memory.scope.kind !== "terminal-command") {
    throw new Error("terminal_run reached authorization without its sealed terminal target");
  }
  return memory.scope;
}

interface TerminalRunInput {
  readonly command: string;
  readonly tabId?: string;
  readonly waitSeconds: number;
}

const TEXT_PROBLEM_MESSAGES: Record<TerminalCommandTextProblem, string> = {
  empty: "command is empty",
  "too-long": `command is longer than ${MAX_TERMINAL_COMMAND_CHARS} characters`,
  "multi-line": "command must be a single line; join steps with && or ; instead of newlines",
  "control-character": "command holds a control character (tab, escape or similar), which the terminal would act on as a key",
  "invisible-character": "command holds an invisible or blank-looking character (a format character, a non-ASCII space, a filler, a combining mark on ASCII), so the approval card would not show what the shell reads",
  "whitespace-run": `command holds more than ${MAX_TERMINAL_COMMAND_WHITESPACE_RUN} whitespace characters in a row, which would push the rest of it out of view`,
  "history-expansion": "command uses shell history expansion (a ! before a word, or a leading ^), which would run text nobody approved; quote or rephrase it",
  comment: "command holds a # comment, which some interactive shells run as text; remove it",
  "shell-divergent": "command uses a construct an interactive zsh and bash run differently (a command word starting with =, nocorrect, noglob, or the r/fc history re-run); rephrase it",
  "shell-state": "command would change the shell for the user's later commands (a function definition, an alias, trap, hook, option or key binding, sourced code, or an assignment to a prompt, hook, PATH or IFS variable); terminal_run does not do that",
  "shell-integration": "command refers to the terminal's own shell-integration names (__ave_*), which terminal_run does not expose",
  "unchecked-construct": "command uses a construct terminal_run cannot check (case, declare, typeset, local, let, ((...)), select, coproc, or a command name taken from a variable); rephrase it with plain commands",
  incomplete: "command is not one complete shell command (an open quote, here-document, trailing operator or backslash), so the shell would wait for more input",
};

/** Validate the input shape and text; throws with the reason (an input error). */
function parseInput(raw: unknown): TerminalRunInput {
  const input = raw !== null && typeof raw === "object" && !Array.isArray(raw) ? raw as Record<string, unknown> : {};
  for (const key of Object.keys(input)) {
    if (key !== "command" && key !== "tabId" && key !== "waitSeconds") throw new Error(`unknown argument ${JSON.stringify(key)}`);
  }
  if (typeof input.command !== "string") throw new Error("command must be a string");
  const problem = terminalCommandTextProblem(input.command);
  if (problem !== null) throw new Error(TEXT_PROBLEM_MESSAGES[problem]);
  if (input.tabId !== undefined && typeof input.tabId !== "string") throw new Error("tabId must be a string");
  const waitSeconds = input.waitSeconds ?? DEFAULT_WAIT_SECONDS;
  if (!Number.isInteger(waitSeconds) || (waitSeconds as number) < 0 || (waitSeconds as number) > MAX_WAIT_SECONDS) {
    throw new Error(`waitSeconds must be an integer from 0 to ${MAX_WAIT_SECONDS}`);
  }
  return {
    command: input.command,
    ...(input.tabId === undefined ? {} : { tabId: input.tabId as string }),
    waitSeconds: waitSeconds as number,
  };
}

/** One page of a block wait: the block once it opened, and whether it finished. */
interface BlockWait {
  readonly block: TerminalBlock | null;
  readonly finished: boolean;
}

/**
 * Wait until block `id` is done (or the shell exits), `waitMs` passes, or
 * `signal` aborts — whichever is first.
 */
function waitForBlock(
  tracker: TerminalBlockTracker,
  id: number,
  waitMs: number,
  signal: AbortSignal | undefined,
): Promise<BlockWait> {
  const settled = (): BlockWait | null => {
    const block = tracker.get(id);
    if (block?.status === "done") return { block, finished: true };
    if (tracker.hasExited()) return { block, finished: block !== null };
    return null;
  };
  const now = settled();
  if (now !== null || waitMs === 0 || signal?.aborted) return Promise.resolve(now ?? { block: tracker.get(id), finished: false });
  return new Promise((resolve) => {
    let done = false;
    const finish = (result: BlockWait): void => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unsubscribe();
      signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = (): void => finish({ block: tracker.get(id), finished: false });
    const timer = setTimeout(() => finish({ block: tracker.get(id), finished: false }), waitMs);
    const unsubscribe = tracker.subscribe(() => {
      const result = settled();
      if (result !== null) finish(result);
    });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function createTerminalRunTool(deps: TerminalRunToolDeps): Tool {
  /**
   * The terminal this call types into and the directory its shell is in.
   * Throws with the reason when there is none to name.
   */
  const resolveTarget = (input: TerminalRunInput, sessionId: string | undefined): {
    windowId: number;
    tabId: string;
    tracker: TerminalBlockTracker;
    cwd: string;
  } => {
    const windowId = resolveSessionWindowId(sessionId, deps);
    if (windowId === null) {
      throw new Error("terminal_run is available only to a conversation in an app window (or its sub-agents); this session has no terminals");
    }
    const bound = input.tabId === undefined && sessionId !== undefined ? deps.boundTerminalTabId?.(sessionId) : undefined;
    const tabId = input.tabId ?? bound ?? deps.activeTerminalTabId(windowId);
    if (tabId === undefined) {
      throw new Error("no terminal is bound to this conversation or shown in its window; pass tabId (call terminal_read with no arguments to list terminals)");
    }
    // A tab of another window answers exactly like a tab that does not exist.
    const tracker = getWindowTerminalBlockTracker(tabId, windowId);
    if (!tracker) {
      throw new Error(`no terminal with tabId ${JSON.stringify(tabId)}; call terminal_read with no arguments to list terminals`);
    }
    const state = tracker.promptState();
    if (state !== "ready") {
      throw new Error(
        `terminal ${tabId} is not waiting at an empty prompt: ${NOT_READY_REASONS[state]}. `
          + "Nothing was typed; the arguments are fine — call again only after terminal_read shows the terminal idle",
      );
    }
    const cwd = tracker.currentCwd();
    if (cwd === null) throw new Error(`terminal ${tabId} has not reported its working directory yet`);
    return { windowId, tabId, tracker, cwd };
  };

  const approvalMemoryScope = (raw: unknown, ctx?: ToolPolicyContext): ApprovalMemoryScope => {
    const input = parseInput(raw);
    const target = resolveTarget(input, ctx?.sessionId);
    return {
      kind: "terminal-command",
      commandSha256: sha256Hex(input.command),
      tabId: target.tabId,
      cwd: target.cwd,
      // The form the allowed-directory list is kept in (allowed-directories.ts),
      // so the card can compare the two as strings: a symlinked $PWD and a
      // case-folding file system both resolve here.
      cwdForMatch: caseFoldForMatch(canonicalizePathForMatch(target.cwd)),
    };
  };

  const execute = async (raw: unknown, ctx: ToolExecutionContext): Promise<ToolExecutionResult> => {
    let input: TerminalRunInput;
    try {
      input = parseInput(raw);
    } catch (error) {
      return terminalToolFailure((error as Error).message);
    }
    const scope = authorizedApprovalMemoryScope(ctx);
    if (scope?.kind !== "terminal-command" || scope.commandSha256 !== sha256Hex(input.command)
      || (input.tabId !== undefined && input.tabId !== scope.tabId)) {
      return terminalToolFailure("this command was not authorized for a terminal; nothing was typed. Call terminal_run again.");
    }
    const sessionId = typeof ctx?.metadata?.sessionId === "string" ? ctx.metadata.sessionId : undefined;
    const windowId = resolveSessionWindowId(sessionId, deps);
    const tracker = windowId === null ? undefined : getWindowTerminalBlockTracker(scope.tabId, windowId);
    if (windowId === null || !tracker) {
      return terminalToolFailure(`terminal ${scope.tabId} is no longer open; nothing was typed`);
    }
    if (tracker.currentCwd() !== scope.cwd) {
      return terminalToolFailure(
        `terminal ${scope.tabId} moved from ${scope.cwd} to ${tracker.currentCwd() ?? "an unreported directory"} after approval; nothing was typed. Call terminal_run again.`,
      );
    }
    ctx.abortSignal?.throwIfAborted();
    const typed = deps.typeCommand(scope.tabId, windowId, input.command);
    if (!typed.ok) {
      return terminalToolFailure(`nothing was typed into terminal ${scope.tabId}: ${typed.message}`);
    }
    const { block, finished } = await waitForBlock(tracker, typed.firstBlockId, input.waitSeconds * 1000, ctx.abortSignal);
    return fenceTerminalData({
      tabId: scope.tabId,
      typed: true,
      finished,
      ...(block === null ? {} : { block: withOutputBudget([block])[0] }),
      ...(finished ? {} : {
        note: block === null
          ? t("be_terminalRun.notStarted", { tabId: scope.tabId })
          : t("be_terminalRun.stillRunning", { tabId: scope.tabId, blockId: block.id }),
      }),
    });
  };

  const tool = createDynamicTool({
    name: TERMINAL_RUN_TOOL_NAME,
    description: t("be_terminalRun.toolDescription"),
    source: "builtin",
    category: "shell",
    isReadOnly: () => false,
    jsonSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          maxLength: MAX_TERMINAL_COMMAND_CHARS,
          description: t("be_terminalRun.commandDescription"),
        },
        tabId: { type: "string", description: t("be_terminalRun.tabIdDescription") },
        waitSeconds: {
          type: "integer",
          minimum: 0,
          maximum: MAX_WAIT_SECONDS,
          description: t("be_terminalRun.waitSecondsDescription", { defaultWait: DEFAULT_WAIT_SECONDS, maxWait: MAX_WAIT_SECONDS }),
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
    // As for `bash`: the command carries the permission scope, so a bare
    // tool-name allow never covers every command.
    approvalCacheKey: (raw) => sha256Hex(JSON.stringify({ command: parseInput(raw).command })),
    approvalMemoryScope,
    execute,
  });
  canonicalTerminalRunTools.add(tool);
  return tool;
}

const NOT_READY_REASONS: Record<Exclude<ReturnType<TerminalBlockTracker["promptState"]>, "ready">, string> = {
  "no-shell-integration": "its shell reports no command markers, so whether it is at its prompt cannot be told",
  exited: "its shell has exited",
  "command-running": "a command or full-screen program is running in its foreground",
  "between-prompts": "its shell has not shown its next prompt yet",
  "pending-input": "the user is typing at the prompt, or it holds text they typed and have not run",
  "shell-starting": "its shell is still starting and has not finished its first prompt; retry in a moment",
  "no-prompt-end-marker": "its shell does not mark the end of its prompt (fish), so whether the user is typing there cannot be told; terminal_run needs zsh or bash",
};
