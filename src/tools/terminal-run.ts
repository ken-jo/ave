/** Type only into the calling conversation's confined shell, never a host terminal.
 * Seal the conversation terminal and cwd before approval and refuse changed targets at execution.
 * Use ordinary shell rules, containment, and sensitive/exfiltration floors; remembered approval covers this exact command/cwd only for the app session.
 * Require a fresh empty shell prompt before approval and execution; refuse busy, unmarked, edited, or exited terminals.
 * Accept only one plain command line with no control/invisible text, history expansion, comments, dialect-only syntax, or persistent shell-state changes. */
import { createDynamicTool, type Tool, type ToolPolicyContext } from "./base.js";
import type { ToolExecutionContext, ToolExecutionResult } from "./types.js";
import { getWindowTerminalBlockTracker, type TerminalBlockTracker } from "../main/terminal/terminal-blocks.js";
import type { TerminalSessionRef, TerminalSessionInfo } from "../shared/terminal-session.js";
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
import { caseFoldForMatch } from "../permissions/sensitive-paths.js";
import { t } from "../i18n/index.js";
import { authorizedApprovalMemoryScope } from "./approval-memory-context.js";
import { resolveSessionWindow, resolveSessionWindowId, type SessionWindowScopeDeps } from "./session-window-scope.js";
import { fenceTerminalData, terminalToolFailure, withOutputBudget } from "./terminal-read.js";

const TERMINAL_RUN_TOOL_NAME = "terminal_run";

const DEFAULT_WAIT_SECONDS = TOOL_TIMEOUT_POLICY.terminalRunWaitDefaultMs / 1000;
const MAX_WAIT_SECONDS = TOOL_TIMEOUT_POLICY.terminalRunWaitMaxMs / 1000;

/** Type a command into a terminal (pty-manager `typeAgentTerminalCommand`): reset the line editor, check the
 * shell against the operating system, paste the line, and press Enter once the edit line shows exactly that line. */
export type TypeTerminalCommand = (
  ref: TerminalSessionRef,
  ownerWindowId: number,
  line: string,
  expectedCwd: string,
  signal?: AbortSignal,
) => Promise<{ ok: true; firstBlockId: number } | { ok: false; reason: string; message: string }>;

/** Check a terminal's shell against the operating system (pty-manager
 * `verifyAgentTerminalShell`): its own process holds the terminal, and its real directory is the one its markers reported. */
type VerifyTerminalShell = (
  ref: TerminalSessionRef,
  ownerWindowId: number,
  reportedCwd: string,
) => Promise<{ ok: true; cwd: string } | { ok: false; reason: string; message: string }>;

/** What the audit log keeps when a terminal ran something other than the approved command. */
export interface TerminalCommandMismatch {
  readonly sessionId: string | undefined;
  readonly tabId: string;
  readonly lane: "agent";
  readonly terminalSessionId: string;
  readonly approvedSha256: string;
  readonly ranSha256: string;
}

export interface TerminalRunToolDeps extends SessionWindowScopeDeps {
  ensureConversationTerminal: (sessionId: string, ownerWindowId: number, cwd?: string, signal?: AbortSignal) => Promise<TerminalSessionInfo>;
  /** Main-owned pane binding for the actual requesting conversation, without parent substitution. */
  boundSurface: (windowId: number, hostSessionId: string) => { kind: "terminal" | "browser"; tabId: string } | undefined;
  /** Type one line into a terminal and press Enter. */
  typeCommand: TypeTerminalCommand;
  /** Check a terminal's shell and directory against the operating system. */
  verifyShell: VerifyTerminalShell;
  /** Record, in the audit log, that a terminal ran a different command than approved. */
  auditMismatch: (mismatch: TerminalCommandMismatch) => void;
}

/** The tools this module created; the only ones the authorization step treats as terminal commands. */
const canonicalTerminalRunTools = new WeakSet<object>();

/** True for a `terminal_run` this module created (never a lookalike registered under the name). */
export function isCanonicalTerminalRunTool(tool: unknown): boolean {
  return typeof tool === "object" && tool !== null && canonicalTerminalRunTools.has(tool);
}

export type TerminalCommandScope = Extract<ApprovalMemoryScope, { kind: "terminal-command" }>;

/** The terminal target sealed into a `terminal_run` invocation's approval memory. Every canonical `terminal_run` invocation has
 * one (its `approvalMemoryScope` returns one or refuses the call), so its absence is a pipeline contract violation and throws. */
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
  "shell-divergent": "command uses a construct an interactive zsh and bash run differently (a word starting with =, a zsh parameter flag such as $=x or $+x, nocorrect, noglob, -, repeat, an assignment after command or builtin, a command of redirections alone, or the r/fc history re-run); rephrase it",
  "shell-state": "command would change the shell for the user's later commands (a function definition, an alias, trap, hook, option or key binding, sourced code, an edit or listing of the shell history, or an assignment to a prompt, hook, PATH or IFS variable); terminal_run does not do that",
  "shell-integration": "command refers to the terminal's own shell-integration names (__ave_*), which terminal_run does not expose",
  "shell-introspection": "command would print the shell's own state (prompt expansion with print -P or ${...@P}, the prompt, hook or line-editor variables such as PS1 or PROMPT_COMMAND, a listing of variables or declarations such as export -p or compgen, vared, or print -z/-s); terminal_run does not expose it",
  "unchecked-construct": "command uses a construct terminal_run cannot check (case, declare, typeset, local, let, ((...)), select, coproc, a glob with parentheses such as *(...), which zsh runs as glob qualifiers, a command name taken from a variable, or a parameter expansion with zsh flags or bash indirection such as ${(P)x} or ${!x}); rephrase it with plain commands",
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

/** How long a call waits for the shell to report starting the typed command, whatever its waitSeconds. */
const BLOCK_START_WAIT_MS = 3_000;

/** Wait until block `id` has opened (or the shell exits), `waitMs` passes, or `signal` aborts. */
function waitForBlockStart(tracker: TerminalBlockTracker, id: number, waitMs: number, signal: AbortSignal | undefined): Promise<void> {
  const started = (): boolean => tracker.get(id) !== null || tracker.hasExited();
  if (started() || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      unsubscribe();
      signal?.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, waitMs);
    const unsubscribe = tracker.subscribe(() => {
      if (started()) finish();
    });
    signal?.addEventListener("abort", finish, { once: true });
  });
}

/** One page of a block wait: the block once it opened, and whether it finished. */
interface BlockWait {
  readonly block: TerminalBlock | null;
  readonly finished: boolean;
}

/** Wait until block `id` is done (or the shell exits), `waitMs` passes, or `signal` aborts; whichever is first. */
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
  /** The terminal this call types into and the directory its shell is in. Throws with the reason when there is none to name. */
  const resolveTarget = async (input: TerminalRunInput, sessionId: string | undefined, initialCwd?: string): Promise<{
    windowId: number;
    tabId: string;
    tracker: TerminalBlockTracker;
    session: Extract<TerminalSessionInfo, { lane: "agent" }>;
    cwd: string;
    /** The directory as the operating system resolves it (realpath). */
    verifiedCwd: string;
  }> => {
    const scope = resolveSessionWindow(sessionId, deps);
    if (scope === null || sessionId === undefined) {
      throw new Error("terminal_run is available only to a conversation in an app window (or its sub-agents); this session has no terminals");
    }
    const { windowId } = scope;
    if (deps.boundSurface(windowId, sessionId)?.kind === "terminal") {
      throw new Error("Agent typing in host terminals is unavailable; run the command yourself or use the conversation's isolated shell tools.");
    }
    const session = await deps.ensureConversationTerminal(sessionId, windowId, initialCwd);
    const tabId = session.tabId;
    if (input.tabId !== undefined && input.tabId !== tabId) throw new Error("terminal_run cannot target a host terminal or another conversation's terminal");
    if (session.lane !== "agent" || session.substrate !== "asrt") throw new Error("terminal_run requires an isolated agent terminal");
    const tracker = getWindowTerminalBlockTracker(session, windowId);
    if (!tracker) {
      throw new Error(`no terminal with tabId ${JSON.stringify(tabId)}; call terminal_read with no arguments to list terminals`);
    }
    const state = tracker.promptState();
    if (state !== "ready") {
      throw new Error(
        `terminal ${tabId} is not waiting at an empty prompt: ${state === "not-found-handler" ? t("be_terminalRun.notFoundHandler") : NOT_READY_REASONS[state]}. `
          + "Nothing was typed; the arguments are fine — call again only after terminal_read shows the terminal idle",
      );
    }
    const cwd = tracker.currentCwd();
    if (cwd === null) throw new Error(`terminal ${tabId} has not reported its working directory yet`);
    // The directory decides the rules, the project rules and the card: take it from the markers only when the operating system agrees.
    const verified = await deps.verifyShell(session, windowId, cwd);
    if (!verified.ok) throw new Error(`terminal ${tabId} cannot take a command: ${verified.message}. Nothing was typed`);
    return { windowId, tabId, tracker, session, cwd, verifiedCwd: verified.cwd };
  };

  const approvalMemoryScope = async (raw: unknown, ctx?: ToolPolicyContext): Promise<ApprovalMemoryScope> => {
    const input = parseInput(raw);
    const target = await resolveTarget(input, ctx?.sessionId, ctx?.cwd);
    return {
      kind: "terminal-command",
      commandSha256: sha256Hex(input.command),
      tabId: target.tabId,
      lane: "agent",
      terminalSessionId: target.session.terminalSessionId,
      sandboxGeneration: target.session.sandboxGeneration,
      cwd: target.cwd,
      // The form the allowed-directory list is kept in (allowed-directories.ts), so the card can
      // compare the two as strings: a symlinked $PWD and a case-folding file system both resolve here.
      cwdForMatch: caseFoldForMatch(target.verifiedCwd),
    };
  };

  const execute = async (raw: unknown, ctx: ToolExecutionContext): Promise<ToolExecutionResult> => {
    const fail = (message: string): ToolExecutionResult => terminalToolFailure(message, "agent");
    let input: TerminalRunInput;
    try {
      input = parseInput(raw);
    } catch (error) {
      return fail((error as Error).message);
    }
    const scope = authorizedApprovalMemoryScope(ctx);
    if (scope?.kind !== "terminal-command" || scope.lane !== "agent" || scope.commandSha256 !== sha256Hex(input.command)
      || (input.tabId !== undefined && input.tabId !== scope.tabId)) {
      return fail("this command was not authorized for a terminal; nothing was typed. Call terminal_run again.");
    }
    const sessionId = typeof ctx?.metadata?.sessionId === "string" ? ctx.metadata.sessionId : undefined;
    const windowId = resolveSessionWindowId(sessionId, deps);
    const tracker = windowId === null ? undefined : getWindowTerminalBlockTracker(scope, windowId);
    if (windowId === null || !tracker) {
      return fail(`terminal ${scope.tabId} is no longer open; nothing was typed`);
    }
    let live: TerminalSessionInfo;
    try {
      if (sessionId === undefined || deps.boundSurface(windowId, sessionId)?.kind === "terminal") {
        return fail("Agent typing in host terminals is unavailable; nothing was typed.");
      }
      live = await deps.ensureConversationTerminal(sessionId, windowId, ctx.cwd, ctx.abortSignal);
    }
    catch (error) { return fail(error instanceof Error ? error.message : "agent terminal unavailable"); }
    if (live.lane !== "agent" || live.tabId !== scope.tabId || live.terminalSessionId !== scope.terminalSessionId || live.sandboxGeneration !== scope.sandboxGeneration) {
      return fail("the approved agent terminal changed; nothing was typed. Call terminal_run again.");
    }
    if (tracker.currentCwd() !== scope.cwd) {
      return fail(
        `terminal ${scope.tabId} moved from ${scope.cwd} to ${tracker.currentCwd() ?? "an unreported directory"} after approval; nothing was typed. Call terminal_run again.`,
      );
    }
    ctx.abortSignal?.throwIfAborted();
    const typed = await deps.typeCommand(scope, windowId, input.command, scope.cwd, ctx.abortSignal);
    if (!typed.ok) {
      return fail(`nothing was typed into terminal ${scope.tabId}: ${typed.message}`);
    }
    // Whatever the wait, give the shell time to report starting the command (its C marker, which records the line it ran), so the line can be checked.
    await waitForBlockStart(tracker, typed.firstBlockId, BLOCK_START_WAIT_MS, ctx.abortSignal);
    const { block, finished } = await waitForBlock(tracker, typed.firstBlockId, input.waitSeconds * 1000, ctx.abortSignal);
    if (block === null) {
      return {
        ...fenceTerminalData({ tabId: scope.tabId, lane: "agent", terminalSessionId: scope.terminalSessionId, typed: true, finished, error: t("be_terminalRun.notVerified", { tabId: scope.tabId }) }),
        isError: true,
      };
    }
    // The shell's own record of what it ran (its C marker) against what was approved. Typing cannot prove the line editor inserted the text as written; this can, after the fact.
    if (block.command.trim() !== input.command.trim()) {
      deps.auditMismatch({
        sessionId,
        tabId: scope.tabId, lane: "agent", terminalSessionId: scope.terminalSessionId,
        approvedSha256: sha256Hex(input.command),
        ranSha256: sha256Hex(block.command),
      });
      return {
        ...fenceTerminalData({
          tabId: scope.tabId, lane: "agent", terminalSessionId: scope.terminalSessionId,
          typed: true,
          error: t("be_terminalRun.ranDifferentCommand", { tabId: scope.tabId }),
          finished,
          block: withOutputBudget([block])[0],
        }),
        isError: true,
      };
    }
    return fenceTerminalData({
      tabId: scope.tabId, lane: "agent", terminalSessionId: scope.terminalSessionId,
      typed: true,
      finished,
      block: withOutputBudget([block])[0],
      ...(finished ? {} : { note: t("be_terminalRun.stillRunning", { tabId: scope.tabId, blockId: block.id }), continuation: { tabId: scope.tabId, terminalSessionId: scope.terminalSessionId, blockId: block.id } }),
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
    // As for `bash`: the command carries the permission scope, so a bare tool-name allow never covers every command.
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
  "pending-input": "the user is typing at the prompt, pressed a key since it was drawn, or it holds text they typed and have not run",
  "no-bracketed-paste": "its shell does not take bracketed paste, so typed text could be read as keys; terminal_run needs zsh 5.1 or bash 4.4 or later, and zsh without a right-hand prompt (RPROMPT)",
  "vi-editing-mode": "its shell uses vi key bindings, where typed text can be read as editing commands; terminal_run needs emacs key bindings",
  "not-found-handler": "command-not-found handler",
  "shell-starting": "its shell is still starting and has not finished its first prompt; retry in a moment",
  "no-prompt-end-marker": "its shell does not mark the end of its prompt (fish), so whether the user is typing there cannot be told; terminal_run needs zsh or bash",
};
