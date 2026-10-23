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

  // Windows reports a path through a regular file as ENOENT, not ENOTDIR.
  it.each([
    ["the parent", ["/synthetic/admin/policy.json"]],
    ["a grandparent", ["/synthetic/admin/nested/policy.json", "/synthetic/admin/nested"]],
  ])("keeps a missing entry under a regular file at %s unreadable", async (_, missing) => {
    const inspectEntry = vi.fn(async (path: string) => {
      if (missing.includes(path)) throw readFailure("ENOENT");
      return { isFile: () => path === "/synthetic/admin" };
    });
    expect(await isAdminPolicyFileAbsent(missing[0]!, readFailure("ENOENT"), inspectEntry)).toBe(false);
  });

  it("confirms a missing entry under an existing directory", async () => {
    const inspectEntry = vi.fn(async (path: string) => {
      if (path === "/synthetic/admin/policy.json") throw readFailure("ENOENT");
      return { isFile: () => false };
    });
    expect(await isAdminPolicyFileAbsent("/synthetic/admin/policy.json", readFailure("ENOENT"), inspectEntry)).toBe(true);
  });

  it.each(["ENOTDIR", "EACCES", "EPERM"])("keeps an inconclusive %s entry probe unreadable", async (code) => {
    const inspectEntry = vi.fn(async () => { throw readFailure(code); });
    expect(await isAdminPolicyFileAbsent("/synthetic/policy.json", readFailure("ENOENT"), inspectEntry)).toBe(false);
  });
});
