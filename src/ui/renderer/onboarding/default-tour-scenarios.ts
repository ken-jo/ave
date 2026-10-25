import { t } from "../../../i18n/runtime.js";

export type CompletionTrigger =
  | { kind: "keypress"; combo: "⌘+K" | "⌘+?" | "⌘+Enter" }
  | { kind: "input"; selector: string }
  | { kind: "click"; selector: string }
  | { kind: "manual" };

export interface TourStep {
  /**
   * Stable CSS selector pinned to a `data-tour-anchor="…"` attribute on
   * the target DOM node. Selectors that match >1 element use the first
   * hit; if no element matches, the component falls back to centring the
   * card in the viewport so the tour never gets stuck (mockup contract
   * "tour must not block the chat surface").
   */
  anchorSelector: string;
  /** Short heading, displayed above the body copy. */
  title: string;
  /** Plain-text explanation. Do NOT include HTML / kbd glyphs here. */
  body: string;
  /**
   * Optional keyboard-shortcut hint rendered as `<kbd>` chips beside the
   * body. Each entry is a human-readable label (e.g. `"⌘+K"`, `"⌘+Enter"`).
   * The component renders these as <kbd> elements with an `aria-label` of
   * `"shortcut: <label>"` so screen-readers announce them properly.
   */
  keyHint?: string[];

  completionTrigger?: CompletionTrigger;
}

export interface TourScenario {
  /** Stable id persisted in `~/.ave/onboarding/tour-state.json`. */
  id: string;
  /** Display title shown in the dot-pagination row (`step / total`). */
  title: string;
  /** Ordered steps. Must be non-empty. */
  steps: TourStep[];
}

/** Keep every tour selector backed by production data-tour-anchor markup and the live keyboard start path. */
function buildFirstBootEssentials(): TourScenario {
  return {
    id: "first-boot-essentials",
    title: t("defaultTourScenarios.firstBootTitle"),
    steps: [
      {
        anchorSelector: '[data-tour-anchor="composer-input"]',
        title: t("defaultTourScenarios.firstBootStep1Title"),
        body: t("defaultTourScenarios.firstBootStep1Body"),
        keyHint: ["⌘+Enter"],
        completionTrigger: {
          kind: "input",
          selector: '[data-tour-anchor="composer-input"]',
        },
      },
      {
        anchorSelector: '[data-tour-anchor="input-action-bar"]',
        title: t("defaultTourScenarios.firstBootStep2Title"),
        body: t("defaultTourScenarios.firstBootStep2Body"),
        completionTrigger: { kind: "manual" },
      },
      {
        anchorSelector: '[data-tour-anchor="command-palette-toggle"]',
        title: t("defaultTourScenarios.firstBootStep3Title"),
        body: t("defaultTourScenarios.firstBootStep3Body"),
        keyHint: ["⌘+K"],
        completionTrigger: { kind: "keypress", combo: "⌘+K" },
      },
      {
        anchorSelector: '[data-tour-anchor="chat-history"]',
        title: t("defaultTourScenarios.firstBootStep4Title"),
        body: t("defaultTourScenarios.firstBootStep4Body"),
        keyHint: ["⌘+F"],
        completionTrigger: { kind: "manual" },
      },
      {
        anchorSelector: '[data-tour-anchor="settings-entry"]',
        title: t("defaultTourScenarios.firstBootStep5Title"),
        body: t("defaultTourScenarios.firstBootStep5Body"),
        completionTrigger: { kind: "manual" },
      },
      {
        anchorSelector: '[data-tour-anchor="model-picker"]',
        title: t("defaultTourScenarios.firstBootStep6Title"),
        body: t("defaultTourScenarios.firstBootStep6Body"),
        completionTrigger: { kind: "manual" },
      },
    ],
  };
}

/** Host tours cannot reach plugin webview DOM; extensions use manifest onboarding. Lazy scenario getters resolve strings in
 * the current locale. */
export const DEFAULT_TOUR_SCENARIOS: Readonly<Record<string, TourScenario>> = Object.freeze(
  Object.defineProperties({} as Record<string, TourScenario>, {
    "first-boot-essentials": { get: buildFirstBootEssentials, enumerable: true, configurable: false },
  }),
);

export function getTourScenario(id: string): TourScenario | undefined {
  return DEFAULT_TOUR_SCENARIOS[id];
}
