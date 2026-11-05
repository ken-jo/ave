// @vitest-environment jsdom
/** The sidebar's project shell (Sidebar E, S2): the rail, the project menu, the selected project, the launchers and the
 * project home. */
import "./setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, waitFor } from "@testing-library/react";
import { renderApp } from "./render-app.js";
import { waitForToast } from "./helpers.js";
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
    await waitForToast(container, "notes 프로젝트를 추가하고 전환했습니다.");
    await act(async () => { fireEvent.click(container.querySelector('[data-testid="status-toast-action"]')!); });
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
    await waitForToast(container, "프로젝트 목록을 아직 불러오지 못해 이 터미널 또는 페이지를 열지 않았습니다.");
    expect(shownSurfaces(container)).toEqual([]);
  });
});
