import type { TerminalLane, TerminalSessionInfo } from "../../shared/terminal-session.js";
import type { TerminalReviewFile } from "../../shared/terminal-file-review.js";

export function terminalSessionFixture(tabId: string, lane: TerminalLane = "agent", terminalSessionId = `${tabId}/${lane}`): TerminalSessionInfo {
  const details = { tabId, terminalSessionId, initialCwd: "/workspace", currentCwd: null, cwdSource: "unavailable" as const, shellIntegration: false };
  return lane === "manual" ? { ...details, lane, substrate: "host" }
    : { ...details, lane, substrate: "asrt", sandboxGeneration: "0" };
}

/** A changed-file entry's review as its operation and hunks of [before, after] text, for comparing evidence snapshots. */
export function reviewChange(entry: TerminalReviewFile | undefined): { operation: string; hunks: string[][] } | undefined {
  return entry?.review ? { operation: entry.review.operation, hunks: entry.review.hunks.map(hunk => [hunk.oldText, hunk.newText]) } : undefined;
}
