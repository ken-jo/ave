// @vitest-environment jsdom
/** The sidebar's project shell (Sidebar E, S2): the rail, the project menu, the selected project, the launchers and the
 * project home. */
import "./setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, waitFor, within } from "@testing-library/react";
import { renderApp } from "./render-app.js";
import { openWindowNotice } from "./helpers.js";
import { MOCK_DEFAULT_SETTINGS } from "./mock-ave-api.js";
import { clearActiveSurface } from "../../src/ui/renderer/preview/active-surface.js";
import { resetMainLayoutRestoreForTest } from "../../src/ui/renderer/preview/main-layout-restore.js";
import { isDarwin } from "../../src/ui/renderer/api-client.js";
import { MAIN_LAYOUT_SAVE_DELAY_MS } from "../../src/ui/renderer/hooks/use-main-layout.js";

vi.mock("@xterm/xterm", () => ({
  Terminal: class {
    cols = 80;
    rows = 24;
    options = {};
    parser = { registerOscHandler: () => ({ dispose() {} }) };
    loadAddon() {}
    open() {}
    onData() { return { dispose() {} }; }
    write() {}
    focus() {}
    dispose() {}
  },
}));
vi.mock("@xterm/addon-fit", () => ({ FitAddon: class { fit() {} } }));

afterEach(() => {
  clearActiveSurface();
  resetMainLayoutRestoreForTest();
  vi.restoreAllMocks();
});

const ROOTS = [{ path: "/ws", isDefault: true }, { path: "/ws/shop", isDefault: false }];

function renderInProject(selection: { kind: "root"; root: string } | { kind: "all" }, extra: Record<string, unknown> = {}) {
  return renderApp({
    hasApiKey: true,
    terminal: true,
    workspaceRoots: ROOTS,
    settings: { ...MOCK_DEFAULT_SETTINGS, system: { closeBehavior: "hide-to-tray", projectSelection: selection, ...extra } },
  });
}

function shownSurfaces(container: HTMLElement): Array<{ kind: string | null; tabId: string | null }> {
  return [...container.querySelectorAll<HTMLElement>('[data-testid="surface-pane"]')]
    .filter((pane) => pane.closest('[data-hidden="true"]') === null)
    .map((pane) => ({ kind: pane.getAttribute("data-surface-kind"), tabId: pane.getAttribute("data-tab-id") }));
}

function byTestId<T extends HTMLElement = HTMLElement>(testId: string): T | null {
  return document.querySelector<T>(`[data-testid="${testId}"]`);
}

async function headerName(): Promise<string> {
  return await waitFor(() => {
    const text = byTestId("sidebar-project-header")?.textContent ?? "";
    expect(text).not.toBe("");
    return text;
  });
}


describe("sidebar projects", () => {
  it("opens a new terminal from the rail in the selected project's folder, and names the project on the launcher", async () => {
    const { container, api } = await renderInProject({ kind: "root", root: "/ws/shop" });
    await waitFor(() => expect(byTestId("sidebar-terminal")?.getAttribute("aria-label")).toBe("새 터미널 (shop에 열림)"));
    expect(byTestId("sidebar-terminal")?.getAttribute("title")).toBe("새 터미널 (shop에 열림)");
    await act(async () => { fireEvent.click(byTestId("sidebar-terminal")!); });
    await waitFor(() => expect(shownSurfaces(container)).toHaveLength(1));
    const spawn = (api as unknown as { terminal: { spawn: ReturnType<typeof vi.fn> } }).terminal.spawn;
    await waitFor(() => expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ tabId: shownSurfaces(container)[0]!.tabId, cwd: "/ws/shop" })));
  });

  it("switches projects from the menu, shows the project's home on a first visit, and hands focus back on Escape", async () => {
    await renderInProject({ kind: "root", root: "/ws/shop" });
    expect(await headerName()).toContain("shop");
    const opener = byTestId<HTMLButtonElement>("sidebar-project-button")!;
    await act(async () => { fireEvent.click(opener); });
    const menu = await waitFor(() => { const el = byTestId("project-menu"); expect(el).not.toBeNull(); return el!; });
    expect(menu.id).toBe("project-menu");
    const search = menu.querySelector<HTMLInputElement>('[data-testid="project-combobox-search"]')!;
    await waitFor(() => expect(document.activeElement).toBe(search));
    await act(async () => { fireEvent.keyDown(search, { key: "Escape" }); });
    await waitFor(() => expect(byTestId("project-menu")).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));

    await act(async () => { fireEvent.click(opener); });
    const row = await waitFor(() => { const el = byTestId("project-menu-project-ws"); expect(el).not.toBeNull(); return el!; });
    await act(async () => { fireEvent.click(row); });
    await waitFor(() => expect(byTestId("sidebar-project-header")?.textContent).toContain("기본 프로젝트"));
    expect(byTestId("sidebar-project-home")?.getAttribute("aria-current")).toBe("page");
    expect(byTestId("sidebar-terminal")?.getAttribute("aria-label")).toBe("새 터미널 (기본 프로젝트에 열림)");
  });

  it("walks the menu with the arrow keys and picks with Enter", async () => {
    const { api } = await renderInProject({ kind: "root", root: "/ws" });
    await act(async () => { fireEvent.click(byTestId("sidebar-project-header")!); });
    const search = await waitFor(() => { const el = byTestId<HTMLInputElement>("project-combobox-search"); expect(el).not.toBeNull(); return el!; });
    // Typing filters the list; the first match is active.
    await act(async () => { fireEvent.change(search, { target: { value: "sho" } }); });
    await waitFor(() => expect(byTestId("project-menu-project-ws-shop")?.getAttribute("data-active")).toBe("true"));
    expect(byTestId("project-menu-all")).toBeNull();
    await act(async () => { fireEvent.keyDown(search, { key: "ArrowDown" }); });
    expect(byTestId("project-menu-add")?.getAttribute("data-active")).toBe("true");
    await act(async () => { fireEvent.keyDown(search, { key: "ArrowUp" }); });
    await act(async () => { fireEvent.keyDown(search, { key: "Enter" }); });
    await waitFor(() => expect(byTestId("sidebar-project-header")?.textContent).toContain("shop"));
    await waitFor(() => expect(vi.mocked(api.updateSettings)).toHaveBeenCalledWith(expect.objectContaining({
      system: expect.objectContaining({ projectSelection: { kind: "root", root: "/ws/shop" }, recentProjectRoots: ["/ws/shop"] }),
    })));
  });

  it("leaves Enter and the arrow keys to the input method while a word is being composed", async () => {
    await renderInProject({ kind: "root", root: "/ws" });
    await act(async () => { fireEvent.click(byTestId("sidebar-project-header")!); });
    const search = await waitFor(() => { const el = byTestId<HTMLInputElement>("project-combobox-search"); expect(el).not.toBeNull(); return el!; });
    await act(async () => { fireEvent.change(search, { target: { value: "쇼" } }); });
    // Committing "쇼" with Enter, and moving the candidate with ↓, belong to the input method: nothing is picked or moved.
    await act(async () => { fireEvent.keyDown(search, { key: "ArrowDown", isComposing: true }); });
    await act(async () => { fireEvent.keyDown(search, { key: "Enter", keyCode: 229 }); });
    expect(byTestId("project-menu")).not.toBeNull();
    expect(byTestId("sidebar-project-header")?.textContent).toContain("기본 프로젝트");
  });

  it("lists the menu as search, 전체 프로젝트, 최근, every project, then 새 프로젝트 추가", async () => {
    await renderInProject({ kind: "root", root: "/ws" }, { recentProjectRoots: ["/ws/shop"] });
    await act(async () => { fireEvent.click(byTestId("sidebar-project-button")!); });
    const menu = await waitFor(() => { const el = byTestId("project-menu"); expect(el).not.toBeNull(); return el!; });
    const order = [...menu.querySelectorAll<HTMLElement>('[role="option"]')].map((option) => option.dataset.testid);
    expect(order).toEqual(["project-menu-all", "project-menu-recent-ws-shop", "project-menu-project-ws", "project-menu-project-ws-shop", "project-menu-add"]);
    expect(byTestId("project-menu-project-ws")?.getAttribute("aria-selected")).toBe("true");
  });

  it("opens the project home with Cmd+0, and only then marks the home row current", async () => {
    const { container } = await renderInProject({ kind: "root", root: "/ws/shop" });
    await waitFor(() => expect(byTestId("sidebar-project-home")).not.toBeNull());
    expect(byTestId("sidebar-project-home")?.textContent).toContain("shop 홈");
    expect(byTestId("sidebar-project-home")?.getAttribute("aria-current")).toBeNull();
    const darwin = isDarwin();
    await act(async () => { fireEvent.keyDown(window, { key: "0", metaKey: darwin, ctrlKey: !darwin }); });
    await waitFor(() => expect(container.querySelector('[data-testid="project-home-path"]')?.textContent).toBe("/ws/shop"));
    expect(byTestId("sidebar-project-home")?.getAttribute("aria-current")).toBe("page");
  });

  it("asks which project in the all-projects view, preselects the most recent one, and stays in the all-projects view", async () => {
    const { container, api } = await renderInProject({ kind: "all" }, { recentProjectRoots: ["/ws/shop"] });
    await waitFor(() => expect(byTestId("sidebar-terminal")?.getAttribute("aria-label")).toBe("새 터미널 (프로젝트 고르기)"));
    await act(async () => { fireEvent.click(byTestId("sidebar-terminal")!); });
    const picker = await waitFor(() => { const el = byTestId("project-picker"); expect(el).not.toBeNull(); return el!; });
    expect(picker.textContent).not.toContain("프로젝트 없음");
    expect(byTestId("project-picker-project-ws")).not.toBeNull();
    expect(byTestId("project-picker-project-ws-shop")?.getAttribute("data-active")).toBe("true");
    await act(async () => { fireEvent.keyDown(picker.querySelector('[data-testid="project-combobox-search"]')!, { key: "Enter" }); });
    await waitFor(() => expect(shownSurfaces(container)).toHaveLength(1));
    const spawn = (api as unknown as { terminal: { spawn: ReturnType<typeof vi.fn> } }).terminal.spawn;
    await waitFor(() => expect(spawn).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/ws/shop" })));
    expect(byTestId("sidebar-project-header")?.textContent).toContain("전체 프로젝트");
  });

  it("adds a folder from the menu, switches to it, and offers the way back", async () => {
    const { container } = await renderInProject({ kind: "root", root: "/ws/shop" });
    const workspace = (window as unknown as { ave: { workspace: { pickRoot: ReturnType<typeof vi.fn>; listRoots: ReturnType<typeof vi.fn> } } }).ave.workspace;
    const added = [...ROOTS, { path: "/ws/notes", isDefault: false }];
    workspace.pickRoot.mockResolvedValueOnce({ ok: true, roots: added, added: "/ws/notes" });
    workspace.listRoots.mockResolvedValue({ ok: true, defaultRoot: "/ws", roots: added });
    await act(async () => { fireEvent.click(byTestId("sidebar-project-button")!); });
    const add = await waitFor(() => { const el = byTestId("project-menu-add"); expect(el).not.toBeNull(); return el!; });
    await act(async () => { fireEvent.click(add); });
    await waitFor(() => expect(byTestId("sidebar-project-header")?.textContent).toContain("notes"));
    const notice = await openWindowNotice(container, "notes 프로젝트를 추가하고 전환했습니다.");
    await act(async () => { fireEvent.click(within(notice).getByRole("button", { name: "이전 프로젝트로" })); });
    await waitFor(() => expect(byTestId("sidebar-project-header")?.textContent).toContain("shop"));
  });

  it("moves a side tab to the main area in its conversation's project, not the selected one", async () => {
    const { container, api } = await renderApp({
      hasApiKey: true,
      terminal: true,
      workspaceRoots: ROOTS,
      settings: { ...MOCK_DEFAULT_SETTINGS, system: { closeBehavior: "hide-to-tray", projectSelection: { kind: "root", root: "/ws" } } },
      history: { sessionId: "shop-session", projectRoot: "/ws/shop", projectName: "shop", messages: [{ role: "user", content: "hi" }] },
    } as never);
    expect(await headerName()).toContain("기본 프로젝트");
    await act(async () => { fireEvent.click(container.querySelector('[data-testid="pane-panel-toggle"]')!); });
    await act(async () => { fireEvent.click(await waitFor(() => {
      const el = byTestId("chat-side-panel-launcher-terminal"); expect(el).not.toBeNull(); return el!;
    })); });
    const tabId = await waitFor(() => {
      const el = document.querySelector('[data-testid="chat-side-panel-tab-strip"] [data-tab-id^="terminal:"]');
      expect(el).not.toBeNull();
      return el!.getAttribute("data-tab-id")!;
    });
    await act(async () => { fireEvent.click(document.querySelector(`[data-tab-id="${tabId}"] [data-testid="chat-side-panel-move-to-main"]`)!); });
    await waitFor(() => expect(shownSurfaces(container)).toEqual([{ kind: "terminal", tabId }]));
    await waitFor(() => {
      const saved = vi.mocked(api.updateSettings).mock.calls
        .map(([patch]) => (patch as { system?: { mainLayout?: { openSurfaces?: unknown[] } } }).system?.mainLayout)
        .filter((each) => each !== undefined)
        .at(-1);
      expect(saved?.openSurfaces).toEqual([expect.objectContaining({ tabId, projectRoot: "/ws/shop" })]);
    }, { timeout: MAIN_LAYOUT_SAVE_DELAY_MS * 10 });
  });

  it("closes a terminal from its row the way its pane's close button does", async () => {
    const { container, api } = await renderInProject({ kind: "root", root: "/ws" });
    expect(await headerName()).toContain("기본 프로젝트");
    await act(async () => { fireEvent.click(byTestId("sidebar-terminal")!); });
    const tabId = await waitFor(() => { const shown = shownSurfaces(container); expect(shown).toHaveLength(1); return shown[0]!.tabId!; });
    // The × says what closing a terminal does, as its menu item does.
    expect(byTestId(`sidebar-surface-close-${tabId}`)!.getAttribute("aria-label")).toBe("닫기 · 실행 중인 명령 종료");
    await act(async () => { fireEvent.click(byTestId(`sidebar-surface-close-${tabId}`)!); });
    await waitFor(() => expect(shownSurfaces(container)).toEqual([]));
    expect(byTestId(`sidebar-surface-tree-${tabId}`)).toBeNull();
    expect((api as unknown as { terminal: { kill: ReturnType<typeof vi.fn> } }).terminal.kill).toHaveBeenCalledWith(tabId);
  });

  it("opens a terminal beside the focused pane with ⌥Enter on its row", async () => {
    const { container } = await renderInProject({ kind: "root", root: "/ws" });
    expect(await headerName()).toContain("기본 프로젝트");
    await act(async () => { fireEvent.click(byTestId("sidebar-terminal")!); });
    const first = await waitFor(() => { const shown = shownSurfaces(container); expect(shown).toHaveLength(1); return shown[0]!.tabId!; });
    await act(async () => { fireEvent.click(byTestId("sidebar-terminal")!); });
    await waitFor(() => expect(shownSurfaces(container).map((each) => each.tabId)).not.toContain(first));
    const row = byTestId(`sidebar-surface-tree-${first}`)!;
    row.focus();
    await act(async () => { fireEvent.keyDown(row, { key: "Enter", altKey: true }); });
    await waitFor(() => expect(shownSurfaces(container)).toHaveLength(2));
    expect(shownSurfaces(container).map((each) => each.tabId)).toContain(first);
  });

  it("moves a terminal to another project from its row menu", async () => {
    const { container, api, chooseDynamicMenuItem } = await renderApp({
      hasApiKey: true,
      terminal: true,
      nativeContextMenu: true,
      workspaceRoots: ROOTS,
      settings: { ...MOCK_DEFAULT_SETTINGS, system: { closeBehavior: "hide-to-tray", projectSelection: { kind: "root", root: "/ws" } } },
    });
    expect(await headerName()).toContain("기본 프로젝트");
    await act(async () => { fireEvent.click(byTestId("sidebar-terminal")!); });
    const tabId = await waitFor(() => { const shown = shownSurfaces(container); expect(shown).toHaveLength(1); return shown[0]!.tabId!; });
    await act(async () => { fireEvent.click(byTestId(`sidebar-surface-menu-${tabId}`)!); });
    await act(async () => { chooseDynamicMenuItem("move:/ws/shop"); });
    await waitFor(() => expect(byTestId(`sidebar-surface-tree-${tabId}`)).toBeNull());
    await waitFor(() => {
      const saved = vi.mocked(api.updateSettings).mock.calls
        .map(([patch]) => (patch as { system?: { mainLayout?: { openSurfaces?: unknown[] } } }).system?.mainLayout)
        .filter((each) => each !== undefined)
        .at(-1);
      expect(saved?.openSurfaces).toEqual([expect.objectContaining({ tabId, projectRoot: "/ws/shop" })]);
    }, { timeout: MAIN_LAYOUT_SAVE_DELAY_MS * 10 });
    await act(async () => { fireEvent.click(byTestId("sidebar-project-button")!); });
    await act(async () => { fireEvent.click(await waitFor(() => { const el = byTestId("project-menu-project-ws-shop"); expect(el).not.toBeNull(); return el!; })); });
    await waitFor(() => expect(byTestId(`sidebar-surface-tree-${tabId}`)).not.toBeNull());
  });

  it("keeps a terminal where it is when the project picked from its open row menu was removed meanwhile", async () => {
    const { container, chooseDynamicMenuItem } = await renderApp({
      hasApiKey: true,
      terminal: true,
      nativeContextMenu: true,
      workspaceRoots: ROOTS,
      settings: { ...MOCK_DEFAULT_SETTINGS, system: { closeBehavior: "hide-to-tray", projectSelection: { kind: "root", root: "/ws" } } },
    });
    expect(await headerName()).toContain("기본 프로젝트");
    await act(async () => { fireEvent.click(byTestId("sidebar-terminal")!); });
    const tabId = await waitFor(() => { const shown = shownSurfaces(container); expect(shown).toHaveLength(1); return shown[0]!.tabId!; });
    // The native menu is open with "move to shop" in it ...
    await act(async () => { fireEvent.click(byTestId(`sidebar-surface-menu-${tabId}`)!); });
    // ... while shop is removed: the next list no longer holds it.
    const workspace = (window as unknown as { ave: { workspace: { pickRoot: ReturnType<typeof vi.fn>; listRoots: ReturnType<typeof vi.fn> } } }).ave.workspace;
    const remaining = [{ path: "/ws", isDefault: true }, { path: "/ws/notes", isDefault: false }];
    workspace.pickRoot.mockResolvedValueOnce({ ok: true, roots: remaining, added: "/ws/notes" });
    workspace.listRoots.mockResolvedValue({ ok: true, defaultRoot: "/ws", roots: remaining });
    await act(async () => { fireEvent.click(byTestId("sidebar-project-button")!); });
    await act(async () => { fireEvent.click(await waitFor(() => { const el = byTestId("project-menu-add"); expect(el).not.toBeNull(); return el!; })); });
    await waitFor(() => expect(byTestId("sidebar-project-header")?.textContent).toContain("notes"));

    expect(() => act(() => { chooseDynamicMenuItem("move:/ws/shop"); })).toThrow("project-unknown");
    await openWindowNotice(container, "그 프로젝트가 더 이상 열려 있지 않아 터미널 또는 페이지를 옮기지 않았습니다.");
    // Still the default project's terminal.
    await act(async () => { fireEvent.click(byTestId("sidebar-project-button")!); });
    await act(async () => { fireEvent.click(await waitFor(() => { const el = byTestId("project-menu-project-ws"); expect(el).not.toBeNull(); return el!; })); });
    await waitFor(() => expect(byTestId(`sidebar-surface-tree-${tabId}`)).not.toBeNull());
  });

  describe("removing a project (cases 29–31)", () => {
    function renderForRemoval(counts: Record<string, number> = {}, system: Record<string, unknown> = {}, roots = ROOTS) {
      return renderApp({
        hasApiKey: true,
        terminal: true,
        nativeContextMenu: true,
        workspaceRoots: roots,
        workspaceRemovalCounts: counts,
        settings: { ...MOCK_DEFAULT_SETTINGS, system: { closeBehavior: "hide-to-tray", projectSelection: { kind: "all" }, expandedProjectRoots: ["/ws", "/ws/shop"], ...system } },
      });
    }
    const workspaceApi = () => (window as unknown as { ave: { workspace: Record<string, ReturnType<typeof vi.fn>> } }).ave.workspace;
    async function chooseRemove(rendered: Awaited<ReturnType<typeof renderForRemoval>>) {
      const row = await waitFor(() => { const el = byTestId("sidebar-project-ws-shop"); expect(el).not.toBeNull(); return el!; });
      await act(async () => { fireEvent.contextMenu(row); });
      await act(async () => { rendered.chooseNativeMenuCommand("project.remove"); });
    }

    it("removes at once when nothing would be lost, forgets the project, and 되돌리기 brings it back", async () => {
      const rendered = await renderForRemoval({}, { recentProjectRoots: ["/ws/shop", "/ws"] });
      await chooseRemove(rendered);
      await waitFor(() => expect(byTestId("sidebar-project-ws-shop")).toBeNull());
      expect(byTestId("remove-project-dialog")).toBeNull();
      expect(workspaceApi().previewRemoveRoot).toHaveBeenCalledWith("/ws/shop");
      expect(workspaceApi().removeRoot).toHaveBeenCalledWith("/ws/shop");
      const notice = await openWindowNotice(rendered.container, "shop 프로젝트를 제거했습니다.");
      // Nothing the window remembers still points at the folder.
      await waitFor(() => expect(rendered.api.updateSettings).toHaveBeenCalledWith({
        system: expect.objectContaining({ recentProjectRoots: ["/ws"], expandedProjectRoots: ["/ws"] }),
      }));

      await act(async () => { fireEvent.click(within(notice).getByRole("button", { name: "되돌리기" })); });
      await waitFor(() => expect(workspaceApi().pickRoot).toHaveBeenCalledWith({ ackToken: "undo:/ws/shop" }));
      await waitFor(() => expect(byTestId("sidebar-project-ws-shop")).not.toBeNull());
      await openWindowNotice(rendered.container, "shop 프로젝트를 다시 추가했습니다.");
    });

    it("asks first when something would be lost, with 취소 focused, and keeps the project on 취소", async () => {
      const rendered = await renderForRemoval({ streamingSessions: 1, pathGrants: 2, detachableSessions: 3 });
      await chooseRemove(rendered);
      const dialog = await waitFor(() => { const el = byTestId("remove-project-dialog"); expect(el).not.toBeNull(); return el!; });
      expect(document.activeElement).toBe(byTestId("remove-project-cancel"));
      expect(byTestId("remove-project-loss-streamingSessions")?.textContent).toBe("진행 중인 응답 1개가 멈춥니다");
      expect(byTestId("remove-project-loss-pathGrants")?.textContent).toContain("2개가 삭제됩니다");
      expect(byTestId("remove-project-loss-routines")).toBeNull();
      expect(byTestId("remove-project-keeps")?.textContent).toContain("대화 3개");
      expect(dialog.textContent).toContain("되돌리기는 프로젝트 목록만 복원합니다.");
      await act(async () => { fireEvent.click(byTestId("remove-project-cancel")!); });
      await waitFor(() => expect(byTestId("remove-project-dialog")).toBeNull());
      expect(workspaceApi().removeRoot).not.toHaveBeenCalled();
      expect(byTestId("sidebar-project-ws-shop")).not.toBeNull();
    });

    it("counts the project's open terminals and pages, and closes them when the removal is confirmed", async () => {
      const rendered = await renderForRemoval({}, { projectSelection: { kind: "root", root: "/ws/shop" } });
      expect(await headerName()).toContain("shop");
      await act(async () => { fireEvent.click(byTestId("sidebar-terminal")!); });
      const tabId = await waitFor(() => { const shown = shownSurfaces(rendered.container); expect(shown).toHaveLength(1); return shown[0]!.tabId!; });
      await act(async () => { fireEvent.click(byTestId("sidebar-project-button")!); });
      await act(async () => { fireEvent.click(await waitFor(() => { const el = byTestId("project-menu-all"); expect(el).not.toBeNull(); return el!; })); });
      await chooseRemove(rendered);
      await waitFor(() => expect(byTestId("remove-project-loss-closingTerminals")?.textContent).toBe("터미널 1개가 닫히고 그 안에서 실행 중인 명령이 종료됩니다"));
      // One terminal, listed once: no separate count of the same terminal from main.
      expect(byTestId("remove-project-losses")!.querySelectorAll("li")).toHaveLength(1);
      await act(async () => { fireEvent.click(byTestId("remove-project-confirm")!); });
      await waitFor(() => expect(byTestId("sidebar-project-ws-shop")).toBeNull());
      expect(shownSurfaces(rendered.container)).toEqual([]);
      expect(byTestId(`sidebar-surface-tree-${tabId}`)).toBeNull();
      expect((rendered.api as unknown as { terminal: { kill: ReturnType<typeof vi.fn> } }).terminal.kill).toHaveBeenCalledWith(tabId);
    });

    it("asks first when the only loss is conversations losing their project link, and says what stays", async () => {
      const rendered = await renderForRemoval({ detachableSessions: 1 });
      await chooseRemove(rendered);
      const dialog = await waitFor(() => { const el = byTestId("remove-project-dialog"); expect(el).not.toBeNull(); return el!; });
      expect(byTestId("remove-project-losses")).toBeNull();
      expect(byTestId("remove-project-keeps")?.textContent).toContain("대화 1개는 기록이 그대로 남습니다");
      expect(dialog.textContent).toContain("되돌리기는 프로젝트 목록만 복원합니다.");
      expect(workspaceApi().removeRoot).not.toHaveBeenCalled();
    });

    it("does not count, or close, a terminal of a child project when its parent folder is removed", async () => {
      const roots = [...ROOTS, { path: "/ws/shop/child", isDefault: false }];
      const rendered = await renderForRemoval({}, { projectSelection: { kind: "root", root: "/ws/shop/child" } }, roots);
      expect(await headerName()).toContain("child");
      await act(async () => { fireEvent.click(byTestId("sidebar-terminal")!); });
      const tabId = await waitFor(() => { const shown = shownSurfaces(rendered.container); expect(shown).toHaveLength(1); return shown[0]!.tabId!; });
      await act(async () => { fireEvent.click(byTestId("sidebar-project-button")!); });
      await act(async () => { fireEvent.click(await waitFor(() => { const el = byTestId("project-menu-all"); expect(el).not.toBeNull(); return el!; })); });
      await chooseRemove(rendered);
      // Nothing of the parent's would be lost, so it goes at once, and the child's terminal stays open.
      await waitFor(() => expect(byTestId("sidebar-project-ws-shop")).toBeNull());
      expect(byTestId("remove-project-dialog")).toBeNull();
      expect(shownSurfaces(rendered.container).map((each) => each.tabId)).toEqual([tabId]);
      expect((rendered.api as unknown as { terminal: { kill: ReturnType<typeof vi.fn> } }).terminal.kill).not.toHaveBeenCalled();
    });

    it("removes nothing, and says why, when the preview cannot be made", async () => {
      const rendered = await renderForRemoval();
      workspaceApi().previewRemoveRoot.mockResolvedValueOnce({ ok: false, error: "preview-failed" });
      await chooseRemove(rendered);
      await openWindowNotice(rendered.container, "이 프로젝트를 제거하면 무엇이 사라지는지 확인하지 못해 제거하지 않았습니다.");
      expect(workspaceApi().removeRoot).not.toHaveBeenCalled();
      expect(byTestId("sidebar-project-ws-shop")).not.toBeNull();
    });

    it("says it is too late when 되돌리기 comes after the token expired", async () => {
      const rendered = await renderForRemoval();
      await chooseRemove(rendered);
      const notice = await openWindowNotice(rendered.container, "shop 프로젝트를 제거했습니다.");
      workspaceApi().pickRoot.mockResolvedValueOnce({ ok: false, error: "ack-expired" });
      await act(async () => { fireEvent.click(within(notice).getByRole("button", { name: "되돌리기" })); });
      await openWindowNotice(rendered.container, "되돌릴 수 있는 시간이 지났습니다.");
      expect(byTestId("sidebar-project-ws-shop")).toBeNull();
    });
  });

  it("does not reopen a closed terminal into a project that has since been removed", async () => {
    const { container } = await renderInProject({ kind: "root", root: "/ws/shop" });
    expect(await headerName()).toContain("shop");
    await act(async () => { fireEvent.click(byTestId("sidebar-terminal")!); });
    await waitFor(() => expect(shownSurfaces(container)).toHaveLength(1));
    const close = container.querySelector('[data-testid="surface-pane"]')!.closest('[data-testid="pane"]')!
      .querySelector<HTMLButtonElement>('[data-testid="pane-close"]')!;
    await act(async () => { fireEvent.click(close); });
    await waitFor(() => expect(shownSurfaces(container)).toHaveLength(0));
    // The shop project is removed: the next list no longer holds it, and adding a folder refreshes the list.
    const workspace = (window as unknown as { ave: { workspace: { pickRoot: ReturnType<typeof vi.fn>; listRoots: ReturnType<typeof vi.fn> } } }).ave.workspace;
    const remaining = [{ path: "/ws", isDefault: true }, { path: "/ws/notes", isDefault: false }];
    workspace.pickRoot.mockResolvedValueOnce({ ok: true, roots: remaining, added: "/ws/notes" });
    workspace.listRoots.mockResolvedValue({ ok: true, defaultRoot: "/ws", roots: remaining });
    await act(async () => { fireEvent.click(byTestId("sidebar-project-button")!); });
    await act(async () => { fireEvent.click(await waitFor(() => { const el = byTestId("project-menu-add"); expect(el).not.toBeNull(); return el!; })); });
    await waitFor(() => expect(byTestId("sidebar-project-header")?.textContent).toContain("notes"));
    const darwin = isDarwin();
    await act(async () => { fireEvent.keyDown(window, { key: "t", shiftKey: true, metaKey: darwin, ctrlKey: !darwin }); });
    await openWindowNotice(container, "프로젝트 목록을 아직 불러오지 못해 이 터미널 또는 페이지를 열지 않았습니다.");
    expect(shownSurfaces(container)).toEqual([]);
  });

  it("keeps a restored terminal's last-used time across launches, and puts one saved without a time below today's conversations", async () => {
    const now = Date.now();
    const timed = "terminal:abcd1234-2";
    const untimed = "terminal:abcd1234-3";
    const mainLayout = {
      version: 2,
      tree: { kind: "leaf", chatGroupId: "main" },
      focusedId: "main",
      surfaces: {},
      openSurfaces: [
        { kind: "terminal", tabId: untimed, ordinal: 1, cwd: "/ws", url: null, projectRoot: "/ws" },
        { kind: "terminal", tabId: timed, ordinal: 2, cwd: "/ws", url: null, projectRoot: "/ws", usedAt: now - 60 * 60_000 },
      ],
      panelOpenIds: [],
      thumbnailOpenIds: [],
      sideTabs: {},
    };
    const { api } = await renderApp({
      hasApiKey: true,
      terminal: true,
      workspaceRoots: ROOTS,
      sessions: [{ id: "sess-today", title: "오늘 대화", modifiedAt: new Date(now - 2 * 60 * 60_000).toISOString(), projectRoot: "/ws", projectName: "ws" }],
      settings: { ...MOCK_DEFAULT_SETTINGS, system: { closeBehavior: "hide-to-tray", projectSelection: { kind: "root", root: "/ws" }, mainLayout } },
    });
    const order = () => [...document.querySelectorAll<HTMLElement>('[data-testid^="sidebar-surface-tree-"], [data-testid="sidebar-row-session-sess-today"]')]
      .map((row) => row.getAttribute("data-testid"));
    await waitFor(() => expect(order()).toEqual([
      `sidebar-surface-tree-${timed}`,
      "sidebar-row-session-sess-today",
      `sidebar-surface-tree-${untimed}`,
    ]));
    // Showing the untimed one gives it a time, which the next save keeps; the other keeps the time it came back with.
    await act(async () => { fireEvent.click(byTestId(`sidebar-surface-${untimed}`)!); });
    const saved = await waitFor(() => {
      const last = vi.mocked(api.updateSettings).mock.calls
        .map(([patch]) => (patch as { system?: { mainLayout?: { openSurfaces?: Array<{ tabId: string; usedAt?: number }> } } }).system?.mainLayout)
        .filter((each) => each !== undefined)
        .at(-1);
      expect(last?.openSurfaces?.find((each) => each.tabId === untimed)?.usedAt).toBeGreaterThanOrEqual(now);
      return last!;
    }, { timeout: MAIN_LAYOUT_SAVE_DELAY_MS * 10 });
    expect(saved.openSurfaces!.find((each) => each.tabId === timed)!.usedAt).toBe(now - 60 * 60_000);
  });
});
