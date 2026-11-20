// @vitest-environment jsdom
import "../../../test/renderer/setup.js";
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { Popover, PopoverContent, PopoverTrigger } from "../../components/ui/popover.js";
import { BROWSER_NATIVE_HOLE_ATTRIBUTE } from "../../shared/browser-native-input.js";
import { installBrowserNativeInput } from "../browser-native-input.js";

const { send } = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock("electron", () => ({ ipcRenderer: { send, on: vi.fn(), removeListener: vi.fn() } }));

afterEach(() => { vi.useRealTimers(); send.mockReset(); });

it("moves host focus into a pressed page and dismisses a popover before its outside-pointer listener is ready", () => {
  vi.useFakeTimers();
  render(<><Popover><PopoverTrigger>Credential</PopoverTrigger><PopoverContent><button type="button">Settings</button></PopoverContent></Popover>
    <button type="button" data-testid="page-hole" {...{ [BROWSER_NATIVE_HOLE_ATTRIBUTE]: JSON.stringify({ tabId: "browser:one", webContentsId: 9, epoch: 3 }) }} /></>);
  const hole = screen.getByTestId("page-hole");
  const handlers = new Map<string, (event: MouseEvent) => void>();
  const hostDocument = { documentElement: document.documentElement,
    elementFromPoint: () => hole, querySelectorAll: () => [hole],
    addEventListener: (name: string, handler: (event: MouseEvent) => void) => handlers.set(name, handler),
    removeEventListener: (name: string) => handlers.delete(name),
  };
  const stop = installBrowserNativeInput(hostDocument as unknown as Document);
  const input = (type: string, isTrusted = true) => act(() => handlers.get(type)?.({ type, isTrusted, clientX: 20, clientY: 30,
    button: 0, buttons: type === "mousedown" ? 1 : 0, detail: 1, deltaX: 0, deltaY: 1, deltaMode: 0,
    preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() } as unknown as MouseEvent));
  try {
    fireEvent.click(screen.getByText("Credential"));
    expect(screen.getByText("Settings")).toHaveFocus();
    // Hold scheduled callbacks: the page can be pressed as soon as the popover renders.
    input("mousedown", false);
    input("wheel");
    expect(screen.getByText("Settings")).toHaveFocus();
    expect(screen.getByRole("dialog")).toBeVisible();
    input("mousedown");
    expect(hole).toHaveFocus();
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(send).toHaveBeenLastCalledWith(expect.any(String), expect.objectContaining({ type: "mouseDown", tabId: "browser:one" }));
  } finally { stop(); }
});
