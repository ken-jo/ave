import { describe, expect, it, vi } from "vitest";
import { answeringRequestAndWait } from "../../__tests__/support/answering-approval-gate.js";
import { extensionStartApprovalRows, type ExtensionStartApprovalRow } from "../../shared/permissions-events.js";
import { createExtensionStartAsker } from "../extension-start-asker.js";
import { ApprovalGate, type ApprovalDecision, type ApprovalRequestInput } from "../approval-gate.js";
import type { PendingExtensionStart } from "../extension-start-consent.js";

const START: PendingExtensionStart = { key: "mcp-stdio:files", identity: "i-files", kind: "mcp-stdio", label: "files", cause: "no-backend" };
const OTHERS: PendingExtensionStart[] = [
  { key: "plugin-child:notes", identity: "i-notes", kind: "plugin-child", label: "Notes (notes)", cause: "no-backend" },
  { key: "worker:notes/index", identity: "i-index", kind: "worker", label: "Notes (notes) / index", cause: "home-privacy-unverified" },
];
const SESSION = { sessionId: "s1" };
const REASON = (starts: readonly PendingExtensionStart[]) => `card for ${starts.map((start) => start.label).join(" + ")}`;

const idOf = (rows: readonly ExtensionStartApprovalRow[], index: number): string => rows[index]?.id ?? "no such row";

type Answer = (rows: readonly ExtensionStartApprovalRow[]) => Partial<ApprovalDecision>;

function asker(answer: Answer, { malformed = false } = {}) {
  const requestAndWait = vi.fn(async (request: ApprovalRequestInput): Promise<ApprovalDecision> => {
    const decision: ApprovalDecision = { requestId: request.id, choice: "deny-once", ...answer(extensionStartApprovalRows(request.args) ?? []) };
    if (malformed) return decision;

    const surface = { isDestroyed: () => false, send: vi.fn() };
    const gate = new ApprovalGate(surface as never);
    const pending = gate.requestAndWait(request);
    const [card] = gate.listPendingRendererRequests(surface as never);
    if (!card?.nonce || !card.hmac) throw new Error("No sealed extension start card");
    gate.resolveFromDesktopRenderer(card.id, { ...decision, nonce: card.nonce, hmac: card.hmac }, surface as never);
    return pending;
  });
  const notify = vi.fn();
  return { requestAndWait, notify,
    asker: createExtensionStartAsker({ approvalGate: { requestAndWait } as unknown as Pick<ApprovalGate, "requestAndWait">, reason: REASON, notify }) };
}

describe("the extension start card", () => {
  it("asks the session for one answer that nothing can remember", async () => {
    const { asker: subject, requestAndWait } = asker(() => ({ choice: "allow-once" }));
    expect(await subject.ask([START], SESSION)).toEqual(new Map([["mcp-stdio:files", "yes"]]));
    expect(requestAndWait).toHaveBeenCalledTimes(1);
    expect(requestAndWait.mock.calls[0]).toEqual([expect.objectContaining({
      sessionId: "s1", category: "tool", kind: "extension-start", toolName: "extension_start",
      forceExplicit: true, allowedChoices: ["allow-once", "deny-once"], durableApprovalRecordAllowed: false,
      args: { isolation: "none", starts: [{ id: expect.any(String), label: "files", kind: "mcp-stdio", cause: "no-backend" }] },
      reason: "card for files",
    })]);
  });

  it("puts every start on one card, each under its own row id, and never sends a start key or identity", async () => {
    const { asker: subject, requestAndWait } = asker((rows) => ({ choice: "allow-once", extensionStartChoices: { [idOf(rows, 0)]: "yes", [idOf(rows, 1)]: "no", [idOf(rows, 2)]: "yes" } }));
    const starts = [START, ...OTHERS];
    expect(await subject.ask(starts, SESSION)).toEqual(new Map([["mcp-stdio:files", "yes"], ["plugin-child:notes", "no"], ["worker:notes/index", "yes"]]));
    expect(requestAndWait).toHaveBeenCalledTimes(1);
    const request = requestAndWait.mock.calls[0]?.[0];
    const rows = extensionStartApprovalRows(request?.args) ?? [];
    expect(rows.map(({ label, kind, cause }) => ({ label, kind, cause }))).toEqual(starts.map(({ label, kind, cause }) => ({ label, kind, cause })));
    expect(new Set(rows.map((row) => row.id)).size).toBe(3);
    expect(request?.reason).toBe("card for files + Notes (notes) + Notes (notes) / index");
    const sent = JSON.stringify(request);
    for (const start of starts) {
      expect(sent).not.toContain(start.key);
      expect(sent).not.toContain(start.identity);
    }
  });

  it("answers only the rows it showed: a start the answer does not name gets no answer", async () => {
    const { asker: subject } = asker((rows) => ({ choice: "allow-once", extensionStartChoices: { [idOf(rows, 0)]: "yes", "mcp-stdio:files": "yes", "plugin-child:notes": "yes" } }), { malformed: true });
    expect(await subject.ask([START, ...OTHERS], SESSION)).toEqual(new Map([["mcp-stdio:files", "yes"]]));
  });

  it("never reads a yes for several starts out of one allow that names none of them", async () => {
    const { asker: subject } = asker(() => ({ choice: "allow-once" }), { malformed: true });
    expect(await subject.ask([START, ...OTHERS], SESSION)).toEqual(new Map());
  });

  it("reads a deny that names no start as a no for each start on the card", async () => {
    const { asker: subject } = asker(() => ({ choice: "deny-once" }));
    expect(await subject.ask([START, ...OTHERS], SESSION)).toEqual(new Map([["mcp-stdio:files", "no"], ["plugin-child:notes", "no"], ["worker:notes/index", "no"]]));
  });

  it.each(["deny-once", "allow-session", "allow-always"] as const)("treats %s as a no", async (choice) => {
    expect(await asker(() => ({ choice }), { malformed: choice !== "deny-once" }).asker.ask([START], SESSION)).toEqual(new Map([["mcp-stdio:files", "no"]]));
  });

  it("passes the notice reason and the audit row through", () => {
    const notify = vi.fn();
    const record = vi.fn();
    const subject = createExtensionStartAsker({ approvalGate: { requestAndWait: vi.fn() } as unknown as Pick<ApprovalGate, "requestAndWait">, reason: REASON, notify, record });
    subject.notify(START, "declined");
    subject.record?.("waiting", START);
    expect(notify).toHaveBeenCalledExactlyOnceWith(START, "declined");
    expect(record).toHaveBeenCalledExactlyOnceWith("waiting", START);
  });

  it("does not ask, and reports nobody to answer, once the turn is cancelled", async () => {
    const { asker: subject, requestAndWait } = asker(() => ({ choice: "allow-once" }));
    const cancelled = new AbortController();
    cancelled.abort();
    expect(await subject.ask([START], { ...SESSION, abortSignal: cancelled.signal })).toBe("no-approver");
    expect(requestAndWait).not.toHaveBeenCalled();
  });

  it("ignores a yes that arrives after the turn was cancelled", async () => {
    const cancelled = new AbortController();
    const requestAndWait = answeringRequestAndWait(() => { cancelled.abort(); return { choice: "allow-once" }; });
    const subject = createExtensionStartAsker({ approvalGate: { requestAndWait } as unknown as Pick<ApprovalGate, "requestAndWait">, reason: REASON, notify: vi.fn() });
    expect(await subject.ask([START], { ...SESSION, abortSignal: cancelled.signal })).toBe("no-approver");
  });
});
