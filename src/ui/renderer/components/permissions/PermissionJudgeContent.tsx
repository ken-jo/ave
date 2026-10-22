import { useEffect, useRef, useState } from "react";
import { Button } from "../../../../components/ui/button.js";
import { Input } from "../../../../components/ui/input.js";
import { Label } from "../../../../components/ui/label.js";
import { useTranslation } from "../../../../i18n/react.js";
import { MAX_PERMISSION_JUDGE_STAGES, type PermissionJudgeSettings, type PermissionJudgeSnapshot } from "../../../../shared/permission-judge-settings.js";
import { SettingsSection } from "../PageShell.js";

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

export function PermissionJudgeContent() {
  const { t } = useTranslation();
  const [snapshot, setSnapshot] = useState<PermissionJudgeSnapshot | null>(null);
  const [draft, setDraft] = useState<PermissionJudgeSettings | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"read" | "invalid" | "keyboard" | "save" | "rewire" | "rollback" | null>(null);
  const [saved, setSaved] = useState(false);
  const [readAttempt, setReadAttempt] = useState(0);
  const [externalChange, setExternalChange] = useState(false);
  const dirtyRef = useRef(false);
  const editRevisionRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    const initialRevision = editRevisionRef.current;
    void (async () => {
      try {
        const api = window.ave?.permission;
        if (!api?.judgeGet) throw new Error("Judge settings unavailable");
        const result = await api.judgeGet();
        if (cancelled) return;
        if (!result.ok) {
          setError("read");
          return;
        }
        if (initialRevision !== editRevisionRef.current) {
          setExternalChange(true);
          return;
        }
        setSnapshot(result);
        setDraft(result.settings);
        setError(null);
        setExternalChange(false);
      } catch {
        if (!cancelled) setError("read");
      }
    })();
    return () => { cancelled = true; };
  }, [readAttempt]);

  useEffect(() => window.ave?.permission?.onConfigChanged?.(() => {
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
    dirtyRef.current = true;
    editRevisionRef.current++;
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

  async function save() {
    if (!draft) return;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const settingsToSave = {
        ...draft,
        chain: draft.chain.map((stage) => stage.external?.command ? {
          ...stage,
          external: {
            ...stage.external,
            command: [stage.external.command[0] ?? "", ...stage.external.command.slice(1).filter((arg) => arg.length > 0)],
            ...(stage.external.env ? { env: stage.external.env.filter(Boolean) } : {}),
          },
        } : stage),
      };
      const result = await window.ave.permission.judgeSet(settingsToSave);
      if (!result.ok) {
        setError(result.error === "invalid-judge-settings" ? "invalid"
          : result.error === "user-keyboard-required" ? "keyboard"
          : result.error === "judge-rewire-failed" ? "rewire"
          : result.error === "judge-rollback-failed" ? "rollback" : "save");
        return;
      }
      setSnapshot(result);
      setDraft(result.settings);
      dirtyRef.current = false;
      setExternalChange(false);
      setSaved(true);
    } catch {
      setError("save");
    } finally {
      setBusy(false);
    }
  }

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
      {snapshot && snapshot.issues.length > 0 && (
        <p role="status" className="text-sm text-warning">{t("permissionJudge.warnings", { count: snapshot.issues.length })}</p>
      )}
      {externalChange && (
        <div className="space-y-2">
          <p role="status" className="text-sm text-warning">{t("permissionJudge.externalChange")}</p>
          <Button type="button" variant="outline" disabled={busy} onClick={reload}>{t("permissionJudge.reload")}</Button>
        </div>
      )}
      {draft && (
        <form onSubmit={(event) => { event.preventDefault(); void save(); }} className="space-y-4">
          <fieldset disabled={busy} className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="permission-judge-mode">{t("permissionJudge.mode")}</Label>
              <select id="permission-judge-mode" className={SELECT_CLASS} value={draft.chain.length === 0 ? "off" : draft.mode} onChange={(event) => {
                const mode = event.target.value;
                if (mode === "off") update({ ...draft, chain: [], mode: "shadow" });
                else if (mode === "shadow" || mode === "active") update({ ...draft, mode, chain: draft.chain.length ? draft.chain : [nextStage([])] });
              }}>
                <option value="off">{t("permissionJudge.off")}</option>
                <option value="shadow">{t("permissionJudge.shadow")}</option>
                <option value="active">{t("permissionJudge.active")}</option>
              </select>
              <p className="text-xs text-muted-foreground">{t("permissionJudge.modeHelp")}</p>
            </div>
            {draft.chain.length > 0 && (
              <>
                <fieldset className="flex flex-wrap gap-4">
                  <legend className="mb-2 text-sm font-medium">{t("permissionJudge.categories")}</legend>
                  {(["shell", "write", "network"] as const).map((category) => (
                    <Label key={category} className="flex items-center gap-2">
                      <input type="checkbox" checked={draft.categories[category]} onChange={(event) => update({ ...draft, categories: { ...draft.categories, [category]: event.target.checked } })} />
                      {category === "shell" ? t("permissionJudge.shell") : category === "write" ? t("permissionJudge.write") : t("permissionJudge.network")}
                    </Label>
                  ))}
                </fieldset>
                <p className="text-xs text-muted-foreground">{t("permissionJudge.chainHelp")}</p>
                <ol className="space-y-3">
                  {draft.chain.map((stage, index) => {
                    const transport = transportFor(stage);
                    const prefix = `permission-judge-stage-${index}`;
                    const selectedModel = stage.model ? `${stage.model.vendor}/${stage.model.model}` : "";
                    const options = snapshot?.modelOptions ?? [];
                    const unavailableModel = stage.model && !options.some((option) => option.vendor === stage.model?.vendor && option.model === stage.model.model);
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
                            <select id={`${prefix}-model`} className={SELECT_CLASS} value={selectedModel} onChange={(event) => {
                              const model = options.find((option) => `${option.vendor}/${option.model}` === event.target.value);
                              const { model: _previousModel, ...rest } = stage;
                              updateStage(index, model ? { ...rest, model } : rest);
                            }}>
                              <option value="">{t("permissionJudge.currentReviewer")}</option>
                              {unavailableModel && <option value={selectedModel} disabled>{t("permissionJudge.unavailableModel", { model: selectedModel })}</option>}
                              {options.map((option) => <option key={`${option.vendor}/${option.model}`} value={`${option.vendor}/${option.model}`}>{option.vendor} / {option.model}</option>)}
                            </select>
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
            <div className="flex flex-wrap gap-2">
              <Button type="button" variant="outline" disabled={draft.chain.length >= MAX_PERMISSION_JUDGE_STAGES} onClick={() => update({ ...draft, mode: draft.chain.length ? draft.mode : "shadow", chain: [...draft.chain, nextStage(draft.chain)] })}>{t("permissionJudge.addStage")}</Button>
              <Button type="submit">{busy ? t("permissionJudge.saving") : t("permissionJudge.save")}</Button>
            </div>
          </fieldset>
          {saved && <p role="status" className="text-sm text-muted-foreground">{t("permissionJudge.saved")}</p>}
        </form>
      )}
    </SettingsSection>
  );
}
