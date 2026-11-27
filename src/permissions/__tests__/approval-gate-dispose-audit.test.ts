import { watchPermissionEvents } from "../../__tests__/support/permission-events.js";
import { deferred } from "../../__tests__/support/deferred.js";
import { expect, it } from "vitest";
import { makeMockWebContents } from "../../__tests__/test-helpers.js";
import { ApprovalGate, IPC_APPROVAL_REQUEST } from "../approval-gate.js";

it("audits every parked request cancelled by shutdown before it resolves", async () => {
  const order: string[] = [];
  const webContents = makeMockWebContents();
  const parked = deferred<void>();
  const pendingIds = new Set<string>();
  webContents.send.mockImplementation((channel: string, request: { id: string }) => {
    if (channel !== IPC_APPROVAL_REQUEST) return;
    pendingIds.add(request.id);
    if (pendingIds.size === 2) parked.resolve();
  });
  const capture = watchPermissionEvents((entry) => {
    if (entry.event === "approval_cancelled") order.push(`cancelled:${entry.requestId}`);
  });
  const gate = new ApprovalGate(webContents as never);
  const decisions = ["first", "second"].map(async (id) => {
    const decision = await gate.requestAndWait({
      id, category: "tool", toolName: "write_probe", toolCategory: "write", args: {},
      reason: "test decision", source: "builtin", createdAt: Date.now(), forceExplicit: true,
    });
    order.push(`resolved:${id}`);
    return decision;
  });
  await parked.promise;
  gate.disposeAll();
  expect(await Promise.all(decisions)).toEqual([
    { requestId: "first", choice: "deny-once" },
    { requestId: "second", choice: "deny-once" },
  ]);
  expect(order).toEqual([
    "cancelled:first",
    "cancelled:second",
    "resolved:first",
    "resolved:second",
  ]);
  expect(gate.pendingCount).toBe(0);
  capture.mockRestore();
});
