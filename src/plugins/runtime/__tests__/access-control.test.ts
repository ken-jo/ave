import { describe, expect, it, vi } from "vitest";
import {
  assertEventEmitAccess,
  assertEventSubscribeAccess,
} from "../index.js";

describe("plugin event access control", () => {
  it("audits each denied subscription once before refusing it", () => {
    const auditLog = vi.fn();
    expect(() => assertEventSubscribeAccess({
      callerPluginId: "plugin-a",
      eventType: "plugin-b.changed",
      auditLog,
    })).toThrow(/subscribe only to host.theme.changed/);
    expect(auditLog).toHaveBeenCalledTimes(1);
    expect(auditLog).toHaveBeenCalledWith(
      "error",
      "plugin_event_access_denied",
      { callerPluginId: "plugin-a", eventType: "plugin-b.changed" },
    );
  });

  it("audits each denied emission once before refusing it", () => {
    const auditLog = vi.fn();
    expect(() => assertEventEmitAccess({
      callerPluginId: "plugin-a",
      eventType: "plugin-b.changed",
      auditLog,
    })).toThrow(/emit only its own UI events/);
    expect(auditLog).toHaveBeenCalledTimes(1);
    expect(auditLog).toHaveBeenCalledWith(
      "error",
      "plugin_event_emit_denied",
      { callerPluginId: "plugin-a", eventType: "plugin-b.changed" },
    );
  });

  it("allows theme subscriptions and own UI emission without denial audit", () => {
    const auditLog = vi.fn();
    assertEventSubscribeAccess({ callerPluginId: "plugin-a", eventType: "host.theme.changed", auditLog });
    assertEventEmitAccess({ callerPluginId: "plugin-a", eventType: "plugin-a.changed", auditLog });
    expect(auditLog).not.toHaveBeenCalled();
  });
});
