// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BrowserTabControlState } from "../../../../shared/browser-surface.js";
import { browserControlFixture } from "../../../../__tests__/support/browser-control-fixture.js";
import type { AveApi } from "../../types.js";
import { __resetBrowserTabBridgeForTest, registerBrowserTabHost } from "../../preview/agent-browser-bridge.js";
import { BrowserSurfaceTools } from "../BrowserSurfaceTools.js";

const TAB = "browser:fixed";
let unregister: (() => void) | undefined;
afterEach(() => { cleanup(); unregister?.(); unregister = undefined; __resetBrowserTabBridgeForTest(); });

function mount() {
  let emit!: (state: BrowserTabControlState) => void;
  const pause = vi.fn(async (): Promise<{ ok: true } | { ok: false; error: string }> => ({ ok: true }));
  const resume = vi.fn(async () => ({ ok: true }));
  const api = { browserWorkspace: {}, browserTabs: { pause, resume,
    getState: vi.fn(async () => ({ revision: 0, tabs: [] })),
    onTabOp: vi.fn(() => () => {}),
    onControl: (handler: typeof emit) => { emit = handler; return () => {}; },
  } } as unknown as AveApi;
  unregister = registerBrowserTabHost(api, { sessionId: () => "fixture-session", hasTab: (id) => id === TAB,
    selectTab: vi.fn(), closeTab: vi.fn() });
  const view = render(<BrowserSurfaceTools api={api} tabId={TAB} onOpenUrl={vi.fn()} />);
  return { ...view, emit, pause, resume };
}

describe("persistent browser control toolbar", () => {
  it("keeps Stop and Resume inside the same toolbar through human, active and paused state", async () => {
    const { emit, pause, resume, container } = mount();
    const toolbar = screen.getByTestId("browser-control-toolbar");
    const parent = toolbar.parentElement!;
    expect(screen.queryByTestId("agent-browser-control-badge")).toBeNull();
    expect(parent.children).toHaveLength(1);
    act(() => emit(browserControlFixture([TAB], "agent-active", 1)));
    expect(screen.getByTestId("browser-control-toolbar")).toBe(toolbar);
    expect(toolbar).toContainElement(screen.getByTestId("agent-browser-control-badge"));
    fireEvent.click(screen.getByTestId("agent-browser-control-stop"));
    await act(async () => {});
    expect(pause).toHaveBeenCalledWith(TAB);
    act(() => emit(browserControlFixture([TAB], "human-paused", 2)));
    expect(toolbar).toContainElement(screen.getByTestId("agent-browser-control-resume"));
    fireEvent.click(screen.getByTestId("agent-browser-control-resume"));
    await act(async () => {});
    expect(resume).toHaveBeenCalledWith(TAB);
    act(() => emit(browserControlFixture([TAB], "human", 3)));
    expect(screen.queryByTestId("agent-browser-control-badge")).toBeNull();
    expect(screen.getByTestId("browser-control-toolbar")).toBe(toolbar);
    expect(parent.children).toHaveLength(1);
    expect(container.querySelectorAll('[data-testid="browser-control-toolbar"]')).toHaveLength(1);
  });

  it("keeps a failed control action visible and accessible within that toolbar", async () => {
    const { emit, pause } = mount();
    const toolbar = screen.getByTestId("browser-control-toolbar");
    pause.mockResolvedValueOnce({ ok: false, error: "action-refused" });
    act(() => emit(browserControlFixture([TAB], "agent-active", 1)));
    fireEvent.click(screen.getByTestId("agent-browser-control-stop"));
    await act(async () => {});
    const error = screen.getByRole("alert");
    expect(toolbar).toContainElement(error);
    expect(error.title).toBe(error.textContent);
    expect(error.textContent).toBe("브라우저 제어 상태를 변경하지 못했습니다.");
    expect(toolbar.parentElement!.children).toHaveLength(1);
  });
});
