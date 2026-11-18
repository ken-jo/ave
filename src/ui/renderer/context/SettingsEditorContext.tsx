import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Button } from "../../../components/ui/button.js";
import { useTranslation } from "../../../i18n/react.js";
import { isSecuritySettingsPatch } from "../../../shared/security-settings.js";
import { SECTION_SETTING_CONTROLS, effectiveSettingValue, settingPatch, settingValuesEqual } from "../settings-modified.js";
import { isIpcErrorResult, type AppSettings, type AveApi, type DeepPartial } from "../types.js";

/** A control names its canonical setting; separate stores provide presence/default/reset adapters. */
export interface SettingsControlDescriptor {
  id: string;
  section: string;
  label: string;
  modified?: boolean;
  reset?: () => Promise<void>;
  disabledReason?: string;
  loading?: boolean;
  loadError?: string;
}
interface SettingsEditorState {
  settings: AppSettings | null;
  defaults: AppSettings | null;
  modifiedOnly: boolean;
  reloadEpoch: number;
  register: (owner: object, controls: readonly SettingsControlDescriptor[]) => void;
  unregister: (owner: object) => void;
  reset: (path: string) => Promise<void>;
}
/**
 * The registered controls change whenever any section registers or finishes loading. They live in their own context so a
 * registration re-renders only the editor's own actions and lock, not every section that registers controls.
 */
interface SettingsEditorControlsState {
  controls: ReadonlyMap<string, SettingsControlDescriptor>;
  /** Controls stay disabled until settings, defaults and every registered control have loaded. */
  locked: boolean;
}
const SettingsEditorContext = createContext<SettingsEditorState | null>(null);
const SettingsEditorControlsContext = createContext<SettingsEditorControlsState | null>(null);

export function SettingsEditorProvider({ api, modifiedOnly, reloadEpoch = 0, onRetryLoad, children }: {
  api: AveApi; modifiedOnly: boolean; reloadEpoch?: number; onRetryLoad?: () => void; children: ReactNode;
}) {
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [defaults, setDefaults] = useState<AppSettings | null>(null);
  const [owners, setOwners] = useState<ReadonlyMap<object, readonly SettingsControlDescriptor[]>>(new Map());
  const [failed, setFailed] = useState(false);
  const [localReload, setLocalReload] = useState(0);
  const { t } = useTranslation();
  const loadRequest = useMemo(() => ({ api, reloadEpoch, localReload }), [api, reloadEpoch, localReload]);
  useEffect(() => {
    const { api } = loadRequest;
    let active = true;
    let receivedUpdate = false;
    const unsubscribe = api.onSettingsUpdated((next) => { receivedUpdate = true; if (active) setSettings(next); });
    void Promise.all([api.getSettings(), api.getSettingsDefaults()]).then(([current, baseline]) => {
      if (!active) return;
      if (!receivedUpdate) setSettings(current);
      setDefaults(baseline); setFailed(false);
    }).catch(() => { if (active) setFailed(true); });
    return () => { active = false; unsubscribe(); };
  }, [loadRequest]);
  const register = useCallback((owner: object, controls: readonly SettingsControlDescriptor[]) => {
    setOwners((current) => { const next = new Map(current); next.set(owner, controls); return next; });
  }, []);
  const unregister = useCallback((owner: object) => {
    setOwners((current) => { if (!current.has(owner)) return current; const next = new Map(current); next.delete(owner); return next; });
  }, []);
  const controls = useMemo(() => {
    const merged = new Map<string, SettingsControlDescriptor>();
    for (const group of owners.values()) for (const control of group) merged.set(control.id, control);
    return merged;
  }, [owners]);
  const controlsRef = useRef(controls); controlsRef.current = controls;
  const reset = useCallback(async (path: string) => {
    const registered = controlsRef.current.get(path);
    if (!registered) throw new Error("Setting is not registered");
    if (registered.disabledReason || registered.loading || registered.loadError) throw new Error("Setting reset is unavailable");
    if (registered.reset) { await registered.reset(); return; }
    if (!defaults) throw new Error("Settings defaults unavailable");
    const value = effectiveSettingValue(defaults, path);
    if (value === undefined) throw new Error("Setting has no default");
    const patch = settingPatch(path, value);
    const result = isSecuritySettingsPatch(patch)
      ? await window.ave.permission.updateSecuritySettings(patch)
      : await api.updateSettings(patch as DeepPartial<AppSettings>);
    if (isIpcErrorResult(result)) throw new Error("Setting reset failed");
    setSettings(result);
  }, [api, defaults]);
  const locked = settings === null || defaults === null || failed || [...controls.values()].some((control) => control.loading || control.loadError);
  const value = useMemo(() => ({ settings, defaults, modifiedOnly, reloadEpoch: reloadEpoch + localReload, register, unregister, reset }), [settings, defaults, modifiedOnly, reloadEpoch, localReload, register, unregister, reset]);
  const controlsValue = useMemo(() => ({ controls, locked }), [controls, locked]);
  const controlLoadError = [...controls.values()].find((control) => control.loadError)?.loadError;
  return <SettingsEditorContext.Provider value={value}><SettingsEditorControlsContext.Provider value={controlsValue}>
    {(failed || controlLoadError) && <div role="alert" className="p-3 text-sm text-destructive">{controlLoadError ?? t("settingsEditor.defaultsFailed")} <Button size="sm" variant="outline" onClick={() => { if (onRetryLoad) onRetryLoad(); else setLocalReload((epoch) => epoch + 1); }}>{t("settingsEditor.retry")}</Button></div>}
    {children}
  </SettingsEditorControlsContext.Provider></SettingsEditorContext.Provider>;
}

/**
 * Disables the setting controls it wraps while the editor is locked. Search, navigation and the editor's own retry and
 * toolbar actions sit outside it, so they work while a section is still loading.
 */
export function SettingsEditorFieldset({ children }: { children: ReactNode }) {
  const editor = useSettingsEditorControls();
  if (!editor) throw new Error("SettingsEditorFieldset requires a SettingsEditorProvider");
  return <fieldset disabled={editor.locked} className="contents">{children}</fieldset>;
}

export function useSettingsEditor() { return useContext(SettingsEditorContext); }

/** The registered controls and the editor lock; only the editor's own actions and tests read them. */
export function useSettingsEditorControls() { return useContext(SettingsEditorControlsContext); }

/** Registration metadata is stable; handlers always use the control's latest render. */
export function useSettingsControls(descriptors: readonly SettingsControlDescriptor[]): void {
  const editor = useSettingsEditor();
  const latest = useRef(descriptors); latest.current = descriptors;
  const owner = useRef<object>({});
  const signature = JSON.stringify(descriptors.map(({ id, section, label, modified, disabledReason, loading, loadError, reset }) => ({ id, section, label, modified, disabledReason, loading, loadError, resetAvailable: reset !== undefined })));
  const register = editor?.register; const unregister = editor?.unregister;
  useEffect(() => {
    if (!register || !unregister) return;
    const metadata = JSON.parse(signature) as Array<Omit<SettingsControlDescriptor, "reset"> & { resetAvailable: boolean }>;
    const controls = metadata.map(({ resetAvailable, ...descriptor }) => ({ ...descriptor,
      ...(resetAvailable ? { reset: async () => { const current = latest.current.find((control) => control.id === descriptor.id); if (!current?.reset) throw new Error("Setting reset adapter unavailable"); await current.reset(); } } : {}),
    }));
    const token = owner.current;
    register(token, controls);
    return () => unregister(token);
  }, [register, unregister, signature]);
}

export function useSettingsControl(descriptor: SettingsControlDescriptor): { "data-setting-id": string } {
  useSettingsControls([descriptor]);
  return { "data-setting-id": descriptor.id };
}

/** Fixed AppSettings controls share their canonical paths and label keys. */
export function useAppSettingsControls(sections: readonly string[]): void {
  const { t } = useTranslation();
  useSettingsControls(sections.flatMap((section) => (SECTION_SETTING_CONTROLS[section] ?? []).map((control) => ({ id: control.path, section, label: t(control.label) }))));
}

/** A new editable control must opt into its owning descriptor or declare a transient draft/query. */
export function _unregisteredSettingsControlsForTest(root: HTMLElement): readonly string[] {
  const ids = new Set([...root.querySelectorAll<HTMLElement>('[data-setting-registered="true"]')].map((node) => node.dataset.settingControlId ?? node.dataset.settingId));
  const blanketExclusions = [...root.querySelectorAll<HTMLElement>("[data-settings-section][data-settings-transient], [data-settings-panel][data-settings-transient]")].map((node) => `blanket-transient:${node.dataset.settingsSection ?? node.dataset.settingsPanel}`);
  const missing = [...root.querySelectorAll<HTMLElement>('input:not([type="hidden"]), textarea, select, [role="combobox"], [role="checkbox"], [role="radio"], [role="switch"], [role="slider"], [contenteditable="true"]')].filter((control) => {
    if (control.getAttribute("aria-hidden") === "true" || control.closest("[data-settings-transient]")) return false;
    const id = control.closest<HTMLElement>("[data-setting-id]")?.dataset.settingId;
    return !id || !ids.has(id);
  }).map((control) => [control.tagName.toLowerCase(), control.id, control.getAttribute("aria-label"), control.getAttribute("data-testid")].filter(Boolean).join(":"));
  return [...blanketExclusions, ...missing];
}

function isSettingModified(editor: Pick<SettingsEditorState, "settings" | "defaults">, path: string): boolean {
  return editor.settings !== null && editor.defaults !== null && !settingValuesEqual(effectiveSettingValue(editor.settings, path), effectiveSettingValue(editor.defaults, path));
}
function descriptorModified(editor: SettingsEditorState, control: SettingsControlDescriptor): boolean {
  return control.modified === undefined ? isSettingModified(editor, control.id) : control.modified;
}

/** Every owning control participates, including write-only secrets and separate stores. */
export function SettingsControlActions({ section }: { section: string }) {
  const editor = useSettingsEditor();
  const registry = useSettingsEditorControls();
  const { t } = useTranslation();
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  if (!editor?.settings || !editor.defaults || !registry) return null;
  const resetControl = editor.reset;
  const controls = [...registry.controls.values()].filter((control) => control.section === section);
  if (controls.length === 0) return null;
  const modified = controls.filter((control) => descriptorModified(editor, control));
  async function reset(path: string) {
    setBusy(path); setFailed(false);
    try { await resetControl(path); } catch { setFailed(true); } finally { setBusy(null); }
  }
  async function copyId(path: string) {
    setFailed(false); try { await navigator.clipboard.writeText(path); } catch { setFailed(true); }
  }
  return <><div hidden data-settings-control-registry={section}>{controls.map((control) => <span key={control.id} data-setting-control-id={control.id} data-setting-registered="true" data-setting-modified={descriptorModified(editor, control) ? "true" : "false"} />)}</div><details open={editor.modifiedOnly || undefined} className="mt-3 border-t border-border pt-2 text-xs" data-settings-actions={section}>
    <summary className="cursor-pointer text-muted-foreground">{t("settingsEditor.actions")}{modified.length > 0 && <span className="ml-2 rounded bg-accent px-1.5 py-0.5 text-accent-foreground">{t("settingsEditor.modifiedCount", { count: modified.length })}</span>}</summary>
    <div className="mt-2 space-y-2">
      {controls.filter((control) => !editor.modifiedOnly || descriptorModified(editor, control)).map((control) => {
        const disabledReason = control.disabledReason ?? control.loadError ?? (control.loading ? t("settingsEditor.loadingPresence") : undefined) ?? (!control.reset && effectiveSettingValue(editor.defaults, control.id) === undefined ? t("settingsEditor.noDefault") : undefined);
        return <div key={control.id} data-setting-id={control.id} data-setting-registered="true" data-setting-modified={descriptorModified(editor, control) ? "true" : "false"} className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">{control.label}{descriptorModified(editor, control) && <span className="ml-2 text-primary">{t("settingsEditor.modified")}</span>}</span>
          <Button size="sm" variant="ghost" className="h-7 text-xs" disabled={busy !== null || !descriptorModified(editor, control) || !!disabledReason} aria-label={t("settingsEditor.resetLabel", { label: control.label })} onClick={() => void reset(control.id)}>{t("settingsEditor.reset")}</Button>
          <Button size="sm" variant="ghost" className="h-7 text-xs" aria-label={t("settingsEditor.copyLabel", { label: control.label })} onClick={() => void copyId(control.id)}>{t("settingsEditor.copyId")}</Button>
          {disabledReason && <p className="w-full text-xs text-muted-foreground">{disabledReason}</p>}
        </div>;
      })}
      {failed && <p role="alert" className="text-destructive">{t("settingsEditor.actionFailed")}</p>}
    </div>
  </details></>;
}
