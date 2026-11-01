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

  it("does not let an older pending success re-enable an owner changed by a newer probe", async () => {
    const older = pendingIdentity();
    const newer = pendingIdentity();
    const getOwnerLogin = vi.fn<() => Promise<string | null>>()
      .mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise);
    const onChanged = vi.fn();
    const policy = createTailnetOwnerIdentityPolicy({ getOwnerLogin, onChanged });
    const oldRequest = policy.probeOwnerIdentity();
    const newRequest = policy.probeOwnerIdentity();
    newer.resolve(NEXT_OWNER);
    const fresh = await newRequest;
    expect(policy.ownerIdentityError(NEXT_OWNER, fresh)).toBeNull();
    older.resolve(OWNER);
    const superseded = await oldRequest;
    expect(superseded.accepted).toBe(false);
    expect(policy.currentOwnerLogin()).toBe(NEXT_OWNER);
    expect(policy.ownerIdentityError(OWNER, superseded)).toBe("tailnet-owner-identity-unavailable");
    expect(policy.ownerIdentityError(NEXT_OWNER, fresh)).toBeNull();
    expect(onChanged).toHaveBeenCalledOnce();
  });

  it("does not let an older pending success undo a newer unavailable observation", async () => {
    const older = pendingIdentity();
    const getOwnerLogin = vi.fn<() => Promise<string | null>>()
      .mockResolvedValueOnce(OWNER).mockReturnValueOnce(older.promise).mockResolvedValueOnce(null);
    const policy = createTailnetOwnerIdentityPolicy({ getOwnerLogin });
    const prior = await policy.probeOwnerIdentity();
    const oldRequest = policy.probeOwnerIdentity();
    const unavailable = await policy.probeOwnerIdentity();
    older.resolve(OWNER);
    const late = await oldRequest;
    expect(policy.currentOwnerLogin()).toBeNull();
    for (const evidence of [prior, unavailable, late]) {
      expect(policy.ownerIdentityError(OWNER, evidence)).toBe("tailnet-owner-identity-unavailable");
    }
    expect(late.accepted).toBe(false);
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
    for (const evidence of [undefined, { ...issued }, Object.freeze({ ...issued }), foreignEvidence, { revision: issued.revision, ownerLogin: OWNER, accepted: true }]) {
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
