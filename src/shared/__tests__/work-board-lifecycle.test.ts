import { describe, expect, it } from "vitest";
import { workBoardMoveRefusal, workBoardReviewKind, workBoardStage, WORK_BOARD_STAGES } from "../work-board-lifecycle.js";
import type { WorkItem } from "../work-board-types.js";

const item: WorkItem = { id: 1, title: "Export notes", status: "planned", priority: "medium", created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z" };
const result: WorkItem = { ...item, runStatus: "completed", output: "Exported notes" };
const plan: WorkItem = { ...item, runId: "run", runStatus: "awaiting_approval", plan: "Export notes", planApproval: { runId: "run", planHash: "hash", itemDigest: "digest", requestedAt: item.created_at, status: "pending", revision: 0 } };

describe("work board lifecycle projection", () => {
  it.each(["planned", "in_progress", "completed"] as const)("retains stored %s without review", status => {
    expect(workBoardStage({ ...item, status })).toBe(status);
  });
  it("derives a pending plan into one review lane", () => {
    expect(workBoardStage(plan)).toBe("review");
    expect(workBoardReviewKind(plan)).toBe("plan");
    expect(workBoardReviewKind({ ...plan, runId: "another" })).toBeNull();
  });
  it("requires a successful result with output", () => {
    expect(workBoardStage(result)).toBe("review");
    for (const runStatus of ["error", "cancelled"] as const) expect(workBoardStage({ ...result, runStatus })).toBe("planned");
    expect(workBoardStage({ ...result, output: " " })).toBe("planned");
  });
  it("projects active runs into In progress without rewriting storage", () => {
    for (const runStatus of ["planning", "executing"] as const) expect(workBoardStage({ ...item, runStatus })).toBe("in_progress");
    expect(item.status).toBe("planned");
  });
  it("preserves historical completion", () => expect(workBoardStage({ ...result, status: "completed" })).toBe("completed"));
  it("fails explicitly on unknown stored values", () => {
    expect(() => workBoardStage({ ...item, status: "review" as WorkItem["status"] })).toThrow("Unknown stored");
    expect(() => workBoardStage({ ...item, status: "other" as WorkItem["status"] })).toThrow("Unknown stored");
  });
  it("allows ordinary stored transitions", () => {
    for (const target of ["planned", "in_progress", "completed"] as const) expect(workBoardMoveRefusal(item, target)).toBeNull();
  });
  it("prevents free form review moves", () => expect(workBoardMoveRefusal(item, "review")).toBe("moveReviewDerived"));
  it("routes pending plans through their own decision flow", () => {
    for (const target of WORK_BOARD_STAGES) expect(workBoardMoveRefusal(plan, target)).toBe("movePlanDecision");
  });
  it("locks live runs and allows only completion of a reviewed result", () => {
    for (const runStatus of ["planning", "executing"] as const) for (const target of WORK_BOARD_STAGES) expect(workBoardMoveRefusal({ ...item, runStatus }, target)).toBe("moveRunActive");
    expect(workBoardMoveRefusal(result, "completed")).toBeNull();
    expect(workBoardMoveRefusal(result, "planned")).toBe("moveResultDecision");
    expect(workBoardMoveRefusal({ ...result, status: "completed" }, "in_progress")).toBe("moveResultDecision");
    expect(workBoardMoveRefusal({ ...result, status: "completed" }, "review")).toBeNull();
  });
});
