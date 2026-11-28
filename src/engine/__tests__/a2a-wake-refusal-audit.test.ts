import { describe, expect, it, vi, onTestFinished } from "vitest";
import { collectPermissionEvents } from "../../__tests__/support/permission-events.js";
import { A2ASubAgentMessageBus } from "../a2a-subagent-message-bus.js";
import type { ConversationLoop } from "../conversation-loop.js";
import type { ResolvedSubAgentAddress } from "../a2a-subagent-message-bus.js";
import { A2A_ROLE_AGENT } from "../../shared/a2a.js";

// Wake refusals must audit which conditions prevented delivery.
function makeMessage() {
  return {
    messageId: "m-1",
    role: A2A_ROLE_AGENT,
    parts: [{ text: "done" }],
    contextId: "parent-session",
    taskId: "sub-child",
  } as never;
}

function makeBus(overrides: {
  wakeFlag?: boolean;
  activeSession?: string;
  hasActiveTurn?: boolean;
  registerHandler?: boolean;
}) {
  const address: ResolvedSubAgentAddress = {
    parentSessionId: "parent-session",
    childSessionId: "sub-child",
    childTitle: "worker",
  };
  const entries: unknown[] = [];
  const bus = new A2ASubAgentMessageBus({
    parentLoop: {
      getSessionId: () => overrides.activeSession ?? "parent-session",
      hasActiveTurn: () => overrides.hasActiveTurn ?? false,
      queueGuidanceWithDisposition: vi.fn(() => "queued"),
    } as unknown as ConversationLoop,
    mailbox: {
      enqueue: vi.fn(async (entry: unknown) => { entries.push(entry); return { ok: true }; }),
      peekWithDiagnostics: vi.fn(async () => ({ entries: [], diagnostics: [] })),
      acknowledge: vi.fn(async () => 0),
    } as never,
    settingsService: {
      get: () => ({ subAgentAutonomousWake: overrides.wakeFlag ?? true }),
    } as never,
    resolveChildAddress: vi.fn(async () => address),
  });
  if (overrides.registerHandler !== false) {
    bus.setWakeHandler(vi.fn(async () => {}));
  }
  return bus;
}

const DELIVERY = {
  parentSessionId: "parent-session",
  childSessionId: "sub-child",
  message: makeMessage(),
};

describe("wake refusal audit", () => {

  it("names an unregistered handler", async () => {
    const capture = collectPermissionEvents();
    onTestFinished(capture.restore);
    const bus = makeBus({ registerHandler: false });
    const result = await bus.deliverToParent(DELIVERY);
    expect(result).toMatchObject({ ok: true, disposition: "mailbox" });
    expect(capture.events).toContainEqual(expect.objectContaining({ operation: "wake", outcome: "refused", reasonCode: "handler-unregistered" }));
  });

  it("names a disabled flag", async () => {
    const capture = collectPermissionEvents();
    onTestFinished(capture.restore);
    const bus = makeBus({ wakeFlag: false });
    await bus.deliverToParent(DELIVERY);
    expect(capture.events).toContainEqual(expect.objectContaining({ operation: "wake", outcome: "refused", reasonCode: "flag-off" }));
  });

  it("names a session mismatch", async () => {
    const capture = collectPermissionEvents();
    onTestFinished(capture.restore);
    const bus = makeBus({ activeSession: "some-other-session", registerHandler: false });
    await bus.deliverToParent(DELIVERY);
    expect(capture.events).toContainEqual({
      event: "subagent_message_delivery", sessionId: "parent-session", childSessionId: "sub-child",
      operation: "wake", outcome: "refused", reasonCode: "session-mismatch:handler-unregistered",
    });
  });

  it("wakes — and audits nothing about refusal — when every condition holds", async () => {
    const capture = collectPermissionEvents();
    onTestFinished(capture.restore);
    const bus = makeBus({});
    const result = await bus.deliverToParent(DELIVERY);
    expect(result).toMatchObject({ ok: true, disposition: "wake-requested" });
    expect(capture.events.some(({ operation, outcome }) => operation === "wake" && outcome === "refused")).toBe(false);
  });
});
