// Keep the in-flight approval visible until response acknowledgement and suppress duplicate decisions.
import "./setup.js";
import { useLayoutEffect } from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import { act, render, renderHook, waitFor } from "@testing-library/react";
import { useApproval } from "../../src/ui/renderer/hooks/use-approval.js";

type ApprovalHandler = (r: unknown) => void;

function installMockNs() {
  const handlers = new Set<ApprovalHandler>();
  const resolvers: Array<(v: unknown) => void> = [];
  const respond = vi.fn(
    () =>
      new Promise((res) => {
        resolvers.push(res);
      }),
  );
  const onRequest = vi.fn((cb: ApprovalHandler) => {
    handlers.add(cb);
    return () => handlers.delete(cb);
  });
  const listPending = vi.fn(async () => [] as unknown[]);
  const settledHandlers = new Set<(payload: unknown) => void>();
  const onSettled = vi.fn((cb: (payload: unknown) => void) => {
    settledHandlers.add(cb);
    return () => settledHandlers.delete(cb);
  });
  const ns = {
    approval: { onRequest, onSettled, respond, listPending },
    permission: {},
    policy: {},
  };
  vi.stubGlobal("ave", ns);
  (window as unknown as { ave: unknown }).ave = ns;
  return {
    emit: (r: unknown) => handlers.forEach((h) => h(r)),
    emitSettled: (requestId: string) =>
      settledHandlers.forEach((h) => h({ requestId })),
    respond,
    listPending,
    drainOne: () => resolvers.shift()?.({ ok: true }),
    drainAll: () => {
      for (const resolve of resolvers.splice(0)) {
        resolve({ ok: true });
      }
    },
  };
}

describe("useApproval — Copilot HIGH #2 re-entrancy", () => {
  it("responds to a request that becomes interactive before passive effects", async () => {
    const { emit, respond, drainAll } = installMockNs();

    function ImmediateDecisionHarness() {
      const { queue, decide } = useApproval();
      // Exercise input after commit but before passive effects by using a layout effect.
      useLayoutEffect(() => {
        if (queue[0]?.id === "req-layout") {
          void decide("req-layout", "allow-once");
        }
      }, [queue, decide]);
      return null;
    }

    render(<ImmediateDecisionHarness />);

    act(() => {
      emit({
        id: "req-layout",
        category: "tool",
        toolName: "read_file",
        args: {},
        reason: "r",
        createdAt: 0,
        requireExplicit: false,
        nonce: "nonce-layout",
        hmac: "hmac-layout",
      });
    });

    await waitFor(() => {
      expect(respond).toHaveBeenCalledTimes(1);
    });
    expect(respond).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: "req-layout",
        choice: "allow-once",
        nonce: "nonce-layout",
        hmac: "hmac-layout",
      }),
    );

    await act(async () => {
      drainAll();
    });
  });

  it("rapid double decide() only dispatches one respond() for the current item", async () => {
    const { emit, respond, drainOne } = installMockNs();
    const { result } = renderHook(() => useApproval());

    act(() => {
      emit({
        id: "req-1",
        category: "tool",
        toolName: "t",
        args: {},
        reason: "r",
        createdAt: 0,
        requireExplicit: false,
      });
      emit({
        id: "req-2",
        category: "tool",
        toolName: "t",
        args: {},
        reason: "r",
        createdAt: 0,
        requireExplicit: false,
      });
    });

    expect(result.current.queue.length).toBe(2);

    // Invoke twice before resolving the response and assert before awaiting either call.
    let first!: Promise<void>;
    let second!: Promise<void>;
    act(() => {
      first = result.current.decide(result.current.queue[0]!.id, "allow-once");
      second = result.current.decide(result.current.queue[0]!.id, "allow-once");
    });

    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond.mock.calls[0]?.[0]).toMatchObject({ requestId: "req-1" });
    expect(result.current.queue.map((request) => request.id)).toEqual(["req-1", "req-2"]);

    await act(async () => {
      drainOne();
      await first;
      await second;
    });

    expect(result.current.queue.map((request) => request.id)).toEqual(["req-2"]);

    let third!: Promise<void>;
    act(() => {
      third = result.current.decide(result.current.queue[0]!.id, "allow-once");
    });
    expect(respond).toHaveBeenCalledTimes(2);
    expect(respond.mock.calls[1]?.[0]).toMatchObject({ requestId: "req-2" });
    await act(async () => {
      drainOne();
      await third;
    });
  });

  it("sequential decide echoes nonce and hmac for each queued request", async () => {
    const { emit, respond, drainOne } = installMockNs();
    const { result } = renderHook(() => useApproval());

    act(() => {
      emit({
        id: "req-1",
        category: "tool",
        toolName: "read_file",
        args: {},
        reason: "r",
        createdAt: 0,
        requireExplicit: false,
        nonce: "nonce-1",
        hmac: "hmac-1",
      });
      emit({
        id: "req-2",
        category: "tool",
        toolName: "write_file",
        args: {},
        reason: "r",
        createdAt: 0,
        requireExplicit: false,
        nonce: "nonce-2",
        hmac: "hmac-2",
      });
    });

    let first!: Promise<void>;
    act(() => {
      first = result.current.decide(result.current.queue[0]!.id, "allow-once");
    });

    expect(respond).toHaveBeenCalledTimes(1);
    expect(respond.mock.calls[0]?.[0]).toMatchObject({
      requestId: "req-1",
      choice: "allow-once",
      nonce: "nonce-1",
      hmac: "hmac-1",
    });

    await act(async () => {
      drainOne();
      await first;
    });

    let second!: Promise<void>;
    act(() => {
      second = result.current.decide(result.current.queue[0]!.id, "allow-once");
    });

    expect(respond).toHaveBeenCalledTimes(2);
    expect(respond.mock.calls[1]?.[0]).toMatchObject({
      requestId: "req-2",
      choice: "allow-once",
      nonce: "nonce-2",
      hmac: "hmac-2",
    });

    await act(async () => {
      drainOne();
      await second;
    });
  });
});

describe("useApproval — requests parked before this renderer mounted", () => {
  it("seeds the queue from listPending, oldest first, without duplicating a request that also arrived live", async () => {
    const { emit, listPending } = installMockNs();
    listPending.mockResolvedValueOnce([
      { id: "parked-1", category: "tool", toolName: "read_file", args: {}, reason: "r", createdAt: 1, requireExplicit: false },
      { id: "live-1", category: "tool", toolName: "list_files", args: {}, reason: "r", createdAt: 2, requireExplicit: false },
    ]);
    const { result } = renderHook(() => useApproval());
    // Deduplicate requests delivered by both subscription and initial snapshot.
    act(() => {
      emit({ id: "live-1", category: "tool", toolName: "list_files", args: {}, reason: "r", createdAt: 2, requireExplicit: false });
    });
    await waitFor(() => expect(result.current.queue.map((req) => req.id)).toEqual(["parked-1", "live-1"]));
    expect(listPending).toHaveBeenCalledTimes(1);
  });

  it("dropSettled forgets settled requests but keeps the head whose answer is still in flight", async () => {
    const { emit, respond, drainAll } = installMockNs();
    const { result } = renderHook(() => useApproval());
    act(() => {
      emit({ id: "req-1", category: "tool", toolName: "read_file", args: {}, reason: "r", createdAt: 1, requireExplicit: false, nonce: "n1", hmac: "h1" });
      emit({ id: "req-2", category: "tool", toolName: "list_files", args: {}, reason: "r", createdAt: 2, requireExplicit: false, nonce: "n2", hmac: "h2" });
      emit({ id: "req-3", category: "tool", toolName: "bash_run", args: {}, reason: "r", createdAt: 3, requireExplicit: false, nonce: "n3", hmac: "h3" });
    });
    await waitFor(() => expect(result.current.queue).toHaveLength(3));

    let deciding!: Promise<void>;
    act(() => {
      deciding = result.current.decide(result.current.queue[0]!.id, "allow-once");
    });
    expect(respond).toHaveBeenCalledTimes(1);

    // Do not retire an in-flight head until acknowledgement; only unrelated queued requests may leave.
    act(() => {
      result.current.dropSettled(["req-1", "req-3"]);
    });
    expect(result.current.queue.map((req) => req.id)).toEqual(["req-1", "req-2"]);

    await act(async () => {
      drainAll();
      await deciding;
    });
    expect(result.current.queue.map((req) => req.id)).toEqual(["req-2"]);
  });
});

// Host retirement must remove requests even when the original requesting surface is gone.
describe("useApproval — the host retires a request nobody here answered", () => {
  const parked = (id: string) => ({
    id,
    category: "tool" as const,
    toolName: "read_file",
    args: {},
    reason: "r",
    createdAt: 1,
    requireExplicit: false,
    nonce: `nonce-${id}`,
    hmac: `hmac-${id}`,
  });

  it("takes the card down on the settlement announcement", async () => {
    const { emit, emitSettled } = installMockNs();
    const { result } = renderHook(() => useApproval());
    act(() => {
      emit(parked("req-closed"));
      emit(parked("req-open"));
    });
    await waitFor(() => expect(result.current.queue).toHaveLength(2));

    act(() => {
      emitSettled("req-closed");
    });

    expect(result.current.queue.map((req) => req.id)).toEqual(["req-open"]);
  });

  it("leaves a request whose own answer is still in flight to that answer", async () => {
    const { emit, emitSettled, respond, drainAll } = installMockNs();
    const { result } = renderHook(() => useApproval());
    act(() => {
      emit(parked("req-answering"));
    });
    await waitFor(() => expect(result.current.queue).toHaveLength(1));

    let deciding!: Promise<void>;
    act(() => {
      deciding = result.current.decide("req-answering", "allow-once");
    });
    expect(respond).toHaveBeenCalledTimes(1);

    // Keep the card until respond acknowledges even if host settlement arrives first.
    act(() => {
      emitSettled("req-answering");
    });
    expect(result.current.queue.map((req) => req.id)).toEqual(["req-answering"]);

    await act(async () => {
      drainAll();
      await deciding;
    });
    expect(result.current.queue).toHaveLength(0);
  });

  it("does not let the parked snapshot resurrect a request settled while it was in flight", async () => {
    const { emitSettled, listPending } = installMockNs();
    let releaseSnapshot!: (requests: unknown[]) => void;
    listPending.mockImplementationOnce(
      () => new Promise<unknown[]>((res) => {
        releaseSnapshot = res;
      }),
    );

    const { result } = renderHook(() => useApproval());
    // Ignore snapshot entries retired after the snapshot was taken.
    act(() => {
      emitSettled("req-gone");
    });
    await act(async () => {
      releaseSnapshot([parked("req-gone"), parked("req-live")]);
    });

    await waitFor(() => expect(result.current.queue.map((req) => req.id)).toEqual(["req-live"]));
  });

  it("reads the parked snapshot once, so retired ids stop being worth remembering after it", async () => {
    const { emit, emitSettled, listPending } = installMockNs();
    const { result } = renderHook(() => useApproval());
    await waitFor(() => expect(listPending).toHaveBeenCalledTimes(1));

    // Release the retirement guard after its only snapshot reader runs to bound retained ids.
    for (let n = 0; n < 3; n += 1) {
      act(() => {
        emit(parked(`req-${n}`));
        emitSettled(`req-${n}`);
      });
      expect(result.current.queue).toHaveLength(0);
    }
    expect(listPending).toHaveBeenCalledTimes(1);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});
