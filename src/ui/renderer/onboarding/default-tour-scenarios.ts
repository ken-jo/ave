




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

/**
 * `first-boot-essentials` — the canonical first-login tour.
 *
 * The tour walks the user through the host UI so they land with a full
 * mental model: the composer, the input action bar, the command palette,
 * recent chat history, the Settings/menu entry, and the model cell in the
 * composer's status row. Plugins no longer have a dedicated step — the
 * input-area relayout folded plugin views into the command palette
 * (SlashPicker), so the palette step (anchor `command-palette-toggle`)
 * already covers how the user reaches plugins. Each anchor is pinned to a
 * `data-tour-anchor=` attribute on a production DOM element so renderer
 * refactors break the tour visibly (test in
 * `__tests__/tour-anchors-trigger.test.tsx`).
 */
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

/**
 * Registry — `SpotlightTour` consumes this map to resolve `scenarioId`
 * payloads received over `ave:tour:start`. New scenarios are added here;
 * the host-side store is unaware of the contents.
 *
 * Host tours only: every step anchors on host UI. An extension introduces
 * itself through its manifest's `onboarding` block (one `firstTask`, up to
 * five `highlights`), which the host proposes generically after this tour —
 * never through a scenario here. Plugin UI renders in a webview guest, so a
 * host tour could not reach a plugin panel's elements anyway.
 *
 * Each property is a getter so scenario objects (with their translated
 * strings) are built lazily at access time, ensuring t() reads the current
 * locale rather than the locale at module initialisation.
 */
export const DEFAULT_TOUR_SCENARIOS: Readonly<Record<string, TourScenario>> = Object.freeze(
  Object.defineProperties({} as Record<string, TourScenario>, {
    "first-boot-essentials": { get: buildFirstBootEssentials, enumerable: true, configurable: false },
  }),
);

export function getTourScenario(id: string): TourScenario | undefined {
  return DEFAULT_TOUR_SCENARIOS[id];
}
