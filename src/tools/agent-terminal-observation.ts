import type { ObservationIdentity, TerminalObservedCommand, TerminalObservationDecision } from "../shared/agent-observation.js";
import { currentAgentObservationIdentity } from "./agent-observation-context.js";

export interface AgentTerminalObservationInput {
  kind: "shell" | "terminal";
  command: string;
  cwd: string;
  sandbox: TerminalObservedCommand["sandbox"];
  tabId?: string;
  terminalSessionId?: string;
  outputAvailability?: "streaming" | "on-completion";
}

export interface AgentTerminalObservationLease {
  readonly signal: AbortSignal;
  write(text: string, options?: { truncated?: boolean }): void;
  finish(exitCode: number | null, status?: Exclude<TerminalObservedCommand["status"], "running">): void;
  bindEgress(token: string, attribution?: TerminalObservationDecision["attribution"]): void;
  revoke(): void;
}

export type AgentTerminalEgressDecision = Omit<TerminalObservationDecision, "kind" | "attribution" | "ts">;

export interface AgentTerminalObservationSink {
  start(identity: ObservationIdentity, input: AgentTerminalObservationInput): AgentTerminalObservationLease;
  egress(token: string, decision: AgentTerminalEgressDecision): void;
  releaseSessions(ended: (sessionId: string) => boolean): void;
}

let sink: AgentTerminalObservationSink | undefined;

/** Installed only by the local desktop observation owner. */
export function setAgentTerminalObservationSink(value: AgentTerminalObservationSink | undefined): void {
  sink = value;
}

/** Tool metadata, terminal lanes and output markers cannot create model-turn authority. */
export function beginAgentTerminalObservation(input: AgentTerminalObservationInput): AgentTerminalObservationLease | undefined {
  const identity = currentAgentObservationIdentity();
  return identity ? sink?.start(identity, input) : undefined;
}

export function observeAgentTerminalEgressDecision(token: string | undefined, decision: AgentTerminalEgressDecision): void {
  if (token !== undefined) sink?.egress(token, decision);
}

export function releaseAgentTerminalObservationSessions(ended: (sessionId: string) => boolean): void {
  sink?.releaseSessions(ended);
}
