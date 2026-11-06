import { describe, expect, it } from "vitest";
import { emitPluginUiEvent, subscribeOwnPluginUiEvents } from "../plugins/ui-events.js";

describe("plugin transcript UI updates", () => {
  it("preserves chunk order and the final update for its own UI", () => {
    const received: unknown[] = [];
    const dispose = subscribeOwnPluginUiEvents("meeting", (_type, data) => received.push(data));
    try {
      for (let index = 0; index < 3; index += 1) {
        emitPluginUiEvent("meeting", "meeting.transcript.updated", { index, isFinal: index === 2 });
      }
      expect(received).toEqual([
        { index: 0, isFinal: false },
        { index: 1, isFinal: false },
        { index: 2, isFinal: true },
      ]);
    } finally {
      dispose();
    }
  });
});
