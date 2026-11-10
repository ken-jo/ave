import { beforeEach, describe, expect, it, vi } from "vitest";

type ContextMenuParams = {
  selectionText: string;
  isEditable: boolean;
  editFlags: {
    canCut: boolean;
    canCopy: boolean;
    canPaste: boolean;
    canSelectAll: boolean;
  };
  x: number;
  y: number;
};

type ContextMenuHandler = (
  event: { preventDefault: () => void },
  params: ContextMenuParams,
) => void;

const {
  buildFromTemplateMock,
  fromWebContentsMock,
  popupMock,
  menuTemplates,
  mainWindowForContentsMock,
  windows,
  independentGuestMock,
  guestWindowIdMock,
  allowsNativeContextMenuMock,
} = vi.hoisted(() => ({
  buildFromTemplateMock: vi.fn(),
  fromWebContentsMock: vi.fn(),
  popupMock: vi.fn(),
  menuTemplates: [] as unknown[],
  mainWindowForContentsMock: vi.fn(),
  windows: [] as unknown[],
  independentGuestMock: vi.fn(),
  guestWindowIdMock: vi.fn(),
  allowsNativeContextMenuMock: vi.fn(),
}));

vi.mock("electron", () => ({
  BrowserWindow: {
    fromWebContents: fromWebContentsMock,
  },
  Menu: {
    buildFromTemplate: buildFromTemplateMock,
  },
}));

vi.mock("../app-state.js", () => ({ getMainWindows: () => windows, mainWindowForContents: mainWindowForContentsMock }));
vi.mock("../browser/browser-tab-registry.js", () => ({ browserTabRegistry: {
  isIndependentGuest: independentGuestMock, guestWindowId: guestWindowIdMock,
  allowsNativeContextMenu: allowsNativeContextMenuMock,
} }));

import { installNativeEditContextMenu } from "../native-edit-context-menu.js";

function install() {
  let handler: ContextMenuHandler | undefined;
  const contents = {
    id: 82,
    isFocused: vi.fn(() => true),
    getZoomFactor: vi.fn(() => 2),
    on: vi.fn((eventName: string, callback: ContextMenuHandler) => {
      if (eventName === "context-menu") handler = callback;
    }),
  };
  installNativeEditContextMenu(contents as never);
  if (!handler) throw new Error("context-menu handler was not installed");
  return { contents, handler };
}

function params(overrides: Partial<ContextMenuParams> = {}): ContextMenuParams {
  return {
    selectionText: "",
    isEditable: false,
    editFlags: {
      canCut: false,
      canCopy: false,
      canPaste: false,
      canSelectAll: false,
    },
    x: 12,
    y: 34,
    ...overrides,
  };
}

describe("installNativeEditContextMenu", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    menuTemplates.length = 0;
    buildFromTemplateMock.mockImplementation((template: unknown) => {
      menuTemplates.push(template);
      return { popup: popupMock };
    });
    fromWebContentsMock.mockReturnValue(null);
    mainWindowForContentsMock.mockReturnValue(null);
    independentGuestMock.mockReturnValue(false);
    guestWindowIdMock.mockReturnValue(7);
    allowsNativeContextMenuMock.mockReturnValue(true);
    windows.length = 0;
  });

  it("uses editable roles and opens against the owning window at event coordinates", () => {
    const owner = { id: 7 };
    fromWebContentsMock.mockReturnValue(owner);
    const { contents, handler } = install();
    const preventDefault = vi.fn();

    handler({ preventDefault }, params({
      isEditable: true,
      x: 41,
      y: 59,
      editFlags: {
        canCut: true,
        canCopy: false,
        canPaste: true,
        canSelectAll: false,
      },
    }));

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(menuTemplates[0]).toEqual([
      { role: "cut", enabled: true },
      { role: "copy", enabled: false },
      { role: "paste", enabled: true },
      { type: "separator" },
      { role: "selectAll", enabled: false },
    ]);
    expect(fromWebContentsMock).toHaveBeenCalledWith(contents);
    expect(popupMock).toHaveBeenCalledWith({ window: owner, x: 41, y: 59 });
  });

  it("uses selection roles and falls back to a coordinate-only popup without an owner", () => {
    const { handler } = install();
    const preventDefault = vi.fn();

    handler({ preventDefault }, params({
      selectionText: " selected text ",
      x: 5,
      y: 9,
      editFlags: {
        canCut: false,
        canCopy: false,
        canPaste: false,
        canSelectAll: true,
      },
    }));

    expect(preventDefault).toHaveBeenCalledOnce();
    expect(menuTemplates[0]).toEqual([
      { role: "copy", enabled: true },
      { type: "separator" },
      { role: "selectAll", enabled: true },
    ]);
    expect(popupMock).toHaveBeenCalledWith({ x: 5, y: 9 });
  });

  it("does nothing for non-editable content without a selection", () => {
    const { handler } = install();
    const preventDefault = vi.fn();

    handler({ preventDefault }, params({ selectionText: "   " }));

    expect(preventDefault).not.toHaveBeenCalled();
    expect(buildFromTemplateMock).not.toHaveBeenCalled();
    expect(fromWebContentsMock).not.toHaveBeenCalled();
    expect(popupMock).not.toHaveBeenCalled();
  });

  it("keeps main UI menu coordinates unchanged", () => {
    const owner = { id: 7 };
    mainWindowForContentsMock.mockReturnValue(owner);
    const { handler } = install();
    handler({ preventDefault: vi.fn() }, params({ isEditable: true, x: 41, y: 59 }));
    expect(popupMock).toHaveBeenCalledExactlyOnceWith({ window: owner, x: 41, y: 59 });
    expect(fromWebContentsMock).not.toHaveBeenCalled();
  });

  it("adds attached native container and page origins without applying UI zoom", () => {
    const { contents, handler } = install();
    independentGuestMock.mockReturnValue(true);
    const page = { webContents: contents, children: [], getBounds: () => ({ x: -20, y: -10, width: 600, height: 400 }) };
    const container = { children: [page], getBounds: () => ({ x: 400, y: 100, width: 500, height: 300 }) };
    const owner = { id: 7, isFocused: () => true, isVisible: () => true, isMinimized: () => false,
      contentView: { children: [container] } };
    windows.push(owner);
    fromWebContentsMock.mockReturnValue(owner);
    handler({ preventDefault: vi.fn() }, params({ isEditable: true, x: 30, y: 40 }));
    expect(popupMock).toHaveBeenCalledExactlyOnceWith({ window: owner, x: 410, y: 130 });
    expect(contents.getZoomFactor).not.toHaveBeenCalled();
  });

  it("does not open a native page menu without authoritative human takeover", () => {
    const { contents, handler } = install();
    independentGuestMock.mockReturnValue(true);
    allowsNativeContextMenuMock.mockReturnValue(false);
    const owner = { id: 7, isFocused: () => true, isVisible: () => true, isMinimized: () => false,
      contentView: { children: [{ webContents: contents, children: [], getBounds: () => ({ x: 400, y: 100 }) }] } };
    windows.push(owner);
    fromWebContentsMock.mockReturnValue(owner);
    const preventDefault = vi.fn();
    handler({ preventDefault }, params({ isEditable: true }));
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(allowsNativeContextMenuMock).toHaveBeenCalledExactlyOnceWith(contents.id);
    expect(buildFromTemplateMock).not.toHaveBeenCalled();
    expect(popupMock).not.toHaveBeenCalled();
  });

  it.each(["detached", "foreign-contents", "inactive-owner", "hidden-owner", "minimized-owner", "unfocused-page", "missing-owner"] as const)("refuses a native editing menu for %s without activating any window", reason => {
    const { contents, handler } = install();
    independentGuestMock.mockReturnValue(true);
    const page = { webContents: reason === "foreign-contents" ? { id: contents.id } : contents,
      children: [], getBounds: () => ({ x: 50, y: 80, width: 600, height: 400 }) };
    const owner = { id: 7, isFocused: () => reason !== "inactive-owner", isVisible: () => reason !== "hidden-owner",
      isMinimized: () => reason === "minimized-owner", focus: vi.fn(),
      contentView: { children: reason === "detached" ? [] : [page] } };
    if (reason !== "missing-owner") windows.push(owner);
    if (reason === "unfocused-page") contents.isFocused.mockReturnValue(false);
    fromWebContentsMock.mockReturnValue(owner);
    const preventDefault = vi.fn();
    handler({ preventDefault }, params({ isEditable: true }));
    expect(preventDefault).toHaveBeenCalledOnce();
    expect(buildFromTemplateMock).not.toHaveBeenCalled();
    expect(popupMock).not.toHaveBeenCalled();
    expect(owner.focus).not.toHaveBeenCalled();
  });
});
