/**
 * Egress attribution fixtures for tests that wrap or spawn confined processes
 * directly. Production callers mint a token per invocation
 * (`permissions/egress-invocations.ts`); a test that is not about attribution
 * passes these fixed values instead.
 */
import type { ShellEgressContext, WorkerEgressOwner } from "../../permissions/egress-invocations.js";

/** A well-formed ASRT `commandId`: 32 hex characters, like a minted token. */
export const TEST_COMMAND_ID = "0123456789abcdef0123456789abcdef";

export const TEST_WORKER_EGRESS_OWNER: WorkerEgressOwner = {
  kind: "worker",
  role: "worker",
  pluginId: "fixture_plugin",
  instanceId: "fixture_worker",
};

/** A shell call outside any conversation that nobody can be asked about. */
export const TEST_SHELL_EGRESS_CONTEXT: ShellEgressContext = {
  sessionId: undefined,
  workspaceRoot: undefined,
  approvalSurface: "unavailable",
};
