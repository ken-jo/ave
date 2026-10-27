// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { useLayoutEffect, useState, type ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AveApi } from "../../types.js";
import type { ChatPreviewTarget, WorkspaceFileItem } from "../../preview/preview-targets.js";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { ApprovalSurfaceProvider } from "../../hooks/use-approval.js";
import { approvalSurfaceStub, deferred } from "../../../../../test/renderer/helpers.js";
import { makeMockAveNamespace } from "../../../../../test/renderer/mock-ave-api.js";
import { AVE_SIDE_BROWSER_PARTITION } from "../../../../shared/side-browser.js";
import { SIDE_PANEL_MIN_WIDTH } from "../../../../shared/side-panel.js";
import { ChatSidePanel } from "../ChatSidePanel.js";
import { FileBrowserWorkspace, deriveRovingPath } from "../ChatSidePanelWorkspaces.js";
import { deriveWorkspaceChanges } from "../../preview/workspace-changes.js";
import { WebSurfaceLayer } from "../WebSurfaceLayer.js";
import { PaneFrame } from "../PaneFrame.js";
import { emptyToolActivity } from "../../../../../test/renderer/helpers.js";
import type { ToolActivityState } from "../ToolActivity.js";
import { useWorkspaceTabs } from "../../preview/workspace-tabs.js";
import type { SubAgentSpawn } from "../../subagents/types.js";
import type {
  NativeContextMenuAction,
  NativeContextMenuPayload,
} from "../../../../shared/native-context-menu.js";
import { TEST_IDS, chatSidePanelLauncherTestId } from "../../../../shared/test-ids.js";
import { ChatContextProvider, type ChatContextValue } from "../../context/ChatContext.js";
import type { SideChatOpenRequest } from "../SideChatView.js";
import type { AgentSpawnEvent } from "../../../../shared/subagent-events.js";
import type { SubAgentTranscriptRequest, SubAgentTranscriptResult } from "../../../../shared/subagent-transcript.js";
import { getLocale, setLocale, t } from "../../../../i18n/runtime.js";

type ChildTranscriptResult = Awaited<ReturnType<NonNullable<AveApi["chatGetSubAgentTranscript"]>>>;

let initialWindowAve: unknown;
beforeEach(() => {
  initialWindowAve = window.ave;
  (window as unknown as { ave: unknown }).ave = makeMockAveNamespace().ns;
});
afterEach(() => { (window as unknown as { ave: unknown }).ave = initialWindowAve; });

let nativeContextActionHandler: ((action: NativeContextMenuAction) => void) | null = null;
let previousWindowAve: unknown;
const showNativeContextMenu = vi.fn(async (_payload: NativeContextMenuPayload) => ({
  ok: true as const,
}));
function emitLastNativeContextCommand(command: NativeContextMenuAction["command"]) {
  const payload = showNativeContextMenu.mock.calls.at(-1)?.[0];
  if (!payload) throw new Error("native context menu was not requested");
  nativeContextActionHandler?.({ requestId: payload.requestId, command });
}

function api(): AveApi {
  return {
    openExternalUrl: vi.fn(async () => ({ ok: true })),
    chatGetVerbatimToolResult: vi.fn(async () => null),
    chatGetSubAgentTranscript: vi.fn(async () => ({ ok: false, error: "not-found" })),
    // useVerticalSplit (file-browser / preview / subagent tabs) seeds + persists
    // the split ratio through the settings round-trip.
    getSettings: vi.fn(async () => ({}) as never),
    updateSettings: vi.fn(async () => ({ ok: true }) as never),
    browserTabs: {
      bindTab: vi.fn(async () => ({ ok: true })),
      stop: vi.fn(async () => ({ ok: true })),
      onTabOp: vi.fn(() => () => undefined),
      onControl: vi.fn(() => () => undefined),
    },
    sideChat: {
      send: vi.fn(async () => ({ ok: true, result: {} })),
      new: vi.fn(async () => ({ ok: true, sessionId: "side-1" })),
      load: vi.fn(async () => ({ ok: true, sessionId: "side-1", messages: [] })),
      list: vi.fn(async () => ({ current: "side-1", sessions: [] })),
      abort: vi.fn(async () => ({ ok: true })),
      onStream: vi.fn(() => () => undefined),
      onFallback: vi.fn(() => () => undefined),
      getSubAgentTranscript: vi.fn(async () => ({ ok: false, error: "not-found" })),
    },
  } as unknown as AveApi;
}

/**
 * The panel's providers. `rerender` re-applies them so a rerender keeps the
 * same tree shape as the mount — a differently shaped tree remounts the
 * harness and loses the state a test is checking survives.
 */
/** One api for the layer across rerenders; these tests do not bind guests. */
const layerApi = api();

function withPanelProviders(ui: ReactElement) {
  return (
    <TooltipProvider>
      <ApprovalSurfaceProvider value={approvalSurfaceStub()}>
        {ui}
        {/* The window's browser guests live in this layer (portaled to body),
            not inside the panel — as in the app. */}
        <WebSurfaceLayer api={layerApi} />
      </ApprovalSurfaceProvider>
    </TooltipProvider>
  );
}

function renderPanel(ui: ReactElement) {
  const result = render(withPanelProviders(ui));
  return {
    ...result,
    rerender: (next: ReactElement) => result.rerender(withPanelProviders(next)),
  };
}

/**
 * Open the tab-bar "+" dropdown and pick a kind (mirrors the launcher menu).
 * Radix DropdownMenu opens on pointerdown, so fire that before the click.
 */
function openLauncherMenu() {
  const trigger = screen.getByTestId("chat-side-panel-add-tab");
  fireEvent.pointerDown(trigger, { button: 0, ctrlKey: false });
  fireEvent.click(trigger);
}
function addTabViaMenu(kind: "preview" | "file-browser" | "browser" | "terminal" | "subagent" | "activity") {
  openLauncherMenu();
  fireEvent.click(screen.getByTestId(`chat-side-panel-launcher-menu-${kind}`));
}

/**
 * Panel harness that owns the workspace-tab store the same way the real
 * ChatView does (via `useWorkspaceTabs`), plus the selected-preview state. The
 * store lives ABOVE the ChatSidePanel mount so tab state survives the panel
 * unmounting — the whole point of lifting it out of the component.
 */
function HarnessPanel({
  api,
  sessionId,
  targets,
  files,
  initialSelectedId,
  panelMounted = true,
  subAgentSpawns = [],
  onClose = vi.fn(),
  activity = emptyToolActivity(),
  onOpenActivityItem,
  sideChatPendingAnswer,
  sideChatOpenRequest,
}: {
  api: AveApi;
  sessionId?: string;
  targets: ChatPreviewTarget[];
  files: WorkspaceFileItem[];
  initialSelectedId: string | null;
  panelMounted?: boolean;
  subAgentSpawns?: SubAgentSpawn[];
  onClose?: () => void;
  activity?: ToolActivityState;
  onOpenActivityItem?: (target: string, web: boolean) => void;
  sideChatPendingAnswer?: boolean;
  sideChatOpenRequest?: SideChatOpenRequest;
}) {
  const [selectedId, setSelectedId] = useState(initialSelectedId);
  const workspaceTabs = useWorkspaceTabs();
  if (!panelMounted) return null;
  return (
    <ChatSidePanel
      api={api}
      sessionId={sessionId}
      targets={targets}
      files={files}
      selectedId={selectedId}
      onSelect={setSelectedId}
      workspaceTabs={workspaceTabs}
      subAgentSpawns={subAgentSpawns}
      width={SIDE_PANEL_MIN_WIDTH}
      onWidthChange={vi.fn()}
      onWidthCommit={vi.fn()}
      onClose={onClose}
      activity={activity}
      sideChatPendingAnswer={sideChatPendingAnswer}
      sideChatOpenRequest={sideChatOpenRequest}
      onOpenActivityItem={onOpenActivityItem}
    />
  );
}

function renderChildTranscript(apiMock: AveApi, overrides: Partial<SubAgentSpawn> = {}) {
  renderPanel(
    <HarnessPanel
      api={apiMock}
      sessionId="parent-session-1"
      targets={[]}
      files={[]}
      initialSelectedId={null}
      subAgentSpawns={[{
        spawnId: "child-spawn",
        childSessionId: "child-1",
        title: "Child transcript",
        status: "done",
        entries: [],
        toolCallCount: 0,
        ...overrides,
      }]}
    />,
  );
  fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("subagent")));
  return screen.getByTestId("chat-side-panel-subagent-detail");
}

async function renderPanelWithRecordedSideChat(
  apiMock: AveApi,
  subAgentSpawns: SubAgentSpawn[] = [],
  onCommit?: (text: string) => void,
) {
  (apiMock.sideChat!.load as ReturnType<typeof vi.fn>).mockResolvedValue({
    ok: true,
    sessionId: "side-7",
    messages: [{ index: 0, role: "assistant", content: "Recorded side-chat session" }],
  });
  const result = renderPanel(
    <>
      <HarnessPanel
        api={apiMock}
        sessionId="tile-session"
        targets={[]}
        files={[]}
        initialSelectedId={null}
        subAgentSpawns={subAgentSpawns}
        sideChatOpenRequest={{ chatGroupId: "main", sessionId: "requested-side", nonce: 1 }}
      />
      {onCommit ? <TranscriptCommitProbe revision={0} onCommit={onCommit} /> : null}
    </>,
  );
  fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("side-chat")));
  await within(screen.getByTestId("side-chat-transcript")).findByText("Recorded side-chat session");
  expect(apiMock.sideChat!.load).toHaveBeenCalledWith("requested-side");
  return result;
}

function TranscriptCommitProbe({ revision, onCommit }: { revision: number; onCommit: (text: string) => void }) {
  useLayoutEffect(() => {
    const detail = screen.queryByTestId("chat-side-panel-subagent-detail");
    if (detail) onCommit(detail.textContent ?? "");
  }, [revision, onCommit]);
  return null;
}

describe("ChatSidePanel", () => {
  beforeEach(() => {
    showNativeContextMenu.mockClear();
    nativeContextActionHandler = null;
    previousWindowAve = (window as unknown as { ave?: unknown }).ave;
    vi.spyOn(window, "getSelection").mockReturnValue(null);
    // File-browser tabs mount ProjectRootsBrowser (workspace.*) and
    // FilePreviewBody (preview.readFile / readDocument); provide sane default stubs so the
    // panel renders without a real preload bridge.
    const ave = {
      ui: {
        showNativeContextMenu,
        onNativeContextMenuAction: (handler: (action: NativeContextMenuAction) => void) => {
          nativeContextActionHandler = handler;
          return () => {
            if (nativeContextActionHandler === handler) nativeContextActionHandler = null;
          };
        },
      },
      attach: { openExternal: vi.fn(async () => ({ ok: true })) },
      preview: { ...makeMockAveNamespace().ns.preview,
        readFile: vi.fn(async () => ({ ok: true, content: "# preview", path: "/tmp/x.md", truncated: false })),
        readDocument: vi.fn(async () => ({ ok: false, error: "unsupported-format", message: "stub" })),
        onDocumentObservation: vi.fn(() => () => {}),
        acknowledgeDocumentObservation: vi.fn(async () => ({ ok: true })),
      },
      workspace: {
        listRoots: vi.fn(async () => ({ ok: true, defaultRoot: "/ws", roots: [{ path: "/ws", isDefault: true }] })),
        pickRoot: vi.fn(async () => ({ ok: true, canceled: true, roots: [{ path: "/ws", isDefault: true }] })),
        listDir: vi.fn(async () => ({ ok: true, path: "/ws", entries: [], truncated: false })),
        removeRoot: vi.fn(async () => ({ ok: true, removed: "", roots: [{ path: "/ws", isDefault: true }] })),
        reveal: vi.fn(async () => ({ ok: true })),
        dropPrepare: vi.fn(async () => ({ ok: true, pendingPath: "/ws/dropped", ackToken: "tok" })),
      },
    };
    (window as unknown as { ave: unknown }).ave = ave;
    // Drop-path bridge (#1458): resolveDroppedPaths is preload-only; default stub
    // returns no path so tests that don't drop are unaffected.
    vi.stubGlobal("aveDrop", { resolveDroppedPaths: vi.fn(() => [] as string[]) });
    (window as unknown as { aveDrop: unknown }).aveDrop = (globalThis as unknown as { aveDrop: unknown }).aveDrop;
  });
  afterEach(() => {
    if (previousWindowAve === undefined) {
      delete (window as unknown as { ave?: unknown }).ave;
    } else {
      (window as unknown as { ave: unknown }).ave = previousWindowAve;
    }
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("opens empty: shows the launcher with five items and shortcut hints, no tabs, no counts", () => {
    renderPanel(
      <HarnessPanel
        api={api()}
        sessionId="session-1"
        targets={[]}
        files={[]}
        initialSelectedId={null}
      />,
    );

    // Empty workspace -> launcher body, no tabs. The strip itself stays: it
    // is the panel's header now, so the control that opens the first tab has
    // to be reachable before there is a tab to hang it beside.
    expect(screen.getByTestId("chat-side-panel-launcher")).toBeTruthy();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.getByTestId("chat-side-panel-add-tab")).toBeTruthy();

    // Seven launcher items: the five surfaces, side chat, and the activity
    // tab that lists the conversation's plugin and tool calls in full.
    expect(screen.getByTestId(chatSidePanelLauncherTestId("preview"))).toBeTruthy();
    expect(screen.getByTestId(chatSidePanelLauncherTestId("terminal"))).toBeTruthy();
    expect(screen.getByTestId(chatSidePanelLauncherTestId("browser"))).toBeTruthy();
    expect(screen.getByTestId(chatSidePanelLauncherTestId("file-browser"))).toBeTruthy();
    expect(screen.getByTestId(chatSidePanelLauncherTestId("subagent"))).toBeTruthy();
    expect(screen.getByTestId(chatSidePanelLauncherTestId("activity"))).toBeTruthy();
    expect(screen.getByTestId(chatSidePanelLauncherTestId("side-chat"))).toBeTruthy();

    // Shortcut hints are displayed for the bound items.
    expect(screen.getByText("⌃⇧G")).toBeTruthy();
    expect(screen.getByText("⌘T")).toBeTruthy();
    expect(screen.getByText("⌘P")).toBeTruthy();
    expect(screen.getByText("⌥⌘S")).toBeTruthy();
  });

  it("launcher click opens the correct-kind tab", () => {
    renderPanel(
      <HarnessPanel
        api={api()}
        sessionId="session-1"
        targets={[]}
        files={[]}
        initialSelectedId={null}
      />,
    );

    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("browser")));
    // Launcher gone, a browser tab is active.
    expect(screen.queryByTestId("chat-side-panel-launcher")).toBeNull();
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    expect(screen.getByTestId("chat-side-panel-tab-browser")).toBeTruthy();
    expect(screen.getByTestId("chat-side-panel-browser-workspace")).toBeTruthy();
  });

  it("keeps the side chat mounted behind another tab, and marks its tab while a card waits there", () => {
    const panel = (pending: boolean) => (
      <HarnessPanel
        api={api()}
        sessionId="session-1"
        targets={[]}
        files={[]}
        initialSelectedId={null}
        sideChatPendingAnswer={pending}
      />
    );
    const view = renderPanel(panel(false));
    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("side-chat")));
    expect(screen.getByTestId("side-chat-view")).toBeTruthy();
    const host = () => screen.getByTestId("chat-side-panel-side-chat-host");
    expect(host().className).not.toBe("hidden");

    // Another tab takes the panel: the side chat's view stays in the tree —
    // its claim and its parked cards live in it — but out of sight.
    openLauncherMenu();
    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("menu-browser")));
    expect(screen.getByTestId("chat-side-panel-tab-browser").getAttribute("aria-selected")).toBe("true");
    expect(screen.getByTestId("side-chat-view")).toBeTruthy();
    expect(host().className).toBe("hidden");
    expect(screen.queryByTestId("chat-side-panel-tab-side-chat-pending-answer")).toBeNull();

    // The window says a card is parked there: the tab says so too.
    view.rerender(panel(true));
    const dot = screen.getByTestId("chat-side-panel-tab-side-chat-pending-answer");
    expect(screen.getByTestId("chat-side-panel-tab-side-chat").contains(dot)).toBe(true);

    // Back on the side-chat tab the card is on screen — no dot for a card the user can see.
    fireEvent.click(screen.getByTestId("chat-side-panel-tab-side-chat"));
    expect(screen.queryByTestId("chat-side-panel-tab-side-chat-pending-answer")).toBeNull();
    expect(host().className).not.toBe("hidden");
  });

  it("launcher keyboard shortcut opens the mapped tab (⌘T -> browser)", () => {
    renderPanel(
      <HarnessPanel
        api={api()}
        sessionId="session-1"
        targets={[]}
        files={[]}
        initialSelectedId={null}
      />,
    );

    fireEvent.keyDown(window, { key: "t", metaKey: true });
    expect(screen.queryByTestId("chat-side-panel-launcher")).toBeNull();
    expect(screen.getByTestId("chat-side-panel-tab-browser")).toBeTruthy();
  });

  it("tab-bar exposes a single '+' launcher dropdown, not scattered add buttons", () => {
    renderPanel(
      <HarnessPanel
        api={api()}
        sessionId="session-1"
        targets={[]}
        files={[]}
        initialSelectedId={null}
      />,
    );

    // Open one tab so the tab bar (and its actions) render.
    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("file-browser")));
    // Single "+" button; the old per-kind add buttons are gone.
    expect(screen.getByTestId("chat-side-panel-add-tab")).toBeTruthy();

    // The "+" dropdown opens the same launcher items and creates a tab.
    openLauncherMenu();
    expect(screen.getByTestId(chatSidePanelLauncherTestId("menu-browser"))).toBeTruthy();
    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("menu-browser")));
    expect(screen.getByTestId("chat-side-panel-tab-browser")).toBeTruthy();
    expect(screen.getAllByRole("tab").length).toBe(2);
  });

  it("closing the last tab returns to the launcher", () => {
    renderPanel(
      <HarnessPanel
        api={api()}
        sessionId="session-1"
        targets={[]}
        files={[]}
        initialSelectedId={null}
      />,
    );

    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("terminal")));
    expect(screen.getAllByRole("tab")).toHaveLength(1);
    // Every tab is closeable — click the close affordance.
    fireEvent.click(screen.getByLabelText(/Close tab|탭 닫기/i));
    expect(screen.getByTestId("chat-side-panel-launcher")).toBeTruthy();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
  });

  it("hides the ordinal on a lone container tab and shows it once a second of the same kind opens", () => {
    renderPanel(
      <HarnessPanel
        api={api()}
        sessionId="session-1"
        targets={[]}
        files={[]}
        initialSelectedId={null}
      />,
    );

    // A single browser tab: the label carries no meaningless "1".
    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("browser")));
    let browserTabs = screen.getAllByTestId("chat-side-panel-tab-browser");
    expect(browserTabs).toHaveLength(1);
    expect(browserTabs[0].textContent).not.toMatch(/\d/);

    // Opening a second browser tab makes both show their ordinal to disambiguate.
    addTabViaMenu("browser");
    browserTabs = screen.getAllByTestId("chat-side-panel-tab-browser");
    expect(browserTabs).toHaveLength(2);
    expect(browserTabs[0].textContent).toMatch(/1/);
    expect(browserTabs[1].textContent).toMatch(/2/);
  });

  it("tab bar shows no count badge", () => {
    const targets: ChatPreviewTarget[] = [
      {
        id: "json-1",
        kind: "json",
        title: "metrics.json",
        sourceLabel: "builtin",
        createdOrder: 0,
        value: { ok: true },
        raw: "{\"ok\":true}",
      },
      {
        id: "json-2",
        kind: "json",
        title: "other.json",
        sourceLabel: "builtin",
        createdOrder: 1,
        value: { ok: false },
        raw: "{\"ok\":false}",
      },
    ];
    renderPanel(
      <HarnessPanel
        api={api()}
        sessionId="session-1"
        targets={targets}
        files={[]}
        initialSelectedId={null}
      />,
    );

    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("preview")));
    const tab = screen.getByTestId("chat-side-panel-tab-preview");
    // Label shows content name + ordinal only — no "2" count of preview targets.
    expect(tab.textContent).not.toMatch(/2/);
  });

  it("renders preview targets and separates browser artifacts and files across tabs", async () => {
    const targets: ChatPreviewTarget[] = [
      {
        id: "file-1",
        kind: "file",
        title: "report.md",
        subtitle: "read_file",
        sourceLabel: "builtin",
        createdOrder: 0,
        path: "C:\\workspace\\report.md",
        canOpenExternal: false,
      },
      {
        id: "html-1",
        kind: "html",
        title: "Artifact dashboard",
        subtitle: "render_html",
        sourceLabel: "builtin",
        createdOrder: 1,
        payload: { html: "<main>Preview OK</main>", title: "Artifact dashboard", height: 200 },
      },
      {
        id: "url-1",
        kind: "url",
        title: "example.com/docs",
        subtitle: "web_fetch",
        sourceLabel: "builtin",
        createdOrder: 2,
        url: "https://example.com/docs",
        // Named by a page rather than asked for by the turn — the row has to
        // say so before the viewer opens it in the webview.
        origin: "result",
      },
      {
        id: "json-1",
        kind: "json",
        title: "metrics.json",
        sourceLabel: "builtin",
        createdOrder: 3,
        value: { ok: true },
        raw: "{\"ok\":true}",
      },
    ];
    const files: WorkspaceFileItem[] = [
      {
        id: "tool:C:\\workspace\\report.md",
        path: "C:\\workspace\\report.md",
        label: "report.md",
        detail: "C:/workspace/report.md",
        sourceLabel: "read_file",
        operation: "read",
        previewTargetId: "file-1",
        canOpenExternal: false,
      },
    ];

    const { container } = renderPanel(
      <HarnessPanel
        api={api()}
        sessionId="session-1"
        targets={targets}
        files={files}
        initialSelectedId="file-1"
      />,
    );

    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("file-browser")));
    fireEvent.click(screen.getByTestId("chat-side-panel-file-filter-session"));
    const report = await within(screen.getByRole("tree")).findByText("report.md");
    expect(report.closest('[role="treeitem"]')).toHaveAttribute("aria-selected", "true");
    expect(screen.getByTestId("chat-side-panel-file-session-badge")).toHaveTextContent("세션");
    expect(screen.queryByTestId("chat-side-panel-file-source-segment")).toBeNull();
    expect(screen.getByTestId("chat-side-panel-file-browser")).toHaveAttribute("data-file-layout", "single");

    // Open a browser tab via the "+" dropdown (replaces scattered add buttons).
    // A browser tab is its address row and its page — nothing else: the list
    // of the conversation's pages is not in it. It opens on the latest page
    // (url-1, created after the html doc).
    addTabViaMenu("browser");
    expect(screen.queryByTestId("chat-side-panel-browser-visited")).toBeNull();
    expect(screen.queryByTestId("chat-preview-search")).toBeNull();
    // The page is a web surface: the panel draws its slot, the window's layer
    // draws the guest.
    expect(container.querySelector('[data-testid="web-surface-slot"]')).not.toBeNull();
    const webview = document.querySelector('[data-testid="chat-side-panel-browser-webview"]');
    expect(webview?.getAttribute("src")).toBe("https://example.com/docs");
    expect(webview?.getAttribute("partition")).toBe(AVE_SIDE_BROWSER_PARTITION);
    expect(webview?.getAttribute("webpreferences")).toContain("javascript=yes");
    expect(webview?.getAttribute("allowpopups")).toBe("true");

    const addressInput = screen.getByTestId("chat-side-panel-browser-address") as HTMLInputElement;
    expect(addressInput.value).toBe("https://example.com/docs");
    fireEvent.change(addressInput, { target: { value: "google.com" } });
    await act(async () => { fireEvent.click(screen.getByTestId("chat-side-panel-browser-go")); });
    const navigated = document.querySelector('[data-testid="chat-side-panel-browser-webview"]');
    // The same guest, navigated — not a second one.
    expect(navigated).toBe(webview);
    expect(navigated?.getAttribute("src")).toBe("https://google.com/");

    // Open a preview (review) tab via the "+" dropdown.
    addTabViaMenu("preview");
    expect(screen.queryByText("Artifact dashboard")).toBeNull();
    expect(screen.getAllByText("metrics.json").length).toBeGreaterThanOrEqual(1);
  });

  it("lists the conversation's pages on the empty landing, and opens a picked one in a tab", () => {
    const targets: ChatPreviewTarget[] = [
      {
        id: "html-1",
        kind: "html",
        title: "Artifact dashboard",
        subtitle: "render_html",
        sourceLabel: "builtin",
        createdOrder: 1,
        payload: { kind: "ave.render_html", html: "<main>Preview OK</main>", title: "Artifact dashboard", height: 200 },
      },
      {
        id: "url-1",
        kind: "url",
        title: "example.com/docs",
        subtitle: "web_fetch",
        sourceLabel: "builtin",
        createdOrder: 2,
        url: "https://example.com/docs",
        origin: "result",
      },
    ];
    renderPanel(<HarnessPanel api={api()} sessionId="session-1" targets={targets} files={[]} initialSelectedId={null} />);
    const visited = within(screen.getByTestId("chat-side-panel-launcher")).getByTestId("chat-side-panel-browser-visited");
    const rows = within(visited).getAllByTestId("chat-side-panel-browser-row");
    // Latest first, and the row says where its address came from.
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("example.com/docs"),
      expect.stringContaining("Artifact dashboard"),
    ]);
    expect(rows[0]!.textContent).toContain("결과에서");
    fireEvent.click(rows[0]!);
    // A browser content tab, its page a web surface.
    expect(screen.queryByTestId("chat-side-panel-launcher")).toBeNull();
    expect(document.querySelector('[data-testid="chat-side-panel-browser-webview"]')?.getAttribute("src")).toBe("https://example.com/docs");
  });

  it("preserves added workspace tabs across a ChatSidePanel unmount (session switch)", () => {
    // The store lives above the panel (in the harness, mirroring ChatView), so
    // unmounting the panel — as happens on a session switch, leaving home, or
    // closing the rail — must NOT lose tab state.
    const targets: ChatPreviewTarget[] = [];
    const files: WorkspaceFileItem[] = [];

    const { rerender } = renderPanel(
      <HarnessPanel
        api={api()}
        sessionId="session-1"
        targets={targets}
        files={files}
        initialSelectedId={null}
      />,
    );

    // Empty at mount (launcher, no tabs).
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    // Add a browser tab via the launcher.
    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("browser")));
    expect(screen.getAllByRole("tab")).toHaveLength(1);

    // Unmount the panel (session switch / rail close) — the harness (store)
    // stays mounted, exactly like ChatView across the conditional render.
    rerender(
        <HarnessPanel
          api={api()}
          sessionId="session-2"
          targets={targets}
          files={files}
          initialSelectedId={null}
          panelMounted={false}
        />,
    );
    expect(screen.queryByTestId(TEST_IDS.chatSidePanel)).toBeNull();

    // Remount the panel — the added tab is still present (state survived).
    rerender(
        <HarnessPanel
          api={api()}
          sessionId="session-2"
          targets={targets}
          files={files}
          initialSelectedId={null}
        />,
    );
    expect(screen.getByTestId(TEST_IDS.chatSidePanel)).toBeTruthy();
    expect(screen.getAllByRole("tab")).toHaveLength(1);
  });

  it("renders MCP app payloads through McpAppView in a preview tab", async () => {
    // Main returns a bundle: the sandbox-proxy URL to navigate to + the app HTML
    // (which now travels over the bridge, not in the document URL).
    const readUiResource = vi.fn(async () => ({
      proxyUrl: "ave-mcp-app://7365727665722d61/proxy.html?t=tok",
      html: "<main>MCP preview card</main>",
    }));
    vi.stubGlobal("ave", {
      preview: makeMockAveNamespace().ns.preview,
      mcp: { readUiResource },
    });
    (window as unknown as { ave: unknown }).ave = {
      preview: makeMockAveNamespace().ns.preview,
      mcp: { readUiResource },
    };
    const targets: ChatPreviewTarget[] = [
      {
        id: "plugin-1",
        kind: "plugin",
        title: "MCP card",
        subtitle: "ui://server-a/card",
        sourceLabel: "mcp:server-a",
        createdOrder: 0,
        serverId: "server-a",
        resourceUri: "ui://server-a/card",
        slot: "sidebar",
        height: 180,
        payload: {
          serverId: "server-a",
          resourceUri: "ui://server-a/card",
          slot: "sidebar",
          height: 180,
          title: "MCP card",
        },
      },
    ];

    const { container } = renderPanel(
      <HarnessPanel
        api={api()}
        sessionId="session-1"
        targets={targets}
        files={[]}
        initialSelectedId="plugin-1"
      />,
    );

    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("preview")));
    await waitFor(() => {
      // The optional third value is an immutable loopback generation, not CSP.
      // Main derives CSP from the resource's own _meta.ui.csp that it just fetched.
      expect(readUiResource).toHaveBeenCalledWith("server-a", "ui://server-a/card", undefined);
    });
    const webview = await waitFor(() => {
      const el = container.querySelector("webview");
      expect(el).not.toBeNull();
      return el as HTMLElement;
    });
    // The webview navigates to the host-owned sandbox-proxy document. The app HTML
    // is NO LONGER percent-encoded into the URL — it now travels over the bridge as
    // `ui/notifications/sandbox-resource-ready`, so it neither hits the ~2MB
    // data:-URL cap nor lands in an opaque-origin document.
    expect(webview.getAttribute("src")).toBe("ave-mcp-app://7365727665722d61/proxy.html?t=tok");
    expect(webview.getAttribute("src")).not.toContain("MCP%20preview%20card");
  });

  it("file-browser tab renders the project-roots browser and a scrollable tab strip (diagnosis ②③)", () => {
    renderPanel(
      <HarnessPanel api={api()} sessionId="session-1" targets={[]} files={[]} initialSelectedId={null} />,
    );
    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("file-browser")));
    expect(screen.getByTestId("chat-side-panel-project-roots")).toBeTruthy();
    // The tab strip is the drag/scroll container (role=tablist with the ref).
    expect(screen.getByTestId("chat-side-panel-tab-scroll")).toBeTruthy();
  });

  it("adding a project folder calls workspace.pickRoot (diagnosis ③)", async () => {
    const pickRoot = vi.fn(async () => ({
      ok: true as const,
      added: "/ws/proj",
      roots: [
        { path: "/ws", isDefault: true },
        { path: "/ws/proj", isDefault: false },
      ],
    }));
    const currentAve = (window as unknown as { ave?: Record<string, unknown> }).ave ?? {};
    (window as unknown as { ave: unknown }).ave = {
      ...currentAve,
      attach: { openExternal: vi.fn(async () => ({ ok: true })) },
      preview: { ...makeMockAveNamespace().ns.preview, onDocumentObservation: vi.fn(() => () => {}), acknowledgeDocumentObservation: vi.fn(async () => ({ ok: true })), readFile: vi.fn(async () => ({ ok: true, content: "# x", path: "/ws/a.md", truncated: false })) },
      workspace: {
        listRoots: vi.fn(async () => ({ ok: true, defaultRoot: "/ws", roots: [{ path: "/ws", isDefault: true }] })),
        pickRoot,
        listDir: vi.fn(async () => ({ ok: true, path: "/ws", entries: [], truncated: false })),
      },
    };

    renderPanel(
      <HarnessPanel api={api()} sessionId="session-1" targets={[]} files={[]} initialSelectedId={null} />,
    );
    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("file-browser")));
    fireEvent.click(screen.getByTestId("chat-side-panel-add-root"));
    await waitFor(() => expect(pickRoot).toHaveBeenCalledTimes(1));
  });

  it("dropping a folder resolves the path via the preload bridge and routes through dropPrepare → ack panel (#1458)", async () => {
    // Renderer-wiring lock: the drop MUST go through the webUtils bridge and the
    // main-side dropPrepare gate, then surface the acknowledgement panel — it can
    // NEVER persist a renderer-named path directly. (The real-Electron e2e proves
    // getPathForFile actually resolves a dropped File; this proves the wiring.)
    const resolveDroppedPaths = vi.fn(() => ["/ws/dropped-proj"]);
    const dropPrepare = vi.fn(async () => ({
      ok: true as const,
      pendingPath: "/ws/dropped-proj",
      ackToken: "drop-tok-1",
      warnings: [] as string[],
    }));
    vi.stubGlobal("aveDrop", { resolveDroppedPaths });
    (window as unknown as { aveDrop: unknown }).aveDrop = (globalThis as unknown as { aveDrop: unknown }).aveDrop;
    vi.stubGlobal("ave", {
      attach: { openExternal: vi.fn(async () => ({ ok: true })) },
      preview: { ...makeMockAveNamespace().ns.preview, onDocumentObservation: vi.fn(() => () => {}), acknowledgeDocumentObservation: vi.fn(async () => ({ ok: true })), readFile: vi.fn(async () => ({ ok: true, content: "# x", path: "/ws/a.md", truncated: false })) },
      workspace: {
        listRoots: vi.fn(async () => ({ ok: true, defaultRoot: "/ws", roots: [{ path: "/ws", isDefault: true }] })),
        pickRoot: vi.fn(async () => ({ ok: true, canceled: true, roots: [{ path: "/ws", isDefault: true }] })),
        listDir: vi.fn(async () => ({ ok: true, path: "/ws", entries: [], truncated: false })),
        dropPrepare,
      },
    });
    (window as unknown as { ave: unknown }).ave = (globalThis as unknown as { ave: unknown }).ave;

    renderPanel(
      <HarnessPanel api={api()} sessionId="session-1" targets={[]} files={[]} initialSelectedId={null} />,
    );
    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("file-browser")));
    const zone = screen.getByTestId("chat-side-panel-project-roots");
    const dataTransfer = { files: [{ name: "dropped-proj" }] as unknown as FileList, dropEffect: "" };
    fireEvent.drop(zone, { dataTransfer });

    await waitFor(() => expect(resolveDroppedPaths).toHaveBeenCalledTimes(1));
    expect(dropPrepare).toHaveBeenCalledWith("/ws/dropped-proj");
    // The ack panel is shown — the drop does NOT silently widen the read scope.
    await waitFor(() => expect(screen.getByTestId("chat-side-panel-root-warning")).toBeTruthy());
  });

  it("dropping a hard-denied folder surfaces a Korean-mapped error and shows no ack panel (#1458)", async () => {
    // A Layer-0 deny from dropPrepare must not offer an ack path — the renderer
    // surfaces the error and never reaches the confirmation panel. The main
    // process returns the STABLE `sensitive-path` code (never raw English prose),
    // which the renderer maps to the localized "outside allowed folders" copy.
    const resolveDroppedPaths = vi.fn(() => ["/home/me/.ssh"]);
    const dropPrepare = vi.fn(async () => ({ ok: false as const, error: "sensitive-path" }));
    vi.stubGlobal("aveDrop", { resolveDroppedPaths });
    (window as unknown as { aveDrop: unknown }).aveDrop = (globalThis as unknown as { aveDrop: unknown }).aveDrop;
    vi.stubGlobal("ave", {
      attach: { openExternal: vi.fn(async () => ({ ok: true })) },
      preview: { ...makeMockAveNamespace().ns.preview, onDocumentObservation: vi.fn(() => () => {}), acknowledgeDocumentObservation: vi.fn(async () => ({ ok: true })), readFile: vi.fn(async () => ({ ok: true, content: "# x", path: "/ws/a.md", truncated: false })) },
      workspace: {
        listRoots: vi.fn(async () => ({ ok: true, defaultRoot: "/ws", roots: [{ path: "/ws", isDefault: true }] })),
        pickRoot: vi.fn(async () => ({ ok: true, canceled: true, roots: [{ path: "/ws", isDefault: true }] })),
        listDir: vi.fn(async () => ({ ok: true, path: "/ws", entries: [], truncated: false })),
        dropPrepare,
      },
    });
    (window as unknown as { ave: unknown }).ave = (globalThis as unknown as { ave: unknown }).ave;

    renderPanel(
      <HarnessPanel api={api()} sessionId="session-1" targets={[]} files={[]} initialSelectedId={null} />,
    );
    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("file-browser")));
    const zone = screen.getByTestId("chat-side-panel-project-roots");
    fireEvent.drop(zone, { dataTransfer: { files: [{ name: ".ssh" }] as unknown as FileList } });

    const banner = await waitFor(() => screen.getByTestId("chat-side-panel-op-error"));
    // The surfaced text is the localized (Korean, per the test locale) copy — the
    // raw validator prose ("sensitive pattern") must NEVER reach the UI.
    expect(banner.textContent ?? "").toContain("허용된 프로젝트 폴더");
    expect(banner.textContent ?? "").not.toMatch(/sensitive pattern|sensitive-path/);
    expect(screen.queryByTestId("chat-side-panel-root-warning")).toBeNull();
  });

  it("dropping a file (not-a-dir) surfaces the Korean not-a-directory copy, not the raw code (#1459)", async () => {
    // The dropPrepare is-a-dir reject and the ack-pass TOCTOU re-check both return
    // the stable `not-a-dir` code; the renderer maps it to Korean via the shared
    // IPC error map — never surfacing the bare code.
    const resolveDroppedPaths = vi.fn(() => ["/ws/note.txt"]);
    const dropPrepare = vi.fn(async () => ({ ok: false as const, error: "not-a-dir" }));
    vi.stubGlobal("aveDrop", { resolveDroppedPaths });
    (window as unknown as { aveDrop: unknown }).aveDrop = (globalThis as unknown as { aveDrop: unknown }).aveDrop;
    vi.stubGlobal("ave", {
      attach: { openExternal: vi.fn(async () => ({ ok: true })) },
      preview: { ...makeMockAveNamespace().ns.preview, onDocumentObservation: vi.fn(() => () => {}), acknowledgeDocumentObservation: vi.fn(async () => ({ ok: true })), readFile: vi.fn(async () => ({ ok: true, content: "# x", path: "/ws/a.md", truncated: false })) },
      workspace: {
        listRoots: vi.fn(async () => ({ ok: true, defaultRoot: "/ws", roots: [{ path: "/ws", isDefault: true }] })),
        pickRoot: vi.fn(async () => ({ ok: true, canceled: true, roots: [{ path: "/ws", isDefault: true }] })),
        listDir: vi.fn(async () => ({ ok: true, path: "/ws", entries: [], truncated: false })),
        dropPrepare,
      },
    });
    (window as unknown as { ave: unknown }).ave = (globalThis as unknown as { ave: unknown }).ave;

    renderPanel(
      <HarnessPanel api={api()} sessionId="session-1" targets={[]} files={[]} initialSelectedId={null} />,
    );
    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("file-browser")));
    const zone = screen.getByTestId("chat-side-panel-project-roots");
    fireEvent.drop(zone, { dataTransfer: { files: [{ name: "note.txt" }] as unknown as FileList } });

    const banner = await waitFor(() => screen.getByTestId("chat-side-panel-op-error"));
    expect(banner.textContent ?? "").toContain("디렉터리가 아닙니다");
    expect(banner.textContent ?? "").not.toContain("not-a-dir");
    expect(screen.queryByTestId("chat-side-panel-root-warning")).toBeNull();
  });

  it("a non-file drag (no resolved path) is a no-op — dropPrepare is never called (#1458)", async () => {
    const resolveDroppedPaths = vi.fn(() => [] as string[]);
    const dropPrepare = vi.fn();
    vi.stubGlobal("aveDrop", { resolveDroppedPaths });
    (window as unknown as { aveDrop: unknown }).aveDrop = (globalThis as unknown as { aveDrop: unknown }).aveDrop;
    vi.stubGlobal("ave", {
      attach: { openExternal: vi.fn(async () => ({ ok: true })) },
      preview: { ...makeMockAveNamespace().ns.preview, onDocumentObservation: vi.fn(() => () => {}), acknowledgeDocumentObservation: vi.fn(async () => ({ ok: true })), readFile: vi.fn(async () => ({ ok: true, content: "# x", path: "/ws/a.md", truncated: false })) },
      workspace: {
        listRoots: vi.fn(async () => ({ ok: true, defaultRoot: "/ws", roots: [{ path: "/ws", isDefault: true }] })),
        pickRoot: vi.fn(async () => ({ ok: true, canceled: true, roots: [{ path: "/ws", isDefault: true }] })),
        listDir: vi.fn(async () => ({ ok: true, path: "/ws", entries: [], truncated: false })),
        dropPrepare,
      },
    });
    (window as unknown as { ave: unknown }).ave = (globalThis as unknown as { ave: unknown }).ave;

    renderPanel(
      <HarnessPanel api={api()} sessionId="session-1" targets={[]} files={[]} initialSelectedId={null} />,
    );
    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("file-browser")));
    const zone = screen.getByTestId("chat-side-panel-project-roots");
    fireEvent.drop(zone, { dataTransfer: { files: [] as unknown as FileList } });

    await waitFor(() => expect(resolveDroppedPaths).toHaveBeenCalledTimes(1));
    expect(dropPrepare).not.toHaveBeenCalled();
  });

  it("opens a filesystem file's content through the traversal-guarded preview IPC (diagnosis ①)", async () => {
    const readFile = vi.fn(async () => ({
      ok: true as const,
      content: "# Architecture\n\nreal content",
      path: "/ws/docs/architecture.md",
      truncated: false,
    }));
    vi.stubGlobal("ave", {
      attach: { openExternal: vi.fn(async () => ({ ok: true })) },
      preview: { ...makeMockAveNamespace().ns.preview, onDocumentObservation: vi.fn(() => () => {}), acknowledgeDocumentObservation: vi.fn(async () => ({ ok: true })), readFile },
      workspace: {
        listRoots: vi.fn(async () => ({ ok: true, defaultRoot: "/ws", roots: [{ path: "/ws", isDefault: true }] })),
        pickRoot: vi.fn(async () => ({ ok: true, canceled: true, roots: [{ path: "/ws", isDefault: true }] })),
        listDir: vi.fn(async (p: string) =>
          p === "/ws"
            ? { ok: true, path: "/ws", entries: [{ name: "architecture.md", path: "/ws/docs/architecture.md", type: "file" }], truncated: false }
            : { ok: true, path: p, entries: [], truncated: false },
        ),
      },
    });
    (window as unknown as { ave: unknown }).ave = (globalThis as unknown as { ave: unknown }).ave;

    renderPanel(
      <HarnessPanel api={api()} sessionId="session-1" targets={[]} files={[]} initialSelectedId={null} />,
    );
    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("file-browser")));
    const fileRow = await screen.findByTestId("chat-side-panel-fs-file");
    fireEvent.click(fileRow);
    await waitFor(() => expect(readFile).toHaveBeenCalledWith("/ws/docs/architecture.md", { workspaceRoot: "/ws", sessionId: "session-1" }));
    // The real content (not a path-only placeholder) renders in the detail pane.
    await screen.findByTestId("chat-side-panel-file-preview");
    await waitFor(() => expect(screen.getByText(/real content/)).toBeTruthy());
  });

  it("does not loop listDir when the active root fails to list", async () => {
    const listDir = vi.fn(async () => ({ ok: false as const, error: "read-failed" as const }));
    vi.stubGlobal("ave", {
      attach: { openExternal: vi.fn(async () => ({ ok: true })) },
      preview: { ...makeMockAveNamespace().ns.preview, onDocumentObservation: vi.fn(() => () => {}), acknowledgeDocumentObservation: vi.fn(async () => ({ ok: true })), readFile: vi.fn(async () => ({ ok: true, content: "", path: "/ws/x", truncated: false })) },
      workspace: {
        listRoots: vi.fn(async () => ({ ok: true, defaultRoot: "/ws", roots: [{ path: "/ws", isDefault: true }] })),
        pickRoot: vi.fn(async () => ({ ok: true, canceled: true, roots: [{ path: "/ws", isDefault: true }] })),
        listDir,
      },
    });
    (window as unknown as { ave: unknown }).ave = (globalThis as unknown as { ave: unknown }).ave;

    renderPanel(
      <HarnessPanel api={api()} sessionId="session-1" targets={[]} files={[]} initialSelectedId={null} />,
    );
    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("file-browser")));

    // The failing active-root load surfaces an error and is NOT retried forever.
    await screen.findByTestId("chat-side-panel-fs-error");
    const callsAfterError = listDir.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 100));
    // No additional IPC after the failure settled — the render→IPC loop is broken.
    expect(listDir.mock.calls.length).toBe(callsAfterError);
    expect(callsAfterError).toBeLessThanOrEqual(2);
  });

  it("requires acknowledgement before persisting a folder with adjacency warnings", async () => {
    const pickRoot = vi.fn(async (opts?: { ackToken?: string }) => {
      if (opts?.ackToken) {
        // Main resolves the token to its bound path — the renderer never names it.
        return {
          ok: true as const,
          added: "/ws/.git",
          roots: [
            { path: "/ws", isDefault: true },
            { path: "/ws/.git", isDefault: false },
          ],
        };
      }
      return {
        ok: true as const,
        requiresAcknowledgement: true as const,
        pendingPath: "/ws/.git",
        ackToken: "tok-abc",
        warnings: ["path contains '.git' segment — secrets may be exposed if added"],
        roots: [{ path: "/ws", isDefault: true }],
      };
    });
    vi.stubGlobal("ave", {
      attach: { openExternal: vi.fn(async () => ({ ok: true })) },
      preview: { ...makeMockAveNamespace().ns.preview, onDocumentObservation: vi.fn(() => () => {}), acknowledgeDocumentObservation: vi.fn(async () => ({ ok: true })), readFile: vi.fn(async () => ({ ok: true, content: "", path: "/ws/x", truncated: false })) },
      workspace: {
        listRoots: vi.fn(async () => ({ ok: true, defaultRoot: "/ws", roots: [{ path: "/ws", isDefault: true }] })),
        pickRoot,
        listDir: vi.fn(async () => ({ ok: true, path: "/ws", entries: [], truncated: false })),
      },
    });
    (window as unknown as { ave: unknown }).ave = (globalThis as unknown as { ave: unknown }).ave;

    renderPanel(
      <HarnessPanel api={api()} sessionId="session-1" targets={[]} files={[]} initialSelectedId={null} />,
    );
    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("file-browser")));
    fireEvent.click(screen.getByTestId("chat-side-panel-add-root"));

    // Warning banner appears; the pick was NOT persisted (no ack yet).
    await screen.findByTestId("chat-side-panel-root-warning");
    expect(pickRoot).toHaveBeenCalledTimes(1);
    expect(pickRoot).toHaveBeenLastCalledWith();

    // Confirm → pickRoot re-invoked with the one-time TOKEN (never a path).
    fireEvent.click(screen.getByTestId("chat-side-panel-root-warning-confirm"));
    await waitFor(() => expect(pickRoot).toHaveBeenCalledTimes(2));
    expect(pickRoot).toHaveBeenLastCalledWith({ ackToken: "tok-abc" });
    await waitFor(() => expect(screen.queryByTestId("chat-side-panel-root-warning")).toBeNull());
  });

  // ── ProjectRootsBrowser: keyboard nav + a11y + context menu + remove root ──

  /** Stub whose /ws lists two folders and one file; /ws/alpha lists one child. */
  function stubRichWorkspace(overrides?: Record<string, unknown>) {
    const listDir = vi.fn(async (p: string) => {
      if (p === "/ws") {
        return {
          ok: true as const,
          path: "/ws",
          entries: [
            { name: "alpha", path: "/ws/alpha", type: "directory" as const },
            { name: "beta", path: "/ws/beta", type: "directory" as const },
            { name: "readme.md", path: "/ws/readme.md", type: "file" as const },
          ],
          truncated: false,
        };
      }
      if (p === "/ws/alpha") {
        return {
          ok: true as const,
          path: "/ws/alpha",
          entries: [{ name: "a1.md", path: "/ws/alpha/a1.md", type: "file" as const }],
          truncated: false,
        };
      }
      return { ok: true as const, path: p, entries: [], truncated: false };
    });
    const reveal = vi.fn(async () => ({ ok: true as const }));
    const removeRoot = vi.fn(async () => ({
      ok: true as const,
      removed: "/ws/proj",
      roots: [{ path: "/ws", isDefault: true }],
    }));
    const writeText = vi.fn();
    vi.stubGlobal("navigator", { ...navigator, clipboard: { writeText }, platform: "MacIntel" });
    const currentAve =
      (window as unknown as { ave?: Record<string, unknown> }).ave ?? {};
    vi.stubGlobal("ave", {
      ...currentAve,
      attach: { openExternal: vi.fn(async () => ({ ok: true })) },
      preview: { ...makeMockAveNamespace().ns.preview, onDocumentObservation: vi.fn(() => () => {}), acknowledgeDocumentObservation: vi.fn(async () => ({ ok: true })), readFile: vi.fn(async () => ({ ok: true, content: "# x", path: "/ws/readme.md", truncated: false })) },
      workspace: {
        listRoots: vi.fn(async () => ({
          ok: true,
          defaultRoot: "/ws",
          roots: [
            { path: "/ws", isDefault: true },
            { path: "/ws/proj", isDefault: false },
          ],
        })),
        pickRoot: vi.fn(async () => ({ ok: true, canceled: true })),
        listDir,
        removeRoot,
        reveal,
        ...overrides,
      },
    });
    (window as unknown as { ave: unknown }).ave = (globalThis as unknown as { ave: unknown }).ave;
    return { listDir, reveal, removeRoot, writeText };
  }

  /**
   * The tree mounts before its first listing resolves, so wait for the rows
   * and their roving row.
   */
  async function treeRowsReady(tree: HTMLElement): Promise<HTMLElement[]> {
    return waitFor(() => {
      const rows = within(tree).getAllByRole("treeitem");
      expect(rows.some((row) => row.getAttribute("tabindex") === "0")).toBe(true);
      return rows;
    });
  }

  it("renders rows as ARIA treeitems with level/setsize/posinset and a single roving tabindex", async () => {
    stubRichWorkspace();
    renderPanel(
      <HarnessPanel api={api()} sessionId="s" targets={[]} files={[]} initialSelectedId={null} />,
    );
    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("file-browser")));
    const tree = await screen.findByRole("tree");
    const items = await treeRowsReady(tree);
    expect(items.length).toBe(3);
    expect(items[0].getAttribute("aria-level")).toBe("1");
    expect(items[0].getAttribute("aria-setsize")).toBe("3");
    expect(items[0].getAttribute("aria-posinset")).toBe("1");
    // Exactly one row is in the tab order (roving tabindex).
    const tabbable = items.filter((el) => el.getAttribute("tabindex") === "0");
    expect(tabbable.length).toBe(1);
  });

  it("derives the roving row from the active row, falling back to the first row", () => {
    const rows = [{ path: "/w/a" }, { path: "/w/b" }];
    expect(deriveRovingPath("/w/b", rows)).toBe("/w/b");
    expect(deriveRovingPath("/w/gone", rows)).toBe("/w/a");
    expect(deriveRovingPath(null, rows)).toBe("/w/a");
    expect(deriveRovingPath("/w/a", [])).toBeNull();
    expect(deriveRovingPath(null, [])).toBeNull();
  });

  it("ArrowDown moves the roving focus to the next row", async () => {
    stubRichWorkspace();
    renderPanel(
      <HarnessPanel api={api()} sessionId="s" targets={[]} files={[]} initialSelectedId={null} />,
    );
    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("file-browser")));
    const tree = await screen.findByRole("tree");
    await treeRowsReady(tree);
    fireEvent.keyDown(tree, { key: "ArrowDown" });
    const items = within(tree).getAllByRole("treeitem");
    // Second row (beta) becomes the roving-focus row (tabindex=0). Roving focus
    // is DISTINCT from selection: moving the arrow cursor does NOT set
    // aria-selected — that tracks the opened file only (APG tree pattern).
    expect(items[1].getAttribute("tabindex")).toBe("0");
    expect(items[1].getAttribute("aria-selected")).toBeNull();
    expect(items[1]).toHaveFocus();
  });

  it("Enter on a folder expands it (lazy-loads children into a role=group)", async () => {
    stubRichWorkspace();
    renderPanel(
      <HarnessPanel api={api()} sessionId="s" targets={[]} files={[]} initialSelectedId={null} />,
    );
    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("file-browser")));
    const tree = await screen.findByRole("tree");
    await treeRowsReady(tree);
    // First row is "alpha" (a directory) and is the active item.
    fireEvent.keyDown(tree, { key: "Enter" });
    await screen.findByText("a1.md");
    expect(within(tree).getByRole("group")).toBeTruthy();
  });

  it("type-ahead focuses the row whose name starts with the typed character", async () => {
    stubRichWorkspace();
    renderPanel(
      <HarnessPanel api={api()} sessionId="s" targets={[]} files={[]} initialSelectedId={null} />,
    );
    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("file-browser")));
    const tree = await screen.findByRole("tree");
    await treeRowsReady(tree);
    fireEvent.keyDown(tree, { key: "r" }); // -> readme.md
    const items = within(tree).getAllByRole("treeitem");
    expect(items[2].getAttribute("tabindex")).toBe("0");
    expect(items[2].getAttribute("aria-selected")).toBeNull();
    expect(items[2]).toHaveFocus();
  });

  it("right-click Reveal calls workspace.reveal with the row path (never opens the file)", async () => {
    const { reveal } = stubRichWorkspace();
    renderPanel(
      <HarnessPanel api={api()} sessionId="s" targets={[]} files={[]} initialSelectedId={null} />,
    );
    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("file-browser")));
    const fileRow = await screen.findByText("readme.md");
    fireEvent.contextMenu(fileRow.closest('[role="treeitem"]') ?? fileRow);
    expect(showNativeContextMenu).toHaveBeenCalledWith(expect.objectContaining({
      kind: "workspace-entry",
      commands: expect.arrayContaining([
        "workspace.open",
        "workspace.reveal",
        "workspace.copy-path",
        "workspace.copy-relative-path",
      ]),
    }));
    emitLastNativeContextCommand("workspace.reveal");
    await waitFor(() => expect(reveal).toHaveBeenCalledWith("/ws/readme.md"));
  });

  it("right-click Copy path writes the absolute path to the clipboard", async () => {
    const { writeText } = stubRichWorkspace();
    renderPanel(
      <HarnessPanel api={api()} sessionId="s" targets={[]} files={[]} initialSelectedId={null} />,
    );
    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("file-browser")));
    const fileRow = await screen.findByText("readme.md");
    fireEvent.contextMenu(fileRow.closest('[role="treeitem"]') ?? fileRow);
    emitLastNativeContextCommand("workspace.copy-path");
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("/ws/readme.md"));
  });

  it("remove-root button (non-default root) calls workspace.removeRoot; default root has no button", async () => {
    const { removeRoot } = stubRichWorkspace();
    renderPanel(
      <HarnessPanel api={api()} sessionId="s" targets={[]} files={[]} initialSelectedId={null} />,
    );
    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("file-browser")));
    // Default root active -> no remove button.
    await screen.findByTestId("chat-side-panel-add-root");
    expect(screen.queryByTestId("chat-side-panel-remove-root")).toBeNull();
    // Switch the active root to the non-default addition.
    const select = (await screen.findByTestId("chat-side-panel-root-select")) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "/ws/proj" } });
    const removeBtn = await screen.findByTestId("chat-side-panel-remove-root");
    fireEvent.click(removeBtn);
    await waitFor(() => expect(removeRoot).toHaveBeenCalledWith("/ws/proj"));
  });

  it("#1494 surfaces the pruned-grants count in the op-info status and lets the user dismiss it", async () => {
    // removeRoot reports prunedGrants:2 — the panel must show the i18n'd count in
    // the `chat-side-panel-op-info` status node (the widened effect of "Remove
    // folder" is made visible), and the dismiss control clears it.
    stubRichWorkspace({
      removeRoot: vi.fn(async () => ({
        ok: true as const,
        removed: "/ws/proj",
        roots: [{ path: "/ws", isDefault: true }],
        prunedGrants: 2,
      })),
    });
    renderPanel(
      <HarnessPanel api={api()} sessionId="s" targets={[]} files={[]} initialSelectedId={null} />,
    );
    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("file-browser")));
    const select = (await screen.findByTestId("chat-side-panel-root-select")) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "/ws/proj" } });
    fireEvent.click(await screen.findByTestId("chat-side-panel-remove-root"));
    // The op-info status renders the i18n'd count text. The renderer resolves to
    // the active locale (ko in this harness → "폴더 제거됨 · 저장된 권한 2건 함께 해제"):
    // assert the load-bearing count is interpolated and the revoke phrasing is
    // present, locale-agnostically.
    const info = await screen.findByTestId("chat-side-panel-op-info");
    expect(info.getAttribute("role")).toBe("status");
    expect(info.textContent).toContain("2");
    // The i18n string must be resolved (not the raw key) and mention the revoke.
    expect(info.textContent).not.toContain("removeRootPruned");
    expect(info.textContent).toMatch(/해제|revoked|révoqué|widerrufen|取消|撤销/);
    // Dismiss control clears the status.
    fireEvent.click(screen.getByTestId("chat-side-panel-op-info-dismiss"));
    await waitFor(() => expect(screen.queryByTestId("chat-side-panel-op-info")).toBeNull());
  });

  it("#1494 shows no op-info status when removeRoot pruned zero grants", async () => {
    // prunedGrants:0 → no transient info surface (only non-zero counts warrant the
    // extra disclosure). Guards against a "0 saved grants revoked" false alarm.
    stubRichWorkspace({
      removeRoot: vi.fn(async () => ({
        ok: true as const,
        removed: "/ws/proj",
        roots: [{ path: "/ws", isDefault: true }],
        prunedGrants: 0,
      })),
    });
    renderPanel(
      <HarnessPanel api={api()} sessionId="s" targets={[]} files={[]} initialSelectedId={null} />,
    );
    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("file-browser")));
    const select = (await screen.findByTestId("chat-side-panel-root-select")) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "/ws/proj" } });
    fireEvent.click(await screen.findByTestId("chat-side-panel-remove-root"));
    // Wait for the root list to update, then assert the info node never appeared.
    await waitFor(() =>
      expect(screen.queryByTestId("chat-side-panel-remove-root")).toBeNull(),
    );
    expect(screen.queryByTestId("chat-side-panel-op-info")).toBeNull();
  });

  it("collapse-all folds every open folder and disables itself when nothing is open", async () => {
    stubRichWorkspace();
    renderPanel(
      <HarnessPanel api={api()} sessionId="s" targets={[]} files={[]} initialSelectedId={null} />,
    );
    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("file-browser")));
    const alpha = await screen.findByText("alpha");
    // Disabled while nothing is expanded.
    expect((screen.getByTestId("chat-side-panel-collapse-all") as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(alpha);
    await screen.findByText("a1.md");
    const collapse = screen.getByTestId("chat-side-panel-collapse-all") as HTMLButtonElement;
    expect(collapse.disabled).toBe(false);
    fireEvent.click(collapse);
    await waitFor(() => expect(screen.queryByText("a1.md")).toBeNull());
    expect((screen.getByTestId("chat-side-panel-collapse-all") as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows an empty-folder placeholder when an expanded child dir has no entries", async () => {
    stubRichWorkspace();
    renderPanel(
      <HarnessPanel api={api()} sessionId="s" targets={[]} files={[]} initialSelectedId={null} />,
    );
    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("file-browser")));
    const beta = await screen.findByText("beta"); // /ws/beta lists []
    fireEvent.click(beta);
    await screen.findByTestId("chat-side-panel-fs-empty");
  });

  it("flags a truncated directory listing", async () => {
    stubRichWorkspace({
      listDir: vi.fn(async (p: string) =>
        p === "/ws"
          ? {
              ok: true,
              path: "/ws",
              entries: [{ name: "readme.md", path: "/ws/readme.md", type: "file" }],
              truncated: true,
            }
          : { ok: true, path: p, entries: [], truncated: false },
      ),
    });
    renderPanel(
      <HarnessPanel api={api()} sessionId="s" targets={[]} files={[]} initialSelectedId={null} />,
    );
    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("file-browser")));
    await screen.findByTestId("chat-side-panel-fs-truncated");
  });

  it("marks the OPENED file (selection) with aria-selected, distinct from roving focus", async () => {
    stubRichWorkspace();
    renderPanel(
      <HarnessPanel api={api()} sessionId="s" targets={[]} files={[]} initialSelectedId={null} />,
    );
    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("file-browser")));
    const tree = await screen.findByRole("tree");
    // Open readme.md — that is the SELECTION (opened file), not merely focus.
    fireEvent.click(await screen.findByText("readme.md"));
    await waitFor(() => {
      const readmeRow = within(tree)
        .getAllByRole("treeitem")
        .find((el) => el.textContent?.includes("readme.md"));
      expect(readmeRow?.getAttribute("aria-selected")).toBe("true");
    });
    // The folder rows (not opened) carry no aria-selected — selection ≠ focus.
    const alphaRow = within(tree)
      .getAllByRole("treeitem")
      .find((el) => el.textContent?.includes("alpha"));
    expect(alphaRow?.getAttribute("aria-selected")).toBeNull();
  });

  it("surfaces a removeRoot failure inline instead of swallowing it", async () => {
    stubRichWorkspace({
      removeRoot: vi.fn(async () => ({ ok: false as const, error: "not-an-additional-root" as const })),
    });
    renderPanel(
      <HarnessPanel api={api()} sessionId="s" targets={[]} files={[]} initialSelectedId={null} />,
    );
    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("file-browser")));
    const select = (await screen.findByTestId("chat-side-panel-root-select")) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "/ws/proj" } });
    fireEvent.click(await screen.findByTestId("chat-side-panel-remove-root"));
    // The failure is shown to the user, not dropped silently.
    const banner = await screen.findByTestId("chat-side-panel-op-error");
    expect(banner.textContent).toBeTruthy();
    // Dismissible.
    fireEvent.click(screen.getByTestId("chat-side-panel-op-error-dismiss"));
    await waitFor(() => expect(screen.queryByTestId("chat-side-panel-op-error")).toBeNull());
  });

  it("surfaces a reveal failure inline instead of swallowing it", async () => {
    stubRichWorkspace({
      reveal: vi.fn(async () => ({ ok: false as const, error: "path-not-allowed" as const })),
    });
    renderPanel(
      <HarnessPanel api={api()} sessionId="s" targets={[]} files={[]} initialSelectedId={null} />,
    );
    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("file-browser")));
    const fileRow = await screen.findByText("readme.md");
    fireEvent.contextMenu(fileRow.closest('[role="treeitem"]') ?? fileRow);
    emitLastNativeContextCommand("workspace.reveal");
    await screen.findByTestId("chat-side-panel-op-error");
  });

  it("file tab keeps zero-count filters available on the same directory tree", async () => {
    renderPanel(<HarnessPanel api={api()} sessionId="s" targets={[]} files={[]} initialSelectedId={null} />);
    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("file-browser")));
    const sessionFilter = screen.getByTestId("chat-side-panel-file-filter-session");
    expect(sessionFilter).not.toBeDisabled();
    expect(sessionFilter).toHaveTextContent("0");
    expect(screen.getByTestId("chat-side-panel-file-filter-all")).toHaveAttribute("aria-pressed", "true");
    fireEvent.click(sessionFilter);
    expect(screen.getByTestId("chat-preview-search")).toBeVisible();
    await screen.findByRole("tree");
  });

  it("file tab integrates session artifacts with the directory before filtering", async () => {
    const files: WorkspaceFileItem[] = [{ id: "report", path: "/ws/report.md", label: "report.md", detail: "report.md", sourceLabel: "read_file", operation: "read", canOpenExternal: false }];
    renderPanel(<HarnessPanel api={api()} sessionId="s" targets={[]} files={files} initialSelectedId={null} />);
    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("file-browser")));
    await within(screen.getByRole("tree")).findByText("report.md");
    const sessionFilter = screen.getByTestId("chat-side-panel-file-filter-session");
    expect(sessionFilter).toHaveTextContent("1");
    fireEvent.click(sessionFilter);
    expect(screen.getByRole("tree")).toHaveTextContent("report.md");
  });

  it("file tab keeps filters compact with pressed-state semantics", () => {
    renderPanel(<HarnessPanel api={api()} sessionId="s" targets={[]} files={[]} initialSelectedId={null} />);
    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("file-browser")));
    const all = screen.getByTestId("chat-side-panel-file-filter-all");
    expect(all).toHaveClass("h-7");
    fireEvent.click(screen.getByTestId("chat-side-panel-file-filter-changed"));
    expect(all).toHaveAttribute("aria-pressed", "false");
    expect(screen.getByTestId("chat-side-panel-file-filter-changed")).toHaveAttribute("aria-pressed", "true");
  });

  it("file tab search filters directory and session rows in the same tree", async () => {
    stubRichWorkspace();
    renderPanel(<HarnessPanel api={api()} sessionId="s" targets={[]} files={[]} initialSelectedId={null} />);
    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("file-browser")));
    await within(screen.getByRole("tree")).findByText("readme.md");
    fireEvent.change(screen.getByTestId("chat-preview-search"), { target: { value: "missing" } });
    expect(screen.getByRole("tree")).not.toHaveTextContent("readme.md");
    fireEvent.change(screen.getByTestId("chat-preview-search"), { target: { value: "readme" } });
    expect(screen.getByRole("tree")).toHaveTextContent("readme.md");
  });

  it("subagent tab: lists spawns (running first) and shows the selected one's detail", () => {
    const subAgentSpawns: SubAgentSpawn[] = [
      { spawnId: "done-1", title: "Completed agent", status: "done", instructions: "completed prompt", entries: [{ kind: "assistant", text: "did work", streaming: false }], summary: "all done", toolCallCount: 2 },
      { spawnId: "run-1", title: "Live agent", status: "running", instructions: "live prompt", entries: [{ kind: "assistant", text: "working", streaming: false }], toolCallCount: 1 },
    ];
    renderPanel(
      <HarnessPanel api={api()} sessionId="s" targets={[]} files={[]} initialSelectedId={null} subAgentSpawns={subAgentSpawns} />,
    );
    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("subagent")));
    const rows = screen.getAllByTestId("chat-side-panel-subagent-row");
    expect(rows).toHaveLength(2);
    // Running spawn sorts first and is auto-selected in the detail pane.
    expect(rows[0]!.textContent).toContain("Live agent");
    expect(rows[0]!.getAttribute("aria-selected")).toBe("true");
    const detail = screen.getByTestId("chat-side-panel-subagent-detail");
    expect(within(detail).getByTestId("chat-side-panel-subagent-transcript")).toBeTruthy();
    expect(detail.textContent).toContain("live prompt");
    expect(detail.textContent).toContain("working");
    expect(detail.textContent).not.toContain("Live agent");
    // Selecting the completed spawn swaps the chat-style detail transcript.
    fireEvent.click(rows[1]!);
    const completedDetail = screen.getByTestId("chat-side-panel-subagent-detail");
    expect(completedDetail.textContent).toContain("completed prompt");
    expect(completedDetail.textContent).toContain("did work");
    expect(completedDetail.textContent).not.toContain("Completed agent");
  });

  it("subagent tab: list is a role=listbox and each row is a role=option (valid aria-selected)", () => {
    const subAgentSpawns: SubAgentSpawn[] = [
      { spawnId: "run-1", title: "Live agent", status: "running", entries: [], toolCallCount: 0 },
    ];
    renderPanel(
      <HarnessPanel api={api()} sessionId="s" targets={[]} files={[]} initialSelectedId={null} subAgentSpawns={subAgentSpawns} />,
    );
    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("subagent")));
    // aria-selected is only valid inside a select container (listbox/grid/…).
    const listbox = screen.getByTestId("chat-side-panel-subagent-list");
    expect(listbox.getAttribute("role")).toBe("listbox");
    const rows = within(listbox).getAllByRole("option");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.getAttribute("aria-selected")).toBe("true");
  });

  it("subagent tab: selected detail reuses the shared WorkGroup/ToolGroup transcript renderer", () => {
    const subAgentSpawns: SubAgentSpawn[] = [
      {
        spawnId: "run-1",
        title: "Weather agent",
        status: "done",
        instructions: "서울 날씨를 확인해줘",
        entries: [
          { kind: "reasoning", text: "날씨 출처를 확인합니다.", streaming: false },
          {
            kind: "tool_group",
            groupId: "tg-weather",
            groupIds: ["tg-weather"],
            status: "done",
            tools: [
              {
                toolUseId: "weather-tool",
                name: "web_fetch",
                displayOrder: 0,
                status: "done",
                category: "network",
                input: { url: "https://weather.example.test" },
                result: "Seoul weather source content",
              },
            ],
          },
          { kind: "assistant", text: "서울은 맑음입니다.", streaming: false },
        ],
        toolCallCount: 1,
      },
    ];
    renderPanel(
      <HarnessPanel api={api()} sessionId="s" targets={[]} files={[]} initialSelectedId={null} subAgentSpawns={subAgentSpawns} />,
    );
    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("subagent")));
    const detail = screen.getByTestId("chat-side-panel-subagent-detail");
    const workGroup = within(detail).getByTestId("work-group");
    expect(workGroup).toBeTruthy();
    expect(detail.textContent).toContain("서울 날씨를 확인해줘");
    expect(detail.textContent).toContain("서울은 맑음입니다.");
    const buttons = detail.querySelectorAll("button");
    expect(buttons.length).toBeGreaterThanOrEqual(3);
    fireEvent.click(buttons[1]!);
    expect(detail.textContent).toContain("날씨 출처를 확인합니다.");
    fireEvent.click(buttons[2]!);
    expect(detail.textContent).toContain("weather.example.test");
    expect(detail.textContent).toContain("Seoul weather source content");
  });

  it("subagent tab: applies the same tools-only processing detail policy", () => {
    const subAgentSpawns: SubAgentSpawn[] = [
      {
        spawnId: "detail-policy",
        title: "Detail policy agent",
        status: "done",
        instructions: "inspect the project",
        entries: [
          { kind: "reasoning", text: "subagent reasoning", streaming: false },
          { kind: "assistant", text: "subagent intermediate", phase: "work", streaming: false },
          {
            kind: "tool_group",
            groupId: "detail-tool-group",
            groupIds: ["detail-tool-group"],
            status: "done",
            tools: [{ toolUseId: "detail-tool", name: "inspect", displayOrder: 0, status: "done" }],
          },
          { kind: "assistant", text: "subagent final", phase: "final", streaming: false },
        ],
        toolCallCount: 1,
      },
    ];
    renderPanel(
      <ChatContextProvider value={{ processingDisplayLevel: "tools" } as ChatContextValue}>
        <HarnessPanel api={api()} sessionId="s" targets={[]} files={[]} initialSelectedId={null} subAgentSpawns={subAgentSpawns} />
      </ChatContextProvider>,
    );
    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("subagent")));
    const detail = screen.getByTestId("chat-side-panel-subagent-detail");
    expect(within(detail).getByTestId("work-group")).toBeTruthy();
    expect(detail.textContent).not.toContain("subagent reasoning");
    expect(detail.textContent).not.toContain("subagent intermediate");
    expect(detail.textContent).toContain("subagent final");
  });

  it("subagent tab: hydrates the persisted child transcript through the shared chat renderer", async () => {
    const apiMock = api();
    apiMock.chatGetSubAgentTranscript = vi.fn(async () => ({
      ok: true,
      childSessionId: "child-1",
      messages: [
        { index: 0, role: "user", content: "internal profile preamble" },
        {
          index: 1,
          role: "assistant",
          content: "",
          toolCalls: [{ id: "child-tool-1", name: "web_fetch", input: { url: "https://news.example.test" } }],
        },
        {
          index: 2,
          role: "tool_result",
          toolUseId: "child-tool-1",
          toolName: "web_fetch",
          content: "headline source content",
        },
        { index: 3, role: "assistant", content: "hydrated child final" },
      ],
    }));
    const subAgentSpawns: SubAgentSpawn[] = [
      {
        spawnId: "derived-tu-1",
        title: "News agent",
        status: "done",
        instructions: "한국어로 오늘 뉴스 요약",
        childSessionId: "child-1",
        toolUseId: "parent-tool-1",
        entries: [],
        toolCallCount: 0,
      },
    ];
    renderPanel(
      <HarnessPanel api={apiMock} sessionId="parent-session-1" targets={[]} files={[]} initialSelectedId={null} subAgentSpawns={subAgentSpawns} />,
    );
    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("subagent")));
    await waitFor(() => expect(apiMock.chatGetSubAgentTranscript).toHaveBeenCalledWith({
      originSessionId: "parent-session-1",
      childSessionId: "child-1",
    }));
    await waitFor(() => {
      const detail = screen.getByTestId("chat-side-panel-subagent-detail");
      expect(within(detail).getByTestId("work-group")).toBeTruthy();
      expect(detail.textContent).toContain("한국어로 오늘 뉴스 요약");
      expect(detail.textContent).toContain("hydrated child final");
      expect(detail.textContent).not.toContain("internal profile preamble");
      expect(within(detail).getByTestId("chat-side-panel-subagent-transcript")).toBeTruthy();
    });
  });

  it("subagent tab: renders a localized status label, not the raw enum", () => {
    const subAgentSpawns: SubAgentSpawn[] = [
      { spawnId: "done-1", title: "Done agent", status: "done", entries: [], toolCallCount: 0 },
    ];
    renderPanel(
      <HarnessPanel api={api()} sessionId="s" targets={[]} files={[]} initialSelectedId={null} subAgentSpawns={subAgentSpawns} />,
    );
    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("subagent")));
    const row = screen.getByTestId("chat-side-panel-subagent-row");
    // Test locale is Korean: "완료" (statusDone), never the raw "done" enum.
    expect(row.textContent).toContain("완료");
    expect(row.textContent).not.toContain("done");
  });

  it("subagent tab: renders a budget suspension as waiting, never done", () => {
    const subAgentSpawns: SubAgentSpawn[] = [
      {
        spawnId: "wait-1",
        title: "Paused agent",
        status: "waiting",
        suspension: { reason: "budget", resumeId: "child-waiting" },
        entries: [],
        toolCallCount: 0,
      },
    ];
    renderPanel(
      <HarnessPanel api={api()} sessionId="s" targets={[]} files={[]} initialSelectedId={null} subAgentSpawns={subAgentSpawns} />,
    );
    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("subagent")));
    const row = screen.getByTestId("chat-side-panel-subagent-row");
    expect(row.textContent).toContain("대기 중");
    expect(within(row).getByText("대기 중").className).toContain("text-warning");
    expect(row.textContent).not.toContain("완료");
    expect(row.textContent).not.toContain("waiting");
  });
  it("subagent tab: renders interrupted as a localized status label", () => {
    const subAgentSpawns: SubAgentSpawn[] = [
      { spawnId: "stop-1", title: "Stopped agent", status: "interrupted", entries: [], toolCallCount: 0 },
    ];
    renderPanel(
      <HarnessPanel api={api()} sessionId="s" targets={[]} files={[]} initialSelectedId={null} subAgentSpawns={subAgentSpawns} />,
    );
    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("subagent")));
    const row = screen.getByTestId("chat-side-panel-subagent-row");
    expect(row.textContent).toContain("중단됨");
    expect(row.textContent).not.toContain("interrupted");
  });

  it("subagent tab: selection is pinned to the chosen spawn and does not jump when the list reorders", () => {
    // Two done spawns; select the second. When a new running spawn arrives and
    // reorders the list (running-first), the pinned selection must stay on the
    // originally-chosen spawn, not silently jump to the new top row.
    const initial: SubAgentSpawn[] = [
      { spawnId: "a", title: "Agent A", status: "done", entries: [{ kind: "assistant", text: "Agent A transcript", streaming: false }], toolCallCount: 0 },
      { spawnId: "b", title: "Agent B", status: "done", entries: [{ kind: "assistant", text: "Agent B transcript", streaming: false }], toolCallCount: 0 },
    ];
    const { rerender } = renderPanel(
      <HarnessPanel api={api()} sessionId="s" targets={[]} files={[]} initialSelectedId={null} subAgentSpawns={initial} />,
    );
    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("subagent")));
    const rows = screen.getAllByTestId("chat-side-panel-subagent-row");
    fireEvent.click(rows[1]!); // select Agent B
    expect(screen.getByTestId("chat-side-panel-subagent-detail").textContent).toContain("Agent B transcript");

    // A new running spawn arrives and would sort to the top of the list.
    const reordered: SubAgentSpawn[] = [
      ...initial,
      { spawnId: "c", title: "Agent C", status: "running", entries: [{ kind: "assistant", text: "Agent C transcript", streaming: false }], toolCallCount: 0 },
    ];
    rerender(
        <HarnessPanel api={api()} sessionId="s" targets={[]} files={[]} initialSelectedId={null} subAgentSpawns={reordered} />,
    );
    // The detail stays pinned to Agent B — no silent jump to the new top row.
    expect(screen.getByTestId("chat-side-panel-subagent-detail").textContent).toContain("Agent B transcript");
    expect(screen.getByTestId("chat-side-panel-subagent-detail").textContent).not.toContain("Agent C transcript");
  });

  it("subagent tab: side-chat transcript read hydrates only the panel's recorded owner", async () => {
    // The tile drops a side-chat frame as another conversation's (its list,
    // `subAgentSpawns`, stays empty here). The side chat is the only surface
    // that keeps it, and the panel's sub-agent tab is where it must be drawn.
    const spawnHandlers = new Set<(event: AgentSpawnEvent) => void>();
    const base = api();
    const transcriptReady = deferred<void>();
    base.sideChat!.getSubAgentTranscript = vi.fn(async (): Promise<SubAgentTranscriptResult> => {
      await transcriptReady.promise;
      return {
        ok: true,
        childSessionId: "side-child-1",
        messages: [{ index: 0, role: "assistant", content: "Persisted side-child transcript" }],
      };
    });
    const apiMock = {
      ...base,
      onAskUserQuestion: () => () => undefined,
      onAgentSpawnEvent: (handler: (event: AgentSpawnEvent) => void) => {
        spawnHandlers.add(handler);
        return () => { spawnHandlers.delete(handler); };
      },
    } as unknown as AveApi;
    const emit = (event: Partial<AgentSpawnEvent>) =>
      act(() => {
        for (const handler of spawnHandlers) handler(event as AgentSpawnEvent);
      });

    await renderPanelWithRecordedSideChat(apiMock);
    expect(spawnHandlers.size).toBeGreaterThan(0);

    await emit({
      type: "start",
      spawnId: "side-spawn-1",
      parentSessionId: "side-7",
      title: "Side researcher",
      childSessionId: "side-child-1",
    });
    // Another conversation's agent is not this panel's to draw.
    await emit({
      type: "start",
      spawnId: "foreign-spawn",
      parentSessionId: "some-other-conversation",
      title: "Foreign agent",
      childSessionId: "foreign-child",
    });

    addTabViaMenu("subagent");
    const rows = screen.getAllByTestId("chat-side-panel-subagent-row");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("Side researcher"),
    ]);
    await waitFor(() => expect(apiMock.sideChat!.getSubAgentTranscript).toHaveBeenCalledWith({
      originSessionId: "side-7",
      childSessionId: "side-child-1",
    }));
    await act(async () => {
      transcriptReady.resolve(undefined);
      await transcriptReady.promise;
    });
    expect(screen.getByTestId("chat-side-panel-subagent-detail").textContent).toContain("Persisted side-child transcript");
    expect(apiMock.chatGetSubAgentTranscript).not.toHaveBeenCalled();
  });

  it.each(((["ko", "en"] as const).flatMap((locale) =>
    (["tile", "side-chat"] as const).flatMap((route) =>
      (["running", "waiting", "done", "error", "interrupted"] as const).map((status) => ({ locale, route, status })),
    ),
  )))(
    "subagent tab: transcript miss preserves the $status state on the $route path in $locale",
    async ({ locale, route, status }) => {
      const previousLocale = getLocale();
      setLocale(locale);
      try {
        const pending = deferred<SubAgentTranscriptResult>();
        const apiMock = api();
        const reader = vi.fn(() => pending.promise);
        const otherReader = route === "side-chat" ? apiMock.chatGetSubAgentTranscript : apiMock.sideChat!.getSubAgentTranscript;
        if (route === "side-chat") {
          delete apiMock.chatGetSubAgentTranscript;
          apiMock.sideChat!.getSubAgentTranscript = reader;
        } else {
          apiMock.chatGetSubAgentTranscript = reader;
        }
        const parentSessionId = route === "side-chat" ? "side-7" : "tile-session";
        await renderPanelWithRecordedSideChat(apiMock, [{
          spawnId: "side-spawn-1",
          parentSessionId,
          childSessionId: "side-child-1",
          title: "Side researcher",
          status,
          entries: [],
          toolCallCount: 0,
        }]);
        addTabViaMenu("subagent");
        await waitFor(() => expect(reader).toHaveBeenCalledExactlyOnceWith({
          originSessionId: parentSessionId, childSessionId: "side-child-1",
        }));
        const detail = screen.getByTestId("chat-side-panel-subagent-transcript");
        expect(within(detail).getByRole("status")).toHaveTextContent(t("subAgentCard.transcriptLoading"));
        await act(async () => {
          pending.resolve({ ok: false, error: "sub-agent-transcript-not-found" });
          await pending.promise;
        });
        if (status === "running" || status === "waiting") {
          expect(detail.textContent).toBe(t(status === "running" ? "subAgentCard.statusRunning" : "subAgentCard.statusWaiting"));
          expect(within(detail).queryByRole("alert")).toBeNull();
        } else {
          expect(within(detail).getByRole("alert")).toHaveTextContent(locale === "ko"
            ? "대화 기록을 불러오지 못했습니다."
            : "Couldn't load transcript.");
        }
        expect(within(detail).queryByRole("status")).toBeNull();
        expect(detail).not.toHaveTextContent("sub-agent-transcript-not-found");
        expect(otherReader).not.toHaveBeenCalled();
      } finally {
        act(() => setLocale(previousLocale));
      }
    },
  );

  it.each(["missing", "denied", "rejected"] as const)(
    "subagent tab: side-chat transcript read keeps live entries without tile fallback when %s",
    async (readState) => {
      const apiMock = api();
      apiMock.chatGetSubAgentTranscript = vi.fn(async (): Promise<SubAgentTranscriptResult> => ({
        ok: true,
        childSessionId: "side-child-1",
        messages: [{ index: 0, role: "assistant", content: "Tile fallback transcript" }],
      }));
      if (readState === "missing") delete apiMock.sideChat!.getSubAgentTranscript;
      if (readState === "denied") {
        apiMock.sideChat!.getSubAgentTranscript = vi.fn(async (): Promise<SubAgentTranscriptResult> => ({
          ok: false, error: "sub-agent-reference-not-found",
        }));
      }
      if (readState === "rejected") {
        apiMock.sideChat!.getSubAgentTranscript = vi.fn(async () => { throw new Error("read unavailable"); });
      }
      const subAgentSpawns: SubAgentSpawn[] = [{
        spawnId: "side-spawn-1",
        parentSessionId: "side-7",
        childSessionId: "side-child-1",
        title: "Side researcher",
        status: "done",
        entries: [{ kind: "assistant", text: "Live side-child tail", streaming: false }],
        toolCallCount: 0,
      }];
      await renderPanelWithRecordedSideChat(apiMock, subAgentSpawns);
      addTabViaMenu("subagent");
      const pendingReads = [
        ...vi.mocked(apiMock.chatGetSubAgentTranscript!).mock.results,
        ...(apiMock.sideChat!.getSubAgentTranscript ? vi.mocked(apiMock.sideChat!.getSubAgentTranscript).mock.results : []),
      ];
      await act(async () => { await Promise.allSettled(pendingReads.map(({ value }) => value)); });
      if (readState !== "missing") expect(apiMock.sideChat!.getSubAgentTranscript).toHaveBeenCalledTimes(1);
      const detail = screen.getByTestId("chat-side-panel-subagent-detail");
      expect(detail.textContent).toContain("Live side-child tail");
      expect(detail.textContent).not.toContain("Tile fallback transcript");
      expect(apiMock.chatGetSubAgentTranscript).not.toHaveBeenCalled();
    },
  );

  it.each(["tile-session", "foreign-session", "requested-side", undefined])(
    "subagent tab: side-chat transcript read leaves a non-owner %s on the tile path",
    async (parentSessionId) => {
      const apiMock = api();
      apiMock.chatGetSubAgentTranscript = vi.fn(async (request: SubAgentTranscriptRequest): Promise<SubAgentTranscriptResult> => ({
        ok: true,
        childSessionId: request.childSessionId,
        messages: [{ index: 0, role: "assistant", content: "Persisted tile-path transcript" }],
      }));
      const subAgentSpawns: SubAgentSpawn[] = [{
        spawnId: "other-spawn",
        ...(parentSessionId ? { parentSessionId } : {}),
        childSessionId: "other-child",
        title: "Other researcher",
        status: "done",
        entries: [],
        toolCallCount: 0,
      }];
      await renderPanelWithRecordedSideChat(apiMock, subAgentSpawns);
      addTabViaMenu("subagent");
      await within(screen.getByTestId("chat-side-panel-subagent-detail")).findByText("Persisted tile-path transcript");
      expect(apiMock.chatGetSubAgentTranscript).toHaveBeenCalledWith({
        originSessionId: parentSessionId ?? "tile-session",
        childSessionId: "other-child",
      });
      expect(apiMock.sideChat!.getSubAgentTranscript).not.toHaveBeenCalled();
    },
  );

  it("subagent tab: side-chat transcript read ignores a late response after selection changes", async () => {
    const apiMock = api();
    const firstReady = deferred<void>();
    const secondReady = deferred<void>();
    apiMock.sideChat!.getSubAgentTranscript = vi.fn(async (request: SubAgentTranscriptRequest): Promise<SubAgentTranscriptResult> => {
      const first = request.childSessionId === "first-child";
      await (first ? firstReady.promise : secondReady.promise);
      return {
        ok: true,
        childSessionId: request.childSessionId,
        messages: [{ index: 0, role: "assistant", content: first ? "Late first-child transcript" : "Selected second-child transcript" }],
      };
    });
    const subAgentSpawns = ["first", "second"].map<SubAgentSpawn>((name) => ({
      spawnId: `${name}-spawn`,
      parentSessionId: "side-7",
      childSessionId: `${name}-child`,
      title: `${name} researcher`,
      status: "done",
      entries: [],
      toolCallCount: 0,
    }));
    await renderPanelWithRecordedSideChat(apiMock, subAgentSpawns);
    addTabViaMenu("subagent");
    await waitFor(() => expect(apiMock.sideChat!.getSubAgentTranscript).toHaveBeenCalledWith({
      originSessionId: "side-7", childSessionId: "first-child",
    }));
    fireEvent.click(screen.getAllByTestId("chat-side-panel-subagent-row")[1]!);
    await waitFor(() => expect(apiMock.sideChat!.getSubAgentTranscript).toHaveBeenCalledWith({
      originSessionId: "side-7", childSessionId: "second-child",
    }));
    await act(async () => {
      secondReady.resolve(undefined);
      await secondReady.promise;
    });
    expect(screen.getByTestId("chat-side-panel-subagent-detail").textContent).toContain("Selected second-child transcript");
    await act(async () => {
      firstReady.resolve(undefined);
      await firstReady.promise;
    });
    const detail = screen.getByTestId("chat-side-panel-subagent-detail");
    expect(detail.textContent).toContain("Selected second-child transcript");
    expect(detail.textContent).not.toContain("Late first-child transcript");
  });

  it("subagent tab: side-chat transcript read hides prior hydration at the next child's render commit", async () => {
    const apiMock = api();
    const nextReady = deferred<void>();
    apiMock.sideChat!.getSubAgentTranscript = vi.fn(async (request: SubAgentTranscriptRequest): Promise<SubAgentTranscriptResult> => {
      const next = request.childSessionId === "next-child";
      if (next) await nextReady.promise;
      return {
        ok: true,
        childSessionId: request.childSessionId,
        messages: [{ index: 0, role: "assistant", content: next ? "Next persisted transcript" : "Prior persisted transcript" }],
      };
    });
    const spawn: SubAgentSpawn = {
      spawnId: "selected-spawn",
      parentSessionId: "side-7",
      childSessionId: "prior-child",
      title: "Selected researcher",
      status: "done",
      entries: [],
      toolCallCount: 0,
    };
    const onCommit = vi.fn();
    const { rerender } = await renderPanelWithRecordedSideChat(apiMock, [spawn], onCommit);
    addTabViaMenu("subagent");
    await within(screen.getByTestId("chat-side-panel-subagent-detail")).findByText("Prior persisted transcript");
    const nextSpawns: SubAgentSpawn[] = [{
      ...spawn,
      childSessionId: "next-child",
      entries: [{ kind: "assistant", text: "Next live tail", streaming: false }],
    }];
    rerender(
      <>
        <HarnessPanel api={apiMock} sessionId="tile-session" targets={[]} files={[]} initialSelectedId={null} subAgentSpawns={nextSpawns} />
        <TranscriptCommitProbe revision={1} onCommit={onCommit} />
      </>,
    );
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit.mock.calls[0]![0]).toContain("Next live tail");
    expect(onCommit.mock.calls[0]![0]).not.toContain("Prior persisted transcript");
    await act(async () => {
      nextReady.resolve(undefined);
      await nextReady.promise;
    });
    const detail = screen.getByTestId("chat-side-panel-subagent-detail");
    expect(detail.textContent).toContain("Next persisted transcript");
    expect(detail.textContent).toContain("Next live tail");
  });

  it("subagent tab: keeps the side chat's agents, and their later frames, after the side-chat tab closes (#2345)", async () => {
    // Closing the tab unmounts the side-chat view, but its loop runs on in
    // main and so do the agents it started. The panel keeps their rows and
    // keeps receiving their frames.
    const spawnHandlers = new Set<(event: AgentSpawnEvent) => void>();
    const base = api();
    const sideChatReady = deferred<void>();
    (base.sideChat!.load as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      await sideChatReady.promise;
      return { ok: true, sessionId: "side-7", messages: [] };
    });
    const apiMock = {
      ...base,
      onAskUserQuestion: () => () => undefined,
      onAgentSpawnEvent: (handler: (event: AgentSpawnEvent) => void) => {
        spawnHandlers.add(handler);
        return () => { spawnHandlers.delete(handler); };
      },
    } as unknown as AveApi;
    const emit = (event: Partial<AgentSpawnEvent>) =>
      act(() => {
        for (const handler of spawnHandlers) handler(event as AgentSpawnEvent);
      });

    renderPanel(
      <HarnessPanel
        api={apiMock}
        sessionId="tile-session"
        targets={[]}
        files={[]}
        initialSelectedId={null}
        sideChatOpenRequest={{ chatGroupId: "main", sessionId: "side-7", nonce: 1 }}
      />,
    );
    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("side-chat")));
    await waitFor(() => expect(base.sideChat!.load).toHaveBeenCalledWith("side-7"));
    // Record the loaded session's ownership before emitting its first spawn.
    await act(async () => {
      sideChatReady.resolve(undefined);
      await sideChatReady.promise;
    });
    await emit({
      type: "start",
      spawnId: "side-spawn-1",
      parentSessionId: "side-7",
      title: "Side researcher",
      childSessionId: "side-child-1",
    });

    const sideChatTab = screen.getByTestId("chat-side-panel-tab-side-chat");
    const closeButton = Array.from(sideChatTab.parentElement!.querySelectorAll("button")).at(-1)!;
    fireEvent.click(closeButton);
    await waitFor(() => expect(screen.queryByTestId("chat-side-panel-side-chat-host")).toBeNull());

    // A frame that lands after the view is gone still has somewhere to go.
    await emit({
      type: "start",
      spawnId: "side-spawn-2",
      parentSessionId: "side-7",
      title: "Side reviewer",
      childSessionId: "side-child-2",
    });

    addTabViaMenu("subagent");
    const rows = screen.getAllByTestId("chat-side-panel-subagent-row");
    expect(rows.map((row) => row.textContent)).toEqual(expect.arrayContaining([
      expect.stringContaining("Side researcher"),
      expect.stringContaining("Side reviewer"),
    ]));
    expect(rows).toHaveLength(2);
  });

  it("subagent tab: unifies a spawn + its resume (shared childSessionId) into one row with a concatenated transcript", () => {
    // An original spawn and its resume are two distinct agent_spawn calls (two
    // spawnIds) but share one childSessionId — the viewer must group them into a
    // SINGLE row whose detail concatenates both segments' transcripts.
    const subAgentSpawns: SubAgentSpawn[] = [
      {
        spawnId: "orig-1",
        title: "Long research",
        status: "done",
        childSessionId: "child-1",
        entries: [{ kind: "assistant", text: "original segment", streaming: false }],
        toolCallCount: 3,
      },
      {
        spawnId: "resume-1",
        title: "(sub-agent)",
        status: "running",
        childSessionId: "child-1",
        entries: [{ kind: "assistant", text: "resumed segment", streaming: false }],
        toolCallCount: 2,
      },
    ];
    renderPanel(
      <HarnessPanel api={api()} sessionId="s" targets={[]} files={[]} initialSelectedId={null} subAgentSpawns={subAgentSpawns} />,
    );
    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("subagent")));
    // Exactly ONE row (the two segments collapsed into one logical agent).
    const rows = screen.getAllByTestId("chat-side-panel-subagent-row");
    expect(rows).toHaveLength(1);
    // The row uses the ORIGINAL's title (one logical agent = one name).
    expect(rows[0]!.textContent).toContain("Long research");
    // The detail transcript concatenates both segments in order.
    const detail = screen.getByTestId("chat-side-panel-subagent-detail");
    expect(detail.textContent).toContain("original segment");
    expect(detail.textContent).toContain("resumed segment");
  });

  it("subagent tab: hydrates a unified resume group by childSessionId only", async () => {
    const apiMock = api();
    // Keep the response pending through the request assertion to exercise the
    // interval between requesting a transcript and committing it to the DOM.
    const transcriptReady = deferred<void>();
    apiMock.chatGetSubAgentTranscript = vi.fn(async () => {
      await transcriptReady.promise;
      return {
        ok: true,
        childSessionId: "child-1",
        messages: [{ index: 0, role: "assistant", content: "hydrated unified transcript" }],
      };
    });
    const subAgentSpawns: SubAgentSpawn[] = [
      {
        spawnId: "live-orig",
        toolUseId: "orig-tool",
        title: "Long research",
        status: "done",
        childSessionId: "child-1",
        entries: [],
        toolCallCount: 1,
      },
      {
        spawnId: "live-resume",
        toolUseId: "resume-tool",
        title: "(sub-agent)",
        status: "done",
        childSessionId: "child-1",
        entries: [],
        toolCallCount: 1,
      },
    ];
    renderPanel(
      <HarnessPanel api={apiMock} sessionId="parent-session-1" targets={[]} files={[]} initialSelectedId={null} subAgentSpawns={subAgentSpawns} />,
    );
    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("subagent")));

    await waitFor(() => expect(apiMock.chatGetSubAgentTranscript).toHaveBeenCalledWith({
      originSessionId: "parent-session-1",
      childSessionId: "child-1",
    }));
    expect(apiMock.chatGetSubAgentTranscript).not.toHaveBeenCalledWith(
      expect.objectContaining({ toolUseId: "resume-tool", spawnId: "live-orig" }),
    );
    transcriptReady.resolve(undefined);
    await waitFor(() => {
      expect(screen.getByTestId("chat-side-panel-subagent-detail").textContent).toContain("hydrated unified transcript");
      expect(apiMock.chatGetSubAgentTranscript).toHaveBeenCalledTimes(1);
    });
  });

  it("subagent tab: keeps hydrated child transcript and live tail for the selected live spawn", async () => {
    const apiMock = api();
    apiMock.chatGetSubAgentTranscript = vi.fn(async () => ({
      ok: true,
      childSessionId: "child-1",
      messages: [{ index: 0, role: "assistant", content: "hydrated original transcript" }],
    }));
    const subAgentSpawns: SubAgentSpawn[] = [
      {
        spawnId: "live-orig",
        toolUseId: "orig-tool",
        title: "Long research",
        status: "done",
        childSessionId: "child-1",
        entries: [],
        toolCallCount: 1,
      },
      {
        spawnId: "live-resume",
        toolUseId: "resume-tool",
        title: "(sub-agent)",
        status: "running",
        childSessionId: "child-1",
        entries: [{ kind: "assistant", text: "live resume tail", streaming: true }],
        toolCallCount: 1,
      },
    ];
    renderPanel(
      <HarnessPanel api={apiMock} sessionId="parent-session-1" targets={[]} files={[]} initialSelectedId={null} subAgentSpawns={subAgentSpawns} />,
    );
    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("subagent")));

    await waitFor(() => expect(apiMock.chatGetSubAgentTranscript).toHaveBeenCalledWith({
      originSessionId: "parent-session-1",
      childSessionId: "child-1",
    }));
    await waitFor(() => {
      const detail = screen.getByTestId("chat-side-panel-subagent-detail");
      expect(detail.textContent).toContain("hydrated original transcript");
      expect(detail.textContent).toContain("live resume tail");
    });
  });

  it.each(["success", "not-found", "reject"] as const)("subagent tab: keeps the selected child's transcript when an earlier %s response arrives late", async (responseMode) => {
    const firstA = deferred<ChildTranscriptResult>();
    const secondA = deferred<ChildTranscriptResult>();
    const pendingB = deferred<ChildTranscriptResult>();
    const responsesA = [firstA, secondA];
    const apiMock = api();
    apiMock.chatGetSubAgentTranscript = vi.fn<NonNullable<AveApi["chatGetSubAgentTranscript"]>>(async ({ childSessionId }) => {
      const response = childSessionId === "child-a" ? responsesA.shift() : pendingB;
      if (!response) throw new Error("Child transcript response was not prepared");
      const result = await response.promise;
      if (response === firstA && responseMode === "reject") throw new Error("Earlier child request failed");
      return result;
    });
    renderPanel(
      <HarnessPanel
        api={apiMock}
        sessionId="parent-session-1"
        targets={[]}
        files={[]}
        initialSelectedId={null}
        subAgentSpawns={[
          { spawnId: "spawn-a", childSessionId: "child-a", title: "Child A", status: "done", entries: [], toolCallCount: 0 },
          { spawnId: "spawn-b", childSessionId: "child-b", title: "Child B", status: "done", entries: [], toolCallCount: 0 },
        ]}
      />,
    );
    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("subagent")));
    await waitFor(() => expect(apiMock.chatGetSubAgentTranscript).toHaveBeenNthCalledWith(1, {
      originSessionId: "parent-session-1", childSessionId: "child-a",
    }));

    fireEvent.click(screen.getByRole("option", { name: /Child B/ }));
    await waitFor(() => expect(apiMock.chatGetSubAgentTranscript).toHaveBeenNthCalledWith(2, {
      originSessionId: "parent-session-1", childSessionId: "child-b",
    }));
    await act(async () => {
      pendingB.resolve({ ok: true, childSessionId: "child-b", messages: [{ index: 0, role: "assistant", content: "Selected child B transcript" }] });
      await pendingB.promise;
    });
    const detail = screen.getByTestId("chat-side-panel-subagent-detail");
    expect(detail.textContent).toContain("Selected child B transcript");

    await act(async () => {
      firstA.resolve(responseMode === "not-found"
        ? { ok: false, error: "not-found" }
        : { ok: true, childSessionId: "child-a", messages: [{ index: 0, role: "assistant", content: "Earlier child A transcript" }] });
      await firstA.promise;
    });
    expect(detail.textContent).toContain("Selected child B transcript");
    expect(detail.textContent).not.toContain("Earlier child A transcript");
    expect(within(detail).queryByRole("alert")).toBeNull();

    fireEvent.click(screen.getByRole("option", { name: /Child A/ }));
    await waitFor(() => expect(apiMock.chatGetSubAgentTranscript).toHaveBeenNthCalledWith(3, {
      originSessionId: "parent-session-1", childSessionId: "child-a",
    }));
    expect(detail.textContent).not.toContain("Selected child B transcript");
    await act(async () => {
      secondA.resolve({ ok: true, childSessionId: "child-a", messages: [{ index: 0, role: "assistant", content: "Fresh child A transcript" }] });
      await secondA.promise;
    });
    expect(detail.textContent).toContain("Fresh child A transcript");
    expect(detail.textContent).not.toContain("Selected child B transcript");
    expect(detail.textContent).not.toContain("Earlier child A transcript");
    expect(apiMock.chatGetSubAgentTranscript).toHaveBeenCalledTimes(3);
  });

  describe.each([
    { locale: "en", loading: "Loading transcript…", failed: "Couldn't load transcript.", summary: "Summary" },
    { locale: "ko", loading: "대화 기록을 불러오는 중…", failed: "대화 기록을 불러오지 못했습니다.", summary: "요약" },
  ] as const)("subagent transcript hydration in $locale", ({ locale, loading, failed, summary }) => {
    let previousLocale = getLocale();
    beforeEach(() => {
      previousLocale = getLocale();
      setLocale(locale);
    });
    afterEach(() => setLocale(previousLocale));

    it("shows loading while the child transcript is pending", () => {
      const pending = deferred<ChildTranscriptResult>();
      const apiMock = api();
      apiMock.chatGetSubAgentTranscript = vi.fn(() => pending.promise);
      const detail = renderChildTranscript(apiMock);

      expect(within(detail).getByRole("status")).toHaveTextContent(loading);
      expect(detail.textContent).not.toContain(summary);
      expect(within(detail).queryByRole("alert")).toBeNull();
    });

    it.each(["not-found", "reject"] as const)("shows a localized transcript failure after %s", async (responseMode) => {
      const pending = deferred<ChildTranscriptResult>();
      const apiMock = api();
      apiMock.chatGetSubAgentTranscript = vi.fn(async () => {
        const response = await pending.promise;
        if (responseMode === "reject") throw new Error("Host-only transport details");
        return response;
      });
      const detail = renderChildTranscript(apiMock);
      await waitFor(() => expect(apiMock.chatGetSubAgentTranscript).toHaveBeenCalledOnce());

      await act(async () => {
        pending.resolve({ ok: false, error: "Host-only transport details" });
        await pending.promise;
      });
      expect(within(detail).getByRole("alert")).toHaveTextContent(failed);
      expect(within(detail).queryByRole("status")).toBeNull();
      expect(detail.textContent).not.toContain(summary);
      expect(detail.textContent).not.toContain("Host-only transport details");
    });

    it("keeps the summary for a successfully loaded empty transcript", async () => {
      const pending = deferred<ChildTranscriptResult>();
      const apiMock = api();
      apiMock.chatGetSubAgentTranscript = vi.fn(() => pending.promise);
      const detail = renderChildTranscript(apiMock);
      await waitFor(() => expect(apiMock.chatGetSubAgentTranscript).toHaveBeenCalledOnce());

      await act(async () => {
        pending.resolve({ ok: true, childSessionId: "child-1", messages: [] });
        await pending.promise;
      });
      expect(detail).toHaveTextContent(summary);
      expect(within(detail).queryByRole("status")).toBeNull();
      expect(within(detail).queryByRole("alert")).toBeNull();
    });
  });

  describe("subagent transcript hydration across spawn status", () => {
    it.each([
      ["running", "not-found"], ["running", "reject"],
      ["waiting", "not-found"], ["waiting", "reject"],
    ] as const)("keeps the %s label after a %s transcript read", async (status, responseMode) => {
      const pending = deferred<ChildTranscriptResult>();
      const apiMock = api();
      apiMock.chatGetSubAgentTranscript = vi.fn(async () => {
        const response = await pending.promise;
        if (responseMode === "reject") throw new Error("Transcript is not persisted yet");
        return response;
      });
      const detail = renderChildTranscript(apiMock, { status });
      await waitFor(() => expect(apiMock.chatGetSubAgentTranscript).toHaveBeenCalledOnce());
      await act(async () => {
        pending.resolve({ ok: false, error: "sub-agent-reference-not-found" });
        await pending.promise;
      });
      expect(within(detail).queryByRole("alert")).toBeNull();
      expect(detail).toHaveTextContent(t(status === "running" ? "subAgentCard.statusRunning" : "subAgentCard.statusWaiting"));
    });

    it.each(["not-found", "reject"] as const)("keeps running live entries after a %s transcript read", async (responseMode) => {
      const pending = deferred<ChildTranscriptResult>();
      const apiMock = api();
      apiMock.chatGetSubAgentTranscript = vi.fn(async () => {
        const response = await pending.promise;
        if (responseMode === "reject") throw new Error("Transcript is not persisted yet");
        return response;
      });
      const detail = renderChildTranscript(apiMock, {
        status: "running", entries: [{ kind: "assistant", text: "Live child transcript", streaming: true }],
      });
      await waitFor(() => expect(apiMock.chatGetSubAgentTranscript).toHaveBeenCalledOnce());
      await act(async () => {
        pending.resolve({ ok: false, error: "sub-agent-transcript-not-found" });
        await pending.promise;
      });
      expect(detail).toHaveTextContent("Live child transcript");
      expect(within(detail).queryByRole("alert")).toBeNull();
    });

    it.each([
      ["running", "done"], ["running", "error"], ["running", "interrupted"],
      ["waiting", "done"], ["waiting", "error"], ["waiting", "interrupted"],
    ] as const)("re-requests an earlier miss when %s becomes %s", async (initialStatus, terminalStatus) => {
      const initial = deferred<ChildTranscriptResult>();
      const terminal = deferred<ChildTranscriptResult>();
      const apiMock = api();
      apiMock.chatGetSubAgentTranscript = vi.fn<NonNullable<AveApi["chatGetSubAgentTranscript"]>>()
        .mockReturnValueOnce(initial.promise).mockReturnValueOnce(terminal.promise);
      const panel = (status: SubAgentSpawn["status"]) => (
        <HarnessPanel api={apiMock} sessionId="parent-session-1" targets={[]} files={[]} initialSelectedId={null}
          subAgentSpawns={[{ spawnId: "child-spawn", childSessionId: "child-1", title: "Child transcript", status, entries: [], toolCallCount: 0 }]} />
      );
      const view = renderPanel(panel(initialStatus));
      fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("subagent")));
      await waitFor(() => expect(apiMock.chatGetSubAgentTranscript).toHaveBeenCalledOnce());
      await act(async () => {
        initial.resolve({ ok: false, error: "sub-agent-transcript-not-found" });
        await initial.promise;
      });
      view.rerender(panel(terminalStatus));
      await waitFor(() => expect(apiMock.chatGetSubAgentTranscript).toHaveBeenCalledTimes(2));
      await act(async () => {
        terminal.resolve({ ok: true, childSessionId: "child-1", messages: [{ index: 0, role: "assistant", content: "Terminal persisted child history" }] });
        await terminal.promise;
      });
      const detail = screen.getByTestId("chat-side-panel-subagent-detail");
      expect(detail).toHaveTextContent("Terminal persisted child history");
      expect(within(detail).queryByRole("alert")).toBeNull();
      expect(apiMock.chatGetSubAgentTranscript).toHaveBeenNthCalledWith(2, {
        originSessionId: "parent-session-1", childSessionId: "child-1",
      });
    });

    it.each([
      ["done", "not-found"], ["done", "reject"],
      ["error", "not-found"], ["error", "reject"],
      ["interrupted", "not-found"], ["interrupted", "reject"],
    ] as const)("keeps the failure alert for %s after %s", async (status, responseMode) => {
      const pending = deferred<ChildTranscriptResult>();
      const apiMock = api();
      apiMock.chatGetSubAgentTranscript = vi.fn(async () => {
        const response = await pending.promise;
        if (responseMode === "reject") throw new Error("Transcript read failed");
        return response;
      });
      const detail = renderChildTranscript(apiMock, { status });
      await waitFor(() => expect(apiMock.chatGetSubAgentTranscript).toHaveBeenCalledOnce());
      await act(async () => {
        pending.resolve({ ok: false, error: "sub-agent-transcript-not-found" });
        await pending.promise;
      });
      expect(within(detail).getByRole("alert")).toHaveTextContent(t("subAgentCard.transcriptLoadFailed"));
    });

    it.each(["not-found", "reject"] as const)("ignores a late running %s after terminal hydration succeeds", async (responseMode) => {
      const initial = deferred<ChildTranscriptResult>();
      const terminal = deferred<ChildTranscriptResult>();
      const apiMock = api();
      apiMock.chatGetSubAgentTranscript = vi.fn<NonNullable<AveApi["chatGetSubAgentTranscript"]>>()
        .mockImplementationOnce(async () => {
          const response = await initial.promise;
          if (responseMode === "reject") throw new Error("Earlier transcript read failed");
          return response;
        }).mockReturnValueOnce(terminal.promise);
      const panel = (status: SubAgentSpawn["status"]) => (
        <HarnessPanel api={apiMock} sessionId="parent-session-1" targets={[]} files={[]} initialSelectedId={null}
          subAgentSpawns={[{ spawnId: "child-spawn", childSessionId: "child-1", title: "Child transcript", status, entries: [], toolCallCount: 0 }]} />
      );
      const view = renderPanel(panel("running"));
      fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("subagent")));
      await waitFor(() => expect(apiMock.chatGetSubAgentTranscript).toHaveBeenCalledOnce());
      view.rerender(panel("done"));
      await waitFor(() => expect(apiMock.chatGetSubAgentTranscript).toHaveBeenCalledTimes(2));
      await act(async () => {
        terminal.resolve({ ok: true, childSessionId: "child-1", messages: [{ index: 0, role: "assistant", content: "Fresh terminal history" }] });
        await terminal.promise;
      });
      const detail = screen.getByTestId("chat-side-panel-subagent-detail");
      expect(detail).toHaveTextContent("Fresh terminal history");
      await act(async () => {
        initial.resolve({ ok: false, error: "sub-agent-transcript-not-found" });
        await initial.promise;
      });
      expect(detail).toHaveTextContent("Fresh terminal history");
      expect(within(detail).queryByRole("alert")).toBeNull();
    });
  });

  it("subagent tab: empty state when the chat has no spawns", () => {
    renderPanel(
      <HarnessPanel api={api()} sessionId="s" targets={[]} files={[]} initialSelectedId={null} subAgentSpawns={[]} />,
    );
    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("subagent")));
    expect(screen.getByTestId("chat-side-panel-subagent-empty")).toBeTruthy();
  });

  it("side-chat IS a launcher item and opens the SideChatView", () => {
    renderPanel(
      <HarnessPanel api={api()} sessionId="s" targets={[]} files={[]} initialSelectedId={null} />,
    );
    expect(screen.getByTestId(chatSidePanelLauncherTestId("side-chat"))).toBeTruthy();
    // Present in the tab-bar "+" menu once a tab exists.
    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("file-browser")));
    openLauncherMenu();
    expect(screen.getByTestId(chatSidePanelLauncherTestId("menu-side-chat"))).toBeTruthy();
    expect(screen.getByTestId(chatSidePanelLauncherTestId("menu-subagent"))).toBeTruthy();
  });

  it("opening the side-chat tab renders the SideChatView (not a placeholder)", () => {
    renderPanel(
      <HarnessPanel api={api()} sessionId="s" targets={[]} files={[]} initialSelectedId={null} />,
    );
    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("side-chat")));
    expect(screen.getByTestId("side-chat-view")).toBeTruthy();
  });
  it("unifies directory and session metadata under filters without source switches", async () => {
    stubRichWorkspace();
    const files: WorkspaceFileItem[] = [
      { id: "edit", path: "/ws/alpha/a1.md", label: "a1.md", detail: "alpha/a1.md", sourceLabel: "edit_file", operation: "modify", canOpenExternal: false },
      { id: "outside", path: "/elsewhere/artifact.md", label: "artifact.md", detail: "artifact.md", sourceLabel: "attachment", operation: "attachment", canOpenExternal: false },
    ];
    renderPanel(<FileBrowserWorkspace api={api()} sessionId="s" files={files} targetById={new Map()} selectedId={null} onSelect={vi.fn()} />);
    expect(screen.queryByTestId("chat-side-panel-file-source-segment")).toBeNull();
    await screen.findByTestId("chat-side-panel-file-filter-changed");
    expect(screen.getByTestId("chat-side-panel-file-filter-session")).toHaveTextContent("1");
    fireEvent.click(screen.getByTestId("chat-side-panel-file-filter-changed"));
    const tree = screen.getByRole("tree");
    expect(tree).toHaveTextContent("alpha");
    expect(tree).not.toHaveTextContent("readme.md");
    fireEvent.click(within(tree).getByText("alpha"));
    expect(await within(tree).findByText("a1.md")).toBeTruthy();
    expect(within(tree).queryByTestId("chat-side-panel-file-session-badge")).toBeNull();
    fireEvent.click(screen.getByTestId("chat-side-panel-file-filter-session"));
    expect(tree).toHaveTextContent("프로젝트 밖");
    expect(tree).toHaveTextContent("artifact.md");
  });

  it("reveals a requested file through ancestors and clears search with the changed filter", async () => {
    stubRichWorkspace();
    const files: WorkspaceFileItem[] = [{ id: "edit", path: "/ws/alpha/a1.md", label: "a1.md", detail: "alpha/a1.md", sourceLabel: "edit_file", operation: "modify", canOpenExternal: false }];
    const props = { api: api(), sessionId: "s", files, targetById: new Map<string, ChatPreviewTarget>(), selectedId: null, onSelect: vi.fn() };
    const result = renderPanel(<FileBrowserWorkspace {...props} />);
    const search = await screen.findByRole("textbox");
    fireEvent.change(search, { target: { value: "missing" } });
    result.rerender(<FileBrowserWorkspace {...props} revealRequest={{ token: 1, path: "alpha/a1.md" }} />);
    await waitFor(() => expect(search).toHaveValue(""));
    expect(screen.getByTestId("chat-side-panel-file-filter-changed")).toHaveAttribute("aria-pressed", "true");
    const selected = await within(screen.getByRole("tree")).findByText("a1.md");
    expect(selected.closest('[role="treeitem"]')).toHaveAttribute("aria-selected", "true");
    fireEvent.change(search, { target: { value: "follow-up" } });
    result.rerender(<FileBrowserWorkspace {...props} files={[...files]} revealRequest={{ token: 1, path: "alpha/a1.md" }} />);
    expect(search).toHaveValue("follow-up");
    result.rerender(<FileBrowserWorkspace {...props} revealRequest={{ token: 2, path: "alpha/a1.md" }} />);
    await waitFor(() => expect(search).toHaveValue(""));
  });

  it("uses a persisted horizontal divider in wide Files and arrow keys resize it", async () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(760);
    stubRichWorkspace();
    const bridge = api();
    renderPanel(<FileBrowserWorkspace api={bridge} sessionId="s" files={[]} targetById={new Map()} selectedId={null} onSelect={vi.fn()} />);
    await waitFor(() => expect(screen.getByTestId("chat-side-panel-file-browser")).toHaveAttribute("data-file-layout", "columns"));
    const divider = screen.getByRole("separator");
    expect(divider).toHaveAttribute("aria-orientation", "vertical");
    expect(divider).toHaveAttribute("aria-valuenow", "300");
    fireEvent.keyDown(divider, { key: "ArrowRight" });
    expect(bridge.updateSettings).toHaveBeenCalledWith({ system: { sidePanelFileTreeWidth: 316 } });
    expect(divider).toHaveAttribute("aria-valuenow", "316");
    expect(screen.queryByTestId("chat-side-panel-file-split-layout")).toBeNull();
  });

  it("narrow selection opens detail and Back returns focus to the selected tree row", async () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(360);
    stubRichWorkspace();
    renderPanel(<FileBrowserWorkspace api={api()} sessionId="s" files={[]} targetById={new Map()} selectedId={null} onSelect={vi.fn()} />);
    const row = (await within(screen.getByRole("tree")).findByText("readme.md")).closest<HTMLElement>('[role="treeitem"]')!;
    act(() => row.focus());
    fireEvent.keyDown(row, { key: "Enter" });
    expect(screen.getByTestId("chat-side-panel-file-tree")).toHaveClass("hidden");
    expect(screen.getByTestId("chat-side-panel-file-detail")).not.toHaveClass("hidden");
    fireEvent.click(screen.getByTestId("chat-side-panel-file-back"));
    expect(screen.getByTestId("chat-side-panel-file-tree")).not.toHaveClass("hidden");
    await waitFor(() => expect(row).toHaveFocus());
    expect(row).toHaveAttribute("aria-selected", "true");
  });

  it("reveals a changed file under a nondefault project with Windows path separators", async () => {
    const current = window.ave;
    vi.stubGlobal("ave", { ...current, workspace: { ...current.workspace,
      listRoots: vi.fn(async () => ({ ok: true, roots: [
        { path: "C:\\default", isDefault: true }, { path: "C:\\project", isDefault: false },
      ] })),
      listDir: vi.fn(async (path: string) => ({ ok: true, path, entries: [], truncated: false })),
    } });
    const files: WorkspaceFileItem[] = [{ id: "win", path: "C:\\project\\src\\a.ts", label: "a.ts", detail: "src/a.ts", sourceLabel: "edit_file", operation: "modify", canOpenExternal: false }];
    renderPanel(<FileBrowserWorkspace api={api()} sessionId="win" files={files} targetById={new Map()} selectedId={null} onSelect={vi.fn()} revealRequest={{ token: 1, path: "C:/project/src/a.ts" }} />);
    await waitFor(() => expect(screen.getByTestId("chat-side-panel-root-select")).toHaveValue("C:\\project"));
    const selected = await within(screen.getByRole("tree")).findByText("a.ts");
    expect(selected.closest('[role="treeitem"]')).toHaveAttribute("aria-selected", "true");
  });

  it.each([false, true])("resolves a relative session preview against its nondefault conversation root, ranged: %s", async (ranged) => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(760);
    stubRichWorkspace({ listRoots: vi.fn(async () => ({ ok: true, roots: [{ path: "/projects/default", isDefault: true }, { path: "/projects/A", isDefault: false }] })) });
    const readFile = vi.fn(async () => ({ ok: true as const, path: "/projects/A/src/a.ts", content: "Project A source", truncated: false }));
    vi.stubGlobal("ave", { ...window.ave, preview: { ...makeMockAveNamespace().ns.preview, ...window.ave.preview, readFile } });
    const target: ChatPreviewTarget = { id: "project-a-source", kind: "file", title: "a.ts", sourceLabel: "read_file", createdOrder: 1,
      path: "src/a.ts", canOpenExternal: false, ...(ranged ? { startLine: 3, endLine: 5 } : {}) };
    const files: WorkspaceFileItem[] = [{ id: "project-a-file", path: target.path, label: target.title, detail: target.path,
      sourceLabel: "read_file", operation: "read", canOpenExternal: false, previewTargetId: target.id }];
    const changes = deriveWorkspaceChanges({ files, targets: [target], workspaceRoot: "/projects/A", review: null });
    renderPanel(<FileBrowserWorkspace api={api()} sessionId="project-a" files={files} changes={changes} targetById={new Map([[target.id, target]])} selectedId={target.id} onSelect={vi.fn()} />);
    await waitFor(() => expect(readFile).toHaveBeenCalledWith("/projects/A/src/a.ts", ranged ? { offset: 2, limit: 3, workspaceRoot: "/projects/A" } : { workspaceRoot: "/projects/A", sessionId: "project-a" }));
    expect(readFile).toHaveBeenCalledTimes(1);
  });

  it("preserves an indexed session file inline preview when its source is unavailable locally", async () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(760);
    stubRichWorkspace();
    const readFile = vi.fn(async () => ({ ok: false as const, error: "read-failed" as const }));
    vi.stubGlobal("ave", { ...window.ave, preview: { ...makeMockAveNamespace().ns.preview, ...window.ave.preview, readFile } });
    const target: ChatPreviewTarget = { id: "indexed-result", kind: "file", title: "search.md", sourceLabel: "search", createdOrder: 1,
      path: "/unavailable/docs/search.md", inlineText: "Supplied indexed document preview", canOpenExternal: false };
    const files: WorkspaceFileItem[] = [{ id: "indexed-file", path: target.path, label: target.title, detail: target.path,
      sourceLabel: "search", operation: "read", canOpenExternal: false, previewTargetId: target.id }];
    renderPanel(<FileBrowserWorkspace api={api()} sessionId="indexed" files={files} targetById={new Map([[target.id, target]])} selectedId={target.id} onSelect={vi.fn()} />);
    expect(await screen.findByText("Supplied indexed document preview")).toBeVisible();
    expect(readFile).not.toHaveBeenCalled();
  });

  it("prefers latest-turn diff detail over a matching inline session preview", async () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(760);
    stubRichWorkspace();
    const target: ChatPreviewTarget = { id: "indexed-changed", kind: "file", title: "readme.md", sourceLabel: "search", createdOrder: 1,
      path: "/ws/readme.md", inlineText: "Older indexed preview", canOpenExternal: false };
    const files: WorkspaceFileItem[] = [{ id: "changed-file", path: target.path, label: target.title, detail: target.path,
      sourceLabel: "search", operation: "read", canOpenExternal: false, previewTargetId: target.id }];
    const changes = deriveWorkspaceChanges({ files, targets: [target], workspaceRoot: "/ws", review: { sessionId: "indexed", turnId: "latest",
      files: [{ path: "readme.md", bytes: 6, lineCount: 1, added: 1, removed: 1, operation: "modify", countsKnown: true, referenceable: true,
        hunks: [{ id: "latest-hunk", oldText: "before\n", newText: "after\n", oldStartLine: 1, newStartLine: 1, startLine: 1, endLine: 1 }] }] } });
    renderPanel(<FileBrowserWorkspace api={api()} sessionId="indexed" files={files} changes={changes} targetById={new Map([[target.id, target]])} selectedId={target.id} onSelect={vi.fn()} />);
    expect(await screen.findByTestId("turn-change-detail")).toHaveTextContent("after");
    expect(screen.queryByText("Older indexed preview")).toBeNull();
  });

  it("previews the current image when a recorded changed file no longer has readable diff hunks", async () => {
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(760);
    const readFile = vi.fn(async () => ({ ok: true, path: "/ws/source.png", image: { dataUrl: "data:image/png;base64,aW1hZ2U=", mimeType: "image/png" }, truncated: false }));
    vi.stubGlobal("ave", { ...window.ave, preview: { ...makeMockAveNamespace().ns.preview, ...window.ave.preview, readFile } });
    const changes = deriveWorkspaceChanges({ files: [], targets: [], workspaceRoot: "/ws", review: {
      sessionId: "image-session", turnId: "latest", files: [{ path: "source.png", bytes: 8, lineCount: 0,
        added: 8, removed: 2, operation: "modify", countsKnown: true, referenceable: false, hunks: [] }],
    } });
    renderPanel(<FileBrowserWorkspace api={api()} sessionId="image-session" files={[]} changes={changes} targetById={new Map()} selectedId={null} onSelect={vi.fn()} revealRequest={{ token: 1, path: "/ws/source.png" }} />);
    expect(await screen.findByTestId("file-preview-image")).toHaveAttribute("src", "data:image/png;base64,aW1hZ2U=");
    expect(screen.queryByTestId("turn-change-detail")).toBeNull();
    expect(screen.getByTestId("chat-side-panel-file-change-counts")).toHaveTextContent("+8 −2");
    expect(readFile).toHaveBeenCalledWith("/ws/source.png", { workspaceRoot: "/ws", sessionId: "image-session" });
  });

});

describe("ChatSidePanel inside a chat group", () => {
  it("is a self-contained card: its tabs and its own close stay on it, not on the group header", () => {
    const onClose = vi.fn();
    renderPanel(
      <PaneFrame title="a" asideSlot bodyInset="none">
        <HarnessPanel api={api()} sessionId="session-1" targets={[]} files={[]} initialSelectedId={null} onClose={onClose} />
      </PaneFrame>,
    );
    const panel = screen.getByTestId(TEST_IDS.chatSidePanel);
    expect(panel.className).toContain("rounded-2xl");
    expect(within(panel).getByTestId("chat-side-panel-tab-strip")).toBeTruthy();
    expect(
      within(screen.getByTestId("pane-header")).queryByTestId("chat-side-panel-tab-strip"),
    ).toBeNull();
    // The card stands beside the group header (over it when floating), so
    // the way out is the card's own close — the header's × closes the tile.
    fireEvent.click(within(panel).getByTestId("chat-side-panel-close"));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows the conversation's tool activity on the empty launcher, and nothing when there is none", () => {
    const onOpenActivityItem = vi.fn();
    const activity = {
      ...emptyToolActivity(),
      toolCallCount: 3,
      fetchedPageCount: 1,
      fetchedPages: [{ id: "url:1", label: "example.com", detail: "https://example.com/a", target: "https://example.com/a", status: "done" as const }],
    };
    const { unmount } = renderPanel(
      <HarnessPanel
        api={api()}
        sessionId="session-1"
        targets={[]}
        files={[]}
        initialSelectedId={null}
        activity={activity}
        onOpenActivityItem={onOpenActivityItem}
      />,
    );
    const launcher = screen.getByTestId("chat-side-panel-launcher");
    expect(within(launcher).getByTestId("chat-side-panel-launcher-tool-activity")).toBeTruthy();
    fireEvent.click(within(launcher).getByTestId("tool-activity-item-url:1"));
    expect(onOpenActivityItem).toHaveBeenCalledWith("https://example.com/a", true);
    unmount();

    renderPanel(
      <HarnessPanel api={api()} sessionId="session-1" targets={[]} files={[]} initialSelectedId={null} activity={emptyToolActivity()} />,
    );
    expect(screen.queryByTestId("chat-side-panel-launcher-tool-activity")).toBeNull();
  });

  it("the launcher's compact report opens the activity tab, which lists every plugin and tool call", () => {
    const activity = {
      ...emptyToolActivity(),
      toolCallCount: 2,
      pluginCallCount: 1,
      pluginCalls: [{ id: "plugin:p1", label: "meeting_open", detail: "meeting", status: "done" as const }],
      toolCalls: [
        { id: "call:t2", name: "read_file", status: "running" as const, source: "builtin", startedAt: Date.UTC(2026, 0, 1, 9, 30, 15), argument: "/ws/report.md" },
        { id: "call:p1", name: "meeting_open", status: "done" as const, source: "plugin", pluginId: "meeting", durationMs: 1400 },
      ],
    };
    renderPanel(
      <HarnessPanel api={api()} sessionId="session-1" targets={[]} files={[]} initialSelectedId={null} activity={activity} />,
    );
    fireEvent.click(screen.getByTestId("tool-activity-open-tab"));
    expect(screen.getByTestId("chat-side-panel-tab-activity")).toBeTruthy();
    const workspace = screen.getByTestId("chat-side-panel-activity-workspace");
    expect(within(workspace).getByTestId("chat-side-panel-activity-plugins")).toHaveTextContent("meeting_open");
    const toolRows = within(workspace).getAllByTestId("chat-side-panel-activity-tool-row");
    expect(toolRows).toHaveLength(2);
    // A live call shows its clock; a persisted one (no clock) shows its duration and source.
    expect(toolRows[0]).toHaveTextContent("read_file");
    expect(toolRows[0]).toHaveTextContent("/ws/report.md");
    expect(toolRows[0]).toHaveTextContent("실행 중");
    expect(toolRows[1]).toHaveTextContent("plugin:meeting");
    expect(toolRows[1]).toHaveTextContent("1.4s");
  });

  it("file tab integrates created, modified, deleted and moved state in the changed tree filter", async () => {
    const files: WorkspaceFileItem[] = [
      { id: "tool:/ws/read.md", path: "/ws/read.md", label: "read.md", detail: "/ws/read.md", sourceLabel: "read_file", operation: "read", canOpenExternal: false },
      { id: "tool:/ws/old.md", path: "/ws/old.md", label: "old.md", detail: "/ws/old.md", sourceLabel: "delete_file", operation: "delete", canOpenExternal: false },
      { id: "tool:/ws/edit.md", path: "/ws/edit.md", label: "edit.md", detail: "/ws/edit.md", sourceLabel: "edit_file", operation: "modify", canOpenExternal: false },
      { id: "tool:/ws/moved.md", path: "/ws/moved.md", label: "moved.md", detail: "/ws/moved.md", sourceLabel: "move_file", operation: "move", canOpenExternal: false },
      { id: "tool:/ws/new.md", path: "/ws/new.md", label: "new.md", detail: "/ws/new.md", sourceLabel: "apply_patch", operation: "create", canOpenExternal: false },
    ];
    renderPanel(
      <HarnessPanel api={api()} sessionId="s" targets={[]} files={files} initialSelectedId={null} />,
    );
    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("file-browser")));
    const changed = screen.getByTestId("chat-side-panel-file-filter-changed");
    expect(changed).toHaveTextContent("4");
    fireEvent.click(changed);
    await within(screen.getByRole("tree")).findByText("old.md");
    const rows = within(screen.getByRole("tree")).getAllByRole("treeitem");
    expect(rows.map((row) => row.textContent)).toEqual([
      expect.stringContaining("edit.md"), expect.stringContaining("moved.md"), expect.stringContaining("new.md"), expect.stringContaining("old.md"),
    ]);
    expect(screen.getAllByTestId("chat-side-panel-file-change-operation").map((badge) => badge.title)).toEqual(["수정", "이동", "생성", "삭제"]);
    expect(within(screen.getByRole("tree")).getByText("old.md")).toHaveClass("line-through");
    expect(screen.getByRole("tree")).not.toHaveTextContent("read.md");
  });

  it.each([
    ["running", "실행 중"],
    ["error", "오류"],
    ["cancelled", "중단됨"],
    ["done", "생성"],
  ] as const)("shows transfer state %s in the unified tree and its filters", async (status, label) => {
    const files: WorkspaceFileItem[] = ["copy_path", "extract_archive"].map((name) => ({
      id: `tool:/ws/${name}-destination`,
      path: `/ws/${name}-destination`,
      label: `${name}-destination`,
      detail: `/ws/${name}-destination`,
      sourceLabel: name,
      operation: "create",
      status,
      canOpenExternal: false,
    }));
    renderPanel(<HarnessPanel api={api()} sessionId="s" targets={[]} files={files} initialSelectedId={null} />);
    fireEvent.click(screen.getByTestId(chatSidePanelLauncherTestId("file-browser")));
    fireEvent.click(screen.getByTestId("chat-side-panel-file-filter-all"));
    await within(screen.getByRole("tree")).findByText("copy_path-destination");
    const statusElements = () => screen.getAllByTestId(status === "done" ? "chat-side-panel-file-change-operation" : "chat-side-panel-file-state");
    expect(statusElements().map((badge) => status === "done" ? badge.title : badge.textContent)).toEqual([label, label]);
    fireEvent.click(screen.getByTestId("chat-side-panel-file-filter-changed"));
    expect(statusElements().map((badge) => status === "done" ? badge.title : badge.textContent)).toEqual([label, label]);
  });
});
