import type { NativeImage, WebContents } from "electron";
import type { BrowserPreview, BrowserPreviewImage } from "../../shared/browser-workspace.js";
import { encodeBrowserPreview } from "./browser-workspace-preview.js";

const AGENT_PREVIEW_MAX_MS = 750;

export interface AgentPreviewTab {
  readonly windowId: number;
  readonly rendererTabId: string | null;
  readonly documentId: number;
  readonly guest: Pick<WebContents, "isDestroyed" | "capturePage"> | null;
}
/** The desktop side of agent captures: Electron decodes the PNG and the browser workspace keeps the last capture. This module
 * stays free of Electron values so the headless bundle can carry the page actions that import it. */
export interface AgentPreviewHost {
  decodePng(png: string): NativeImage;
  record(windowId: number, preview: BrowserPreview): void;
}
export interface AgentPreviewOptions {
  readonly maxMs?: number;
  /** The tool call's own signals: a stopped call gives up its thumbnail at once instead of waiting out the capture. */
  readonly signals?: readonly (AbortSignal | undefined)[];
}

// Best effort: a failed or slow capture leaves the tool result unchanged.
export async function captureAgentPreview(
  tab: AgentPreviewTab,
  png: string | undefined,
  host: AgentPreviewHost,
  options: AgentPreviewOptions = {},
): Promise<BrowserPreviewImage | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const signals = (options.signals ?? []).filter((signal): signal is AbortSignal => signal !== undefined);
  let stopWaiting: (() => void) | undefined;
  try {
    const guest = tab.guest;
    if (!guest || guest.isDestroyed() || signals.some((signal) => signal.aborted)) return undefined;
    const documentId = tab.documentId;
    const image = png !== undefined
      ? host.decodePng(png)
      : await Promise.race([
        guest.capturePage(undefined, { stayHidden: true, stayAwake: false }).catch(() => null),
        new Promise<null>((resolve) => {
          timer = setTimeout(() => resolve(null), options.maxMs ?? AGENT_PREVIEW_MAX_MS);
          stopWaiting = () => resolve(null);
          for (const signal of signals) signal.addEventListener("abort", stopWaiting, { once: true });
        }),
      ]);
    if (!image || tab.guest !== guest || guest.isDestroyed() || tab.documentId !== documentId) return undefined;
    const encoded = encodeBrowserPreview(image);
    if (!encoded) return undefined;
    if (tab.rendererTabId !== null) host.record(tab.windowId, { tabId: tab.rendererTabId, documentGeneration: documentId, ...encoded });
    return encoded;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
    if (stopWaiting) for (const signal of signals) signal.removeEventListener("abort", stopWaiting);
  }
}
