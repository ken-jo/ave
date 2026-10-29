// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { approvalSurfaceStub, emptyToolActivity } from "../../../../../test/renderer/helpers.js";
import { makeMockAveNamespace } from "../../../../../test/renderer/mock-ave-api.js";
import type { AgentObservationEvent, ObservationRequest } from "../../../../shared/agent-observation.js";
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
  acknowledge = vi.fn(async (request: ObservationRequest) => ({
    ok: true,
    ...(request.action === "subscribe-terminal" ? { observation: { targetId: TARGET_ID, sessionId: request.sessionId, seq: 0 } } : {}),
  }));
  (window as unknown as { ave: unknown }).ave = { ...ns, preview: {
    ...ns.preview,
    onAgentObservation: vi.fn((handler: (events: AgentObservationEvent[]) => void) => { listener = handler; return stopListening; }),
    acknowledgeObservation: acknowledge,
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

const actions = (action: string) => acknowledge.mock.calls.filter(([request]) => (request as ObservationRequest).action === action);

describe("ChatSidePanel host terminal privacy", () => {
  it("never subscribes to isolated command observations when shown, hidden or reopened", () => {
    const view = render(<Harness visible />);
    act(() => { store!.openInEphemeral({ source: "browser", url: "https://a.example/" }); });
    expect(screen.getByTestId(TEST_IDS.chatSidePanel)).toBeInTheDocument();
    expect(actions("subscribe-terminal")).toHaveLength(0);
    expect(screen.queryByTestId("terminal-observation-content")).toBeNull();
    view.rerender(<Harness visible={false} />);
    view.rerender(<Harness visible />);
    expect(actions("subscribe-terminal")).toHaveLength(0);
    expect(screen.queryByTestId("terminal-observation-content")).toBeNull();
  });
});
