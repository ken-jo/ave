// Card and sentence selector must share the same ordered scope options. Paths come only from host-resolved candidatePath/suggestedParent; no filesystem or sentence parsing occurs here.
import type { ApprovalChoice } from "./approval-gate.js";

export interface ApprovalScopeOption {
  // Opaque, positional handle. It is the only thing besides `choice` that is ever disclosed to the selector model, and it carries no path.
  id: string;
  choice: ApprovalChoice;
  // Widening scopes outlive the call being decided.
  widens: boolean;
  // Host-resolved path this scope would allow. Never user-supplied.
  path?: string;
}

export interface ApprovalScopeInput {
  candidatePath: string;
  suggestedParent: string | null;
  // Host-imposed narrowing for a forced one-shot request.
  allowedChoices?: readonly ApprovalChoice[];
}

// Build the host-authorized choices, narrowest first. The renderer may present those choices in a different visual order, but it focuses allow-once and can only commit one of the exact host-provided choice/path pairs.
export function buildApprovalScopeOptions(
  input: ApprovalScopeInput,
): ApprovalScopeOption[] {
  const { candidatePath, suggestedParent, allowedChoices } = input;
  const permitted = (c: ApprovalChoice) => !allowedChoices || allowedChoices.includes(c);
  const out: ApprovalScopeOption[] = [];
  const push = (option: Omit<ApprovalScopeOption, "id">) => {
    out.push({ id: `o${out.length + 1}`, ...option });
  };

  if (permitted("allow-once")) {
    push({ choice: "allow-once", widens: false, path: candidatePath });
  }
  if (suggestedParent && permitted("allow-always")) {
    push({ choice: "allow-always", widens: true, path: suggestedParent });
  }
  // Deny is a peer scope, so refusing costs what allowing costs.
  if (permitted("deny-once")) push({ choice: "deny-once", widens: false });
  return out;
}
