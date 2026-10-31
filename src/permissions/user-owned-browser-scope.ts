import type { ApprovalMemoryScope } from "../shared/permissions-events.js";
import { canonicalJsonEqual } from "../shared/canonical-json.js";

export type UserOwnedBrowserScope = Extract<ApprovalMemoryScope, { kind: "browser-origin" }>;
const issuedScopes = new WeakMap<object, () => boolean>();

export function issueUserOwnedBrowserScope(scope: UserOwnedBrowserScope, isCurrent: () => boolean): UserOwnedBrowserScope {
  const issued = Object.freeze({ ...scope });
  issuedScopes.set(issued, isCurrent);
  return issued;
}

export function isIssuedUserOwnedBrowserScope(scope: unknown): scope is UserOwnedBrowserScope {
  if (typeof scope !== "object" || scope === null) return false;
  try { return issuedScopes.get(scope)?.() === true; } catch { return false; }
}

export function preserveUserOwnedBrowserScope(source: unknown, frozenCopy: UserOwnedBrowserScope): void {
  if (isIssuedUserOwnedBrowserScope(source) && Object.isFrozen(frozenCopy) && canonicalJsonEqual(source, frozenCopy)) issuedScopes.set(frozenCopy, issuedScopes.get(source)!);
}
