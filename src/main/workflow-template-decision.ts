import { randomUUID } from "node:crypto";
import type { TemplateConfirmationOrigin } from "../shared/workflow-template-types.js";
import { requireTemplate } from "../work-board/template-graph.js";
const decisionBrand: unique symbol = Symbol("host-decision");
export interface HostDecisionProof { readonly origin: TemplateConfirmationOrigin; readonly auditId: string; readonly decidedAt: string; readonly [decisionBrand]: true }
const decisions = new WeakSet<HostDecisionProof>();
/** Called by the local decision handler after sender, owner-frame and gesture checks. */
export function mintHostDecisionProof(origin: TemplateConfirmationOrigin): HostDecisionProof {
  const proof: HostDecisionProof = Object.freeze({ origin, auditId: randomUUID(), decidedAt: new Date().toISOString(), [decisionBrand]: true as const });
  decisions.add(proof); return proof;
}
export function assertHostDecisionProof(proof: HostDecisionProof | undefined): asserts proof is HostDecisionProof {
  requireTemplate(proof !== undefined && decisions.has(proof) && proof.origin === "local-desktop");
}
