// @vitest-environment jsdom
/** The execute child's session id arrives on the executing event when it links; later turn events carry no id and must not erase it. */
import "../../../../../test/renderer/setup.js";
import { act } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WorkBoardPanel } from "../WorkBoardPanel.js";
import type { AveApi } from "../../types.js";
import type { RunProgressEventPayload, WorkItemResolved } from "../../../../shared/work-board-types.js";

const ITEM: WorkItemResolved = {
  id: 9,
  title: "Ship the release notes",
  status: "in_progress",
  status_resolved: "in_progress",
  priority: "medium",
  created_at: "2026-11-04T00:00:00.000Z",
  updated_at: "2026-11-04T00:00:00.000Z",
  runStatus: "executing",
  plan: "PLAN",
  runSessionId: "plan-child-session",
};

describe("Work Board — live execute session id", () => {
  afterEach(() => cleanup());

  it("keeps the execute child id from the linked executing event across later turn events", async () => {
    let progress: ((ev: RunProgressEventPayload) => void) | undefined;
    const noop = () => () => {};
    const api = {
      listWorkBoard: async () => ({ status: "ok" as const, items: [ITEM] }),
      listWorkProposals: async () => ({ status: "ok" as const, proposals: [] }),
      getWorkBoardItem: async () => ({ status: "found" as const, item: ITEM }),
      onWorkBoardItemChanged: noop,
      onWorkProposalChanged: noop,
      onWorkBoardRunProgress: (cb: (ev: RunProgressEventPayload) => void) => {
        progress = cb;
        return () => {};
      },
      onWorkBoardRunStarted: noop,
      onWorkBoardRunFinished: noop,
      onWorkBoardRunFailed: noop,
    } as unknown as AveApi;

    render(<WorkBoardPanel api={api} />);
    fireEvent.click(await screen.findByTestId("work-board-card"));
    await waitFor(() => expect(progress).toBeDefined());

    const at = "2026-11-04T00:00:01.000Z";
    act(() => progress!({ itemId: 9, phase: "executing", runSessionId: "exec-child-session", at }));
    act(() => progress!({ itemId: 9, phase: "executing", turn: 1, text: "working", at }));

    const panel = await screen.findByTestId("work-board-run-output");
    expect(panel.querySelector('[title="exec-child-session"]')).not.toBeNull();
    expect(panel.querySelector('[title="plan-child-session"]')).toBeNull();
  });
});
