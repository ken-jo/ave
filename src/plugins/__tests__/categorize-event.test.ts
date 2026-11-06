import { describe, expect, it } from "vitest";
import { categorizeEvent } from "../capabilities.js";

describe("event categories", () => {
  it("recognizes only the host theme event as a public category", () => {
    expect(categorizeEvent("host.theme.changed")).toBe("host");
    for (const type of ["meeting.started", "calendar.event.added", "email.new", "index.updated", "first.panel.updated"]) {
      expect(categorizeEvent(type)).toBe("other");
    }
  });
});
