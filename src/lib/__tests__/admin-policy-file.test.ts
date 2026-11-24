import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isAdminPolicyFileAbsent } from "../admin-policy-file.js";

const probes = vi.hoisted(() => ({ lstat: vi.fn(), stat: vi.fn() }));
vi.mock("node:fs/promises", () => probes);
const policyPath = join(tmpdir(), "policy-fixture", "admin", "policy.json");
const entry = (directory: boolean, symbolicLink = false) => ({
  isDirectory: () => directory,
  isSymbolicLink: () => symbolicLink,
  isFile: () => !directory && !symbolicLink,
});

beforeEach(() => {
  probes.lstat.mockReset().mockResolvedValue(entry(true));
  probes.stat.mockReset();
});

function readFailure(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error("policy read failed"), { code });
}

describe("administrative policy absence", () => {
  it("confirms a missing entry after an ENOENT read failure", async () => {
    const inspectEntry = vi.fn(async () => { throw readFailure("ENOENT"); });
    expect(await isAdminPolicyFileAbsent(policyPath, readFailure("ENOENT"), inspectEntry)).toBe(true);
    expect(inspectEntry).toHaveBeenCalledWith(policyPath);
  });

  it.each(["ENOTDIR", "EACCES", "EPERM", "EIO"])("keeps %s unreadable without inferring absence", async (code) => {
    const inspectEntry = vi.fn(async () => { throw readFailure("ENOENT"); });
    expect(await isAdminPolicyFileAbsent(policyPath, readFailure(code), inspectEntry)).toBe(false);
    expect(inspectEntry).not.toHaveBeenCalled();
  });

  it.each([false, true])("keeps an existing entry unreadable (symbolic link: %s)", async (symbolicLink) => {
    const inspectEntry = vi.fn(async () => ({ isSymbolicLink: () => symbolicLink }));
    expect(await isAdminPolicyFileAbsent(policyPath, readFailure("ENOENT"), inspectEntry)).toBe(false);
  });

  // Windows reports paths through regular files as ENOENT rather than ENOTDIR.
  it.each([
    ["the parent", [policyPath]],
    ["a grandparent", [join(dirname(policyPath), "nested", "policy.json"), join(dirname(policyPath), "nested")]],
  ])("keeps a missing entry under a regular file at %s unreadable", async (_, missing) => {
    const inspectEntry = probes.lstat.mockImplementation(async (path: string) => {
      if (missing.includes(path)) throw readFailure("ENOENT");
      return entry(path !== dirname(policyPath));
    });
    expect(await isAdminPolicyFileAbsent(missing[0]!, readFailure("ENOENT"), inspectEntry)).toBe(false);
  });

  it("confirms a missing entry under an existing directory", async () => {
    const inspectEntry = vi.fn(async (path: string) => {
      if (path === policyPath) throw readFailure("ENOENT");
      return entry(true);
    });
    expect(await isAdminPolicyFileAbsent(policyPath, readFailure("ENOENT"), inspectEntry)).toBe(true);
  });

  it.each(["ENOTDIR", "EACCES", "EPERM"])("keeps an inconclusive %s entry probe unreadable", async (code) => {
    const inspectEntry = vi.fn(async () => { throw readFailure(code); });
    expect(await isAdminPolicyFileAbsent(policyPath, readFailure("ENOENT"), inspectEntry)).toBe(false);
  });

  it("keeps an ENOENT under a symlink-to-file ancestor unreadable", async () => {
    probes.lstat.mockImplementation(async (path: string) => {
      if (path === policyPath) throw readFailure("ENOENT");
      return entry(false, true);
    });
    probes.stat.mockResolvedValue(entry(false));
    expect(await isAdminPolicyFileAbsent(policyPath, readFailure("ENOENT"))).toBe(false);
    expect(probes.stat).toHaveBeenCalledWith(dirname(policyPath));
  });

  it("keeps missing ancestors through the root inconclusive", async () => {
    probes.lstat.mockRejectedValue(readFailure("ENOENT"));
    expect(await isAdminPolicyFileAbsent(policyPath, readFailure("ENOENT"))).toBe(false);
  });
});
