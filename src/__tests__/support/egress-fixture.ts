/** Fixed attribution values are for tests outside attribution coverage; production mints a token per invocation. */
import type { ShellEgressContext, WorkerEgressOwner } from "../../permissions/egress-invocations.js";

/** A valid commandId is 32 hexadecimal characters. */
export const TEST_COMMAND_ID = "0123456789abcdef0123456789abcdef";

export const TEST_WORKER_EGRESS_OWNER: WorkerEgressOwner = {
  kind: "worker",
  role: "worker",
  pluginId: "fixture_plugin",
  instanceId: "fixture_worker",
};

/** The invocation has no conversation or possible approver. */
export const TEST_SHELL_EGRESS_CONTEXT: ShellEgressContext = {
  sessionId: undefined,
  workspaceRoot: undefined,
  approvalSurface: "unavailable",
};
