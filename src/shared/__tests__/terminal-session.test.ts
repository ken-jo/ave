import { describe, expect, it } from "vitest";
import { parseTerminalDataEvent, parseTerminalExitEvent, parseTerminalSessionRef, sameTerminalSession } from "../terminal-session.js";

const ref = { tabId: "terminal:aaaaaaaa-1", lane: "manual" as const, terminalSessionId: "host-1" };
describe("terminal session identity", () => {
  it("requires lane and host incarnation on each internal mutation/event", () => {
    expect(parseTerminalSessionRef(ref)).toEqual(ref);
    for (const value of [{ tabId: ref.tabId }, { ...ref, lane: "host" }, { ...ref, terminalSessionId: "" }, null]) expect(parseTerminalSessionRef(value)).toBeNull();
    expect(parseTerminalDataEvent({ ...ref, chunk: "hello" })).toEqual({ ...ref, chunk: "hello" });
    expect(parseTerminalExitEvent({ ...ref, exitCode: 0, signal: 1 })).toEqual({ ...ref, exitCode: 0, signal: 1 });
    expect(parseTerminalExitEvent({ ...ref, exitCode: NaN })).toBeNull();
    expect(sameTerminalSession(ref, { ...ref, terminalSessionId: "host-2" })).toBe(false);
    expect(sameTerminalSession(ref, { ...ref, lane: "agent" })).toBe(false);
  });
});
