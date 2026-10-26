import { afterEach, beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPolicy, getAdminPolicyPath } from "../policy-store.js";
import { buildSandboxConfig } from "../asrt-sandbox.js";
import { FilePolicySource, loadMarketplacePolicy } from "../../marketplace/sources/policy.js";
import { readPolicyServiceBase } from "../../marketplace/service/client.js";
import { readModelCatalogRefreshPolicy } from "../../core/model-catalog/refresh-policy.js";
import { readWindowsDirectoryDacls, win32SystemBinary, type WindowsDirectoryDacl } from "../../shared/ave-home.js";
import { initAdminPolicyAudit } from "../../lib/admin-policy-file.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import * as sensitivePaths from "../sensitive-paths.js";
import { createServiceClient } from "../../boot/steps/service-endpoint.js";

describe.skipIf(process.platform !== "win32")("Windows administrative policy trust", () => {
  let root: string;
  let admin: string;
  let user: string;
  let token: WindowsDirectoryDacl;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "policy-trust-"));
    vi.stubEnv("ProgramData", join(root, "machine"));
    vi.stubEnv("AVE_HOME", join(root, "home"));
    admin = getAdminPolicyPath();
    user = join(root, "user", "policy.json");
    await mkdir(join(root, "machine", "Ave"), { recursive: true });
    [token] = readWindowsDirectoryDacls([root]);
    expect(token.error).toBeUndefined();
    expect(typeof token.elevated).toBe("boolean");
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    await rm(root, { recursive: true, force: true });
  });

  async function writeUserPolicy(contents: string): Promise<void> {
    await writeFile(admin, contents);
    const [file] = readWindowsDirectoryDacls([admin]);
    expect(file.error).toBeUndefined();
    if (file.ownerSid !== token.currentUserSid) {
      execFileSync(win32SystemBinary("icacls"), [admin, "/setowner", `*${token.currentUserSid}`, "/q"], { windowsHide: true });
    }
    expect(readWindowsDirectoryDacls([admin])[0].ownerSid).toBe(token.currentUserSid);
  }

  it("keeps production policy readers free of injectable reader parameters", () => {
    expectTypeOf<Parameters<typeof readPolicyServiceBase>>().toEqualTypeOf<[policyPath: string]>();
    expectTypeOf<Parameters<typeof readModelCatalogRefreshPolicy>>().toEqualTypeOf<[policyPath: string]>();
    expectTypeOf<Parameters<typeof loadMarketplacePolicy>>().toEqualTypeOf<[path?: string, platform?: NodeJS.Platform]>();
    expectTypeOf<Parameters<typeof createServiceClient>>().toEqualTypeOf<[fetchImpl: typeof fetch, stagingBase?: string]>();
  });

  it("omits machine-owned roots from the Windows deny-write set", () => {
    const machine = process.env.ProgramData!;
    vi.stubEnv("ProgramFiles", join(root, "programs"));
    vi.stubEnv("ProgramFiles(x86)", join(root, "programs-x86"));
    vi.stubEnv("CommonProgramFiles", join(root, "common"));
    vi.stubEnv("ProgramW6432", join(root, "programs64"));
    const paths = [admin, join(process.env.ProgramFiles!, "absent"), join(process.env["ProgramFiles(x86)"]!, "absent"), join(process.env.CommonProgramFiles!, "absent"), join(process.env.ProgramW6432!, "absent"), join(process.env.SystemRoot!, "absent-policy")];
    const config = buildSandboxConfig({ allowedDomains: [], allowWrite: [join(root, "workspace")], denyRead: paths, denyWrite: paths });
    const denies = config.filesystem.denyWrite.map((entry) => typeof entry === "string" ? entry : entry.path);
    expect(denies.filter((path) => path.toLowerCase().startsWith(machine.toLowerCase()))).toEqual([]);
    for (const path of paths) expect(denies).not.toContain(path);
  });

  it("keeps protective denies inside a write grant beneath a machine root", async () => {
    const workspace = join(process.env.ProgramData!, "workspace");
    await mkdir(join(workspace, ".git", "hooks"), { recursive: true });
    const locked = join(workspace, "locked");
    const config = buildSandboxConfig({
      allowedDomains: [],
      allowWrite: [workspace],
      denyRead: [locked],
      denyWrite: [locked],
    });
    const denyRead = config.filesystem.denyRead.map((entry) => typeof entry === "string" ? entry : entry.path);
    const denyWrite = config.filesystem.denyWrite.map((entry) => typeof entry === "string" ? entry : entry.path);
    expect(config.filesystem.allowWrite.map(entry => typeof entry === "string" ? entry : entry.path)).toContain(workspace);
    expect(denyWrite).toContain(join(workspace, ".git", "config"));
    expect(denyWrite).toContain(join(workspace, ".git", "hooks"));
    expect(denyRead).toContain(locked);
    expect(denyWrite).toContain(locked);
    expect(denyRead).not.toContain(admin);
    expect(denyWrite).not.toContain(admin);
  });

  it("keeps a machine write deny that contains a grant beneath the root", async () => {
    const blocked = join(process.env.ProgramData!, "blocked");
    const child = join(blocked, "child");
    await mkdir(child, { recursive: true });
    const config = buildSandboxConfig({ allowedDomains: [], allowWrite: [child], denyWrite: [blocked] });
    expect(config.filesystem.allowWrite.map(entry => typeof entry === "string" ? entry : entry.path)).toContain(child);
    expect(config.filesystem.denyWrite.map((entry) => typeof entry === "string" ? entry : entry.path)).toContain(blocked);
  });

  it("refuses a write pattern whose literal base contains a machine root", () => {
    const pattern = join(root, "*");
    expect(() => buildSandboxConfig({ allowedDomains: [], allowWrite: [pattern] }))
      .toThrow(`Windows write grant ${pattern} contains machine root ${process.env.ProgramData!}`);
  });

  it("refuses a write pattern whose character class spells a machine root", () => {
    const pattern = join(root, "[m]achine", "*");
    expect(() => buildSandboxConfig({ allowedDomains: [], allowWrite: [pattern] }))
      .toThrow(`Windows write grant ${pattern} contains machine root ${process.env.ProgramData!}`);
  });

  it("does not read the extended-length prefix as a wildcard", () => {
    const grant = `\\\\?\\${join(root, "work")}`;
    expect(() => buildSandboxConfig({ allowedDomains: [], allowWrite: [grant] })).not.toThrow();
  });

  it("refuses a recursive write pattern rooted at a machine root", () => {
    const pattern = join(process.env.ProgramData!, "**");
    expect(() => buildSandboxConfig({ allowedDomains: [], allowWrite: [pattern] }))
      .toThrow(`Windows write grant ${pattern} contains machine root ${process.env.ProgramData!}`);
  });

  it("refuses a write grant equal to a machine root", () => {
    const machine = process.env.ProgramData!;
    expect(() => buildSandboxConfig({ allowedDomains: [], allowWrite: [machine] }))
      .toThrow(`Windows write grant ${machine} contains machine root ${machine}`);
  });

  it("keeps machine deny rows when a pattern prevents identity proof", () => {
    const target = join(process.env.ProgramData!, "workspace", "*");
    const config = buildSandboxConfig({ allowedDomains: [], denyRead: [target], denyWrite: [target] });
    expect(config.filesystem.denyRead).toContain(target);
    expect(config.filesystem.denyWrite).toContain(target);
  });

  it("keeps machine deny rows with unresolved short names", () => {
    const target = join(process.env.ProgramData!, "OTHER~1", "locked");
    const config = buildSandboxConfig({ allowedDomains: [], denyRead: [target], denyWrite: [target] });
    expect(config.filesystem.denyRead).toContain(target);
    expect(config.filesystem.denyWrite).toContain(target);
  });

  it("keeps machine deny rows when canonical identity throws", () => {
    const target = join(process.env.ProgramData!, "locked");
    const canonicalize = sensitivePaths.canonicalizePathForMatch;
    const spy = vi.spyOn(sensitivePaths, "canonicalizePathForMatch").mockImplementation((path) => {
      if (path === target) throw new Error("Path identity unavailable");
      return canonicalize(path);
    });
    try {
      const config = buildSandboxConfig({ allowedDomains: [], denyRead: [target], denyWrite: [target] });
      expect(config.filesystem.denyRead).toContain(target);
      expect(config.filesystem.denyWrite).toContain(target);
    } finally {
      spy.mockRestore();
    }
  });

  it("refuses a write grant above a machine root", () => {
    const machine = process.env.ProgramData!;
    expect(() => buildSandboxConfig({ allowedDomains: [], allowWrite: [root] }))
      .toThrow(`Windows write grant ${root} contains machine root ${machine}`);
  });

  it("never omits a machine read deny, with or without a read grant over it", () => {
    // Keep the fixture's ProgramData outside the profile, whose rows the disjoint-profile rule may omit.
    vi.stubEnv("USERPROFILE", join(root, "profile"));
    for (const allowRead of [undefined, [process.env.ProgramData!], [root]]) {
      const config = buildSandboxConfig({ allowedDomains: [], allowRead, denyRead: [admin], denyWrite: [admin] });
      expect(config.filesystem.denyRead).toContain(admin);
      expect(config.filesystem.denyWrite).not.toContain(admin);
    }
  });

  it("treats a missing policy under a user-owned Ave directory as absent", async () => {
    const directory = join(root, "machine", "Ave");
    if (readWindowsDirectoryDacls([directory])[0].ownerSid !== token.currentUserSid) {
      execFileSync(win32SystemBinary("icacls"), [directory, "/setowner", `*${token.currentUserSid}`, "/q"], { windowsHide: true });
    }
    expect(readWindowsDirectoryDacls([directory])[0].ownerSid).toBe(token.currentUserSid);
    const policy = await loadPolicy(user, admin);
    expect(policy).toMatchObject({ source: "defaults", managed: false });
    expect(policy).not.toHaveProperty("adminStatus");
    expect(await loadMarketplacePolicy(admin)).toMatchObject({ ok: true });
  });

  it("rejects a user-owned policy and surfaces its owner reason", async () => {
    await writeUserPolicy('{"version":1,"requireExplicitApproval":false}');
    const log = vi.fn();
    initAdminPolicyAudit({ log });
    const policy = await loadPolicy(user, admin);
    expect(policy).toMatchObject({ requireExplicitApproval: true, managed: true, adminStatus: "invalid" });
    expect(policy.adminReason).toContain(`untrusted policy file at ${admin}`);
    expect(policy.adminReason).toContain("owner S-1-5-");
    expect(log).toHaveBeenCalledWith(expect.objectContaining({ type: "error", output: expect.stringContaining(`untrusted policy file at ${admin}`) }));
  });

  it("blocks marketplace policy from the same user-owned file", async () => {
    await writeUserPolicy('{"version":1,"marketplaces":{"allowDirectInstall":true}}');
    const policy = await loadMarketplacePolicy(admin);
    expect(policy).toMatchObject({ ok: false });
    expect(policy).toHaveProperty("error", expect.stringContaining(`untrusted policy file at ${admin}`));
    const source = await FilePolicySource.open(admin);
    expect(source.load).toMatchObject({ ok: false, error: expect.stringContaining(`untrusted policy file at ${admin}`) });
    expect(source.digest).toBe("unreadable:untrusted-policy");
  });

  it("rejects a user-owned service endpoint policy through the default reader", async () => {
    await writeUserPolicy('{"service":{"baseUrl":"https://service.example"}}');
    await expect(readPolicyServiceBase(admin)).rejects.toThrow(`untrusted policy file at ${admin}`);
  });

  it("disables refresh for a user-owned policy without a refresh restriction", async () => {
    await writeUserPolicy('{"marketplaces":{}}');
    expect(await readModelCatalogRefreshPolicy(admin)).toBe("off");
  });

  it("refuses a reparse parent instead of reading its target", async () => {
    const target = join(root, "target");
    await mkdir(target);
    await writeFile(join(target, "policy.json"), '{"version":1,"requireExplicitApproval":false}');
    const alias = join(root, "alias");
    await symlink(target, alias, "junction");
    const policy = await loadPolicy(user, join(alias, "policy.json"));
    expect(policy.adminStatus).toBe("invalid");
    expect(policy.adminReason).toContain("Reparse point refused");
  });

  it("loads a protected administrative policy and diagnoses empty and malformed bytes", async (context) => {
    expect(token.error).toBeUndefined();
    expect(typeof token.elevated).toBe("boolean");
    await writeUserPolicy('{"version":1,"requireExplicitApproval":false}');
    expect((await loadPolicy(user, admin)).adminStatus).toBe("invalid");
    if (!token.elevated) context.skip("An elevated token is required to set the fixture owner");
    const parent = join(root, "machine", "Ave");
    // icacls rejects `/setowner` combined with `/grant` or `/inheritance` (exit 87).
    execFileSync(win32SystemBinary("icacls"), [parent, "/setowner", "*S-1-5-32-544", "/q"], { windowsHide: true });
    execFileSync(win32SystemBinary("icacls"), [parent, "/inheritance:r", "/grant:r", "*S-1-5-32-544:(OI)(CI)F", "*S-1-5-18:(OI)(CI)F", "/q"], { windowsHide: true });
    await writeFile(admin, '{"version":1,"requireExplicitApproval":false}');
    execFileSync(win32SystemBinary("icacls"), [admin, "/setowner", "*S-1-5-32-544", "/q"], { windowsHide: true });
    expect(await loadPolicy(user, admin)).toMatchObject({ source: "admin", requireExplicitApproval: false, managed: false });
    expect(await loadMarketplacePolicy(admin)).toMatchObject({ ok: true });
    await writeFile(admin, "");
    expect(await loadPolicy(user, admin)).toMatchObject({ adminStatus: "invalid", adminReason: `invalid policy file at ${admin}: empty file; not valid JSON` });
    await writeFile(admin, "SECRET_POLICY_CONTENT");
    expect(await loadPolicy(user, admin)).toMatchObject({ adminStatus: "invalid", adminReason: `invalid policy file at ${admin}: not valid JSON` });
  });

  it("preserves ordinary policy reads on other platforms", async () => {
    await writeUserPolicy('{"version":1,"requireExplicitApproval":false}');
    expect((await loadPolicy(user, admin)).adminStatus).toBe("invalid");
    setProcessPlatform("linux");
    try {
      const policy = await loadPolicy(user, admin);
      expect(policy.requireExplicitApproval).toBe(false);
      expect(policy.adminStatus).toBeUndefined();
      expect(await loadMarketplacePolicy(admin)).toMatchObject({ ok: true });
      expect(await readPolicyServiceBase(admin)).toBeNull();
      expect(await readModelCatalogRefreshPolicy(admin)).toBeNull();
    } finally {
      setProcessPlatform("win32");
    }
  });
});
