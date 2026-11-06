import { describe, expect, it } from "vitest";
import { canEmitEvent, PUBLIC_EVENT_NAMESPACES, PUBLIC_HOST_EVENT_TYPES } from "../../plugins/capabilities.js";

describe("plugin UI event ownership", () => {
  it("has no public cross-plugin namespaces", () => {
    expect(PUBLIC_EVENT_NAMESPACES.size).toBe(0);
    expect([...PUBLIC_HOST_EVENT_TYPES]).toEqual(["host.theme.changed"]);
  });

  it("accepts only the emitting plugin's own event names", () => {
    expect(canEmitEvent("first.panel.updated", "first")).toBe(true);
    for (const type of ["second.panel.updated", "calendar.event.added", "meeting.started", "email.new", "index.updated", "first", "first."]) {
      expect(canEmitEvent(type, "first")).toBe(false);
    }
  });

  it("cannot spoof host-only namespaces", () => {
    for (const pluginId of ["host", "plugin", "work_board", "alert"]) {
      expect(canEmitEvent(`${pluginId}.state.changed`, pluginId)).toBe(false);
    }
  });
});
