import { describe, expect, it, vi } from "vitest";
import { createExtensionStartAsker } from "../extension-start-asker.js";
import type { ApprovalGate } from "../approval-gate.js";
import type { PendingExtensionStart } from "../extension-start-consent.js";

const START: PendingExtensionStart = { key: "mcp-stdio:files", kind: "mcp-stdio", label: "files", cause: "no-backend" };
const SESSION = { sessionId: "s1", attended: true };
const REASON = (start: PendingExtensionStart) => `card for ${start.label}`;

function asker(choice: string) {
  const requestAndWait = vi.fn(async () => ({ choice }));
  const notify = vi.fn();
  return { requestAndWait, notify,
    asker: createExtensionStartAsker({ approvalGate: { requestAndWait } as unknown as Pick<ApprovalGate, "requestAndWait">, reason: REASON, notify }) };
}

describe("the extension start card", () => {
  it("asks the session for one answer that nothing can remember", async () => {
    const { asker: subject, requestAndWait } = asker("allow-once");
    expect(await subject.ask(START, SESSION)).toBe("yes");
    expect(requestAndWait).toHaveBeenCalledTimes(1);
    expect(requestAndWait.mock.calls[0]).toEqual([expect.objectContaining({
      sessionId: "s1", category: "tool", toolName: "extension_start",
      forceExplicit: true, allowedChoices: ["allow-once", "deny-once"], durableApprovalRecordAllowed: false,
      args: { start: "files", kind: "mcp-stdio", isolation: "none", cause: "no-backend" },
      reason: "card for files",
    })]);
  });

  it.each(["deny-once", "allow-session", "allow-always"])("treats %s as a no", async (choice) => {
    expect(await asker(choice).asker.ask(START, SESSION)).toBe("no");
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
    const { asker: subject, requestAndWait } = asker("allow-once");
    const cancelled = new AbortController();
    cancelled.abort();
    expect(await subject.ask(START, { ...SESSION, abortSignal: cancelled.signal })).toBe("no-approver");
    expect(requestAndWait).not.toHaveBeenCalled();
  });

  it("ignores a yes that arrives after the turn was cancelled", async () => {
    const cancelled = new AbortController();
    const requestAndWait = vi.fn(async () => { cancelled.abort(); return { choice: "allow-once" }; });
    const subject = createExtensionStartAsker({ approvalGate: { requestAndWait } as unknown as Pick<ApprovalGate, "requestAndWait">, reason: REASON, notify: vi.fn() });
    expect(await subject.ask(START, { ...SESSION, abortSignal: cancelled.signal })).toBe("no-approver");
  });
});
