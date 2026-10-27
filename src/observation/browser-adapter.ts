import { OBSERVATION_LIMITS, type BrowserObservationDetail, type BrowserObservationEvent } from "../shared/agent-observation.js";
import { ObservationDaemon, type ObservationAdapter } from "./daemon.js";

interface BrowserViewRegistration {
  id: string;
  sessionId: string;
  hostSessionId: string;
  isCurrent: () => boolean;
  onEvents: (events: BrowserObservationEvent[]) => void;
}

/** Only command receipts supply metadata; this adapter never listens to a page. */
export class BrowserObservationAdapter implements ObservationAdapter {
  readonly source = "browser" as const;
  private readonly views = new Set<string>();
  private disposed = false;

  constructor(private readonly daemon: ObservationDaemon) { daemon.registerAdapter(this); }

  registerView(registration: BrowserViewRegistration): void {
    if (this.disposed || this.views.has(registration.id)) throw new Error("Browser observation view already registered.");
    if (!registration.hostSessionId || registration.hostSessionId.length > 256) throw new Error("Invalid browser observation host session.");
    this.daemon.registerTarget<BrowserObservationEvent>({ id: registration.id, path: "browser", hostSessionId: registration.hostSessionId }, registration.sessionId,
      registration.isCurrent, registration.onEvents, this.source);
    this.views.add(registration.id);
  }

  record(id: string, detail: BrowserObservationDetail): void {
    if (this.disposed || !this.views.has(id)) throw new Error("Browser observation view is unavailable.");
    this.daemon.publish<BrowserObservationEvent>(id, { kind: "action", before: null, after: sanitizeBrowserObservationDetail(detail) });
  }

  acknowledge(id: string, seq: number): void {
    if (!this.views.has(id)) throw new Error("Browser observation view is unavailable.");
    this.daemon.acknowledge<BrowserObservationEvent>(id, seq);
  }

  release(id: string): void { this.views.delete(id); this.daemon.release(id); }

  clear(id: string): void {
    try { this.daemon.endTarget(id); }
    finally { this.views.delete(id); }
  }

  requireResync(id: string): void {
    this.daemon.publish<BrowserObservationEvent>(id, { kind: "status", before: null, after: { code: "resync-required" } });
  }

  dispose(): void {
    this.disposed = true;
    for (const id of this.views) this.release(id);
  }
}

function displayText(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, " ").slice(0, OBSERVATION_LIMITS.browserTextChars);
}

/** Drop URL credentials and all query/fragment data before anything reaches a queue. */
function displayUrl(value: string): string {
  if (value === "about:blank") return value;
  let url: URL;
  try { url = new URL(value); }
  catch { throw new Error("Invalid browser observation URL."); }
  if (url.protocol !== "https:" && url.protocol !== "http:") return "";
  url.username = ""; url.password = ""; url.search = ""; url.hash = "";
  return url.href.slice(0, OBSERVATION_LIMITS.browserUrlChars);
}

export function sanitizeBrowserObservationDetail(detail: BrowserObservationDetail): BrowserObservationDetail {
  if (!/^tab-\d+$/.test(detail.tabId) || (detail.rendererTabId !== null
    && (detail.rendererTabId.length === 0 || detail.rendererTabId.length > 256))) {
    throw new Error("Invalid browser observation tab identity.");
  }
  if (detail.action === "download" && !detail.download) throw new Error("Missing browser observation download state.");
  const element = detail.element;
  if (element && !/^e\d+$/.test(element.ref)) throw new Error("Invalid browser observation element reference.");
  return {
    action: detail.action, tabId: detail.tabId, rendererTabId: detail.rendererTabId,
    url: displayUrl(detail.url), title: displayText(detail.title),
    ...(element ? { element: { ref: element.ref, role: displayText(element.role),
      name: element.redacted ? "" : displayText(element.name), redacted: element.redacted } } : {}),
    ...(detail.download ? { download: { state: detail.download.state } } : {}),
  };
}
