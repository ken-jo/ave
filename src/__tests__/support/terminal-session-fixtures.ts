import type { TerminalLane, TerminalSessionInfo } from "../../shared/terminal-session.js";

export function terminalSessionFixture(tabId: string, lane: TerminalLane = "agent", terminalSessionId = `${tabId}/${lane}`): TerminalSessionInfo {
  const details = { tabId, terminalSessionId, initialCwd: "/workspace", currentCwd: null, cwdSource: "unavailable" as const, shellIntegration: false };
  return lane === "manual" ? { ...details, lane, substrate: "host" }
    : { ...details, lane, substrate: "asrt", sandboxGeneration: "0" };
}
