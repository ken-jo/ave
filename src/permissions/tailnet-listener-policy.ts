import { TAILNET_PORT_CONFINED_WORKER_RANGE } from "../shared/tailnet-observer-config.js";
import { getWindowsProxyPortRange } from "./asrt-sandbox.js";

export function assertTailnetListenerPortAllowed(port: number): void {
  if (process.platform !== "win32") return;
  const [first, last] = getWindowsProxyPortRange();
  if (port >= first && port <= last) throw new Error(TAILNET_PORT_CONFINED_WORKER_RANGE);
}
