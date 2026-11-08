import { describe, expect, it } from "vitest";
import { runAgentStatus, type LiveRunEntry } from "../work-board/LiveRunPanel.js";
import type { RunPhase } from "../../hooks/use-work-board-run.js";
import type { ApprovalRequest } from "../../types.js";

const entry = (phase: RunPhase | undefined, extra: { stopping?: boolean; approvals?: number } = {}): LiveRunEntry => ({
  item: {} as LiveRunEntry["item"],
  run: {
    busy: true, phase, turns: [], sessionIds: [], tools: [], steers: [], stopping: extra.stopping ?? false, phaseAt: {},
  },
  approvals: Array.from({ length: extra.approvals ?? 0 }, () => ({}) as ApprovalRequest),
});

describe("runAgentStatus — a work-board run in the agent status slot", () => {
  it.each([
    [undefined, { working: true, badge: null }],
    ["planning", { working: true, badge: null }],
    ["executing", { working: true, badge: null }],
    ["awaiting_approval", { working: false, badge: "waiting" }],
    ["done", { working: false, badge: null }],
    ["cancelled", { working: false, badge: "exited" }],
    ["error", { working: false, badge: "error" }],
    ["denied", { working: false, badge: "blocked" }],
  ] as const)("phase %s", (phase, expected) => {
    expect(runAgentStatus(entry(phase))).toEqual(expected);
  });

  it("a tool approval outranks the phase, and stopping outranks both", () => {
    expect(runAgentStatus(entry("executing", { approvals: 1 }))).toEqual({ working: false, badge: "waiting" });
    expect(runAgentStatus(entry("executing", { approvals: 1, stopping: true }))).toEqual({ working: true, badge: null });
  });
});
