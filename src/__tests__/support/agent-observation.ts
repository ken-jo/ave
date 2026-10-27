import type { ObservationIdentity } from "../../shared/agent-observation.js";
import { runWithAgentObservationInvocation, runWithAgentObservationTurn } from "../../tools/agent-observation-context.js";

export function agentObservationFixture(identity: ObservationIdentity) {
  return <T>(run: () => Promise<T>): Promise<T> =>
    runWithAgentObservationTurn(identity, () => runWithAgentObservationInvocation(identity, run));
}
