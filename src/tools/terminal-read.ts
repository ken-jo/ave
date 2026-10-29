/** Read only the calling conversation's confined terminal; host terminal output requires explicit user attachment.
 * Frame command/output records as sanitized untrusted data; this ordinary permission-checked read cannot type or spawn. */
import { createDynamicTool, type Tool } from "./base.js";
import { getWindowTerminalBlockTracker, getWindowTerminalBlockSession } from "../main/terminal/terminal-blocks.js";
import { sameTerminalSession, type TerminalSessionRef } from "../shared/terminal-session.js";
import type { TerminalBlock } from "../shared/terminal-blocks.js";
import { neutralizeFenceClose } from "../shared/fence-sanitizer.js";
import { t } from "../i18n/index.js";
import { resolveSessionWindow, resolveSessionWindowId, type SessionWindowScopeDeps } from "./session-window-scope.js";
import { terminalSandboxWindowNotice } from "../main/terminal/terminal-sandbox-policy.js";

const DEFAULT_LIMIT = 5;
const MAX_LIMIT = 20;
/** Block summaries listed per tab when no tab is named. */
const SUMMARIES_PER_TAB = 10;
/** Output characters returned per call across all blocks. A single block keeps about 72K characters
 * at most (64K head and tail plus its open line); this keeps a 20-block read from flooding the turn. */
const MAX_RESPONSE_OUTPUT_CHARS = 96 * 1024;

export interface TerminalReadToolDeps extends SessionWindowScopeDeps {
  /** Main-owned isolated-terminal identity for the exact invoking session. Never spawns a terminal. */
  conversationTerminalRef: (sessionId: string, windowId: number) => TerminalSessionRef | undefined;
}

/** The app window whose terminals `sessionId` may read (session-window-scope.ts): its own window, else its parent's when it is a running sub-agent, else none. */
export function resolveTerminalWindowId(
  sessionId: string | undefined,
  deps: SessionWindowScopeDeps,
): number | null {
  return resolveSessionWindowId(sessionId, deps);
}

export function terminalToolFailure(error: string, lane?: TerminalSessionRef["lane"]) {
  const notice = lane === "agent" ? terminalSandboxWindowNotice() : undefined;
  return { output: JSON.stringify({ error, ...(notice === undefined ? {} : { sandboxNotice: notice }) }), isError: true };
}

/** The open tag of the fence every successful result is framed in. */
const TERMINAL_OUTPUT_FENCE_OPEN = '<terminal-output trust="untrusted-terminal-data">';

/** Frame a result as untrusted terminal data. Everything in it; command text, output, directories; is whatever programs printed, so no field may close the frame: a
 * forged `</terminal-output>` is neutralized in every string before the JSON is built (afterwards, the inserted backslash could form an invalid JSON escape such as `\ `). */
export function fenceTerminalData(payload: unknown) {
  const notice = terminalSandboxWindowNotice();
  const record = payload !== null && typeof payload === "object" ? payload as Record<string, unknown> : undefined;
  const agentSession = record?.lane === "agent" || (Array.isArray(record?.terminals)
    && record.terminals.some(session => session !== null && typeof session === "object" && session.lane === "agent"));
  const annotated = notice !== undefined && agentSession ? { ...record, sandboxNotice: notice } : payload;
  return {
    output: [
      TERMINAL_OUTPUT_FENCE_OPEN,
      t("be_terminalRead.untrusted"),
      JSON.stringify(neutralizeStrings(annotated)),
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

export function withOutputBudget(blocks: readonly TerminalBlock[]) {
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
        lane: { type: "string", enum: ["agent"], description: t("be_terminalRead.laneDescription") },
        terminalSessionId: { type: "string", description: t("be_terminalRead.sessionDescription") },
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
      if (rawInput !== undefined && (rawInput === null || typeof rawInput !== "object" || Array.isArray(rawInput))) return terminalToolFailure("terminal_read expects an object");
      const input = (rawInput ?? {}) as { tabId?: unknown; lane?: unknown; terminalSessionId?: unknown; blockId?: unknown; limit?: unknown };
      if (Object.keys(input).some((key) => !["tabId", "lane", "terminalSessionId", "blockId", "limit"].includes(key))) return terminalToolFailure("unknown terminal_read argument");
      if (input.tabId !== undefined && typeof input.tabId !== "string") {
        return terminalToolFailure("tabId must be a string");
      }
      if (input.blockId !== undefined && (!Number.isInteger(input.blockId) || (input.blockId as number) < 1)) {
        return terminalToolFailure("blockId must be a positive integer");
      }
      if (
        input.limit !== undefined
        && (!Number.isInteger(input.limit) || (input.limit as number) < 1 || (input.limit as number) > MAX_LIMIT)
      ) {
        return terminalToolFailure(`limit must be an integer from 1 to ${MAX_LIMIT}`);
      }
      const sessionId = typeof ctx?.metadata?.sessionId === "string" ? ctx.metadata.sessionId : undefined;
      const scope = resolveSessionWindow(sessionId, deps);
      if (scope === null || sessionId === undefined) {
        return terminalToolFailure("terminal_read is available only to a conversation in an app window (or its sub-agents); this session has no terminals");
      }
      const { windowId } = scope;
      const owned = deps.conversationTerminalRef(sessionId, windowId);

      if (Object.keys(input).length === 0) {
        const tracker = owned?.lane === "agent" ? getWindowTerminalBlockTracker(owned, windowId) : undefined;
        const session = owned?.lane === "agent" ? getWindowTerminalBlockSession(owned, windowId) : undefined;
        const terminals = tracker && session?.lane === "agent" ? [{
          ...session, exited: tracker.hasExited(), recentBlocks: tracker.list().slice(0, SUMMARIES_PER_TAB),
        }] : [];
        return fenceTerminalData({
          terminals,
          ...(terminals.length === 0 ? { note: t("be_terminalRead.noTerminals") } : {}),
        });
      }

      if (input.lane !== "agent") return terminalToolFailure("Host terminal output is private; ask the user to attach a command block explicitly.");
      if (typeof input.terminalSessionId !== "string" || !input.terminalSessionId) {
        return terminalToolFailure("targeted terminal_read requires lane and terminalSessionId; call terminal_read with no arguments to list sessions");
      }

      const tabId = (input.tabId as string | undefined) ?? owned?.tabId;
      if (tabId === undefined) {
        return terminalToolFailure("blockId and limit require tabId when no terminal is active; call terminal_read with no arguments to list terminals");
      }
      // A tab of another window answers exactly like a tab that does not exist.
      const ref: TerminalSessionRef = { tabId, lane: input.lane, terminalSessionId: input.terminalSessionId };
      if (!owned || owned.lane !== "agent" || !sameTerminalSession(owned, ref)) {
        return terminalToolFailure("No matching isolated terminal belongs to this conversation.");
      }
      const tracker = getWindowTerminalBlockTracker(ref, windowId);
      const session = getWindowTerminalBlockSession(ref, windowId);
      if (!tracker || !session) {
        return terminalToolFailure(`no terminal with tabId ${JSON.stringify(tabId)}; call terminal_read with no arguments to list terminals`, ref.lane);
      }
      if (input.blockId !== undefined) {
        const block = tracker.get(input.blockId as number);
        if (!block) return terminalToolFailure(`no block ${String(input.blockId)} in terminal ${tabId}`, ref.lane);
        return fenceTerminalData({ ...session, block: withOutputBudget([block])[0] });
      }
      const limit = (input.limit as number | undefined) ?? DEFAULT_LIMIT;
      return fenceTerminalData({
        ...session,
        blocks: withOutputBudget(tracker.recent(limit)),
      });
    },
  });
}
