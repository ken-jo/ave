// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
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
  DynamicNativeMenuAction,
  DynamicNativeMenuPayload,
  NativeContextMenuAction,
  NativeContextMenuPayload,
} from "../../../../shared/native-context-menu.js";
import { setTerminalExited } from "../../preview/terminal-attention.js";

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
  const dynamicMenuHandlers = new Set<(action: DynamicNativeMenuAction) => void>();
  const showDynamicMenu = vi.fn(async (_payload: DynamicNativeMenuPayload) => ({ ok: true as const }));
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
    projectName: (project) => project.isDefault ? "기본 프로젝트" : project.projectName,
    onSelectProjectRoot: vi.fn(),
    onSelectAllProjects: vi.fn(),
    onProjectAdded: vi.fn(),
    onLaunch: vi.fn(),
    onRemoveProject: vi.fn(),
    // The all-projects view with every group open shows every row these tests read; a test about one project selects it.
    projectSelection: { kind: "all" },
    isProjectExpanded: () => true,
    onSetProjectExpanded: vi.fn(),
    collapsed: false,
    onToggleCollapse: vi.fn(),
    onOpenUnifiedSearch: vi.fn(),
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
      showDynamicMenu,
      onDynamicMenuAction: (handler: (action: DynamicNativeMenuAction) => void) => {
        dynamicMenuHandlers.add(handler);
        return () => {
          dynamicMenuHandlers.delete(handler);
        };
      },
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
    showDynamicMenu,
    chooseDynamicMenuItem: (id: string) => {
      const payload = showDynamicMenu.mock.calls.at(-1)?.[0];
      if (!payload) throw new Error("dynamic menu was not requested");
      for (const handler of dynamicMenuHandlers) handler({ requestId: payload.requestId, id });
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

/** The 기본 프로젝트's group in the all-projects tree: conversations without an open project live there (case 05). */
const DEFAULT_GROUP = "sidebar-project-group-C-Users-example-workspace-ave-project-ave";
const OTHER_GROUP = "sidebar-project-group-C-Users-example-workspace-ave-project-other-app";

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

  it("files conversations without a project under the 기본 프로젝트 group and project conversations under their own", async () => {
    const { getByTestId, getByText, queryByTestId, restore } = renderSidebar();
    try {
      expect(queryByTestId("sidebar-current-project")).toBeNull();
      const defaultGroup = getByTestId(DEFAULT_GROUP);
      expect(defaultGroup.textContent).toContain("전체 동기화로 상태 파악");
      expect(defaultGroup.textContent).toContain("사이드 패널 개선");
      expect(getByTestId("sidebar-session-sess-1").getAttribute("aria-current")).toBe("page");
      expect(getByTestId("sidebar-project-C-Users-example-workspace-ave-project-other-app").textContent).toContain("other-app");
      expect(getByTestId(OTHER_GROUP).contains(getByText("다른 프로젝트 대화"))).toBe(true);
      expect(defaultGroup.textContent).not.toContain("다른 프로젝트 대화");
    } finally {
      restore();
    }
  });

  it("keeps a conversation whose project was removed under the 기본 프로젝트, without resurrecting its project", async () => {
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
      expect(getByTestId("sidebar-project-group-C-Users-example-workspace-default").textContent).toContain("보존된 일반 대화");
      expect(queryByTestId("sidebar-project-C-Users-example-workspace-deleted-project")).toBeNull();
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

  it("starts a new conversation in a group's project from its + button, and folds the group from its row", async () => {
    const onSetProjectExpanded = vi.fn();
    const { getByTestId, onNewChatForProject, restore } = renderSidebar({ onSetProjectExpanded });
    try {
      fireEvent.click(getByTestId("sidebar-project-new-C-Users-example-workspace-ave-project-other-app"));
      expect(onNewChatForProject).toHaveBeenCalledWith({
        projectRoot: "C:\\Users\\example\\workspace\\ave-project\\other-app",
        projectName: "other-app",
      });
      expect(onSetProjectExpanded).not.toHaveBeenCalled();
      fireEvent.click(getByTestId("sidebar-project-toggle-C-Users-example-workspace-ave-project-other-app"));
      expect(onSetProjectExpanded).toHaveBeenCalledWith("C:\\Users\\example\\workspace\\ave-project\\other-app", false);
    } finally {
      restore();
    }
  });

});

describe("Sidebar legacy default-root session handling", () => {
  // Production reads scrub legacy default-root metadata; this fixture exercises the renderer boundary independently.
  it("files a session tagged with the default project root under the 기본 프로젝트, not under a phantom 'workspace' group", async () => {
    const DEFAULT_ROOT = "C:\\Users\\example\\workspace\\ave-project\\ave";
    const legacySession: SessionSummary = sessionRow({
      id: "legacy-session",
      title: "레거시 기본 프로젝트 대화",
      modifiedAt: new Date().toISOString(),
      projectRoot: DEFAULT_ROOT,
      projectName: "workspace",
    });
    const { getByTestId, getAllByRole, restore } = renderSidebar({
      sessions: [legacySession],
      currentSessionId: "legacy-session",
    });
    try {
      expect(getByTestId(DEFAULT_GROUP).textContent).toContain("레거시 기본 프로젝트 대화");
      // Two groups — the 기본 프로젝트, named as such, and other-app — and no third one made from the session's own name.
      const groups = getAllByRole("treeitem").filter((row) => row.getAttribute("aria-level") === "1");
      expect(groups.map((row) => row.getAttribute("data-testid"))).toEqual([
        "sidebar-project-C-Users-example-workspace-ave-project-ave",
        "sidebar-project-C-Users-example-workspace-ave-project-other-app",
      ]);
      expect(groups[0]!.textContent).toContain("기본 프로젝트");
      expect(groups[0]!.textContent).not.toContain("workspace");
    } finally {
      restore();
    }
  });

});

describe("Sidebar stacked sections", () => {
  it("draws one tree, with the 기본 프로젝트 group first and no tab controls", () => {
    const { getByTestId, getByRole, queryByTestId, restore } = renderSidebar();
    try {
      const tree = getByRole("tree");
      expect(tree.getAttribute("aria-label")).toBe("전체 프로젝트 항목");
      expect(getByTestId("sidebar-sections").querySelector('[role="tablist"]')).toBeNull();
      expect(queryByTestId("sidebar-tabs")).toBeNull();
      const groupRows = [...tree.querySelectorAll('[role="treeitem"][aria-level="1"]')].map((row) => row.getAttribute("data-testid"));
      expect(groupRows).toEqual([
        "sidebar-project-C-Users-example-workspace-ave-project-ave",
        "sidebar-project-C-Users-example-workspace-ave-project-other-app",
      ]);
    } finally { restore(); }
  });

  it("files a main-area surface by its own project, whichever conversation it is bound to", async () => {
    const root = "/projects/example";
    const sessions = [
      sessionRow({ id: "project-chat", title: "Project chat", projectRoot: root, modifiedAt: new Date().toISOString() }),
      sessionRow({ id: "general-chat", title: "General chat", modifiedAt: new Date().toISOString() }),
    ];
    const mainSurfaces: MainSurface[] = [
      { tabId: "browser:project", kind: "browser", ordinal: 1, url: "https://project.example/", projectRoot: root },
      { tabId: "browser:child", kind: "browser", ordinal: 3, url: "https://child.example/", projectRoot: root },
      { tabId: "terminal:project", kind: "terminal", ordinal: 1, url: null, projectRoot: root },
      { tabId: "browser:general", kind: "browser", ordinal: 2, url: null, projectRoot: "/ws" },
      { tabId: "terminal:general", kind: "terminal", ordinal: 2, url: null, projectRoot: "/ws" },
      { tabId: "terminal:unknown", kind: "terminal", ordinal: 3, url: null, projectRoot: "/ws" },
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
      sessions, projects: [{ projectRoot: "/ws", projectName: "ws", isDefault: true }, { projectRoot: root, projectName: "Example" }], mainSurfaces, onOpenSurface,
    }, { browserTabs: api.browserTabs });
    try {
      act(() => noteWebSurfaceFavicon("browser:project", BROWSER_FAVICON_DATA_URL));
      const project = getByTestId("sidebar-project-group-projects-example");
      const general = getByTestId("sidebar-project-group-ws");
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
      // The surface's own project decides, not the conversation that holds it now.
      act(() => receiveControl({ revision: 2, tabs: state.tabs.map((tab) => ({ ...tab, owner: { sessionId: "general-chat" } })) }));
      expect(project.contains(getByTestId("sidebar-surface-browser:project"))).toBe(true);
      expect(getByTestId("sidebar-surface-browser:project").querySelector("img")?.getAttribute("src")).toBe(BROWSER_FAVICON_DATA_URL);
      act(() => receiveBindings({ revision: 2, bindings: [{ sessionId: "general-chat", browserTabIds: [], terminalTabIds: ["terminal:project"] }] }));
      expect(project.contains(getByTestId("sidebar-surface-terminal:project"))).toBe(true);
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
      { tabId: "browser:icon", kind: "browser", ordinal: 1, url: "https://a.example/", projectRoot: "/ws" },
      { tabId: "browser:blank", kind: "browser", ordinal: 2, url: null, projectRoot: "/ws" },
      { tabId: "browser:unsafe", kind: "browser", ordinal: 3, url: "file:///private/example", projectRoot: "/ws" },
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
      expect(queryByTestId("sidebar-surface-browser:icon")).toBeNull();
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
      { tabId: "browser:long", kind: "browser", ordinal: 1, url: `https://example.test/${"long-path".repeat(50)}`, projectRoot: "/ws" },
      { tabId: "terminal:long", kind: "terminal", ordinal: 1, url: null, projectRoot: "/ws" },
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
      const unassigned = getByTestId(DEFAULT_GROUP);
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
      let unassigned = getByTestId(DEFAULT_GROUP);
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
            onRemoveProject={vi.fn()}
            onSelect={vi.fn()}
            pluginViews={[]}
            hasApiKey
            onOpenSettings={vi.fn()}
            projectName={(project) => project.projectName}
            onSelectProjectRoot={vi.fn()}
            onSelectAllProjects={vi.fn()}
            onProjectAdded={vi.fn()}
            onLaunch={vi.fn()}
            projectSelection={{ kind: "all" }}
            isProjectExpanded={() => true}
            onSetProjectExpanded={vi.fn()}
            projects={[{ projectRoot: "C:\\Users\\example\\workspace\\ave-project\\ave", projectName: "ave", isDefault: true }]}
            collapsed={false}
            onToggleCollapse={vi.fn()}
            onOpenUnifiedSearch={vi.fn()}
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
      unassigned = getByTestId(DEFAULT_GROUP);
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

  it("hands 프로젝트 제거 to the app with the project, and offers it for no 기본 프로젝트 (case 29)", async () => {
    const onRemoveProject = vi.fn();
    const defaultProject: ProjectIdentity = { projectRoot: "C:\\Users\\example\\workspace\\ave-project\\ave", projectName: "ave", isDefault: true };
    const { container, getByTestId, showNativeContextMenu, emitNativeContextCommand, removeRoot, restore } = renderSidebar({
      sessions: [], projects: [defaultProject, ...projects], onRemoveProject,
    });
    try {
      fireEvent.contextMenu(await waitFor(() => getByTestId("sidebar-project-C-Users-example-workspace-ave-project-alpha")));
      emitNativeContextCommand("project.remove");
      expect(onRemoveProject).toHaveBeenCalledWith(expect.objectContaining({ projectRoot: "C:\\Users\\example\\workspace\\ave-project\\alpha" }));
      // The sidebar removes nothing itself: the app previews and confirms first.
      expect(removeRoot).not.toHaveBeenCalled();

      showNativeContextMenu.mockClear();
      const defaultRow = [...container.querySelectorAll<HTMLElement>('[role="treeitem"][data-testid^="sidebar-project-"]')]
        .find((row) => row.textContent?.includes("기본 프로젝트"));
      expect(defaultRow).toBeDefined();
      fireEvent.contextMenu(defaultRow!);
      expect(showNativeContextMenu).toHaveBeenCalledWith(expect.objectContaining({ kind: "project" }));
      expect(showNativeContextMenu.mock.calls[0]?.[0].commands).not.toContain("project.remove");
    } finally {
      restore();
    }
  });
  it("sorts a pinned project's group ahead of the others", async () => {
    const { getByTestId, restore } = renderSidebar({
      sessions: [],
      projects,
      isProjectPinned: (root) => root === "C:\\Users\\example\\workspace\\ave-project\\beta",
      onToggleProjectPin: vi.fn(),
    });
    try {
      const rows = Array.from(getByTestId("sidebar-tree").querySelectorAll('[role="treeitem"][aria-level="1"]'));
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

  it("offers add-project when the all-projects list's empty area is right-clicked, and adds through workspace.pickRoot", async () => {
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
      const tabBody = await waitFor(() => getByTestId("sidebar-sections"));
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

  it("switches to nothing when the folder dialog is dismissed, and reports an add that names no folder", async () => {
    const onRefreshProjects = vi.fn();
    const onProjectAdded = vi.fn();
    const onProjectError = vi.fn();
    const { getByTestId, emitNativeContextCommand, pickRoot, restore } = renderSidebar({
      sessions: [], projects, onRefreshProjects, onProjectAdded, onProjectError,
    });
    try {
      // Main answers a dismissed dialog with the current roots and `canceled`.
      pickRoot.mockResolvedValueOnce({ ok: true, canceled: true, roots: [{ path: "C:\\Users\\example\\workspace\\ave-project\\alpha", isDefault: false }] } as never);
      fireEvent.contextMenu(await waitFor(() => getByTestId("sidebar-sections")));
      emitNativeContextCommand("project.add");
      await waitFor(() => expect(pickRoot).toHaveBeenCalledTimes(1));
      await act(async () => {});
      expect(onProjectAdded).not.toHaveBeenCalled();
      expect(onRefreshProjects).not.toHaveBeenCalled();
      expect(onProjectError).not.toHaveBeenCalled();

      // An add that succeeded without saying which folder is a broken answer: no guess, an error.
      pickRoot.mockResolvedValueOnce({ ok: true, roots: [{ path: "C:\\Users\\example\\workspace\\ave-project\\alpha", isDefault: false }] } as never);
      fireEvent.contextMenu(getByTestId("sidebar-sections"));
      emitNativeContextCommand("project.add");
      await waitFor(() => expect(onProjectError).toHaveBeenCalledWith("add", "invalid-response"));
      expect(onProjectAdded).not.toHaveBeenCalled();
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
      const tabBody = await waitFor(() => getByTestId("sidebar-sections"));
      fireEvent.contextMenu(tabBody);
      emitNativeContextCommand("project.add");

      await waitFor(() => expect(onProjectError).toHaveBeenCalledWith("add", "persist-failed"));
      expect(onRefreshProjects).not.toHaveBeenCalled();
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

      fireEvent.contextMenu(await waitFor(() => getByTestId("sidebar-sections")));
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

      fireEvent.contextMenu(await waitFor(() => getByTestId("sidebar-sections")));
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
      projectSelection: { kind: "root", root: "C:\\Users\\example\\workspace\\ave-project\\ave" },
      selectedProject: { projectRoot: "C:\\Users\\example\\workspace\\ave-project\\ave", projectName: "ave", isDefault: true },
    });
    // A project's list answers its blank area with import and nothing row-scoped: import creates a NEW conversation, so it
    // cannot act on a row.
    fireEvent.contextMenu(getByTestId("sidebar-sections"));
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

const OTHER_APP: ProjectIdentity = { projectRoot: "C:\\Users\\example\\workspace\\ave-project\\other-app", projectName: "other-app" };

describe("Sidebar rail", () => {
  it("keeps the rail when the list folds, and draws no text on it", () => {
    const { getByTestId, queryByTestId, restore } = renderSidebar({
      collapsed: true,
      failedPluginCards: [FAILED_PLUGIN_CARD],
    });
    const rail = getByTestId("sidebar-rail");
    expect(queryByTestId("sidebar-card")).toBeNull();
    const buttons = rail.querySelectorAll("button");
    expect(buttons.length).toBeGreaterThan(0);
    for (const button of buttons) {
      // Names live in the tooltip only (case 03): every rail button carries them as `aria-label` and `title`.
      expect(button.getAttribute("aria-label")).toBeTruthy();
      expect(button.getAttribute("title")).toBeTruthy();
      expect(button.textContent?.trim().replace(/^[a-z]{1,2}$/, "")).toBe("");
    }
    expect(getByTestId("sidebar-group-plugins")).toBeTruthy();
    restore();
  });

  it("lists the project button, the launchers, the views, then search and settings", () => {
    const { getByTestId, restore } = renderSidebar({ projectSelection: { kind: "root", root: OTHER_APP.projectRoot }, selectedProject: OTHER_APP });
    const order = [...getByTestId("sidebar-rail").querySelectorAll("button")].map((button) => button.dataset.testid);
    expect(order).toEqual([
      "sidebar-project-button",
      "sidebar-new-chat", "sidebar-web", "sidebar-terminal",
      "toolbar-work-board", "sidebar-routines", "sidebar-memory", "sidebar-starred",
      "sidebar-search", "sidebar-settings",
    ]);
    // Every launcher and view says which project it acts in.
    for (const id of ["sidebar-new-chat", "sidebar-web", "sidebar-terminal", "toolbar-work-board", "sidebar-memory"]) {
      expect(getByTestId(id).getAttribute("aria-label")).toContain("other-app");
    }
    restore();
  });

  it("launches nothing until the selection has loaded", () => {
    const onLaunch = vi.fn();
    // The selection has not been read yet: neither a project nor the all-projects view.
    const { getByTestId, restore } = renderSidebar({ onLaunch, projectSelection: undefined, selectedProject: undefined });
    try {
      const terminal = getByTestId("sidebar-terminal") as HTMLButtonElement;
      expect(terminal.disabled).toBe(true);
      expect(terminal.getAttribute("aria-label")).toBe("새 터미널");
      fireEvent.click(terminal);
      expect(onLaunch).not.toHaveBeenCalled();
    } finally { restore(); }
  });

  it("launches in the selected project without asking", () => {
    const onLaunch = vi.fn();
    const { getByTestId, queryByTestId, restore } = renderSidebar({
      onLaunch, projectSelection: { kind: "root", root: OTHER_APP.projectRoot }, selectedProject: OTHER_APP,
    });
    fireEvent.click(getByTestId("sidebar-terminal"));
    expect(onLaunch).toHaveBeenCalledWith("terminal", OTHER_APP);
    expect(queryByTestId("project-picker")).toBeNull();
    restore();
  });

  it("marks the home row current only while the project home is the page", () => {
    const onSelect = vi.fn();
    const home = renderSidebar({ onSelect, projectSelection: { kind: "root", root: OTHER_APP.projectRoot }, selectedProject: OTHER_APP });
    const row = home.getByTestId("sidebar-project-home");
    expect(row.textContent).toContain("other-app 홈");
    expect(row.getAttribute("aria-current")).toBeNull();
    fireEvent.click(row);
    expect(onSelect).toHaveBeenCalledWith("project-home");
    home.restore();
    cleanup();
    const current = renderSidebar({ activeView: "project-home", projectSelection: { kind: "root", root: OTHER_APP.projectRoot }, selectedProject: OTHER_APP });
    expect(current.getByTestId("sidebar-project-home").getAttribute("aria-current")).toBe("page");
    current.restore();
  });

  it("lists only the selected project's conversations", () => {
    const { queryByTestId, restore } = renderSidebar({ projectSelection: { kind: "root", root: OTHER_APP.projectRoot }, selectedProject: OTHER_APP });
    expect(queryByTestId("sidebar-session-sess-other")).not.toBeNull();
    expect(queryByTestId("sidebar-session-sess-1")).toBeNull();
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
  it("has no marketplace row and no chat-home row", () => {
    const { queryByTestId, queryByText, restore } = renderSidebar();
    expect(queryByTestId("sidebar-home")).toBeNull();
    expect(queryByTestId("sidebar-marketplace")).toBeNull();
    expect(queryByText("마켓플레이스")).toBeNull();
    expect(queryByText("Marketplace")).toBeNull();
    restore();
  });

  it("opens a built-in view from its rail button and marks the current one", () => {
    const onSelect = vi.fn();
    const { getByTestId, restore } = renderSidebar({ onSelect, activeView: "routines" });
    expect(getByTestId("sidebar-routines").getAttribute("aria-current")).toBe("page");
    expect(getByTestId("toolbar-work-board").getAttribute("aria-current")).toBeNull();
    fireEvent.click(getByTestId("toolbar-work-board"));
    expect(onSelect).toHaveBeenCalledWith("work-board");
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
    expect(getByTestId("sidebar-group-plugins").getAttribute("aria-label")).toBe("익스텐션");
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

describe("Sidebar project tree paging", () => {
  const DEFAULT_ROOT = "C:\\Users\\example\\workspace\\ave-project\\ave";
  const OTHER_ROOT = "C:\\Users\\example\\workspace\\ave-project\\other-app";
  const inDefault = {
    projectSelection: { kind: "root" as const, root: DEFAULT_ROOT },
    selectedProject: { projectRoot: DEFAULT_ROOT, projectName: "ave", isDefault: true },
  };

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

  it("shows a project's first twenty rows, counting its terminals and pages, and opens the rest from the last row", () => {
    const conversations = manyConversations(22, "일반");
    const mainSurfaces: MainSurface[] = [1, 2, 3].map((ordinal) => (
      { tabId: `terminal:0000000a-${ordinal}`, kind: "terminal", ordinal, url: null, projectRoot: DEFAULT_ROOT }
    ));
    const { getByTestId, queryByTestId, container, restore } = renderSidebar({ ...inDefault, sessions: conversations, mainSurfaces, currentSessionId: "일반-0" });
    try {
      const rows = () => container.querySelectorAll('[role="treeitem"]:not([data-tree-key^="more:"])').length;
      expect(rows()).toBe(20);
      const more = getByTestId("sidebar-tree-more-project");
      expect(more.getAttribute("role")).toBe("treeitem");
      expect(more.textContent).toBe("이전 항목 5개 더 보기");
      fireEvent.click(more);
      expect(rows()).toBe(25);
      expect(countRenderedRows(conversations, queryByTestId)).toBe(22);
      expect(queryByTestId("sidebar-tree-more-project")).toBeNull();
    } finally {
      restore();
    }
  });

  it("renders a short list whole, with nothing to open", () => {
    const conversations = manyConversations(4, "짧은");
    const { queryByTestId, restore } = renderSidebar({ ...inDefault, sessions: conversations, currentSessionId: "짧은-0" });
    try {
      expect(countRenderedRows(conversations, queryByTestId)).toBe(4);
      expect(queryByTestId("sidebar-tree-more-project")).toBeNull();
    } finally {
      restore();
    }
  });

  it("pages the rows that survive the archive filter", () => {
    const conversations = manyConversations(24, "보관");
    const archived = new Set(["보관-1", "보관-3", "보관-5"]);
    const { getByTestId, queryByTestId, restore } = renderSidebar({
      ...inDefault,
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
      // A page is a page of rows the reader can SEE: archived rows leave the list before it is paged.
      expect(countRenderedRows(conversations, queryByTestId)).toBe(20);
      expect(queryByTestId("sidebar-session-보관-1")).toBeNull();
      expect(getByTestId("sidebar-tree-more-project").textContent).toBe("이전 항목 1개 더 보기");
      fireEvent.click(getByTestId("sidebar-toggle-archived"));
      expect(getByTestId("sidebar-tree-more-project").textContent).toBe("이전 항목 4개 더 보기");
    } finally {
      restore();
    }
  });

  it("gives each all-projects group its own page of six and a row that opens the rest", () => {
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
        { projectRoot: DEFAULT_ROOT, projectName: "ave", isDefault: true },
        { projectRoot: OTHER_ROOT, projectName: "other-app" },
        { projectRoot: THIRD_ROOT, projectName: "third-app" },
      ],
    });
    const moreId = "sidebar-tree-more-C-Users-example-workspace-ave-project-other-app";
    try {
      expect(countRenderedRows(otherRows, queryByTestId)).toBe(6);
      expect(countRenderedRows(thirdRows, queryByTestId)).toBe(6);
      expect(getByTestId(moreId).textContent).toBe("이전 항목 3개 더 보기");
      fireEvent.click(getByTestId(moreId));
      expect(countRenderedRows(otherRows, queryByTestId)).toBe(9);
      expect(queryByTestId(moreId)).toBeNull();
      // One group opening says nothing about its neighbours.
      expect(countRenderedRows(thirdRows, queryByTestId)).toBe(6);
    } finally {
      restore();
    }
  });
});

describe("Sidebar view rows", () => {
  async function featuresRow(_getByTestId: (id: string) => HTMLElement, rowTestId: string) {
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

  it("keeps pending attention in a subagent row's name and its family in the description", () => {
    const { getByRole, restore } = renderSidebar({
      sessions: [workBoardRow],
      pendingAnswerSessionIds: new Set([workBoardRow.id]),
    });
    try {
      const row = getByRole("button", { name: /월간 보고서 초안.*답변 대기 중/ });
      expect(row.hasAttribute("aria-label")).toBe(false);
      expect(row.getAttribute("aria-description")).toBe("워크보드 작업");
      expect(row.hasAttribute("title")).toBe(false);
    } finally {
      restore();
    }
  });

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
      const list = getByTestId(DEFAULT_GROUP);
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
      mainSurfaces: [{ tabId, kind, ordinal: 1, url: null, projectRoot: root }],
      onOpenSideChat, onOpenPaneChat,
    }, { browserTabs });
    try {
      await waitFor(() => expect(getByTestId("sidebar-surface-chats-" + tabId).contains(getByTestId("sidebar-session-side-1"))).toBe(true));
      expect(getAllByTestId("sidebar-session-side-1")).toHaveLength(1);
      expect(getAllByTestId("sidebar-surface-" + tabId)).toHaveLength(1);
      // The pane chat sits one level under its surface's row, right after it.
      expect(getByTestId("sidebar-surface-tree-" + tabId).nextElementSibling).toBe(getByTestId("sidebar-surface-chats-" + tabId));
      expect(getByTestId("sidebar-row-session-side-1").getAttribute("aria-level")).toBe("3");
      fireEvent.click(getByTestId("sidebar-session-side-1"));
      expect(onOpenPaneChat).toHaveBeenCalledWith(tabId);
      expect(onOpenSideChat).not.toHaveBeenCalled();
      expect(onLoadSession).not.toHaveBeenCalled();
    } finally { restore(); }
  });

  it("draws the tree's connector lines per level: ancestor lines, ├ for a child with later siblings, └ for the last", async () => {
    const tabId = "terminal:guides";
    const root = "/projects/guides";
    const paneChats = [
      { ...sideChatRow, id: "side-a", title: "첫 패널 채팅", paneTabId: tabId, projectRoot: root },
      { ...sideChatRow, id: "side-b", title: "둘째 패널 채팅", paneTabId: tabId, projectRoot: root },
    ];
    // Older than the terminal (a surface never shown counts as used now), so it is the group's last row.
    const olderChat = sessionRow({ id: "older-chat", title: "예전 대화", modifiedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(), projectRoot: root });
    const browserTabs = {
      getSessionBindings: async () => ({ revision: 1, bindings: paneChats.map((chat) => ({ sessionId: chat.id, browserTabIds: [], terminalTabIds: [tabId] })) }),
      onSessionBindingsChanged: () => () => {},
    } as unknown as AveApi["browserTabs"];
    const { getByTestId, restore } = renderSidebar({
      sessions: [...paneChats, olderChat],
      projects: [{ projectRoot: root, projectName: "Guides" }],
      mainSurfaces: [{ tabId, kind: "terminal", ordinal: 1, url: null, projectRoot: root }],
    }, { browserTabs });
    const guidesOf = (row: HTMLElement) => [...row.querySelectorAll<HTMLElement>("[data-tree-guide]")].map((guide) => guide.dataset.treeGuide);
    try {
      await waitFor(() => expect(getByTestId("sidebar-surface-chats-" + tabId).contains(getByTestId("sidebar-row-session-side-b"))).toBe(true));
      const group = getByTestId("sidebar-project-projects-guides");
      const terminal = getByTestId("sidebar-surface-tree-" + tabId);
      const first = getByTestId("sidebar-row-session-side-a");
      const second = getByTestId("sidebar-row-session-side-b");
      const older = getByTestId("sidebar-row-session-older-chat");
      // The order the guides are drawn for: the group, its terminal, the terminal's two chats, then the older chat.
      const rows = [...document.querySelectorAll<HTMLElement>('[role="treeitem"]')];
      const at = [group, terminal, first, second, older].map((row) => rows.indexOf(row));
      expect(at).toEqual([...at].sort((a, b) => a - b));
      expect(at[4]! - at[0]!).toBe(4);
      // A top-level row has no indent; each row has one column per level above it.
      expect(guidesOf(group)).toEqual([]);
      expect(group.querySelector('[data-testid="tree-indent-guides"]')).toBeNull();
      expect(guidesOf(terminal)).toEqual(["mid"]);
      expect(guidesOf(first)).toEqual(["line", "mid"]);
      expect(guidesOf(second)).toEqual(["line", "last"]);
      expect(guidesOf(older)).toEqual(["last"]);
      // Indented by padding on the row itself, so its hover and focus ring keep the full width.
      expect(terminal.style.paddingLeft).toBe("1rem");
      expect(second.style.paddingLeft).toBe("2rem");
      expect(group.style.paddingLeft).toBe("");
      // ├ draws the full-height line and an arm; └ draws one element, down then right.
      expect(terminal.querySelector<HTMLElement>('[data-tree-guide="mid"]')!.children).toHaveLength(2);
      const lastElbow = older.querySelector<HTMLElement>('[data-tree-guide="last"]')!;
      expect(lastElbow.children).toHaveLength(1);
      expect(lastElbow.firstElementChild!.className).toContain("border-l");
      expect(lastElbow.firstElementChild!.className).toContain("border-b");
      // Decoration only: hidden from assistive tech and click-through, with the row's aria-level unchanged.
      for (const row of [terminal, first, second, older]) {
        const strip = row.querySelector<HTMLElement>('[data-testid="tree-indent-guides"]')!;
        expect(strip.getAttribute("aria-hidden")).toBe("true");
        expect(strip.className).toContain("pointer-events-none");
        for (const guide of row.querySelectorAll("[data-tree-guide]")) expect(guide.getAttribute("aria-hidden")).toBe("true");
      }
      expect([terminal, first, second, older].map((row) => row.getAttribute("aria-level"))).toEqual(["2", "3", "3", "2"]);
      // The containers carry no indent or line of their own any more; the rows do.
      expect(getByTestId("sidebar-surface-chats-" + tabId).className).not.toMatch(/\bml-|border-l/);
      expect(getByTestId("sidebar-project-group-projects-guides").className).not.toMatch(/\bml-|border-l/);
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
    const view = renderSidebar({ sessions: [{ ...sideChatRow, paneTabId: tabId }], mainSurfaces: [{ tabId, kind: "terminal", ordinal: 1, url: null, projectRoot: "/ws" }] }, { browserTabs });
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
      expect(view.getByTestId("sidebar-sections").textContent).toContain("이전 터미널 채팅");
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
    const view = renderSidebar({ sessions: [session], mainSurfaces: [{ tabId, kind: "terminal", ordinal: 1, url: null, projectRoot: "/ws" }], onOpenSideChat, onOpenPaneChat, conversationActions }, { browserTabs, locale });
    try {
      await waitFor(() => view.getByTestId("sidebar-surface-chats-" + tabId));
      act(() => {
        session.archivedAt = "2026-10-29T00:00:00Z";
        update({ revision: 2, bindings: [] });
      });
      expect(view.queryByTestId("sidebar-surface-chats-" + tabId)).toBeNull();
      expect(view.queryByTestId("sidebar-session-side-1")).toBeNull();
      fireEvent.click(view.getByTestId("sidebar-toggle-archived"));
      expect(view.getByTestId(DEFAULT_GROUP).textContent).toContain(locale === "ko" ? "이전 터미널 채팅" : "Former terminal chat");
      expect(view.getByTestId("sidebar-surface-tree-" + tabId).contains(view.getByTestId("sidebar-session-side-1"))).toBe(false);
      fireEvent.click(view.getByTestId("sidebar-session-side-1"));
      expect(onOpenSideChat).toHaveBeenCalledWith("side-1", "sess-1");
      expect(onOpenPaneChat).not.toHaveBeenCalled();
    } finally { view.restore(); setRuntimeLocale(suiteLocale); }
  });

  it("omits a renderer-only pane claim without a host binding", () => {
    const tabId = "terminal:unbound";
    const onOpenPaneChat = vi.fn();
    const view = renderSidebar({ sessions: [{ ...sideChatRow, paneTabId: tabId }], mainSurfaces: [{ tabId, kind: "terminal", ordinal: 1, url: null, projectRoot: "/ws" }], onOpenPaneChat });
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
        getByTestId(DEFAULT_GROUP).contains(getByTestId("sidebar-session-side-orphan")),
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
      const tree = getByTestId(DEFAULT_GROUP);
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

describe("Sidebar project tree (cases 05, 18, 19, 20)", () => {
  const DEFAULT_ROOT = "C:\\Users\\example\\workspace\\ave-project\\ave";
  const OTHER_ROOT = "C:\\Users\\example\\workspace\\ave-project\\other-app";
  const DEFAULT_PROJECT: ProjectIdentity = { projectRoot: DEFAULT_ROOT, projectName: "ave", isDefault: true };
  const inProject = (project: ProjectIdentity) => ({
    projectSelection: { kind: "root" as const, root: project.projectRoot },
    selectedProject: project,
  });
  const DAY = 86_400_000;
  const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
  const treeRows = (container: HTMLElement) => [...container.querySelectorAll<HTMLElement>('[role="tree"] [role="treeitem"]')];
  const key = (row: Element) => row.getAttribute("data-tree-key");

  it("gives exactly one row the tab stop — the current conversation — and keeps every button inside a row out of the tab order", () => {
    const { container, getByRole, restore } = renderSidebar(inProject(DEFAULT_PROJECT));
    try {
      const rows = treeRows(container);
      expect(rows.filter((row) => row.tabIndex === 0).map(key)).toEqual(["session:sess-1"]);
      expect(getByRole("tree").querySelectorAll('button:not([tabindex="-1"])')).toHaveLength(0);
      // Rows are treeitems with buttons inside, never buttons inside a link.
      expect(getByRole("tree").querySelector("a button, a [role=treeitem]")).toBeNull();
    } finally {
      restore();
    }
  });

  it("names a conversation in its row's title, so a truncated name can still be read", () => {
    const { getByTestId, restore } = renderSidebar(inProject(DEFAULT_PROJECT));
    try {
      // Inside the sidebar the hover preview shows the full name instead of the native tooltip, and the title becomes the
      // row's description, as it does for terminal and page rows.
      expect(getByTestId("sidebar-session-sess-1").getAttribute("aria-description")).toBe("전체 동기화로 상태 파악");
    } finally {
      restore();
    }
  });

  it("shows a row's full name in the preview when the row itself takes keyboard focus, and hides it when focus leaves", async () => {
    const { container, restore } = renderSidebar(inProject(DEFAULT_PROJECT));
    try {
      const row = treeRows(container).find((each) => key(each) === "session:sess-1")!;
      act(() => { row.focus(); });
      const card = await waitFor(() => { const el = document.querySelector('[data-testid="sidebar-preview"]'); expect(el).not.toBeNull(); return el!; });
      expect(card.textContent).toContain("전체 동기화로 상태 파악");
      expect(row.getAttribute("aria-describedby")).toBe(card.id);
      act(() => { row.blur(); });
      await waitFor(() => expect(document.querySelector('[data-testid="sidebar-preview"]')).toBeNull());
    } finally {
      restore();
    }
  });

  it("hands focus to the next row when the focused one goes away, never to the page", async () => {
    const { container, rerenderSidebar, restore } = renderSidebar(inProject(DEFAULT_PROJECT));
    try {
      const first = treeRows(container).find((row) => key(row) === "session:sess-1")!;
      first.focus();
      expect(document.activeElement).toBe(first);
      // The focused conversation is archived (or closed, or deleted): its row leaves the list.
      act(() => {
        rerenderSidebar({
          sessions: [sessionRow({ id: "sess-2", title: "사이드 패널 개선", modifiedAt: ago(0) })],
        });
      });
      await waitFor(() => expect(key(document.activeElement!)).toBe("session:sess-2"));
      expect((document.activeElement as HTMLElement).tabIndex).toBe(0);
    } finally {
      restore();
    }
  });

  it("keeps the rest of the sidebar when the tree fails to render, and says so in its place", () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const broken = sessionRow({ id: "sess-9", modifiedAt: ago(0) });
    Object.defineProperty(broken, "title", { get: () => { throw new Error("bad row"); } });
    const { getByTestId, queryByRole, restore } = renderSidebar({ ...inProject(DEFAULT_PROJECT), sessions: [broken] });
    try {
      expect(queryByRole("tree")).toBeNull();
      expect(getByTestId("sidebar-tree-error").textContent).toContain("대화 목록을 표시하지 못했습니다");
      expect(getByTestId("sidebar-project-button")).toBeTruthy();
    } finally {
      restore();
      error.mockRestore();
    }
  });

  it("walks the rows with the arrow keys, Home and End, and opens with Enter or beside the focused tile with ⌥Enter", () => {
    const onOpenSessionBeside = vi.fn();
    const { container, onLoadSession, restore } = renderSidebar({ ...inProject(DEFAULT_PROJECT), onOpenSessionBeside });
    try {
      const rows = treeRows(container);
      rows[0]!.focus();
      fireEvent.keyDown(rows[0]!, { key: "ArrowDown" });
      expect(key(document.activeElement!)).toBe("session:sess-2");
      expect((document.activeElement as HTMLElement).tabIndex).toBe(0);
      fireEvent.keyDown(document.activeElement!, { key: "Home" });
      expect(key(document.activeElement!)).toBe("session:sess-1");
      fireEvent.keyDown(document.activeElement!, { key: "End" });
      expect(key(document.activeElement!)).toBe("session:sess-2");
      fireEvent.keyDown(document.activeElement!, { key: "Enter" });
      expect(onLoadSession).toHaveBeenCalledWith("sess-2");
      fireEvent.keyDown(document.activeElement!, { key: "Enter", altKey: true });
      expect(onOpenSessionBeside).toHaveBeenCalledWith("sess-2");
      fireEvent.keyDown(document.activeElement!, { key: "ArrowUp" });
      expect(key(document.activeElement!)).toBe("session:sess-1");
    } finally {
      restore();
    }
  });

  it("renames the focused conversation with F2 and gives focus back to its row on Escape", async () => {
    const conversationActions = {
      isArchived: () => false, isUnread: () => false, isResponding: () => false,
      onRename: vi.fn(), onSetArchived: vi.fn(), onSetUnread: vi.fn(), onShare: vi.fn(), onCopy: vi.fn(), onDelete: vi.fn(),
    };
    const { container, getByTestId, restore } = renderSidebar({ ...inProject(DEFAULT_PROJECT), conversationActions });
    try {
      const row = treeRows(container)[0]!;
      row.focus();
      fireEvent.keyDown(row, { key: "F2" });
      const field = getByTestId("sidebar-session-rename-sess-1");
      fireEvent.keyDown(field, { key: "Escape" });
      await waitFor(() => expect(key(document.activeElement!)).toBe("session:sess-1"));
    } finally {
      restore();
    }
  });

  it("opens the row menu from the keyboard as a right-click would", () => {
    const { container, showNativeContextMenu, restore } = renderSidebar(inProject(DEFAULT_PROJECT));
    try {
      const row = treeRows(container)[0]!;
      row.focus();
      fireEvent.keyDown(row, { key: "F10", shiftKey: true });
      expect(showNativeContextMenu).toHaveBeenCalledTimes(1);
      expect(showNativeContextMenu.mock.calls[0]![0].commands).toEqual(expect.arrayContaining(["conversation.open"]));
      fireEvent.keyDown(row, { key: "ContextMenu" });
      expect(showNativeContextMenu).toHaveBeenCalledTimes(2);
    } finally {
      restore();
    }
  });

  it("interleaves conversations and terminals by recency under 지난 7일 and 지난 30일", () => {
    const surfaceAt = Date.now();
    const { container, getByTestId, restore } = renderSidebar({
      ...inProject(DEFAULT_PROJECT),
      sessions: [
        sessionRow({ id: "new", title: "새 대화", modifiedAt: ago(1) }),
        sessionRow({ id: "old", title: "지난 대화", modifiedAt: ago(9) }),
      ],
      currentSessionId: "new",
      mainSurfaces: [{ tabId: "terminal:0000000b-1", kind: "terminal", ordinal: 1, url: null, projectRoot: DEFAULT_ROOT }],
    });
    try {
      expect(surfaceAt).toBeLessThanOrEqual(Date.now());
      expect(treeRows(container).map(key)).toEqual(["surface:terminal:0000000b-1", "session:new", "session:old"]);
      const last7 = getByTestId("sidebar-tree-header-last7Days");
      const last30 = getByTestId("sidebar-tree-header-last30Days");
      expect(last7.textContent).toBe("지난 7일");
      expect(last30.textContent).toBe("지난 30일");
      expect(last7.className).toContain("sticky");
      // The header sits right before the rows it heads.
      expect(last30.nextElementSibling?.getAttribute("data-tree-key")).toBe("session:old");
    } finally {
      restore();
    }
  });

  it("keeps two projects that share a folder name apart", () => {
    const first: ProjectIdentity = { projectRoot: "/work/a/app", projectName: "app" };
    const second: ProjectIdentity = { projectRoot: "/work/b/app", projectName: "app" };
    const { getByTestId, restore } = renderSidebar({
      projects: [{ projectRoot: "/home/example/.ave/workspace", projectName: "workspace", isDefault: true }, first, second],
      sessions: [
        sessionRow({ id: "in-a", title: "A 대화", modifiedAt: ago(0), projectRoot: first.projectRoot, projectName: "app" }),
        sessionRow({ id: "in-b", title: "B 대화", modifiedAt: ago(0), projectRoot: second.projectRoot, projectName: "app" }),
      ],
    });
    try {
      expect(getByTestId("sidebar-project-group-work-a-app").textContent).toContain("A 대화");
      expect(getByTestId("sidebar-project-group-work-a-app").textContent).not.toContain("B 대화");
      expect(getByTestId("sidebar-project-group-work-b-app").textContent).toContain("B 대화");
    } finally {
      restore();
    }
  });

  it("folds a group to its count, unfolds it with →, folds it with ← and climbs from a row to its group", () => {
    const expanded = new Set<string>([DEFAULT_ROOT]);
    const onSetProjectExpanded = vi.fn((root: string, open: boolean) => { if (open) expanded.add(root); else expanded.delete(root); });
    const { container, getByTestId, rerenderSidebar, restore } = renderSidebar({
      isProjectExpanded: (root) => expanded.has(root),
      onSetProjectExpanded,
      mainSurfaces: [{ tabId: "terminal:0000000b-2", kind: "terminal", ordinal: 2, url: null, projectRoot: OTHER_ROOT }],
    });
    try {
      const otherRow = getByTestId("sidebar-project-C-Users-example-workspace-ave-project-other-app");
      expect(otherRow.getAttribute("aria-expanded")).toBe("false");
      // One conversation and one terminal.
      expect(getByTestId("sidebar-project-count-C-Users-example-workspace-ave-project-other-app").textContent).toBe("2");
      otherRow.focus();
      fireEvent.keyDown(otherRow, { key: "ArrowRight" });
      expect(onSetProjectExpanded).toHaveBeenLastCalledWith(OTHER_ROOT, true);
      rerenderSidebar({ isProjectExpanded: (root) => expanded.has(root) });
      expect(getByTestId(OTHER_GROUP).textContent).toContain("다른 프로젝트 대화");
      const child = treeRows(container).find((row) => key(row) === "session:sess-other")!;
      expect(child.getAttribute("aria-level")).toBe("2");
      child.focus();
      fireEvent.keyDown(child, { key: "ArrowLeft" });
      expect(document.activeElement).toBe(getByTestId("sidebar-project-C-Users-example-workspace-ave-project-other-app"));
      fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
      expect(onSetProjectExpanded).toHaveBeenLastCalledWith(OTHER_ROOT, false);
    } finally {
      restore();
    }
  });

  it("offers open, open beside, move to another project and close on a terminal row, and does what is chosen", () => {
    const onOpenSurface = vi.fn();
    const onOpenSurfaceBeside = vi.fn();
    const onMoveSurface = vi.fn();
    const onCloseSurface = vi.fn();
    const tabId = "terminal:0000000b-3";
    const view = renderSidebar({
      ...inProject(DEFAULT_PROJECT),
      mainSurfaces: [{ tabId, kind: "terminal", ordinal: 3, url: null, projectRoot: DEFAULT_ROOT }],
      onOpenSurface, onOpenSurfaceBeside, onMoveSurface, onCloseSurface,
    });
    try {
      fireEvent.click(view.getByTestId(`sidebar-surface-menu-${tabId}`));
      const menu = view.showDynamicMenu.mock.calls.at(-1)![0];
      expect(menu.sections.map((section) => section.items.map((item) => item.label))).toEqual([
        ["열기", "옆에 분할로 열기", "다른 프로젝트로 이동"],
        ["닫기 · 실행 중인 명령 종료"],
      ]);
      expect(menu.sections[0]!.items[0]!.accelerator).toBe("Enter");
      expect(menu.sections[0]!.items[1]!.accelerator).toBe("Alt+Enter");
      expect(menu.sections[0]!.items[2]!.submenu?.map((item) => item.label)).toEqual(["other-app"]);
      view.chooseDynamicMenuItem(`move:${OTHER_ROOT}`);
      expect(onMoveSurface).toHaveBeenCalledWith(tabId, OTHER_ROOT);
      fireEvent.click(view.getByTestId(`sidebar-surface-menu-${tabId}`));
      view.chooseDynamicMenuItem("beside");
      expect(onOpenSurfaceBeside).toHaveBeenCalledWith(tabId);
      fireEvent.click(view.getByTestId(`sidebar-surface-close-${tabId}`));
      expect(onCloseSurface).toHaveBeenCalledWith(tabId);
      fireEvent.click(view.getByTestId(`sidebar-surface-${tabId}`));
      expect(onOpenSurface).toHaveBeenCalledWith(tabId);
    } finally {
      view.restore();
    }
  });

  it("offers a side panel's tab only to open, with no close, move or split", () => {
    const tabs = [{ tabId: "terminal:0000000b-4", kind: "terminal" as const, ordinal: 4, url: null, cwd: null }];
    const unregister = registerSideTabsSink("group-tree", {
      adopt: vi.fn(), release: vi.fn(), open: vi.fn(), activate: vi.fn(), snapshot: () => tabs,
    });
    const view = renderSidebar({ ...inProject(DEFAULT_PROJECT), chatGroupIds: ["group-tree"], onCloseSurface: vi.fn(), onMoveSurface: vi.fn(), onOpenSurfaceBeside: vi.fn() });
    try {
      expect(view.queryByTestId("sidebar-surface-close-terminal:0000000b-4")).toBeNull();
      fireEvent.click(view.getByTestId("sidebar-surface-menu-terminal:0000000b-4"));
      expect(view.showDynamicMenu.mock.calls.at(-1)![0].sections.map((section) => section.items.map((item) => item.id))).toEqual([["open"]]);
    } finally {
      view.restore();
      unregister();
    }
  });

  it("says 종료됨 on a terminal whose shell has ended", () => {
    const tabId = "terminal:0000000b-5";
    const view = renderSidebar({
      ...inProject(DEFAULT_PROJECT),
      mainSurfaces: [{ tabId, kind: "terminal", ordinal: 5, url: null, projectRoot: DEFAULT_ROOT }],
    });
    try {
      expect(view.queryByTestId(`sidebar-surface-status-${tabId}`)).toBeNull();
      act(() => setTerminalExited(tabId, true));
      expect(view.getByTestId(`sidebar-surface-status-${tabId}`).textContent).toBe("종료됨");
      act(() => setTerminalExited(tabId, false));
      expect(view.queryByTestId(`sidebar-surface-status-${tabId}`)).toBeNull();
    } finally {
      view.restore();
    }
  });

  it("keeps the work board and memory under the list, outside its scroller", () => {
    const onSelect = vi.fn();
    const { getByTestId, restore } = renderSidebar({ ...inProject(DEFAULT_PROJECT), onSelect });
    try {
      const footer = getByTestId("sidebar-card-footer");
      expect(footer.closest("[data-radix-scroll-area-viewport]")).toBeNull();
      expect(getByTestId("sidebar-tree").closest("[data-radix-scroll-area-viewport]")).not.toBeNull();
      fireEvent.click(getByTestId("sidebar-card-work-board"));
      fireEvent.click(getByTestId("sidebar-card-memory"));
      expect(onSelect.mock.calls).toEqual([["work-board"], ["memory"]]);
    } finally {
      restore();
    }
  });

  it("lists nothing until the selection has loaded", () => {
    const { queryByRole, restore } = renderSidebar({ projectSelection: undefined, selectedProject: undefined });
    try {
      expect(queryByRole("tree")).toBeNull();
    } finally {
      restore();
    }
  });
});
