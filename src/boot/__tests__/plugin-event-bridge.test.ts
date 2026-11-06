import { describe, expect, it, vi } from "vitest";
import { emitEvent } from "../types.js";
import { emitPluginUiEvent } from "../../plugins/ui-events.js";
import { registerPluginEventBridge } from "../steps/ipc-bridge.js";
import { CHANNELS } from "../../contract/app-contract.js";

describe("plugin UI event bridge", () => {
  it("forwards owned UI events and ignores global cross-plugin events", () => {
    const send = vi.fn();
    const runtime = { listPluginManifests: () => [{ pluginId: "first" }] };
    const win = { isDestroyed: () => false, webContents: { send }, once: vi.fn() };
    const dispose = registerPluginEventBridge(runtime as never, win as never);
    emitEvent("calendar.event.added", { pluginId: "first" });
    expect(send).not.toHaveBeenCalled();
    emitPluginUiEvent("first", "first.panel.updated", { value: 1 });
    expect(send).toHaveBeenCalledWith(CHANNELS.pluginBridge.event, "first.panel.updated", { value: 1 });
    dispose();
    send.mockClear();
    emitPluginUiEvent("first", "first.panel.updated");
    expect(send).not.toHaveBeenCalled();
  });
});
