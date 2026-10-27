import { beforeEach, describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../../contract/app-contract.js";
const invoke = vi.hoisted(() => vi.fn());
vi.mock("electron", () => ({ ipcRenderer: { invoke } }));
import { buildDocumentEngineApiSurface } from "../document-engine-api-surface.js";

beforeEach(() => { invoke.mockReset(); });
describe("document engine preload installation controls", () => {
  it.each(["status", "install", "cancel", "uninstall"] as const)("sends %s without any caller-selected path or URL", async (action) => {
    invoke.mockResolvedValueOnce({ ok: true });
    const api = buildDocumentEngineApiSurface();
    await expect(api[action]()).resolves.toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledWith(CHANNELS.documentEngine[action]);
  });
});
