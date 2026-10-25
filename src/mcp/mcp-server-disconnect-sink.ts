/** Shared retirement sink disables cards and clears server partitions for both external and plugin servers. */
import { createRequire } from "node:module";
import { CHANNELS } from "../contract/app-contract.js";
import { mcpAppPartitionName } from "../shared/mcp-app-partition.js";
import { createLogger } from "../lib/logger.js";

const log = createLogger("mcp-disconnect-sink");
const require = createRequire(import.meta.url);

type DisconnectSinkWindow = {
  isDestroyed(): boolean;
  webContents: { send(channel: string, payload: unknown): void };
};
type DisconnectSinkSession = { clearStorageData(): Promise<void> };

export interface McpServerDisconnectedSinkDeps {
  getAllWindows?: () => DisconnectSinkWindow[];
  fromPartition?: (name: string) => DisconnectSinkSession;
}

/** Broadcast retirement before clearing storage so live cards cannot race a wiped partition.
 * Catch synchronous partition-name errors and asynchronous clear failures during best-effort teardown. */
export function createMcpServerDisconnectedSink(
  deps: McpServerDisconnectedSinkDeps = {},
): (serverId: string) => void {
  const getAllWindows =
    deps.getAllWindows ??
    (() =>
      (require("electron").BrowserWindow as typeof import("electron").BrowserWindow)
        .getAllWindows() as unknown as DisconnectSinkWindow[]);
  const fromPartition =
    deps.fromPartition ??
    ((name: string) =>
      (require("electron").session as typeof import("electron").session)
        .fromPartition(name) as unknown as DisconnectSinkSession);

  return (serverId: string) => {
    try {
      for (const win of getAllWindows()) {
        if (!win.isDestroyed()) {
          win.webContents.send(CHANNELS.mcp.serverDisconnected, { serverId });
        }
      }
      void fromPartition(mcpAppPartitionName(serverId)).clearStorageData().catch(() => undefined);
    } catch (err) {
      log.warn("mcp: server-disconnected sink failed (%s): %s", serverId, (err as Error).message);
    }
  };
}
