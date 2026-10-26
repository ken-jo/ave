/** Broadcast disconnect before clearing storage so live cards cannot race a wiped partition. */
import { describe, it, expect, vi } from "vitest";
import { createMcpServerDisconnectedSink } from "../../../mcp/mcp-server-disconnect-sink.js";
import { CHANNELS } from "../../../contract/app-contract.js";
import { mcpAppPartitionName, MAX_SERVER_ID_LEN } from "../../../shared/mcp-app-partition.js";

function harness() {
  const order: string[] = [];
  const send = vi.fn(() => order.push("broadcast"));
  const destroyedSend = vi.fn();
  const clearStorageData = vi.fn(() => {
    order.push("clear");
    return Promise.resolve();
  });
  const fromPartition = vi.fn((name: string) => {
    order.push(`from:${name}`);
    return { clearStorageData };
  });
  const sink = createMcpServerDisconnectedSink({
    getAllWindows: () => [
      { isDestroyed: () => false, webContents: { send } },
      { isDestroyed: () => true, webContents: { send: destroyedSend } },
    ],
    fromPartition,
  });
  return { order, send, destroyedSend, clearStorageData, fromPartition, sink };
}

describe("createMcpServerDisconnectedSink", () => {
  it("broadcasts to non-destroyed windows only, then clears (order)", () => {
    const h = harness();
    h.sink("github");

    expect(h.send).toHaveBeenCalledWith(CHANNELS.mcp.serverDisconnected, { serverId: "github" });
    expect(h.destroyedSend).not.toHaveBeenCalled();
    expect(h.clearStorageData).toHaveBeenCalledOnce();
    expect(h.fromPartition).toHaveBeenCalledWith(mcpAppPartitionName("github"));

    expect(h.order.indexOf("broadcast")).toBeLessThan(h.order.indexOf("clear"));
  });

  it("swallows a synchronous throw from an over-length id (MINOR-A) — broadcast still ran", () => {
    const send = vi.fn();
    const clearStorageData = vi.fn(() => Promise.resolve());
    // `mcpAppPartitionName(id)` throws at the clear step for an over-length id.
    const sink = createMcpServerDisconnectedSink({
      getAllWindows: () => [{ isDestroyed: () => false, webContents: { send } }],
      fromPartition: () => ({ clearStorageData }),
    });
    const tooLong = "a".repeat(MAX_SERVER_ID_LEN + 1);
    expect(() => sink(tooLong)).not.toThrow();
    expect(send).toHaveBeenCalledOnce();
    expect(clearStorageData).not.toHaveBeenCalled();
  });
});
