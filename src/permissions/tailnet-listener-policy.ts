import { TAILNET_CONFINED_RANGE_UNVERIFIED, TAILNET_PORT_CONFINED_WORKER_RANGE } from "../shared/tailnet-observer-config.js";
import { getWindowsProxyPortRange } from "./asrt-sandbox.js";
import { readAsrtWindowsStatus } from "./asrt-windows-support.js";
import { getWindowsSandboxSubstrate, isPluginWorkerConfinementRequestedAtBoot } from "./sandbox-capability.js";

/** Read once per selection or admission so every candidate is tested against the same permit. */
export async function readTailnetListenerPortPolicy(): Promise<(port: number) => boolean> {
  if (process.platform !== "win32") return () => true;

  const configured = getWindowsProxyPortRange();
  const substrate = getWindowsSandboxSubstrate();
  // A ready WFP dependency can become selectable after boot, when background isolation finishes.
  const canSelectWfpWorker = isPluginWorkerConfinementRequestedAtBoot() && substrate?.srtWinReady === true
    && substrate.extensions !== "mxc";
  const installed = canSelectWfpWorker
    ? (await readAsrtWindowsStatus().catch(() => undefined))?.wfpPortRange
    : undefined;
  if (canSelectWfpWorker && installed === undefined) throw new Error(TAILNET_CONFINED_RANGE_UNVERIFIED);
  const ranges = installed === undefined ? [configured] : [configured, installed];
  return port => !ranges.some(([first, last]) => port >= first && port <= last);
}

export async function assertTailnetListenerPortAllowed(port: number): Promise<void> {
  const isAllowed = await readTailnetListenerPortPolicy();
  if (!isAllowed(port)) throw new Error(TAILNET_PORT_CONFINED_WORKER_RANGE);
}
