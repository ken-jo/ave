import type { StageEnvelope } from "../shared/workflow-template-types.js";
import { createLogger } from "../lib/logger.js";
import type { StageRunEngineDeps } from "../work-board/workflow/stage-run-engine.js";
import type { ToolSource } from "../tools/types.js";
import { redactRecentlyDeniedText } from "./reviewer/recently-denied-redaction.js";
import type { UnattendedIsolationProof, UnattendedIsolationProfile } from "./unattended-isolation.js";

export interface UnattendedStageEntry {
  runKey: string;
  stageId: string;
  envelope: StageEnvelope;
  workspaceRoot: string;
  isolation: { proven: boolean; reason?: string; profile?: UnattendedIsolationProfile };
}

type LaneHooks = NonNullable<StageRunEngineDeps["lane"]>;
interface UnattendedDenial {
  sessionId: string;
  code: string;
  call: { toolName: string; source: ToolSource; inputSummary: string };
}
type DeniedListener = (event: UnattendedDenial) => void;
interface StageRegistration {
  entry: UnattendedStageEntry;
  stageSessionId: string;
  prove?: () => UnattendedIsolationProof;
}
const stages = new Map<string, StageRegistration>();
const deniedListeners = new Set<DeniedListener>();
const log = createLogger("unattended-lane");

interface StageAdmission {
  envelope: StageEnvelope;
  workspaceRoot: string;
  profile: UnattendedIsolationProfile;
  prove: () => UnattendedIsolationProof;
}
const admissions = new Map<string, StageAdmission>();
const admissionKey = (runKey: string, stageId: string): string => JSON.stringify([runKey, stageId]);

export function activateUnattendedAdmission(runKey: string, stageId: string, admission: StageAdmission): () => void {
  const key = admissionKey(runKey, stageId);
  if (admissions.has(key)) throw new Error("Unattended stage admission already active");
  admissions.set(key, admission);
  return () => { admissions.delete(key); };
}

export function admittedUnattendedStage(runKey: string, stageId: string): StageAdmission | undefined {
  return admissions.get(admissionKey(runKey, stageId));
}

export function reproveUnattendedStages(): void {
  for (const registration of stages.values()) {
    const { entry, prove, stageSessionId } = registration;
    if (!prove || !entry.isolation.proven || stages.get(stageSessionId) !== registration) continue;
    const proof = prove();
    if (!proof.proven) entry.isolation = proof;
  }
}

function registerStage(sessionId: string, registration: StageRegistration): void {
  if (stages.has(sessionId)) throw new Error("Unattended session is already registered");
  stages.set(sessionId, registration);
}

export function registerUnattendedStage(sessionId: string, entry: UnattendedStageEntry): void {
  registerStage(sessionId, { entry, stageSessionId: sessionId });
}

export function inheritUnattendedStage(sessionId: string, parentSessionId: string | undefined): boolean {
  const registration = parentSessionId === undefined ? undefined : stages.get(parentSessionId);
  if (registration === undefined) return false;
  registerStage(sessionId, registration);
  return true;
}

// Keep descendants restricted while their revoked registration awaits cleanup.
export function registeredUnattendedStageOf(sessionId: string | undefined): UnattendedStageEntry | undefined {
  return sessionId === undefined ? undefined : stages.get(sessionId)?.entry;
}

export function unattendedStageOf(sessionId: string | undefined): UnattendedStageEntry | undefined {
  const registration = sessionId === undefined ? undefined : stages.get(sessionId);
  return registration && stages.get(registration.stageSessionId) === registration ? registration.entry : undefined;
}

export function endUnattendedStage(sessionId: string): void {
  stages.delete(sessionId);
}

export function onUnattendedDenied(listener: DeniedListener): () => void {
  deniedListeners.add(listener);
  return () => { deniedListeners.delete(listener); };
}

export function reportUnattendedDenial({ sessionId, code, call }: UnattendedDenial): void {
  if (!deniedListeners.size) return;
  const redacted = Object.freeze({
    toolName: redactRecentlyDeniedText(call.toolName, 128),
    source: call.source,
    inputSummary: redactRecentlyDeniedText(call.inputSummary),
  });
  const event = Object.freeze({ sessionId, code, call: redacted });
  for (const listener of deniedListeners) {
    try {
      listener(event);
    } catch {
      log.warn("An unattended denial listener failed");
    }
  }
}

export const unattendedLaneHooks = {
  sessionLinked({ runKey, stageId, sessionId, workspaceRoot }) {
    if (stages.has(sessionId)) return;
    const admission = admittedUnattendedStage(runKey, stageId);
    if (!admission) return;
    if (admission.workspaceRoot !== workspaceRoot) throw new Error("Unattended stage workspace changed before linking");
    registerStage(sessionId, {
      stageSessionId: sessionId,
      entry: { runKey, stageId, envelope: admission.envelope, workspaceRoot, isolation: admission.prove() },
      prove: admission.prove,
    });
  },
  sessionEnded: endUnattendedStage,
  onDenied: onUnattendedDenied,
} satisfies Omit<LaneHooks, "admit">;
