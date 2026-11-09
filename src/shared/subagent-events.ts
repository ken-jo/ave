import type { A2AProjectedTaskState } from "./a2a.js";

export type SubAgentSuspensionReason = "budget" | "question";

export interface SubAgentSuspension {
  reason: SubAgentSuspensionReason;
  prompt?: string;
  resumeId: string;
}

export type SubAgentRunStatus = "running" | "waiting" | "done" | "error" | "interrupted";

/** Keep lifecycle fixtures typed to this shared contract so required taskState cannot disappear through record-shaped adapters. */
export interface SessionActivity {
  sessionId: string;
  sequence: number;
  running: boolean;
  attention: boolean;
}

/** A full host view; sequence also retires omitted states from older stream frames. */
export interface SessionActivitySnapshot {
  sequence: number;
  sessions: SessionActivity[];
}

export interface AgentSpawnEvent<TEntry = unknown> {
  /** Host-sequenced live state, independent of list snapshots. Absent before a child is linked. */
  activity?: SessionActivity;
  spawnId: string;
  /** Every frame requires its parent session ID; tiles receive all frames and must filter to their own conversation. */
  parentSessionId: string;
  taskState: A2AProjectedTaskState;
  type: "start" | "activity" | "done" | "error";
  title?: string;
  instructions?: string;
  entries?: TEntry[];
  summary?: string;
  toolCallCount?: number;
  message?: string;
  status?: SubAgentRunStatus;
  suspension?: SubAgentSuspension;
  toolUseId?: string;
  childSessionId?: string;
}
