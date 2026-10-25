/** Persona selection uses prompt files plus a synthetic no-override entry; agent profiles and skills are separate. */

import { t } from "../i18n/index.js";

export interface RolePreset {
  id: string;
  name: string;
  systemPromptAdd: string;
  isDefault?: boolean;
  origin?: { kind: "agent-plugin" | "plugin"; package: string; version: string };
}

export const DEFAULT_PERSONA_SELECTION: RolePreset = {
  id: "default",
  name: t("be_rolePresets.defaultName"),
  systemPromptAdd: "",
  isDefault: true,
};

export interface ActiveRolePrompt {
  id?: string;
  name: string;
  systemPromptAdd: string;
  origin?: { kind: "agent-plugin" | "plugin"; package: string; version: string };
}

/** Send only the selected id; main resolves prompt bodies at turn start. */
export function buildActivePersonaPromptId(preset: RolePreset | null | undefined): string | null {
  const id = preset?.id.trim();
  if (!preset || preset.isDefault || !id || id === DEFAULT_PERSONA_SELECTION.id) return null;
  return id;
}
