import { TailnetOwnerIdentityError, readTailnetOwnerLogin } from "./tailnet-owner-identity.js";
import type { TailnetOwnerIdentityErrorCode } from "../shared/tailnet-sharing.js";

export interface TailnetOwnerIdentityEvidence { readonly revision: number; readonly ownerLogin: string | null; readonly accepted: boolean }
interface TailnetOwnerIdentityPolicy {
  probeOwnerIdentity(): Promise<TailnetOwnerIdentityEvidence>;
  currentOwnerLogin(): string | null;
  ownerIdentityError(login: string, evidence: TailnetOwnerIdentityEvidence): TailnetOwnerIdentityErrorCode | null;
}

/** Evidence is request-bound host state; newer observations invalidate earlier identity revisions without a TTL. */
export function createTailnetOwnerIdentityPolicy(options: { getOwnerLogin?: () => Promise<string | null> | string | null; onChanged?: () => void } = {}): TailnetOwnerIdentityPolicy {
  let issuedProbe = 0;
  let settledProbe = 0;
  let revision = 0;
  let ownerLogin: string | null = null;
  const issuedEvidence = new WeakSet<object>();
  let inFlight: Promise<TailnetOwnerIdentityEvidence> | undefined;
  const observeOwnerIdentity = async (): Promise<TailnetOwnerIdentityEvidence> => {
    const sequence = ++issuedProbe;
    let value: string | null = null;
    try { const result = await (options.getOwnerLogin ?? readTailnetOwnerLogin)(); value = typeof result === "string" && result.trim().length > 0 && result.length <= 512 && !/[\u0000-\u001f\u007f]/.test(result) ? result : null; } catch { /* Unavailable identity suspends admission without deleting durable grants. */ }
    const accepted = sequence > settledProbe || value === ownerLogin;
    if (accepted) {
      settledProbe = Math.max(settledProbe, sequence);
      if (revision === 0 || value !== ownerLogin) {
        ownerLogin = value;
        revision += 1;
        options.onChanged?.();
      }
    }
    const evidence = Object.freeze({ revision, ownerLogin: value, accepted });
    issuedEvidence.add(evidence);
    return evidence;
  };
  const probeOwnerIdentity = (): Promise<TailnetOwnerIdentityEvidence> => {
    if (inFlight) return inFlight;
    const pending = observeOwnerIdentity();
    inFlight = pending;
    const clearPending = () => { if (inFlight === pending) inFlight = undefined; };
    void pending.then(clearPending, clearPending);
    return pending;
  };
  const ownerIdentityError = (login: string, evidence: TailnetOwnerIdentityEvidence): TailnetOwnerIdentityErrorCode | null => {
    if (!evidence || !issuedEvidence.has(evidence) || !evidence.accepted || evidence.revision !== revision || ownerLogin === null) return "tailnet-owner-identity-unavailable";
    return ownerLogin !== login ? "tailnet-owner-identity-mismatch" : null;
  };

  return Object.freeze({ probeOwnerIdentity, currentOwnerLogin: () => ownerLogin, ownerIdentityError });
}

export async function probeTailnetOwnerIdentityGuard(policy: TailnetOwnerIdentityPolicy): Promise<{ readonly evidence: TailnetOwnerIdentityEvidence; readonly assertCurrent: () => void }> {
  const evidence = await policy.probeOwnerIdentity();
  const assertCurrent = (): void => {
    const error = policy.ownerIdentityError(evidence.ownerLogin ?? "", evidence);
    if (error !== null) throw new TailnetOwnerIdentityError(error);
  };
  assertCurrent();
  return { evidence, assertCurrent };
}
