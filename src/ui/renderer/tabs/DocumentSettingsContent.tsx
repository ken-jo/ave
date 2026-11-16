import { useAppSettingsControls, useSettingsDocumentRead, useSettingsEditor } from "../context/SettingsEditorContext.js";
import { useEffect, useRef, useState } from "react";
import { Input } from "../../../components/ui/input.js";
import { Label } from "../../../components/ui/label.js";
import { RadioGroup, RadioGroupItem } from "../../../components/ui/radio-group.js";
import { isDocumentOpenMode, type DocumentOpenMode } from "../../../shared/document-settings.js";
import { EDITOR_COMMAND_MAX_CHARS, isEditorCommandSetting } from "../../../shared/editor-command.js";
import { useTranslation } from "../../../i18n/react.js";
import { getApi } from "../api-client.js";
import { SettingsSection } from "../components/PageShell.js";
import { useNotifySaved } from "../context/SavedToastContext.js";
import { DocumentEngineInstallContent } from "../components/DocumentEngineInstallContent.js";

const OPEN_MODE_OPTIONS: readonly { value: DocumentOpenMode; label: string; hint: string }[] = [
  { value: "direct", label: "documentSettings.direct", hint: "documentSettings.directHint" },
  { value: "link", label: "documentSettings.link", hint: "documentSettings.linkHint" },
];

export function DocumentSettingsContent() {
  useAppSettingsControls(["chat-documents"]);
  const { t } = useTranslation();
  const notifySaved = useNotifySaved();
  const [openMode, setOpenMode] = useState<DocumentOpenMode>("direct");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const readSettings = useSettingsDocumentRead(() => getApi().getSettings());
  const editorSettings = useSettingsEditor()?.settings;
  // The editor command as saved, and what is being typed; they differ until the field is left or Enter is pressed.
  const [editorCommand, setEditorCommand] = useState("");
  const [editorDraft, setEditorDraft] = useState("");
  const [editorInvalid, setEditorInvalid] = useState(false);
  const savedEditorCommand = useRef("");


  useEffect(() => {
    let active = true;
    const api = getApi();
    let receivedUpdate = false;
    const apply = (settings: Awaited<ReturnType<typeof api.getSettings>>) => {
      if (active && isDocumentOpenMode(settings.documents?.openMode) && typeof settings.documents.editorCommand === "string") {
        setOpenMode(settings.documents.openMode);
        const saved = settings.documents.editorCommand;
        // A value saved elsewhere replaces the draft only while the draft still shows the previous saved value.
        const previous = savedEditorCommand.current;
        savedEditorCommand.current = saved;
        setEditorCommand(saved);
        setEditorDraft((draft) => (draft === previous ? saved : draft));
        setLoaded(true);
        setFailed(false);
      } else if (active) {
        setFailed(true);
      }
    };
    const unsubscribe = api.onSettingsUpdated((settings) => { receivedUpdate = true; apply(settings); });
    void (editorSettings ? Promise.resolve(editorSettings) : readSettings()).then((settings) => { if (!receivedUpdate) apply(settings); }).catch(() => { if (active && !receivedUpdate) setFailed(true); });
    return () => { active = false; unsubscribe(); };
  }, [readSettings, editorSettings]);

  const handleModeChange = async (next: DocumentOpenMode) => {
    if (next === openMode) return;
    setSaving(true);
    setFailed(false);
    try {
      const result = await getApi().updateSettings({ documents: { openMode: next } });
      if ("ok" in result && result.ok === false) throw new Error("Document preference was not saved");
      if (!("documents" in result) || !isDocumentOpenMode(result.documents.openMode)) {
        throw new Error("Document preference response is invalid");
      }
      setOpenMode(result.documents.openMode);
      notifySaved();
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  const saveEditorCommand = async () => {
    const next = editorDraft.trim();
    setEditorInvalid(false);
    if (next === editorCommand) { setEditorDraft(next); return; }
    if (!isEditorCommandSetting(next)) { setEditorInvalid(true); return; }
    setSaving(true);
    setFailed(false);
    try {
      const result = await getApi().updateSettings({ documents: { editorCommand: next } });
      if ("ok" in result && result.ok === false) throw new Error("Editor command was not saved");
      // Main keeps the old value when it refuses the new one, so a reply that does not carry it is a failed save.
      if (!("documents" in result) || result.documents.editorCommand !== next) throw new Error("Editor command response is invalid");
      savedEditorCommand.current = next;
      setEditorCommand(next);
      setEditorDraft(next);
      notifySaved();
    } catch {
      setFailed(true);
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsSection data-settings-section="chat-documents" title={t("documentSettings.title")} description={t("documentSettings.description")}>
      <DocumentEngineInstallContent />
      <RadioGroup
        data-setting-id="documents.openMode"
        value={openMode}
        onValueChange={(value) => { if (isDocumentOpenMode(value)) void handleModeChange(value); }}
        disabled={!loaded || saving}
        aria-label={t("documentSettings.title")}
        data-testid="document-open-mode"
        className="space-y-2"
      >
        {OPEN_MODE_OPTIONS.map((option) => (
          <Label key={option.value} htmlFor={`document-open-${option.value}`} className="flex items-start gap-3 rounded-md border border-border px-3 py-2">
            <RadioGroupItem id={`document-open-${option.value}`} value={option.value} data-value={option.value} />
            <span className="space-y-1">
              <span className="block text-sm font-medium">{t(option.label)}</span>
              <span className="block text-xs text-muted-foreground">{t(option.hint)}</span>
            </span>
          </Label>
        ))}
      </RadioGroup>
      <div data-setting-id="documents.editorCommand" className="mt-4 space-y-1.5">
        <Label htmlFor="document-editor-command" className="text-sm font-medium">{t("documentSettings.editorCommandLabel")}</Label>
        <Input
          id="document-editor-command"
          data-testid="document-editor-command"
          value={editorDraft}
          maxLength={EDITOR_COMMAND_MAX_CHARS}
          placeholder="code --goto {file}:{line}"
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          disabled={!loaded || saving}
          aria-invalid={editorInvalid || undefined}
          aria-describedby="document-editor-command-hint"
          className="font-mono text-xs"
          onChange={(event) => { setEditorDraft(event.target.value); setEditorInvalid(false); }}
          onBlur={() => void saveEditorCommand()}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void saveEditorCommand(); }
            if (event.key === "Escape") { setEditorDraft(editorCommand); setEditorInvalid(false); }
          }}
        />
        <p id="document-editor-command-hint" className="text-xs text-muted-foreground">
          {t("documentSettings.editorCommandHint", { file: "{file}", line: "{line}" })}
        </p>
        {editorInvalid && <p role="alert" className="text-sm text-destructive" data-testid="document-editor-command-invalid">{t("documentSettings.editorCommandInvalid")}</p>}
      </div>
      {failed && <p role="alert" className="mt-2 text-sm text-destructive">{t("documentSettings.saveFailed")}</p>}
    </SettingsSection>
  );
}
