# Observability Guide

Status: Implemented. Covers the audit log, plugin performance stats, LLM usage
and cost, and DLP hit statistics. Source files and tests named below are
authoritative when they disagree with this page.

All four surfaces are local: they read data under `<ave home>/` or in-process
state, and are exposed to the renderer through host-renderer-only IPC channels
declared in `src/contract/app-contract.ts`.

## Audit log

Writer: `AuditLogger` (`src/audit/audit-logger.ts`).

### Storage

JSONL under `<ave home>/audit/`, partitioned by UTC day:

| File | Content |
| --- | --- |
| `<date>.jsonl` | Telemetry channel: `AuditEntry` rows |
| `<date>.permission-audit.jsonl` | Hash-chained permission audit channel |
| `<date>.permission-shadow.jsonl` | Permission shadow channel |
| `<date>.sandbox-gate.jsonl` | Sandbox gate telemetry |

`AuditEntry.type` is one of `turn`, `tool_call`, `approval`, `warn`, `error`,
`mcp_connect`, `mcp_apikey_set`, `kill_switch`, `dlp`, `info`,
`diagnostics-export`, `plugin_hostapi_denied`. Tool-call fields are described
in [Tool Governance, section 8](../architecture/tool-governance.md#8-audit-log).

Rotation (`rotateAndPrune`): the active file rotates at 10 MB or after 7 days;
gzip archives older than 30 days are deleted. Each plain channel queues at most
1,024 pending writes or 4 MB; beyond that the channel drops telemetry rather
than blocking the caller.

### Search and stats

- `search({ dateFrom, dateTo, type, textSearch, limit = 100, offset = 0 })`:
  `dateFrom`/`dateTo` are inclusive host-local `YYYY-MM-DD` days mapped onto the
  UTC partitions they overlap; each row is kept by its own timestamp. `type` is
  an exact match; `textSearch` is a case-insensitive substring match on the
  serialized row. Results are newest first; `total` counts every match.
- `getStats(lastDays)`: `totalByType`, `totalByDay` (host-local days), and
  `sensitiveOps` (count of `approval` and `kill_switch` rows).

IPC: `ave:audit:search`, `ave:audit:stats` (`src/ipc/domains/audit.ts`).

Tests: `src/audit/__tests__/audit-search.test.ts`,
`src/audit/__tests__/audit-rotation.test.ts`,
`src/audit/__tests__/audit-logger-permission-chain.test.ts`.

## Plugin performance stats

Collector: `PerfStatsTracker` in `src/plugins/runtime/index.ts`. Stats are held
in memory and reset when the app restarts.

| Field | Meaning |
| --- | --- |
| `startupMs` | Load duration measured when the plugin is added |
| `toolCallCount` | Incremented at the start of each tool call |
| `errorCount` | Calls that failed |
| `totalExecMs` | Summed call duration |
| `lastCallAt` | Epoch milliseconds of the latest call, or `null` |

The renderer (`src/ui/renderer/tabs/PluginPerfTab.tsx`) derives average
duration (`totalExecMs / toolCallCount`) and error rate
(`errorCount / toolCallCount`, percent). Error-rate badge: below 1% normal,
1% to 5% warning, above 5% destructive.

IPC: `ave:plugins:perf-stats` returns `Record<pluginId, PluginPerfStats>`
(`src/ipc/domains/plugins.ts`).

Tests: `src/plugins/__tests__/plugin-perf-stats.test.ts`.

## LLM usage and cost

Aggregation: `src/engine/usage-stats.ts`, reading `type: "turn"` audit rows
and their token usage.

- Pricing: rates resolve through `src/shared/model-pricing.ts` (user
  correction, then the model catalog, else unknown). Corrections come from the
  `llm.pricingOverrides` setting or the `AVE_PRICING_OVERRIDE` environment
  variable, merged by `src/shared/pricing-overrides.ts`. Turns without a known
  price are counted as unknown-cost, not priced at zero.
- Summary (`computeUsageSummary`): today, this week, this month, per vendor,
  per model, a daily trend, and the top 5 conversations by cost.
- Monthly projection (`computeMonthlyProjection(trend)`): mean daily cost over
  the days present in the trend, multiplied by 30. Returns 0 for an empty
  trend.
- CSV export: `ave:usage:export-csv` opens a save dialog and writes the rows
  with headers `date, vendor, model, inputTokens, outputTokens,
  cacheReadTokens, cacheWriteTokens, totalTokens, cost, unknownCostTurns`
  (`src/ipc/domains/usage.ts`).

IPC: `ave:usage:summary`, `ave:usage:range`, `ave:usage:daily-summary`,
`ave:usage:export-csv`, `ave:usage:pricing-overrides`. Renderer:
`src/ui/renderer/components/UsageDashboard.tsx`.

Tests: `src/engine/__tests__/usage-stats.test.ts`.

## DLP hit statistics

Producer: `redactForLLM` in `src/audit/dlp-filter.ts` applies `PII_PATTERNS`
from `src/shared/dlp.ts`. When it redacts at least one match it writes:

```jsonc
{
  "timestamp": "...",
  "sessionId": "...",
  "type": "dlp",
  "dlp": { "byKind": { "EMAIL": 1 }, "totalRedactions": 1, "turnId": "..." }
}
```

The logger and a session-id getter are injected by `initDlpAudit`, called from
`src/ipc/index.ts`. Current callers of `redactForLLM` are script hook payloads
(`src/hooks/script-hook-manager.ts`) and diagnostics bundles
(`src/audit/diagnostics-bundle.ts`).

Aggregation: `getDlpStats(days = 7)` in `src/audit/dlp-stats.ts` scans audit
files from the window, keeps `type: "dlp"` rows, and returns `totalHits`,
`byKind`, `byDay`, and `topPatterns` (top 5 kinds).

IPC: `ave:dlp:stats`. Renderer: `src/ui/renderer/tabs/PrivacyTab.tsx`.

Tests: `src/audit/__tests__/dlp-stats.test.ts`,
`src/audit/__tests__/dlp-redact.test.ts`.

The executor's Step 7b masking of display and audit surfaces is a separate
path; see [Tool Governance, section 11](../architecture/tool-governance.md#11-data-loss-prevention).

## Operator checks

- Empty states: the cost view shows zero (not `NaN`) for a range with no
  entries, the DLP panel shows zero hits, and the plugin performance tab loads
  with no plugins installed.
- High DLP hit rate: inspect `topPatterns` in the privacy tab, then adjust the
  matching entry in `PII_PATTERNS` (`src/shared/dlp.ts`) and run the DLP tests
  above with `bun run test:vitest -- run src/audit`.
- Slow plugin: compare `startupMs` (load cost) against average call duration
  (call cost) in the plugin performance tab, then inspect that plugin's tool
  handlers.

## Related

- [Tool Governance](../architecture/tool-governance.md)
- [Permission Policy Design](../architecture/permission-policy-design.md)
- [Production Release Checklist](./production-release-checklist.md)
- [Vision](../vision/README.md)
