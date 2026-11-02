// Host-only flow control for a delegated worker's output: lets the relay toward a plugin child pause the worker's
// stdout and stderr while the child's wire is congested, and end the incarnation with a named reason. Plugins never
// see it; the handles they hold carry no such method.
import type { PluginWorkerExitReason } from "../plugins/public-contract.js";

export interface WorkerOutputFlow {
  /** Stop reading the worker's output pipes; the worker blocks on its own writes once they fill. */
  pause(): void;
  resume(): void;
  /** End the incarnation with this reason. */
  end(reason: Extract<PluginWorkerExitReason, "output-overflow">): void;
}

const flows = new WeakMap<object, WorkerOutputFlow>();

/** Record the flow behind a host-produced handle, including a wrapper handed onwards in its place. */
export function registerWorkerOutputFlow(handle: object, flow: WorkerOutputFlow): void {
  flows.set(handle, flow);
}

export function workerOutputFlowOf(handle: object): WorkerOutputFlow | undefined {
  return flows.get(handle);
}
