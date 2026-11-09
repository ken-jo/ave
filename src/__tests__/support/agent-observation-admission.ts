import type { ObservationIdentity } from "../../shared/agent-observation.js";
import { AsyncResource } from "node:async_hooks";
import { runWithAgentObservationInvocation, runWithAgentObservationTurn } from "../../tools/agent-observation-context.js";

/** Runs `run` inside an agent model turn and its already authorized tool invocation, as host tool execution does. */
export function runAdmittedAgentWork<T>(identity: ObservationIdentity, run: () => Promise<T>): Promise<T> {
  return runWithAgentObservationTurn(identity, () => runWithAgentObservationInvocation(identity, run));
}

/** Keep one host model turn alive while its individual tool invocations complete. */
export function openAgentObservationTurn(identity: Pick<ObservationIdentity, "sessionId" | "turnId">) {
  let context!: AsyncResource;
  let end!: () => void;
  const finished = runWithAgentObservationTurn(identity, async () => {
    context = new AsyncResource("admitted-observation-turn");
    await new Promise<void>((resolve) => { end = resolve; });
  });
  return {
    run<T>(invocation: Pick<ObservationIdentity, "toolUseId">, run: () => Promise<T>): Promise<T> {
      return context.runInAsyncScope(() => runWithAgentObservationInvocation({ ...identity, toolUseId: invocation.toolUseId }, run));
    },
    async finish(): Promise<void> {
      end();
      try { await finished; }
      finally { context.emitDestroy(); }
    },
  };
}
