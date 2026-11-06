import { buildHostShellExecutionPlan, type HostShellExecutionPlan } from "../../permissions/host-shell-execution-plan.js";
import { __issueHostShellExecutionPlanForTest } from "../../permissions/sandbox-capability.js";

/** Build a plan as the host provider issues it; startup proof trusts only issued plans. */
export function buildIssuedHostShellExecutionPlan(input: Parameters<typeof buildHostShellExecutionPlan>[0]): HostShellExecutionPlan {
  return __issueHostShellExecutionPlanForTest(buildHostShellExecutionPlan(input));
}
