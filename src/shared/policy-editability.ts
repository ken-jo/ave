/** Match savePolicy exactly: an administrator policy source or managed user policy is not editable, regardless of the other flag. */

export type PolicySource = "defaults" | "user" | "admin" | "merged";

export function isPolicyUserEditable(policy: {
  source: PolicySource;
  managed?: boolean;
}): boolean {
  if (policy.source === "admin" || policy.source === "merged") return false;
  return policy.managed !== true;
}
