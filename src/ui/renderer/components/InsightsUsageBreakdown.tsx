import type { ReactNode } from "react";
import type { UsageSummaryShape } from "../types.js";
import { useTranslation } from "../../../i18n/react.js";
import { formatTokensExact } from "../../../lib/cost-format.js";

interface InsightsUsageBreakdownProps {
  summary: Partial<UsageSummaryShape> | null;
  monthLabel: string;
  loading?: boolean;
  error?: boolean;
}

function byTokensDesc<T extends { totalTokens?: number }>(rows: readonly T[] | undefined): T[] {
  return [...(rows ?? [])].sort((a, b) => (b.totalTokens ?? 0) - (a.totalTokens ?? 0));
}

function UsageTable({ testId, label, children }: { testId: string; label: string; children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <table data-testid={testId} className="w-full text-xs">
      <thead>
        <tr className="text-left text-muted-foreground">
          <th className="pb-1 font-medium">{label}</th>
          <th className="pb-1 text-right font-medium">{t("usageDashboard.colTokens")}</th>
        </tr>
      </thead>
      <tbody>{children}</tbody>
    </table>
  );
}

export function InsightsUsageBreakdown({
  summary,
  monthLabel,
  loading = false,
  error = false,
}: InsightsUsageBreakdownProps) {
  const { t } = useTranslation();
  const apiProviders = byTokensDesc(summary?.perVendor);
  const apiModels = byTokensDesc(summary?.perModel);
  const subscriptionProviders = byTokensDesc(summary?.subscription?.perRuntime);
  const subscriptionModels = byTokensDesc(summary?.subscription?.perModel);

  const stateMessage = loading
    ? t("usageDashboard.loading")
    : error
      ? t("usageDashboard.loadError")
      : t("usageDashboard.noData");

  return (
    <div
      data-testid="insights-monthly-usage-breakdown"
      className="mt-4 grid shrink-0 gap-4 lg:grid-cols-2"
    >
      <section
        data-testid="insights-provider-usage"
        className="min-w-0 overflow-hidden rounded-md border bg-background"
      >
        <header className="border-b px-3 py-2">
          <h3 className="text-sm font-semibold text-foreground">{t("usageDashboard.perVendor")}</h3>
          <p className="text-xs text-muted-foreground">{monthLabel}</p>
        </header>
        <div className="max-h-64 space-y-3 overflow-y-auto p-3">
          {apiProviders.length > 0 ? (
            <UsageTable testId="insights-api-provider-usage" label={t("usageDashboard.colVendor")}>
              {apiProviders.map((row) => (
                <tr key={row.vendor} className="border-t">
                  <td className="break-all py-1.5 font-mono">{row.vendor}</td>
                  <td className="py-1.5 text-right tabular-nums">{formatTokensExact(row.totalTokens)}</td>
                </tr>
              ))}
            </UsageTable>
          ) : null}

          {subscriptionProviders.length > 0 ? (
            <div className={apiProviders.length > 0 ? "border-t pt-3" : undefined}>
              <p className="mb-1 text-xs font-medium text-muted-foreground">
                {t("usageDashboard.subscriptionUsageTitle")}
              </p>
              <UsageTable testId="insights-subscription-provider-usage" label={t("usageDashboard.subscriptionRuntime")}>
                {subscriptionProviders.map((row) => (
                  <tr key={row.provider} className="border-t">
                    <td className="break-all py-1.5 font-mono">{row.provider}</td>
                    <td className="py-1.5 text-right tabular-nums">{formatTokensExact(row.totalTokens)}</td>
                  </tr>
                ))}
              </UsageTable>
            </div>
          ) : null}

          {apiProviders.length === 0 && subscriptionProviders.length === 0 ? (
            <p className="text-xs text-muted-foreground">{stateMessage}</p>
          ) : null}
        </div>
      </section>

      <section
        data-testid="insights-model-usage"
        className="min-w-0 overflow-hidden rounded-md border bg-background"
      >
        <header className="border-b px-3 py-2">
          <h3 className="text-sm font-semibold text-foreground">{t("usageDashboard.perModel")}</h3>
          <p className="text-xs text-muted-foreground">{monthLabel}</p>
        </header>
        <div className="max-h-64 space-y-3 overflow-y-auto p-3">
          {apiModels.length > 0 ? (
            <UsageTable testId="insights-api-model-usage" label={t("usageDashboard.colModel")}>
              {apiModels.map((row) => (
                <tr key={`${row.vendor}:${row.model}`} className="border-t">
                  <td className="break-all py-1.5 font-mono">
                    <span className="text-muted-foreground">{row.vendor}/</span>{row.model}
                  </td>
                  <td className="py-1.5 text-right tabular-nums">{formatTokensExact(row.totalTokens)}</td>
                </tr>
              ))}
            </UsageTable>
          ) : null}

          {subscriptionModels.length > 0 ? (
            <div className={apiModels.length > 0 ? "border-t pt-3" : undefined}>
              <p className="mb-1 text-xs font-medium text-muted-foreground">
                {t("usageDashboard.subscriptionUsageTitle")}
              </p>
              <UsageTable testId="insights-subscription-model-usage" label={t("usageDashboard.colModel")}>
                {subscriptionModels.map((row) => (
                  <tr key={`${row.provider}:${row.model}`} className="border-t">
                    <td className="break-all py-1.5 font-mono">
                      <span className="text-muted-foreground">{row.provider}/</span>{row.model}
                    </td>
                    <td className="py-1.5 text-right tabular-nums">{formatTokensExact(row.totalTokens)}</td>
                  </tr>
                ))}
              </UsageTable>
            </div>
          ) : null}

          {apiModels.length === 0 && subscriptionModels.length === 0 ? (
            <p className="text-xs text-muted-foreground">{stateMessage}</p>
          ) : null}
        </div>
      </section>
    </div>
  );
}
