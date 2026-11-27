import type { StageEnvelope } from "../shared/workflow-template-types.js";
import type { StageRunEngineDeps } from "../work-board/workflow/stage-run-engine.js";
import type { ToolSource } from "../tools/types.js";
import { redactRecentlyDeniedText } from "./reviewer/recently-denied-redaction.js";

export interface UnattendedStageEntry {
  runKey: string;
  stageId: string;
  envelope: StageEnvelope;
  workspaceRoot: string;
  isolation: { proven: boolean; reason?: string };
}

type LaneHooks = NonNullable<StageRunEngineDeps["lane"]>;
interface UnattendedDenial {
  sessionId: string;
  code: string;
  call: { toolName: string; source: ToolSource; inputSummary: string };
}
type DeniedListener = (event: UnattendedDenial) => void;
const stages = new Map<string, UnattendedStageEntry>();
const deniedListeners = new Set<DeniedListener>();

export function registerUnattendedStage(sessionId: string, entry: UnattendedStageEntry): void {
  if (stages.has(sessionId)) throw new Error("Unattended session is already registered");
  stages.set(sessionId, entry);
}

export function unattendedStageOf(sessionId: string | undefined): UnattendedStageEntry | undefined {
  return sessionId === undefined ? undefined : stages.get(sessionId);
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
  for (const listener of deniedListeners) listener(event);
}

export const unattendedLaneHooks = {
  // The interim schedule predicate still limits admission to read-only versions.
  admit: async () => ({ ok: true }),
  sessionLinked: ({ sessionId, ...entry }) => {
    registerUnattendedStage(sessionId, { ...entry, isolation: { proven: false } });
  },
  sessionEnded: endUnattendedStage,
  onDenied: onUnattendedDenied,
} satisfies LaneHooks;
