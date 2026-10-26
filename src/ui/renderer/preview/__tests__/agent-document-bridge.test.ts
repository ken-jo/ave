import { describe, expect, it, vi } from "vitest";
import type { AvePreviewApi } from "../../types.js";
import type { DocumentOpenRequest } from "../../../../shared/document-open.js";
import { openDocumentInPanel, registerDocumentPanelHost } from "../agent-document-bridge.js";

it("opens only the visible tile holding the exact session and acknowledges its committed result", async () => {
  let receive!: (request: DocumentOpenRequest) => void;
  const acknowledgeDocumentOpen = vi.fn(async () => ({ ok: true }));
  const off = vi.fn();
  const api = { onDocumentOpen: (handler: typeof receive) => { receive = handler; return off; }, acknowledgeDocumentOpen } as unknown as AvePreviewApi;
  const other = vi.fn(async () => true), hidden = vi.fn(async () => true), chosen = vi.fn(async () => true);
  const unregister = [
    registerDocumentPanelHost(api, { sessionId: () => "other", isVisible: () => true, openDocument: other }),
    registerDocumentPanelHost(api, { sessionId: () => "wanted", isVisible: () => false, openDocument: hidden }),
    registerDocumentPanelHost(api, { sessionId: () => "wanted", isVisible: () => true, openDocument: chosen }),
  ];
  try {
    const request = { requestId: "one", sessionId: "wanted", path: "/workspace/book.xlsx", expiresAt: Date.now() + 1000 };
    receive(request);
    await vi.waitFor(() => expect(acknowledgeDocumentOpen).toHaveBeenCalledWith({ requestId: "one", sessionId: "wanted", opened: true }));
    expect(chosen).toHaveBeenCalledWith(request.path, request.expiresAt);
    expect(other).not.toHaveBeenCalled(); expect(hidden).not.toHaveBeenCalled();
  } finally { unregister.forEach((cleanup) => cleanup()); }
  expect(off).toHaveBeenCalledOnce();
});
describe("document request admission", () => {
  it("rejects expired requests before touching panel state", async () => {
    const openDocument = vi.fn(async () => true);
    const unregister = registerDocumentPanelHost({} as AvePreviewApi, { sessionId: () => "one", isVisible: () => true, openDocument });
    try { expect(await openDocumentInPanel("/file.xlsx", "one", Date.now() - 1)).toBe(false); expect(openDocument).not.toHaveBeenCalled(); }
    finally { unregister(); }
  });
  it("does not choose another tile when no visible session holder exists", async () => {
    expect(await openDocumentInPanel("/file.xlsx", "missing", Date.now() + 1000)).toBe(false);
  });
});
