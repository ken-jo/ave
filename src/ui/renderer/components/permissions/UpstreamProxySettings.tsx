/**
 * Settings → Permissions → OS Tool Sandbox: where the sandbox egress proxy
 * sends allowed connections next (owner decision 2026-10-20). Off, Use
 * system settings (environment variables, else the OS proxy settings with
 * PAC) or a manual URL with a bypass list; the trusted "resolves names"
 * opt-in for a proxy on this computer; and a read-only line with the
 * effective upstream for https://example.com.
 *
 * The setting is main-owned: it is read and written only through the
 * permissions upstreamProxyGet / upstreamProxySet channels, and credential
 * values never come back to this page (only whether some are stored).
 * Changes apply to new connections at once: the route hook reads the live
 * setting and its cache is cleared on every write.
 */
import { useCallback, useEffect, useState, type ReactElement } from "react";
import { Button } from "../../../../components/ui/button.js";
import { Checkbox } from "../../../../components/ui/checkbox.js";
import { Input } from "../../../../components/ui/input.js";
import { Label } from "../../../../components/ui/label.js";
import { RadioGroup, RadioGroupItem } from "../../../../components/ui/radio-group.js";
import { useTranslation } from "../../../../i18n/react.js";
import { errorMessage } from "../../../../shared/error-message.js";
import type {
  UpstreamProxyDiagnostic,
  UpstreamProxyMode,
  UpstreamProxyPatch,
  UpstreamProxyRouteView,
  UpstreamProxyView,
} from "../../../../shared/upstream-proxy.js";
import { formatIpcError } from "../../format-ipc-error.js";
import { isIpcErrorResult } from "../../types.js";

interface UpstreamProxySettingsProps {
  /** Override reader for tests. Defaults to window.ave.permission.upstreamProxyGet. */
  readonly reader?: () => Promise<unknown>;
  /** Override writer for tests. Defaults to window.ave.permission.upstreamProxySet. */
  readonly writer?: (patch: UpstreamProxyPatch) => Promise<unknown>;
}

function isView(value: unknown): value is UpstreamProxyView {
  return value !== null && typeof value === "object"
    && typeof (value as { settings?: unknown }).settings === "object"
    && typeof (value as { diagnostic?: unknown }).diagnostic === "object";
}

function failureOf(result: unknown): string | undefined {
  if (isIpcErrorResult(result)) return formatIpcError(result.error, result.message);
  if (result !== null && typeof result === "object" && (result as { ok?: unknown }).ok === false) {
    const failed = result as { error?: unknown; message?: unknown };
    return formatIpcError(
      typeof failed.error === "string" ? failed.error : undefined,
      typeof failed.message === "string" ? failed.message : undefined,
    );
  }
  return undefined;
}

const MODES: ReadonlyArray<{ mode: UpstreamProxyMode; label: string; hint: string }> = [
  { mode: "off", label: "upstreamProxySettings.modeOff", hint: "upstreamProxySettings.modeOffHint" },
  { mode: "system", label: "upstreamProxySettings.modeSystem", hint: "upstreamProxySettings.modeSystemHint" },
  { mode: "manual", label: "upstreamProxySettings.modeManual", hint: "upstreamProxySettings.modeManualHint" },
];

export function UpstreamProxySettings({ reader, writer }: UpstreamProxySettingsProps): ReactElement {
  const { t: translate } = useTranslation();
  const [view, setView] = useState<UpstreamProxyView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // The mode shown; "manual" can be chosen before a URL is saved for it.
  const [mode, setMode] = useState<UpstreamProxyMode>("system");
  const [manualUrl, setManualUrl] = useState("");
  const [bypass, setBypass] = useState("");

  const adopt = useCallback((next: UpstreamProxyView) => {
    setView(next);
    setMode(next.settings.mode);
    setManualUrl(next.settings.manualUrl);
    setBypass(next.settings.bypass);
  }, []);

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await (reader ?? (() => window.ave!.permission!.upstreamProxyGet()))();
      const failed = failureOf(result);
      if (failed !== undefined) setError(translate("upstreamProxySettings.loadFailed", { message: failed }));
      else if (isView(result)) adopt(result);
      else setError(translate("upstreamProxySettings.loadFailed", { message: "unexpected answer" }));
    } catch (err) {
      setError(translate("upstreamProxySettings.loadFailed", { message: errorMessage(err) }));
    }
  }, [reader, translate, adopt]);

  const save = useCallback(async (patch: UpstreamProxyPatch, successNotice?: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const result = await (writer ?? ((p: UpstreamProxyPatch) => window.ave!.permission!.upstreamProxySet(p)))(patch);
      const failed = failureOf(result);
      if (failed !== undefined) {
        setError(translate("upstreamProxySettings.saveFailed", { message: failed }));
        // Show what is actually stored again.
        if (view) setMode(view.settings.mode);
        return;
      }
      const next = (result as { view?: unknown }).view;
      if (isView(next)) adopt(next);
      // Credentials bound to the previous proxy are removed by main; say so
      // whatever was saved, so the person is not surprised by a 407 later.
      if ((result as { credentialsRemoved?: unknown }).credentialsRemoved === true) {
        setNotice(translate("upstreamProxySettings.credentialsRemoved"));
      } else if (successNotice !== undefined) {
        setNotice(successNotice);
      }
    } catch (err) {
      setError(translate("upstreamProxySettings.saveFailed", { message: errorMessage(err) }));
    } finally {
      setBusy(false);
    }
  }, [writer, translate, adopt, view]);

  useEffect(() => { void load(); }, [load]);

  const onModeChange = (value: string): void => {
    const next = value as UpstreamProxyMode;
    setMode(next);
    setNotice(null);
    // Manual waits for its URL and the Save button unless one is stored.
    if (next === "manual" && (view?.settings.manualUrl ?? "") === "") return;
    void save({ mode: next });
  };

  const settings = view?.settings;
  return (
    <div className="mt-3 space-y-3 border-t pt-3" data-testid="upstream-proxy-settings">
      <div className="space-y-0.5">
        <p className="text-sm font-medium">{translate("upstreamProxySettings.title")}</p>
        <p className="text-[11px] text-muted-foreground">{translate("upstreamProxySettings.description")}</p>
      </div>
      <RadioGroup
        value={mode}
        onValueChange={onModeChange}
        aria-label={translate("upstreamProxySettings.modeAriaLabel")}
        className="gap-2"
        disabled={busy || view === null}
      >
        {MODES.map((entry) => (
          <div key={entry.mode} className="flex items-start gap-3">
            <RadioGroupItem
              value={entry.mode}
              id={`upstream-proxy-mode-${entry.mode}`}
              data-testid={`upstream-proxy-mode-${entry.mode}`}
              className="mt-0.5"
            />
            <Label htmlFor={`upstream-proxy-mode-${entry.mode}`} className="cursor-pointer flex-col items-start gap-0.5">
              <div className="text-sm">{translate(entry.label)}</div>
              <div className="text-[11px] font-normal text-muted-foreground">{translate(entry.hint)}</div>
            </Label>
          </div>
        ))}
      </RadioGroup>
      {mode === "manual" ? (
        <form
          className="space-y-2 pl-7"
          data-testid="upstream-proxy-manual"
          onSubmit={(event) => {
            event.preventDefault();
            void save({ mode: "manual", manualUrl, bypass }, translate("upstreamProxySettings.saved"));
          }}
        >
          <div className="space-y-1">
            <Label htmlFor="upstream-proxy-url" className="text-[12px]">{translate("upstreamProxySettings.urlLabel")}</Label>
            <Input
              id="upstream-proxy-url"
              data-testid="upstream-proxy-url"
              className="h-8 font-mono text-[12px]"
              value={manualUrl}
              autoComplete="off"
              spellCheck={false}
              placeholder={translate("upstreamProxySettings.urlPlaceholder")}
              onChange={(event) => setManualUrl(event.target.value)}
            />
            <p className="text-[11px] text-muted-foreground">{translate("upstreamProxySettings.urlHint")}</p>
          </div>
          <div className="space-y-1">
            <Label htmlFor="upstream-proxy-bypass" className="text-[12px]">{translate("upstreamProxySettings.bypassLabel")}</Label>
            <Input
              id="upstream-proxy-bypass"
              data-testid="upstream-proxy-bypass"
              className="h-8 font-mono text-[12px]"
              value={bypass}
              autoComplete="off"
              spellCheck={false}
              placeholder={translate("upstreamProxySettings.bypassPlaceholder")}
              onChange={(event) => setBypass(event.target.value)}
            />
            <p className="text-[11px] text-muted-foreground">{translate("upstreamProxySettings.bypassHint")}</p>
          </div>
          {view?.hasCredentials ? (
            <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground" data-testid="upstream-proxy-credentials">
              <span>{translate("upstreamProxySettings.credentialsStored")}</span>
              <Button
                type="button"
                size="sm"
                variant="outline"
                className="h-7 px-2 text-[12px]"
                disabled={busy}
                data-testid="upstream-proxy-clear-credentials"
                onClick={() => void save({ clearCredentials: true })}
              >
                {translate("upstreamProxySettings.clearCredentials")}
              </Button>
            </div>
          ) : null}
          <Button type="submit" size="sm" className="h-7 px-3 text-[12px]" disabled={busy} data-testid="upstream-proxy-save">
            {translate("upstreamProxySettings.save")}
          </Button>
        </form>
      ) : null}
      <div className="flex items-start gap-3">
        <Checkbox
          checked={settings?.resolvesNames ?? false}
          data-testid="upstream-proxy-resolves-names"
          aria-label={translate("upstreamProxySettings.resolvesNamesLabel")}
          disabled={busy || view === null}
          className="mt-0.5 size-5"
          onCheckedChange={(checked) => void save({ resolvesNames: checked === true })}
        />
        <div className="min-w-0 space-y-0.5">
          <p className="text-sm">{translate("upstreamProxySettings.resolvesNamesLabel")}</p>
          <p className="text-[11px] text-muted-foreground">{translate("upstreamProxySettings.resolvesNamesHint")}</p>
        </div>
      </div>
      <p className="text-[11px] text-muted-foreground">{translate("upstreamProxySettings.authNote")}</p>
      {error !== null ? (
        <p role="alert" className="text-[11px] text-destructive" data-testid="upstream-proxy-error">{error}</p>
      ) : null}
      {notice !== null ? (
        <p role="status" className="text-[11px] text-muted-foreground" data-testid="upstream-proxy-notice">{notice}</p>
      ) : null}
      <EffectiveUpstream diagnostic={view?.diagnostic ?? null} />
    </div>
  );
}

function routeText(route: UpstreamProxyRouteView, translate: (key: string, params?: Record<string, string>) => string): string {
  const base = route.kind === "direct"
    ? translate("upstreamProxySettings.routeDirect")
    : translate(route.kind === "https" ? "upstreamProxySettings.routeHttpsProxy" : "upstreamProxySettings.routeProxy", { endpoint: route.endpoint ?? "" });
  return route.credentials ? translate("upstreamProxySettings.routeCredentials", { route: base }) : base;
}

function sourceText(diagnostic: UpstreamProxyDiagnostic, translate: (key: string, params?: Record<string, string>) => string): string {
  switch (diagnostic.source) {
    case "off": return translate("upstreamProxySettings.sourceOff");
    case "manual": return translate("upstreamProxySettings.sourceManual");
    case "manual-bypass": return translate("upstreamProxySettings.sourceManualBypass");
    case "environment":
      return diagnostic.envVar !== undefined
        ? translate("upstreamProxySettings.sourceEnvironment", { envVar: diagnostic.envVar })
        : translate("upstreamProxySettings.sourceEnvironmentNone");
    case "environment-bypass": return translate("upstreamProxySettings.sourceEnvironmentBypass");
    case "system": return translate("upstreamProxySettings.sourceSystem");
    case "system-unavailable": return translate("upstreamProxySettings.sourceSystemUnavailable");
  }
}

function EffectiveUpstream({ diagnostic }: { diagnostic: UpstreamProxyDiagnostic | null }): ReactElement {
  const { t: translate } = useTranslation();
  return (
    <div className="space-y-0.5 rounded-md border bg-muted/(--opacity-light) px-3 py-2 text-[11px] text-muted-foreground" data-testid="upstream-proxy-effective">
      <p className="font-medium text-foreground">
        {translate("upstreamProxySettings.effectiveHeading", { url: diagnostic?.url ?? "https://example.com/" })}
      </p>
      {diagnostic === null ? (
        <p>{translate("upstreamProxySettings.effectiveLoading")}</p>
      ) : (
        <>
          {diagnostic.routes.length > 0 ? (
            <p className="break-all font-mono text-foreground" data-testid="upstream-proxy-effective-routes">
              {diagnostic.routes.map((route) => routeText(route, translate)).join("; ")}
            </p>
          ) : null}
          <p data-testid="upstream-proxy-effective-source">{sourceText(diagnostic, translate)}</p>
          {diagnostic.skipped.length > 0 ? (
            <p className="break-words">{translate("upstreamProxySettings.skipped", { entries: diagnostic.skipped.join(", ") })}</p>
          ) : null}
          {diagnostic.refusal !== undefined ? (
            <p className="text-warning" data-testid="upstream-proxy-effective-refusal">
              {translate("upstreamProxySettings.refusal", { reason: diagnostic.refusal })}
            </p>
          ) : null}
        </>
      )}
    </div>
  );
}
