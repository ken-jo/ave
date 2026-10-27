import type { BrowserGuest, BrowserTabRecord } from "../main/browser/browser-tab-registry.js";
import type { BrowserObservationAction, BrowserObservationDetail, BrowserObservationElement, ObservationIdentity } from "../shared/agent-observation.js";
import { captureAgentObservationInvocation } from "./agent-observation-context.js";

export interface AgentBrowserCommandReceipt {
  target(element: BrowserObservationElement, downloadUrl?: string): void;
  complete(): void;
  dispose(): void;
}
export interface AgentBrowserObservationSink {
  begin(identity: ObservationIdentity, tab: BrowserTabRecord<BrowserGuest>, action: BrowserObservationAction,
    isCurrent: () => boolean, detail: BrowserObservationDetail, downloadUrl?: string): AgentBrowserCommandReceipt;
  endSessions(ended: (sessionId: string) => boolean): void;
}
let browserSink: AgentBrowserObservationSink | undefined;
export function setAgentBrowserObservationSink(sink: AgentBrowserObservationSink | undefined): void { browserSink = sink; }
export function endAgentBrowserObservationSessions(ended: (sessionId: string) => boolean): void { browserSink?.endSessions(ended); }

/** Model-turn identity is host-owned; metadata or a renderer cannot admit a command. */
export async function observeAgentBrowserCommand<T>(
  tab: BrowserTabRecord<BrowserGuest>, action: BrowserObservationAction,
  run: (onTarget: ((element: BrowserObservationElement, downloadUrl?: string) => void) | undefined) => Promise<T>,
  signal?: AbortSignal, expectedDownloadUrl?: string,
): Promise<T> {
  const admission = captureAgentObservationInvocation();
  const identity = admission?.identity;
  const guest = tab.guest;
  const sink = browserSink;
  const tabOperation = action === "tab-close" || action === "tab-switch";
  const lease = tab.lease;
  const controlled = lease?.actor.sessionId === identity?.sessionId && tab.controlMode === "agent-active";
  const ownedOperation = tabOperation && tab.opener === "agent" && tab.owner !== null && tab.controlMode !== "human-paused";
  if (!identity || !admission || !sink || !guest || guest.isDestroyed() || signal?.aborted || (!controlled && !ownedOperation)) {
    return run(undefined);
  }
  const isCurrent = (): boolean => admission.isCurrent() && !signal?.aborted
    && tab.controlMode !== "human-paused" && (tab.guest === guest || (action === "tab-close" && tab.guest === null && guest.isDestroyed()))
    && (action === "tab-close" || !guest.isDestroyed())
    && (lease ? tab.lease?.id === lease.id && tab.lease.actor.sessionId === identity.sessionId : ownedOperation && tab.opener === "agent");
  const receipt = sink.begin(identity, tab, action, isCurrent, { action, tabId: tab.handle,
    rendererTabId: tab.rendererTabId, url: guest.getURL(), title: guest.getTitle() }, expectedDownloadUrl);
  try {
    const result = await run((element, downloadUrl) => receipt.target(element, downloadUrl));
    if (isCurrent() && !(result && typeof result === "object" && "isError" in result && result.isError === true)) receipt.complete();
    return result;
  } finally { receipt.dispose(); }
}
