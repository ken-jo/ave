// @vitest-environment jsdom
import "../../../../../test/renderer/setup.ts";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { RemoteA2AActionButton } from "../RemoteA2AActionButton.js";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { t } from "../../../../i18n/runtime.js";

function installApi(status: Record<string, unknown> = { state: "idle", updatedAt: "2026-07-16T00:00:00.000Z" }) {
  const send = vi.fn(async () => ({ ok: true, status: { state: "sent", taskHandle: "task_handle_123456", taskAvailable: true, taskState: "TASK_STATE_WORKING", targetAgentId: 1, targetLabel: "Agent one", outcome: "success", updatedAt: "2026-07-16T00:00:01.000Z" } }));
  const task = vi.fn(async () => ({ ok: true, status }));
  const action = vi.fn(async () => ({ ok: true, status }));
  Object.defineProperty(window, "aveApi", {
    configurable: true,
    value: {
      remoteA2a: {
        targets: vi.fn(async () => ({ ok: true, targets: [{ targetAgentId: 1, label: "Agent one" }] })),
        status: vi.fn(async () => ({ ok: true, status })),
        send,
        task,
        action,
      },
    },
  });
  return { send, task, action };
}

beforeEach(() => {
  document.body.innerHTML = "";
});

async function openPanel() {
  await act(async () => { render(<TooltipProvider><RemoteA2AActionButton /></TooltipProvider>); });
  fireEvent.click(await screen.findByTestId("remote-a2a-trigger"));
  return await screen.findByTestId("remote-a2a-panel");
}

describe("RemoteA2AActionButton production IPC surface", () => {
  it("sends only the selected target and user intent through the stable UI controls", async () => {
    const api = installApi();
    await openPanel();
    fireEvent.change(screen.getByTestId("remote-a2a-intent"), { target: { value: "Do the bounded task" } });
    fireEvent.click(screen.getByTestId("remote-a2a-send"));
    await waitFor(() => expect(screen.getByTestId("remote-a2a-status").getAttribute("data-state")).toBe("sent"));
    expect(api.send).toHaveBeenCalledWith(1, "Do the bounded task");
  });

  it("exposes Replay only for an operation-recovery handle without fabricating Task actions", async () => {
    const api = installApi({ state: "failed", taskHandle: "recovery_handle_123", taskAvailable: false, recoveryEligible: true, outcome: "unknown-manual-reconciliation-required", updatedAt: "2026-07-16T00:00:00.000Z" });
    await openPanel();
    expect(screen.getByTestId("remote-a2a-replay")).toBeTruthy();
    expect(screen.queryByTestId("remote-a2a-get")).toBeNull();
    expect(screen.queryByTestId("remote-a2a-resume")).toBeNull();
    expect(screen.queryByTestId("remote-a2a-cancel")).toBeNull();
    expect(screen.getByTestId("remote-a2a-status").textContent).not.toContain("unknown-manual-reconciliation-required");
    fireEvent.click(screen.getByTestId("remote-a2a-replay"));
    await waitFor(() => expect(api.action).toHaveBeenCalledWith("replay", "recovery_handle_123"));
  });

  it("shows AUTH_REQUIRED as out-of-band and disables credential-bearing Resume", async () => {
    installApi({ state: "sent", taskHandle: "task_handle_123456", taskAvailable: true, recoveryEligible: false, taskState: "TASK_STATE_AUTH_REQUIRED", updatedAt: "2026-07-16T00:00:00.000Z" });
    await openPanel();
    expect(screen.getByTestId("remote-a2a-status").textContent).toBe(t("remoteA2aActionButton.authRequired"));
    expect(screen.getByTestId("remote-a2a-resume")).toHaveProperty("disabled", true);
    expect(screen.queryByTestId("remote-a2a-replay")).toBeNull();
  });

  it("shows already-settled cancellation feedback instead of a sent message", async () => {
    installApi({
      state: "sent",
      taskHandle: "task_handle_123456",
      taskAvailable: true,
      recoveryEligible: false,
      taskState: "TASK_STATE_CANCELED",
      targetLabel: "Agent one",
      outcome: "cancel-already-settled",
      updatedAt: "2026-07-16T00:00:00.000Z",
    });

    await openPanel();

    expect(screen.getByTestId("remote-a2a-status").textContent).toBe(t("remoteA2aActionButton.alreadySettled"));
    expect(screen.getByTestId("remote-a2a-status").textContent).not.toContain("Agent one");
  });

  it("keeps approved targets visible when only the initial status request rejects", async () => {
    installApi();
    window.aveApi.remoteA2a.status = vi.fn(async () => {
      throw new Error("transient status failure");
    });

    await openPanel();

    expect(screen.getByTestId("remote-a2a-target")).toHaveProperty("value", "1");
    expect(screen.getByTestId("remote-a2a-status").textContent).toBe(t("remoteA2aActionButton.ready"));
  });

  it("retains typed intent when a resolved send reports a failed delivery state", async () => {
    installApi();
    window.aveApi.remoteA2a.send = vi.fn(async () => ({
      ok: true as const,
      status: { state: "failed" as const, outcome: "remote-task-failed", updatedAt: "2026-07-16T00:00:01.000Z" },
    }));
    await openPanel();
    const input = screen.getByTestId("remote-a2a-intent");
    fireEvent.change(input, { target: { value: "Keep this text" } });
    fireEvent.click(screen.getByTestId("remote-a2a-send"));

    await waitFor(() => expect(screen.getByTestId("remote-a2a-status").getAttribute("data-state")).toBe("failed"));
    expect(input).toHaveProperty("value", "Keep this text");
  });

  it("retains typed intent when a resolved Resume reports a failed delivery state", async () => {
    installApi({ state: "sent", taskHandle: "task_handle_123456", taskAvailable: true, recoveryEligible: false, taskState: "TASK_STATE_INPUT_REQUIRED", updatedAt: "2026-07-16T00:00:00.000Z" });
    const action = vi.fn(async () => ({
      ok: true as const,
      status: { state: "failed" as const, taskHandle: "task_handle_123456", outcome: "resume-failed", updatedAt: "2026-07-16T00:00:01.000Z" },
    }));
    window.aveApi.remoteA2a.action = action;
    await openPanel();
    const input = screen.getByTestId("remote-a2a-intent");
    fireEvent.change(input, { target: { value: "Keep resume text" } });
    fireEvent.click(screen.getByTestId("remote-a2a-resume"));

    await waitFor(() => expect(screen.getByTestId("remote-a2a-status").getAttribute("data-state")).toBe("failed"));
    expect(action).toHaveBeenCalledWith("resume", "task_handle_123456", "Keep resume text");
    expect(input).toHaveProperty("value", "Keep resume text");
  });

  it("keeps Task actions after a Refresh and after an IPC-level refusal", async () => {
    const actionable = { state: "sent", taskHandle: "task_handle_123456", taskAvailable: true, taskState: "TASK_STATE_WORKING", targetLabel: "Agent one", outcome: "success", updatedAt: "2026-07-16T00:00:00.000Z" };
    const api = installApi(actionable);
    await openPanel();
    fireEvent.click(screen.getByTestId("remote-a2a-get"));
    await waitFor(() => expect(api.task).toHaveBeenCalledWith("task_handle_123456"));
    expect(await screen.findByTestId("remote-a2a-get")).toBeTruthy();

    api.task.mockResolvedValueOnce({ ok: false, error: "a2a-remote-operation-rejected" } as never);
    fireEvent.click(screen.getByTestId("remote-a2a-get"));
    await waitFor(() => expect(screen.getByTestId("remote-a2a-status").getAttribute("data-state")).toBe("failed"));
    expect(screen.getByTestId("remote-a2a-get")).toBeTruthy();
    expect(screen.getByTestId("remote-a2a-cancel")).toHaveProperty("disabled", false);

    api.action.mockRejectedValueOnce(new Error("ipc channel closed"));
    fireEvent.click(screen.getByTestId("remote-a2a-cancel"));
    await waitFor(() => expect(api.action).toHaveBeenCalledWith("cancel", "task_handle_123456"));
    await waitFor(() => expect(screen.getByTestId("remote-a2a-get")).toHaveProperty("disabled", false));
    expect(screen.getByTestId("remote-a2a-cancel")).toBeTruthy();
  });

  it("does not surface rejected IPC exception details", async () => {
    installApi();
    window.aveApi.remoteA2a.send = vi.fn(async () => {
      throw new Error("private-provider-detail");
    });
    await openPanel();
    fireEvent.change(screen.getByTestId("remote-a2a-intent"), { target: { value: "Bounded request" } });
    fireEvent.click(screen.getByTestId("remote-a2a-send"));

    await waitFor(() => expect(screen.getByTestId("remote-a2a-status").getAttribute("data-state")).toBe("failed"));
    expect(screen.getByTestId("remote-a2a-status").textContent).not.toContain("private-provider-detail");
    expect(screen.getByTestId("remote-a2a-status").textContent).not.toContain("a2a-remote-send-failed");
  });

  it("tells the owner a may-have-been-sent action is unknown, not merely unsent", async () => {
    installApi({ state: "failed", taskHandle: "task_handle_123456", taskAvailable: true, taskState: "TASK_STATE_INPUT_REQUIRED", outcome: "continue-reconciliation-required:transport-ambiguous", updatedAt: "2026-07-16T00:00:00.000Z" });
    await openPanel();
    const text = screen.getByTestId("remote-a2a-status").textContent ?? "";
    expect(text).toBe(t("remoteA2aActionButton.deliveryUnknown"));
    expect(text).not.toContain(t("remoteA2aActionButton.notSent", { reason: "" }).trim());
  });

  it("tells the owner a never-sent action can be tried again, and keeps its Task actions", async () => {
    installApi({ state: "failed", taskHandle: "task_handle_123456", taskAvailable: true, taskState: "TASK_STATE_INPUT_REQUIRED", outcome: "not-sent", updatedAt: "2026-07-16T00:00:00.000Z" });
    await openPanel();
    expect(screen.getByTestId("remote-a2a-status").textContent).toContain(t("remoteA2aActionButton.neverSentRetry"));
    expect(screen.getByTestId("remote-a2a-resume")).toBeTruthy();
  });

  it("shows the remote agent's reply on the task card", async () => {
    installApi({ state: "sent", taskHandle: "task_handle_123456", taskAvailable: true, taskState: "TASK_STATE_COMPLETED", reply: { text: "Three findings, see summary.", truncated: true, artifactCount: 1, redactions: 0 }, updatedAt: "2026-07-16T00:00:00.000Z" });
    await openPanel();
    expect(screen.getByTestId("remote-a2a-reply-text").textContent).toBe("Three findings, see summary.");
    expect(screen.getByTestId("remote-a2a-reply-truncated")).toBeTruthy();
  });

  it("polls a working Task while open, backing off, and stops once it settles", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const working = { state: "sent", taskHandle: "task_handle_123456", taskAvailable: true, taskState: "TASK_STATE_WORKING", updatedAt: "2026-07-16T00:00:00.000Z" };
      const api = installApi(working);
      api.task.mockResolvedValueOnce({ ok: true, status: { ...working, updatedAt: "2026-07-16T00:00:02.000Z" } })
        .mockResolvedValueOnce({ ok: true, status: { ...working, taskState: "TASK_STATE_COMPLETED", reply: { text: "All done.", truncated: false, artifactCount: 0, redactions: 0 }, updatedAt: "2026-07-16T00:00:06.000Z" } } as never);
      await openPanel();

      await act(async () => { await vi.advanceTimersByTimeAsync(1_500); });
      expect(api.task).not.toHaveBeenCalled();
      await act(async () => { await vi.advanceTimersByTimeAsync(600); });
      expect(api.task).toHaveBeenCalledTimes(1);
      // Unchanged state: the next wait doubles.
      await act(async () => { await vi.advanceTimersByTimeAsync(3_300); });
      expect(api.task).toHaveBeenCalledTimes(1);
      await act(async () => { await vi.advanceTimersByTimeAsync(800); });
      expect(api.task).toHaveBeenCalledTimes(2);
      await waitFor(() => expect(screen.getByTestId("remote-a2a-reply-text").textContent).toBe("All done."));
      // Terminal: no more polls.
      await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
      expect(api.task).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not poll a Task that waits on the owner", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const api = installApi({ state: "sent", taskHandle: "task_handle_123456", taskAvailable: true, taskState: "TASK_STATE_INPUT_REQUIRED", updatedAt: "2026-07-16T00:00:00.000Z" });
      await openPanel();
      await act(async () => { await vi.advanceTimersByTimeAsync(120_000); });
      expect(api.task).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops polling once a poll reports a failure", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const working = { state: "sent", taskHandle: "task_handle_123456", taskAvailable: true, taskState: "TASK_STATE_WORKING", updatedAt: "2026-07-16T00:00:00.000Z" };
      const api = installApi(working);
      api.task.mockResolvedValueOnce({ ok: true, status: { ...working, state: "failed", outcome: "authentication-failed", updatedAt: "2026-07-16T00:00:02.000Z" } } as never);
      await openPanel();
      await act(async () => { await vi.advanceTimersByTimeAsync(2_100); });
      expect(api.task).toHaveBeenCalledTimes(1);
      await waitFor(() => expect(screen.getByTestId("remote-a2a-status").getAttribute("data-state")).toBe("failed"));
      await act(async () => { await vi.advanceTimersByTimeAsync(300_000); });
      expect(api.task).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("drops a poll answer for a Task the owner has switched away from", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const first = { state: "sent", taskHandle: "task_handle_111111", taskAvailable: true, taskState: "TASK_STATE_WORKING", targetLabel: "Agent one", updatedAt: "2026-07-16T00:00:01.000Z" };
      const second = { state: "sent", taskHandle: "task_handle_222222", taskAvailable: true, taskState: "TASK_STATE_COMPLETED", targetLabel: "Agent one", reply: { text: "second reply", truncated: false, artifactCount: 0, redactions: 0 }, updatedAt: "2026-07-16T00:00:02.000Z" };
      const api = installApi(first);
      (window.aveApi.remoteA2a as unknown as Record<string, unknown>).tasks = vi.fn(async () => ({ ok: true, tasks: [second, first] }));
      let answer!: (value: unknown) => void;
      api.task.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }) as never);
      await openPanel();
      await act(async () => { await vi.advanceTimersByTimeAsync(2_100); });
      expect(api.task).toHaveBeenCalledTimes(1);

      fireEvent.change(await screen.findByTestId("remote-a2a-recent"), { target: { value: "task_handle_222222" } });
      await waitFor(() => expect(screen.getByTestId("remote-a2a-reply-text").textContent).toBe("second reply"));
      await act(async () => { answer({ ok: true, status: { ...first, taskState: "TASK_STATE_COMPLETED", reply: { text: "first reply", truncated: false, artifactCount: 0, redactions: 0 } } }); });
      expect(screen.getByTestId("remote-a2a-reply-text").textContent).toBe("second reply");
    } finally {
      vi.useRealTimers();
    }
  });

  it("runs the owner's action after an in-flight poll instead of failing as busy", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const working = { state: "sent", taskHandle: "task_handle_123456", taskAvailable: true, taskState: "TASK_STATE_WORKING", updatedAt: "2026-07-16T00:00:00.000Z" };
      const api = installApi(working);
      let answer!: (value: unknown) => void;
      api.task.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve; }) as never);
      await openPanel();
      await act(async () => { await vi.advanceTimersByTimeAsync(2_100); });
      expect(api.task).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByTestId("remote-a2a-cancel"));
      await act(async () => { await vi.advanceTimersByTimeAsync(10); });
      expect(api.action).not.toHaveBeenCalled();
      await act(async () => { answer({ ok: true, status: { ...working, updatedAt: "2026-07-16T00:00:03.000Z" } }); });
      await waitFor(() => expect(api.action).toHaveBeenCalledWith("cancel", "task_handle_123456"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets the owner switch between recent Tasks", async () => {
    const first = { state: "sent", taskHandle: "task_handle_111111", taskAvailable: true, taskState: "TASK_STATE_COMPLETED", targetLabel: "Agent one", reply: { text: "first reply", truncated: false, artifactCount: 0, redactions: 0 }, updatedAt: "2026-07-16T00:00:01.000Z" };
    const second = { ...first, taskHandle: "task_handle_222222", reply: { text: "second reply", truncated: false, artifactCount: 0, redactions: 0 }, updatedAt: "2026-07-16T00:00:02.000Z" };
    installApi(second);
    (window.aveApi.remoteA2a as unknown as Record<string, unknown>).tasks = vi.fn(async () => ({ ok: true, tasks: [second, first] }));
    await openPanel();
    const picker = await screen.findByTestId("remote-a2a-recent");
    fireEvent.change(picker, { target: { value: "task_handle_111111" } });
    await waitFor(() => expect(screen.getByTestId("remote-a2a-reply-text").textContent).toBe("first reply"));
  });
});
