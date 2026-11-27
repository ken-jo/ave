import { randomUUID } from "node:crypto";
import { requireTemplate } from "../work-board/template-graph.js";
import type { WorkDecisionAuthority } from "../work-board/work-decision-authority.js";

const decisionBrand: unique symbol = Symbol("host-decision");

export interface RemoteWorkDecisionEvidence {
  readonly login: string;
  readonly conversationId: string;
  readonly authority: WorkDecisionAuthority;
}

interface DecisionProofBase {
  readonly auditId: string;
  readonly decidedAt: string;
  readonly [decisionBrand]: true;
}
export type HostDecisionProof = DecisionProofBase & (
  | { readonly origin: "local-desktop" }
  | { readonly origin: "tailnet-surface"; readonly remote: RemoteWorkDecisionEvidence }
);

const decisions = new WeakSet<HostDecisionProof>();

/** Mint only after the corresponding host entry point has authorized the user gesture. */
export function mintHostDecisionProof(
  ...source: [origin: "local-desktop"] | [origin: "tailnet-surface", evidence: RemoteWorkDecisionEvidence]
): HostDecisionProof {
  if (source[0] === "tailnet-surface") {
    const evidence = source[1];
    requireTemplate(evidence && typeof evidence.login === "string" && evidence.login.length > 0 && evidence.login.length <= 512
      && typeof evidence.conversationId === "string" && evidence.conversationId.length > 0
      && typeof evidence.authority?.isCurrent === "function" && typeof evidence.authority.refreshCurrent === "function");
  }
  const base: DecisionProofBase = { auditId: randomUUID(), decidedAt: new Date().toISOString(), [decisionBrand]: true };
  const proof: HostDecisionProof = source[0] === "local-desktop"
    ? Object.freeze({ ...base, origin: source[0] })
    : Object.freeze({ ...base, origin: source[0], remote: Object.freeze({ ...source[1] }) });
  decisions.add(proof);
  return proof;
}

export function assertHostDecisionProof(proof: HostDecisionProof | undefined, options?: { allowTailnet: true }): asserts proof is HostDecisionProof {
  requireTemplate(proof !== undefined && decisions.has(proof) && (proof.origin === "local-desktop" || (proof.origin === "tailnet-surface" && options?.allowTailnet)));
}
