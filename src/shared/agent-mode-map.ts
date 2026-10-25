/** Recommend mode skills without loading them; skill_load must still enforce body-hash approval. */

import { t } from "../i18n/index.js";

/** Modes tune working posture, not sampling parameters or the user-configured round budget. */
export interface AgentModeConfig {
  reasoningHint: string;
  /** Candidate names must match bundled skills; recommendations never authorize skill access. */
  autoSkills: readonly string[];
}

export const AGENT_MODES = [
  "execute",
  "plan",
  "research",
  "explore",
  "default",
] as const;
export type AgentMode = (typeof AGENT_MODES)[number];

export function isAgentMode(value: unknown): value is AgentMode {
  return (
    typeof value === "string" &&
    (AGENT_MODES as readonly string[]).includes(value)
  );
}

export const AGENT_MODE_MAP: Readonly<Record<AgentMode, AgentModeConfig>> =
  Object.freeze({
    execute: {
      reasoningHint:
        t("be_agentModeMap.executeReasoningHint"),
      autoSkills: ["email-polish", "meeting-minutes"],
    },
    plan: {
      reasoningHint:
        t("be_agentModeMap.planReasoningHint"),
      autoSkills: ["decision-record", "report-writing"],
    },
    research: {
      reasoningHint:
        t("be_agentModeMap.researchReasoningHint"),
      autoSkills: ["data-summary", "report-writing"],
    },
    explore: {
      reasoningHint:
        t("be_agentModeMap.exploreReasoningHint"),
      autoSkills: [],
    },
    default: {
      // Unknown or absent modes use no posture or skills; the profile and configured runner budget still apply.
      reasoningHint: "",
      autoSkills: [],
    },
  });

/** Return default for absent or unknown modes; flag only nonempty unknown modes for audit. */
export function resolveAgentMode(mode: string | null | undefined): {
  config: AgentModeConfig;
  matched: boolean;
  requested: string | null;
} {
  const trimmed = mode?.trim() ?? "";
  if (!trimmed) {
    return { config: AGENT_MODE_MAP.default, matched: true, requested: null };
  }
  if (isAgentMode(trimmed)) {
    return { config: AGENT_MODE_MAP[trimmed], matched: true, requested: trimmed };
  }
  return { config: AGENT_MODE_MAP.default, matched: false, requested: trimmed };
}
