/** Nothing is installed before review, including pasted MCP configuration and direct package folders. */
import { useState } from "react";
import { Button } from "../../../../components/ui/button.js";
import { Textarea } from "../../../../components/ui/textarea.js";
import { useTranslation } from "../../../../i18n/react.js";
import { cn } from "../../../../lib/utils.js";
import { scrubDiagnosticSecrets } from "../../../../shared/dlp.js";
import type { DirectMcpPreviewView, GitMarketplaceFailure } from "../../../../shared/git-marketplace.js";
import type { AveApi } from "../../types.js";
import { ENTRY_SUBJECT, importActionLabel, importFailureText } from "./labels.js";
import { MarketplaceProblem } from "./MarketplaceProblem.js";
import { McpRuntimeSummary } from "./McpRuntimeSummary.js";

type Mode = "git" | "mcp" | "server-json" | "import";

type ImportPreview = Awaited<ReturnType<AveApi["previewClaudeDesktopMcpImport"]>>;
type ImportApply = Awaited<ReturnType<AveApi["applyClaudeDesktopMcpImport"]>>;

export interface DirectInstallViewProps {
  api: Pick<AveApi, "gitMarketplace" | "previewClaudeDesktopMcpImport" | "applyClaudeDesktopMcpImport">;
  onGitAddress: () => void;
  onOpenMcpSettings: () => void;
  onInstalled: () => void;
}

export function DirectInstallView({ api, onGitAddress, onOpenMcpSettings, onInstalled }: DirectInstallViewProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<Mode>("git");
  const [serverJson, setServerJson] = useState("");
  const [select, setSelect] = useState<{ package?: number; remote?: number }>({});
  const [preview, setPreview] = useState<DirectMcpPreviewView | null>(null);
  const [failure, setFailure] = useState<GitMarketplaceFailure | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [config, setConfig] = useState("");
  const [importPreview, setImportPreview] = useState<ImportPreview | null>(null);
  const [importResult, setImportResult] = useState<ImportApply | null>(null);

  const reviewServerJson = async (choice = select) => {
    setBusy(true);
    setFailure(null);
    setDone(null);
    try {
      const result = await api.gitMarketplace.previewDirectMcp({ serverJson, ...(choice.package !== undefined || choice.remote !== undefined ? { select: choice } : {}) });
      if (result.ok) setPreview(result.value);
      else {
        setPreview(null);
        setFailure(result);
      }
    } finally {
      setBusy(false);
    }
  };

  const connect = async () => {
    if (!preview) return;
    setBusy(true);
    try {
      const result = await api.gitMarketplace.executeInstall(preview.planId);
      if (result.ok) {
        setDone(
          result.value.connectionWarning
            ? `${t("gitMarketplace.install.done", { name: preview.name, version: preview.version })} ${t("gitMarketplace.install.notConnected", { message: scrubDiagnosticSecrets(result.value.connectionWarning) })}`
            : t("gitMarketplace.direct.connected", { name: preview.name }),
        );
        setPreview(null);
        setServerJson("");
        onInstalled();
      } else {
        // The install took the plan even though it failed; Review again plans afresh.
        setPreview(null);
        setFailure(result);
      }
    } finally {
      setBusy(false);
    }
  };

  const tabs: Array<{ mode: Mode; label: string }> = [
    { mode: "git", label: t("gitMarketplace.direct.tabGit") },
    { mode: "mcp", label: t("gitMarketplace.direct.tabMcp") },
    { mode: "server-json", label: t("gitMarketplace.direct.tabServerJson") },
    { mode: "import", label: t("gitMarketplace.direct.tabImport") },
  ];

  return (
    <div className="space-y-3" data-testid="git-marketplace:direct">
      <p className="text-xs text-muted-foreground">{t("gitMarketplace.direct.description")}</p>
      <div role="tablist" className="flex flex-wrap gap-1 border-b">
        {tabs.map((tab) => (
          <button
            key={tab.mode}
            type="button"
            role="tab"
            aria-selected={mode === tab.mode}
            onClick={() => {
              setMode(tab.mode);
              setFailure(null);
              setDone(null);
            }}
            className={cn("-mb-px border-b-2 px-3 py-1.5 text-sm", mode === tab.mode ? "border-primary font-medium" : "border-transparent text-muted-foreground hover:text-foreground")}
            data-testid={`git-marketplace:direct:tab:${tab.mode}`}
          >
            {tab.label}
          </button>
        ))}
      </div>

      {mode === "git" && (
        <div className="space-y-2 text-sm">
          <p className="text-muted-foreground">{t("gitMarketplace.direct.gitHelp")}</p>
          <Button size="sm" onClick={onGitAddress} data-testid="git-marketplace:direct:git">{t("gitMarketplace.direct.gitOpen")}</Button>
        </div>
      )}

      {mode === "mcp" && (
        <div className="space-y-2 text-sm">
          <p className="text-muted-foreground">{t("gitMarketplace.direct.mcpHelp")}</p>
          <Button size="sm" variant="outline" onClick={onOpenMcpSettings}>{t("gitMarketplace.direct.mcpOpen")}</Button>
        </div>
      )}

      {mode === "server-json" && (
        <div className="space-y-2">
          <Textarea
            value={serverJson}
            onChange={(event) => {
              setServerJson(event.target.value);
              // A package or remote picked in the previous document does not carry over to this one.
              setSelect({});
              setPreview(null);
            }}
            className="min-h-40 font-mono text-xs"
            aria-label="server.json"
            placeholder='{ "name": "io.github.example/weather", "version": "0.5.0", "packages": [ … ] }'
            data-testid="git-marketplace:direct:server-json"
          />
          {!preview && (
            <Button size="sm" disabled={busy || serverJson.trim().length === 0} onClick={() => void reviewServerJson()}>
              {t("gitMarketplace.direct.review")}
            </Button>
          )}
          {preview && (
            <div className="space-y-2 rounded-md border p-3 text-sm" data-testid="git-marketplace:direct:server-json:preview">
              <p>
                <span className="font-medium">{preview.name}</span> <span className="font-mono text-xs">{preview.version}</span>
              </p>
              <McpRuntimeSummary runtime={preview.runtime} />
              {preview.options.packages + preview.options.remotes > 1 && (
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  <span className="text-muted-foreground">{t("gitMarketplace.direct.otherOptions", { packages: preview.options.packages, remotes: preview.options.remotes })}</span>
                  {Array.from({ length: preview.options.packages }, (_, index) => (
                    <Button key={`p${index}`} size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={() => { const next = { package: index }; setSelect(next); void reviewServerJson(next); }}>
                      {t("gitMarketplace.direct.usePackage", { index: index + 1 })}
                    </Button>
                  ))}
                  {Array.from({ length: preview.options.remotes }, (_, index) => (
                    <Button key={`r${index}`} size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={() => { const next = { remote: index }; setSelect(next); void reviewServerJson(next); }}>
                      {t("gitMarketplace.direct.useRemote", { index: index + 1 })}
                    </Button>
                  ))}
                </div>
              )}
              <p className="text-xs text-muted-foreground">{t("gitMarketplace.direct.unbound")}</p>
              <Button size="sm" disabled={busy} onClick={() => void connect()} data-testid="git-marketplace:direct:connect">
                {t("gitMarketplace.direct.connect")}
              </Button>
            </div>
          )}
        </div>
      )}

      {mode === "import" && (
        <div className="space-y-2">
          <p className="text-xs text-muted-foreground">{t("gitMarketplace.direct.importHelp")}</p>
          <Textarea
            value={config}
            onChange={(event) => {
              setConfig(event.target.value);
              setImportPreview(null);
              setImportResult(null);
            }}
            className="min-h-32 font-mono text-xs"
            aria-label={t("gitMarketplace.direct.tabImport")}
            placeholder='{ "mcpServers": { … } }'
          />
          {!importPreview && (
            <Button size="sm" disabled={busy || config.trim().length === 0} onClick={() => void api.previewClaudeDesktopMcpImport(config).then(setImportPreview)}>
              {t("gitMarketplace.direct.importPreview")}
            </Button>
          )}
          {importPreview && (
            <div className="space-y-2 rounded-md border p-3 text-xs">
              {importPreview.entries.map((entry) => (
                <div key={entry.id}>
                  <span className="font-mono font-medium">{entry.id}</span>{" "}
                  <span className="break-all font-mono text-muted-foreground">
                    {entry.config.transport === "stdio" ? [entry.config.command, ...(entry.config.args ?? [])].join(" ") : entry.config.url}
                  </span>
                  {entry.warning && <span className="block text-warning">{entry.warning}</span>}
                </div>
              ))}
              {importPreview.errors.map((error) => (
                <p key={error.id} className="text-destructive">{error.id}: {scrubDiagnosticSecrets(error.reason)}</p>
              ))}
              {importPreview.entries.length > 0 && !importResult && (
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => void api.applyClaudeDesktopMcpImport({ raw: config, conflictPolicy: "skip" }).then((result) => {
                    setImportResult(result);
                    if (result.ok) onInstalled();
                  })}
                >
                  {t("gitMarketplace.direct.importApply", { count: importPreview.entries.length })}
                </Button>
              )}
              {importResult && (importResult.ok
                ? importResult.results.map((row) => row.action === "failed"
                  ? <MarketplaceProblem key={row.id} tone="error" text={importFailureText(t, row.id, row.failure)} details={row.reason} testId={`git-marketplace:direct:import:${row.id}`} />
                  : (
                    <p key={row.id} data-testid={`git-marketplace:direct:import:${row.id}`}>
                      {row.id}: {importActionLabel(t, row.action)}
                      {row.reason ? ` — ${t("gitMarketplace.install.notConnected", { message: scrubDiagnosticSecrets(row.reason) })}` : ""}
                    </p>
                  ))
                : <MarketplaceProblem tone="error" text={t("gitMarketplace.direct.importFailed")} details={importResult.error} testId="git-marketplace:direct:import-error" />)}
            </div>
          )}
        </div>
      )}

      {failure && <MarketplaceProblem failure={failure} subject={ENTRY_SUBJECT} />}
      {done && <p className="text-sm text-success" data-testid="git-marketplace:direct:done">{done}</p>}
    </div>
  );
}
