# Observability Guide

The host exposes application logs, plugin performance, and saved-session usage
through local diagnostics and renderer IPC.

## Application logs

The application logger (`src/lib/logger.ts`) emits structured permission,
approval, reviewer, hook, sandbox, and DLP events. Tool calls use process-local
keyed correlation IDs. DLP events report counts while enforcement continues on
the original input path.

Packaged and production hosts write ordinary logs under <ave home>/logs.
Development file logging is opt-in. Files roll after a completed write reaches
10 MiB, with up to 20 per date and a 200 MiB total cap. Retention defaults to
seven days and is set
through diagnostics.logRetentionDays (1–365 days). Settings → Diagnostics
exposes the live log tail and consent-gated, redacted support bundles.

Logging is best-effort. One file writer preserves order across rolls. Bounded
destination buffers can drop records under backpressure. When delivery resumes
or shutdown flushes the destinations, `app_log_loss` reports counts for each
destination. Shutdown waits up to 500 ms and counts records since the last
confirmed drain as unconfirmed on a stalled destination. The diagnostic itself
is best-effort. Permission outcomes, approval binding, and shutdown status are
independent of log delivery.

Historical audit files are left in place and ignored.

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

Aggregation: `src/engine/usage-stats.ts`, reading saved assistant turn summaries.

- Pricing: each request records its price when it is served
  (`src/shared/model-pricing.ts`: a user correction, the endpoint's own report
  or the model catalog, decided by the address the request was sent to; else
  unknown with a reason). Corrections come from the `llm.pricingOverrides`
  setting or the `AVE_PRICING_OVERRIDE` environment variable, merged by
  `src/shared/pricing-overrides.ts`, and apply to new requests. Requests
  without a recorded price are counted as unknown-cost, not priced at zero.
- Summary (`computeUsageSummary`): today, this week, this month, per vendor,
  per model, a daily trend, the top 5 conversations by priced spend and the
  top 5 by tokens. `auditIncomplete` flags partial coverage from the available saved summaries; its costs are shown as unknown.
- Monthly projection (`computeMonthlyProjection(trend)`): mean daily cost over
  the days present in the trend, multiplied by 30. Returns 0 for an empty
  trend and `undefined` when any day has an unknown-cost request.
- CSV export: `ave:usage:export-csv` opens a save dialog and writes the rows
  with headers `date, vendor, model, inputTokens, outputTokens,
  cacheReadTokens, cacheWriteTokens, totalTokens, cost, unknownCostTurns,
  endpointPriceUnavailableTurns, legacyRouteUnrecordedTurns, auditIncomplete`
  (`src/ipc/domains/usage.ts`). `cost` is blank on an incomplete row.

IPC: `ave:usage:summary`, `ave:usage:range`, `ave:usage:daily-summary`,
`ave:usage:export-csv`, `ave:usage:pricing-overrides`. Renderer:
`src/ui/renderer/components/UsageDashboard.tsx`.

Tests: `src/engine/__tests__/usage-stats.test.ts`.

## Remote reporting

Local app logging is independent of the remote reporting consent in
Settings → Diagnostics. `telemetry.level` is Off, Crash, Error or All; new profiles
start at Off. Crash allows native crash dumps, Error adds extension load-failure
reports, and All adds app usage and extension installation/removal events.

App events use `telemetry.endpoint` and contain event names, numeric metrics,
app version and a hashed session ID. Extension reports use the marketplace
service document's same-origin telemetry destination and contain the extension
ID, version, a persistent random device ID and, for failures, a bounded host
error category. Their payload excludes diagnostic messages, conversation content
and API keys. Clearing the app endpoint does not disable that separate extension
destination; choose Off to stop all remote reporting.

Native dumps use `telemetry.crashReportEndpoint` and can include unmasked
process memory. Both editable destinations require HTTPS and an operator-allowed
host from `AVE_TELEMETRY_ALLOWLIST`; credentials and fragments are refused.
Packaged builds exclude localhost from the enforced and displayed allowlist.
Off cancels active event uploads and disables native uploads immediately.
Changing a native destination takes effect on the next launch. Local dumps
remain available regardless of the level.

Migration retains an existing crash opt-out. The panel explains that exception
and requires an explicit level confirmation before enabling crash uploads.
Consent policy: `src/shared/telemetry-policy.ts`. Regression coverage:
`src/shared/__tests__/telemetry-policy.test.ts`,
`src/main/__tests__/release-prep.test.ts`,
`src/__tests__/telemetry-client.test.ts` and
`test/e2e/ui/telemetry-settings-surface.spec.ts`.

## Operator checks

- Empty states: the usage view identifies partial coverage and the plugin
  performance tab loads with no plugins installed.
- Slow plugin: compare `startupMs` (load cost) against average call duration
  (call cost) in the plugin performance tab, then inspect that plugin's tool
  handlers.

## Related

- [Tool Governance](../architecture/tool-governance.md)
- [Permission Policy Design](../architecture/permission-policy-design.md)
- [Production Release Checklist](./production-release-checklist.md)
- [Vision](../vision/README.md)
