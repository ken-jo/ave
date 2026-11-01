import { describe, expect, it, vi } from "vitest";
import { createTailnetOwnerIdentityPolicy } from "../tailnet-owner-policy.js";

function pendingIdentity() {
  let resolve!: (value: string | null) => void;
  const promise = new Promise<string | null>(accept => { resolve = accept; });
  return { promise, resolve };
}

const OWNER = "owner@example.test";
const NEXT_OWNER = "next-owner@example.test";
const FOREIGN = "foreign@example.test";

describe("request-scoped device owner policy", () => {
  it("probes asynchronously for every request without reusing a recent matching result", async () => {
    const pending = pendingIdentity();
    const getOwnerLogin = vi.fn<() => Promise<string | null>>()
      .mockResolvedValueOnce(OWNER)
      .mockReturnValueOnce(pending.promise)
      .mockResolvedValueOnce(NEXT_OWNER);
    const policy = createTailnetOwnerIdentityPolicy({ getOwnerLogin });
    const first = await policy.probeOwnerIdentity();
    expect(policy.ownerIdentityError(OWNER, first)).toBeNull();
    let settled = false;
    const secondRequest = policy.probeOwnerIdentity().then(evidence => { settled = true; return evidence; });
    await Promise.resolve();
    expect(getOwnerLogin).toHaveBeenCalledTimes(2);
    expect(settled).toBe(false);
    pending.resolve(null);
    const second = await secondRequest;
    expect(policy.ownerIdentityError(OWNER, second)).toBe("tailnet-owner-identity-unavailable");
    const third = await policy.probeOwnerIdentity();
    expect(getOwnerLogin).toHaveBeenCalledTimes(3);
    expect(policy.ownerIdentityError(NEXT_OWNER, third)).toBeNull();
    expect(policy.ownerIdentityError(OWNER, third)).toBe("tailnet-owner-identity-mismatch");
  });

  it("coalesces simultaneous callers only while the observation is pending", async () => {
    const pending = pendingIdentity();
    const getOwnerLogin = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValue(OWNER);
    const policy = createTailnetOwnerIdentityPolicy({ getOwnerLogin });
    const first = policy.probeOwnerIdentity();
    const second = policy.probeOwnerIdentity();
    expect(first).toBe(second);
    expect(getOwnerLogin).toHaveBeenCalledOnce();
    pending.resolve(OWNER);
    const [left, right] = await Promise.all([first, second]);
    expect(policy.ownerIdentityError(OWNER, left)).toBeNull();
    expect(policy.ownerIdentityError(OWNER, right)).toBeNull();
    const later = await policy.probeOwnerIdentity();
    expect(getOwnerLogin).toHaveBeenCalledTimes(2);
    expect(policy.ownerIdentityError(OWNER, later)).toBeNull();
  });

  it.each(["unavailable", "probe-error"] as const)("invalidates pre-failure evidence after %s and admits only fresh evidence on same-owner recovery", async failure => {
    const getOwnerLogin = vi.fn<() => Promise<string | null>>().mockResolvedValueOnce(OWNER);
    if (failure === "probe-error") getOwnerLogin.mockRejectedValueOnce(new Error("Owner probe unavailable"));
    else getOwnerLogin.mockResolvedValueOnce(null);
    getOwnerLogin.mockResolvedValueOnce(OWNER);
    const onChanged = vi.fn();
    const policy = createTailnetOwnerIdentityPolicy({ getOwnerLogin, onChanged });
    const before = await policy.probeOwnerIdentity();
    expect(policy.ownerIdentityError(OWNER, before)).toBeNull();
    const suspended = await policy.probeOwnerIdentity();
    expect(policy.ownerIdentityError(OWNER, before)).toBe("tailnet-owner-identity-unavailable");
    expect(policy.ownerIdentityError(OWNER, suspended)).toBe("tailnet-owner-identity-unavailable");
    const recovered = await policy.probeOwnerIdentity();
    expect(policy.ownerIdentityError(OWNER, recovered)).toBeNull();
    expect(policy.ownerIdentityError(OWNER, before)).toBe("tailnet-owner-identity-unavailable");
    expect(policy.ownerIdentityError(OWNER, suspended)).toBe("tailnet-owner-identity-unavailable");
    expect(onChanged).toHaveBeenCalledTimes(3);
  });

  it("rejects absent, copied, forged and another policy's evidence", async () => {
    const policy = createTailnetOwnerIdentityPolicy({ getOwnerLogin: () => OWNER });
    const issued = await policy.probeOwnerIdentity();
    const other = createTailnetOwnerIdentityPolicy({ getOwnerLogin: () => OWNER });
    const foreignEvidence = await other.probeOwnerIdentity();
    expect(Object.isFrozen(issued)).toBe(true);
    for (const evidence of [{ ...issued }, Object.freeze({ ...issued }), foreignEvidence, { revision: issued.revision, ownerLogin: OWNER, accepted: true }]) {
      expect(policy.ownerIdentityError(OWNER, evidence)).toBe("tailnet-owner-identity-unavailable");
    }
    expect(policy.ownerIdentityError(OWNER, issued)).toBeNull();
  });

  it("does not invalidate the owner's evidence or notify changes because a foreign requester mismatches", async () => {
    const getOwnerLogin = vi.fn(async () => OWNER);
    const onChanged = vi.fn();
    const policy = createTailnetOwnerIdentityPolicy({ getOwnerLogin, onChanged });
    const ownerEvidence = await policy.probeOwnerIdentity();
    expect(onChanged).toHaveBeenCalledOnce();
    const requesterEvidence = await policy.probeOwnerIdentity();
    expect(policy.ownerIdentityError(FOREIGN, requesterEvidence)).toBe("tailnet-owner-identity-mismatch");
    expect(policy.ownerIdentityError(OWNER, ownerEvidence)).toBeNull();
    expect(policy.currentOwnerLogin()).toBe(OWNER);
    expect(onChanged).toHaveBeenCalledOnce();
    expect(getOwnerLogin).toHaveBeenCalledTimes(2);
  });
});
