import { beforeEach, describe, expect, it, vi } from "vitest";
import { UI } from "../../../shared/ipc-channels.js";
import { NATIVE_MENU_MAX_ITEMS } from "../../../shared/native-context-menu.js";

const {
  handlers,
  popupMock,
  sendMock,
  isDestroyedMock,
  getURLMock,
  fromWebContentsMock,
  auditLogMock,
  menuTemplates,
} = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  popupMock: vi.fn(),
  sendMock: vi.fn(),
  isDestroyedMock: vi.fn(() => false),
  getURLMock: vi.fn(() => "file:///app/index.html"),
  fromWebContentsMock: vi.fn(),
  auditLogMock: vi.fn(),
  menuTemplates: [] as unknown[],
}));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
  BrowserWindow: {
    fromWebContents: fromWebContentsMock,
  },
  Menu: {
    buildFromTemplate: vi.fn((template: unknown) => {
      menuTemplates.push(template);
      return { popup: popupMock };
    }),
  },
}));

function invoke(channel: string, ...args: unknown[]): unknown {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler registered for: ${channel}`);
  return fn(...args);
}

function makeEvent(url = "file:///app/index.html") {
  getURLMock.mockReturnValue(url);
  return {
    sender: {
      isDestroyed: isDestroyedMock,
      send: sendMock,
      getURL: getURLMock,
    },
    senderFrame: {
      url,
    },
  };
}

async function setup() {
  handlers.clear();
  vi.clearAllMocks();
  menuTemplates.length = 0;
  fromWebContentsMock.mockReturnValue({ isDestroyed: vi.fn(() => false) });
  const { registerUiHandlers } = await import("../ui.js");
  registerUiHandlers({
    auditLogger: { log: auditLogMock },
    getMainWindow: vi.fn(),
  } as never);
}

function firstTemplate() {
  return menuTemplates[0] as Array<{
    label?: string;
    type?: string;
    enabled?: boolean;
    checked?: boolean;
    click?: () => void;
    submenu?: Array<{
      label?: string;
      type?: string;
      enabled?: boolean;
      checked?: boolean;
      click?: () => void;
    }>;
  }>;
}

describe("ui IPC handlers", () => {
  beforeEach(async () => {
    await setup();
  });

  it("builds generic native commands in canonical order and emits typed click actions", () => {
    const event = makeEvent();

    const result = invoke(UI.nativeContextMenu, event, {
      requestId: "native-1",
      x: 10.4,
      y: 20.6,
      kind: "project",
      commands: [
        "project.remove",
        "project.reveal",
        "project.new-chat",
        "project.pin",
      ],
    });

    expect(result).toEqual({ ok: true });
    expect(popupMock).toHaveBeenCalledWith({
      window: expect.objectContaining({ isDestroyed: expect.any(Function) }),
      x: 10,
      y: 21,
    });

    const template = firstTemplate();
    expect(template.map((item) => item.type ?? "command")).toEqual([
      "command",
      "separator",
      "command",
      "command",
      "separator",
      "command",
    ]);
    for (const item of template) item.click?.();

    expect(sendMock.mock.calls.map(([, action]) => action)).toEqual([
      { requestId: "native-1", command: "project.new-chat" },
      { requestId: "native-1", command: "project.pin" },
      { requestId: "native-1", command: "project.reveal" },
      { requestId: "native-1", command: "project.remove" },
    ]);
    expect(sendMock.mock.calls.every(([channel]) => channel === UI.nativeContextAction)).toBe(true);
  });

  it("builds conversation commands in canonical order and emits typed click actions", () => {
    const event = makeEvent();

    const result = invoke(UI.nativeContextMenu, event, {
      requestId: "conversation-1",
      x: 4,
      y: 8,
      kind: "conversation",
      commands: ["conversation.unpin", "conversation.open"],
    });

    expect(result).toEqual({ ok: true });
    const template = firstTemplate();
    expect(template.map((item) => item.type ?? "command")).toEqual([
      "command",
      "separator",
      "command",
    ]);
    for (const item of template) item.click?.();

    expect(sendMock.mock.calls.map(([, action]) => action)).toEqual([
      { requestId: "conversation-1", command: "conversation.open" },
      { requestId: "conversation-1", command: "conversation.unpin" },
    ]);
  });

  it("builds command item actions in canonical order", () => {
    const event = makeEvent();

    const result = invoke(UI.nativeContextMenu, event, {
      requestId: "command-1",
      x: 4,
      y: 8,
      kind: "command-item",
      commands: ["command.copy", "command.activate"],
    });

    expect(result).toEqual({ ok: true });
    const template = firstTemplate();
    expect(template.map((item) => item.type ?? "command")).toEqual([
      "command",
      "separator",
      "command",
    ]);
    for (const item of template) item.click?.();

    expect(sendMock.mock.calls.map(([, action]) => action)).toEqual([
      { requestId: "command-1", command: "command.activate" },
      { requestId: "command-1", command: "command.copy" },
    ]);
  });

  it.each([
    ["cross-kind command", ["project.pin"]],
    ["unknown command", ["message.unknown"]],
    ["empty commands", []],
  ])("rejects native context payloads with %s", (_caseName, commands) => {
    const result = invoke(UI.nativeContextMenu, makeEvent(), {
      requestId: "native-invalid",
      x: 1,
      y: 2,
      kind: "message",
      commands,
    });

    expect(result).toEqual({ ok: false, error: "invalid-native-context-menu" });
    expect(popupMock).not.toHaveBeenCalled();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it("rejects plugin shell or child-frame senders", () => {
    const wellFormed = { requestId: "req-4", x: 1, y: 2, kind: "message", commands: ["message.copy"] };
    const pluginResult = invoke(
      UI.nativeContextMenu,
      makeEvent("file:///app/plugin-ui-shell.html"),
      wellFormed,
    );
    expect(pluginResult).toEqual({ ok: false, error: "unauthorized-frame" });

    const iframeEvent = makeEvent("file:///app/index.html");
    getURLMock.mockReturnValue("file:///app/host.html");
    const iframeResult = invoke(UI.nativeContextMenu, iframeEvent, { ...wellFormed, requestId: "req-5" });

    expect(iframeResult).toEqual({ ok: false, error: "unauthorized-frame" });
    expect(auditLogMock).toHaveBeenCalled();
    expect(popupMock).not.toHaveBeenCalled();
  });
});

describe("dynamic native menu", () => {
  beforeEach(async () => {
    await setup();
  });

  const payload = (sections: unknown) => ({
    requestId: "11111111-2222-4333-8444-555555555555",
    x: 12.4,
    y: 30.6,
    sections,
  });

  it("builds sections into one menu, separated, and echoes the clicked id back", () => {
    const result = invoke(UI.dynamicMenu, makeEvent(), payload([
      { items: [{ id: "shortcut:board", label: "업무 보드" }] },
      {
        items: [{
          id: "category:command",
          label: "명령",
          submenu: [{ id: "command:/new", label: "/new — 새 대화" }],
        }],
      },
    ]));
    expect(result).toEqual({ ok: true });
    expect(popupMock).toHaveBeenCalledWith(expect.objectContaining({ x: 12, y: 31 }));

    const template = firstTemplate();
    expect(template.map((item) => item.label ?? item.type))
      .toEqual(["업무 보드", "separator", "명령"]);

    expect(template[2]!.click).toBeUndefined();
    template[2]!.submenu![0]!.click!();
    expect(sendMock).toHaveBeenCalledWith(UI.dynamicMenuAction, {
      requestId: "11111111-2222-4333-8444-555555555555",
      id: "command:/new",
    });
  });

  it("draws the persona submenu first, its rows as radio items with the active one checked", () => {
    const result = invoke(UI.dynamicMenu, makeEvent(), payload([{
      items: [
        {
          id: "category:persona",
          label: "페르소나",
          submenu: [
            { id: "persona:default", label: "기본", checked: false },
            { id: "persona:coding", label: "코딩", checked: true },
          ],
        },
        { id: "category:command", label: "커맨드", submenu: [{ id: "command:/new", label: "/new" }] },
        { id: "category:plugin", label: "플러그인", submenu: [{ id: "plugin:meeting", label: "미팅" }] },
        { id: "category:skills", label: "스킬", submenu: [{ id: "skill:review", label: "review" }] },
      ],
    }]));
    expect(result).toEqual({ ok: true });

    const template = firstTemplate();
    expect(template.map((item) => item.label)).toEqual(["페르소나", "커맨드", "플러그인", "스킬"]);
    expect(template[0]!.submenu!.map((row) => [row.label, row.type, row.checked])).toEqual([
      ["기본", "radio", false],
      ["코딩", "radio", true],
    ]);
    expect(template[1]!.submenu![0]).not.toHaveProperty("type");
    expect(template[1]!.submenu![0]).not.toHaveProperty("checked");

    template[0]!.submenu![0]!.click!();
    expect(sendMock).toHaveBeenCalledWith(UI.dynamicMenuAction, {
      requestId: "11111111-2222-4333-8444-555555555555",
      id: "persona:default",
    });
  });

  it("flattens what a plugin name could otherwise do to the menu's structure", () => {
    invoke(UI.dynamicMenu, makeEvent(), payload([{
      items: [
        { id: "a", label: "메모\n관리자 권한 부여‮" },
        { id: "b", label: "가".repeat(400) },
        { id: "c", label: "   " },
        { id: "d", label: "정상" },
        { id: "e", label: "R&D" },
      ],
    }]));

    const labels = firstTemplate().map((item) => item.label);
    // Strip line breaks, bidi controls, and mnemonic markers so labels cannot impersonate adjacent rows.
    expect(labels).toEqual(["메모 관리자 권한 부여", "가".repeat(119) + "…", "정상", "R&&D"]);
  });

  it("refuses a payload with nothing to draw rather than popping an empty menu", () => {
    expect(invoke(UI.dynamicMenu, makeEvent(), payload([{ items: [{ label: "no id" }] }])))
      .toEqual({ ok: false, error: "invalid-dynamic-menu" });
    expect(invoke(UI.dynamicMenu, makeEvent(), { requestId: "x", x: 0, y: 0, sections: [] }))
      .toEqual({ ok: false, error: "invalid-dynamic-menu" });
    expect(popupMock).not.toHaveBeenCalled();
  });

  it("drops an accelerator that is not a key spec, keeping the row", () => {
    invoke(UI.dynamicMenu, makeEvent(), payload([{
      items: [
        { id: "a", label: "붙이기", accelerator: "CommandOrControl+U" },
        { id: "b", label: "이상한 것", accelerator: "not; a spec" },
        { id: "c", label: "빈 키", accelerator: "Ctrl+" },
        { id: "d", label: "키 없음", accelerator: "Ctrl+Shift" },
        { id: "e", label: "가짜 수식", accelerator: "NotAModifier+A" },
        { id: "f", label: "맨 키", accelerator: "K" },
      ],
    }]));
    const template = firstTemplate() as Array<{ accelerator?: string }>;
    // Drop invalid accelerators without losing the entire native menu.
    expect(template.map((item) => item.accelerator))
      .toEqual(["CommandOrControl+U", undefined, undefined, undefined, undefined, undefined]);
  });

  it("drops a category whose children did not fit instead of drawing it as a dead row", () => {
    // A truncated category must remain a container, never become an unregistered leaf action.
    const filler = Array.from({ length: NATIVE_MENU_MAX_ITEMS }, (_, index) => ({
      id: `leaf:${index}`,
      label: `항목 ${index}`,
    }));
    invoke(UI.dynamicMenu, makeEvent(), payload([{
      items: [...filler, { id: "category:skills", label: "스킬", submenu: [{ id: "skill:a", label: "a" }] }],
    }]));
    const template = firstTemplate();
    expect(template).toHaveLength(NATIVE_MENU_MAX_ITEMS);
    expect(template.map((item) => item.label)).not.toContain("스킬");
  });

  it("stops at the depth a menu can be, so a payload cannot nest without bound", () => {
    invoke(UI.dynamicMenu, makeEvent(), payload([{
      items: [{
        id: "l1",
        label: "1",
        submenu: [
          { id: "l2-leaf", label: "고를 수 있는 것" },
          { id: "l2-deep", label: "2", submenu: [{ id: "l3", label: "3" }] },
        ],
      }],
    }]));
    const submenu = firstTemplate()[0]!.submenu!;
    expect(submenu.map((item) => item.label)).toEqual(["고를 수 있는 것"]);
  });

  it("refuses a tree that is ONLY too deep rather than drawing rows nothing can pick", () => {
    // Reject menus with no drawable leaves instead of showing empty containers.
    expect(invoke(UI.dynamicMenu, makeEvent(), payload([{
      items: [{
        id: "l1",
        label: "1",
        submenu: [{ id: "l2", label: "2", submenu: [{ id: "l3", label: "3" }] }],
      }],
    }]))).toEqual({ ok: false, error: "invalid-dynamic-menu" });
  });
});
