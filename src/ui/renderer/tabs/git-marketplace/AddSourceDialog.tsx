/**
 * Add a marketplace (design §15.5, §7.2): the address, then a preview of
 * what the repository holds, then the confirm that adds it. A repository
 * that holds one package switches to the direct-install preview. When git is
 * missing, installing it is the first, blocking step (§15.7). An address
 * that needs a warning (plain http, an internal network, this computer) is
 * asked about before Ave contacts it: *Continue* checks again carrying the
 * confirmations, and *Add* stores exactly those (§18.5).
 */
import { useEffect, useState } from "react";
import { Button } from "../../../../components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../../components/ui/dialog.js";
import { Input } from "../../../../components/ui/input.js";
import { Label } from "../../../../components/ui/label.js";
import { useTranslation } from "../../../../i18n/react.js";
import { cn } from "../../../../lib/utils.js";
import type { EnteredTargetWarningView, GitMarketplaceFailure, SourcePreviewRequest, SourcePreviewView, SourceView, SourceWarning } from "../../../../shared/git-marketplace.js";
import type { AveApi } from "../../types.js";
import { GitRuntimeCard } from "./GitRuntimeCard.js";
import { ENTRY_SUBJECT, KIND_ORDER, kindLabel, shortSha, warningText } from "./labels.js";
import { MarketplaceProblem } from "./MarketplaceProblem.js";
import { SourceBadges } from "./SourcesView.js";

type Auth = SourcePreviewRequest["auth"];

export interface AddSourceDialogProps {
  api: Pick<AveApi, "gitMarketplace" | "gitRuntime" | "updateSettings">;
  open: boolean;
  /** Install from a git folder (§8.1): the address step also asks for a folder. */
  direct?: boolean;
  /** An address from `ave://marketplace/add?url=…`, filled in for the user to check. */
  initialInput?: string;
  /** Why a deep link filled nothing in (§18.3 #7), shown when the dialog opens. */
  initialFailure?: GitMarketplaceFailure | null;
  onClose: () => void;
  /** The source was added; for a single package, the caller opens it. */
  onAdded: (source: SourceView, preview: SourcePreviewView) => void;
}

export function AddSourceDialog({ api, open, direct = false, initialInput = "", initialFailure = null, onClose, onAdded }: AddSourceDialogProps) {
  const { t } = useTranslation();
  const [gitReady, setGitReady] = useState<boolean | null>(null);
  const [input, setInput] = useState("");
  const [ref, setRef] = useState("");
  const [subdir, setSubdir] = useState("");
  const [auth, setAuth] = useState<Auth>("none");
  const [token, setToken] = useState("");
  const [preview, setPreview] = useState<SourcePreviewView | null>(null);
  const [id, setId] = useState("");
  const [failure, setFailure] = useState<GitMarketplaceFailure | null>(null);
  const [busy, setBusy] = useState(false);
  /** The warnings the last check asked about, before any connection. */
  const [warnings, setWarnings] = useState<EnteredTargetWarningView[] | null>(null);
  /** What the user confirmed for the address as typed; a changed field asks again. */
  const [acknowledged, setAcknowledged] = useState<SourceWarning[]>([]);

  /** A field edit: the confirmations were for the address as it was. */
  const edit = <T,>(set: (value: T) => void) => (value: T) => {
    set(value);
    setWarnings(null);
    setAcknowledged([]);
  };

  useEffect(() => {
    if (!open) return;
    setInput(initialInput);
    setRef("");
    setSubdir("");
    setAuth("none");
    setToken("");
    setPreview(null);
    setId("");
    setFailure(initialFailure);
    setWarnings(null);
    setAcknowledged([]);
    setGitReady(null);
    void api.gitRuntime.status().then((result) => setGitReady(result.ok && result.status.state === "ready"));
  }, [open, api, initialInput, initialFailure]);

  const check = async (acknowledge: readonly SourceWarning[] = acknowledged) => {
    setBusy(true);
    setFailure(null);
    setWarnings(null);
    try {
      const request: SourcePreviewRequest = {
        input: input.trim(),
        auth,
        ...(ref.trim() ? { ref: ref.trim() } : {}),
        ...(subdir.trim() ? { subdir: subdir.trim() } : {}),
        ...(auth === "token" && token ? { token } : {}),
        ...(acknowledge.length > 0 ? { acknowledge: [...acknowledge] } : {}),
      };
      const result = await api.gitMarketplace.previewSource(request);
      if (result.ok) {
        if (result.value.type === "confirm") {
          setWarnings(result.value.warnings);
        } else {
          setPreview(result.value);
          setId(result.value.suggestedId);
        }
      } else {
        setFailure(result);
        if (result.code === "GIT_RUNTIME_MISSING" || result.code === "GIT_RUNTIME_TOO_OLD") setGitReady(false);
      }
    } finally {
      setBusy(false);
    }
  };

  /** *Continue* on the warnings: check again carrying them. */
  const confirmWarnings = () => {
    if (!warnings) return;
    const next = [...new Set([...acknowledged, ...warnings.map((view) => view.warning)])];
    setAcknowledged(next);
    void check(next);
  };

  const add = async () => {
    if (!preview) return;
    setBusy(true);
    setFailure(null);
    try {
      const result = await api.gitMarketplace.addSource({ previewId: preview.previewId, ...(id.trim() ? { id: id.trim() } : {}) });
      if (result.ok) onAdded(result.value, preview);
      else setFailure(result);
    } finally {
      setBusy(false);
    }
  };

  const step = gitReady === false ? 0 : preview ? 2 : 1;
  const title = direct ? t("gitMarketplace.add.directTitle") : t("gitMarketplace.add.title");

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-w-lg" data-testid="git-marketplace:add">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            <span className="flex gap-2 text-xs" aria-label={t("gitMarketplace.add.stepsLabel")}>
              {gitReady === false && <span className={cn(step === 0 && "font-semibold text-foreground")}>{t("gitMarketplace.add.stepGit")}</span>}
              <span className={cn(step === 1 && "font-semibold text-foreground")}>{t("gitMarketplace.add.stepAddress")}</span>
              <span aria-hidden="true">›</span>
              <span className={cn(step === 2 && "font-semibold text-foreground")}>{t("gitMarketplace.add.stepReview")}</span>
            </span>
          </DialogDescription>
        </DialogHeader>

        {step === 0 && <GitRuntimeCard api={api} compact onReady={() => setGitReady(true)} />}

        {step === 1 && (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="git-marketplace-add-url">{t("gitMarketplace.add.address")}</Label>
              <Input
                id="git-marketplace-add-url"
                value={input}
                onChange={(event) => edit(setInput)(event.target.value)}
                placeholder={t("gitMarketplace.add.addressPlaceholder")}
                data-testid="git-marketplace:add:url"
                autoFocus
              />
            </div>
            {direct && (
              <div className="space-y-1">
                <Label htmlFor="git-marketplace-add-subdir">{t("gitMarketplace.add.folder")}</Label>
                <Input id="git-marketplace-add-subdir" className="font-mono" value={subdir} onChange={(event) => edit(setSubdir)(event.target.value)} placeholder="skills/proofread" />
              </div>
            )}
            <div className="space-y-1">
              <Label htmlFor="git-marketplace-add-ref">{t("gitMarketplace.add.ref")}</Label>
              <Input id="git-marketplace-add-ref" className="font-mono" value={ref} onChange={(event) => edit(setRef)(event.target.value)} placeholder="main" />
            </div>
            <fieldset className="space-y-1">
              <legend className="text-sm font-medium">{t("gitMarketplace.add.signIn")}</legend>
              <div className="flex gap-3 text-sm">
                {(["none", "token", "ssh"] as const).map((value) => (
                  <label key={value} className="flex items-center gap-1.5">
                    <input type="radio" name="git-marketplace-auth" checked={auth === value} onChange={() => edit(setAuth)(value)} data-testid={`git-marketplace:add:auth:${value}`} />
                    {value === "none" ? t("gitMarketplace.add.authNone") : value === "token" ? t("gitMarketplace.add.authToken") : t("gitMarketplace.add.authSsh")}
                  </label>
                ))}
              </div>
              {auth === "token" && (
                <Input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder={t("gitMarketplace.add.tokenPlaceholder")} data-testid="git-marketplace:add:token" />
              )}
            </fieldset>
            {warnings && (
              <MarketplaceProblem
                tone="warning"
                title={t("gitMarketplace.warning.title")}
                text={warnings.map((view) => warningText(t, view))}
                onContinue={confirmWarnings}
                onCancel={() => {
                  setWarnings(null);
                  setAcknowledged([]);
                }}
                testId="git-marketplace:add:warnings"
              />
            )}
          </div>
        )}

        {step === 2 && preview && (
          <div className="space-y-3 text-sm" data-testid="git-marketplace:add:preview">
            {preview.type === "marketplace" ? (
              <>
                <p>
                  <span className="font-medium">{preview.marketplace.displayName}</span>
                  {preview.marketplace.owner && <span className="text-muted-foreground"> · {t("gitMarketplace.add.owner", { owner: preview.marketplace.owner })}</span>}
                </p>
                <p className="text-xs text-muted-foreground">
                  {t("gitMarketplace.add.commit", { commit: shortSha(preview.commit) })}
                  {preview.ref ? ` · ${preview.ref}` : ""}
                </p>
                <ul className="flex flex-wrap gap-1.5 text-xs">
                  {KIND_ORDER.filter((kind) => (preview.counts[kind] ?? 0) > 0).map((kind) => (
                    <li key={kind} className="rounded-md border px-2 py-0.5">
                      {preview.counts[kind]} {kindLabel(t, kind)}
                    </li>
                  ))}
                </ul>
                {preview.codeRunning > 0 && (
                  <p className="rounded-md border border-warning/(--opacity-medium) bg-warning/(--opacity-soft) px-3 py-2 text-xs text-warning">
                    {t("gitMarketplace.add.codeRunning", { count: preview.codeRunning })}
                  </p>
                )}
                {preview.diagnostics.map((line) => (
                  <p key={line} className="text-xs text-muted-foreground">{t("gitMarketplace.add.skipped", { detail: line })}</p>
                ))}
              </>
            ) : (
              <>
                <p>
                  {t("gitMarketplace.direct.detected", { kind: kindLabel(t, preview.kind), file: preview.detectedFrom })} ·{" "}
                  <span className="font-medium">{preview.displayName ?? preview.name}</span>
                </p>
                <p className="font-mono text-xs">{preview.version}</p>
                {preview.versionSynthesized && <p className="text-xs text-muted-foreground">{t("gitMarketplace.direct.synthesized")}</p>}
                <p className="text-xs">{preview.runsCode ? t("gitMarketplace.direct.runsCode") : t("gitMarketplace.direct.noCode")}</p>
              </>
            )}
            {preview.badges.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                <SourceBadges badges={preview.badges} testId="git-marketplace:add:badge" />
              </div>
            )}
            {preview.credentialHelper && <p className="text-xs text-muted-foreground">{t("gitMarketplace.add.credentialHelper")}</p>}
            <div className="space-y-1">
              <Label htmlFor="git-marketplace-add-id">{t("gitMarketplace.add.sourceName")}</Label>
              <Input id="git-marketplace-add-id" className="font-mono" value={id} onChange={(event) => setId(event.target.value)} data-testid="git-marketplace:add:id" />
              <p className="text-[11px] text-muted-foreground">{t("gitMarketplace.add.sourceNameHelp")}</p>
            </div>
          </div>
        )}

        {failure && <MarketplaceProblem failure={failure} subject={ENTRY_SUBJECT} testId="git-marketplace:add:error" />}

        <DialogFooter className="gap-2">
          {step === 2 && (
            <Button variant="outline" onClick={() => setPreview(null)} disabled={busy}>
              {t("gitMarketplace.back")}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>{t("common.cancel")}</Button>
          {step === 1 && (
            <Button onClick={() => void check()} disabled={busy || warnings !== null || input.trim().length === 0 || gitReady === null} data-testid="git-marketplace:add:check">
              {busy ? t("gitMarketplace.add.checking") : t("gitMarketplace.add.check")}
            </Button>
          )}
          {step === 2 && preview && (
            <Button onClick={() => void add()} disabled={busy} data-testid="git-marketplace:add:confirm">
              {preview.type === "marketplace" ? t("gitMarketplace.add.confirm") : t("gitMarketplace.direct.confirm", { kind: kindLabel(t, preview.kind) })}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
