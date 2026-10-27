import type { ObservationIdentity } from "../../shared/agent-observation.js";
import { runWithAgentObservationInvocation, runWithAgentObservationTurn } from "../../tools/agent-observation-context.js";

/** Runs `run` inside an agent model turn and its already authorized tool invocation, as host tool execution does. */
export function runAdmittedAgentWork<T>(identity: ObservationIdentity, run: () => Promise<T>): Promise<T> {
  return runWithAgentObservationTurn(identity, () => runWithAgentObservationInvocation(identity, run));
}
