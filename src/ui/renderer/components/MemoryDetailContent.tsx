import { useState } from "react";
import { Button } from "../../../components/ui/button.js";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../../../components/ui/tabs.js";
import { useTranslation } from "../../../i18n/react.js";
import type { MemoryDetailResult } from "../../../shared/memory-detail.js";

export type OpenMemorySession = (sessionId: string, messageId?: string) => void | boolean | Promise<void | boolean>;

type LoadedDetail = Extract<MemoryDetailResult, { ok: true }>;
type UsageVia = LoadedDetail["usage"]["entries"][number]["via"];

export function MemoryDetailContent({ detail, onOpenSession, onSameOrigin }: {
  detail: MemoryDetailResult | undefined;
  onOpenSession?: OpenMemorySession;
  onSameOrigin: (sessionId: string) => void;
}) {
  const { t } = useTranslation();
  const [via, setVia] = useState<"all" | UsageVia>("all");
  const [openFailed, setOpenFailed] = useState(false);
  const open = async (sessionId: string, messageId?: string) => {
    setOpenFailed(false);
    try {
      if (await onOpenSession?.(sessionId, messageId) === false) setOpenFailed(true);
    } catch { setOpenFailed(true); }
  };
  if (!detail) return <p role="status" className="text-xs text-muted-foreground">{t("memorySearchPanel.loading")}</p>;
  if (!detail.ok) return <p role="alert" className="text-xs text-destructive">{t("memorySearchPanel.detailFailed")}</p>;
  const origin = detail.origin;
  const usage = [...detail.usage.entries].sort((a, b) => b.at.localeCompare(a.at));
  const visibleUsage = usage.filter((row) => via === "all" || row.via === via);
  const labelVia = (value: UsageVia | "all") => {
    switch (value) {
      case "all": return t("memorySearchPanel.useAll");
      case "injected": return t("memorySearchPanel.useInjected");
      case "searched": return t("memorySearchPanel.useSearched");
      case "read": return t("memorySearchPanel.useRead");
    }
  };
  const usageRows = (rows: typeof usage) => {
    let day = "";
    return rows.map((row, index) => {
      const nextDay = new Date(row.at).toLocaleDateString();
      const heading = nextDay !== day;
      day = nextDay;
      return <li key={`${row.at}-${index}`} className="min-w-0">
        {heading && <h4 className="pt-3 pb-1 text-xs font-medium text-muted-foreground">{nextDay}</h4>}
        <button type="button" disabled={!onOpenSession} onClick={() => void open(row.sessionId, row.anchorMessageId)} className="flex w-full min-w-0 items-center gap-2 rounded-md py-2 text-left text-xs hover:bg-muted disabled:text-muted-foreground">
          <span className="min-w-0 flex-1 truncate">{row.title || t("memorySearchPanel.sessionFallbackTitle", { id: row.sessionId.slice(0, 8) })}</span>
          <span className="shrink-0 rounded border px-1">{labelVia(row.via)}</span>
          <time dateTime={row.at}>{new Date(row.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</time>
        </button>
      </li>;
    });
  };
  return <div className="min-w-0 space-y-3">
    {openFailed && <p role="alert" className="text-xs text-destructive">{t("memorySearchPanel.loadFailed")}</p>}
    <Tabs defaultValue="overview">
      <TabsList className="flex w-full flex-wrap h-auto">
        <TabsTrigger value="overview">{t("memorySearchPanel.overview")}</TabsTrigger>
        <TabsTrigger value="usage">{t("memorySearchPanel.useLog")} {usage.length}</TabsTrigger>
        <TabsTrigger value="history">{t("memorySearchPanel.history")} {detail.history.entries.length}</TabsTrigger>
      </TabsList>
      <TabsContent value="overview" className="space-y-4">
        <section className="space-y-2 text-xs" aria-label={t("memorySearchPanel.origin")}>
          <h3 className="font-semibold">{t("memorySearchPanel.origin")}</h3>
          {origin.status === "absent" ? <p className="text-muted-foreground">{t("memorySearchPanel.noOrigin")}</p>
            : origin.status === "unavailable" ? <p className="rounded-md border border-dashed p-3 text-muted-foreground">{t("memorySearchPanel.originUnavailable")}</p>
              : <>
                <div className="rounded-lg border p-3 space-y-2">
                  <p className="font-medium break-words">{origin.title || t("memorySearchPanel.sessionFallbackTitle", { id: origin.sessionId.slice(0, 8) })}</p>
                  {!origin.messageId && <p className="text-muted-foreground">{t("memorySearchPanel.noMessagePosition")}</p>}
                  {origin.quote !== undefined && <blockquote className="border-l-2 pl-2 whitespace-pre-wrap break-words">{origin.quote}</blockquote>}
                  {origin.quote !== undefined && <p className="text-muted-foreground">{t("memorySearchPanel.savedFromMessage")}</p>}
                </div>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="outline" disabled={!onOpenSession} onClick={() => void open(origin.sessionId, origin.messageId)}>{t("memorySearchPanel.viewConversation")}</Button>
                  <Button size="sm" variant="outline" onClick={() => onSameOrigin(origin.sessionId)}>{t("memorySearchPanel.sameOrigin")}</Button>
                </div>
                <p className="text-muted-foreground">{t("memorySearchPanel.liveQuote")}</p>
              </>}
        </section>
        <section className="border-t pt-3" aria-label={t("memorySearchPanel.recentUse")}>
          <h3 className="text-xs font-semibold">{t("memorySearchPanel.recentUse")}</h3>
          {usage.length ? <ul>{usageRows(usage.slice(0, 3))}</ul> : <p className="py-3 text-xs text-muted-foreground">{t("memorySearchPanel.noUse")}</p>}
        </section>
      </TabsContent>
      <TabsContent value="usage">
        <div className="flex flex-wrap gap-1" aria-label={t("memorySearchPanel.useFilter")}>
          {(["all", "injected", "searched", "read"] as const).map((value) => <button key={value} type="button" aria-pressed={via === value} className={`rounded-full border px-2 py-1 text-xs ${via === value ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`} onClick={() => setVia(value)}>{labelVia(value)} {value === "all" ? usage.length : usage.filter((row) => row.via === value).length}</button>)}
        </div>
        {visibleUsage.length ? <ul>{usageRows(visibleUsage)}</ul> : <p className="py-3 text-xs text-muted-foreground">{t("memorySearchPanel.noUse")}</p>}
        {(detail.usage.incomplete || detail.usage.limited) && <p role="status" className="text-xs text-muted-foreground">{t("memorySearchPanel.useIncomplete")}</p>}
      </TabsContent>
      <TabsContent value="history" className="space-y-3 text-xs">
        {detail.history.historyIncomplete && <p role="status" className="rounded border p-2 text-muted-foreground">{t("memorySearchPanel.historyIncomplete")}</p>}
        {detail.history.entries.length === 0 && <p className="text-muted-foreground">{t("memorySearchPanel.noHistory")}</p>}
        <ol className="space-y-4 border-l pl-3">
          {[...detail.history.entries].reverse().map((row, index) => <li key={`${row.at}-${index}`} className="space-y-1">
            <div className="flex flex-wrap justify-between gap-2"><span className="font-medium">{row.op === "created" ? t("memorySearchPanel.created") : row.op === "updated" ? t("memorySearchPanel.updated") : t("memorySaveNotice.delete")}</span><time dateTime={row.at} className="text-muted-foreground">{new Date(row.at).toLocaleString()}</time></div>
            {row.before !== undefined && <del className="block whitespace-pre-wrap break-words text-destructive">{row.before}</del>}
            {row.after !== undefined && <ins className="block whitespace-pre-wrap break-words">{row.after}</ins>}
            {row.sessionId && <button type="button" disabled={!onOpenSession} className="underline text-muted-foreground" onClick={() => void open(row.sessionId!)}>{t("memorySearchPanel.changeConversation")}</button>}
          </li>)}
        </ol>
        {detail.history.truncatedBefore && <p className="border-t pt-2 text-muted-foreground">{t("memorySearchPanel.historyTruncated", { date: new Date(detail.history.truncatedBefore).toLocaleDateString() })}</p>}
      </TabsContent>
    </Tabs>
  </div>;
}
