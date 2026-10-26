import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { useChromiumRuntime } from "../../__tests__/support/chromium-runtime.js";
import type { Session } from "electron";
import { applyBrowserSessionIdentity, buildPersistentBrowserUserAgent } from "../browser-user-agent.js";

useChromiumRuntime();

vi.mock("electron", () => ({ app: { getVersion: () => "0.14.1" } }));

const SRC = fileURLToPath(new URL("../..", import.meta.url));

function productionSources(): Array<{ path: string; text: string }> {
  return readdirSync(SRC, { withFileTypes: true, recursive: true })
    .filter((entry) => entry.isFile() && /\.(ts|tsx)$/.test(entry.name))
    .map((entry) => join(entry.parentPath, entry.name))
    .map((file) => ({ path: relative(SRC, file).split(sep).join("/"), text: readFileSync(file, "utf8") }))
    .filter(({ path }) => !/(^|\/)__tests__\//.test(path) && !/\.test\.tsx?$/.test(path));
}

describe("browser session identity", () => {
  it("identifies the application without claiming another browser", () => {
    const ua = buildPersistentBrowserUserAgent({ chromiumVersion: "154.0.1234.5", platform: "win32" });
    expect(ua).toContain("Chrome/154.0.0.0");
    expect(ua).toMatch(/Safari\/537\.36 Ave\/0\.14\.1$/);
    expect(ua).not.toMatch(/Electron\/|Edg\//i);
  });

  it("refuses to guess when the runtime has no Chromium version", () => {
    expect(() => buildPersistentBrowserUserAgent({ chromiumVersion: "", platform: "win32" })).toThrow(/no Chromium version/);
    expect(() => buildPersistentBrowserUserAgent({ chromiumVersion: "unknown", platform: "win32" })).toThrow(/no Chromium version/);
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

  // Identity comes only from setUserAgent/userAgentFallback; no module may rewrite request headers or client hints in flight.
  it("no production module rewrites browser request identity headers", () => {
    const sources = productionSources();
    expect(sources.length).toBeGreaterThan(100);
    const offenders = sources.flatMap(({ path, text }) => [
      ...(text.includes("onBeforeSendHeaders") ? [`${path}: onBeforeSendHeaders`] : []),
      ...(text.includes("onHeadersReceived") && /user-agent|sec-ch-ua/i.test(text) ? [`${path}: onHeadersReceived with identity headers`] : []),
      ...(/\.setUserAgent\(|userAgentFallback\s*=/.test(text) && path !== "main/browser-user-agent.ts" ? [`${path}: sets a user agent outside the helper`] : []),
    ]);
    expect(offenders).toEqual([]);
  });
});
