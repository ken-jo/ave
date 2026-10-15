/**
 * `terminal_read` LLM tool — read the command blocks of the user's terminal tabs.
 *
 * The workspace terminal records each command it runs as a block (command,
 * working directory, exit code, timing, plain-text output; see
 * main/terminal/terminal-blocks.ts). This tool is the agent's read path to
 * those records, so "why did my build fail?" can be answered from what the
 * user's terminal actually printed.
 *
 *   {}                      → every terminal tab with its recent block summaries
 *                             (the one the user is looking at marked `active`)
 *   { tabId, limit? }       → the newest `limit` blocks of one tab, with output
 *   { tabId, blockId }      → one block with output
 *   { limit } / { blockId } → the same for the window's active terminal, when
 *                             the user is looking at one (a default, not an
 *                             authority: an explicit tabId always wins)
 *
 * Results are framed `<terminal-output trust="untrusted-terminal-data">`
 * (fence-sanitizer.ts): command text and output are whatever programs printed,
 * so the model is told they are data, and no printed close tag can end the
 * frame. Errors are host-written and stay bare JSON.
 *
 * SCOPE. A session sees only the terminals of the app window that hosts it —
 * the window whose rail it can see them in. A sub-agent inherits its parent's
 * window (walking up through nested children); a routine, a work-board run
 * or any session no window hosts has no terminals and is refused.
 *
 * category="read": it reads host-owned records and nothing else — it cannot
 * write to a terminal or start a command. It still takes the ordinary read
 * path (no standing allow), because terminal output can hold private data.
 */
import { createDynamicTool, type Tool } from "./base.js";
import { getWindowTerminalBlockTracker, listTerminalBlockTabs } from "../main/terminal/terminal-blocks.js";
import type { TerminalBlock } from "../shared/terminal-blocks.js";
import { neutralizeFenceClose } from "../shared/fence-sanitizer.js";
import { t } from "../i18n/index.js";

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;
/** Block summaries listed per tab when no tab is named. */
const SUMMARIES_PER_TAB = 10;
/**
 * Output characters returned per call across all blocks. A single block keeps
 * about 72K characters at most (64K head and tail plus its open line); this
 * keeps a 20-block read from flooding the turn.
 */
const MAX_RESPONSE_OUTPUT_CHARS = 96 * 1024;

/** Nested sub-agent levels walked to find the conversation a child belongs to. */
const MAX_SCOPE_DEPTH = 8;

export interface TerminalReadToolDeps {
  /** The window id hosting this interactive session, or null when none does. */
  windowIdForHostedSession: (sessionId: string) => number | null;
  /** The spawning session of a running sub-agent, or undefined for any other session. */
  liveOriginSessionId: (sessionId: string) => string | undefined;
  /** The terminal tab the user is looking at in a window, if a terminal is the active surface. */
  activeTerminalTabId?: (windowId: number) => string | undefined;
}

/**
 * The app window whose terminals `sessionId` may read: its own window when a
 * window hosts it, else its parent's when it is a running sub-agent, else
 * none. Never a default — an unresolved session reads nothing.
 */
export function resolveTerminalWindowId(
  sessionId: string | undefined,
  deps: TerminalReadToolDeps,
): number | null {
  const seen = new Set<string>();
  let current = sessionId;
  for (let depth = 0; current !== undefined && depth <= MAX_SCOPE_DEPTH; depth++) {
    if (seen.has(current)) return null;
    seen.add(current);
    const windowId = deps.windowIdForHostedSession(current);
    if (windowId !== null) return windowId;
    current = deps.liveOriginSessionId(current);
  }
  return null;
}

function failure(error: string) {
  return { output: JSON.stringify({ error }), isError: true };
}

/** The open tag of the fence every successful result is framed in. */
const TERMINAL_OUTPUT_FENCE_OPEN = '<terminal-output trust="untrusted-terminal-data">';

/**
 * Frame a result as untrusted terminal data. Everything in it — command text,
 * output, directories — is whatever programs printed, so no field may close
 * the frame: a forged `</terminal-output>` is neutralized in every string
 * before the JSON is built (afterwards, the inserted backslash could form an
 * invalid JSON escape such as `\ `).
 */
function fenced(payload: unknown) {
  return {
    output: [
      TERMINAL_OUTPUT_FENCE_OPEN,
      t("be_terminalRead.untrusted"),
      JSON.stringify(neutralizeStrings(payload)),
      "</terminal-output>",
    ].join("\n"),
    isError: false,
  };
}

function neutralizeStrings(value: unknown): unknown {
  if (typeof value === "string") return neutralizeFenceClose(value, "terminal-output");
  if (Array.isArray(value)) return value.map(neutralizeStrings);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, neutralizeStrings(entry)]));
  }
  return value;
}

function withOutputBudget(blocks: readonly TerminalBlock[]) {
  let budget = MAX_RESPONSE_OUTPUT_CHARS;
  return blocks.map((block) => {
    const output = block.output.length <= budget
      ? block.output
      : block.output.slice(block.output.length - Math.max(0, budget));
    const clipped = output.length < block.output.length;
    budget -= output.length;
    return {
      ...block,
      output,
      ...(clipped ? { outputClippedForResponse: true } : {}),
    };
  });
}

export function createTerminalReadTool(deps: TerminalReadToolDeps): Tool {
  return createDynamicTool({
    name: "terminal_read",
    description: t("be_terminalRead.toolDescription"),
    source: "builtin",
    category: "read",
    isReadOnly: () => true,
    parallelSafe: true,
    jsonSchema: {
      type: "object",
      properties: {
        tabId: { type: "string", description: t("be_terminalRead.tabIdDescription") },
        blockId: { type: "integer", minimum: 1, description: t("be_terminalRead.blockIdDescription") },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: MAX_LIMIT,
          description: t("be_terminalRead.limitDescription", { defaultLimit: DEFAULT_LIMIT, maxLimit: MAX_LIMIT }),
        },
      },
      additionalProperties: false,
    },
    execute: async (rawInput, ctx) => {
      const input = (rawInput ?? {}) as { tabId?: unknown; blockId?: unknown; limit?: unknown };
      if (input.tabId !== undefined && typeof input.tabId !== "string") {
        return failure("tabId must be a string");
      }
      if (input.blockId !== undefined && (!Number.isInteger(input.blockId) || (input.blockId as number) < 1)) {
        return failure("blockId must be a positive integer");
      }
      if (
        input.limit !== undefined
        && (!Number.isInteger(input.limit) || (input.limit as number) < 1 || (input.limit as number) > MAX_LIMIT)
      ) {
        return failure(`limit must be an integer from 1 to ${MAX_LIMIT}`);
      }
      const sessionId = typeof ctx?.metadata?.sessionId === "string" ? ctx.metadata.sessionId : undefined;
      const windowId = resolveTerminalWindowId(sessionId, deps);
      if (windowId === null) {
        return failure("terminal_read is available only to a conversation in an app window (or its sub-agents); this session has no terminals");
      }
      const activeTabId = deps.activeTerminalTabId?.(windowId);

      if (input.tabId === undefined && input.blockId === undefined && input.limit === undefined) {
        const terminals = listTerminalBlockTabs(windowId).map(({ tabId, tracker }) => ({
          tabId,
          ...(tabId === activeTabId ? { active: true } : {}),
          shellIntegration: tracker.isIntegrated(),
          exited: tracker.hasExited(),
          recentBlocks: tracker.list().slice(0, SUMMARIES_PER_TAB),
        }));
        return fenced({
          terminals,
          ...(terminals.length === 0 ? { note: t("be_terminalRead.noTerminals") } : {}),
        });
      }

      // An explicit tabId wins; without one, blockId/limit read the terminal
      // the user is looking at, when there is one.
      const tabId = (input.tabId as string | undefined) ?? activeTabId;
      if (tabId === undefined) {
        return failure("blockId and limit require tabId when no terminal is active; call terminal_read with no arguments to list terminals");
      }
      // A tab of another window answers exactly like a tab that does not exist.
      const tracker = getWindowTerminalBlockTracker(tabId, windowId);
      if (!tracker) {
        return failure(`no terminal with tabId ${JSON.stringify(tabId)}; call terminal_read with no arguments to list terminals`);
      }
      if (input.blockId !== undefined) {
        const block = tracker.get(input.blockId as number);
        if (!block) return failure(`no block ${String(input.blockId)} in terminal ${tabId}`);
        return fenced({ tabId, block: withOutputBudget([block])[0] });
      }
      const limit = (input.limit as number | undefined) ?? DEFAULT_LIMIT;
      return fenced({
        tabId,
        shellIntegration: tracker.isIntegrated(),
        blocks: withOutputBudget(tracker.recent(limit)),
      });
    },
  });
}
