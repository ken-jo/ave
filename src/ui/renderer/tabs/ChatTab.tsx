import { useCallback } from "react";
import { PrivacyTab } from "./PrivacyTab.js";
import { Badge } from "../../../components/ui/badge.js";
import { Switch } from "../../../components/ui/switch.js";
import { Input } from "../../../components/ui/input.js";
import { Label } from "../../../components/ui/label.js";
import { RadioGroup, RadioGroupItem } from "../../../components/ui/radio-group.js";
import {
  SUBAGENT_MAX_ROUNDS_DEFAULT,
  SUBAGENT_MAX_ROUNDS_MIN,
} from "../../../shared/subagent-policy.js";
import { SettingsPageHeader, SettingsSection } from "../components/PageShell.js";
import { useTranslation } from "../../../i18n/react.js";

import {
  PROCESSING_DISPLAY_LEVELS,
  type ProcessingDisplayLevel,
} from "../../../shared/processing-display-level.js";

const PROCESSING_DISPLAY_LABEL_KEYS: Record<ProcessingDisplayLevel, string> = {
  tools: "chatTab.processingDisplayBrief",
  reasoning: "chatTab.processingDisplayStandard",
  full: "chatTab.processingDisplayDetailed",
};

const PROCESSING_DISPLAY_HINT_KEYS: Record<ProcessingDisplayLevel, string> = {
  tools: "chatTab.processingDisplayBriefHint",
  reasoning: "chatTab.processingDisplayStandardHint",
  full: "chatTab.processingDisplayDetailedHint",
};


export interface ChatTabProps {
  autoCompact: boolean;
  setAutoCompact: (updater: boolean | ((prev: boolean) => boolean)) => void;
  processingDisplayLevel: ProcessingDisplayLevel;
  setProcessingDisplayLevel: (value: ProcessingDisplayLevel) => void;
  streamSmoothing: "none" | "word" | "char";
  setStreamSmoothing: (v: "none" | "word" | "char") => void;
  idlePreferenceRefresh?: boolean;
  setIdlePreferenceRefresh?: (v: boolean) => void;
  idleMemoryConsolidation?: boolean;
  setIdleMemoryConsolidation?: (v: boolean) => void;
  subAgentAutonomousWake?: boolean;
  subAgentMaxRounds?: number;
  setSubAgentMaxRounds?: (next: number) => void;
  setSubAgentAutonomousWake?: (v: boolean) => void;
  piiRedactEnabled: boolean;
  onPiiRedactToggle: () => void;
  settingsLoaded: boolean;
  /** Debounced immediate-apply hook for chat settings saved through the chat payload. */
  onImmediateChange?: () => void;
}

export function ChatTab({
  autoCompact,
  setAutoCompact,
  processingDisplayLevel,
  setProcessingDisplayLevel,
  streamSmoothing,
  setStreamSmoothing,
  idlePreferenceRefresh,
  setIdlePreferenceRefresh,
  idleMemoryConsolidation,
  setIdleMemoryConsolidation,
  subAgentAutonomousWake,
  subAgentMaxRounds,
  setSubAgentMaxRounds,
  setSubAgentAutonomousWake,
  piiRedactEnabled,
  onPiiRedactToggle,
  settingsLoaded,
  onImmediateChange,
}: ChatTabProps) {
  const { t } = useTranslation();
  // Memoize the wrapped onToggle so PrivacyTab receives a stable identity across re-renders — if PrivacyTab ever memoizes
  // via React.memo / props comparison, an inline arrow would defeat it.
  const handlePiiRedactToggle = useCallback(() => {
    onPiiRedactToggle();
    onImmediateChange?.();
  }, [onPiiRedactToggle, onImmediateChange]);

  return (
    <div className="space-y-6">
      <SettingsPageHeader
        title={t("chatTab.title")}
        description={t("chatTab.description")}
      />

      <SettingsSection
        data-settings-section="chat-optimization"
        title={t("chatTab.conversationOptimizationTitle")}
        description={t("chatTab.conversationOptimizationDescription")}
      >
        <div className="flex items-center gap-3 rounded-md border px-3 py-3">
          <Switch
            aria-label={t("chatTab.autoCompactLabel")}
            checked={autoCompact}
            disabled={!settingsLoaded}
            className="shrink-0"
            onCheckedChange={(checked) => {
              setAutoCompact(checked === true);
              onImmediateChange?.();
            }}
          />
          <div className="space-y-0.5">
            <p className="text-sm font-medium">{t("chatTab.autoCompactLabel")}</p>
            <p className="text-dense text-muted-foreground">{t("chatTab.autoCompactHint")}</p>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        data-settings-section="chat-stream-smoothing"
        title={t("chatTab.streamSmoothingTitle")}
        description={t("chatTab.streamSmoothingDescription")}
      >
        <RadioGroup
          className="flex gap-4 text-sm"
          value={streamSmoothing}
          disabled={!settingsLoaded}
          onValueChange={(value) => {
            setStreamSmoothing(value as "none" | "word" | "char");
            onImmediateChange?.();
          }}
          aria-label={t("chatTab.streamSmoothingTitle")}
        >
          {(["none", "word", "char"] as const).map((opt) => (
            <Label key={opt} className="flex items-center gap-1">
              <RadioGroupItem value={opt} />
              {opt === "none" ? t("chatTab.streamOptNone") : opt === "word" ? t("chatTab.streamOptWord") : t("chatTab.streamOptChar")}
            </Label>
          ))}
        </RadioGroup>
      </SettingsSection>

      <SettingsSection
        data-settings-section="chat-processing-display"
        title={t("chatTab.processingDisplayTitle")}
        description={t("chatTab.processingDisplayDescription")}
      >
        <div className="space-y-3 rounded-md border px-3 py-3">
          <RadioGroup value={processingDisplayLevel} disabled={!settingsLoaded}
            aria-label={t("chatTab.processingDisplayAriaLabel")}
            className="flex flex-wrap gap-4"
            onValueChange={(value) => {
              if (!PROCESSING_DISPLAY_LEVELS.includes(value as ProcessingDisplayLevel)) return;
              setProcessingDisplayLevel(value as ProcessingDisplayLevel);
              onImmediateChange?.();
            }}>
            {PROCESSING_DISPLAY_LEVELS.map((level) => <Label key={level} className="flex items-center gap-2">
              <RadioGroupItem value={level} aria-label={t(PROCESSING_DISPLAY_LABEL_KEYS[level])} />
              {t(PROCESSING_DISPLAY_LABEL_KEYS[level])}
            </Label>)}
          </RadioGroup>
          <p className="text-dense text-muted-foreground" data-testid="processing-display-hint">
            {t(PROCESSING_DISPLAY_HINT_KEYS[processingDisplayLevel])}
          </p>
        </div>
      </SettingsSection>

      <SettingsSection
        data-settings-section="chat-experimental"
        title={t("chatTab.experimentalTitle")}
        description={t("chatTab.experimentalDescription")}
        badge={
          <Badge variant="outline" className="text-tiny uppercase">
            {t("chatTab.experimentalBadge")}
          </Badge>
        }
      >
        <div className="flex items-center gap-3 rounded-md border px-3 py-3">
          <Switch
            checked={idlePreferenceRefresh ?? false}
            disabled={!settingsLoaded}
            aria-label={t("chatTab.idleRefreshLabel")}
            data-testid="idle-preference-refresh-toggle"
            className="shrink-0"
            onCheckedChange={(checked) => {
              setIdlePreferenceRefresh?.(checked === true);
            }}
          />
          <div className="space-y-0.5">
            <p className="text-sm font-medium">{t("chatTab.idleRefreshLabel")}</p>
            <p className="text-dense text-muted-foreground">
              {t("chatTab.idleRefreshHint")}
            </p>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-3 rounded-md border px-3 py-3">
          <Switch
            checked={idleMemoryConsolidation ?? false}
            disabled={!settingsLoaded}
            aria-label={t("chatTab.idleMemoryConsolidationLabel")}
            data-testid="idle-memory-consolidation-toggle"
            className="shrink-0"
            onCheckedChange={(checked) => {
              setIdleMemoryConsolidation?.(checked === true);
            }}
          />
          <div className="space-y-0.5">
            <p className="text-sm font-medium">{t("chatTab.idleMemoryConsolidationLabel")}</p>
            <p className="text-dense text-muted-foreground">
              {t("chatTab.idleMemoryConsolidationHint")}
            </p>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-3 rounded-md border px-3 py-3">
          <Switch
            checked={subAgentAutonomousWake ?? false}
            disabled={!settingsLoaded}
            aria-label={t("chatTab.subAgentWakeLabel")}
            data-testid="subagent-autonomous-wake-toggle"
            className="shrink-0"
            onCheckedChange={(checked) => {
              setSubAgentAutonomousWake?.(checked === true);
            }}
          />
          <div className="space-y-0.5">
            <p className="text-sm font-medium">{t("chatTab.subAgentWakeLabel")}</p>
            <p className="text-dense text-muted-foreground">
              {t("chatTab.subAgentWakeHint")}
            </p>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-3 rounded-md border px-3 py-3">
          <Input
            type="number"
            min={SUBAGENT_MAX_ROUNDS_MIN}
            // No `max`: the engine runs the configured budget as-is, so the
            // field must not refuse a value the engine would honour.
            // Commit on blur, not per keystroke: typing "12" passes through
            // "1", and a per-keystroke write would persist that and clamp it
            // back into the field mid-edit. `key` remounts the field when the
            // stored value changes, so a clamped value is reflected back.
            key={subAgentMaxRounds ?? SUBAGENT_MAX_ROUNDS_DEFAULT}
            defaultValue={subAgentMaxRounds ?? SUBAGENT_MAX_ROUNDS_DEFAULT}
            disabled={!settingsLoaded}
            aria-label={t("chatTab.subAgentMaxRoundsLabel")}
            data-testid="subagent-max-rounds-input"
            className="w-20"
            onBlur={(e) => {
              const parsed = Number.parseInt(e.target.value, 10);
              if (Number.isFinite(parsed)) setSubAgentMaxRounds?.(parsed);
            }}
          />
          <div className="space-y-0.5">
            <p className="text-sm font-medium">{t("chatTab.subAgentMaxRoundsLabel")}</p>
            <p className="text-dense text-muted-foreground">
              {t("chatTab.subAgentMaxRoundsHint")}
            </p>
          </div>
        </div>
      </SettingsSection>

      <SettingsSection
        data-settings-section="chat-privacy"
        title={t("chatTab.privacyTitle")}
        description={t("chatTab.privacyDescription")}
      >
        <PrivacyTab
          piiRedactEnabled={piiRedactEnabled}
          onToggle={handlePiiRedactToggle}
        />
      </SettingsSection>
    </div>
  );
}
