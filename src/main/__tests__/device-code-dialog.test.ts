import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BaseWindow } from "electron";
import { setLocale } from "../../i18n/index.js";
import { en } from "../../i18n/messages/en.js";
import { ko } from "../../i18n/messages/ko.js";

const state = vi.hoisted(() => ({
  windows: [] as unknown[], clipboard: vi.fn(), external: vi.fn(async () => undefined),
  background: false, loadError: false,
  permissions: { request: vi.fn(), check: vi.fn(), device: vi.fn(), requestFilter: vi.fn() },
}));

class DialogWindow extends EventEmitter {
  destroyed = false;
  documentUrl = "";
  frame = {};
  options: Record<string, unknown>;
  webContents = Object.assign(new EventEmitter(), {
    id: 12,
    mainFrame: this.frame,
    getURL: () => this.documentUrl,
    isDestroyed: () => this.destroyed,
    setWindowOpenHandler: vi.fn(),
  });
  setMenu = vi.fn();
  show = vi.fn();
  showInactive = vi.fn();
  isDestroyed = () => this.destroyed;
  loadURL = vi.fn(async (url: string) => {
    this.documentUrl = url;
    if (state.loadError) throw new Error("load failed");
  });
  destroy = vi.fn(() => {
    this.destroyed = true;
    this.emit("closed");
  });
  constructor(options: Record<string, unknown>) {
    super();
    this.options = options;
    state.windows.push(this);
  }
}

vi.mock("electron", () => ({
  BrowserWindow: class extends DialogWindow {},
  clipboard: { writeText: state.clipboard },
  shell: { openExternal: state.external },
  session: { fromPartition: vi.fn(() => ({
    setPermissionRequestHandler: state.permissions.request,
    setPermissionCheckHandler: state.permissions.check,
    setDevicePermissionHandler: state.permissions.device,
    webRequest: { onBeforeRequest: state.permissions.requestFilter },
  })) },
}));
vi.mock("../e2e-window-presentation.js", () => ({
  isBackgroundE2eRuntime: () => state.background,
  showWindowForRuntime: (window: DialogWindow) => state.background ? window.showInactive() : window.show(),
}));

const { buildDeviceCodeDialogHtml, createDeviceCodePresentation } = await import("../device-code-dialog.js");

const prompt = () => ({ userCode: "ABCD-EFGH", verificationUri: "https://auth.example.test/verify",
  verificationUriComplete: "https://auth.example.test/verify?user_code=ABCD-EFGH", expiresAt: Date.now() + 60_000 });
const parent = () => Object.assign(new EventEmitter(), { isDestroyed: () => false }) as unknown as BaseWindow;
const actions = { copyCode: "copy", copyUri: "copy-uri", openUri: "open", openComplete: "complete", cancel: "cancel" };

function window(): DialogWindow {
  const result = state.windows.at(-1);
  if (!(result instanceof DialogWindow)) throw new Error("Dialog was not created");
  return result;
}

function action(name: string, target = window()) {
  const html = decodeURIComponent(target.documentUrl.split(",").slice(1).join(","));
  const match = html.match(new RegExp(`href="(https://device-code\\.invalid/[^"]+/${name})"`));
  if (!match?.[1]) throw new Error(`Missing action ${name}`);
  return match[1];
}

function navigate(url: string, changes: Record<string, unknown> = {}, target = window()) {
  const event = { url, preventDefault: vi.fn(), isMainFrame: true, frame: target.frame,
    initiator: target.frame, ...changes };
  target.webContents.emit("will-navigate", event);
  expect(event.preventDefault).toHaveBeenCalledOnce();
}

beforeEach(() => {
  state.windows.length = 0;
  state.background = false;
  state.loadError = false;
  vi.clearAllMocks();
  setLocale("en");
});
afterEach(() => {
  for (const candidate of state.windows) if (candidate instanceof DialogWindow && !candidate.destroyed) candidate.destroy();
});

describe("device sign-in dialog", () => {
  it("requires a live parent and rejects an already canceled request before creating a window", async () => {
    const absent = createDeviceCodePresentation(() => null);
    expect(absent.available()).toBe(false);
    await expect(absent.show(prompt(), new AbortController())).rejects.toThrow("do not retry here");
    const destroyed = createDeviceCodePresentation(() => ({ isDestroyed: () => true }) as BaseWindow);
    expect(destroyed.available()).toBe(false);
    const controller = new AbortController();
    controller.abort();
    await expect(createDeviceCodePresentation(parent).show(prompt(), controller)).rejects.toThrow("canceled");
    expect(state.windows).toHaveLength(0);
  });

  it("renders an escaped static document with both verification paths and a copy action", () => {
    const html = buildDeviceCodeDialogHtml({ ...prompt(), userCode: '<img src="https://bad.test/">', verificationUri: "https://auth.example.test/?a=1&b=2" }, actions);
    expect(html).toContain('&lt;img src=&quot;https://bad.test/&quot;&gt;');
    expect(html).toContain("?a=1&amp;b=2");
    expect(html).not.toContain("<script");
    expect(html).toContain("script-src 'none'");
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain('href="complete"');
    expect(html).toContain("Copy code");
    expect(buildDeviceCodeDialogHtml({ ...prompt(), verificationUriComplete: undefined }, actions)).not.toContain('href="complete"');
  });

  it.each(["https://user:secret@auth.example.test/", "file:///etc/passwd", "http://auth.example.test/", "javascript:alert(1)", "https://auth.example.test/#token"])("rejects unsafe verification links (%s)", async (verificationUri) => {
    await expect(createDeviceCodePresentation(parent).show({ ...prompt(), verificationUri }, new AbortController())).rejects.toThrow();
    expect(state.windows).toHaveLength(0);
  });

  it("locks renderer capabilities, permissions, network, popups, frame creation and redirects", async () => {
    const close = await createDeviceCodePresentation(parent).show(prompt(), new AbortController());
    const target = window();
    expect(target.options).toMatchObject({ modal: true, show: false, webPreferences: {
      sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, navigateOnDragDrop: false, devTools: false,
    } });
    expect((target.options.webPreferences as Record<string, unknown>).preload).toBeUndefined();
    expect(target.webContents.setWindowOpenHandler.mock.calls[0]?.[0]()).toEqual({ action: "deny" });
    const childNavigation = { isMainFrame: false, preventDefault: vi.fn() };
    target.webContents.emit("will-frame-navigate", childNavigation);
    expect(childNavigation.preventDefault).toHaveBeenCalledOnce();
    const mainNavigation = { isMainFrame: true, preventDefault: vi.fn() };
    target.webContents.emit("will-frame-navigate", mainNavigation);
    expect(mainNavigation.preventDefault).not.toHaveBeenCalled();
    const redirect = { preventDefault: vi.fn() };
    target.webContents.emit("will-redirect", redirect);
    expect(redirect.preventDefault).toHaveBeenCalledOnce();
    const attach = { preventDefault: vi.fn() };
    target.webContents.emit("will-attach-webview", attach);
    expect(attach.preventDefault).toHaveBeenCalledOnce();
    const permission = vi.fn();
    state.permissions.request.mock.calls[0]?.[0](null, "camera", permission);
    expect(permission).toHaveBeenCalledWith(false);
    expect(state.permissions.check.mock.calls[0]?.[0]()).toBe(false);
    expect(state.permissions.device.mock.calls[0]?.[0]()).toBe(false);
    const request = vi.fn();
    state.permissions.requestFilter.mock.calls[0]?.[1]({}, request);
    expect(request).toHaveBeenCalledWith({ cancel: true });
    close();
  });

  it("copies only host-stored values and opens only the two stored verification URLs", async () => {
    const input = prompt();
    const close = await createDeviceCodePresentation(parent).show(input, new AbortController());
    navigate(action("copy-code"));
    navigate(action("copy-uri"));
    expect(state.clipboard.mock.calls).toEqual([[input.userCode], [input.verificationUri]]);
    navigate(action("open-uri"));
    navigate(action("open-complete"));
    expect(state.external.mock.calls).toEqual([[input.verificationUri], [input.verificationUriComplete]]);
    navigate(`${action("copy-code")}?value=forged`);
    navigate("https://attacker.example.test/");
    expect(state.clipboard).toHaveBeenCalledTimes(2);
    expect(state.external).toHaveBeenCalledTimes(2);
    close();
  });

  it("rejects child frames, mismatched initiators, foreign action tokens and replaced documents", async () => {
    const close = await createDeviceCodePresentation(parent).show(prompt(), new AbortController());
    navigate(action("copy-code"), { isMainFrame: false });
    navigate(action("copy-code"), { frame: {} });
    navigate(action("copy-code"), { initiator: {} });
    navigate(action("copy-code"), { initiator: null });
    navigate("https://device-code.invalid/different/copy-code");
    const copy = action("copy-code");
    window().documentUrl = "https://attacker.example.test/";
    navigate(copy);
    expect(state.clipboard).not.toHaveBeenCalled();
    close();
  });

  it.each(["cancel", "window", "parent", "renderer", "abort"])("aborts polling and releases the window on %s cancellation", async (source) => {
    const owner = parent();
    const controller = new AbortController();
    const close = await createDeviceCodePresentation(() => owner).show(prompt(), controller);
    if (source === "cancel") navigate(action("cancel"));
    else if (source === "window") window().destroy();
    else if (source === "parent") owner.emit("closed");
    else if (source === "renderer") window().webContents.emit("render-process-gone");
    else controller.abort();
    expect(controller.signal.aborted).toBe(true);
    expect(window().destroyed).toBe(true);
    expect(owner.listenerCount("closed")).toBe(0);
    close();
    expect(window().destroy).toHaveBeenCalledOnce();
  });

  it("successful completion closes without turning success into cancellation", async () => {
    const controller = new AbortController();
    const owner = parent();
    const close = await createDeviceCodePresentation(() => owner).show(prompt(), controller);
    close();
    close();
    expect(controller.signal.aborted).toBe(false);
    expect(window().destroy).toHaveBeenCalledOnce();
    expect(owner.listenerCount("closed")).toBe(0);
  });

  it("propagates a load failure and aborts its request", async () => {
    state.loadError = true;
    const controller = new AbortController();
    await expect(createDeviceCodePresentation(parent).show(prompt(), controller)).rejects.toThrow("load failed");
    expect(controller.signal.aborted).toBe(true);
    expect(window().destroyed).toBe(true);
  });

  it("uses inactive non-modal presentation during background checks", async () => {
    state.background = true;
    const close = await createDeviceCodePresentation(parent).show(prompt(), new AbortController());
    expect(window().options.modal).toBe(false);
    expect(window().showInactive).toHaveBeenCalledOnce();
    expect(window().show).not.toHaveBeenCalled();
    close();
  });

  it("provides all prompt and protocol-error messages in every built-in locale", () => {
    const keys = Object.keys(en).filter(key => key.startsWith("deviceCode.") || /^mcpTab\.auth(Device|Dpop)/.test(key));
    expect(keys.length).toBeGreaterThan(10);
    for (const key of keys) {
      expect(en[key as keyof typeof en]).toBeTruthy();
      expect(ko[key as keyof typeof ko]).toBeTruthy();
    }
  });
});
