import { describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { useChromiumRuntime } from "../../__tests__/support/chromium-runtime.js";
import { BrowserWindow, type WebContents } from "electron";
import { LINK_WINDOW_SHELL_ARGUMENT } from "../../shared/preload-bundles.js";

useChromiumRuntime();

const viewerSession = vi.hoisted(() => ({
  setUserAgent: (() => {}) as (ua: string) => void,
  setPermissionRequestHandler: () => {},
  cookies: { flushStore: () => {} },
}));

vi.mock("electron", () => ({
  BrowserWindow: vi.fn(),
  app: { getVersion: () => "0.14.1" },
  session: { fromPartition: vi.fn(() => viewerSession) },
}));

const { attachLinkNavigationGuards, applyPersistentBrowserUserAgent } = await import("../link-window-service.js");
const { buildPersistentBrowserUserAgent } = await import("../browser-user-agent.js");

describe("applyPersistentBrowserUserAgent", () => {
  it("gives the viewer partition the honest Chromium + Ave user agent", () => {
    const setUserAgent = vi.spyOn(viewerSession, "setUserAgent");
    applyPersistentBrowserUserAgent("persist:link-viewer");
    expect(setUserAgent).toHaveBeenCalledWith(buildPersistentBrowserUserAgent());
    expect(setUserAgent.mock.calls[0]?.[0]).toMatch(/Safari\/537\.36 Ave\/0\.14\.1$/);
  });
});

function makeContents() {
  const handlers = new Map<string, (event: { url: string; preventDefault: () => void }) => void>();
  const contents = {
    setWindowOpenHandler: vi.fn(),
    on: vi.fn((eventName: string, handler: (event: { url: string; preventDefault: () => void }) => void) => {
      handlers.set(eventName, handler);
      return contents;
    }),
  } as unknown as WebContents & { setWindowOpenHandler: ReturnType<typeof vi.fn> };
  return { contents, handlers };
}

function navEvent(url: string) {
  return { url, preventDefault: vi.fn() };
}

describe("attachLinkNavigationGuards", () => {
  it("denies popups and permits only http(s) top-level navigation", () => {
    const { contents, handlers } = makeContents();
    attachLinkNavigationGuards(contents);

    expect(contents.setWindowOpenHandler).toHaveBeenCalledOnce();
    expect(contents.setWindowOpenHandler.mock.calls[0]?.[0]()).toEqual({ action: "deny" });

    const httpsEvent = navEvent("https://example.com/path");
    handlers.get("will-navigate")!(httpsEvent);
    expect(httpsEvent.preventDefault).not.toHaveBeenCalled();

    const fileEvent = navEvent("file:///etc/passwd");
    handlers.get("will-navigate")!(fileEvent);
    expect(fileEvent.preventDefault).toHaveBeenCalledOnce();

    const redirectEvent = navEvent("ave://plugin-auth/callback");
    handlers.get("will-redirect")!(redirectEvent);
    expect(redirectEvent.preventDefault).toHaveBeenCalledOnce();
  });
});

describe("jsonForScriptBlock — script-block injection safety", () => {
  it("neutralizes a </script> sequence so the value cannot break out", async () => {
    const { jsonForScriptBlock } = await import("../link-window-service.js");
    const malicious = "https://ok.example/</script><script>alert(1)</script>";
    const out = jsonForScriptBlock(malicious);
    // No raw angle bracket survives — a parser can never see a closing tag.
    expect(out).not.toContain("<");
    expect(out).not.toContain(">");
    expect(out).toContain("\\u003c");
    // Still a valid JS string literal that round-trips to the original.
    // eslint-disable-next-line no-eval
    expect(JSON.parse(out.replace(/\\u003c/g, "<").replace(/\\u003e/g, ">"))).toBe(malicious);
  });

  it("leaves an ordinary URL intact as a parseable literal", async () => {
    const { jsonForScriptBlock } = await import("../link-window-service.js");
    const url = "https://example.com/path?a=1&b=2";
    expect(JSON.parse(jsonForScriptBlock(url))).toBe(url);
  });
});

describe("buildLinkWindowShellHtml — title sinks", () => {
  it("HTML-escapes the <title> element but hands the script sinks the verbatim string", async () => {
    const { buildLinkWindowShellHtml } = await import("../link-window-service.js");
    const title = 'Say "hi" & <go>';
    const html = buildLinkWindowShellHtml({ url: "https://example.com/", title, platform: "darwin" });
    expect(html).toContain("<title>Say &quot;hi&quot; &amp; &lt;go&gt;</title>");
    // document.title / textContent do not decode entities: the literal must be the raw title.
    const assignments = [...html.matchAll(/(?:document\.title|titleEl\.textContent) = ("(?:[^"\\]|\\.)*");/g)];
    expect(assignments).toHaveLength(2);
    for (const [, literal] of assignments) {
      expect(JSON.parse(literal.replace(/\\u003c/g, "<").replace(/\\u003e/g, ">"))).toBe(title);
      expect(literal).not.toContain("&quot;");
    }
  });
});

it("marks link shell preloads as independent of app appearance", async () => {
  const win = Object.assign(new EventEmitter(), {
    webContents: Object.assign(new EventEmitter(), { id: 4242, setWindowOpenHandler: vi.fn() }),
    setMenu: vi.fn(),
    show: vi.fn(),
    loadURL: vi.fn<() => Promise<void>>(),
  });
  win.loadURL.mockImplementation(async () => { win.emit("ready-to-show"); });
  vi.mocked(BrowserWindow).mockImplementation(function () { return win as unknown as BrowserWindow; });
  const { openLinkWindow, buildLinkWindowShellHtml } = await import("../link-window-service.js");
  try {
    await openLinkWindow(null, { url: "https://example.test/", windowTitle: "Sign in" });
    expect(vi.mocked(BrowserWindow).mock.calls.at(-1)?.[0]?.webPreferences?.additionalArguments).toEqual([LINK_WINDOW_SHELL_ARGUMENT]);
    const html = buildLinkWindowShellHtml({ url: "https://example.test/", title: "Sign in", platform: "win32" });
    expect(html).toContain("--ts-bg");
    expect(html).not.toContain("var(--background)");
    expect(html).toContain('document.getElementById("close").addEventListener("click", () => window.aveWindow?.close())');
  } finally { win.webContents.emit("destroyed"); }
});
