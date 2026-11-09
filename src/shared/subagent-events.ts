import type { A2AProjectedTaskState } from "./a2a.js";

export type SubAgentSuspensionReason = "budget" | "question";

export interface SubAgentSuspension {
  reason: SubAgentSuspensionReason;
  prompt?: string;
  resumeId: string;
}

export type SubAgentRunStatus = "running" | "waiting" | "done" | "error" | "interrupted";

export interface SessionActivity {
  sessionId: string;
  running: boolean;
  attention: boolean;
}

export interface SessionActivitySnapshot {
  sessions: SessionActivity[];
}

export interface AgentSpawnEvent<TEntry = unknown> {
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
