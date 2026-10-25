import { useRef, useState } from "react";
import { BROWSER_SITE_DECISIONS, BROWSER_SITE_PERMISSIONS, BROWSER_WORKSPACE_LIMITS, browserWorkspaceUrl, type BrowserFindRequest, type BrowserWorkspaceApi, type BrowserWorkspaceResult } from "../../../shared/browser-workspace.js";
import { useTranslation } from "../../../i18n/react.js";
import { useBrowserWorkspace, type BrowserWorkspaceTabsClient } from "../hooks/use-browser-workspace.js";
import { BrowserWorkspaceCard } from "./BrowserWorkspaceCard.js";

export interface BrowserWorkspacePanelProps {
  readonly api: BrowserWorkspaceApi;
  readonly browserTabs: BrowserWorkspaceTabsClient;
  readonly activeTabId: string | null;
  readonly visible: boolean;
  readonly onOpenUrl: (url: string) => void;
}

export function BrowserWorkspacePanel({ api, browserTabs, activeTabId, visible, onOpenUrl }: BrowserWorkspacePanelProps) {
  const { t } = useTranslation();
  const { state, control, failed } = useBrowserWorkspace(api, browserTabs);
  const [expanded, setExpanded] = useState(false);
  const [text, setText] = useState("");
  const [operationFailed, setOperationFailed] = useState(false);
  const searchIdentity = useRef<Pick<BrowserFindRequest, "tabId" | "documentGeneration" | "text"> | null>(null);
  const active = state?.tabs.find((tab) => tab.tabId === activeTabId);
  const url = browserWorkspaceUrl(active?.url);
  const origin = url ? new URL(url).origin : null;
  const target = active ? { tabId: active.tabId, documentGeneration: active.documentGeneration } : null;
  const bookmarked = state?.bookmarks.some((entry) => entry.url === url) ?? false;
  const run = async (operation: Promise<BrowserWorkspaceResult<unknown>>): Promise<boolean> => {
    try { const result = await operation; setOperationFailed(!result.ok); return result.ok; } catch { setOperationFailed(true); return false; }
  };
  const findText = async (forward: boolean, forceNew: boolean) => {
    if (!target || !text.trim()) return;
    const identity = { ...target, text };
    const previous = searchIdentity.current;
    const findNext = forceNew || !previous || previous.tabId !== identity.tabId || previous.documentGeneration !== identity.documentGeneration || previous.text !== identity.text;
    searchIdentity.current = identity;
    if (!await run(api.find({ ...identity, forward, findNext })) && searchIdentity.current === identity) searchIdentity.current = null;
  };
  if (!visible) return null;
  return <section aria-label={t("browserWorkspace.title")} className="shrink-0 border-b text-xs" data-testid="browser-workspace-panel">
    <div className="flex flex-wrap items-center gap-1 p-1">
      <button type="button" className="rounded border px-2 py-1" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{t("browserWorkspace.library")}</button>
      <button type="button" className="rounded border px-2 py-1" disabled={!url || !active} aria-pressed={bookmarked} onClick={() => { if (url && active) void run(api.setBookmark({ url, title: active.title.slice(0, BROWSER_WORKSPACE_LIMITS.titleLength), bookmarked: !bookmarked })); }}>{t(bookmarked ? "browserWorkspace.removeBookmark" : "browserWorkspace.bookmark")}</button>
      <form className="flex min-w-0 items-center gap-1" onSubmit={(event) => { event.preventDefault(); void findText(true, true); }}>
        <input aria-label={t("browserWorkspace.find")} className="w-28 min-w-0 rounded border bg-transparent px-1 py-1" maxLength={BROWSER_WORKSPACE_LIMITS.findLength} value={text} onChange={(event) => setText(event.target.value)} />
        <button type="submit" className="rounded border px-1 py-1" disabled={!target || !text.trim()}>{t("browserWorkspace.find")}</button>
        <button type="button" className="rounded border px-1 py-1" disabled={!target || !text.trim()} onClick={() => void findText(false, false)}>{t("browserWorkspace.previous")}</button>
        <button type="button" className="rounded border px-1 py-1" disabled={!target || !text.trim()} onClick={() => void findText(true, false)}>{t("browserWorkspace.next")}</button>
        <button type="button" className="rounded border px-1 py-1" disabled={!target} onClick={() => { searchIdentity.current = null; if (target) void run(api.stopFind(target)); setText(""); }}>{t("browserWorkspace.stopFind")}</button>
      </form>
      <label className="flex items-center gap-1">{t("browserWorkspace.zoom")}<select aria-label={t("browserWorkspace.zoom")} className="rounded border bg-background px-1 py-1" disabled={!target} value={active?.zoomFactor ?? 1} onChange={(event) => { if (target) void run(api.zoom({ ...target, factor: Number(event.target.value) })); }}>
        {[0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2, 2.5, 3].map((factor) => <option key={factor} value={factor}>{Math.round(factor * 100)}%</option>)}
      </select></label>
    </div>
    {(failed || operationFailed) && <p role="alert" className="px-2 pb-1 text-destructive">{t("browserWorkspace.failed")}</p>}
    {state?.storageStatus === "corrupt" && <p role="alert" className="px-2 pb-1 text-destructive">{t("browserWorkspace.corrupt")}</p>}
    {expanded && state && <div className="max-h-72 space-y-3 overflow-auto border-t p-2">
      <div><h3 className="mb-1 font-semibold">{t("browserWorkspace.tabs")}</h3><ul className="grid grid-cols-2 gap-2">
        {state.tabs.map((tab) => {
          const view = control?.tabs.find((entry) => entry.rendererTabId === tab.tabId);
          return <BrowserWorkspaceCard key={`${tab.tabId}:${tab.documentGeneration}`} api={api} tab={tab} visible={visible && expanded} mode={t(`browserWorkspace.mode.${view?.mode ?? "human"}`)} />;
        })}
      </ul></div>
      <div><h3 className="mb-1 font-semibold">{t("browserWorkspace.bookmarks")}</h3>{state.bookmarks.length === 0 && <p className="text-muted-foreground">{t("browserWorkspace.empty")}</p>}<ul>{state.bookmarks.map((entry) => <li key={entry.url}><button type="button" className="max-w-full truncate text-left underline" title={entry.url} onClick={() => onOpenUrl(entry.url)}>{entry.title || entry.url}</button></li>)}</ul></div>
      <div><h3 className="mb-1 font-semibold">{t("browserWorkspace.history")}</h3><button type="button" className="mb-1 rounded border px-2 py-1" disabled={state.history.length === 0} onClick={() => void run(api.clearHistory())}>{t("browserWorkspace.clearHistory")}</button><ul>{state.history.map((entry) => <li key={entry.url}><button type="button" className="max-w-full truncate text-left underline" title={entry.url} onClick={() => onOpenUrl(entry.url)}>{entry.title || entry.url}</button></li>)}</ul></div>
      <fieldset disabled={!target || !origin}><legend className="mb-1 font-semibold">{t("browserWorkspace.sitePermissions")}</legend><p className="mb-1 break-all text-muted-foreground">{origin ?? t("browserWorkspace.noSite")}</p>
        <div className="grid grid-cols-2 gap-1">{BROWSER_SITE_PERMISSIONS.map((permission) => <label key={permission} className="flex items-center justify-between gap-2">{t(`browserWorkspace.permission.${permission}`)}<select className="rounded border bg-background p-1" aria-label={t(`browserWorkspace.permission.${permission}`)} disabled={permission === "fullscreen" && !state.capabilities.fullscreen} value={state.sitePermissions.find((rule) => rule.origin === origin && rule.permission === permission)?.decision ?? "ask"} onChange={(event) => { const decision = BROWSER_SITE_DECISIONS.find((candidate) => candidate === event.target.value); if (target && origin && decision) void run(api.setSitePermission({ ...target, origin, permission, decision })); }}>{BROWSER_SITE_DECISIONS.map((decision) => <option key={decision} value={decision}>{t(`browserWorkspace.decision.${decision}`)}</option>)}</select></label>)}</div>
        {!state.capabilities.fullscreen && <p className="mt-1 text-muted-foreground">{t("browserWorkspace.fullscreenUnavailable")}</p>}
      </fieldset>
      <div><h3 className="mb-1 font-semibold">{t("browserWorkspace.downloads")}</h3>{state.downloads.length === 0 && <p className="text-muted-foreground">{t("browserWorkspace.empty")}</p>}<ul>{state.downloads.map((download) => <li key={download.id} className="flex justify-between gap-2"><span className="truncate">{download.name}</span><span>{t(`browserWorkspace.download.${download.state}`)} · {Math.round(download.receivedBytes / 1024)} / {Math.round(download.totalBytes / 1024)} KB</span></li>)}</ul></div>
    </div>}
  </section>;
}
