import { useEffect, useRef, useState } from "react";
import { Button } from "../../../../components/ui/button.js";
import { Input } from "../../../../components/ui/input.js";
import { Label } from "../../../../components/ui/label.js";
import { useTranslation } from "../../../../i18n/react.js";
import {
  MAX_PERMISSION_JUDGE_STAGES,
  DEFAULT_PERMISSION_JUDGE_MODE,
  DEFAULT_PERMISSION_JUDGE_CATEGORIES,
  serializePermissionJudgeSettingsPatch,
  type PermissionJudgeSettings,
  type PermissionJudgeSnapshot,
} from "../../../../shared/permission-judge-settings.js";
import { SettingsSection } from "../PageShell.js";
import { useNotifySaved } from "../../context/SavedToastContext.js";
import { PERMISSION_JUDGE_CACHE_KEY, useSettingsControls, useSettingsEditor } from "../../context/SettingsEditorContext.js";
import {
  SystemSubagentModelSelect,
} from "../../tabs/LlmTab.js";

type JudgeStage = PermissionJudgeSettings["chain"][number];
type JudgeTransport = "builtin-llm" | "command" | "url";

const SELECT_CLASS = "h-9 w-full rounded-md border border-input bg-background px-3 text-sm";
const TEXTAREA_CLASS = "min-h-20 w-full rounded-md border border-input bg-background px-3 py-2 text-sm";

function nextStage(chain: readonly JudgeStage[]): JudgeStage {
  let number = 1;
  while (chain.some((stage) => stage.id === `stage-${number}`)) number++;
  return { id: `stage-${number}`, provider: "builtin-llm" };
}


function transportFor(stage: JudgeStage): JudgeTransport {
  return stage.provider === "builtin-llm" ? "builtin-llm" : stage.external?.url !== undefined ? "url" : "command";
}

export function PermissionJudgeContent({ reviewerModeInvalid = false }: { reviewerModeInvalid?: boolean }) {
  const { t } = useTranslation();
  const notifySaved = useNotifySaved();
  const [snapshot, setSnapshot] = useState<PermissionJudgeSnapshot | null>(null);
  const [draft, setDraft] = useState<PermissionJudgeSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [savingChain, setSavingChain] = useState(false);
  const [pendingPatch, setPendingPatch] = useState<Partial<PermissionJudgeSettings> | null>(null);
  const busyRef = useRef(false);
  const draftRef = useRef<PermissionJudgeSettings | null>(null);
  const requestRevisionRef = useRef(0);
  const [error, setError] = useState<"read" | "invalid" | "keyboard" | "save" | "rewire" | "rollback" | null>(null);
  const [saved, setSaved] = useState(false);
  const [readAttempt, setReadAttempt] = useState(0);
  const [externalChange, setExternalChange] = useState(false);
  const dirtyRef = useRef(false);
  const editRevisionRef = useRef(0);
  // The first read may take the judge answer the settings view already holds; a retry or a change event asks again.
  const editorCache = useSettingsEditor()?.cache;

  useEffect(() => {
    if (busyRef.current) return;
    let cancelled = false;
    const initialRevision = editRevisionRef.current;
    const requestRevision = ++requestRevisionRef.current;
    void (async () => {
      try {
        const api = window.ave?.permission;
        if (!api?.judgeGet) throw new Error("Judge settings unavailable");
        const read = () => api.judgeGet();
        const result = editorCache ? await editorCache.load(PERMISSION_JUDGE_CACHE_KEY, read, { fresh: readAttempt > 0 }) : await read();
        if (cancelled || requestRevision !== requestRevisionRef.current) return;
        if (!result.ok) {
          setError("read");
          return;
        }
        if (initialRevision !== editRevisionRef.current) {
          setExternalChange(true);
          return;
        }
        setSnapshot(result);
        draftRef.current = result.settings;
        setDraft(result.settings);
        setError(null);
        setExternalChange(false);
      } catch {
        if (!cancelled && requestRevision === requestRevisionRef.current) setError("read");
      }
    })();
    return () => { cancelled = true; };
  }, [editorCache, readAttempt]);

  useEffect(() => window.ave?.permission?.onConfigChanged?.(() => {
    if (busyRef.current) return;
    if (dirtyRef.current) setExternalChange(true);
    else setReadAttempt((attempt) => attempt + 1);
  }), []);

  function reload() {
    dirtyRef.current = false;
    setError(null);
    setSaved(false);
    setExternalChange(false);
    setReadAttempt((attempt) => attempt + 1);
  }

  function update(settings: PermissionJudgeSettings) {
    if (!snapshot) return;
    dirtyRef.current = chainChanged(settings.chain, snapshot.settings.chain);
    editRevisionRef.current++;
    draftRef.current = settings;
    setDraft(settings);
    setError(null);
    setSaved(false);
  }

  function updateStage(index: number, stage: JudgeStage) {
    if (draft) update({ ...draft, chain: draft.chain.map((existing, at) => at === index ? stage : existing) });
  }

  function moveStage(index: number, direction: -1 | 1) {
    if (!draft) return;
    const chain = [...draft.chain];
    [chain[index], chain[index + direction]] = [chain[index + direction]!, chain[index]!];
    update({ ...draft, chain });
  }

  function chainChanged(chain: JudgeStage[], savedChain: JudgeStage[]): boolean {
    return JSON.stringify(serializePermissionJudgeSettingsPatch({ chain })) !== JSON.stringify(serializePermissionJudgeSettingsPatch({ chain: savedChain }));
  }

  async function persist(patch: Partial<PermissionJudgeSettings>, chainSave = false): Promise<boolean> {
    if (!snapshot || busyRef.current) return false;
    const wire = (settings: Partial<PermissionJudgeSettings>) => JSON.stringify(serializePermissionJudgeSettingsPatch(settings));
    const changed = Object.fromEntries((Object.keys(patch) as Array<keyof PermissionJudgeSettings>)
      .filter((key) => (key === "chain" && snapshot.storedChainRejected) || wire({ [key]: patch[key] }) !== wire({ [key]: snapshot.settings[key] }))
      .map((key) => [key, patch[key]])) as Partial<PermissionJudgeSettings>;
    if (Object.keys(changed).length === 0) return true;
    busyRef.current = true;
    const requestRevision = ++requestRevisionRef.current;
    const submittedEditRevision = editRevisionRef.current;
    setBusy(true);
    setSavingChain(chainSave);
    setPendingPatch(changed);
    setError(null);
    setSaved(false);
    try {
      // The invocation happens in this user handler, before any await, so main can check its gesture.
      const request = window.ave.permission.judgeSet(changed);
      const result = await request;
      if (requestRevision !== requestRevisionRef.current) return false;
      if (!result.ok) {
        setError(result.error === "invalid-judge-settings" ? "invalid"
          : result.error === "user-keyboard-required" ? "keyboard"
          : result.error === "judge-rewire-failed" ? "rewire"
          : result.error === "judge-rollback-failed" ? "rollback" : "save");
        return false;
      }
      const preserveChain = dirtyRef.current && (!chainSave || submittedEditRevision !== editRevisionRef.current);
      const next = preserveChain && draftRef.current
        ? { ...result.settings, chain: draftRef.current.chain }
        : result.settings;
      draftRef.current = next;
      dirtyRef.current = chainChanged(next.chain, result.settings.chain);
      setSnapshot(result);
      setDraft(next);
      setExternalChange(false);
      setSaved(chainSave);
      if (!chainSave) notifySaved();
      return true;
    } catch {
      if (requestRevision === requestRevisionRef.current) setError("save");
      return false;
    } finally {
      if (requestRevision === requestRevisionRef.current) {
        setPendingPatch(null);
        setBusy(false);
        setSavingChain(false);
      }
      busyRef.current = false;
    }
  }

  function save() {
    if (!draft || !dirtyRef.current) return;
    const chain = draft.chain.map((stage) => stage.external?.command ? {
      ...stage,
      external: {
        ...stage.external,
        command: [stage.external.command[0] ?? "", ...stage.external.command.slice(1).filter((arg) => arg.length > 0)],
        ...(stage.external.env ? { env: stage.external.env.filter(Boolean) } : {}),
      },
    } : stage);
    void persist({ chain, ...(chain.length === 0 ? { mode: DEFAULT_PERMISSION_JUDGE_MODE } : {}) }, true);
  }

  function handleModeChange(mode: string) {
    if (!snapshot || reviewerModeInvalid) return;
    if (mode === "off") void persist({ chain: [], mode: DEFAULT_PERMISSION_JUDGE_MODE });
    else if (mode === "shadow" || mode === "active") {
      // Enabling an empty chain creates the standard stage, never an unsaved editor draft.
      void persist({ mode, ...(snapshot.settings.chain.length === 0 ? { chain: [nextStage([])] } : {}) });
    }
  }

  useSettingsControls(snapshot ? [
    { id: "permissions.judge.model", section: "permissions-judge", label: t("permissionJudge.reviewerModel"), modified: snapshot.settings.model !== null,
      disabledReason: busy ? t("permissionJudge.saving") : undefined,
      reset: async () => { if (!await persist({ model: null })) throw new Error("Reviewer model reset failed"); } },
    { id: "permissions.judge.mode", section: "permissions-judge", label: t("permissionJudge.mode"), modified: snapshot.settings.mode !== DEFAULT_PERMISSION_JUDGE_MODE,
      disabledReason: reviewerModeInvalid ? t("permissionJudge.modeChoiceRequired") : busy ? t("permissionJudge.saving") : undefined,
      reset: async () => { if (!await persist({ mode: DEFAULT_PERMISSION_JUDGE_MODE })) throw new Error("Evaluator mode reset failed"); } },
    { id: "permissions.judge.categories", section: "permissions-judge", label: t("permissionJudge.categories"), modified: Object.entries(DEFAULT_PERMISSION_JUDGE_CATEGORIES).some(([category, value]) => snapshot.settings.categories[category as keyof typeof DEFAULT_PERMISSION_JUDGE_CATEGORIES] !== value),
      disabledReason: busy ? t("permissionJudge.saving") : undefined,
      reset: async () => { if (!await persist({ categories: { ...DEFAULT_PERMISSION_JUDGE_CATEGORIES } })) throw new Error("Evaluator categories reset failed"); } },
    { id: "permissions.judge.chain", section: "permissions-judge", label: t("permissionJudge.chainSetting"), modified: snapshot.storedChainRejected || snapshot.settings.chain.length > 0 || dirtyRef.current,
      disabledReason: busy ? t("permissionJudge.saving") : undefined,
      reset: async () => {
        if (!snapshot.storedChainRejected && snapshot.settings.chain.length === 0) {
          draftRef.current = snapshot.settings; setDraft(snapshot.settings); dirtyRef.current = false; setSaved(false); return;
        }
        if (!await persist({ chain: [], mode: DEFAULT_PERMISSION_JUDGE_MODE }, true)) throw new Error("Evaluator chain reset failed");
      } },
  ] : []);

  const controls = snapshot ? { ...snapshot.settings, ...pendingPatch } : null;

  const errorText = error === "read" ? t("permissionJudge.readFailed")
    : error === "invalid" ? t("permissionJudge.invalidSettings")
    : error === "keyboard" ? t("permissionJudge.keyboardRequired")
    : error === "rewire" ? t("permissionJudge.rewireFailed")
    : error === "rollback" ? t("permissionJudge.rollbackFailed")
    : error === "save" ? t("permissionJudge.saveFailed") : null;

  return (
    <SettingsSection data-settings-section="permissions-judge" title={t("permissionJudge.title")} description={t("permissionJudge.description")}>
      {errorText && <p role={error === "read" ? "status" : "alert"} className="text-sm text-destructive">{errorText}</p>}
      {error === "read" && <Button type="button" variant="outline" onClick={reload}>{t("permissionJudge.retry")}</Button>}
      {!draft && !error && <p role="status" className="text-sm text-muted-foreground">{t("permissionJudge.loading")}</p>}
      {snapshot?.storedChainRejected === true && (
        <p role="alert" data-testid="permission-judge-chain-rejected" className="text-sm text-destructive">
          {t("permissionJudge.storedChainRejected")}
        </p>
      )}
      {snapshot && snapshot.issues.length > 0 && (
        <p role="status" className="text-sm text-warning">{t("permissionJudge.warnings", { count: snapshot.issues.length })}</p>
      )}
      {externalChange && (
        <div className="space-y-2">
          <p role="status" className="text-sm text-warning">{t("permissionJudge.externalChange")}</p>
          <Button type="button" variant="outline" disabled={busy} onClick={reload}>{t("permissionJudge.reload")}</Button>
        </div>
      )}
      {draft && controls && snapshot && (
        <form onSubmit={(event) => { event.preventDefault(); void save(); }} className="space-y-4">
          <fieldset disabled={busy && savingChain} className="space-y-4">
            <div className="space-y-1.5" data-setting-id="permissions.judge.model">
              <Label htmlFor="permission-reviewer-model">{t("permissionJudge.reviewerModel")}</Label>
              <SystemSubagentModelSelect
                id="permission-reviewer-model"
                snapshot={snapshot}
                value={controls.model ?? undefined}
                disabled={busy}
                unsetLabel={snapshot?.chatModel
                  ? t("permissionJudge.followChatModelNamed", { model: snapshot.chatModel })
                  : t("permissionJudge.followChatModel")}
                placeholder={t("permissionJudge.followChatModel")}
                unavailableLabel={t("permissionJudge.modelUnavailableFacts")}
                onChange={(model) => void persist({ model: model ?? null })}
              />
              <p className="text-xs text-muted-foreground">{t("permissionJudge.reviewerModelHelp")}</p>
              {snapshot?.reviewerModelUnavailable === true && !(pendingPatch && "model" in pendingPatch) && (
                <p role="alert" data-testid="permission-reviewer-model-unavailable" className="text-sm text-destructive">
                  {t("permissionJudge.reviewerModelUnavailable")}
                </p>
              )}
            </div>
            <div className="space-y-1.5" data-setting-id="permissions.judge.mode">
              <Label htmlFor="permission-judge-mode">{t("permissionJudge.mode")}</Label>
              <select
                id="permission-judge-mode"
                className={SELECT_CLASS}
                disabled={reviewerModeInvalid || busy}
                aria-describedby={reviewerModeInvalid ? "reviewer-mode-fault" : undefined}
                value={reviewerModeInvalid ? "" : controls.chain.length === 0 ? "off" : controls.mode}
                onChange={(event) => handleModeChange(event.target.value)}
              >
                {reviewerModeInvalid && <option value="" disabled>{t("permissionJudge.modeChoiceRequired")}</option>}
                <option value="off">{t("permissionJudge.off")}</option>
                <option value="shadow">{t("permissionJudge.shadow")}</option>
                <option value="active">{t("permissionJudge.active")}</option>
              </select>
              <p className="text-xs text-muted-foreground">{t("permissionJudge.modeHelp")}</p>
            </div>
            {draft.chain.length > 0 && (
              <>
                <fieldset className="flex flex-wrap gap-4" data-setting-id="permissions.judge.categories">
                  <legend className="mb-2 text-sm font-medium">{t("permissionJudge.categories")}</legend>
                  {(["shell", "write", "network"] as const).map((category) => (
                    <Label key={category} className="flex items-center gap-2">
                      <input type="checkbox" checked={controls.categories[category]} disabled={busy} onChange={(event) => void persist({ categories: { ...snapshot.settings.categories, [category]: event.target.checked } })} />
                      {category === "shell" ? t("permissionJudge.shell") : category === "write" ? t("permissionJudge.write") : t("permissionJudge.network")}
                    </Label>
                  ))}
                </fieldset>
                <p className="text-xs text-muted-foreground">{t("permissionJudge.chainHelp")}</p>
                <ol className="space-y-3" data-setting-id="permissions.judge.chain">
                  {draft.chain.map((stage, index) => {
                    const transport = transportFor(stage);
                    const prefix = `permission-judge-stage-${index}`;
                    return (
                      <li key={index} className="space-y-3 rounded-md border p-3" aria-label={t("permissionJudge.stage", { number: index + 1 })}>
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="text-sm font-medium">{t("permissionJudge.stage", { number: index + 1 })}</span>
                          <div className="flex gap-2">
                            <Button type="button" variant="outline" size="sm" disabled={index === 0} onClick={() => moveStage(index, -1)} aria-label={t("permissionJudge.moveUpStage", { number: index + 1 })}>{t("permissionJudge.moveUp")}</Button>
                            <Button type="button" variant="outline" size="sm" disabled={index === draft.chain.length - 1} onClick={() => moveStage(index, 1)} aria-label={t("permissionJudge.moveDownStage", { number: index + 1 })}>{t("permissionJudge.moveDown")}</Button>
                            <Button type="button" variant="outline" size="sm" onClick={() => update({ ...draft, chain: draft.chain.filter((_, at) => at !== index), ...(draft.chain.length === 1 ? { mode: "shadow" as const } : {}) })} aria-label={t("permissionJudge.removeStage", { number: index + 1 })}>{t("permissionJudge.remove")}</Button>
                          </div>
                        </div>
                        <div className="grid gap-3 sm:grid-cols-2">
                          <div className="space-y-1.5">
                            <Label htmlFor={`${prefix}-id`}>{t("permissionJudge.stageId")}</Label>
                            <Input id={`${prefix}-id`} value={stage.id} required maxLength={32} pattern="[A-Za-z0-9][A-Za-z0-9_-]*" onChange={(event) => updateStage(index, { ...stage, id: event.target.value })} />
                          </div>
                          <div className="space-y-1.5">
                            <Label htmlFor={`${prefix}-provider`}>{t("permissionJudge.provider")}</Label>
                            <select id={`${prefix}-provider`} className={SELECT_CLASS} value={transport} onChange={(event) => {
                              const value = event.target.value;
                              updateStage(index, value === "builtin-llm" ? { id: stage.id, provider: "builtin-llm" } : { id: stage.id, provider: "external", external: value === "url" ? { url: "" } : { command: [""] } });
                            }}>
                              <option value="builtin-llm">{t("permissionJudge.builtin")}</option>
                              <option value="command">{t("permissionJudge.command")}</option>
                              <option value="url">{t("permissionJudge.url")}</option>
                            </select>
                          </div>
                        </div>
                        {transport === "builtin-llm" ? (
                          <div className="space-y-1.5">
                            <Label htmlFor={`${prefix}-model`}>{t("permissionJudge.model")}</Label>
                            <SystemSubagentModelSelect
                              id={`${prefix}-model`}
                              snapshot={snapshot}
                              value={stage.model}
                              unsetLabel={t("permissionJudge.currentReviewer")}
                              placeholder={t("permissionJudge.currentReviewer")}
                              unavailableLabel={t("permissionJudge.modelUnavailableFacts")}
                              onChange={(model) => {
                                const { model: _previousModel, ...rest } = stage;
                                updateStage(index, model ? { ...rest, model } : rest);
                              }}
                            />
                          </div>
                        ) : (
                          <>
                            {transport === "command" ? (
                              <>
                                <div className="space-y-1.5">
                                  <Label htmlFor={`${prefix}-executable`}>{t("permissionJudge.executable")}</Label>
                                  <Input id={`${prefix}-executable`} value={stage.external?.command?.[0] ?? ""} required onChange={(event) => updateStage(index, { ...stage, external: { ...stage.external, command: [event.target.value, ...(stage.external?.command?.slice(1) ?? [])] } })} />
                                </div>
                                <div className="space-y-1.5">
                                  <Label htmlFor={`${prefix}-args`}>{t("permissionJudge.arguments")}</Label>
                                  <textarea id={`${prefix}-args`} className={TEXTAREA_CLASS} value={stage.external?.command?.slice(1).join("\n") ?? ""} onChange={(event) => updateStage(index, { ...stage, external: { ...stage.external, command: [stage.external?.command?.[0] ?? "", ...(event.target.value === "" ? [] : event.target.value.split("\n"))] } })} />
                                </div>
                                <div className="space-y-1.5">
                                  <Label htmlFor={`${prefix}-env`}>{t("permissionJudge.environment")}</Label>
                                  <Input id={`${prefix}-env`} value={stage.external?.env?.join(", ") ?? ""} onChange={(event) => updateStage(index, { ...stage, external: { ...stage.external, env: event.target.value.split(",").map((name) => name.trim()) } })} />
                                </div>
                              </>
                            ) : (
                              <div className="space-y-1.5">
                                <Label htmlFor={`${prefix}-url`}>{t("permissionJudge.endpoint")}</Label>
                                <Input id={`${prefix}-url`} type="url" required value={stage.external?.url ?? ""} onChange={(event) => updateStage(index, { ...stage, external: { url: event.target.value } })} />
                              </div>
                            )}
                            <div className="space-y-1.5">
                              <Label htmlFor={`${prefix}-threshold`}>{t("permissionJudge.threshold")}</Label>
                              <Input id={`${prefix}-threshold`} type="number" min={0} max={1} step={0.01} value={stage.escalateBelow ?? ""} onChange={(event) => {
                                const { escalateBelow: _previousThreshold, ...rest } = stage;
                                updateStage(index, event.target.value === "" ? rest : { ...rest, escalateBelow: Number(event.target.value) });
                              }} />
                            </div>
                          </>
                        )}
                      </li>
                    );
                  })}
                </ol>
              </>
            )}
            {dirtyRef.current && <p role="status" className="text-sm text-warning">{t("permissionJudge.chainUnsaved")}</p>}
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" disabled={draft.chain.length >= MAX_PERMISSION_JUDGE_STAGES} onClick={() => update({ ...draft, mode: draft.chain.length ? draft.mode : DEFAULT_PERMISSION_JUDGE_MODE, chain: [...draft.chain, nextStage(draft.chain)] })}>{t("permissionJudge.addStage")}</Button>
              <Button type="submit" disabled={busy || !dirtyRef.current}>{savingChain ? t("permissionJudge.saving") : t("permissionJudge.save")}</Button>
            </div>
          </fieldset>
          {saved && <p role="status" className="text-sm text-muted-foreground">{t("permissionJudge.saved")}</p>}
        </form>
      )}
    </SettingsSection>
  );
}
