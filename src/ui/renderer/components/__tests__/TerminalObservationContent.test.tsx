// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "../../../../../test/renderer/setup.js";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { TranscriptRenderer } from "../TranscriptRenderer.js";
import type { ChatEntry } from "../../../../lib/chat-stream-state.js";
import { TerminalObservationCommands, useTerminalObservation } from "../TerminalObservationContent.js";
import { OBSERVATION_LIMITS, type AgentObservationEvent, type TerminalObservedCommand, type ObservationResponse } from "../../../../shared/agent-observation.js";
import { en } from "../../../../i18n/messages/en.js";
import type { EgressGrantScope } from "../../../../shared/egress-grant-scopes.js";
import type { EgressDecisionBasis } from "../../../../audit/sandbox-audit.js";
import { ko } from "../../../../i18n/messages/ko.js";

function TerminalObservationHarness({ sessionId, observe }: { sessionId?: string; observe: boolean }) {
  const observation = useTerminalObservation(sessionId, observe);
  return <TerminalObservationCommands observation={observation} />;
}

const SESSION = "terminal-agent-session";
const TARGET = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const OTHER_TARGET = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
let listeners: Set<(events: AgentObservationEvent[]) => void>;
let acknowledge: ReturnType<typeof vi.fn>;
let previousAve: unknown;

function command(overrides: Partial<TerminalObservedCommand> = {}): TerminalObservedCommand {
  return { id: "command-one", toolUseId: "tool-one", turnId: "turn-one", kind: "shell", command: "bun test", cwd: "/workspace/project",
    startedAt: Date.now() - 12_000, finishedAt: null, durationMs: 0, status: "running", exitCode: null,
    outputTail: "first passing assertion\n", outputTruncated: false, sandbox: { mode: "isolated", detail: "filesystem and process confinement" },
    outputAvailability: "streaming", decisions: [], ...overrides };
}
function snapshot(seq: number, commands: TerminalObservedCommand[] = [command()], overrides: Partial<AgentObservationEvent> = {}): AgentObservationEvent {
  return { source: "terminal", actor: "agent", sessionId: SESSION, target: { id: TARGET, path: "agent-terminal" }, seq,
    ts: Date.now(), kind: "snapshot", before: null, after: { commands }, ...overrides } as AgentObservationEvent;
}
async function emit(...events: AgentObservationEvent[]) {
  await act(async () => { listeners.forEach((listener) => listener(events)); });
}
async function open() {
  const result = render(<TerminalObservationHarness sessionId={SESSION} observe />);
  await waitFor(() => expect(acknowledge).toHaveBeenCalledWith({ action: "subscribe-terminal", sessionId: SESSION }));
  return result;
}

beforeEach(() => {
  listeners = new Set();
  acknowledge = vi.fn(async (request: { action: string; sessionId: string }): Promise<ObservationResponse> =>
    request.action === "subscribe-terminal"
      ? { ok: true, observation: { targetId: TARGET, sessionId: request.sessionId, seq: 0 } } : { ok: true });
  previousAve = window.ave;
  (window as unknown as { ave: unknown }).ave = { preview: {
    onAgentObservation: (listener: (events: AgentObservationEvent[]) => void) => { listeners.add(listener); return () => listeners.delete(listener); },
    acknowledgeObservation: acknowledge,
  } };
});
afterEach(() => { cleanup(); vi.useRealTimers(); vi.restoreAllMocks(); (window as unknown as { ave: unknown }).ave = previousAve; });

describe("agent terminal observation view", () => {
  it("has no activity strip or command list for a user-only session", async () => {
    await open();
    await emit(snapshot(1, []));
    expect(screen.queryByTestId("terminal-observation-content")).toBeNull();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("does not subscribe without a conversation", () => {
    render(<TerminalObservationHarness observe />);
    expect(acknowledge).not.toHaveBeenCalled();
    expect(listeners.size).toBe(0);
  });

  it("keeps an initial host snapshot that arrives before the subscription reply", async () => {
    let finish: (response: ObservationResponse) => void = () => { throw new Error("Subscription has not started"); };
    acknowledge.mockImplementation((request: { action: string }) => request.action === "subscribe-terminal"
      ? new Promise<ObservationResponse>((resolve) => { finish = resolve; }) : Promise.resolve({ ok: true }));
    render(<TerminalObservationHarness sessionId={SESSION} observe />);
    await emit(snapshot(1));
    expect(screen.queryByTestId("terminal-observation-live-strip")).toBeNull();
    await act(async () => { finish({ ok: true, observation: { targetId: TARGET, sessionId: SESSION, seq: 0 } }); });
    expect(screen.getByTestId("terminal-observation-status").textContent).toBe("에이전트 실행 중");
    expect(screen.getByTestId("terminal-observation-command").textContent).toBe("bun test");
    expect(screen.getByTestId("terminal-observation-duration").textContent).toBe("· 12s");
    expect(acknowledge).toHaveBeenCalledWith({ action: "rendered", targetId: TARGET, sessionId: SESSION, seq: 1 });
  });

  it("renders a bounded read-only command list with cwd, output and scoped decisions", async () => {
    await open();
    await emit(snapshot(1, [command({ outputTruncated: true, decisions: [{ kind: "egress", host: "service.example.test", port: 443,
      decision: "deny", basis: "sandbox", scope: null, reason: "destination refused", attribution: "terminal-session", ts: Date.now() }] })]));
    const row = screen.getByTestId("terminal-observation-command-row");
    fireEvent.click(within(row).getByText("bun test"));
    expect(within(row).getByTestId("terminal-observation-cwd").textContent).toBe("/workspace/project");
    expect(within(row).getByTestId("terminal-observation-output").textContent).toBe("first passing assertion\n");
    expect(row.textContent).toContain("샌드박스 격리");
    expect(row.textContent).toContain("종료 코드 알 수 없음");
    expect(row.textContent).toContain("한도 내 최근 출력만 표시합니다.");
    expect(screen.getByTestId("terminal-observation-decisions").textContent).toContain("service.example.test:443");
    expect(screen.getByTestId("terminal-observation-decisions").textContent).toContain("터미널 세션 · 하위 프로세스가 공유");
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("says why a command in a terminal the user typed into shows no output or network decisions", async () => {
    await open();
    await emit(snapshot(1, [command({ kind: "terminal", tabId: "tab", terminalSessionId: "terminal-session", outputTail: "",
      outputAvailability: "withheld-user-input" })]));
    const row = screen.getByTestId("terminal-observation-command-row");
    // Visible on the collapsed row, before the details are opened.
    expect(within(row).getByTestId("terminal-observation-withheld-marker").textContent).toBe(ko["terminalObservation.outputWithheldShort"]);
    fireEvent.click(within(row).getByText("bun test"));
    expect(within(row).getByTestId("terminal-observation-withheld").textContent).toBe(ko["terminalObservation.outputWithheldUserInput"]);
    expect(within(row).queryByTestId("terminal-observation-output")).toBeNull();
    expect(within(row).queryByTestId("terminal-observation-decisions")).toBeNull();
    expect(en["terminalObservation.outputWithheldUserInput"]).toContain("you typed in this terminal");
  });

  it.each<{ scope: EgressGrantScope; label: string }>([
    { scope: "once", label: "한 번" },
    { scope: "session", label: "이 대화" },
    { scope: "tab", label: "이 터미널 탭" },
    { scope: "project", label: "이 프로젝트" },
    { scope: "always", label: "항상" },
  ])("shows the actual $scope permission separately from command correlation", async ({ scope, label }) => {
    await open();
    await emit(snapshot(1, [command({ decisions: [{ kind: "egress", host: "allowed.example.test", port: 443,
      decision: "allow", basis: "grant", scope, reason: null, attribution: "command", ts: Date.now() }] })]));
    expect(screen.getByTestId("terminal-observation-decisions").textContent).toContain("이 명령");
    expect(screen.getByTestId("terminal-observation-decision-scope").textContent).toBe(`허용 범위: ${label}`);
    expect(screen.getByTestId("terminal-observation-decision-basis").textContent).toBe("결정 근거: 기존 허용");
  });

  it.each<{ basis: EgressDecisionBasis; label: string }>([
    { basis: "extension-allowlist", label: "선언된 네트워크 접근" },
    { basis: "grant", label: "기존 허용" },
    { basis: "rule", label: "네트워크 규칙" },
    { basis: "prompt", label: "승인 결정" },
    { basis: "policy", label: "호스트 정책" },
    { basis: "sandbox", label: "샌드박스 거부" },
  ])("localizes the $basis decision basis independently of terminal correlation", async ({ basis, label }) => {
    await open();
    await emit(snapshot(1, [command({ decisions: [{ kind: "egress", host: "denied.example.test", port: 443,
      decision: "deny", basis, scope: null, reason: "refused", attribution: "terminal-session", ts: Date.now() }] })]));
    expect(screen.getByTestId("terminal-observation-decisions").textContent).toContain("터미널 세션 · 하위 프로세스가 공유");
    expect(screen.getByTestId("terminal-observation-decision-basis").textContent).toBe(`결정 근거: ${label}`);
    expect(screen.getByTestId("terminal-observation-decision-scope").textContent).toBe("허용 범위: 허용 없음");
  });

  it("ignores documents, other sessions, other targets, duplicates and reordered snapshots", async () => {
    await open();
    await emit(snapshot(2, [command({ command: "approved command" })]));
    await emit(snapshot(1, [command({ command: "old command" })]), snapshot(2, [command({ command: "duplicate command" })]),
      snapshot(3, [command({ command: "foreign target" })], { target: { id: OTHER_TARGET, path: "other" } }),
      snapshot(4, [command({ command: "foreign session" })], { sessionId: "other-session" }),
      { source: "document", actor: "agent", sessionId: SESSION, target: { id: TARGET, path: "document" },
        seq: 5, ts: Date.now(), kind: "status", before: null, after: { code: "live" } });
    expect(screen.getByTestId("terminal-observation-command").textContent).toBe("approved command");
    expect(acknowledge.mock.calls.filter(([request]) => request.action === "rendered").map(([request]) => request.seq)).toEqual([2]);
  });

  it("ticks a running duration and pins the final exit code and duration", async () => {
    vi.useFakeTimers();
    const start = Date.now() - 12_000;
    render(<TerminalObservationHarness sessionId={SESSION} observe />);
    await act(async () => {});
    await emit(snapshot(1, [command({ startedAt: start })]));
    expect(screen.getByTestId("terminal-observation-duration").textContent).toBe("· 12s");
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(screen.getByTestId("terminal-observation-duration").textContent).toBe("· 14s");
    await emit(snapshot(2, [command({ startedAt: start, status: "failed", exitCode: 7, finishedAt: Date.now(), durationMs: 14_200 })]));
    expect(screen.getByTestId("terminal-observation-status").textContent).toBe("에이전트 실행 완료");
    expect(screen.getByTestId("terminal-observation-command-row").textContent).toContain("종료 코드 7");
    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(screen.getByTestId("terminal-observation-duration").textContent).toBe("· 14s");
  });

  it("releases and immediately hides the previous conversation when the session changes", async () => {
    const result = await open();
    await emit(snapshot(1));
    result.rerender(<TerminalObservationHarness sessionId="new-session" observe />);
    expect(screen.queryByTestId("terminal-observation-live-strip")).toBeNull();
    expect(acknowledge).toHaveBeenCalledWith({ action: "release", targetId: TARGET, sessionId: SESSION, seq: 0 });
    await emit(snapshot(2));
    expect(screen.queryByTestId("terminal-observation-live-strip")).toBeNull();
    result.unmount();
    expect(listeners.size).toBe(0);
  });

  it("releases a late subscription reply after unmount", async () => {
    let finish: (response: ObservationResponse) => void = () => { throw new Error("Subscription has not started"); };
    acknowledge.mockImplementation((request: { action: string }) => request.action === "subscribe-terminal"
      ? new Promise<ObservationResponse>((resolve) => { finish = resolve; }) : Promise.resolve({ ok: true }));
    const result = render(<TerminalObservationHarness sessionId={SESSION} observe />);
    result.unmount();
    await act(async () => { finish({ ok: true, observation: { targetId: TARGET, sessionId: SESSION, seq: 0 } }); });
    expect(acknowledge).toHaveBeenLastCalledWith({ action: "release", targetId: TARGET, sessionId: SESSION, seq: 0 });
    expect(listeners.size).toBe(0);
  });

  it("shows localized subscription, host status and render acknowledgement failures in the same slot", async () => {
    acknowledge.mockResolvedValueOnce({ ok: false, error: "unauthorized" });
    const failed = render(<TerminalObservationHarness sessionId={SESSION} observe />);
    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toBe("에이전트 터미널 활동을 표시하지 못했습니다");
    failed.unmount();
    await open();
    await emit({ source: "terminal", actor: "agent", sessionId: SESSION, target: { id: TARGET, path: "agent-terminal" },
      seq: 1, ts: Date.now(), kind: "status", before: null, after: { code: "resync-required" } });
    expect(screen.getAllByTestId("terminal-observation-live-strip")).toHaveLength(1);
    expect(screen.getByRole("alert").textContent).toBe("에이전트 터미널 활동을 다시 연결해야 합니다");
    acknowledge.mockResolvedValueOnce({ ok: false, error: "bad-request" });
    await emit(snapshot(2));
    await waitFor(() => expect(screen.getByRole("alert").textContent).toBe("에이전트 터미널 활동을 표시하지 못했습니다"));
    expect(screen.queryByTestId("terminal-observation-commands")).toBeNull();
  });

  it("bounds snapshots waiting for the subscription reply and reports overload", async () => {
    acknowledge.mockImplementation(() => new Promise<ObservationResponse>(() => {}));
    render(<TerminalObservationHarness sessionId={SESSION} observe />);
    await emit(...Array.from({ length: OBSERVATION_LIMITS.maxViews + 1 }, (_, index) => snapshot(index + 1, [command()], { target: { id: `pending-${index}`, path: "agent-terminal" } })));
    expect(screen.getByRole("alert").textContent).toBe("에이전트 터미널 활동을 다시 연결해야 합니다");
  });

  it("marks transports that provide output only at completion without claiming streaming", async () => {
    await open();
    await emit(snapshot(1, [command({ outputAvailability: "on-completion" })]));
    expect(screen.getByTestId("terminal-observation-command-row").textContent).toContain("완료 시 출력 제공");
  });

  it("provides both locale labels for running and completed activity", () => {
    expect(en["terminalObservation.running"]).toBe("Agent running");
    expect(ko["terminalObservation.running"]).toBe("에이전트 실행 중");
    expect(en["terminalObservation.completed"]).toBe("Agent execution finished");
    expect(ko["terminalObservation.completed"]).toBe("에이전트 실행 완료");
  });
});


describe("conversation-owned inline terminal commands", () => {
  const entries: ChatEntry[] = [
    { kind: "user", text: "first turn" },
    { kind: "tool_group", groupId: "first-group", groupIds: ["first-group"], status: "done", tools: [{ toolUseId: "tool-one", name: "bash", displayOrder: 0, status: "done" }] },
    { kind: "assistant", text: "first answer", phase: "final" },
    { kind: "user", text: "second turn" },
    { kind: "tool_group", groupId: "second-group", groupIds: ["second-group"], status: "done", tools: [{ toolUseId: "tool-two", name: "bash", displayOrder: 0, status: "done" }] },
    { kind: "assistant", text: "second answer", phase: "final" },
  ];
  it("places each command beside its own turn and shares one authenticated subscription", async () => {
    render(<TooltipProvider><TranscriptRenderer entries={entries} streaming={false} currentSessionId={SESSION} observeTerminal /></TooltipProvider>);
    await waitFor(() => expect(acknowledge).toHaveBeenCalledWith({ action: "subscribe-terminal", sessionId: SESSION }));
    await emit(snapshot(1, [
      command({ command: "first-command", status: "completed", exitCode: 0 }),
      command({ id: "second", toolUseId: "tool-two", turnId: "turn-two", command: "second-command", status: "failed", exitCode: 7 }),
      command({ id: "foreign", toolUseId: "not-in-transcript", command: "foreign-command" }),
    ]));
    const rows = screen.getAllByTestId("terminal-observation-command-row");
    expect(rows).toHaveLength(2);
    expect(rows[0]!.textContent).toContain("first-command");
    expect(rows[1]!.textContent).toContain("second-command");
    expect(rows[0]!.compareDocumentPosition(screen.getByText("second turn")) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.queryByText("foreign-command")).toBeNull();
    expect(acknowledge.mock.calls.filter(([request]) => request.action === "subscribe-terminal")).toHaveLength(1);
    expect(rows[1]!.querySelector("summary")!.textContent).toContain("7");
    expect(rows[1]!.querySelector("summary")!.textContent).toContain("/workspace/project");
  });

  it("labels confined and explicitly approved host commands with their actual execution domain", async () => {
    await open();
    await emit(snapshot(1, [command(), command({ id: "host", toolUseId: "host-tool", command: "approved-host-command", sandbox: { mode: "unconfined", detail: "approved host execution" } })]));
    expect(screen.getByTestId("terminal-isolated-identity").textContent).toBe(ko["terminalObservation.isolatedLabel"]);
    expect(screen.getByTestId("terminal-approved-host-identity").textContent).toBe(ko["terminalObservation.approvedHostLabel"]);
    expect(screen.getByTestId("terminal-isolated-identity").closest("li")!.className).toContain("border-l-agent");
    expect(screen.getByTestId("terminal-approved-host-identity").closest("li")!.className).toContain("border-l-primary");
  });
});
