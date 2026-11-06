import { afterEach, describe, expect, it, vi } from "vitest";
import { emitPluginUiEvent, subscribeOwnPluginUiEvents } from "../ui-events.js";

const disposers: Array<() => void> = [];
afterEach(() => { for (const dispose of disposers.splice(0)) dispose(); });

describe("plugin UI events", () => {
  it("delivers to the emitting plugin's own UI without notifying another plugin", () => {
    const own = vi.fn();
    const other = vi.fn();
    disposers.push(subscribeOwnPluginUiEvents("first", own));
    disposers.push(subscribeOwnPluginUiEvents("second", other));
    emitPluginUiEvent("first", "first.panel.updated", { value: 1 });
    expect(own).toHaveBeenCalledWith("first.panel.updated", { value: 1 });
    expect(other).not.toHaveBeenCalled();
  });

  it("rejects foreign and reserved event targets", () => {
    for (const type of ["second.panel.updated", "calendar.event.added", "host.theme.changed", "audit.entry.created"]) {
      expect(() => emitPluginUiEvent("first", type)).toThrow("only its own UI events");
    }
  });

  it("disposes listeners", () => {
    const receive = vi.fn();
    const dispose = subscribeOwnPluginUiEvents("first", receive);
    dispose();
    emitPluginUiEvent("first", "first.panel.updated");
    expect(receive).not.toHaveBeenCalled();
  });
});
