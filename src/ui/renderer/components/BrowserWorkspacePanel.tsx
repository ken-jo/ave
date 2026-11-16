import { EmptyState } from "../../../components/ui/empty-state.js";
import { useEffect, useRef, useState } from "react";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { BROWSER_VISITORS, BROWSER_WORKSPACE_LIMITS, browserWorkspaceUrl, type BrowserFindRequest, type BrowserFindResult, type BrowserWorkspaceApi, type BrowserWorkspaceResult } from "../../../shared/browser-workspace.js";
import { useTranslation } from "../../../i18n/react.js";
import { useBrowserWorkspace, type BrowserWorkspaceTabsClient } from "../hooks/use-browser-workspace.js";
import { BrowserWorkspaceCard } from "./BrowserWorkspaceCard.js";

export interface BrowserWorkspacePanelProps {
  readonly api: BrowserWorkspaceApi;
  readonly browserTabs: BrowserWorkspaceTabsClient;
  readonly activeTabId: string | null;
  readonly visible: boolean;
  readonly onOpenUrl: (url: string) => void;
  /** Rises each time the find field should take the caret. */
  readonly findFocus?: number;
}

/** The library shows one kind of thing at a time. */
const LIBRARY_SECTIONS = ["tabs", "bookmarks", "history", "downloads", "data"] as const;
type LibrarySection = typeof LIBRARY_SECTIONS[number];
const ROW_BUTTON = "h-6 px-2 text-xs";

export function BrowserWorkspacePanel({ api, browserTabs, activeTabId, visible, onOpenUrl, findFocus = 0 }: BrowserWorkspacePanelProps) {
  const findInput = useRef<HTMLInputElement>(null);
  useEffect(() => { if (findFocus > 0 && visible) { findInput.current?.focus(); findInput.current?.select(); } }, [findFocus, visible]);
  const { t } = useTranslation();
  const { state, control, failed } = useBrowserWorkspace(api, browserTabs);
  const [expanded, setExpanded] = useState(false);
  const [text, setText] = useState("");
  const [operationFailed, setOperationFailed] = useState(false);
  const [historyQuery, setHistoryQuery] = useState("");
  const [clearKinds, setClearKinds] = useState({ history: true, siteData: false, cache: false });
  const [dataCleared, setDataCleared] = useState(false);
  const [section, setSection] = useState<LibrarySection>("tabs");
  // A find's count arrives after its request returns, and can arrive before it: the two meet by request id.
  const [findRequest, setFindRequest] = useState<number | null>(null);
  const [findResult, setFindResult] = useState<BrowserFindResult | null>(null);
  useEffect(() => api.onFindResult(setFindResult), [api]);
  const searchIdentity = useRef<Pick<BrowserFindRequest, "tabId" | "documentGeneration" | "text"> | null>(null);
  const active = state?.tabs.find((tab) => tab.tabId === activeTabId);
  const url = browserWorkspaceUrl(active?.url);
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
    let result: Awaited<ReturnType<BrowserWorkspaceApi["find"]>>;
    try { result = await api.find({ ...identity, forward, findNext }); } catch { setOperationFailed(true); if (searchIdentity.current === identity) searchIdentity.current = null; return; }
    setOperationFailed(!result.ok);
    if (result.ok) setFindRequest(result.value.requestId);
    else if (searchIdentity.current === identity) searchIdentity.current = null;
  };
  const counted = findRequest !== null && findResult !== null && findResult.requestId === findRequest && findResult.tabId === active?.tabId ? findResult : null;
  const clearFind = () => { searchIdentity.current = null; setFindRequest(null); if (target) void run(api.stopFind(target)); setText(""); };
  if (!visible) return null;
  return <section aria-label={t("browserWorkspace.title")} className="shrink-0 border-b text-xs" data-testid="browser-workspace-panel">
    <div className="flex flex-wrap items-center gap-1 p-1">
      <Button type="button" variant="outline" size="sm" className={ROW_BUTTON} aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{t("browserWorkspace.library")}</Button>
      <Button type="button" variant="outline" size="sm" className={ROW_BUTTON} disabled={!url || !active} aria-pressed={bookmarked} onClick={() => { if (url && active) void run(api.setBookmark({ url, title: active.title.slice(0, BROWSER_WORKSPACE_LIMITS.titleLength), bookmarked: !bookmarked })); }}>{t(bookmarked ? "browserWorkspace.removeBookmark" : "browserWorkspace.bookmark")}</Button>
      <form className="flex min-w-0 items-center gap-1" onSubmit={(event) => { event.preventDefault(); void findText(true, true); }}>
        <Input ref={findInput} aria-label={t("browserWorkspace.find")} placeholder={t("browserWorkspace.find")} className="h-6 w-32 min-w-0 px-2 text-xs" maxLength={BROWSER_WORKSPACE_LIMITS.findLength} value={text} onChange={(event) => { setText(event.target.value); setFindRequest(null); }} onKeyDown={(event) => { if (event.key === "Escape") clearFind(); }} data-testid="browser-find-input" />
        {counted ? <span role="status" className="shrink-0 tabular-nums text-muted-foreground" data-testid="browser-find-count" data-matches={counted.matches}>{counted.matches === 0 ? t("browserWorkspace.findNone") : t("browserWorkspace.findCount", { current: String(counted.activeMatch), total: String(counted.matches) })}</span> : null}
        <Button type="submit" variant="outline" size="sm" className={ROW_BUTTON} disabled={!target || !text.trim()}>{t("browserWorkspace.find")}</Button>
        <Button type="button" variant="outline" size="sm" className={ROW_BUTTON} disabled={!target || !text.trim()} onClick={() => void findText(false, false)}>{t("browserWorkspace.previous")}</Button>
        <Button type="button" variant="outline" size="sm" className={ROW_BUTTON} disabled={!target || !text.trim()} onClick={() => void findText(true, false)}>{t("browserWorkspace.next")}</Button>
        <Button type="button" variant="outline" size="sm" className={ROW_BUTTON} disabled={!target} onClick={clearFind}>{t("browserWorkspace.stopFind")}</Button>
      </form>
    </div>
    {(failed || operationFailed) && <p role="alert" className="px-2 pb-1 text-destructive">{t("browserWorkspace.failed")}</p>}
    {state?.storageStatus === "corrupt" && <p role="alert" className="px-2 pb-1 text-destructive">{t("browserWorkspace.corrupt")}</p>}
    {expanded && state && <div className="border-t" data-testid="browser-library" data-section={section}>
      <fieldset aria-label={t("browserWorkspace.library")} className="m-0 flex min-w-0 flex-wrap gap-1 border-0 border-b p-1">
        {LIBRARY_SECTIONS.map((name) => <Button key={name} type="button" variant={name === section ? "secondary" : "ghost"} size="sm" className={ROW_BUTTON} aria-pressed={name === section} onClick={() => setSection(name)} data-testid={`browser-library-${name}`}>{t(`browserWorkspace.section.${name}`)}</Button>)}
      </fieldset>
      <div className="max-h-72 overflow-auto p-2">
      {section === "tabs" && <div><ul className="grid grid-cols-2 gap-2">
        {state.tabs.map((tab) => {
          const view = control?.tabs.find((entry) => entry.rendererTabId === tab.tabId);
          return <BrowserWorkspaceCard key={`${tab.tabId}:${tab.documentGeneration}`} api={api} tab={tab} visible={visible && expanded} mode={t(`browserWorkspace.mode.${view?.mode ?? "human"}`)} />;
        })}
      </ul></div>}
      {section === "bookmarks" && <div>{state.bookmarks.length === 0 && <EmptyState className="p-0" title={t("browserWorkspace.empty")} />}<ul>{state.bookmarks.map((entry) => <li key={entry.url}><button type="button" className="max-w-full truncate text-left underline" title={entry.url} onClick={() => onOpenUrl(entry.url)}>{entry.title || entry.url}</button></li>)}</ul></div>}
      {section === "history" && <div data-testid="browser-history">
        <div className="mb-1 flex flex-wrap items-center gap-1">
          <Input aria-label={t("browserWorkspace.historySearch")} placeholder={t("browserWorkspace.historySearch")} className="h-6 w-44 min-w-0 px-2 text-xs" value={historyQuery} onChange={(event) => setHistoryQuery(event.target.value)} data-testid="browser-history-search" />
          <Button type="button" variant="outline" size="sm" className={ROW_BUTTON} disabled={state.history.length === 0} onClick={() => void run(api.clearHistory())}>{t("browserWorkspace.clearHistory")}</Button>
        </div>
        {BROWSER_VISITORS.map((by) => {
          const needle = historyQuery.trim().toLowerCase();
          const entries = state.history.filter((entry) => entry.by === by && (needle === "" || entry.title.toLowerCase().includes(needle) || entry.url.toLowerCase().includes(needle)));
          // The agent's visits are listed apart, and only when there are any: they are not the user's own browsing.
          if (by === "agent" && !state.history.some((entry) => entry.by === "agent")) return null;
          return <div key={by} data-testid={`browser-history-${by}`}>
            {by === "agent" && <h4 className="mb-1 mt-2 font-medium text-muted-foreground">{t("browserWorkspace.historyAgent")}</h4>}
            {entries.length === 0 && <EmptyState className="p-0" title={t(needle === "" ? "browserWorkspace.empty" : "browserWorkspace.historyNoMatch")} />}
            <ul>{entries.map((entry) => <li key={entry.url} className="flex items-center justify-between gap-2" data-testid="browser-history-row">
              <button type="button" className="min-w-0 truncate text-left underline" title={entry.url} onClick={() => onOpenUrl(entry.url)}>{entry.title || entry.url}</button>
              <span className="flex shrink-0 items-center gap-1 text-muted-foreground"><time dateTime={new Date(entry.at).toISOString()}>{new Date(entry.at).toLocaleString()}</time>
                <Button type="button" variant="outline" size="sm" className={ROW_BUTTON} aria-label={t("browserWorkspace.historyDelete", { title: entry.title || entry.url })} onClick={() => void run(api.deleteHistory({ url: entry.url, by: entry.by }))} data-testid="browser-history-delete">{t("browserWorkspace.historyDeleteShort")}</Button>
              </span>
            </li>)}</ul>
          </div>;
        })}
      </div>}
      {section === "data" && <fieldset data-testid="browser-clear-data"><legend className="mb-1 font-semibold">{t("browserWorkspace.clearData")}</legend>
        <div className="flex flex-wrap items-center gap-3">
          {(["history", "siteData", "cache"] as const).map((kind) => <label key={kind} className="flex items-center gap-1"><input type="checkbox" checked={clearKinds[kind]} onChange={(event) => { setDataCleared(false); setClearKinds({ ...clearKinds, [kind]: event.target.checked }); }} data-testid={`browser-clear-data-${kind}`} />{t(`browserWorkspace.clearData.${kind}`)}</label>)}
          <Button type="button" variant="outline" size="sm" className={ROW_BUTTON} disabled={!clearKinds.history && !clearKinds.siteData && !clearKinds.cache} data-testid="browser-clear-data-submit" onClick={() => void run(api.clearData(clearKinds)).then(setDataCleared)}>{t("browserWorkspace.clearData.submit")}</Button>
        </div>
        <p className="mt-1 text-muted-foreground">{t("browserWorkspace.clearData.note")}</p>
        {dataCleared && <p role="status" className="mt-1 text-muted-foreground" data-testid="browser-data-cleared">{t("browserWorkspace.clearData.done")}</p>}
      </fieldset>}
      {section === "downloads" && <div>{state.downloads.length === 0 && <EmptyState className="p-0" title={t("browserWorkspace.empty")} />}<ul>{state.downloads.map((download) => <li key={download.id} className="flex justify-between gap-2"><span className="truncate">{download.name}</span><span className="flex shrink-0 items-center gap-1" data-testid="browser-download-row" data-state={download.state}>{t(`browserWorkspace.download.${download.state}`)}{download.state === "blocked" ? null : <> · {Math.round(download.receivedBytes / 1024)} / {Math.round(download.totalBytes / 1024)} KB</>}
        {download.state === "completed" && <Button type="button" variant="outline" size="sm" className={ROW_BUTTON} onClick={() => void run(api.showDownload({ id: download.id }))} data-testid="browser-download-show">{t("browserWorkspace.download.show")}</Button>}
        {download.state === "progressing" && <Button type="button" variant="outline" size="sm" className={ROW_BUTTON} onClick={() => void run(api.cancelDownload({ id: download.id }))} data-testid="browser-download-cancel">{t("browserWorkspace.download.cancel")}</Button>}
      </span></li>)}</ul></div>}
      </div>
    </div>}
  </section>;
}
