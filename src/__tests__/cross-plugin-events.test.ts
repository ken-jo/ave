import { describe, expect, it, vi } from "vitest";
import { onEvent } from "../boot/types.js";
import { emitPluginUiEvent, subscribeOwnPluginUiEvents } from "../plugins/ui-events.js";

describe("plugin event isolation", () => {
  it("does not publish a UI notification on the host bus or to a foreign plugin", () => {
    const globalListener = vi.fn();
    const foreignListener = vi.fn();
    const disposeGlobal = onEvent("first.panel.updated", globalListener);
    const disposeForeign = subscribeOwnPluginUiEvents("second", foreignListener);
    try {
      emitPluginUiEvent("first", "first.panel.updated", { pluginId: "second" });
      expect(globalListener).not.toHaveBeenCalled();
      expect(foreignListener).not.toHaveBeenCalled();
    } finally {
      disposeGlobal();
      disposeForeign();
    }
  });
});
