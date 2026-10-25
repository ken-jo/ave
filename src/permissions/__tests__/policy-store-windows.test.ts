import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadPolicy, getAdminPolicyPath } from "../policy-store.js";
import { buildSandboxConfig } from "../asrt-sandbox.js";
import { loadMarketplacePolicy } from "../../marketplace/sources/policy.js";
import { readPolicyServiceBase } from "../../marketplace/service/client.js";
import { readModelCatalogRefreshPolicy } from "../../core/model-catalog/refresh-policy.js";
import { readWindowsDirectoryDacls, win32SystemBinary, type WindowsDirectoryDacl } from "../../shared/ave-home.js";
import { initAdminPolicyAudit } from "../../lib/admin-policy-file.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";

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

  it("omits machine-owned roots from both Windows deny sets", () => {
    const machine = process.env.ProgramData!;
    vi.stubEnv("ProgramFiles", join(root, "programs"));
    vi.stubEnv("ProgramFiles(x86)", join(root, "programs-x86"));
    vi.stubEnv("CommonProgramFiles", join(root, "common"));
    vi.stubEnv("ProgramW6432", join(root, "programs64"));
    const paths = [admin, join(process.env.ProgramFiles!, "absent"), join(process.env["ProgramFiles(x86)"]!, "absent"), join(process.env.CommonProgramFiles!, "absent"), join(process.env.ProgramW6432!, "absent"), join(process.env.SystemRoot!, "absent-policy")];
    const config = buildSandboxConfig({ allowedDomains: [], allowWrite: [machine], denyRead: paths, denyWrite: paths });
    const denies = [...config.filesystem.denyRead, ...config.filesystem.denyWrite].map((entry) => typeof entry === "string" ? entry : entry.path);
    expect(denies.filter((path) => path.toLowerCase().startsWith(machine.toLowerCase()))).toEqual([]);
    for (const path of paths) expect(denies).not.toContain(path);
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
    await expect(readPolicyServiceBase(admin)).rejects.toThrow(`untrusted policy file at ${admin}`);
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
    execFileSync(win32SystemBinary("icacls"), [parent, "/inheritance:r", "/grant:r", "*S-1-5-32-544:(OI)(CI)F", "*S-1-5-18:(OI)(CI)F", "/setowner", "*S-1-5-32-544", "/q"], { windowsHide: true });
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
