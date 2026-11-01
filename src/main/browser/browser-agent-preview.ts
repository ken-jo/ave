import { nativeImage, type NativeImage, type WebContents } from "electron";
import type { BrowserPreview, BrowserPreviewImage } from "../../shared/browser-workspace.js";
import { encodeBrowserPreview } from "./browser-workspace-preview.js";

const AGENT_PREVIEW_MAX_MS = 750;

export interface AgentPreviewTab {
  readonly windowId: number;
  readonly rendererTabId: string | null;
  readonly documentId: number;
  readonly guest: Pick<WebContents, "isDestroyed" | "capturePage"> | null;
}
export type AgentPreviewRecorder = (windowId: number, preview: BrowserPreview) => void;
export interface AgentPreviewOptions {
  readonly decode?: (png: string) => NativeImage;
  readonly maxMs?: number;
}

function decodePng(png: string): NativeImage {
  return nativeImage.createFromBuffer(Buffer.from(png, "base64"));
}

// Best effort: a failed or slow capture leaves the tool result unchanged.
export async function captureAgentPreview(
  tab: AgentPreviewTab,
  png: string | undefined,
  record: AgentPreviewRecorder | undefined,
  options: AgentPreviewOptions = {},
): Promise<BrowserPreviewImage | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const guest = tab.guest;
    if (!guest || guest.isDestroyed()) return undefined;
    const documentId = tab.documentId;
    const image = png !== undefined
      ? (options.decode ?? decodePng)(png)
      : await Promise.race([
        guest.capturePage(undefined, { stayHidden: true, stayAwake: false }).catch(() => null),
        new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), options.maxMs ?? AGENT_PREVIEW_MAX_MS); }),
      ]);
    if (!image || tab.guest !== guest || guest.isDestroyed() || tab.documentId !== documentId) return undefined;
    const encoded = encodeBrowserPreview(image);
    if (!encoded) return undefined;
    if (record && tab.rendererTabId !== null) record(tab.windowId, { tabId: tab.rendererTabId, documentGeneration: documentId, ...encoded });
    return encoded;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}
