import { isAbsolute } from "node:path";
import type { IsolationUnproven, StageEnvelope } from "../shared/workflow-template-types.js";
import type { HostShellExecutionPlan } from "./host-shell-execution-plan.js";

export type { IsolationUnproven } from "../shared/workflow-template-types.js";

export interface UnattendedIsolationProfile {
  readRoots: readonly string[];
  writeRoots: readonly string[];
  readDenyRoots: readonly string[];
}

export type UnattendedIsolationProof = { proven: true; profile: UnattendedIsolationProfile } | { proven: false; reason: IsolationUnproven };

export function proveUnattendedIsolation({ plan, envelope, workspaceRoot, home, toolchainRoots, floorCovers }: {
  plan: HostShellExecutionPlan;
  envelope: StageEnvelope;
  workspaceRoot: string;
  home: string | undefined;
  toolchainRoots: readonly string[];
  floorCovers: (path: string) => boolean;
}): UnattendedIsolationProof {
  if (!plan.sandboxed) return { proven: false, reason: "sandbox-unavailable" };
  if (plan.substrate !== "mxc") return { proven: false, reason: "platform-not-qualified" };
  if (plan.egressProtocolCoverage.rawIp !== "blocked") return { proven: false, reason: "boundary-unverified" };
  const readRoots = [workspaceRoot, ...envelope.readRoots];
  if (home === undefined || !isAbsolute(home) || readRoots.some(path => !isAbsolute(path) || floorCovers(path))) {
    return { proven: false, reason: "read-narrowing-unavailable" };
  }
  return {
    proven: true,
    profile: { readRoots: [...readRoots, ...toolchainRoots], writeRoots: [workspaceRoot], readDenyRoots: [home] },
  };
}
