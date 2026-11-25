import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getLocale, setLocale } from "../../../i18n/index.js";
import { bootExtensionStartAsker } from "../plugin-tool-executor.js";
import type { PendingExtensionStart } from "../../../permissions/extension-start-consent.js";

const START: PendingExtensionStart = { key: "plugin-child:notes", identity: "fixture", kind: "plugin-child", label: "Notes (notes)", cause: "no-backend" };

function subject() {
  const requestAndWait = vi.fn(async (_request: { reason: string }) => ({ choice: "deny-once" }));
  const deliver = vi.fn((_notice: { body: string }) => {});
  const log = vi.fn((_row: unknown) => {});
  const asker = bootExtensionStartAsker({ approvalGate: { requestAndWait }, bootAuditLogger: { log }, notificationService: { deliver } } as never);
  return { asker, requestAndWait, deliver, log };
}

describe("the extension start card, notice and audit rows at boot", () => {
  const hostLocale = getLocale();
  beforeEach(() => setLocale("en"));
  afterEach(() => setLocale(hostLocale));

  it("asks with the catalog text for the kind of start, naming the plugin by its id", async () => {
    const { asker, requestAndWait } = subject();
    await asker.ask([START], { sessionId: "s1" });
    await asker.ask([{ ...START, kind: "plugin-hook" }], { sessionId: "s1" });
    expect(requestAndWait.mock.calls.map(([request]) => request.reason)).toEqual([
      "The extension Notes (notes) would start without OS isolation. Allow this one start?",
      "The extension hook Notes (notes) would run without OS isolation. Allow this one run?",
    ]);
  });

  it("names every start on a card that lists several", async () => {
    const { asker, requestAndWait } = subject();
    await asker.ask([START, { ...START, key: "mcp-stdio:files", kind: "mcp-stdio", label: "files" }], { sessionId: "s1" });
    expect(requestAndWait.mock.calls.map(([request]) => request.reason)).toEqual([
      "2 extension starts would run without OS isolation: Notes (notes), files. Answer for each one.",
    ]);
    setLocale("ko");
    await asker.ask([START, { ...START, key: "mcp-stdio:files", kind: "mcp-stdio", label: "files" }], { sessionId: "s1" });
    expect(requestAndWait.mock.calls[1]?.[0].reason).toBe("2개 항목이 OS 격리 없이 시작됩니다: Notes (notes), files. 항목마다 따로 답해 주세요.");
  });

  it("says a declined start was declined, and an unanswered one that nobody approved it", () => {
    const { asker, deliver } = subject();
    asker.notify(START, "declined");
    asker.notify(START, "unattended");
    asker.notify({ ...START, cause: "home-privacy-unverified" }, "declined");
    const bodies = deliver.mock.calls.map(([notice]) => notice.body);
    expect(bodies[0]).toContain("you declined");
    expect(bodies[1]).toContain("nobody approved it");
    expect(bodies[2]).toMatch(/you declined.*folder permissions/);
    expect(bodies.every((body) => body.startsWith("Notes (notes) was not started"))).toBe(true);
  });

  it("says on the card and the notice that the container check did not finish in time, and still that nothing isolates the start", async () => {
    const { asker, requestAndWait, deliver } = subject();
    const late: PendingExtensionStart = { ...START, cause: "readiness-deadline" };
    await asker.ask([late], { sessionId: "s1" });
    expect(requestAndWait.mock.calls.map(([request]) => request.reason)).toEqual([
      "The container check did not finish in time. The extension Notes (notes) would start without OS isolation. Allow this one start?"]);
    asker.notify(late, "declined");
    asker.notify(late, "unattended");
    const bodies = deliver.mock.calls.map(([notice]) => notice.body);
    expect(bodies[0]).toMatch(/^Notes \(notes\) was not started: the container check did not finish in time and you declined to run it without OS isolation\. Restart Ave to run the check again; if the Windows sandbox is not installed, install it/);
    expect(bodies[1]).toMatch(/^Notes \(notes\) was not started: the container check did not finish in time, it would run without OS isolation and nobody approved it\./);
    setLocale("ko");
    await asker.ask([late], { sessionId: "s1" });
    asker.notify(late, "unattended");
    const korean = [requestAndWait.mock.calls.map(([request]) => request.reason)[1], deliver.mock.calls.map(([notice]) => notice.body)[2]];
    expect(korean.every((text) => typeof text === "string")).toBe(true);
    expect(korean.every((text) => text?.includes("컨테이너 확인이 제한 시간 안에 끝나지") && text.includes("OS 격리 없이") && !text.includes("extensionStart."))).toBe(true);
  });

  it("carries the expired container check on its own row when the card lists several starts", async () => {
    const { asker, requestAndWait } = subject();
    await asker.ask([START, { ...START, key: "mcp-stdio:files", kind: "mcp-stdio", label: "files", cause: "readiness-deadline" }], { sessionId: "s1" });
    const [asked] = requestAndWait.mock.calls.map(([request]) => request as unknown as { args: { starts: { label: string; cause: string }[] } });
    const starts = asked?.args.starts ?? [];
    expect(starts.map((row) => [row.label, row.cause])).toEqual([["Notes (notes)", "no-backend"], ["files", "readiness-deadline"]]);
  });

  it("writes one audit row per waiting, unanswered, declined or confined start", () => {
    const { asker, log } = subject();
    for (const event of ["waiting", "unattended", "declined", "confined"] as const) asker.record?.(event, START);
    expect(log.mock.calls.map(([row]) => row)).toEqual(["waiting", "unattended", "declined", "confined"].map((event) => expect.objectContaining({
      sessionId: "extension-start", type: "info",
      input: JSON.stringify({ event, kind: "plugin-child", key: "plugin-child:notes", cause: "no-backend" }),
      output: `[extension_start_${event}] Notes (notes)`,
    })));
  });
});
