import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { net } from "electron";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { refreshModelCatalogCache, MODEL_CATALOG_REFRESH_URL } from "../../../core/model-catalog/refresh.js";
import { activeModelCatalog } from "../../../shared/model-catalog/active.js";
import { createDesktopNetworkFetch } from "../desktop-network-fetch.js";

const state = vi.hoisted(() => ({
  calls: [] as Array<{ options: Record<string, unknown>; headers: Headers }>,
  error: undefined as Error | undefined,
}));
vi.mock("node:dns", () => ({ promises: { lookup: async () => [{ address: "93.184.215.14", family: 4 }] } }));
vi.mock("electron", () => ({ net: {
  fetch: vi.fn(),
  request: (options: Record<string, unknown>) => {
    const headers = new Headers();
    state.calls.push({ options, headers });
    const request = Object.assign(new EventEmitter(), {
      setHeader: (key: string, value: string) => headers.set(key, value),
      abort: () => {},
      end: () => {
        if (state.error) request.emit("error", state.error);
        else request.emit("response", { headers: {}, statusCode: 204, statusMessage: "No Content" });
      },
    });
    return request;
  },
} }));

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "catalog-native-request-")); });
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  vi.clearAllMocks();
  state.calls.length = 0;
  state.error = undefined;
});

it("omits session authentication and cookies at the native request boundary", async () => {
  await refreshModelCatalogCache({
    fetchImpl: createDesktopNetworkFetch().singleHopNetworkFetch,
    dir, reference: activeModelCatalog(),
  });
  expect(state.calls).toHaveLength(1);
  expect(state.calls[0]!.options).toMatchObject({
    url: MODEL_CATALOG_REFRESH_URL, method: "GET", redirect: "manual", credentials: "omit",
    bypassCustomProtocolHandlers: true,
  });
  expect([...state.calls[0]!.headers]).toEqual([["accept", "application/json"]]);
});

it("does not retry a certificate failure over cleartext or another transport", async () => {
  state.error = new Error("ERR_CERT_AUTHORITY_INVALID");
  const result = await refreshModelCatalogCache({
    fetchImpl: createDesktopNetworkFetch().singleHopNetworkFetch,
    dir, reference: activeModelCatalog(),
  });
  expect(result).toMatchObject({ status: "failed", reason: expect.stringContaining("ERR_CERT_AUTHORITY_INVALID") });
  expect(state.calls.map(({ options }) => options.url)).toEqual([MODEL_CATALOG_REFRESH_URL]);
  expect(net.fetch).not.toHaveBeenCalled();
});
