import { describe, expect, it, vi } from "vitest";
import { CHANNELS } from "../../contract/app-contract.js";

const mocks = vi.hoisted(() => ({ invoke: vi.fn(async () => ({ ok: true })), on: vi.fn(), removeListener: vi.fn() }));
vi.mock("electron", () => ({ ipcRenderer: mocks }));
import { buildAveNamespaceExtras } from "../internal-surface.js";

describe("document panel preload contract", () => {
  it("validates main requests and removes the same event listener", async () => {
    const api = buildAveNamespaceExtras().preview;
    const received = vi.fn();
    const off = api.onDocumentOpen(received);
    expect(mocks.on).toHaveBeenCalledWith(CHANNELS.preview.documentOpenRequest, expect.any(Function));
    const listener = mocks.on.mock.calls.at(-1)![1] as (event: unknown, payload: unknown) => void;
    listener({}, { path: "/workspace/book.xlsx" });
    expect(received).not.toHaveBeenCalled();
    const request = { requestId: "request", sessionId: "one", path: "/workspace/book.xlsx", expiresAt: 12345 };
    listener({}, request);
    expect(received).toHaveBeenCalledWith(request);
    const ack = { requestId: "request", sessionId: "one", opened: true };
    await api.acknowledgeDocumentOpen(ack);
    expect(mocks.invoke).toHaveBeenCalledWith(CHANNELS.preview.documentOpenAck, ack);
    off();
    expect(mocks.removeListener).toHaveBeenCalledWith(CHANNELS.preview.documentOpenRequest, listener);
  });
});
