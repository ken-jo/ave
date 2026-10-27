import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DocumentObservationEvent, DocumentObservationEngine } from "../../shared/agent-observation.js";
import type { PreviewPageDocument, PreviewDocumentElement } from "../../shared/preview-page-document.js";
import { DocumentObservationAdapter } from "../document-adapter.js";
import { contentHash as hash } from "../../__tests__/support/content-hash.js";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });
const identity = { sessionId: "session-one", turnId: "turn-one", toolUseId: "tool-one" };
function document(text: string, format: "docx" | "pptx" = "docx"): PreviewPageDocument {
  const elements: PreviewDocumentElement[] = format === "docx" ? [
    { element: { kind: "paragraph", paragraph: 0 }, text },
    { element: { kind: "paragraph", paragraph: 0, run: 0 }, text },
  ] : [{ element: { kind: "shape", slide: 0, shapeId: "shape-2" }, text }];
  return { format, totalPages: 1, pagesTruncated: false, elements,
    page: { index: 0, paragraphs: [text], textTruncated: false, png: null, width: 0, height: 0 } };
}
function fixture(format: "docx" | "pptx" = "docx", engine?: DocumentObservationEngine | null) {
  const root = mkdtempSync(join(tmpdir(), "ave-observed-page-"));
  const path = join(root, `observed.${format}`);
  writeFileSync(path, "before");
  const parse = vi.fn(async (bytes: Buffer) => document(bytes.toString(), format));
  const adapter = new DocumentObservationAdapter(engine === undefined ? { id: "page-reader", parse } : engine);
  const events: DocumentObservationEvent[] = [];
  adapter.registerView({ id: "view", sessionId: identity.sessionId, path, hash: hash("before"), document: document("before", format),
    isCurrent: () => true, onEvents: (batch) => events.push(...batch) });
  adapter.acknowledge("view", 0);
  cleanups.push(() => { adapter.dispose(); rmSync(root, { recursive: true, force: true }); });
  return { adapter, parse, path, events, root };
}

describe("agent page document reconciliation", () => {
  it("emits paragraph and run deltas only from a verified agent save through the existing envelope", async () => {
    const { adapter, path, parse, events } = fixture();
    writeFileSync(path, "after");
    await adapter.observeMutation(identity, path, hash("before"), hash("after"));
    await vi.waitFor(() => expect(events.some((event) => event.kind === "snapshot")).toBe(true));
    expect(parse).toHaveBeenCalledWith(expect.any(Buffer), "docx", 0, expect.any(AbortSignal), { sessionId: identity.sessionId });
    expect(events.filter((event) => event.kind === "element")).toMatchObject([
      { source: "document", actor: "agent", sessionId: identity.sessionId, before: "before", after: "after", advisory: false,
        element: { kind: "paragraph", paragraph: 0 } },
      { before: "before", after: "after", advisory: false, element: { kind: "paragraph", paragraph: 0, run: 0 } },
    ]);
  });

  it("keeps slide shape addresses when replacing a verified presentation snapshot", async () => {
    const { adapter, path, events } = fixture("pptx");
    writeFileSync(path, "after");
    await adapter.observeMutation(identity, path, hash("before"), hash("after"));
    await vi.waitFor(() => expect(events.some((event) => event.kind === "snapshot")).toBe(true));
    expect(events.find((event) => event.kind === "element")).toMatchObject({ before: "before", after: "after",
      advisory: false, element: { kind: "shape", slide: 0, shapeId: "shape-2" } });
  });

  it("uses the same tool-bound journal completion proof for structured page saves", async () => {
    const { adapter, path, events, root } = fixture("docx");
    const action = join(root, "action");
    mkdirSync(join(action, "document-observation"), { recursive: true });
    const journal = join(action, "document-observation", "journal.jsonl");
    const lease = adapter.openJournal(identity, action);
    writeFileSync(journal, `${JSON.stringify({ v: 1, kind: "begin", editId: "page-save", target: path, beforeHash: hash("before") })}\n`);
    lease.poll();
    writeFileSync(path, "after");
    appendFileSync(journal, `${JSON.stringify({ v: 1, kind: "commit", editId: "page-save", afterHash: hash("after") })}\n`);
    await lease.finish();
    await vi.waitFor(() => expect(events.some((event) => event.kind === "snapshot")).toBe(true));
    expect(events.find((event) => event.kind === "element")).toMatchObject({ before: "before", after: "after", advisory: false,
      element: { kind: "paragraph", paragraph: 0 } });
  });

  it("does not read a user-only save or another session's document", async () => {
    const { adapter, path, parse, events } = fixture();
    writeFileSync(path, "private user text");
    await adapter.observeMutation({ ...identity, sessionId: "another-session" }, path, hash("before"), hash("private user text"));
    expect(parse).not.toHaveBeenCalled();
    expect(events).toEqual([]);
  });

  it("refuses a prior user revision without capturing its elements", async () => {
    const { adapter, path, parse, events } = fixture();
    writeFileSync(path, "after");
    await adapter.observeMutation(identity, path, hash("private user text"), hash("after"));
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ kind: "status", after: { code: "reload-required" } })));
    expect(parse).not.toHaveBeenCalled();
    expect(events.some((event) => event.kind !== "status")).toBe(false);
    expect(JSON.stringify(events)).not.toContain("private user text");
  });

  it("retains the acknowledged comparison baseline until the new page is actually rendered", async () => {
    const { adapter, path, events } = fixture();
    writeFileSync(path, "after");
    await adapter.observeMutation(identity, path, hash("before"), hash("after"));
    await vi.waitFor(() => expect(events.some((event) => event.kind === "snapshot")).toBe(true));
    writeFileSync(path, "latest");
    await adapter.observeMutation({ ...identity, toolUseId: "tool-two" }, path, hash("after"), hash("latest"));
    await vi.waitFor(() => expect(events.some((event) => event.kind === "element" && event.after === "latest")).toBe(true));
    expect(events.find((event) => event.kind === "element" && event.after === "latest")).toMatchObject({ before: "before" });
  });

  it("rejects engine selection or protocol violations without replacing the valid baseline", async () => {
    const { adapter, path, events } = fixture("docx", { id: "wrong-selection", parse: async () => document("after", "pptx") });
    writeFileSync(path, "after");
    await adapter.observeMutation(identity, path, hash("before"), hash("after"));
    await vi.waitFor(() => expect(events).toContainEqual(expect.objectContaining({ kind: "status", after: { code: "observation-error" } })));
    expect(events.some((event) => event.kind === "element" || event.kind === "snapshot")).toBe(false);
  });
});
