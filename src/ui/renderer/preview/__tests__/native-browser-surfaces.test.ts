import { ok } from "node:assert/strict";
import { afterEach, describe, expect, it } from "vitest";
import type { BrowserNativeSurfaceResult } from "../../../../shared/browser-native-surface.js";
import { nativeSurfaceFixture } from "../../../../__tests__/support/native-browser-surface.js";
import { commandNativeBrowserSurface, connectNativeBrowserSurfaces, createNativeBrowserSurface, requestNativeBrowserSurface } from "../native-browser-surfaces.js";
import { nativeWebSurfaceState, publishLiveWebTabs, setNativeBrowserTabIds, setWebSurfaceUrl, withdrawLiveWebTabs } from "../web-surfaces.js";
const source = Symbol("native-client");
afterEach(async () => { withdrawLiveWebTabs(source); await Promise.resolve(); });
function sourceTab() {
  setNativeBrowserTabIds([]);
  publishLiveWebTabs(source, new Set(["browser:client"]));
  setWebSurfaceUrl("browser:client", "about:blank", "request:client");
}
describe("native page client ownership", () => {
  it("rejects an older create completion without replacing or closing a newer registration", async () => {
    sourceTab();
    const fixture = nativeSurfaceFixture();
    const close = connectNativeBrowserSurfaces(fixture.api);
    const run = fixture.nativeSurface.getMockImplementation();
    ok(run);
    let complete!: () => void;
    fixture.nativeSurface.mockImplementationOnce(async (request) => {
      const result = await run(request);
      await new Promise<void>((resolve) => { complete = resolve; });
      return result;
    });
    const pending = createNativeBrowserSurface(fixture.api, "browser:client", "request:client");
    await Promise.resolve();
    const current = await createNativeBrowserSurface(fixture.api, "browser:client", "request:client");
    ok(current);
    complete();
    expect(await pending).toBeNull();
    expect(nativeWebSurfaceState("browser:client")).toBe(current.surface);
    expect(fixture.nativeSurface.mock.calls.some(([request]) => request.action === "close")).toBe(false);
    fixture.nativeSurface.mockImplementation(run);
    expect(await commandNativeBrowserSurface("browser:client", "reload")).toBe(true);
    close();
  });
  it("disposes a pending creation after its tab retires", async () => {
    sourceTab();
    const fixture = nativeSurfaceFixture();
    const close = connectNativeBrowserSurfaces(fixture.api);
    const state = (await fixture.api.nativeSurface({ action: "create", tabId: "browser:client" }));
    let complete!: (result: BrowserNativeSurfaceResult) => void;
    fixture.nativeSurface.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const pending = createNativeBrowserSurface(fixture.api, "browser:client", "request:client");
    withdrawLiveWebTabs(source);
    await Promise.resolve();
    complete(state);
    expect(await pending).toBeNull();
    expect(fixture.nativeSurface).toHaveBeenLastCalledWith({ action: "close", tabId: "browser:client", webContentsId: 42 });
    close();
  });
  it("keeps newer registration state when an old command resolves and an older subscription disposes", async () => {
    sourceTab();
    const fixture = nativeSurfaceFixture();
    const oldDisconnect = connectNativeBrowserSurfaces(fixture.api);
    const old = await createNativeBrowserSurface(fixture.api, "browser:client", "request:client");
    ok(old);
    let complete!: (result: BrowserNativeSurfaceResult) => void;
    fixture.nativeSurface.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    const pending = requestNativeBrowserSurface(fixture.api, { action: "reload", tabId: "browser:client", webContentsId: old.surface.webContentsId });
    const disconnect = connectNativeBrowserSurfaces(fixture.api);
    const current = await createNativeBrowserSurface(fixture.api, "browser:client", "request:client");
    ok(current);
    oldDisconnect();
    complete({ ok: true, surface: null });
    await pending;
    expect(nativeWebSurfaceState("browser:client")).toBe(current.surface);
    expect(await commandNativeBrowserSurface("browser:client", "reload")).toBe(true);
    disconnect();
    expect(await commandNativeBrowserSurface("browser:client", "reload")).toBe(false);
  });
  it("removes failed creation routing", async () => {
    sourceTab();
    const fixture = nativeSurfaceFixture();
    const disconnect = connectNativeBrowserSurfaces(fixture.api);
    await createNativeBrowserSurface(fixture.api, "browser:client", "request:client");
    fixture.nativeSurface.mockResolvedValueOnce({ ok: false, error: "stale-surface" });
    expect(await createNativeBrowserSurface(fixture.api, "browser:client", "request:client")).toBeNull();
    expect(await commandNativeBrowserSurface("browser:client", "reload")).toBe(false);
    disconnect();
  });
});
