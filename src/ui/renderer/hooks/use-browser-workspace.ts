import { useEffect, useState } from "react";
import { parseBrowserWorkspaceState, type BrowserWorkspaceApi, type BrowserWorkspaceState } from "../../../shared/browser-workspace.js";
import type { BrowserTabControlState } from "../../../shared/browser-surface.js";

export interface BrowserWorkspaceTabsClient {
  getState(): Promise<BrowserTabControlState>;
  onControl(handler: (state: BrowserTabControlState) => void): () => void;
}
export function useBrowserWorkspace(api: BrowserWorkspaceApi, browserTabs: BrowserWorkspaceTabsClient) {
  const [state, setState] = useState<BrowserWorkspaceState | null>(null);
  const [control, setControl] = useState<BrowserTabControlState | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    let newestState = -1;
    let newestControl = -1;
    setState(null); setControl(null); setFailed(false);
    const accept = (value: BrowserWorkspaceState) => {
      const parsed = parseBrowserWorkspaceState(value);
      if (!alive) return;
      if (!parsed) { setFailed(true); return; }
      if (parsed.revision >= newestState) { newestState = parsed.revision; setState(parsed); }
    };
    const acceptControl = (value: BrowserTabControlState) => {
      if (alive && value.revision >= newestControl) { newestControl = value.revision; setControl(value); }
    };
    const unsubscribeState = api.onChanged(accept);
    const unsubscribeControl = browserTabs.onControl(acceptControl);
    void api.getState().then((result) => { if (result.ok) accept(result.value); else if (alive) setFailed(true); }).catch(() => { if (alive) setFailed(true); });
    void browserTabs.getState().then(acceptControl).catch(() => { if (alive) setFailed(true); });
    return () => { alive = false; unsubscribeState(); unsubscribeControl(); };
  }, [api, browserTabs]);
  return { state, control, failed };
}
