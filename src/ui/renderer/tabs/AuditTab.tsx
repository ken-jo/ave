import { EmptyState } from "../../../components/ui/empty-state.js";
import React, { useCallback, useEffect, useState, useRef } from "react";
import { Badge } from "../../../components/ui/badge.js";
import { Button } from "../../../components/ui/button.js";
import { Input } from "../../../components/ui/input.js";
import { Label } from "../../../components/ui/label.js";
import { NativeSelect, NativeSelectOption } from "../../../components/ui/native-select.js";
import type { AuditEntry } from "../../../audit/audit-logger.js";
import { SettingsPageHeader, SettingsSection } from "../components/PageShell.js";
import { useTranslation } from "../../../i18n/react.js";
import { formatMediumDateTime } from "../../../shared/format-time.js";
import { localDateKey, shiftLocalDateKey } from "../../../shared/local-date.js";
import { DiagnosticsSection } from "./DiagnosticsSection.js";
import { TelemetrySection } from "./TelemetrySection.js";
import { shortSessionId } from "../../../shared/session-lookup.js";

interface AuditStats {
  totalByType: Record<string, number>;
  totalByDay: Record<string, number>;
  sensitiveOps: number;
}

interface AuditSearchResult {
  entries: AuditEntry[];
  total: number;
}

const PAGE_SIZE = 50;
const DEFAULT_RANGE_DAYS = 7;

const TYPE_BADGE: Record<string, string> = {
  // Telemetry AuditEntry types (src/audit/audit-logger.ts:85)
  turn: "bg-info/(--opacity-soft) text-info",
  tool_call: "bg-success/(--opacity-soft) text-success",
  approval: "bg-warning/(--opacity-soft) text-warning",
  warn: "bg-warning/(--opacity-soft) text-warning",
  error: "bg-destructive/(--opacity-soft) text-destructive",
  mcp_connect: "bg-emphasis/(--opacity-soft) text-emphasis",
  kill_switch: "bg-destructive/(--opacity-soft) text-destructive",
  // Permission HMAC-chain AuditCommon decisions (src/audit/audit-schema.ts:85+).
  // Rows in the permission-audit jsonl have no `type` field; the row
  // normalize step falls back to `decision`. Without these keys every
  // permission row falls through to the neutral muted badge. Color-coded so
  // allow/ask/deny are visually distinct at a glance.
  allow: "bg-success/(--opacity-soft) text-success",
  ask: "bg-warning/(--opacity-soft) text-warning",
  deny: "bg-destructive/(--opacity-soft) text-destructive",
  mode_change: "bg-emphasis/(--opacity-soft) text-emphasis",
  manifest_violation: "bg-destructive/(--opacity-soft) text-destructive",
};

export function AuditTab() {
  const { t, locale } = useTranslation();
  // The picker shows host-local civil days: "today" is the day on the person's calendar, not the UTC day the store
  // partitions by. The search side maps these keys back onto the UTC partitions.
  const [dateFrom, setDateFrom] = useState(() =>
    shiftLocalDateKey(localDateKey(new Date()), -DEFAULT_RANGE_DAYS),
  );
  const [dateTo, setDateTo] = useState(() => localDateKey(new Date()));
  const [typeFilter, setTypeFilter] = useState("");
  const [textSearch, setTextSearch] = useState("");
  const [page, setPage] = useState(0);
  const [submittedFilter, setSubmittedFilter] = useState(() => ({ dateFrom, dateTo, type: "", textSearch: "" }));
  const searchRequestId = useRef(0);

  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AuditSearchResult>({ entries: [], total: 0 });
  const [stats, setStats] = useState<AuditStats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const statsRequestId = useRef(0);
  const [expandedIdx, setExpandedIdx] = useState<number | null>(null);

  const fetchStats = useCallback(async () => {
    const id = ++statsRequestId.current;
    setStats(null);
    setStatsError(null);
    try {
      const s = await (window as unknown as { aveApi: { audit: { getStats: (d: number) => Promise<AuditStats> } } }).aveApi.audit.getStats(7);
      if (id === statsRequestId.current) setStats(s);
    } catch {
      if (id === statsRequestId.current) setStatsError(t("auditTab.statsFailed"));
    }
  }, [t]);

  const runSearch = useCallback(async (currentPage: number, filter: typeof submittedFilter) => {
    const id = ++searchRequestId.current;
    setLoading(true);
    setError(null);
    setResult({ entries: [], total: 0 });
    try {
      const res = await (window as unknown as { aveApi: { audit: { search: (f: unknown) => Promise<AuditSearchResult> } } }).aveApi.audit.search({
        dateFrom: filter.dateFrom || undefined,
        dateTo: filter.dateTo || undefined,
        type: filter.type || undefined,
        textSearch: filter.textSearch || undefined,
        limit: PAGE_SIZE,
        offset: currentPage * PAGE_SIZE,
      });
      if (id === searchRequestId.current) setResult(res);
    } catch {
      if (id === searchRequestId.current) setError(t("auditTab.searchFailed"));
    } finally {
      if (id === searchRequestId.current) setLoading(false);
    }
  }, [t]);

  useEffect(() => {
    void fetchStats();
    void runSearch(0, submittedFilter);
    return () => { searchRequestId.current++; statsRequestId.current++; };
  // The initial submitted filter is the mount snapshot; edits apply on Search.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSearch = () => {
    if (dateFrom && dateTo && dateFrom > dateTo) {
      setError(t("auditTab.invalidDateRange"));
      return;
    }
    const filter = { dateFrom, dateTo, type: typeFilter, textSearch };
    setSubmittedFilter(filter);
    setPage(0);
    setExpandedIdx(null);
    void runSearch(0, filter);
    void fetchStats();
  };

  const handlePage = (next: number) => {
    setPage(next);
    setExpandedIdx(null);
    void runSearch(next, submittedFilter);
  };

  const totalPages = Math.ceil(result.total / PAGE_SIZE);

  // Top-3 types from stats
  const top3 = stats
    ? Object.entries(stats.totalByType)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 3)
    : [];
  const maxCount = top3[0]?.[1] ?? 1;

  return (
    // No inner scroll wrapper — SettingsContent's right pane owns the single dialog scroll (always-visible gutter for G2).
    // Wrapping the tab in its own ScrollArea here would create a double scrollbar.
    <div className="pr-1">
      <div className="space-y-6">
        <SettingsPageHeader
          title={t("auditTab.pageTitle")}
          description={t("auditTab.pageDescription")}
        />

        {/* ── Stats Bar ── */}
        {statsError && <p role="alert" className="text-sm text-destructive">{statsError}</p>}
        {stats && (
          <SettingsSection data-settings-section="audit-stats" title={t("auditTab.statsTitle")}>
            <div className="flex flex-wrap gap-3">
              <div className="rounded-md border px-3 py-2 text-center">
                <p className="text-xs text-muted-foreground">{t("auditTab.statsTotalItems")}</p>
                <p className="text-lg font-semibold tabular-nums">
                  {Object.values(stats.totalByType).reduce((a, b) => a + b, 0).toLocaleString()}
                </p>
              </div>
              <div className="rounded-md border px-3 py-2 text-center">
                <p className="text-xs text-muted-foreground">{t("auditTab.statsSensitiveOps")}</p>
                <p className={`text-lg font-semibold tabular-nums ${stats.sensitiveOps > 0 ? "text-destructive" : ""}`}>
                  {stats.sensitiveOps}
                </p>
              </div>
            </div>
            {top3.length > 0 && (
              <div className="space-y-1">
                <p className="text-dense text-muted-foreground">{t("auditTab.statsTopTypes")}</p>
                {top3.map(([typeName, count]) => (
                  <div key={typeName} className="flex items-center gap-2">
                    <span className="w-20 truncate text-dense font-mono">{typeName}</span>
                    <div className="flex-1 rounded-full bg-muted h-2 overflow-hidden">
                      {/* Runtime fill ratio flows through the --progress CSS
                          variable so the bar geometry stays in classes. */}
                      <div
                        className="h-2 w-[var(--progress)] rounded-full bg-primary"
                        style={{ "--progress": `${Math.round((count / maxCount) * 100)}%` } as React.CSSProperties}
                      />
                    </div>
                    <span className="w-8 text-right text-dense tabular-nums">{count}</span>
                  </div>
                ))}
              </div>
            )}
          </SettingsSection>
        )}

        {/* ── Filters ── */}
        <SettingsSection data-settings-section="audit-filter" title={t("auditTab.filterTitle")}>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label htmlFor="audit-date-from" className="text-dense text-muted-foreground">{t("auditTab.filterDateFrom")}</Label>
              <Input
                type="date"
                className="h-8 text-xs"
                id="audit-date-from"
                data-testid="audit-date-from"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="audit-date-to" className="text-dense text-muted-foreground">{t("auditTab.filterDateTo")}</Label>
              <Input
                type="date"
                className="h-8 text-xs"
                id="audit-date-to"
                data-testid="audit-date-to"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
              />
            </div>
          </div>
          <div className="flex gap-2">
            <NativeSelect
              size="sm"
              className="w-32 flex-shrink-0"
              aria-label={t("auditTab.filterType")}
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
            >
              <NativeSelectOption value="">{t("auditTab.filterAllTypes")}</NativeSelectOption>
              <NativeSelectOption value="turn">turn</NativeSelectOption>
              <NativeSelectOption value="tool_call">tool_call</NativeSelectOption>
              <NativeSelectOption value="approval">approval</NativeSelectOption>
              <NativeSelectOption value="warn">warn</NativeSelectOption>
              <NativeSelectOption value="error">error</NativeSelectOption>
              <NativeSelectOption value="mcp_connect">mcp_connect</NativeSelectOption>
              <NativeSelectOption value="kill_switch">kill_switch</NativeSelectOption>
            </NativeSelect>
            <Input
              className="h-8 flex-1 text-xs"
              aria-label={t("auditTab.filterTextPlaceholder")}
              placeholder={t("auditTab.filterTextPlaceholder")}
              value={textSearch}
              onChange={(e) => setTextSearch(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter") handleSearch(); }}
            />
            <Button size="sm" className="h-8" onClick={handleSearch} disabled={loading}>
              {loading ? "..." : t("auditTab.searchButton")}
            </Button>
          </div>
        </SettingsSection>

        {/* ── Results ── */}
        <SettingsSection
          data-settings-section="audit-results"
          title={result.total > 0 ? t("auditTab.resultsWithCount", { count: result.total.toLocaleString() }) : t("auditTab.resultsTitle")}
          actions={
            totalPages > 1 ? (
              <div className="flex items-center gap-1 text-dense">
                <button
                  className="rounded px-1 hover:bg-muted disabled:opacity-40"
                  aria-label={t("auditTab.previousPage")}
                  disabled={loading || page === 0}
                  onClick={() => handlePage(page - 1)}
                >
                  ‹
                </button>
                <span>{page + 1} / {totalPages}</span>
                <button
                  className="rounded px-1 hover:bg-muted disabled:opacity-40"
                  aria-label={t("auditTab.nextPage")}
                  disabled={loading || page >= totalPages - 1}
                  onClick={() => handlePage(page + 1)}
                >
                  ›
                </button>
              </div>
            ) : undefined
          }
        >
          {error && (
            <div role="alert" className="rounded-md border border-destructive/(--opacity-medium) bg-destructive/(--opacity-subtle) px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}

          {!loading && result.entries.length === 0 && !error && (
            <EmptyState align="center" className="px-0 py-4" title={t("auditTab.emptyState")} />
          )}

          {result.entries.length > 0 && (
            <div className="min-w-0 overflow-x-auto rounded-md border text-xs">
              <table className="min-w-max w-full">
                <thead>
                  <tr className="border-b bg-muted/(--opacity-medium)">
                    <th className="px-3 py-2 text-left font-medium">{t("auditTab.colTimestamp")}</th>
                    <th className="px-3 py-2 text-left font-medium">{t("auditTab.colType")}</th>
                    <th className="px-3 py-2 text-left font-medium">{t("auditTab.colSourceRoute")}</th>
                    <th className="px-3 py-2 text-left font-medium">{t("auditTab.colMessage")}</th>
                  </tr>
                </thead>
                <tbody>
                  {result.entries.map((entry, i) => {
                    const isExpanded = expandedIdx === i;
                    // Normalize telemetry and permission-chain audit rows for display; keep expanded JSON unchanged.
                    const e = entry as unknown as Record<string, unknown>;
                    const ts = (e.timestamp ?? e.ts) as string | undefined;
                    const rowType = (e.type ?? e.decision ?? "—") as string;
                    const sessionPreview = typeof e.sessionId === "string" ? shortSessionId(e.sessionId as string) : undefined;
                    const routeOrTool = (e.route ?? e.tool ?? e.trustOrigin ?? sessionPreview) as string | undefined;
                    const previewRaw = (e.input ?? e.output ?? e.reason ?? "") as string;
                    const preview = typeof previewRaw === "string" ? previewRaw : String(previewRaw);
                    const badgeClass = TYPE_BADGE[rowType] ?? "bg-muted text-muted-foreground";
                    return (
                      <React.Fragment key={i}>
                        <tr
                          className="border-b last:border-0 hover:bg-muted/(--opacity-light)"
                        >
                          <td
                            className="px-3 py-1.5 font-mono text-tiny text-muted-foreground whitespace-nowrap"
                            data-testid="audit-row-time"
                          >
                            {ts === undefined ? "—" : formatMediumDateTime(ts, locale)}
                          </td>
                          <td className="px-3 py-1.5">
                            <Badge className={`text-tiny ${badgeClass}`}>{rowType}</Badge>
                          </td>
                          <td className="px-3 py-1.5 text-muted-foreground font-mono">
                            {routeOrTool ?? "—"}
                          </td>
                          <td className="max-w-[200px] truncate px-3 py-1.5 text-muted-foreground">
                            <button
                              type="button"
                              className="w-full cursor-pointer text-left underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-ring"
                              aria-expanded={isExpanded}
                              aria-controls={`audit-entry-details-${i}`}
                              aria-label={t("auditTab.toggleDetails", { number: i + 1 })}
                              onClick={() => setExpandedIdx(isExpanded ? null : i)}
                            >
                              {preview.slice(0, 80) || t("auditTab.entryDetails")}
                            </button>
                          </td>
                        </tr>
                        {isExpanded && (
                          <tr className="border-b last:border-0 bg-muted/(--opacity-muted)">
                            <td id={`audit-entry-details-${i}`} colSpan={4} className="px-3 py-2">
                              <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all rounded bg-background p-2 text-tiny">
                                {JSON.stringify(entry, null, 2)}
                              </pre>
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </SettingsSection>

        {/* ── Diagnostics: bundle export + log tail + crash list ── */}
        <DiagnosticsSection defaultDateFrom={submittedFilter.dateFrom} defaultDateTo={submittedFilter.dateTo} />

        {/* ── Telemetry: what leaves this machine, and where it goes ── */}
        <TelemetrySection />
      </div>
    </div>
  );
}
