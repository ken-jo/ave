import "../../../../test/renderer/setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { useMemorySearch } from "../hooks/use-memory-search.js";
import type { AveApi } from "../types.js";

function Harness({ api }: { api: AveApi }) {
  const { query, setQuery, noteResults, sessionResults, loading } = useMemorySearch(api);

  return (
    <div>
      <input aria-label="query" value={query} onChange={(e) => setQuery(e.target.value)} />
      <div data-testid="loading">{String(loading)}</div>
      <div data-testid="notes">{noteResults.map((note) => note.title).join(",")}</div>
      <div data-testid="sessions">{sessionResults.map((session) => session.sessionId).join(",")}</div>
    </div>
  );
}

describe("useMemorySearch", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("ignores an older search that resolves after the query is cleared", async () => {
    vi.useFakeTimers();
    let resolveSearch!: (notes: { title: string; excerpt: string }[]) => void;
    const api = {
      onMemorySaveResult: vi.fn(() => () => {}),
      memoryGetSummaries: vi.fn().mockResolvedValue({ ok: true, notes: [{ title: "Current catalog", content: "Current" }], entries: [] }),
      memoryGetIndex: vi.fn().mockResolvedValue(""),
      memoryListSessions: vi.fn().mockResolvedValue([]),
      memorySearchEntries: vi.fn(() => new Promise((resolve) => { resolveSearch = resolve; })),
      memorySearchSessions: vi.fn().mockResolvedValue([]),
    } as unknown as AveApi;
    render(<Harness api={api} />);
    await act(async () => { await Promise.resolve(); });
    fireEvent.change(screen.getByLabelText("query"), { target: { value: "old" } });
    await act(async () => { vi.advanceTimersByTime(200); });
    fireEvent.change(screen.getByLabelText("query"), { target: { value: "" } });
    await act(async () => { resolveSearch([{ title: "Stale search", excerpt: "Old" }]); });
    expect(screen.getByTestId("notes").textContent).toBe("Current catalog");
  });

  it("keeps the newest catalog when change-event reads complete out of order", async () => {
    let notify!: Parameters<AveApi["onMemorySaveResult"]>[0];
    let resolveInitial!: (value: unknown) => void;
    const api = {
      onMemorySaveResult: vi.fn((handler) => { notify = handler; return () => {}; }),
      memoryGetSummaries: vi.fn().mockImplementationOnce(() => new Promise((resolve) => { resolveInitial = resolve; }))
        .mockResolvedValue({ ok: true, notes: [{ title: "Newest catalog", content: "New" }], entries: [] }),
      memoryGetIndex: vi.fn().mockResolvedValue(""),
      memoryListSessions: vi.fn().mockResolvedValue([]),
    } as unknown as AveApi;
    render(<Harness api={api} />);
    await act(async () => {
      notify({ sessionId: "session", result: { status: "saved", op: "created", entry: { id: "new", filename: "new.md", title: "Event title", scope: "global" } } });
    });
    await act(async () => { resolveInitial({ ok: true, notes: [{ title: "Old catalog", content: "Old" }], entries: [] }); });
    expect(screen.getByTestId("notes").textContent).toBe("Newest catalog");
  });

  it("queries memorySearchEntries for note results after debounce", async () => {
    vi.useFakeTimers();
    const api = {
      onMemorySaveResult: vi.fn(() => () => {}),
      memoryGetSummaries: vi.fn().mockResolvedValue({ ok: true, notes: [], entries: [] }),
      memoryGetIndex: vi.fn().mockResolvedValue("# Ave Memory Index\n\n## Saved Memories\n- indexed 기억"),
      memoryListSessions: vi.fn().mockResolvedValue([]),
      memorySearchEntries: vi.fn().mockResolvedValue([
        { title: "사용자 기억", excerpt: "본문", updatedAt: "2026-04-20T00:00:00Z" },
      ]),
      memorySearchSessions: vi.fn().mockResolvedValue([
        { sessionId: "session-1", matchedMessage: "본문", timestamp: "2026-04-20T00:00:00Z" },
      ]),
      memorySearchNotes: vi.fn(),
    } as unknown as AveApi;

    render(<Harness api={api} />);

    // Initial catalog load runs immediately on mount; subsequent query-driven searches are debounced.
    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });

    await act(async () => {
      fireEvent.change(screen.getByLabelText("query"), { target: { value: "기억" } });
    });

    // Advance past the 200 ms search debounce
    await act(async () => {
      vi.advanceTimersByTime(300);
      await Promise.resolve();
    });

    expect(api.memorySearchEntries).toHaveBeenCalledWith("기억");
    expect(api.memorySearchNotes).not.toHaveBeenCalled();
    expect(screen.getByTestId("notes").textContent).toContain("메모리 인덱스");
    expect(screen.getByTestId("notes").textContent).toContain("사용자 기억");
    expect(screen.getByTestId("sessions").textContent).toContain("session-1");
  });

  it("does not call memorySearchEntries before debounce delay elapses", async () => {
    vi.useFakeTimers();
    const api = {
      onMemorySaveResult: vi.fn(() => () => {}),
      memoryGetSummaries: vi.fn().mockResolvedValue({ ok: true, notes: [], entries: [] }),
      memoryGetIndex: vi.fn().mockResolvedValue(""),
      memoryListSessions: vi.fn().mockResolvedValue([]),
      memorySearchEntries: vi.fn().mockResolvedValue([]),
      memorySearchSessions: vi.fn().mockResolvedValue([]),
      memorySearchNotes: vi.fn(),
    } as unknown as AveApi;

    render(<Harness api={api} />);

    await act(async () => {
      fireEvent.change(screen.getByLabelText("query"), { target: { value: "기억" } });
    });

    // Advance only 100 ms — before the 200 ms debounce
    await act(async () => {
      vi.advanceTimersByTime(100);
    });

    expect(api.memorySearchEntries).not.toHaveBeenCalled();
  });
});
