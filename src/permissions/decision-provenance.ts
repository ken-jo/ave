/** A decision the policy made for the invocation's own origin. */
export type RuleProvenance = { readonly kind: "rule" };
/** A decision the host made itself: a failure, a missing surface or approver, a timeout or shutdown. */
export type HostProvenance = { readonly kind: "host" };
export const RULE_PROVENANCE: RuleProvenance = Object.freeze({ kind: "rule" });
export const HOST_PROVENANCE: HostProvenance = Object.freeze({ kind: "host" });
