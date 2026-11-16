import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "../../../components/ui/button.js";
import { Checkbox } from "../../../components/ui/checkbox.js";
import { Input } from "../../../components/ui/input.js";
import { Label } from "../../../components/ui/label.js";
import { NativeSelect, NativeSelectOption } from "../../../components/ui/native-select.js";
import type { PluginConfigSchemaPropertySummary, PluginConfigSchemaSummary } from "../types.js";
import { useTranslation } from "../../../i18n/react.js";
import { t } from "../../../i18n/runtime.js";
import { resolvePluginLocalizedText } from "../../../shared/plugin-localized-text.js";
import { useSettingsControls } from "../context/SettingsEditorContext.js";
export type PluginConfigFormValues = Record<string, unknown>;

export interface PluginConfigSchemaFormProps {
  pluginId: string;
  schema: PluginConfigSchemaSummary;
  /** Saved + default-merged config values (cleartext only — secrets handled separately). */
  values: PluginConfigFormValues;
  /** Per-secret-key indicator: true when the keychain holds a value for this key. */
  secretsPresent: Record<string, boolean>;
  onSave: (values: PluginConfigFormValues) => Promise<void> | void;
  onSetSecret: (key: string, value: string) => Promise<void> | void;
  /** Remove only this field's saved override through its owning cleartext or secret writer. */
  onResetField: (key: string) => Promise<void> | void;
  loading?: boolean;
  loadError?: string;
}

export function pluginConfigFieldLabel(key: string, prop: PluginConfigSchemaPropertySummary, locale: string): string {
  return resolvePluginLocalizedText(prop, prop.locales, locale, ["title"]) ?? key;
}

function deriveDescription(prop: PluginConfigSchemaPropertySummary, locale: string): string | undefined {
  return resolvePluginLocalizedText(prop, prop.locales, locale, ["description"]);
}

function coerceNumber(raw: string): number | undefined {
  if (raw === "") return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function fieldError(prop: PluginConfigSchemaPropertySummary, value: unknown, required: boolean): string | null {
  if (value === undefined || value === "") return required ? t("pluginConfigSchemaForm.errorRequired") : null;
  if (prop.enum && !prop.enum.some((option) => option === value)) return t("pluginConfigSchemaForm.errorInvalidValue");
  if (prop.type === "integer" && !Number.isInteger(value)) return t("pluginConfigSchemaForm.errorInteger");
  if ((prop.type === "integer" || prop.type === "number") && (typeof value !== "number" || !Number.isFinite(value))) return t("pluginConfigSchemaForm.errorInvalidValue");
  if (prop.type === "string" && typeof value === "string") {
    if (prop.minLength !== undefined && value.length < prop.minLength) {
      return t("pluginConfigSchemaForm.errorMinLength", { minLength: prop.minLength });
    }
    if (prop.maxLength !== undefined && value.length > prop.maxLength) {
      return t("pluginConfigSchemaForm.errorMaxLength", { maxLength: prop.maxLength });
    }
    if (prop.pattern) {
      try {
        const re = new RegExp(prop.pattern);
        if (!re.test(value)) return t("pluginConfigSchemaForm.errorPatternMismatch", { pattern: prop.pattern });
      } catch {
        // bad pattern — schema author error; surface gracefully
        return t("pluginConfigSchemaForm.errorPatternInvalid", { pattern: prop.pattern });
      }
    }
  }
  if ((prop.type === "number" || prop.type === "integer") && typeof value === "number") {
    if (prop.minimum !== undefined && value < prop.minimum) {
      return t("pluginConfigSchemaForm.errorMinValue", { minimum: prop.minimum });
    }
    if (prop.maximum !== undefined && value > prop.maximum) {
      return t("pluginConfigSchemaForm.errorMaxValue", { maximum: prop.maximum });
    }
  }
  return null;
}

function isSameConfigValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) && Array.isArray(b)) {
    return JSON.stringify(a) === JSON.stringify(b);
  }
  return a === b;
}

/**
 * Render a typed form for the plugin's declared `configSchema`. The form
 * keeps secret fields and cleartext fields strictly separate: cleartext
 * values flow through `onSave`, secret writes go through `onSetSecret`
 * one key at a time so the value never sits in the cleartext settings
 * payload.
 */
/** The per-field Save for valid cleartext drafts; busy while the host writes. */
function SaveFieldButton({ fieldId, dirty, saving, onSave }: { fieldId: string; dirty: boolean; saving: boolean; onSave: () => void }) {
  const { t } = useTranslation();
  return (
    <Button
      size="sm"
      className="h-7 text-xs px-2 shrink-0"
      onClick={onSave}
      disabled={!dirty || saving}
      data-testid={`${fieldId}:save`}
    >
      {saving ? t("pluginConfigSchemaForm.saving") : t("pluginConfigSchemaForm.save")}
    </Button>
  );
}

export function PluginConfigSchemaForm({
  pluginId,
  schema,
  values,
  secretsPresent,
  onSave,
  onSetSecret,
  onResetField,
  loading,
  loadError,
}: PluginConfigSchemaFormProps) {
  const { t, locale } = useTranslation();
  const properties = schema.properties ?? {};
  const propertyKeys = useMemo(() => Object.keys(properties), [properties]);
  const [draft, setDraft] = useState<PluginConfigFormValues>(() => ({ ...values }));
  const dirtyKeysRef = useRef<Set<string>>(new Set());
  // On plugin switch reset all drafts and secrets; on same-plugin updates merge saved values while preserving unsaved
  // fields.
  const prevPluginIdRef = useRef(pluginId);
  useEffect(() => {
    if (prevPluginIdRef.current !== pluginId) {
      dirtyKeysRef.current = new Set();
      setDraft({ ...values });
      setSecretDrafts({});
      prevPluginIdRef.current = pluginId;
      return;
    }
    setDraft((prev) => {
      const next = { ...values };
      const nextDirtyKeys = new Set<string>();
      for (const key of dirtyKeysRef.current) {
        const prop = properties[key];
        if (!prop) continue;
        if (prop.type === "string" && prop.format === "secret") continue;
        if (prev[key] === undefined) continue;
        const draftV = prev[key];
        const savedV = values[key];
        if (!isSameConfigValue(draftV, savedV)) {
          next[key] = draftV;
          nextDirtyKeys.add(key);
        }
      }
      dirtyKeysRef.current = nextDirtyKeys;
      return next;
    });
  }, [pluginId, values, properties]);
  const [secretDrafts, setSecretDrafts] = useState<Record<string, string>>({});
  /** Per-key saving indicator — drives the inline Save button's loading state on text / number / array / secret fields.
   * Toggle / enum auto-save uses the parent's `saving` prop. */
  const [fieldSaving, setFieldSaving] = useState<Record<string, boolean>>({});
  const required = useMemo(() => new Set(schema.required ?? []), [schema.required]);
  const [saveErrors, setSaveErrors] = useState<Record<string, string>>({});
  const requiredSetup = propertyKeys.some((key) => {
    const prop = properties[key];
    return prop.format !== "secret" && required.has(key) && (values[key] === undefined || values[key] === "");
  });
  const hasDraftErrors = propertyKeys.some((key) => {
    const prop = properties[key];
    return prop.format !== "secret" && fieldError(prop, draft[key], required.has(key)) !== null;
  });
  const hasMissingRequiredSecrets = propertyKeys.some((key) =>
    properties[key].format === "secret" && required.has(key) && !secretsPresent[key]);

  // Build a single-key cleartext payload — uses `values` (the saved baseline)
  // for every key EXCEPT `nextKey`, which takes `nextValue`. This is critical:
  // building from `draft` would side-effect-persist other dirty text fields
  // when the user clicks Save on just one — silently committing values the
  // user never confirmed. Secrets are stripped (separate IPC), empty/undefined
  // dropped so `default` falls back at read time.
  const buildSingleKeyPayload = useCallback(
    (nextKey: string, nextValue: unknown): PluginConfigFormValues => {
      const out: PluginConfigFormValues = {};
      for (const key of propertyKeys) {
        const prop = properties[key];
        if (prop.type === "string" && prop.format === "secret") continue;
        const v = key === nextKey ? nextValue : values[key];
        if (v === undefined || v === "") continue;
        out[key] = v;
      }
      return out;
    },
    [properties, propertyKeys, values],
  );

  const persistCleartext = useCallback(async (key: string, payload: PluginConfigFormValues): Promise<boolean> => {
    setFieldSaving((prev) => ({ ...prev, [key]: true }));
    setSaveErrors((prev) => ({ ...prev, [key]: "" }));
    try {
      await onSave(payload);
      return true;
    } catch {
      setSaveErrors((prev) => ({ ...prev, [key]: t("pluginConfigTab.errorSave") }));
      return false;
    } finally {
      setFieldSaving((prev) => ({ ...prev, [key]: false }));
    }
  }, [onSave, t]);

  // Toggles and selects have no Save button, so a refused write must not leave the refused choice on screen. The latest stored
  // values and a per-key revision let a failure restore the stored value without overwriting a newer choice.
  const storedValuesRef = useRef(values);
  storedValuesRef.current = values;
  const immediateRevisionsRef = useRef<Record<string, number>>({});

  // Toggle/enum auto-save — fires onSave immediately for the changed key
  // only. The previous debounced full-draft save was retired because it
  // also caused cross-field bleed (same root cause as buildSingleKeyPayload).
  // Toggle/enum interactions are typically one click at a time, so the
  // 200ms debounce is unnecessary; remove it to keep semantics clean.
  const updateImmediate = useCallback(
    (key: string, value: unknown) => {
      dirtyKeysRef.current.add(key);
      setDraft((prev) => ({ ...prev, [key]: value }));
      if (!requiredSetup && !hasMissingRequiredSecrets && !fieldError(properties[key], value, required.has(key))) {
        const revision = (immediateRevisionsRef.current[key] ?? 0) + 1;
        immediateRevisionsRef.current[key] = revision;
        const owner = prevPluginIdRef.current;
        void persistCleartext(key, buildSingleKeyPayload(key, value)).then((saved) => {
          if (saved || immediateRevisionsRef.current[key] !== revision || prevPluginIdRef.current !== owner) return;
          dirtyKeysRef.current.delete(key);
          setDraft((prev) => {
            const next = { ...prev };
            if (storedValuesRef.current[key] === undefined) delete next[key];
            else next[key] = storedValuesRef.current[key];
            return next;
          });
        });
      }
    },
    [buildSingleKeyPayload, hasMissingRequiredSecrets, persistCleartext, properties, required, requiredSetup],
  );

  /** Text/number/array — set draft only; explicit per-field Save button persists. */
  const updateDraft = useCallback((key: string, value: unknown) => {
    dirtyKeysRef.current.add(key);
    setDraft((prev) => ({ ...prev, [key]: value }));
  }, []);

  /** Per-field cleartext save — text/number/array. Only this field's value
   *  is committed; other dirty drafts stay in local state (not persisted).
   *  The rejected draft stays visible with an inline error. */
  const saveField = useCallback(
    async (key: string) => {
      if (requiredSetup || hasMissingRequiredSecrets || fieldError(properties[key], draft[key], required.has(key))) return;
      await persistCleartext(key, buildSingleKeyPayload(key, draft[key]));
    },
    [buildSingleKeyPayload, draft, hasMissingRequiredSecrets, persistCleartext, properties, required, requiredSetup],
  );

  /** Per-field secret save — text/password input, routes to keychain. */
  const saveSecretField = useCallback(
    async (key: string, value = secretDrafts[key] ?? "") => {
      if (value !== "" && fieldError(properties[key], value, required.has(key))) return;
      setFieldSaving((p) => ({ ...p, [key]: true }));
      setSaveErrors((prev) => ({ ...prev, [key]: "" }));
      try {
        await onSetSecret(key, value);
        setSecretDrafts((p) => ({ ...p, [key]: "" }));
      } catch {
        setSaveErrors((prev) => ({ ...prev, [key]: t("pluginConfigTab.errorSaveSecret") }));
      } finally {
        setFieldSaving((p) => ({ ...p, [key]: false }));
      }
    },
    [secretDrafts, onSetSecret, properties, required, t],
  );

  /** Dirty check for cleartext fields — draft differs from saved `values`. */
  const isCleartextDirty = useCallback(
    (key: string): boolean => {
      const draftVal = draft[key];
      const savedVal = values[key];
      return !isSameConfigValue(draftVal, savedVal);
    },
    [draft, values],
  );

  useSettingsControls(propertyKeys.map((key) => {
    const prop = properties[key];
    const secret = prop.type === "string" && prop.format === "secret";
    const resetError = secret && required.has(key) ? t("pluginConfigSchemaForm.errorRequired")
      : !secret ? fieldError(prop, prop.default, required.has(key))
        ?? (hasMissingRequiredSecrets ? t("pluginConfigSchemaForm.errorRequired") : undefined) : undefined;
    return {
      id: `pluginConfig.${pluginId}.${key}`,
      section: "plugin-config-installed",
      label: `${pluginId}: ${pluginConfigFieldLabel(key, prop, locale)}`,
      modified: secret ? Boolean(secretsPresent[key]) : !isSameConfigValue(values[key], prop.default),
      loading,
      loadError,
      ...(resetError ? { disabledReason: resetError } : {}),
      reset: async () => {
        if (secret) {
          await onResetField(key);
          setSecretDrafts((previous) => ({ ...previous, [key]: "" }));
        } else {
          await onResetField(key);
          dirtyKeysRef.current.delete(key);
          setDraft((previous) => ({ ...previous, [key]: prop.default }));
        }
      },
    };
  }));

  return (
    <div data-testid={`plugin-config-form:${pluginId}`} className="flex flex-col gap-3">
      {propertyKeys.length === 0 && (
        <p className="text-xs text-muted-foreground">{t("pluginConfigSchemaForm.noFields")}</p>
      )}
      {propertyKeys.map((key) => {
        const prop = properties[key];
        const label = pluginConfigFieldLabel(key, prop, locale);
        const description = deriveDescription(prop, locale);
        const isSecret = prop.type === "string" && prop.format === "secret";
        const fieldId = `pcfg:${pluginId}:${key}`;
        const settingId = `pluginConfig.${pluginId}.${key}`;
        const value = draft[key];
        const error = isSecret
          ? fieldError(prop, secretDrafts[key], required.has(key) && !secretsPresent[key])
          : fieldError(prop, value, required.has(key));
        return (
          <div key={key} data-setting-row={settingId} className="flex flex-col gap-1">
            <Label htmlFor={fieldId} className="text-xs font-medium">
              {label}
              {required.has(key) && <span className="ml-1 text-destructive">*</span>}
              <span className="ml-2 font-mono text-tiny text-muted-foreground">{key}</span>
            </Label>
            {description && (
              <p className="text-dense text-muted-foreground">{description}</p>
            )}
            {isSecret ? (
              <>
                <div className="flex items-center gap-2">
                  <Input
                    id={fieldId}
                    data-setting-id={settingId}
                    type="password"
                    className="h-7 text-xs flex-1"
                    placeholder={secretsPresent[key] ? t("pluginConfigSchemaForm.secretSavedPlaceholder") : t("pluginConfigSchemaForm.secretInputPlaceholder")}
                    value={secretDrafts[key] ?? ""}
                    onChange={(e) =>
                      setSecretDrafts((prev) => ({ ...prev, [key]: e.target.value }))
                    }
                    data-testid={`${fieldId}:input`}
                  />
                  <Button
                    size="sm"
                    className="h-7 text-xs px-2 shrink-0"
                    onClick={() => void saveSecretField(key)}
                    disabled={!(secretDrafts[key]?.length ?? 0) || Boolean(error) || Boolean(fieldSaving[key])}
                    data-testid={`${fieldId}:save`}
                  >
                    {fieldSaving[key] ? t("pluginConfigSchemaForm.saving") : t("pluginConfigSchemaForm.save")}
                  </Button>
                  {secretsPresent[key] && !required.has(key) && (
                    <Button size="sm" variant="outline" disabled={Boolean(fieldSaving[key])}
                      data-testid={`${fieldId}:delete`}
                      onClick={() => void saveSecretField(key, "")}>
                      {t("pluginConfigSchemaForm.deleteSecret")}
                    </Button>
                  )}
                </div>
                <p className="text-tiny text-muted-foreground">
                  {t("pluginConfigSchemaForm.secretKeychainNote")}
                </p>
              </>
            ) : prop.enum ? (
              <NativeSelect
                id={fieldId}
                data-setting-id={settingId}
                disabled={hasMissingRequiredSecrets}
                size="sm"
                className="w-full"
                value={(value ?? prop.default ?? "") as string | number}
                onChange={(e) => {
                  const raw = e.target.value;
                  const next: unknown =
                    prop.type === "number" || prop.type === "integer"
                      ? coerceNumber(raw)
                      : prop.type === "boolean"
                        ? raw === "true"
                        : raw;
                  updateImmediate(key, next);
                }}
              >
                <NativeSelectOption value="" disabled>
                  {t("pluginConfigSchemaForm.selectPlaceholder")}
                </NativeSelectOption>
                {prop.enum.map((option) => (
                  <NativeSelectOption key={String(option)} value={String(option)}>
                    {String(option)}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            ) : prop.type === "boolean" ? (
              <Label className="flex items-center gap-2 text-xs">
                <Checkbox
                  id={fieldId}
                  data-setting-id={settingId}
                  disabled={hasMissingRequiredSecrets}
                  checked={Boolean(value ?? prop.default ?? false)}
                  onCheckedChange={(checked) => updateImmediate(key, checked === true)}
                />
                <span className="text-muted-foreground">{t("pluginConfigSchemaForm.enableLabel", { label })}</span>
              </Label>
            ) : prop.type === "array" && prop.items?.type === "string" ? (
              <div className="flex items-center gap-2">
                <Input
                  id={fieldId}
                  data-setting-id={settingId}
                  className="h-7 text-xs flex-1"
                  placeholder={t("pluginConfigSchemaForm.arrayPlaceholder")}
                  value={
                    Array.isArray(value)
                      ? value.join(", ")
                      : Array.isArray(prop.default)
                        ? (prop.default as unknown[]).join(", ")
                        : ""
                  }
                  onChange={(e) => {
                    const tokens = e.target.value
                      .split(",")
                      .map((s) => s.trim())
                      .filter((s) => s.length > 0);
                    updateDraft(key, tokens);
                  }}
                  onKeyDown={(e) => { if (e.key === "Enter" && isCleartextDirty(key)) void saveField(key); }}
                />
                <SaveFieldButton
                  fieldId={fieldId}
                  dirty={isCleartextDirty(key) && !error && !requiredSetup && !hasMissingRequiredSecrets}
                  saving={Boolean(fieldSaving[key])}
                  onSave={() => void saveField(key)}
                />
              </div>
            ) : prop.type === "number" || prop.type === "integer" ? (
              <div className="flex items-center gap-2">
                <Input
                  id={fieldId}
                  data-setting-id={settingId}
                  type="number"
                  className="h-7 text-xs flex-1"
                  value={
                    typeof value === "number"
                      ? String(value)
                      : typeof prop.default === "number"
                        ? String(prop.default)
                        : ""
                  }
                  onChange={(e) => {
                    const next = coerceNumber(e.target.value);
                    updateDraft(key, next);
                  }}
                  onKeyDown={(e) => { if (e.key === "Enter" && isCleartextDirty(key)) void saveField(key); }}
                  step={prop.type === "integer" ? 1 : "any"}
                  min={prop.minimum}
                  max={prop.maximum}
                />
                <SaveFieldButton
                  fieldId={fieldId}
                  dirty={isCleartextDirty(key) && !error && !requiredSetup && !hasMissingRequiredSecrets}
                  saving={Boolean(fieldSaving[key])}
                  onSave={() => void saveField(key)}
                />
              </div>
            ) : (
              <div className="flex items-center gap-2">
                <Input
                  id={fieldId}
                  data-setting-id={settingId}
                  className="h-7 text-xs flex-1"
                  value={typeof value === "string" ? value : (prop.default as string | undefined) ?? ""}
                  onChange={(e) => updateDraft(key, e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && isCleartextDirty(key)) void saveField(key); }}
                  maxLength={prop.maxLength}
                />
                <SaveFieldButton
                  fieldId={fieldId}
                  dirty={isCleartextDirty(key) && !error && !requiredSetup && !hasMissingRequiredSecrets}
                  saving={Boolean(fieldSaving[key])}
                  onSave={() => void saveField(key)}
                />
              </div>
            )}
            {error && <p role="alert" className="text-dense text-destructive">{error}</p>}
            {saveErrors[key] && <p role="alert" className="text-dense text-destructive">{saveErrors[key]}</p>}
          </div>
        );
      })}
      {requiredSetup && (
        <Button data-testid={`${pluginId}:save-required`} disabled={hasDraftErrors || hasMissingRequiredSecrets || Boolean(fieldSaving.required)}
          onClick={() => {
            if (hasDraftErrors || hasMissingRequiredSecrets) return;
            const payload: PluginConfigFormValues = {};
            for (const key of propertyKeys) {
              if (properties[key].format !== "secret" && draft[key] !== undefined && draft[key] !== "") payload[key] = draft[key];
            }
            void persistCleartext("required", payload);
          }}>
          {t("pluginConfigSchemaForm.save")}
        </Button>
      )}
      {saveErrors.required && <p role="alert" className="text-dense text-destructive">{saveErrors.required}</p>}
      {schema.customPanel && (
        <div
          className="rounded-md border border-dashed p-2 text-dense text-muted-foreground"
          data-testid={`${pluginId}:custom-panel-placeholder`}
        >
          {t("pluginConfigSchemaForm.customPanelNote", { exportName: schema.customPanel.exportName })}
        </div>
      )}
      {/* Once required setup is complete, text/number/array/secret fields save individually; toggle/enum save on change. */}
    </div>
  );
}
