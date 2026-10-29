import {
  _reserveConversationTerminalForTest, spawnTerminal as spawnLane, writeTerminal as writeLane,
  releaseConversationTerminals, _conversationTerminalOwnerForTest,
  resizeTerminal as resizeLane, typeAgentTerminalCommand, verifyAgentTerminalShell,
  type SpawnTerminalOptions,
} from "../../main/terminal/pty-manager.js";
import { getTerminalBlockTracker as getTracker } from "../../main/terminal/terminal-blocks.js";
import type { TerminalSessionRef } from "../../shared/terminal-session.js";
import { terminalSessionFixture } from "./terminal-session-fixtures.js";

const refs = new Map<string, TerminalSessionRef>();
const ref = (tabId: string): TerminalSessionRef => refs.get(tabId) ?? terminalSessionFixture(tabId);
export async function spawnTerminal(options: Omit<SpawnTerminalOptions, "lane">) {
  _reserveConversationTerminalForTest(options.tabId, options.tabId, options.ownerWindowId ?? null, options.cwd);
  const result = await spawnLane({ ...options, lane: "agent" });
  if (result.ok) refs.set(options.tabId, result.session);
  return result;
}
export const getTerminalBlockTracker = (tabId: string) => getTracker(ref(tabId));
export const writeTerminal = (tabId: string, data: string) => writeLane(ref(tabId), data);
export const resizeTerminal = (tabId: string, cols: number, rows: number) => resizeLane(ref(tabId), cols, rows);
export const typeTerminalCommand = (tabId: string, ownerWindowId: number, line: string, cwd: string, signal?: AbortSignal) =>
  typeAgentTerminalCommand(ref(tabId), ownerWindowId, line, cwd, signal);
export const verifyTerminalShell = (tabId: string, ownerWindowId: number, cwd: string) => verifyAgentTerminalShell(ref(tabId), ownerWindowId, cwd);

/** End the conversation represented by this deterministic backend fixture identity. */
export const killTerminal = (sessionId: string) => releaseConversationTerminals((id) => id === sessionId);
export const conversationOwnedBy = (sessionId: string, ownerWindowId: number | null) => {
  const owner = _conversationTerminalOwnerForTest(sessionId);
  return owner === undefined || owner === ownerWindowId;
};
