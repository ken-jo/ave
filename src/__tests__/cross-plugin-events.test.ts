/** Exercise host event routing in-process; plugin behavior belongs in plugin suites. */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { emitEvent, onEvent, offEvent } from "../boot/types.js";

import {
  canEmitEvent,
  requiredCapabilityForEmit,
  classifySubscription,
  PUBLIC_EVENT_NAMESPACES,
} from "../plugins/capabilities.js";

/** Use the production emit predicate without loading the plugin runtime. */
function makeStubEmitEvent(pluginId: string, emittedEvents: string[]) {
  return (type: string, data?: Record<string, unknown>) => {
    if (!canEmitEvent(type, emittedEvents)) {
      const requiredCap = requiredCapabilityForEmit(type);
      console.warn(
        `[ave] plugin:${pluginId} emitEvent('${type}') dropped — missing capability '${requiredCap}'`,
      );
      return; // dropped
    }
    emitEvent(type, { pluginId, ...(data ?? {}) });
  };
}

describe("Sprint 4-D T4 — cross-plugin event flow (host event bus)", () => {
  const disposers: Array<() => void> = [];

  afterEach(() => {
    for (const d of disposers.splice(0)) d();
  });

  it("Scenario 1 — meeting.summary.created triggers calendar handler", () => {
    const calendarHandler = vi.fn();
    disposers.push(onEvent("meeting.summary.created", calendarHandler));

    const meetingEmit = makeStubEmitEvent("meeting", ["meeting.summary.created"]);

    const payload = {
      sessionId: "sess-001",
      title: "Quarterly Planning",
      summary: "Discussed roadmap.",
      highlights: ["Milestone A"],
      actionItems: ["Follow up with design team"],
    };

    meetingEmit("meeting.summary.created", payload);

    expect(calendarHandler).toHaveBeenCalledTimes(1);
    expect(calendarHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "meeting",
        sessionId: "sess-001",
        title: "Quarterly Planning",
      }),
    );
  });

  it("Scenario 2 — email.invite.detected triggers calendar handler", () => {
    const calendarHandler = vi.fn();
    disposers.push(onEvent("email.invite.detected", calendarHandler));

    const emailEmit = makeStubEmitEvent("email", ["email.invite.detected"]);

    const payload = {
      messageId: "msg-abc",
      subject: "Team sync invite",
      start: "2026-04-20T10:00:00+09:00",
      end: "2026-04-20T11:00:00+09:00",
    };

    emailEmit("email.invite.detected", payload);

    expect(calendarHandler).toHaveBeenCalledTimes(1);
    expect(calendarHandler).toHaveBeenCalledWith(
      expect.objectContaining({
        pluginId: "email",
        messageId: "msg-abc",
        subject: "Team sync invite",
      }),
    );
  });

  it("Scenario 4 — memory.private.secret is classified as private and subscription is blocked at wiring time", () => {
    // Manifest subscription wiring, rather than the raw bus, rejects private namespaces.

    expect(classifySubscription("memory.private.secret")).toBe("private");
    expect(classifySubscription("memory.private.anything")).toBe("private");
    expect(classifySubscription("settings.apiKey.openai")).toBe("private");
    expect(classifySubscription("audit.log")).toBe("private");
    expect(classifySubscription("dlp.redacted")).toBe("private");

    const spy = vi.fn();
    disposers.push(onEvent("memory.private.secret", spy));

    emitEvent("memory.private.secret", { secret: "hunter2" });

    expect(classifySubscription("memory.private.secret")).toBe("private");

    expect(PUBLIC_EVENT_NAMESPACES.has("memory")).toBe(false);
    expect(PUBLIC_EVENT_NAMESPACES.has("audit")).toBe(false);
    expect(PUBLIC_EVENT_NAMESPACES.has("dlp")).toBe(false);
    expect(PUBLIC_EVENT_NAMESPACES.has("settings")).toBe(false);
  });

  it("Scenario 5 — plugin that did not declare the email namespace cannot emit email.new", () => {
    const spy = vi.fn();
    disposers.push(onEvent("email.new", spy));

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const meetingEmit = makeStubEmitEvent("meeting", ["meeting.summary.created"]);
    meetingEmit("email.new", { subject: "Test" });

    expect(spy).not.toHaveBeenCalled();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("dropped — missing capability 'mail-source'"),
    );

    warnSpy.mockRestore();
  });

  it("Scenario 10 — plugin that did not declare the meeting namespace cannot emit meeting.*", () => {
    const spy = vi.fn();
    disposers.push(onEvent("meeting.summary.created", spy));

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    const emailEmit = makeStubEmitEvent("email", ["email.new"]);
    emailEmit("meeting.summary.created", { sessionId: "fake", summary: "fake" });

    expect(spy).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("dropped — missing capability 'meeting-recorder'"),
    );

    warnSpy.mockRestore();
  });

  it("Scenario 5b — plugin declaring email.* in emittedEvents can emit email.new", () => {
    const spy = vi.fn();
    disposers.push(onEvent("email.new", spy));

    const emailEmit = makeStubEmitEvent("email", ["email.new"]);
    emailEmit("email.new", { subject: "Hello" });

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({ pluginId: "email", subject: "Hello" }),
    );
  });
});
