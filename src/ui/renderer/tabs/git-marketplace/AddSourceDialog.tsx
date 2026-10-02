/**
 * Add a marketplace (design §15.5, §7.2): the address, then a preview of
 * what the repository holds, then the confirm that adds it. A repository
 * that holds one package switches to the direct-install preview. When git is
 * missing, installing it is the first, blocking step (§15.7). An address
 * that needs a warning (plain http, an internal network, this computer) is
 * asked about before Ave contacts it: *Continue* checks again carrying the
 * confirmations, and *Add* stores exactly those (§18.5).
 *
 * The address can be a folder (§18.4, §7.7): typed, or chosen with *Choose
 * folder…* (main's folder dialog). A folder takes no branch, package folder
 * or sign-in, so the form stops asking for them, and it needs no git, so a
 * missing git does not block it. The preview names the folder Ave will
 * read, the path it was resolved from when a link led there, its contents
 * revision, and when its changes are picked up; a folder on another computer
 * is asked about first, like an address.
 */
import { useEffect, useRef, useState } from "react";
import { Button } from "../../../../components/ui/button.js";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "../../../../components/ui/dialog.js";
import { Input } from "../../../../components/ui/input.js";
import { Label } from "../../../../components/ui/label.js";
import { useTranslation } from "../../../../i18n/react.js";
import { cn } from "../../../../lib/utils.js";
import { reservedPrefixIn } from "../../../../shared/dlp.js";
import type { EnteredTargetWarningView, FolderPickView, GitMarketplaceFailure, SourcePreviewAsk, SourcePreviewRequest, SourcePreviewView, SourceView, SourceWarning } from "../../../../shared/git-marketplace.js";
import type { AveApi } from "../../types.js";
import { GitRuntimeCard } from "./GitRuntimeCard.js";
import { ENTRY_SUBJECT, KIND_ORDER, kindLabel, looksLikeFolder, reservedIdText, shortSha, warningText } from "./labels.js";
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
  /**
   * A source was added, whether or not this dialog still shows the request that added it (it may
   * have been closed, or reopened for another address since): the caller refreshes what lists sources.
   */
  onCommitted: (source: SourceView) => void;
  /** The add this dialog shows finished: the caller closes the dialog and, for a single package, opens it. */
  onAdded: (source: SourceView, preview: SourcePreviewView) => void;
  /** *Show <id>* on an add refused for duplicating source `id` (§18.8): the caller closes the dialog and shows that row. */
  onShowSource: (id: string) => void;
}

export function AddSourceDialog({ api, open, direct = false, initialInput = "", initialFailure = null, onClose, onCommitted, onAdded, onShowSource }: AddSourceDialogProps) {
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
  /** The folder dialog could not open: main's text, for Copy details. */
  const [pickFailure, setPickFailure] = useState<string | null>(null);
  /**
   * The folder *Choose folder…* chose, while the address still shows it: main holds the path and the
   * field shows it scrubbed, so a check sends the pick, never the shown text (§18.9). Typing drops it.
   */
  const [picked, setPicked] = useState<FolderPickView | null>(null);
  /** A folder takes no branch, package folder or sign-in, and needs no git (§18.4.1). */
  const folder = looksLikeFolder(input);

  /**
   * Which fields an answer belongs to. A field edit, a newer check and reopening the
   * dialog each move it on, so an answer to an earlier check (a warning, a preview, a
   * failure) arriving late is dropped: a warning is only ever shown, and confirmed, for
   * the address as it is now.
   */
  const generation = useRef(0);

  /** A field edit: the confirmations, and any answer still on its way, were for the address as it was. */
  const edit = <T,>(set: (value: T) => void) => (value: T) => {
    generation.current += 1;
    set(value);
    setWarnings(null);
    setAcknowledged([]);
    setBusy(false);
  };

  useEffect(() => {
    // Opening or closing starts over: a request still on its way belongs to the dialog as it was,
    // so it can no longer clear `busy`, and nothing it started may keep the new dialog waiting.
    generation.current += 1;
    setBusy(false);
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
    setPickFailure(null);
    setPicked(null);
    setGitReady(null);
    void api.gitRuntime.status().then((result) => setGitReady(result.ok && result.status.state === "ready"));
  }, [open, api, initialInput, initialFailure]);

  const check = async (acknowledge: readonly SourceWarning[] = acknowledged, address: string = input, chosen: FolderPickView | null = picked) => {
    const mine = ++generation.current;
    setBusy(true);
    setFailure(null);
    setPickFailure(null);
    setWarnings(null);
    try {
      // A folder is sent without the fields the form hides for it: they would only be refused.
      // A chosen folder goes by its pick: the address field holds only its scrubbed display.
      const confirmed = acknowledge.length > 0 ? { acknowledge: [...acknowledge] } : {};
      const request: SourcePreviewAsk = chosen !== null && address === chosen.display
        ? { pick: chosen.pick, auth: "none", ...confirmed }
        : looksLikeFolder(address)
        ? { input: address.trim(), auth: "none", ...confirmed }
        : {
            input: address.trim(),
            auth,
            ...(ref.trim() ? { ref: ref.trim() } : {}),
            ...(subdir.trim() ? { subdir: subdir.trim() } : {}),
            ...(auth === "token" && token ? { token } : {}),
            ...(acknowledge.length > 0 ? { acknowledge: [...acknowledge] } : {}),
          };
      const result = await api.gitMarketplace.previewSource(request);
      if (mine !== generation.current) return;
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
      if (mine === generation.current) setBusy(false);
    }
  };

  /**
   * *Choose folder…*: main's folder dialog. The chosen folder's display
   * replaces the address and is checked at once by its pick (main reads the
   * folder it chose); a cancel changes nothing.
   */
  const chooseFolder = async () => {
    const mine = generation.current;
    setPickFailure(null);
    const answer = await api.gitMarketplace.pickFolder();
    if (mine !== generation.current) return;
    if (!answer.ok) {
      setPickFailure(answer.message);
      return;
    }
    if (answer.value === null) return;
    const chosen = answer.value;
    edit(setInput)(chosen.display);
    setPicked(chosen);
    void check([], chosen.display, chosen);
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
    const mine = generation.current;
    setBusy(true);
    setFailure(null);
    try {
      const result = await api.gitMarketplace.addSource({ previewId: preview.previewId, ...(id.trim() ? { id: id.trim() } : {}) });
      // The add happened either way, so the lists refresh; closing the dialog and opening the package
      // belong to the dialog that asked, as a failure does. A reopened dialog is another request.
      if (result.ok) onCommitted(result.value);
      if (mine !== generation.current) return;
      if (result.ok) onAdded(result.value, preview);
      else setFailure(result);
    } finally {
      if (mine === generation.current) setBusy(false);
    }
  };

  // Git is the first step only for a git address: a folder is read without it (§18.4.3).
  const step = gitReady === false && !folder && !preview ? 0 : preview ? 2 : 1;
  // An id using a reserved prefix (§18.8) is named as it is typed, with what to do, before Add is asked.
  const reservedId = reservedPrefixIn(id.trim());
  const chooseFolderButton = (
    <Button type="button" variant="outline" className="shrink-0" onClick={() => void chooseFolder()} disabled={busy} data-testid="git-marketplace:add:choose-folder">
      {t("gitMarketplace.add.chooseFolder")}
    </Button>
  );
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

        {step === 0 && (
          <div className="space-y-3">
            <GitRuntimeCard api={api} compact onReady={() => setGitReady(true)} />
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border px-3 py-2 text-xs" data-testid="git-marketplace:add:folder-without-git">
              <span className="min-w-0 text-muted-foreground">{t("gitMarketplace.add.folderWithoutGit")}</span>
              {chooseFolderButton}
            </div>
          </div>
        )}

        {step === 1 && (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="git-marketplace-add-url">{t("gitMarketplace.add.address")}</Label>
              <div className="flex gap-2">
                <Input
                  id="git-marketplace-add-url"
                  className="min-w-0"
                  value={input}
                  onChange={(event) => {
                    edit(setInput)(event.target.value);
                    setPicked(null);
                  }}
                  placeholder={t("gitMarketplace.add.addressPlaceholder")}
                  data-testid="git-marketplace:add:url"
                  autoFocus
                />
                {chooseFolderButton}
              </div>
              {folder && <p className="text-[11px] text-muted-foreground" data-testid="git-marketplace:add:folder-input">{t("gitMarketplace.add.folderInput")}</p>}
            </div>
            {direct && !folder && (
              <div className="space-y-1">
                <Label htmlFor="git-marketplace-add-subdir">{t("gitMarketplace.add.folder")}</Label>
                <Input id="git-marketplace-add-subdir" className="font-mono" value={subdir} onChange={(event) => edit(setSubdir)(event.target.value)} placeholder="skills/proofread" />
              </div>
            )}
            {!folder && (
            <div className="space-y-1">
              <Label htmlFor="git-marketplace-add-ref">{t("gitMarketplace.add.ref")}</Label>
              <Input id="git-marketplace-add-ref" className="font-mono" value={ref} onChange={(event) => edit(setRef)(event.target.value)} placeholder="main" />
            </div>
            )}
            {!folder && (
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
            )}
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

        {pickFailure !== null && (
          <MarketplaceProblem tone="error" text={t("gitMarketplace.add.pickFolderFailed")} details={pickFailure} testId="git-marketplace:add:pick-error" />
        )}

        {step === 2 && preview && (
          <div className="space-y-3 text-sm" data-testid="git-marketplace:add:preview">
            {preview.transport === "folder" && preview.path !== null && (
              <div className="space-y-1" data-testid="git-marketplace:add:folder">
                <p className="break-all font-mono text-xs">{t("gitMarketplace.add.folderPath", { path: preview.path })}</p>
                {preview.resolvedFrom !== null && (
                  <p className="break-all text-xs text-muted-foreground" data-testid="git-marketplace:add:resolved-from">{t("gitMarketplace.add.resolvedFrom", { input: preview.resolvedFrom })}</p>
                )}
              </div>
            )}
            {preview.type === "marketplace" ? (
              <>
                <p>
                  <span className="font-medium">{preview.marketplace.displayName}</span>
                  {preview.marketplace.owner && <span className="text-muted-foreground"> · {t("gitMarketplace.add.owner", { owner: preview.marketplace.owner })}</span>}
                </p>
                <p className="text-xs text-muted-foreground">
                  {preview.transport === "folder"
                    ? t("gitMarketplace.add.folderContents", { revision: shortSha(preview.commit) })
                    : t("gitMarketplace.add.commit", { commit: shortSha(preview.commit) })}
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
                {preview.versionSynthesized && (
                  <p className="text-xs text-muted-foreground">
                    {preview.transport === "folder" ? t("gitMarketplace.direct.synthesizedFolder") : t("gitMarketplace.direct.synthesized")}
                  </p>
                )}
                <p className="text-xs">{preview.runsCode ? t("gitMarketplace.direct.runsCode") : t("gitMarketplace.direct.noCode")}</p>
              </>
            )}
            {preview.badges.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                <SourceBadges badges={preview.badges} testId="git-marketplace:add:badge" />
              </div>
            )}
            {preview.transport === "folder" && <p className="text-xs text-muted-foreground" data-testid="git-marketplace:add:folder-pickup">{t("gitMarketplace.add.folderPickup")}</p>}
            {preview.credentialHelper && <p className="text-xs text-muted-foreground">{t("gitMarketplace.add.credentialHelper")}</p>}
            <div className="space-y-1">
              <Label htmlFor="git-marketplace-add-id">{t("gitMarketplace.add.sourceName")}</Label>
              <Input
                id="git-marketplace-add-id"
                className="font-mono"
                value={id}
                onChange={(event) => setId(event.target.value)}
                aria-invalid={reservedId !== null}
                aria-describedby={reservedId ? "git-marketplace-add-id-reserved" : undefined}
                data-testid="git-marketplace:add:id"
              />
              {reservedId ? (
                <p id="git-marketplace-add-id-reserved" className="text-[11px] text-destructive" role="alert" data-testid="git-marketplace:add:id-reserved">
                  {reservedIdText(t, reservedId)}
                </p>
              ) : (
                <p className="text-[11px] text-muted-foreground">{t("gitMarketplace.add.sourceNameHelp")}</p>
              )}
            </div>
          </div>
        )}

        {failure && <MarketplaceProblem failure={failure} subject={ENTRY_SUBJECT} onShowSource={onShowSource} testId="git-marketplace:add:error" />}

        <DialogFooter className="gap-2">
          {step === 2 && (
            <Button variant="outline" onClick={() => setPreview(null)} disabled={busy}>
              {t("gitMarketplace.back")}
            </Button>
          )}
          <Button variant="ghost" onClick={onClose}>{t("common.cancel")}</Button>
          {step === 1 && (
            <Button onClick={() => void check()} disabled={busy || warnings !== null || input.trim().length === 0 || (gitReady === null && !folder)} data-testid="git-marketplace:add:check">
              {busy ? t("gitMarketplace.add.checking") : t("gitMarketplace.add.check")}
            </Button>
          )}
          {step === 2 && preview && (
            <Button onClick={() => void add()} disabled={busy || reservedId !== null} data-testid="git-marketplace:add:confirm">
              {preview.type === "marketplace" ? t("gitMarketplace.add.confirm") : t("gitMarketplace.direct.confirm", { kind: kindLabel(t, preview.kind) })}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
