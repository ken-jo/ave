// @vitest-environment jsdom
/** The compact running card: a chip that says which phase and turn the agent is on and how long the run has gone, one line of
 * the agent's latest narration, both in the footprint the idle card had. */
import "../../../../../test/renderer/setup.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, render, screen, within } from "@testing-library/react";
import { WorkBoardPanel } from "../WorkBoardPanel.js";
import type { AveApi } from "../../types.js";
import type {
  RunProgressEventPayload,
  RunTranscriptEvent,
  WorkItemResolved,
} from "../../../../shared/work-board-types.js";
import { t } from "../../../../i18n/runtime.js";

const STARTED_AT = "2026-11-04T03:00:00.000Z";
const STARTED_MS = Date.parse(STARTED_AT);

function item(overrides: Partial<WorkItemResolved> = {}): WorkItemResolved {
  return {
    id: 4,
    title: "Add login regression test",
    detail: "Reproduce the redirect loop",
    status: "in_progress",
    status_resolved: "in_progress",
    priority: "high",
    created_at: "2026-11-04T02:00:00.000Z",
    updated_at: "2026-11-04T02:00:00.000Z",
    runStatus: "executing",
    runId: "run-b",
    runHistory: [{ runId: "run-b", startedAt: STARTED_AT, status: "planning" }],
    ...overrides,
  };
}

const TRANSCRIPT: RunTranscriptEvent[] = [
  { ts: "2026-11-04T03:00:05.000Z", phase: "planning", kind: "turn", turn: 1, text: "Reading the login flow" },
  { ts: "2026-11-04T03:01:00.000Z", phase: "executing", kind: "turn", turn: 1, text: "Writing the failing test" },
  { ts: "2026-11-04T03:03:00.000Z", phase: "executing", kind: "turn", turn: 2, text: "One reproduction failed; finding the cause" },
];

function stubApi(items: WorkItemResolved[], transcript: RunTranscriptEvent[] = TRANSCRIPT) {
  const progress: Array<(p: RunProgressEventPayload) => void> = [];
  const list = vi.fn(async () => ({ status: "ok" as const, items }));
  const noop = () => () => {};
  const api = {
    listWorkBoard: list,
    listWorkProposals: async () => ({ status: "ok" as const, proposals: [] }),
    getWorkBoardRunTranscript: vi.fn(async () => ({ events: transcript })),
    runWorkBoardItem: vi.fn(() => new Promise(() => {})),
    onWorkBoardItemChanged: noop,
    onWorkProposalChanged: noop,
    onWorkBoardRunProgress: (h: (p: RunProgressEventPayload) => void) => {
      progress.push(h);
      return () => {};
    },
    onWorkBoardRunStarted: noop,
    onWorkBoardRunFinished: noop,
    onWorkBoardRunFailed: noop,
  } as unknown as AveApi;
  const emit = (ev: Omit<RunProgressEventPayload, "at"> & { at?: string }) =>
    act(() => {
      for (const h of progress) h({ at: "2026-11-04T03:04:00.000Z", ...ev });
    });
  return { api, emit, list };
}

function hhmm(iso: string): string {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

describe("Work Board — compact running card", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.setSystemTime(STARTED_MS + 252_000);
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it("shows phase, the current phase's turn and the elapsed time in one chip", async () => {
    const { api } = stubApi([item()]);
    render(<WorkBoardPanel api={api} />);

    const chip = await screen.findByTestId("work-board-live-chip");
    await vi.waitFor(() =>
      expect(chip.textContent).toBe(
        `${t("workBoard.liveChipExecuting")} · ${t("workBoard.liveChipTurn", { turn: 2 })} · 4:12`,
      ),
    );
    expect(chip.getAttribute("data-phase")).toBe("executing");
  });

  it("ticks the elapsed time once a second while the run is live", async () => {
    const { api } = stubApi([item()]);
    render(<WorkBoardPanel api={api} />);
    const chip = await screen.findByTestId("work-board-live-chip");
    await vi.waitFor(() => expect(chip.textContent).toMatch(/4:12$/));

    await act(async () => {
      vi.advanceTimersByTime(1_000);
    });
    expect(chip.textContent).toMatch(/4:13$/);
  });

  it("narrates the latest turn on one line with its local time", async () => {
    const { api } = stubApi([item()]);
    render(<WorkBoardPanel api={api} />);

    const line = await screen.findByTestId("work-board-live-narration");
    await vi.waitFor(() =>
      expect(line.textContent).toBe(`${hhmm(TRANSCRIPT[2]!.ts)} · One reproduction failed; finding the cause`),
    );
    expect(line.className).toContain("truncate");
    expect(line.getAttribute("title")).toBe("One reproduction failed; finding the cause");
  });

  it("keeps the description in the layout, hidden, so the running card stays as tall as the idle one", async () => {
    const { api } = stubApi([item()]);
    render(<WorkBoardPanel api={api} />);
    const line = await screen.findByTestId("work-board-live-narration");

    const spacer = line.parentElement?.querySelector('p[aria-hidden="true"]');
    expect(spacer?.textContent).toBe("Reproduce the redirect loop");
    expect(spacer?.className).toContain("invisible");
    expect(spacer?.className).toContain("line-clamp-2");
    // The visible card no longer shows the description or the due line while the run is live.
    expect(screen.queryByText(t("workBoard.noDueDate"))).toBeNull();
  });

  it("follows live turns after the backfill", async () => {
    const { api, emit } = stubApi([item()]);
    render(<WorkBoardPanel api={api} />);
    const chip = await screen.findByTestId("work-board-live-chip");
    await vi.waitFor(() => expect(chip.textContent).toContain(t("workBoard.liveChipTurn", { turn: 2 })));

    emit({ itemId: 4, phase: "executing", turn: 3, text: "Fixed the redirect; rerunning" });

    expect(chip.textContent).toContain(t("workBoard.liveChipTurn", { turn: 3 }));
    expect(screen.getByTestId("work-board-live-narration").textContent).toContain("Fixed the redirect; rerunning");
  });

  it("says the plan is waiting for approval without a turn count", async () => {
    const { api } = stubApi([item({ runStatus: "awaiting_approval" })], TRANSCRIPT.slice(0, 1));
    render(<WorkBoardPanel api={api} />);

    const chip = await screen.findByTestId("work-board-live-chip");
    await vi.waitFor(() => expect(chip.getAttribute("data-phase")).toBe("awaiting_approval"));
    expect(chip.textContent).toBe(`${t("workBoard.liveChipAwaitingApproval")} · 4:12`);
  });

  it("leaves the elapsed time out while the board still holds a previous run's history", async () => {
    // The live stream says a run is executing, but the listed item is still the finished previous run.
    const { api, emit } = stubApi([item({ runStatus: "completed" })]);
    render(<WorkBoardPanel api={api} />);
    await screen.findByTestId("work-board-card");

    emit({ itemId: 4, phase: "executing", turn: 1, text: "working" });

    const chip = screen.getByTestId("work-board-live-chip");
    expect(chip.textContent).toBe(`${t("workBoard.liveChipExecuting")} · ${t("workBoard.liveChipTurn", { turn: 1 })}`);
  });

  it("re-lists the board when a run enters a new phase so the run start is the current one", async () => {
    const { api, emit, list } = stubApi([item()]);
    render(<WorkBoardPanel api={api} />);
    await screen.findByTestId("work-board-card");
    const before = list.mock.calls.length;

    emit({ itemId: 4, phase: "executing", turn: 3, text: "a turn" });
    expect(list.mock.calls.length).toBe(before);

    emit({ itemId: 4, phase: "planning" });
    await vi.waitFor(() => expect(list.mock.calls.length).toBe(before + 1));
  });

  it("puts the narration in the chip's row on a card without a description, so it gains no line at run start", async () => {
    const { api } = stubApi([item({ detail: undefined })]);
    render(<WorkBoardPanel api={api} />);
    const line = await screen.findByTestId("work-board-live-narration");
    await vi.waitFor(() => expect(line.textContent).toContain("One reproduction failed; finding the cause"));

    // The idle card is title + due line; the running card is title + this one row.
    const row = screen.getByTestId("work-board-live-row");
    expect(line.parentElement).toBe(row);
    expect(within(row).getByTestId("work-board-live-chip")).toBeTruthy();
    expect(line.className).toContain("truncate");
    expect(row.parentElement?.querySelector('p[aria-hidden="true"]')).toBeNull();
  });

  it("subscribes to the progress stream once, so a host that keeps one listener still drives both the card and the re-list", async () => {
    // A preload-shaped stub that keeps only the latest listener: a second subscription would silently replace the first.
    let only: ((p: RunProgressEventPayload) => void) | undefined;
    const subscribe = vi.fn((h: (p: RunProgressEventPayload) => void) => {
      only = h;
      return () => {};
    });
    const { api, list } = stubApi([item()]);
    (api as unknown as { onWorkBoardRunProgress: typeof subscribe }).onWorkBoardRunProgress = subscribe;
    render(<WorkBoardPanel api={api} />);
    const chip = await screen.findByTestId("work-board-live-chip");
    const before = list.mock.calls.length;

    act(() => only!({ itemId: 4, phase: "executing", turn: 5, text: "turn five", at: "2026-11-04T03:04:00.000Z" }));
    expect(chip.textContent).toContain(t("workBoard.liveChipTurn", { turn: 5 }));

    act(() => only!({ itemId: 4, phase: "planning", at: "2026-11-04T03:04:01.000Z" }));
    await vi.waitFor(() => expect(list.mock.calls.length).toBe(before + 1));
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  it("draws no chip or narration on an item that is not running", async () => {
    const { api } = stubApi([item({ runStatus: "completed" })]);
    render(<WorkBoardPanel api={api} />);
    await screen.findByTestId("work-board-card");

    expect(screen.queryByTestId("work-board-live-chip")).toBeNull();
    expect(screen.queryByTestId("work-board-live-narration")).toBeNull();
    expect(screen.getByTestId("work-board-run")).toBeTruthy();
  });
});
