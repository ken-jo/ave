// @vitest-environment jsdom
import { triggerIntersection } from "../../../../../test/renderer/setup.js";
import { describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { TooltipProvider } from "../../../../components/ui/tooltip.js";
import { Sidebar } from "../Sidebar.js";
import { CoveredConversationApprovalDock } from "../permissions/ApprovalDock.js";
import { I18nProvider } from "../../../../i18n/react.js";
import { getLocale, setLocale as setRuntimeLocale } from "../../../../i18n/runtime.js";
import { SUGGESTIONS_SESSION_ID } from "../../../../shared/suggestions-session.js";
import type { SessionSummary } from "../../hooks/use-sessions.js";
import { sessionRow } from "../../../../../test/renderer/mock-ave-api.js";
import type { ProjectIdentity } from "../../../../shared/project-identity.js";
import type { BrowserTabControlState, SessionTabBindingsState } from "../../../../shared/browser-surface.js";
import type { MainSurface } from "../../preview/main-surfaces.js";
import type { AveApi } from "../../types.js";
import { BROWSER_FAVICON_DATA_URL, browserControlFixture } from "../../../../__tests__/support/browser-control-fixture.js";
import { registerBrowserTabHost } from "../../preview/agent-browser-bridge.js";
import { forgetWebSurfaceLocation, noteWebSurfaceFavicon, noteWebSurfaceLocation } from "../../preview/web-surfaces.js";
import { emitMainLayoutChange } from "../../preview/main-layout-restore.js";
import { registerSideTabsSink } from "../../preview/surface-moves.js";
import type {
  NativeContextMenuAction,
  NativeContextMenuPayload,
} from "../../../../shared/native-context-menu.js";

it("names a covered conversation's approval exactly as its untitled sidebar row", () => {
  const title = "그래 두개 진행해보자";
  const { getByTestId, restore } = renderSidebar({
    sessions: [sessionRow({ id: "untitled-conversation", title, modifiedAt: "2026-01-01T00:00:00Z" })],
  });
  try {
    const sidebarTitle = getByTestId("sidebar-session-untitled-conversation").textContent;
    const approval = render(
      <CoveredConversationApprovalDock
        conversation={{ sessionId: "untitled-conversation", messages: [{ role: "user", content: title }] }}
        queue={[{ id: "write-request", category: "tool", toolName: "write_file", toolCategory: "write",
          args: { path: "/workspace/views.c4" }, reason: "Internal reason", createdAt: Date.now(), requireExplicit: false }]}
        onDecide={vi.fn()} onOpenConversation={vi.fn()}
      />,
    );
    expect(approval.getByTestId("approval-conversation").textContent).toContain(sidebarTitle);
    expect(sidebarTitle).toBe(title);
    expect(approval.getByTestId("approval-conversation").textContent).not.toContain("새 대화");
  } finally {
    cleanup();
    restore();
  }
});

function renderSidebar(
  overrides: Partial<Parameters<typeof Sidebar>[0]> = {},
  options: { locale?: string; browserTabs?: AveApi["browserTabs"] } = {},
) {
  const onLoadSession = vi.fn();
  const onNewChatForProject = vi.fn();
  // EVERY listener, not the last one: the preload's own registration is
  // `ipcRenderer.on`, and the sidebar now has two subscribers of its own — the
  // session/project rows and the view rows. Keeping one would deliver the
  // action to whichever mounted last and silently drop the other's menus.
  const nativeContextActionHandlers = new Set<(action: NativeContextMenuAction) => void>();
  const showNativeContextMenu = vi.fn(async (_payload: NativeContextMenuPayload) => ({
    ok: true as const,
  }));
  const removeRoot = vi.fn(async (root: string) => ({
    ok: true as const, removed: root, roots: [],
  }));
  const ADDED_ROOT = "C:\\Users\\example\\workspace\\ave-project\\gamma";
  const pickRoot = vi.fn(async (_options?: { ackToken?: string }) => ({
    ok: true as const,
    roots: [{ path: ADDED_ROOT, isDefault: false }],
    added: ADDED_ROOT,
  } as {
    ok: true;
    roots?: { path: string; isDefault: boolean }[];
    added?: string;
    requiresAcknowledgement?: boolean;
    pendingPath?: string;
    ackToken?: string;
    warnings?: string[];
  }));
  const listRoots = vi.fn(async () => ({
    ok: true as const,
    defaultRoot: "C:\\Users\\example\\workspace\\ave-project\\ave",
    roots: [
      { path: "C:\\Users\\example\\workspace\\ave-project\\ave", isDefault: true },
      { path: "C:\\Users\\example\\workspace\\ave-project\\other-app", isDefault: false },
    ],
  }));
  const sessions: SessionSummary[] = overrides.sessions ?? [
    sessionRow({ id: "sess-1", title: "전체 동기화로 상태 파악", modifiedAt: new Date().toISOString() }),
    sessionRow({
      id: "sess-2",
      title: "사이드 패널 개선",
      modifiedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    }),
    sessionRow({
      id: "sess-other",
      title: "다른 프로젝트 대화",
      modifiedAt: new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
      projectRoot: "C:\\Users\\example\\workspace\\ave-project\\other-app",
      projectName: "other-app",
    }),
  ];

  const props: Parameters<typeof Sidebar>[0] = {
    activeView: "home",
    onSelect: vi.fn(),
    pluginViews: [],
    hasApiKey: true,
    onOpenSettings: vi.fn(),
    onNewChat: vi.fn(),
    collapsed: false,
    onToggleCollapse: vi.fn(),
    onOpenUnifiedSearch: vi.fn(),
    viewNav: {
      segments: [],
      canGoBack: false,
      canGoForward: false,
      onBack: vi.fn(),
      onForward: vi.fn(),
      onSelectSegment: vi.fn(),
    },
    sessions,
    projects: overrides.projects ?? [
      {
        projectRoot: "C:\\Users\\example\\workspace\\ave-project\\ave",
        projectName: "ave",
        isDefault: true,
      },
      {
        projectRoot: "C:\\Users\\example\\workspace\\ave-project\\other-app",
        projectName: "other-app",
      },
    ],
    currentSessionId: "sess-1",
    onLoadSession,
    onNewChatForProject,
    ...(options.browserTabs ? { browserTabs: options.browserTabs } : {}),
    ...overrides,
  };

  const previous = (window as unknown as { ave?: unknown }).ave;
  (window as unknown as { ave?: unknown }).ave = {
    ...(previous && typeof previous === "object" ? previous : {}),
    ui: {
      showNativeContextMenu,
      onNativeContextMenuAction: (handler: (action: NativeContextMenuAction) => void) => {
        nativeContextActionHandlers.add(handler);
        return () => {
          nativeContextActionHandlers.delete(handler);
        };
      },
    },
    workspace: {
      removeRoot,
      listRoots,
      pickRoot,
    },
  };

  const tree = (locale: string | undefined) => {
    const sidebar = (
      <TooltipProvider>
        <Sidebar {...props} />
      </TooltipProvider>
    );
    return locale === undefined
      ? sidebar
      : <I18nProvider locale={locale} setLocale={() => {}}>{sidebar}</I18nProvider>;
  };
  const result = render(tree(options.locale));

  return {
    ...result,
    onLoadSession,
    onNewChatForProject,
    showNativeContextMenu,
    removeRoot,
    listRoots,
    pickRoot,
    addedRoot: ADDED_ROOT,
    switchLocale: (locale: string) => result.rerender(tree(locale)),
    rerenderSidebar: (updates: Partial<Parameters<typeof Sidebar>[0]>) => {
      Object.assign(props, updates);
      result.rerender(tree(options.locale));
    },
    emitNativeContextCommand: (command: NativeContextMenuAction["command"]) => {
      const payload = showNativeContextMenu.mock.calls.at(-1)?.[0];
      if (!payload) throw new Error("native context menu was not requested");
      // The request id is what routes it: only the hook that opened this menu holds a pending entry for that id, so the others
      // ignore it.
      for (const handler of nativeContextActionHandlers) {
        handler({ requestId: payload.requestId, command });
      }
    },
    restore: () => {
      if (previous === undefined) {
        delete (window as unknown as { ave?: unknown }).ave;
      } else {
        (window as unknown as { ave?: unknown }).ave = previous;
      }
    },
  };
}

describe("Sidebar plugin view labels follow the UI language", () => {
  const meeting = {
    pluginId: "meeting",
    extension: {
      id: "meeting-control",
      slot: "sidebar" as const,
      kind: "embedded-module" as const,
      displayName: "미팅",
      title: "회의 기록",
      entry: "dist/ui.js",
      exportName: "PluginUi",
      locales: { en: { displayName: "Meeting" }, ko: { displayName: "미팅" } },
    },
  };

  it("names the extension in the active language and re-renders on a switch", async () => {
    // The provider mirrors its locale into the process-wide runtime; the rest of this file renders under the suite's own, so
    // put it back.
    const suiteLocale = getLocale();
    const { getByTestId, findByRole, queryByRole, switchLocale, restore } = renderSidebar(
      { pluginViews: [meeting] },
      { locale: "en" },
    );
    try {
      fireEvent.click(getByTestId("sidebar-group-plugins"));
      expect(await findByRole("menuitem", { name: /Meeting/ })).toBeTruthy();
      expect(queryByRole("menuitem", { name: /미팅/ })).toBeNull();

      switchLocale("ko");
      if (!queryByRole("menuitem", { name: /미팅/ })) fireEvent.click(getByTestId("sidebar-group-plugins"));
      expect(await findByRole("menuitem", { name: /미팅/ })).toBeTruthy();
      expect(queryByRole("menuitem", { name: /Meeting/ })).toBeNull();

      // A language the map does not name falls back to the entry's own text.
      switchLocale("fr");
      if (!queryByRole("menuitem", { name: /미팅/ })) fireEvent.click(getByTestId("sidebar-group-plugins"));
      expect(await findByRole("menuitem", { name: /미팅/ })).toBeTruthy();
    } finally {
      restore();
      cleanup();
      setRuntimeLocale(suiteLocale);
    }
  });
});

describe("Sidebar project sessions", () => {
  it("does not fetch workspace roots when the parent supplies projects", async () => {
    const { listRoots, restore } = renderSidebar();
    try {
      await Promise.resolve();
      expect(listRoots).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("renders no-project conversations as a plain ungrouped list on the General section, and real projects as groups on the project section", async () => {
    const { getByTestId, getByText, queryByTestId, restore } = renderSidebar();
    try {
      // General stays flat while named projects are visible above it.
      expect(queryByTestId("sidebar-current-project")).toBeNull();
      const unassigned = getByTestId("sidebar-unassigned-sessions");
      expect(unassigned.textContent).toContain("전체 동기화로 상태 파악");
      expect(unassigned.textContent).toContain("사이드 패널 개선");
      expect(getByText("전체 동기화로 상태 파악")).toBeTruthy();
      expect(getByText("사이드 패널 개선")).toBeTruthy();
      expect(getByTestId("sidebar-session-sess-1").getAttribute("aria-current")).toBe("page");

      // The project section contains the named group.
      await waitFor(() => {
        expect(getByTestId("sidebar-project-C-Users-example-workspace-ave-project-other-app").textContent).toContain("other-app");
      });
      expect(getByText("다른 프로젝트 대화")).toBeTruthy();
    } finally {
      restore();
    }
  });

  it("keeps a stale project conversation as a general chat without resurrecting its project", async () => {
    const staleRoot = "C:\\Users\\example\\workspace\\deleted-project";
    const { getByTestId, queryByTestId, restore } = renderSidebar({
      projects: [{
        projectRoot: "C:\\Users\\example\\workspace\\default",
        projectName: "default",
        isDefault: true,
      }],
      sessions: [{
        id: "stale-session",
        title: "보존된 일반 대화",
        modifiedAt: new Date().toISOString(),
        sessionKind: "main",
        family: "main",
        projectRoot: staleRoot,
        projectName: "deleted-project",
      }],
    });
    try {
      expect(getByTestId("sidebar-unassigned-sessions").textContent).toContain("보존된 일반 대화");
      await waitFor(() => {
        expect(queryByTestId("sidebar-project-C-Users-example-workspace-deleted-project")).toBeNull();
      });
    } finally {
      restore();
    }
  });
  it("loads a selected project conversation through the existing session loader", async () => {
    const { getByTestId, onLoadSession, restore } = renderSidebar();
    try {
      fireEvent.click(getByTestId("sidebar-session-sess-2"));
      expect(onLoadSession).toHaveBeenCalledWith("sess-2");
    } finally {
      restore();
    }
  });

  it("starts a new conversation scoped to the selected project", async () => {
    const { getByTestId, onNewChatForProject, restore } = renderSidebar();
    try {
      await waitFor(() => {
        expect(getByTestId("sidebar-project-C-Users-example-workspace-ave-project-other-app").textContent).toContain("other-app");
      });
      fireEvent.click(getByTestId("sidebar-project-C-Users-example-workspace-ave-project-other-app"));
      expect(onNewChatForProject).toHaveBeenCalledWith({
        projectRoot: "C:\\Users\\example\\workspace\\ave-project\\other-app",
        projectName: "other-app",
      });
    } finally {
      restore();
    }
  });
});

describe("Sidebar legacy default-root session handling", () => {
  // Production reads scrub legacy default-root metadata; this fixture exercises the renderer boundary independently.
  it("renders a session tagged with the default project root as ungrouped, not as a phantom 'workspace' project group", async () => {
    // Matches the default root renderSidebar's workspace.listRoots stub reports below (isDefault: true) — the exact "legacy
    // default-tagged" shape pre-PR persistence produced (projectRoot=defaultRoot, projectName="workspace").
    const DEFAULT_ROOT = "C:\\Users\\example\\workspace\\ave-project\\ave";
    const legacySession: SessionSummary = sessionRow({
      id: "legacy-session",
      title: "레거시 기본 프로젝트 대화",
      modifiedAt: new Date().toISOString(),
      projectRoot: DEFAULT_ROOT,
      projectName: "workspace",
    });
    const { getByTestId, getByText, queryByTestId, restore } = renderSidebar({
      sessions: [legacySession],
      currentSessionId: "legacy-session",
    });
    try {
      // The default project entry comes from the async workspace.listRoots
      // stub (like the "other-app" project in the tests above) — wait for
      // it to settle so the assertion reflects steady state, not the
      // pre-fetch render where workspaceProjects is still [].
      await waitFor(() => {
        expect(getByTestId("sidebar-unassigned-sessions").textContent).toContain("레거시 기본 프로젝트 대화");
      });
      expect(getByText("레거시 기본 프로젝트 대화")).toBeTruthy();
      // No ghost project group synthesized from the default root anywhere in
      // the project section — only the unrelated "other-app" real project from
      // renderSidebar's stub. (Can't grep broadly for "workspace" in the
      // testid: the default root's OWN path legitimately contains that
      // substring — "C:\Users\example\workspace\..." — so the precise
      // ghost-group testid is asserted directly instead.)
      await waitFor(() => expect(getByTestId("sidebar-project-C-Users-example-workspace-ave-project-other-app")).toBeTruthy());
      expect(queryByTestId("sidebar-project-C-Users-example-workspace-ave-project-ave")).toBeNull();
    } finally {
      restore();
    }
  });
});

describe("Sidebar stacked sections", () => {
  it("shows Projects before General without tab controls", () => {
    const { getByTestId, queryByTestId, restore } = renderSidebar();
    try {
      const sections = getByTestId("sidebar-sections");
      expect(Array.from(sections.querySelectorAll("section")).map((section) => section.getAttribute("aria-label"))).toEqual(["프로젝트", "일반"]);
      expect(sections.querySelector('[role="tablist"]')).toBeNull();
      expect(queryByTestId("sidebar-tabs")).toBeNull();
      expect(getByTestId("sidebar-projects").textContent).toContain("다른 프로젝트 대화");
      expect(getByTestId("sidebar-unassigned-sessions").textContent).toContain("전체 동기화로 상태 파악");
    } finally { restore(); }
  });

  it("groups all three item types by the bound session and leaves unbound or unknown sessions in General", async () => {
    const root = "/projects/example";
    const sessions = [
      sessionRow({ id: "project-chat", title: "Project chat", projectRoot: root, modifiedAt: new Date().toISOString() }),
      sessionRow({ id: "general-chat", title: "General chat", modifiedAt: new Date().toISOString() }),
    ];
    const mainSurfaces: MainSurface[] = [
      { tabId: "browser:project", kind: "browser", ordinal: 1, url: "https://project.example/" },
      { tabId: "browser:child", kind: "browser", ordinal: 3, url: "https://child.example/" },
      { tabId: "terminal:project", kind: "terminal", ordinal: 1, url: null },
      { tabId: "browser:general", kind: "browser", ordinal: 2, url: null },
      { tabId: "terminal:general", kind: "terminal", ordinal: 2, url: null },
      { tabId: "terminal:unknown", kind: "terminal", ordinal: 3, url: null },
    ];
    const state: BrowserTabControlState = { revision: 1, tabs: [{
      tabId: "host-project", rendererTabId: "browser:project", url: "https://project.example/", title: "Project page",
      mode: "human-paused", owner: { sessionId: "project-chat" }, lease: null, generation: 1, kind: "embedded", openerTabId: null,
    }, {
      tabId: "host-child", rendererTabId: "browser:child", url: "https://child.example/", title: "Child page",
      mode: "human-paused", owner: { sessionId: "child-chat", directParentSessionId: "project-chat" }, lease: null, generation: 1, kind: "embedded", openerTabId: null,
    }] };
    let receiveControl!: (state: BrowserTabControlState) => void;
    let receiveBindings!: (state: SessionTabBindingsState) => void;
    const bindings = { revision: 1, bindings: [
      { sessionId: "project-chat", browserTabIds: ["browser:project"], terminalTabIds: ["terminal:project"] },
      { sessionId: "missing", browserTabIds: [], terminalTabIds: ["terminal:unknown"] },
    ] };
    const api = { browserTabs: {
      getState: async () => state,
      onControl: (listener: typeof receiveControl) => { receiveControl = listener; return () => {}; },
      onTabOp: () => () => {},
      getSessionBindings: async () => bindings,
      onSessionBindingsChanged: (listener: typeof receiveBindings) => { receiveBindings = listener; return () => {}; },
    } } as unknown as AveApi;
    const unregister = registerBrowserTabHost(api, { sessionId: () => null, hasTab: () => false, selectTab: vi.fn(), closeTab: vi.fn() });
    const onOpenSurface = vi.fn();
    const { getByTestId, onLoadSession, restore } = renderSidebar({
      sessions, projects: [{ projectRoot: root, projectName: "Example" }], mainSurfaces, onOpenSurface,
    }, { browserTabs: api.browserTabs });
    try {
      act(() => noteWebSurfaceFavicon("browser:project", BROWSER_FAVICON_DATA_URL));
      const project = getByTestId("sidebar-projects");
      const general = getByTestId("sidebar-unassigned-sessions");
      await waitFor(() => expect(project.contains(getByTestId("sidebar-surface-browser:project"))).toBe(true));
      expect(project.contains(getByTestId("sidebar-session-project-chat"))).toBe(true);
      expect(project.contains(getByTestId("sidebar-surface-terminal:project"))).toBe(true);
      expect(project.contains(getByTestId("sidebar-surface-browser:child"))).toBe(true);
      expect(general.contains(getByTestId("sidebar-session-general-chat"))).toBe(true);
      for (const id of ["browser:general", "terminal:general", "terminal:unknown"]) {
        expect(general.contains(getByTestId(`sidebar-surface-${id}`))).toBe(true);
      }
      expect(getByTestId("sidebar-conversation-glyph-project-chat").classList.contains("lucide-message-square-text")).toBe(true);
      expect(getByTestId("sidebar-surface-terminal:project").querySelector(".lucide-terminal")).not.toBeNull();
      expect(getByTestId("sidebar-surface-browser:project").querySelector("img")?.getAttribute("src")).toBe(BROWSER_FAVICON_DATA_URL);
      fireEvent.click(getByTestId("sidebar-session-project-chat"));
      expect(onLoadSession).toHaveBeenCalledWith("project-chat");
      fireEvent.click(getByTestId("sidebar-surface-browser:project"));
      fireEvent.click(getByTestId("sidebar-surface-terminal:project"));
      expect(onOpenSurface.mock.calls).toEqual([["browser:project"], ["terminal:project"]]);
      expect(getByTestId("sidebar-surface-browser:project").querySelector("img")?.getAttribute("src")).toBe(BROWSER_FAVICON_DATA_URL);
      act(() => receiveControl({ revision: 2, tabs: state.tabs.map((tab) => ({ ...tab, owner: { sessionId: "general-chat" } })) }));
      expect(general.contains(getByTestId("sidebar-surface-browser:project"))).toBe(true);
      expect(project.contains(getByTestId("sidebar-surface-browser:project"))).toBe(false);
      expect(getByTestId("sidebar-surface-browser:project").querySelector("img")?.getAttribute("src")).toBe(BROWSER_FAVICON_DATA_URL);
      act(() => receiveBindings({ revision: 2, bindings: [{ sessionId: "general-chat", browserTabIds: [], terminalTabIds: ["terminal:project"] }] }));
      expect(general.contains(getByTestId("sidebar-surface-terminal:project"))).toBe(true);
      act(() => receiveBindings(bindings));
      expect(project.contains(getByTestId("sidebar-surface-terminal:project"))).toBe(false);
    } finally { act(() => { unregister(); noteWebSurfaceFavicon("browser:project", null); }); restore(); }
  });

  it("tracks side-panel tab snapshots without a second tab store", () => {
    let tabs = [{ tabId: "terminal:side", kind: "terminal" as const, ordinal: 4, url: null, cwd: null }];
    const unregister = registerSideTabsSink("group-1", {
      adopt: vi.fn(), release: vi.fn(), open: vi.fn(), activate: vi.fn(), snapshot: () => tabs,
    });
    const { getByTestId, queryByTestId, restore } = renderSidebar({ chatGroupIds: ["group-1"] });
    try {
      expect(getByTestId("sidebar-surface-terminal:side").textContent).toContain("4");
      act(() => { tabs = []; emitMainLayoutChange(); });
      expect(queryByTestId("sidebar-surface-terminal:side")).toBeNull();
    } finally { unregister(); restore(); }
  });

  it("uses shared data-only guest favicons and shows a globe after failure, navigation or missing metadata", async () => {
    const state = browserControlFixture(["browser:icon"]);
    let receiveControl!: (state: BrowserTabControlState) => void;
    const unregister = registerBrowserTabHost({ browserTabs: {
      getState: async () => state,
      onControl: (listener: typeof receiveControl) => { receiveControl = listener; return () => {}; },
      onTabOp: () => () => {},
    } } as unknown as AveApi, { sessionId: () => null, hasTab: () => false, selectTab: vi.fn(), closeTab: vi.fn() });
    const { getByTestId, queryByTestId, rerenderSidebar, restore } = renderSidebar({ mainSurfaces: [
      { tabId: "browser:icon", kind: "browser", ordinal: 1, url: "https://a.example/" },
      { tabId: "browser:blank", kind: "browser", ordinal: 2, url: null },
      { tabId: "browser:unsafe", kind: "browser", ordinal: 3, url: "file:///private/example" },
    ] });
    const publish = (faviconDataUrl: string | null) => {
      act(() => noteWebSurfaceFavicon("browser:icon", faviconDataUrl));
    };
    try {
      await waitFor(() => expect(getByTestId("sidebar-surface-browser:icon").textContent).toContain("Fixture page"));
      for (const id of ["browser:icon", "browser:blank", "browser:unsafe"]) {
        expect(getByTestId(`sidebar-surface-${id}`).querySelector(".lucide-globe")).not.toBeNull();
      }
      publish("https://a.example/favicon.png");
      expect(getByTestId("sidebar-surface-browser:icon").querySelector("img")).toBeNull();
      publish(BROWSER_FAVICON_DATA_URL);
      const row = getByTestId("sidebar-surface-browser:icon");
      expect(row.querySelector("img")?.getAttribute("src")).toBe(BROWSER_FAVICON_DATA_URL);
      fireEvent.error(row.querySelector("img")!);
      expect(row.querySelector("img")).toBeNull();
      expect(row.querySelector(".lucide-globe")).not.toBeNull();
      publish(null);
      publish(BROWSER_FAVICON_DATA_URL);
      expect(row.querySelector("img")).not.toBeNull();
      rerenderSidebar({ collapsed: true });
      expect(queryByTestId("sidebar-surface-browser:icon")).not.toBeNull();
      publish(null);
      rerenderSidebar({ collapsed: false });
      expect(getByTestId("sidebar-surface-browser:icon").querySelector(".lucide-globe")).not.toBeNull();
      publish(BROWSER_FAVICON_DATA_URL);
      act(() => { noteWebSurfaceFavicon("browser:icon", null); noteWebSurfaceLocation("browser:icon", "https://next.example/page"); });
      expect(getByTestId("sidebar-surface-browser:icon").querySelector("img")).toBeNull();
      publish(BROWSER_FAVICON_DATA_URL);
      expect(getByTestId("sidebar-surface-browser:icon").querySelector("img")).not.toBeNull();
    } finally {
      act(() => { unregister(); forgetWebSurfaceLocation("browser:icon"); });
      restore();
    }
  });

  it.each([200, 216, 232])("keeps sections and long mixed rows bounded at %ipx", (width) => {
    const { getByTestId, restore } = renderSidebar({ width, sessions: [sessionRow({ id: "long", title: "long-title-".repeat(50), modifiedAt: new Date().toISOString() })], mainSurfaces: [
      { tabId: "browser:long", kind: "browser", ordinal: 1, url: `https://example.test/${"long-path".repeat(50)}` },
      { tabId: "terminal:long", kind: "terminal", ordinal: 1, url: null },
    ] });
    try {
      expect(getByTestId("sidebar-card").style.width).toBe(`${width}px`);
      expect(getByTestId("sidebar-sections").classList.contains("min-w-0")).toBe(true);
      for (const id of ["sidebar-session-long", "sidebar-surface-browser:long", "sidebar-surface-terminal:long"]) {
        expect(getByTestId(id).querySelector(".min-w-0.truncate")).not.toBeNull();
      }
    } finally { restore(); }
  });
});

describe("Sidebar conversation pinning", () => {
  it("shows a pin toggle per conversation row and calls onToggleSessionStar with the session id and title", () => {
    const onToggleSessionStar = vi.fn();
    const { getByTestId, restore } = renderSidebar({
      isSessionStarred: () => null,
      onToggleSessionStar,
    });
    try {
      const pinButton = getByTestId("sidebar-session-pin-sess-1");
      expect(pinButton.getAttribute("aria-pressed")).toBe("false");
      fireEvent.click(pinButton);
      expect(onToggleSessionStar).toHaveBeenCalledWith("sess-1", "전체 동기화로 상태 파악");
    } finally {
      restore();
    }
  });

  it("sorts a pinned conversation to the top of the ungrouped list, ahead of a more recent unpinned one", () => {
    const { getByTestId, restore } = renderSidebar({
      isSessionStarred: (sessionId: string) => (sessionId === "sess-2" ? "starred-id" : null),
      onToggleSessionStar: vi.fn(),
    });
    try {
      const unassigned = getByTestId("sidebar-unassigned-sessions");
      const rows = Array.from(unassigned.querySelectorAll('[data-testid^="sidebar-session-"]'))
        .filter((el) => {
          // Keep only the row's own load button. Each row also carries a pin and a menu button under the same `sidebar-session`
          // prefix.
          const id = el.getAttribute("data-testid") ?? "";
          return !id.includes("-pin-") && !id.includes("-menu-");
        });
      expect(rows.map((el) => el.getAttribute("data-testid"))).toEqual([
        "sidebar-session-sess-2",
        "sidebar-session-sess-1",
      ]);
      expect(getByTestId("sidebar-session-pin-sess-2").getAttribute("aria-pressed")).toBe("true");
    } finally {
      restore();
    }
  });

  it("reverts to recency order once a pinned conversation is unpinned", () => {
    let pinned = new Set(["sess-2"]);
    const { getByTestId, rerender, restore } = renderSidebar({
      isSessionStarred: (sessionId: string) => (pinned.has(sessionId) ? "starred-id" : null),
      onToggleSessionStar: vi.fn(),
    });
    try {
      let unassigned = getByTestId("sidebar-unassigned-sessions");
      let rows = Array.from(unassigned.querySelectorAll('[data-testid^="sidebar-session-"]'))
        .filter((el) => {
          // Keep only the row's own load button. Each row also carries a pin and a menu button under the same `sidebar-session`
          // prefix.
          const id = el.getAttribute("data-testid") ?? "";
          return !id.includes("-pin-") && !id.includes("-menu-");
        });
      expect(rows[0].getAttribute("data-testid")).toBe("sidebar-session-sess-2");

      pinned = new Set();
      rerender(
        <TooltipProvider>
          <Sidebar
            activeView="home"
            onSelect={vi.fn()}
            pluginViews={[]}
            hasApiKey
            onOpenSettings={vi.fn()}
            onNewChat={vi.fn()}
            collapsed={false}
            onToggleCollapse={vi.fn()}
            onOpenUnifiedSearch={vi.fn()}
            viewNav={{
              segments: [],
              canGoBack: false,
              canGoForward: false,
              onBack: vi.fn(),
              onForward: vi.fn(),
              onSelectSegment: vi.fn(),
            }}
            sessions={[
              {
                id: "sess-1",
                title: "전체 동기화로 상태 파악",
                modifiedAt: new Date().toISOString(),
                sessionKind: "main",
                family: "main",
              },
              {
                id: "sess-2",
                title: "사이드 패널 개선",
                modifiedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
                sessionKind: "main",
                family: "main",
              },
            ]}
            currentSessionId="sess-1"
            onLoadSession={vi.fn()}
            onNewChatForProject={vi.fn()}
            isSessionStarred={(sessionId: string) => (pinned.has(sessionId) ? "starred-id" : null)}
            onToggleSessionStar={vi.fn()}
          />
        </TooltipProvider>,
      );
      unassigned = getByTestId("sidebar-unassigned-sessions");
      rows = Array.from(unassigned.querySelectorAll('[data-testid^="sidebar-session-"]'))
        .filter((el) => {
          // Keep only the row's own load button. Each row also carries a pin and a menu button under the same `sidebar-session`
          // prefix.
          const id = el.getAttribute("data-testid") ?? "";
          return !id.includes("-pin-") && !id.includes("-menu-");
        });
      expect(rows.map((el) => el.getAttribute("data-testid"))).toEqual([
        "sidebar-session-sess-1",
        "sidebar-session-sess-2",
      ]);
    } finally {
      restore();
    }
  });
});

describe("Sidebar project pinning", () => {
  const projects: ProjectIdentity[] = [
    { projectRoot: "C:\\Users\\example\\workspace\\ave-project\\alpha", projectName: "alpha", isDefault: false },
    { projectRoot: "C:\\Users\\example\\workspace\\ave-project\\beta", projectName: "beta", isDefault: false },
  ];

  it("shows a pin/unpin context menu item and calls onToggleProjectPin with the project root", async () => {
    const onToggleProjectPin = vi.fn();
    const {
      getByTestId,
      showNativeContextMenu,
      emitNativeContextCommand,
      restore,
    } = renderSidebar({
      sessions: [],
      projects,
      isProjectPinned: () => false,
      onToggleProjectPin,
    });
    try {
      const projectRow = await waitFor(() => getByTestId("sidebar-project-C-Users-example-workspace-ave-project-alpha"));
      fireEvent.contextMenu(projectRow);
      expect(showNativeContextMenu).toHaveBeenCalledWith(expect.objectContaining({
        kind: "project",
        commands: expect.arrayContaining([
          "project.pin",
          "project.new-chat",
          "project.reveal",
          "project.remove",
        ]),
      }));
      emitNativeContextCommand("project.pin");
      expect(onToggleProjectPin).toHaveBeenCalledWith("C:\\Users\\example\\workspace\\ave-project\\alpha");
    } finally {
      restore();
    }
  });

  it("refreshes projects only after the native remove action succeeds", async () => {
    const onRefreshProjects = vi.fn();
    const {
      getByTestId,
      removeRoot,
      emitNativeContextCommand,
      restore,
    } = renderSidebar({
      sessions: [],
      projects,
      onRefreshProjects,
    });
    try {
      const projectRow = await waitFor(() =>
        getByTestId("sidebar-project-C-Users-example-workspace-ave-project-alpha"));
      fireEvent.contextMenu(projectRow);
      emitNativeContextCommand("project.remove");

      await waitFor(() => {
        expect(removeRoot).toHaveBeenCalledWith(
          "C:\\Users\\example\\workspace\\ave-project\\alpha",
        );
        expect(onRefreshProjects).toHaveBeenCalledTimes(1);
      });
    } finally {
      restore();
    }
  });

  it("keeps the project and surfaces the IPC error when native remove fails", async () => {
    const onRefreshProjects = vi.fn();
    const onProjectError = vi.fn();
    const {
      getByTestId,
      removeRoot,
      emitNativeContextCommand,
      restore,
    } = renderSidebar({
      sessions: [],
      projects,
      onRefreshProjects,
      onProjectError,
    });
    removeRoot.mockResolvedValueOnce({
      ok: false,
      error: "not-an-additional-root",
      message: "not registered",
    } as never);
    try {
      const projectRow = await waitFor(() =>
        getByTestId("sidebar-project-C-Users-example-workspace-ave-project-alpha"));
      fireEvent.contextMenu(projectRow);
      emitNativeContextCommand("project.remove");

      await waitFor(() => {
        expect(onProjectError).toHaveBeenCalledWith(
          "remove",
          "not-an-additional-root",
          "not registered",
        );
      });
      expect(onRefreshProjects).not.toHaveBeenCalled();
      expect(getByTestId("sidebar-project-C-Users-example-workspace-ave-project-alpha")).toBeTruthy();
    } finally {
      restore();
    }
  });
  it("sorts a pinned project to the top of the project section", async () => {
    const { getByTestId, restore } = renderSidebar({
      sessions: [],
      projects,
      isProjectPinned: (root) => root === "C:\\Users\\example\\workspace\\ave-project\\beta",
      onToggleProjectPin: vi.fn(),
    });
    try {
      await waitFor(() => expect(getByTestId("sidebar-projects")).toBeTruthy());
      const projectsPanel = getByTestId("sidebar-projects");
      // Scoped to the actual project-root buttons only — the context menu's own items/content also carry a "sidebar-project-"
      // prefixed testid (e.g. "sidebar-project-menu-pin"), so match on the root-path suffix.
      const rows = Array.from(projectsPanel.querySelectorAll('[data-testid^="sidebar-project-C-Users"]'));
      expect(rows.map((el) => el.getAttribute("data-testid"))).toEqual([
        "sidebar-project-C-Users-example-workspace-ave-project-beta",
        "sidebar-project-C-Users-example-workspace-ave-project-alpha",
      ]);
    } finally {
      restore();
    }
  });
});

describe("Sidebar project section add-project context menu", () => {
  const projects: ProjectIdentity[] = [
    { projectRoot: "C:\\Users\\example\\workspace\\ave-project\\alpha", projectName: "alpha", isDefault: false },
  ];

  it("offers add-project when the project section's empty area is right-clicked, and adds through workspace.pickRoot", async () => {
    const onRefreshProjects = vi.fn();
    const {
      getByTestId,
      showNativeContextMenu,
      emitNativeContextCommand,
      pickRoot,
      restore,
    } = renderSidebar({
      sessions: [],
      projects,
      onRefreshProjects,
    });
    try {
      const tabBody = await waitFor(() => getByTestId("sidebar-projects"));
      fireEvent.contextMenu(tabBody);
      expect(showNativeContextMenu).toHaveBeenCalledTimes(1);
      expect(showNativeContextMenu).toHaveBeenCalledWith(expect.objectContaining({
        kind: "project",
        commands: ["project.add"],
      }));

      emitNativeContextCommand("project.add");
      await waitFor(() => {
        expect(pickRoot).toHaveBeenCalledTimes(1);
        expect(onRefreshProjects).toHaveBeenCalledTimes(1);
      });
    } finally {
      restore();
    }
  });

  it("surfaces a refused add instead of leaving the right-click a no-op", async () => {
    const onRefreshProjects = vi.fn();
    const onProjectError = vi.fn();
    const { getByTestId, emitNativeContextCommand, pickRoot, restore } = renderSidebar({
      sessions: [],
      projects,
      onRefreshProjects,
      onProjectError,
    });
    pickRoot.mockResolvedValueOnce({ ok: false, error: "persist-failed" } as never);
    try {
      const tabBody = await waitFor(() => getByTestId("sidebar-projects"));
      fireEvent.contextMenu(tabBody);
      emitNativeContextCommand("project.add");

      await waitFor(() => expect(onProjectError).toHaveBeenCalledWith("add", "persist-failed"));
      expect(onRefreshProjects).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("offers add-project from the project section trigger", async () => {
    const { getByTestId, showNativeContextMenu, emitNativeContextCommand, pickRoot, restore } =
      renderSidebar({ sessions: [], projects });
    try {
      fireEvent.contextMenu(getByTestId("sidebar-projects-heading"));
      expect(showNativeContextMenu).toHaveBeenCalledWith(expect.objectContaining({
        kind: "project",
        commands: ["project.add"],
      }));

      emitNativeContextCommand("project.add");
      await waitFor(() => expect(pickRoot).toHaveBeenCalledTimes(1));
    } finally {
      restore();
    }
  });

  it("keeps the per-row menu authoritative — a right-click on a project row requests exactly one menu, the row's", async () => {
    const onRefreshProjects = vi.fn();
    const { getByTestId, showNativeContextMenu, emitNativeContextCommand, onNewChatForProject, restore } =
      renderSidebar({ sessions: [], projects, onRefreshProjects });
    try {
      const row = await waitFor(() =>
        getByTestId("sidebar-project-C-Users-example-workspace-ave-project-alpha"));
      fireEvent.contextMenu(row);

      // The tab body's own handler must NOT also fire and replace the row's pending menu — one right-click, one menu request.
      expect(showNativeContextMenu).toHaveBeenCalledTimes(1);
      const payload = showNativeContextMenu.mock.calls[0]?.[0];
      expect(payload?.commands).toEqual(expect.arrayContaining([
        "project.new-chat",
        "project.add",
        "project.remove",
      ]));

      // The row's own primary action still resolves against the row's handlers.
      emitNativeContextCommand("project.new-chat");
      expect(onNewChatForProject).toHaveBeenCalledWith({
        projectRoot: "C:\\Users\\example\\workspace\\ave-project\\alpha",
        projectName: "alpha",
      });
    } finally {
      restore();
    }
  });

  it("holds the add behind the adjacency warning and completes it with the ack token", async () => {
    const onRefreshProjects = vi.fn();
    const {
      getByTestId,
      queryByTestId,
      emitNativeContextCommand,
      pickRoot,
      addedRoot,
      restore,
    } = renderSidebar({ sessions: [], projects, onRefreshProjects });
    try {
      pickRoot.mockResolvedValueOnce({
        ok: true,
        requiresAcknowledgement: true,
        pendingPath: addedRoot,
        ackToken: "ack-1",
        warnings: ["close to a sensitive location"],
      });

      fireEvent.contextMenu(await waitFor(() => getByTestId("sidebar-projects")));
      emitNativeContextCommand("project.add");

      const warning = await waitFor(() => getByTestId("sidebar-project-root-warning"));
      expect(warning.textContent).toContain("close to a sensitive location");
      expect(onRefreshProjects).not.toHaveBeenCalled();

      fireEvent.click(getByTestId("sidebar-project-root-warning-confirm"));
      await waitFor(() => {
        expect(pickRoot).toHaveBeenLastCalledWith({ ackToken: "ack-1" });
        expect(onRefreshProjects).toHaveBeenCalledTimes(1);
      });
      await waitFor(() => expect(queryByTestId("sidebar-project-root-warning")).toBeNull());
    } finally {
      restore();
    }
  });

  it("dismisses the adjacency warning without adding", async () => {
    const onRefreshProjects = vi.fn();
    const { getByTestId, queryByTestId, emitNativeContextCommand, pickRoot, addedRoot, restore } =
      renderSidebar({ sessions: [], projects, onRefreshProjects });
    try {
      pickRoot.mockResolvedValueOnce({
        ok: true,
        requiresAcknowledgement: true,
        pendingPath: addedRoot,
        ackToken: "ack-1",
        warnings: ["close to a sensitive location"],
      });

      fireEvent.contextMenu(await waitFor(() => getByTestId("sidebar-projects")));
      emitNativeContextCommand("project.add");

      fireEvent.click(await waitFor(() => getByTestId("sidebar-project-root-warning-cancel")));
      await waitFor(() => expect(queryByTestId("sidebar-project-root-warning")).toBeNull());
      expect(pickRoot).toHaveBeenCalledTimes(1);
      expect(onRefreshProjects).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});

describe("Sidebar conversation context menu", () => {
  it("opens and pins an unpinned conversation through the native menu", async () => {
    const onToggleSessionStar = vi.fn();
    const { getByTestId, onLoadSession, showNativeContextMenu, emitNativeContextCommand, restore } = renderSidebar({
      onToggleSessionStar,
      isSessionStarred: () => null,
    });
    try {
      const row = await waitFor(() => getByTestId("sidebar-session-sess-1"));
      fireEvent.contextMenu(row);
      expect(showNativeContextMenu).toHaveBeenCalledWith(expect.objectContaining({
        kind: "conversation",
        commands: ["conversation.open", "conversation.pin"],
      }));

      emitNativeContextCommand("conversation.open");
      expect(onLoadSession).toHaveBeenCalledWith("sess-1");

      fireEvent.contextMenu(row);
      emitNativeContextCommand("conversation.pin");
      expect(onToggleSessionStar).toHaveBeenCalledWith("sess-1", "전체 동기화로 상태 파악");
    } finally {
      restore();
    }
  });

  it("offers unpin for a pinned conversation", async () => {
    const onToggleSessionStar = vi.fn();
    const { getByTestId, showNativeContextMenu, emitNativeContextCommand, restore } = renderSidebar({
      onToggleSessionStar,
      isSessionStarred: (sessionId) => sessionId === "sess-1" ? "star-1" : null,
    });
    try {
      const row = await waitFor(() => getByTestId("sidebar-session-sess-1"));
      fireEvent.contextMenu(row);
      expect(showNativeContextMenu).toHaveBeenCalledWith(expect.objectContaining({
        kind: "conversation",
        commands: ["conversation.open", "conversation.unpin"],
      }));

      emitNativeContextCommand("conversation.unpin");
      expect(onToggleSessionStar).toHaveBeenCalledWith("sess-1", "전체 동기화로 상태 파악");
    } finally {
      restore();
    }
  });

  it("keeps another conversation reachable however many turns are running — the sidebar holds no turn state", async () => {
    const onToggleSessionStar = vi.fn();
    const { getByTestId, showNativeContextMenu, restore } = renderSidebar({
      onToggleSessionStar,
      isSessionStarred: () => null,
    });
    try {
      const inactiveRow = await waitFor(() => getByTestId("sidebar-session-sess-2"));
      // One conversation's turn is not a reason to lock the others away. Where
      // the incoming conversation goes is the window's call — it gives it a
      // group of its own rather than taking the running one's place — so the
      // sidebar's job is simply to stay openable.
      expect(inactiveRow).not.toBeDisabled();
      fireEvent.contextMenu(inactiveRow);
      expect(showNativeContextMenu).toHaveBeenCalledWith(expect.objectContaining({
        kind: "conversation",
        commands: expect.arrayContaining(["conversation.open"]),
      }));
    } finally {
      restore();
    }
  });
});

describe("Sidebar conversation row actions", () => {
  const rowState = () => ({
    archived: new Set<string>(),
    unread: new Set<string>(),
    responding: new Set<string>(),
    onRename: vi.fn(),
    onSetArchived: vi.fn(),
    onSetUnread: vi.fn(),
    onShare: vi.fn(),
    onCopy: vi.fn(),
    onDelete: vi.fn(),
  });

  const asActions = (state: ReturnType<typeof rowState>) => ({
    isArchived: (id: string) => state.archived.has(id),
    isUnread: (id: string) => state.unread.has(id),
    isResponding: (id: string) => state.responding.has(id),
    onRename: state.onRename,
    onSetArchived: state.onSetArchived,
    onSetUnread: state.onSetUnread,
    onShare: state.onShare,
    onCopy: state.onCopy,
    onDelete: state.onDelete,
  });

  it("shows a responding dot on a row whose conversation has a turn running, in place of the kind glyph", () => {
    const state = rowState();
    state.responding.add("sess-2");
    const { getByTestId, queryByTestId, restore } = renderSidebar({ conversationActions: asActions(state) });
    try {
      const dot = getByTestId("sidebar-session-responding-sess-2");
      expect(dot.getAttribute("aria-label")).toBeTruthy();
      expect(getByTestId("sidebar-session-sess-2").closest("[data-responding='true']")).toBeTruthy();
      expect(queryByTestId("sidebar-session-responding-sess-1")).toBeNull();
      expect(getByTestId("sidebar-session-sess-1").closest("[data-responding='true']")).toBeNull();
    } finally {
      restore();
    }
  });

  it("opens the same menu from the trailing button as from a right-click", () => {
    const state = rowState();
    const { getByTestId, showNativeContextMenu, restore } = renderSidebar({
      conversationActions: asActions(state),
    });
    fireEvent.click(getByTestId("sidebar-session-menu-sess-1"));
    const call = showNativeContextMenu.mock.calls.at(-1)?.[0];
    expect(call?.kind).toBe("conversation");
    // Every command the row offers must be one the main-side allow-list knows.
    expect(call?.commands).toEqual(
      expect.arrayContaining([
        "conversation.rename",
        "conversation.mark-unread",
        "conversation.share",
        "conversation.copy",
        "conversation.archive",
        "conversation.delete",
      ]),
    );
    restore();
  });

  it("offers unarchive and mark-read once the row is in those states", () => {
    const state = rowState();
    state.archived.add("sess-1");
    state.unread.add("sess-1");
    const { getByTestId, showNativeContextMenu, restore } = renderSidebar({
      conversationActions: asActions(state),
    });
    fireEvent.click(getByTestId("sidebar-toggle-archived"));
    fireEvent.click(getByTestId("sidebar-session-menu-sess-1"));
    const call = showNativeContextMenu.mock.calls.at(-1)?.[0];
    expect(call?.commands).toContain("conversation.unarchive");
    expect(call?.commands).toContain("conversation.mark-read");
    expect(call?.commands).not.toContain("conversation.archive");
    expect(call?.commands).not.toContain("conversation.mark-unread");
    restore();
  });

  it("offers no archive or rename on the Suggestions conversation, but keeps delete", async () => {
    // Archived rows leave the list, so archiving the conversation every unrequested card is addressed to would hide each
    // suggestion and its count. Delete stays: main clears it and recreates the row.
    const state = rowState();
    const { getByTestId, showNativeContextMenu, restore } = renderSidebar({
      sessions: [
        sessionRow({ id: SUGGESTIONS_SESSION_ID, title: "Inbox", modifiedAt: new Date().toISOString() }),
        sessionRow({ id: "sess-2", title: "다른 대화", modifiedAt: new Date(Date.now() - 3600_000).toISOString() }),
      ],
      conversationActions: asActions(state),
    });
    try {
      await waitFor(() => getByTestId(`sidebar-session-menu-${SUGGESTIONS_SESSION_ID}`));
      fireEvent.click(getByTestId(`sidebar-session-menu-${SUGGESTIONS_SESSION_ID}`));
      const suggestions = showNativeContextMenu.mock.calls.at(-1)?.[0];
      expect(suggestions?.commands).not.toContain("conversation.archive");
      expect(suggestions?.commands).not.toContain("conversation.unarchive");
      expect(suggestions?.commands).not.toContain("conversation.rename");
      expect(suggestions?.commands).toContain("conversation.delete");

      // An ordinary row next to it still offers both.
      fireEvent.click(getByTestId("sidebar-session-menu-sess-2"));
      const ordinary = showNativeContextMenu.mock.calls.at(-1)?.[0];
      expect(ordinary?.commands).toEqual(
        expect.arrayContaining(["conversation.archive", "conversation.rename", "conversation.delete"]),
      );
    } finally {
      restore();
    }
  });

  it("hides archived conversations until the archive toggle is used", () => {
    const state = rowState();
    state.archived.add("sess-1");
    const { getByTestId, queryByTestId, restore } = renderSidebar({
      conversationActions: asActions(state),
    });
    expect(queryByTestId("sidebar-session-sess-1")).toBeNull();
    fireEvent.click(getByTestId("sidebar-toggle-archived"));
    expect(queryByTestId("sidebar-session-sess-1")).not.toBeNull();
    restore();
  });

  it("offers import on the LIST, and only row commands on a row", () => {
    const state = rowState();
    const onImport = vi.fn();
    const { getByTestId, showNativeContextMenu, restore } = renderSidebar({
      conversationActions: { ...asActions(state), onImport },
    });
    // The list's own blank area answers with import and nothing row-scoped: import creates a NEW conversation, so it cannot
    // act on a row.
    fireEvent.contextMenu(getByTestId("sidebar-unassigned-sessions"));
    const listMenu = showNativeContextMenu.mock.calls.at(-1)?.[0];
    expect(listMenu?.commands).toEqual(["conversation.import"]);

    // A row answers first and does NOT offer import.
    fireEvent.click(getByTestId("sidebar-session-menu-sess-1"));
    const rowMenu = showNativeContextMenu.mock.calls.at(-1)?.[0];
    expect(rowMenu?.commands).not.toContain("conversation.import");
    expect(rowMenu?.commands).toContain("conversation.delete");
    restore();
  });

  it("commits a rename on Enter and abandons it on Escape", () => {
    const state = rowState();
    const { getByTestId, emitNativeContextCommand, restore } = renderSidebar({
      conversationActions: asActions(state),
    });
    fireEvent.click(getByTestId("sidebar-session-menu-sess-1"));
    act(() => emitNativeContextCommand("conversation.rename"));
    const field = getByTestId("sidebar-session-rename-sess-1");
    fireEvent.change(field, { target: { value: "새 이름" } });
    fireEvent.keyDown(field, { key: "Escape" });
    expect(state.onRename).not.toHaveBeenCalled();

    fireEvent.click(getByTestId("sidebar-session-menu-sess-1"));
    act(() => emitNativeContextCommand("conversation.rename"));
    const again = getByTestId("sidebar-session-rename-sess-1");
    fireEvent.change(again, { target: { value: "새 이름" } });
    fireEvent.keyDown(again, { key: "Enter" });
    expect(state.onRename).toHaveBeenCalledWith("sess-1", "새 이름");
    restore();
  });
});

describe("Sidebar collapsed rail", () => {
  it("renders collapsed as well as expanded", () => {
    // The collapsed rail returns EARLY from the conversation list, so any hook
    // added below that branch renders in one state and not the other. React
    // reports that as "rendered fewer hooks than expected" and the whole app
    // falls into the error boundary — which is what this asserts against.
    const { getByTestId, restore } = renderSidebar({ collapsed: true });
    expect(getByTestId("sidebar-cluster")).toBeTruthy();
    restore();
  });

  it("shows icons only — no nav label is left to overflow the rail", () => {
    const { getByTestId, queryByTestId, restore } = renderSidebar({
      collapsed: true,
      failedPluginCards: [FAILED_PLUGIN_CARD],
    });
    const buttons = getByTestId("primary-sidebar").querySelectorAll("button");
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      expect(button.textContent?.trim()).toBe("");
    }
    // The groups are single icons; their rows wait in the flyout.
    expect(getByTestId("sidebar-group-features")).toBeTruthy();
    expect(getByTestId("sidebar-group-plugins")).toBeTruthy();
    expect(queryByTestId("toolbar-work-board")).toBeNull();
    restore();
  });

  it("opens the group's flyout from the rail icon without expanding the sidebar", async () => {
    const onToggleCollapse = vi.fn();
    const onSelect = vi.fn();
    const { getByTestId, findByTestId, queryByTestId, restore } = renderSidebar({
      collapsed: true,
      onToggleCollapse,
      onSelect,
    });

    fireEvent.click(getByTestId("sidebar-group-features"));
    const menu = await findByTestId("sidebar-group-features-menu");
    expect(menu.getAttribute("role")).toBe("menu");
    expect(onToggleCollapse).not.toHaveBeenCalled();

    fireEvent.click(getByTestId("sidebar-routines"));
    expect(onSelect).toHaveBeenCalledWith("routines");
    await waitFor(() => expect(queryByTestId("sidebar-group-features-menu")).toBeNull());
    expect(onToggleCollapse).not.toHaveBeenCalled();
    restore();
  });

  it("expands the sidebar to reveal its project section when the rail's folder is clicked", () => {
    const onToggleCollapse = vi.fn();
    const { getByTestId, restore } = renderSidebar({
      collapsed: true,
      onToggleCollapse,
    });

    fireEvent.click(getByTestId("sidebar-projects-collapsed"));

    expect(onToggleCollapse).toHaveBeenCalledTimes(1);
    restore();
  });
});

const FAILED_PLUGIN_CARD: NonNullable<Parameters<typeof Sidebar>[0]["failedPluginCards"]>[number] = {
  id: "notes",
  name: "Notes",
  description: "Notes fixture",
  sampleTools: [],
  capabilities: [],
  tools: [],
  loadStatus: "failed",
};

describe("Sidebar nav groups", () => {
  it("has no home row and no marketplace row", () => {
    const { queryByTestId, queryByText, restore } = renderSidebar();
    expect(queryByTestId("sidebar-home")).toBeNull();
    expect(queryByTestId("sidebar-marketplace")).toBeNull();
    expect(queryByText("홈")).toBeNull();
    expect(queryByText("Home")).toBeNull();
    expect(queryByText("마켓플레이스")).toBeNull();
    expect(queryByText("Marketplace")).toBeNull();
    restore();
  });

  it("opens the Features flyout from its row with menu semantics; a pick navigates and closes it", async () => {
    const onSelect = vi.fn();
    const { getByTestId, findByTestId, queryByTestId, restore } = renderSidebar({
      onSelect,
      activeView: "routines",
    });
    const trigger = getByTestId("sidebar-group-features");
    expect(trigger.getAttribute("aria-haspopup")).toBe("menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    // The trigger says one of its rows is the page, since the rows are hidden.
    expect(trigger.getAttribute("data-active")).toBe("true");
    expect(queryByTestId("toolbar-work-board")).toBeNull();

    fireEvent.click(trigger);
    const menu = await findByTestId("sidebar-group-features-menu");
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(trigger.getAttribute("aria-controls")).toBe("sidebar-group-features-menu");
    const rows = Array.from(menu.querySelectorAll('[role="menuitem"]')).map((row) => row.getAttribute("data-testid"));
    expect(rows).toEqual(["toolbar-work-board", "sidebar-routines", "sidebar-starred", "sidebar-terminal", "sidebar-web"]);
    expect(getByTestId("sidebar-routines").getAttribute("aria-current")).toBe("page");

    fireEvent.click(getByTestId("toolbar-work-board"));
    expect(onSelect).toHaveBeenCalledWith("work-board");
    await waitFor(() => expect(queryByTestId("sidebar-group-features-menu")).toBeNull());
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    restore();
  });

  it("walks the rows with the arrow keys, wrapping, and closes on Escape", async () => {
    const { getByTestId, findByTestId, queryByTestId, restore } = renderSidebar();
    fireEvent.click(getByTestId("sidebar-group-features"));
    const menu = await findByTestId("sidebar-group-features-menu");
    await waitFor(() => expect(document.activeElement).toBe(getByTestId("toolbar-work-board")));

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(getByTestId("sidebar-routines"));
    fireEvent.keyDown(menu, { key: "End" });
    expect(document.activeElement).toBe(getByTestId("sidebar-web"));
    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(getByTestId("toolbar-work-board"));
    fireEvent.keyDown(menu, { key: "ArrowUp" });
    expect(document.activeElement).toBe(getByTestId("sidebar-web"));

    fireEvent.keyDown(menu, { key: "Escape" });
    await waitFor(() => expect(queryByTestId("sidebar-group-features-menu")).toBeNull());
    restore();
  });

  it("renders the extension group only when there is a code package row", async () => {
    const empty = renderSidebar();
    expect(empty.queryByTestId("sidebar-group-plugins")).toBeNull();
    empty.restore();
    cleanup();

    const onSelect = vi.fn();
    const { getByTestId, findByTestId, queryByTestId, restore } = renderSidebar({
      failedPluginCards: [FAILED_PLUGIN_CARD],
      onSelect,
    });
    expect(getByTestId("sidebar-group-plugins")).toHaveTextContent("익스텐션");
    fireEvent.click(getByTestId("sidebar-group-plugins"));
    const menu = await findByTestId("sidebar-group-plugins-menu");
    const row = menu.querySelector<HTMLElement>('[role="menuitem"]');
    expect(row?.textContent).toContain("Notes");
    expect(row?.textContent).toContain("Doctor");

    fireEvent.click(row!);
    expect(onSelect).toHaveBeenCalledWith("plugin-doctor:notes");
    await waitFor(() => expect(queryByTestId("sidebar-group-plugins-menu")).toBeNull());
    restore();
  });
});

describe("Sidebar settings alert (no chat model configured)", () => {
  // Show missing configuration on the sidebar destination that repairs it, in both expanded and collapsed layouts.
  it.each([
    ["expanded", false],
    ["collapsed rail", true],
  ] as const)("marks the Settings entry red when no model is configured (%s)", (_layout, collapsed) => {
    const { getByTestId, restore } = renderSidebar({ collapsed, modelConfigured: false });
    const badge = getByTestId("sidebar-settings-alert");
    expect(getByTestId("sidebar-settings").contains(badge)).toBe(true);
    expect(badge.className).toContain("bg-destructive");
    expect(badge.getAttribute("aria-label")).toBe("채팅 모델 미설정");
    restore();
  });

  it.each([
    ["configured", true],
    ["not yet known", null],
  ] as const)("shows no badge while the model is %s", (_state, modelConfigured) => {
    for (const collapsed of [false, true]) {
      const { queryByTestId, restore } = renderSidebar({ collapsed, modelConfigured });
      expect(queryByTestId("sidebar-settings-alert")).toBeNull();
      restore();
      cleanup();
    }
  });
});

describe("Sidebar current-row scoping", () => {
  it("marks the loaded conversation as the current page only while a conversation is showing", () => {
    const onChat = renderSidebar({ activeView: "home" });
    expect(
      onChat.getByTestId("sidebar-session-sess-1").getAttribute("aria-current"),
    ).toBe("page");
    onChat.restore();
    cleanup();

    // A session stays LOADED while the user reads a plugin view, but the page
    // they are on is the plugin. Both rows claiming `aria-current="page"` told
    // a screen reader the window was in two places at once, and drew the chat
    // row selected underneath the selected plugin row.
    const onPlugin = renderSidebar({ activeView: "plugin:notes:panel" });
    expect(
      onPlugin.getByTestId("sidebar-session-sess-1").getAttribute("aria-current"),
    ).toBeNull();
    onPlugin.restore();
  });
});

describe("Sidebar conversation reveal on scroll", () => {
  const OTHER_ROOT = "C:\\Users\\example\\workspace\\ave-project\\other-app";

  /** How many of `conversations` currently have a row in the sidebar. */
  function countRenderedRows(
    conversations: SessionSummary[],
    queryByTestId: (id: string) => HTMLElement | null,
  ): number {
    return conversations.filter((session) => queryByTestId(`sidebar-session-${session.id}`)).length;
  }

  function manyConversations(
    count: number,
    prefix: string,
    project?: { projectRoot: string; projectName: string },
  ): SessionSummary[] {
    return Array.from({ length: count }, (_unused, index) => sessionRow({
      id: `${prefix}-${index}`,
      title: `${prefix} 대화 ${index}`,
      modifiedAt: new Date(Date.now() - index * 60_000).toISOString(),
      ...(project ?? {}),
    }));
  }

  const SENTINEL = "sidebar-unassigned-sessions-sentinel";

  it("reveals one page per intersection, rebuilding its observer each time", async () => {
    const conversations = manyConversations(15, "일반");
    const { getByTestId, queryByTestId, restore } = renderSidebar({
      sessions: conversations,
      currentSessionId: "일반-0",
    });
    try {
      const renderedRows = () => countRenderedRows(conversations, queryByTestId);

      // One page up front — the rest is not rendered yet, and nothing claims otherwise: the old capped list ended in an inert "N
      // more" label.
      expect(renderedRows()).toBe(6);

      // The sentinel is what asks for the next page, and it must actually be
      // observed — an unobserved sentinel would silently reveal nothing.
      // It is then parked back out of view, because this test is about ONE page
      // per intersection; a sentinel left in view keeps asking, which is the
      // next test's subject.
      await act(async () => {
        expect(triggerIntersection(getByTestId(SENTINEL))).toBe(1);
        triggerIntersection(getByTestId(SENTINEL), false);
      });
      expect(renderedRows()).toBe(12);

      // Still exactly ONE observer: the reveal built a new one and disconnected the old, rather than leaving both watching the
      // same sentinel.
      await act(async () => {
        expect(triggerIntersection(getByTestId(SENTINEL))).toBe(1);
        triggerIntersection(getByTestId(SENTINEL), false);
      });
      expect(renderedRows()).toBe(15);

      // Everything is on screen, so there is nothing left to ask for.
      expect(queryByTestId(SENTINEL)).toBeNull();
    } finally {
      restore();
    }
  });

  it("keeps revealing from one intersection while the sentinel stays in view", async () => {
    const conversations = manyConversations(15, "이어서");
    const { getByTestId, queryByTestId, restore } = renderSidebar({
      sessions: conversations,
      currentSessionId: "이어서-0",
    });
    try {
      const renderedRows = () => countRenderedRows(conversations, queryByTestId);
      expect(renderedRows()).toBe(6);

      // A sentinel that is still on screen after a reveal has to produce the
      // NEXT reveal without being poked again — a page shorter than the
      // scroller would otherwise leave the list stalled with the sentinel
      // sitting in plain view and nothing to scroll toward.
      await act(async () => {
        expect(triggerIntersection(getByTestId(SENTINEL))).toBe(1);
      });
      await waitFor(() => expect(renderedRows()).toBe(15));
      expect(queryByTestId(SENTINEL)).toBeNull();
    } finally {
      restore();
    }
  });

  it("renders a short list whole, with no sentinel to scroll toward", () => {
    const conversations = manyConversations(4, "짧은");
    const { queryByTestId, restore } = renderSidebar({
      sessions: conversations,
      currentSessionId: "짧은-0",
    });
    try {
      for (const session of conversations) {
        expect(queryByTestId(`sidebar-session-${session.id}`)).toBeTruthy();
      }
      expect(queryByTestId(SENTINEL)).toBeNull();
    } finally {
      restore();
    }
  });

  it("pages the list that survives the archive filter, and follows it back down when it shrinks", async () => {
    const conversations = manyConversations(15, "보관");
    const archived = new Set(["보관-1", "보관-3", "보관-5"]);
    const { getByTestId, queryByTestId, restore } = renderSidebar({
      sessions: conversations,
      currentSessionId: "보관-0",
      conversationActions: {
        isArchived: (id: string) => archived.has(id),
        isUnread: () => false,
        isResponding: () => false,
        onRename: vi.fn(),
        onSetArchived: vi.fn(),
        onSetUnread: vi.fn(),
        onShare: vi.fn(),
        onCopy: vi.fn(),
        onDelete: vi.fn(),
      },
    });
    try {
      const renderedRows = () => countRenderedRows(conversations, queryByTestId);

      // A page is a page of rows the reader can SEE: the archived rows leave the list before it is paged, so the first page is
      // six visible rows and not six minus whatever was archived among them.
      expect(renderedRows()).toBe(6);
      expect(queryByTestId("sidebar-session-보관-1")).toBeNull();
      expect(queryByTestId("sidebar-session-보관-6")).not.toBeNull();

      fireEvent.click(getByTestId("sidebar-toggle-archived"));
      await act(async () => {
        triggerIntersection(getByTestId(SENTINEL));
      });
      await waitFor(() => expect(renderedRows()).toBe(15));

      // Hiding them again shortens the list under the window. What is rendered follows the list that exists now — the count from
      // the longer one is not carried over, and nothing is left asking for rows that are gone.
      fireEvent.click(getByTestId("sidebar-toggle-archived"));
      await waitFor(() => expect(renderedRows()).toBe(12));
      expect(queryByTestId(SENTINEL)).toBeNull();
    } finally {
      restore();
    }
  });

  it("gives each project group its own page and a control that opens the rest", async () => {
    const THIRD_ROOT = "C:\\Users\\example\\workspace\\ave-project\\third-app";
    const conversations = [
      ...manyConversations(9, "프로젝트", { projectRoot: OTHER_ROOT, projectName: "other-app" }),
      ...manyConversations(9, "이웃", { projectRoot: THIRD_ROOT, projectName: "third-app" }),
    ];
    const otherRows = conversations.filter((session) => session.projectRoot === OTHER_ROOT);
    const thirdRows = conversations.filter((session) => session.projectRoot === THIRD_ROOT);
    const { getByTestId, queryByTestId, restore } = renderSidebar({
      sessions: conversations,
      currentSessionId: "프로젝트-0",
      projects: [
        {
          projectRoot: "C:\\Users\\example\\workspace\\ave-project\\ave",
          projectName: "ave",
          isDefault: true,
        },
        { projectRoot: OTHER_ROOT, projectName: "other-app" },
        { projectRoot: THIRD_ROOT, projectName: "third-app" },
      ],
    });
    const moreId = "sidebar-project-sessions-more-C-Users-example-workspace-ave-project-other-app";
    try {
      // Each group shows one page so a long conversation list cannot push
      // sibling projects below the fold.
      await waitFor(() => expect(countRenderedRows(otherRows, queryByTestId)).toBe(6));
      expect(countRenderedRows(thirdRows, queryByTestId)).toBe(6);

      const more = getByTestId(moreId);
      expect(more.tagName).toBe("BUTTON");
      expect(more).toHaveAttribute("aria-expanded", "false");
      expect(more.textContent).toContain("3");

      fireEvent.click(more);
      expect(countRenderedRows(otherRows, queryByTestId)).toBe(9);
      expect(getByTestId(moreId)).toHaveAttribute("aria-expanded", "true");
      // One group opening says nothing about its neighbours.
      expect(countRenderedRows(thirdRows, queryByTestId)).toBe(6);

      fireEvent.click(getByTestId(moreId));
      expect(countRenderedRows(otherRows, queryByTestId)).toBe(6);
      expect(getByTestId(moreId)).toHaveAttribute("aria-expanded", "false");
    } finally {
      restore();
    }
  });
});

describe("Sidebar view rows", () => {
  async function featuresRow(getByTestId: (id: string) => HTMLElement, rowTestId: string) {
    fireEvent.click(getByTestId("sidebar-group-features"));
    return await waitFor(() => {
      const row = document.querySelector<HTMLButtonElement>(`[data-testid="${rowTestId}"]`);
      expect(row).not.toBeNull();
      return row!;
    });
  }

  it("names both destinations in the row's own menu", async () => {
    const onSelect = vi.fn();
    const onSelectInNewPane = vi.fn();
    const { getByTestId, showNativeContextMenu, emitNativeContextCommand, restore } =
      renderSidebar({ onSelect, onSelectInNewPane });
    try {
      const row = await featuresRow(getByTestId, "sidebar-routines");
      fireEvent.contextMenu(row);

      // Both commands are offered, so the second destination is discoverable without anyone having been told about a modifier
      // chord.
      const payload = showNativeContextMenu.mock.calls.at(-1)?.[0];
      expect(payload?.kind).toBe("view-row");
      expect(payload?.commands).toEqual(["view.open", "view.open-in-new-pane"]);

      act(() => emitNativeContextCommand("view.open-in-new-pane"));
      expect(onSelectInNewPane).toHaveBeenCalledWith("routines");
      expect(onSelect).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("offers only the one destination where there is no second pane to open into", async () => {
    // A narrow canvas withholds the callback entirely, and the row has to follow: a menu row that cannot go anywhere is worse than
    // no menu row.
    const onSelect = vi.fn();
    const { getByTestId, showNativeContextMenu, emitNativeContextCommand, restore } =
      renderSidebar({ onSelect });
    try {
      const row = await featuresRow(getByTestId, "sidebar-routines");
      fireEvent.contextMenu(row);
      expect(showNativeContextMenu.mock.calls.at(-1)?.[0]?.commands).toEqual(["view.open"]);

      act(() => emitNativeContextCommand("view.open"));
      expect(onSelect).toHaveBeenCalledWith("routines");
    } finally {
      restore();
    }
  });

  it("routes a modifier-click to the new pane and a plain click to the focused one", async () => {
    const onSelect = vi.fn();
    const onSelectInNewPane = vi.fn();
    const { getByTestId, restore } = renderSidebar({ onSelect, onSelectInNewPane });
    try {
      const row = await featuresRow(getByTestId, "sidebar-routines");
      fireEvent.click(row, { metaKey: true });
      expect(onSelectInNewPane).toHaveBeenCalledWith("routines");
      expect(onSelect).not.toHaveBeenCalled();

      const again = await featuresRow(getByTestId, "sidebar-routines");
      fireEvent.click(again);
      expect(onSelect).toHaveBeenCalledWith("routines");
      expect(onSelectInNewPane).toHaveBeenCalledTimes(1);
    } finally {
      restore();
    }
  });
});

describe("Sidebar — every conversation family", () => {
  const mainRow: SessionSummary = sessionRow({
    id: "sess-1",
    title: "전체 동기화로 상태 파악",
    modifiedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
  });
  const routineRow: SessionSummary = sessionRow({
    id: "routine-run-1",
    title: "아침 브리핑",
    modifiedAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
    sessionKind: "routine",
    routineId: "rt-1",
    routineTitle: "아침 브리핑",
    routineFiredAt: new Date(Date.now() - 30 * 60 * 1000).toISOString(),
  });
  const workBoardRow: SessionSummary = sessionRow({
    id: "sub-wb-1",
    title: "월간 보고서 초안",
    modifiedAt: new Date().toISOString(),
    sessionKind: "subagent",
    workBoardItemId: 7,
  });
  const sideChatRow: SessionSummary = sessionRow({
    id: "side-1",
    title: "환경 변수 확인",
    modifiedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    family: "side-chat",
    originSessionId: "sess-1",
  });
  const orphanSideChatRow: SessionSummary = sessionRow({
    id: "side-orphan",
    title: "부모 없는 사이드 챗",
    modifiedAt: new Date(Date.now() - 5 * 60 * 1000).toISOString(),
    family: "side-chat",
  });

  const allRows = [workBoardRow, routineRow, sideChatRow, orphanSideChatRow, mainRow];

  it("lists a row per family, with a chat glyph and its accessible family label", async () => {
    const { getByTestId, restore } = renderSidebar({ sessions: allRows });
    try {
      await waitFor(() => getByTestId("sidebar-session-sess-1"));
      const glyphFamily = (id: string) =>
        getByTestId(`sidebar-conversation-glyph-${id}`).getAttribute("data-session-family");
      expect(glyphFamily("sess-1")).toBe("main");
      expect(glyphFamily("routine-run-1")).toBe("routine");
      expect(glyphFamily("sub-wb-1")).toBe("work-board");
      expect(glyphFamily("side-1")).toBe("side-chat");

      // The chat glyph stays unnamed; every other family names itself.
      expect(getByTestId("sidebar-conversation-glyph-sess-1").getAttribute("aria-hidden")).toBe("true");
      expect(getByTestId("sidebar-conversation-glyph-routine-run-1").getAttribute("aria-label")).toBe("루틴 실행");
      expect(getByTestId("sidebar-conversation-glyph-sub-wb-1").getAttribute("aria-label")).toBe("워크보드 작업");
      expect(getByTestId("sidebar-conversation-glyph-side-1").getAttribute("aria-label")).toBe("사이드 챗");
    } finally {
      restore();
    }
  });

  it("keeps every non-main row read-only — no drag, no pin, no active state", async () => {
    const { getByTestId, queryByTestId, restore } = renderSidebar({ sessions: allRows });
    try {
      await waitFor(() => getByTestId("sidebar-session-sess-1"));
      expect(getByTestId("sidebar-session-sess-1").getAttribute("draggable")).toBe("true");
      for (const id of ["routine-run-1", "sub-wb-1", "side-1"]) {
        const button = getByTestId(`sidebar-session-${id}`);
        expect(button.getAttribute("draggable")).toBe("false");
        expect(button.getAttribute("aria-current")).toBeNull();
        expect(queryByTestId(`sidebar-session-pin-${id}`)).toBeNull();
      }
    } finally {
      restore();
    }
  });

  it("offers only 'open' in a non-main row's context menu", async () => {
    const { getByTestId, showNativeContextMenu, restore } = renderSidebar({ sessions: allRows });
    try {
      await waitFor(() => getByTestId("sidebar-session-sub-wb-1"));
      fireEvent.contextMenu(getByTestId("sidebar-session-sub-wb-1"));
      await waitFor(() => {
        expect(showNativeContextMenu).toHaveBeenCalledWith(expect.objectContaining({
          kind: "conversation",
          commands: ["conversation.open"],
        }));
      });
    } finally {
      restore();
    }
  });

  it("opens a routine run through the ordinary session-load path", async () => {
    const { getByTestId, onLoadSession, restore } = renderSidebar({ sessions: allRows });
    try {
      await waitFor(() => getByTestId("sidebar-session-routine-run-1"));
      fireEvent.click(getByTestId("sidebar-session-routine-run-1"));
      expect(onLoadSession).toHaveBeenCalledWith("routine-run-1");
    } finally {
      restore();
    }
  });

  it("opens a work-board row on the board, never as a chat", async () => {
    const onOpenWorkBoardItem = vi.fn();
    const { getByTestId, onLoadSession, restore } = renderSidebar({
      sessions: allRows,
      onOpenWorkBoardItem,
    });
    try {
      await waitFor(() => getByTestId("sidebar-session-sub-wb-1"));
      fireEvent.click(getByTestId("sidebar-session-sub-wb-1"));
      expect(onOpenWorkBoardItem).toHaveBeenCalledWith(7);
      expect(onLoadSession).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it("keeps side chats flat and opens them with their origin session", async () => {
    const onOpenSideChat = vi.fn();
    const { getByTestId, onLoadSession, restore } = renderSidebar({
      sessions: allRows,
      onOpenSideChat,
    });
    try {
      const list = getByTestId("sidebar-unassigned-sessions");
      expect(list.contains(getByTestId("sidebar-session-sess-1"))).toBe(true);
      expect(list.contains(getByTestId("sidebar-session-side-1"))).toBe(true);
      expect(list.querySelector('[data-testid^="sidebar-conversation-tree-"]')).toBeNull();

      fireEvent.click(getByTestId("sidebar-session-side-1"));
      expect(onOpenSideChat).toHaveBeenCalledWith("side-1", "sess-1");
      expect(onLoadSession).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it.each(["terminal", "browser"] as const)("nests a host-bound %s chat only under its surface and preserves pane routing", async (kind) => {
    const onOpenSideChat = vi.fn();
    const onOpenPaneChat = vi.fn();
    const tabId = kind + ":pane-chat";
    const root = "/projects/pane-chat";
    const browserTabs = {
      getSessionBindings: async () => ({ revision: 1, bindings: [{ sessionId: sideChatRow.id, browserTabIds: kind === "browser" ? [tabId] : [], terminalTabIds: kind === "terminal" ? [tabId] : [] }] }),
      onSessionBindingsChanged: () => () => {},
    } as unknown as AveApi["browserTabs"];
    const { getByTestId, getAllByTestId, onLoadSession, restore } = renderSidebar({
      sessions: [{ ...sideChatRow, paneTabId: tabId, projectRoot: root }],
      projects: [{ projectRoot: root, projectName: "Pane project" }],
      mainSurfaces: [{ tabId, kind, ordinal: 1, url: null }],
      onOpenSideChat, onOpenPaneChat,
    }, { browserTabs });
    try {
      await waitFor(() => expect(getByTestId("sidebar-surface-chats-" + tabId).contains(getByTestId("sidebar-session-side-1"))).toBe(true));
      expect(getAllByTestId("sidebar-session-side-1")).toHaveLength(1);
      expect(getAllByTestId("sidebar-surface-" + tabId)).toHaveLength(1);
      expect(getByTestId("sidebar-session-side-1").closest(`[data-testid="sidebar-surface-tree-${tabId}"]`)).toBe(getByTestId("sidebar-surface-tree-" + tabId));
      fireEvent.click(getByTestId("sidebar-session-side-1"));
      expect(onOpenPaneChat).toHaveBeenCalledWith(tabId);
      expect(onOpenSideChat).not.toHaveBeenCalled();
      expect(onLoadSession).not.toHaveBeenCalled();
    } finally { restore(); }
  });

  it("hides pane rows and provenance while the host binding snapshot is loading", async () => {
    const tabId = "terminal:loading";
    let resolveBindings!: (state: SessionTabBindingsState) => void;
    const snapshot = new Promise<SessionTabBindingsState>((resolve) => { resolveBindings = resolve; });
    const browserTabs = {
      getSessionBindings: () => snapshot,
      onSessionBindingsChanged: () => () => {},
    } as unknown as AveApi["browserTabs"];
    const view = renderSidebar({ sessions: [{ ...sideChatRow, paneTabId: tabId }], mainSurfaces: [{ tabId, kind: "terminal", ordinal: 1, url: null }] }, { browserTabs });
    try {
      expect(view.queryByText("이전 터미널 채팅")).toBeNull();
      expect(view.queryByTestId("sidebar-session-side-1")).toBeNull();
      await act(async () => resolveBindings({ revision: 1, bindings: [{ sessionId: sideChatRow.id, browserTabIds: [], terminalTabIds: [tabId] }] }));
      expect(view.getByTestId("sidebar-surface-chats-" + tabId).contains(view.getByTestId("sidebar-session-side-1"))).toBe(true);
      expect(view.queryByText("이전 터미널 채팅")).toBeNull();
    } finally { view.restore(); }
  });

  it("omits a globally listed unarchived pane chat outside this window instead of calling it former", async () => {
    const browserTabs = {
      getSessionBindings: vi.fn(async () => ({ revision: 1, bindings: [] })),
      onSessionBindingsChanged: () => () => {},
    } as unknown as AveApi["browserTabs"];
    const view = renderSidebar({ sessions: [{ ...sideChatRow, paneTabId: "terminal:other-window" }] }, { browserTabs });
    try {
      await act(async () => {});
      expect(view.queryByText("이전 터미널 채팅")).toBeNull();
      expect(view.queryByTestId("sidebar-session-side-1")).toBeNull();
    } finally { view.restore(); }
  });

  it("keeps the archive toggle reachable for a closed pane chat scoped only to a project", async () => {
    const root = "/projects/closed-pane";
    const onOpenSideChat = vi.fn();
    const browserTabs = {
      getSessionBindings: async () => ({ revision: 1, bindings: [] }),
      onSessionBindingsChanged: () => () => {},
    } as unknown as AveApi["browserTabs"];
    const view = renderSidebar({ sessions: [{ ...sideChatRow, projectRoot: root, paneTabId: "terminal:closed", archivedAt: "2026-10-29T00:00:00Z" }], projects: [{ projectRoot: root, projectName: "Closed pane project" }], onOpenSideChat }, { browserTabs });
    try {
      await act(async () => {});
      expect(view.queryByTestId("sidebar-session-side-1")).toBeNull();
      fireEvent.click(view.getByTestId("sidebar-toggle-archived"));
      expect(view.getByTestId("sidebar-projects").textContent).toContain("이전 터미널 채팅");
      fireEvent.click(view.getByTestId("sidebar-session-side-1"));
      expect(onOpenSideChat).toHaveBeenCalledWith("side-1", "sess-1");
      fireEvent.click(view.getByTestId("sidebar-toggle-archived"));
      expect(view.queryByTestId("sidebar-session-side-1")).toBeNull();
    } finally { view.restore(); }
  });

  it.each(["ko", "en"])("archives an ended binding behind the toggle with an openable provenance row in %s", async (locale) => {
    let update!: (state: SessionTabBindingsState) => void;
    const tabId = "terminal:closed";
    const browserTabs = {
      getSessionBindings: async () => ({ revision: 1, bindings: [{ sessionId: sideChatRow.id, browserTabIds: [], terminalTabIds: [tabId] }] }),
      onSessionBindingsChanged: (handler: typeof update) => { update = handler; return () => {}; },
    } as unknown as AveApi["browserTabs"];
    const onOpenSideChat = vi.fn();
    const onOpenPaneChat = vi.fn();
    const suiteLocale = getLocale();
    const session: SessionSummary = { ...sideChatRow, paneTabId: tabId };
    const conversationActions = { isArchived: () => Boolean(session.archivedAt), isUnread: () => false, isResponding: () => false,
      onRename: vi.fn(), onSetArchived: vi.fn(), onSetUnread: vi.fn(), onShare: vi.fn(), onCopy: vi.fn(), onDelete: vi.fn() };
    const view = renderSidebar({ sessions: [session], mainSurfaces: [{ tabId, kind: "terminal", ordinal: 1, url: null }], onOpenSideChat, onOpenPaneChat, conversationActions }, { browserTabs, locale });
    try {
      await waitFor(() => view.getByTestId("sidebar-surface-chats-" + tabId));
      act(() => {
        session.archivedAt = "2026-10-29T00:00:00Z";
        update({ revision: 2, bindings: [] });
      });
      expect(view.queryByTestId("sidebar-surface-chats-" + tabId)).toBeNull();
      expect(view.queryByTestId("sidebar-session-side-1")).toBeNull();
      fireEvent.click(view.getByTestId("sidebar-toggle-archived"));
      expect(view.getByTestId("sidebar-unassigned-sessions").textContent).toContain(locale === "ko" ? "이전 터미널 채팅" : "Former terminal chat");
      expect(view.getByTestId("sidebar-surface-tree-" + tabId).contains(view.getByTestId("sidebar-session-side-1"))).toBe(false);
      fireEvent.click(view.getByTestId("sidebar-session-side-1"));
      expect(onOpenSideChat).toHaveBeenCalledWith("side-1", "sess-1");
      expect(onOpenPaneChat).not.toHaveBeenCalled();
    } finally { view.restore(); setRuntimeLocale(suiteLocale); }
  });

  it("omits a renderer-only pane claim without a host binding", () => {
    const tabId = "terminal:unbound";
    const onOpenPaneChat = vi.fn();
    const view = renderSidebar({ sessions: [{ ...sideChatRow, paneTabId: tabId }], mainSurfaces: [{ tabId, kind: "terminal", ordinal: 1, url: null }], onOpenPaneChat });
    try {
      expect(view.queryByTestId("sidebar-surface-chats-" + tabId)).toBeNull();
      expect(view.queryByTestId("sidebar-session-side-1")).toBeNull();
      expect(onOpenPaneChat).not.toHaveBeenCalled();
    } finally { view.restore(); }
  });

  it("lists a side chat whose conversation is not here at the top level", async () => {
    const { getByTestId, queryByTestId, restore } = renderSidebar({ sessions: allRows });
    try {
      await waitFor(() => getByTestId("sidebar-session-side-orphan"));
      // No parent row means no tree wrapper — the row stands on its own line, still carrying the side-chat glyph.
      expect(queryByTestId("sidebar-conversation-tree-side-orphan")).toBeNull();
      expect(
        getByTestId("sidebar-conversation-glyph-side-orphan").getAttribute("data-session-family"),
      ).toBe("side-chat");
      expect(
        getByTestId("sidebar-unassigned-sessions").contains(getByTestId("sidebar-session-side-orphan")),
      ).toBe(true);
    } finally {
      restore();
    }
  });
});

describe("Sidebar — the dedicated Suggestions conversation", () => {
  it("names its row from the catalog, ignoring a stored title, and counts the suggestions waiting there", async () => {
    const { getByTestId, queryByTestId, restore } = renderSidebar({
      sessions: [
        // A title stored by an earlier build or a rename is ignored for this id.
        sessionRow({ id: SUGGESTIONS_SESSION_ID, title: "Inbox", modifiedAt: new Date().toISOString() }),
        sessionRow({ id: "sess-2", title: "다른 대화", modifiedAt: new Date(Date.now() - 3600_000).toISOString() }),
      ],
      pendingAnswerSessionIds: new Set([SUGGESTIONS_SESSION_ID]),
      suggestionsPendingCount: 3,
    });
    try {
      await waitFor(() => getByTestId(`sidebar-session-${SUGGESTIONS_SESSION_ID}`));
      const row = getByTestId(`sidebar-session-${SUGGESTIONS_SESSION_ID}`);
      expect(row.textContent).toContain("제안");
      expect(row.textContent).not.toContain("Inbox");
      const badge = getByTestId(`sidebar-pending-count-${SUGGESTIONS_SESSION_ID}`);
      expect(row.contains(badge)).toBe(true);
      expect(badge.textContent).toBe("3");
      expect(badge.getAttribute("aria-label")).toBe("대기 중인 제안 3개");
      // The count stands in for the dot on that row; other rows carry none.
      expect(queryByTestId(`sidebar-pending-answer-${SUGGESTIONS_SESSION_ID}`)).toBeNull();
      expect(queryByTestId("sidebar-pending-count-sess-2")).toBeNull();
    } finally {
      restore();
    }
  });
});

describe("Sidebar pending-answer dot", () => {
  const sideChat: SessionSummary = sessionRow({
    id: "side-1",
    title: "환경 변수 확인",
    modifiedAt: new Date(Date.now() - 10 * 60 * 1000).toISOString(),
    family: "side-chat",
    originSessionId: "sess-1",
  });
  const routine: SessionSummary = sessionRow({
    id: "routine-run-1",
    title: "아침 브리핑",
    modifiedAt: new Date(Date.now() - 20 * 60 * 1000).toISOString(),
    family: "routine",
  });

  it("marks exactly the rows the window says are parked on an answer, whatever their family", async () => {
    const { getByTestId, queryByTestId, restore } = renderSidebar({
      sessions: [
        sessionRow({ id: "sess-1", title: "현재", modifiedAt: new Date().toISOString() }),
        sessionRow({ id: "sess-2", title: "다른 대화", modifiedAt: new Date(Date.now() - 3600_000).toISOString() }),
        sideChat,
        routine,
      ],
      pendingAnswerSessionIds: new Set(["sess-1", "side-1", "routine-run-1"]),
    });
    try {
      await waitFor(() => getByTestId("sidebar-session-sess-1"));
      // The conversation and its side chat both carry the dot: a card
      // parked in the side chat is news about the conversation it belongs to.
      const tree = getByTestId("sidebar-unassigned-sessions");
      expect(tree.contains(getByTestId("sidebar-pending-answer-sess-1"))).toBe(true);
      expect(tree.contains(getByTestId("sidebar-pending-answer-side-1"))).toBe(true);
      expect(getByTestId("sidebar-pending-answer-routine-run-1")).toBeTruthy();
      expect(queryByTestId("sidebar-pending-answer-sess-2")).toBeNull();
      expect(getByTestId("sidebar-pending-answer-sess-1").getAttribute("aria-label")).toBe("답변 대기 중");
      // Inside the row's button, so the way to the card is the row itself.
      expect(getByTestId("sidebar-session-sess-1").contains(getByTestId("sidebar-pending-answer-sess-1"))).toBe(true);
    } finally {
      restore();
    }
  });

  it("marks the Plugins group while a request outside every conversation waits, expanded and collapsed", () => {
    const expanded = renderSidebar({
      failedPluginCards: [FAILED_PLUGIN_CARD],
      pluginRequestPending: true,
    });
    try {
      const dot = expanded.getByTestId("sidebar-group-plugins-pending-answer");
      expect(expanded.getByTestId("sidebar-group-plugins").contains(dot)).toBe(true);
    } finally {
      expanded.restore();
      cleanup();
    }
    const collapsed = renderSidebar({
      collapsed: true,
      failedPluginCards: [FAILED_PLUGIN_CARD],
      pluginRequestPending: true,
    });
    try {
      expect(collapsed.getByTestId("sidebar-group-plugins").contains(
        collapsed.getByTestId("sidebar-group-plugins-pending-answer"),
      )).toBe(true);
    } finally {
      collapsed.restore();
      cleanup();
    }
    const quiet = renderSidebar({ failedPluginCards: [FAILED_PLUGIN_CARD] });
    try {
      expect(quiet.queryByTestId("sidebar-group-plugins-pending-answer")).toBeNull();
    } finally {
      quiet.restore();
    }
  });
});
