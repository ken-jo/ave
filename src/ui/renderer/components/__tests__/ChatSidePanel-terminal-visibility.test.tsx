// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { approvalSurfaceStub, emptyToolActivity } from "../../../../../test/renderer/helpers.js";
import { makeMockAveNamespace } from "../../../../../test/renderer/mock-ave-api.js";
import type { AgentObservationEvent, TerminalObservationRequest } from "../../../../shared/agent-observation.js";
import { SIDE_PANEL_MIN_WIDTH } from "../../../../shared/side-panel.js";
import { TEST_IDS } from "../../../../shared/test-ids.js";
import { ApprovalSurfaceProvider } from "../../hooks/use-approval.js";
import { useWorkspaceTabs, type WorkspaceTabsStore } from "../../preview/workspace-tabs.js";
import type { AveApi } from "../../types.js";
import { ChatSidePanel } from "../ChatSidePanel.js";

const TARGET_ID = "b0000000-0000-4000-8000-000000000001";

let store: WorkspaceTabsStore | null = null;
let previousWindowAve: unknown;
let listener: ((events: AgentObservationEvent[]) => void) | null = null;
let stopListening: ReturnType<typeof vi.fn>;
let acknowledge: ReturnType<typeof vi.fn>;

beforeEach(() => {
  previousWindowAve = window.ave;
  const ns = makeMockAveNamespace().ns;
  stopListening = vi.fn(() => { listener = null; });
  acknowledge = vi.fn(async (request: TerminalObservationRequest) => ({
    ok: true,
    ...(request.action === "subscribe-terminal" ? { observation: { targetId: TARGET_ID, sessionId: request.sessionId, seq: 0 } } : {}),
  }));
  (window as unknown as { ave: unknown }).ave = { ...ns, preview: {
    ...ns.preview,
    onAgentObservation: vi.fn((handler: (events: AgentObservationEvent[]) => void) => { listener = handler; return stopListening; }),
    acknowledgeAgentObservation: acknowledge,
  } };
});

afterEach(() => {
  (window as unknown as { ave: unknown }).ave = previousWindowAve;
  store = null;
  listener = null;
});

const api = { openExternalUrl: vi.fn(async () => ({ ok: true })) } as unknown as AveApi;

function Harness({ visible }: { visible: boolean }) {
  const workspaceTabs = useWorkspaceTabs();
  store = workspaceTabs;
  return (
    <TooltipProvider>
      <ApprovalSurfaceProvider value={approvalSurfaceStub()}>
        <ChatSidePanel
          api={api}
          visible={visible}
          sessionId="s1"
          targets={[]}
          files={[]}
          selectedId={null}
          onSelect={vi.fn()}
          workspaceTabs={workspaceTabs}
          subAgentSpawns={[]}
          width={SIDE_PANEL_MIN_WIDTH}
          onWidthChange={vi.fn()}
          onWidthCommit={vi.fn()}
          onClose={vi.fn()}
          activity={emptyToolActivity()}
        />
      </ApprovalSurfaceProvider>
    </TooltipProvider>
  );
}

const actions = (action: string) => acknowledge.mock.calls.filter(([request]) => (request as TerminalObservationRequest).action === action);

const COMMAND = {
  id: "command-one", toolUseId: "tool-one", turnId: "turn-one", kind: "shell", command: "bun test", cwd: "/workspace/project",
  startedAt: 1, finishedAt: 2, durationMs: 1, status: "completed", exitCode: 0, outputTail: "all passed\n", outputTruncated: false,
  sandbox: { mode: "isolated", detail: "filesystem and process confinement" }, outputAvailability: "streaming", decisions: [],
};

function snapshot(seq: number): AgentObservationEvent {
  return {
    source: "terminal", kind: "snapshot", actor: "agent", sessionId: "s1", seq, ts: seq,
    target: { id: TARGET_ID, path: "terminal-activity" }, before: null, after: { commands: [COMMAND] },
  } as unknown as AgentObservationEvent;
}

describe("ChatSidePanel terminal observation visibility", () => {
  it("releases the terminal subscription while a retained panel is closed, keeps its view, and subscribes again on reopen", async () => {
    const view = render(<Harness visible />);
    // A browser page tab keeps the panel retained (mounted) after it closes.
    act(() => { store!.openInEphemeral({ source: "browser", url: "https://a.example/" }); });
    await waitFor(() => expect(actions("subscribe-terminal")).toHaveLength(1));
    await act(async () => { listener!([snapshot(1)]); });
    await waitFor(() => expect(actions("rendered")).toHaveLength(1));
    const row = screen.getByTestId("terminal-observation-command-row");
    fireEvent.click(within(row).getByText("bun test"));
    expect(row).toHaveAttribute("open");

    view.rerender(<Harness visible={false} />);
    await waitFor(() => expect(actions("release")).toHaveLength(1));
    expect(actions("release")[0]![0]).toMatchObject({ action: "release", targetId: TARGET_ID, sessionId: "s1" });
    expect(stopListening).toHaveBeenCalledTimes(1);
    expect(listener).toBeNull();
    // Not unmounted: the panel, its retained browser tab and the expanded command row are still there.
    expect(screen.getByTestId(TEST_IDS.chatSidePanel)).toBeInTheDocument();
    expect(screen.getByTestId("chat-side-panel-browser-tab-host")).toBeInTheDocument();
    expect(screen.getByTestId("terminal-observation-command-row")).toBe(row);
    expect(row).toHaveAttribute("open");
    const acknowledgedWhileHidden = acknowledge.mock.calls.length;
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(acknowledge.mock.calls.length).toBe(acknowledgedWhileHidden);

    view.rerender(<Harness visible />);
    await waitFor(() => expect(actions("subscribe-terminal")).toHaveLength(2));
    expect(listener).not.toBeNull();
    await act(async () => { listener!([snapshot(2)]); });
    await waitFor(() => expect(actions("rendered")).toHaveLength(2));
    expect(screen.getByTestId("terminal-observation-command-row")).toBe(row);
    expect(row).toHaveAttribute("open");
    expect(actions("release")).toHaveLength(1);
  });
});
