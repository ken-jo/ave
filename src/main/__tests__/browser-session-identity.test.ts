import { describe, expect, it, vi } from "vitest";
import type { Session } from "electron";
import { applyBrowserSessionIdentity, buildPersistentBrowserUserAgent } from "../browser-user-agent.js";

vi.mock("electron", () => ({ app: { getVersion: () => "0.14.1" } }));

describe("browser session identity", () => {
  it("identifies the application without claiming another browser", () => {
    const ua = buildPersistentBrowserUserAgent({ chromiumVersion: "154.0.1234.5", platform: "win32" });
    expect(ua).toContain("Chrome/154.0.0.0");
    expect(ua).toMatch(/Safari\/537\.36 Ave\/0\.14\.1$/);
    expect(ua).not.toMatch(/Electron\/|Edg\//i);
  });

  it("sets the user agent without intercepting request headers or hints", () => {
    const setUserAgent = vi.fn();
    const onBeforeSendHeaders = vi.fn();
    const session = { setUserAgent, webRequest: { onBeforeSendHeaders } } as unknown as Session;
    applyBrowserSessionIdentity(session);
    applyBrowserSessionIdentity(session);
    expect(setUserAgent).toHaveBeenCalledWith(buildPersistentBrowserUserAgent());
    expect(onBeforeSendHeaders).not.toHaveBeenCalled();
  });
});
