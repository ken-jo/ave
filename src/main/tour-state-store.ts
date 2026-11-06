import { join } from "node:path";
import { openFeatureNamespace, readJsonFileOrEmpty } from "./storage/feature-namespace.js";
import { isStringArray } from "../shared/is-record.js";

export interface TourState {
  lastSeenScenario: string | null;
  completedScenarios: string[];
  dismissedAt: string | null;
}

export const DEFAULT_TOUR_STATE: TourState = {
  lastSeenScenario: null,
  completedScenarios: [],
  dismissedAt: null,
};

// `~/.ave/onboarding/` namespace — owns `tour-state.json`.
const ns = openFeatureNamespace("onboarding");
const TOUR_STATE_FILE = "tour-state.json";

function normaliseState(raw: unknown): TourState {
  if (!raw || typeof raw !== "object") return DEFAULT_TOUR_STATE;
  const candidate = raw as Record<string, unknown>;
  const lastSeenScenario =
    typeof candidate.lastSeenScenario === "string" ? candidate.lastSeenScenario : null;
  const completedScenarios = isStringArray(candidate.completedScenarios)
    ? // De-dupe defensively: a corrupted manual edit shouldn't grow the
      // list every time the renderer marks the same scenario complete.
      Array.from(new Set(candidate.completedScenarios))
    : [];
  const dismissedAt =
    typeof candidate.dismissedAt === "string" ? candidate.dismissedAt : null;
  return { lastSeenScenario, completedScenarios, dismissedAt };
}

// Missing or corrupt JSON starts empty; other read failures propagate so an
// unavailable state cannot replay onboarding or overwrite existing scenarios.
async function loadTourState(): Promise<TourState> {
  return readJsonFileOrEmpty(
    join(ns.dir, TOUR_STATE_FILE),
    () => normaliseState(DEFAULT_TOUR_STATE),
    normaliseState,
  );
}

// Persist the tour state to disk. The feature-namespace helper creates the `~/.ave/onboarding/` directory with 0o700 + writes the file atomically with
// 0o600 to match the Storage Namespace per Feature rule.
export function writeTourState(next: TourState): Promise<void> {
  return serializeTourState(() => ns.writeJson(TOUR_STATE_FILE, normaliseState(next)));
}

// Share one queue with completion and dismissal so importing cannot lose another
// window's update. Reject the caller on failure and allow later durable retries.
let pendingWrite: Promise<unknown> = Promise.resolve();

function serializeTourState<T>(operation: () => Promise<T>): Promise<T> {
  const result = pendingWrite.then(operation, operation);
  pendingWrite = result;
  // Observe the queue rejection without changing the caller's result.
  void result.catch(() => undefined);
  return result;
}

/** Legacy completion is import evidence only. An existing completion makes the
 * import idempotent; no settings mutation or additional marker is needed. */
export function readTourState(legacyOnboardingCompleted = false): Promise<TourState> {
  return serializeTourState(async () => {
    const current = await loadTourState();
    if (!legacyOnboardingCompleted || current.completedScenarios.includes("first-boot-essentials")) {
      return current;
    }
    const next = {
      ...current,
      completedScenarios: [...current.completedScenarios, "first-boot-essentials"],
    };
    await ns.writeJson(TOUR_STATE_FILE, next);
    return next;
  });
}

// Mark `scenarioId` as completed. Idempotent: re-marking a scenario does not duplicate it in `completedScenarios`. Also updates `lastSeenScenario`
// because completion implies the user saw it.
export async function markScenarioComplete(scenarioId: string): Promise<TourState> {
  if (!scenarioId || typeof scenarioId !== "string") {
    throw new Error("invalid-scenario-id");
  }
  return serializeTourState(async () => {
    const current = await loadTourState();
    const completed = current.completedScenarios.includes(scenarioId)
      ? current.completedScenarios
      : [...current.completedScenarios, scenarioId];
    const next: TourState = {
      lastSeenScenario: scenarioId,
      completedScenarios: completed,
      dismissedAt: current.dismissedAt,
    };
    await ns.writeJson(TOUR_STATE_FILE, next);
    return next;
  });
}

export async function dismissScenario(scenarioId: string): Promise<TourState> {
  if (!scenarioId || typeof scenarioId !== "string") {
    throw new Error("invalid-scenario-id");
  }
  return serializeTourState(async () => {
    const current = await loadTourState();
    const next: TourState = {
      lastSeenScenario: scenarioId,
      completedScenarios: current.completedScenarios,
      dismissedAt: new Date().toISOString(),
    };
    await ns.writeJson(TOUR_STATE_FILE, next);
    return next;
  });
}
