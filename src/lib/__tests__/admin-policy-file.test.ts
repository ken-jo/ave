import { describe, expect, it, vi } from "vitest";
import { isAdminPolicyFileAbsent } from "../admin-policy-file.js";

function readFailure(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error("policy read failed"), { code });
}

describe("administrative policy absence", () => {
  it("confirms a missing entry after an ENOENT read failure", async () => {
    const inspectEntry = vi.fn(async () => { throw readFailure("ENOENT"); });
    expect(await isAdminPolicyFileAbsent("/synthetic/policy.json", readFailure("ENOENT"), inspectEntry)).toBe(true);
    expect(inspectEntry).toHaveBeenCalledWith("/synthetic/policy.json");
  });

  it.each(["ENOTDIR", "EACCES", "EPERM", "EIO"])("keeps %s unreadable without inferring absence", async (code) => {
    const inspectEntry = vi.fn(async () => { throw readFailure("ENOENT"); });
    expect(await isAdminPolicyFileAbsent("/synthetic/policy.json", readFailure(code), inspectEntry)).toBe(false);
    expect(inspectEntry).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps an existing entry unreadable (symbolic link: %s)", async (symbolicLink) => {
    const inspectEntry = vi.fn(async () => ({ isSymbolicLink: () => symbolicLink }));
    expect(await isAdminPolicyFileAbsent("/synthetic/policy.json", readFailure("ENOENT"), inspectEntry)).toBe(false);
  });

  it.each(["ENOTDIR", "EACCES", "EPERM"])("keeps an inconclusive %s entry probe unreadable", async (code) => {
    const inspectEntry = vi.fn(async () => { throw readFailure(code); });
    expect(await isAdminPolicyFileAbsent("/synthetic/policy.json", readFailure("ENOENT"), inspectEntry)).toBe(false);
  });
});
