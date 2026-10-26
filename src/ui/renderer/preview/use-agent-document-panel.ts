import { useEffect, useLayoutEffect, useRef } from "react";
import type { AvePreviewApi } from "../types.js";
import type { WorkspaceTabsStore } from "./workspace-tabs.js";
import type { ChatPreviewTarget } from "./preview-targets.js";
import { registerDocumentPanelHost } from "./agent-document-bridge.js";

interface DocumentPanelOptions {
  api: AvePreviewApi | undefined;
  sessionId: string | undefined;
  workspaceTabs: WorkspaceTabsStore;
  panelVisible: boolean;
  panelHidden: boolean;
  element: () => HTMLElement | null;
  targets: readonly ChatPreviewTarget[];
  addTarget: (sessionId: string, target: ChatPreviewTarget) => void;
  openPanel: () => void;
}
interface PendingDocument {
  sessionId: string;
  targetId: string;
  expiresAt: number;
  finish: (opened: boolean) => void;
}

/** Commit the existing preview tab selection before acknowledging a session-bound document request. */
export function useAgentDocumentPanel(options: DocumentPanelOptions): void {
  const current = useRef(options);
  const pendingRef = useRef<PendingDocument | null>(null);
  useLayoutEffect(() => { current.current = options; });
  useEffect(() => registerDocumentPanelHost(options.api, {
    sessionId: () => current.current.sessionId ?? null,
    isVisible: () => {
      const element = current.current.element();
      const style = element ? getComputedStyle(element) : null;
      return document.visibilityState === "visible" && !!element?.isConnected && element.closest("[inert]") === null
        && element.getClientRects().length > 0 && style?.visibility !== "hidden" && style?.display !== "none"
        && !current.current.panelHidden;
    },
    openDocument: (path, expiresAt) => {
      const { sessionId, workspaceTabs, addTarget, openPanel } = current.current;
      if (!sessionId || Date.now() >= expiresAt) return Promise.resolve(false);
      const existing = current.current.targets.find((target) => target.kind === "file" && target.path === path && target.inlineText === undefined);
      const targetId = existing?.id ?? `document:${path}`;
      pendingRef.current?.finish(false);
      const result = new Promise<boolean>((resolve) => {
        const finish = (opened: boolean): void => {
          clearTimeout(timer);
          if (pendingRef.current?.finish === finish) pendingRef.current = null;
          resolve(opened);
        };
        const timer = setTimeout(() => finish(false), Math.max(0, expiresAt - Date.now()));
        pendingRef.current = { sessionId, targetId, expiresAt, finish };
      });
      if (!existing) addTarget(sessionId, { id: targetId, kind: "file", path, title: path.split(/[\\/]/u).at(-1) ?? path,
        sourceLabel: "open_document", createdOrder: 0, canOpenExternal: false });
      workspaceTabs.openInEphemeral({ source: "preview", targetId });
      openPanel();
      return result;
    },
  }), [options.api]);
  useLayoutEffect(() => {
    const pending = pendingRef.current;
    if (!pending) return;
    if (pending.sessionId !== options.sessionId || Date.now() >= pending.expiresAt) {
      pending.finish(false); return;
    }
    const active = options.workspaceTabs.tabs.find((tab) => tab.id === options.workspaceTabs.activeTabId);
    if (options.panelVisible && active?.content?.source === "preview" && active.content.targetId === pending.targetId
      && options.targets.some((target) => target.id === pending.targetId)) pending.finish(true);
  }, [options]);
  useEffect(() => () => { pendingRef.current?.finish(false); }, []);
}
