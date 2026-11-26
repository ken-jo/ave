// windows-permission
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { SandboxManager } from "@anthropic-ai/sandbox-runtime";
import { isAdmittedWindowsEntry } from "@anthropic-ai/sandbox-runtime/dist/sandbox/windows-sandbox-utils.js";
import { configureHostResources } from "../../main/host-resources.js";
import { buildPerCommandSandboxCustomConfig, buildSandboxConfig, getBuiltinShellReadPolicy } from "../asrt-sandbox.js";

vi.mock("node:os", async importOriginal => ({
  ...await importOriginal<typeof import("node:os")>(),
  userInfo: () => ({ homedir: process.env.USERPROFILE, username: "alice", uid: -1, gid: -1, shell: null }),
}));

describe.runIf(process.platform === "win32")("Windows deny origin", () => {
  let root: string;
  let profile: string;
  let target: string;

  beforeAll(() => configureHostResources({ resourcePath: resolve("resources"), isPackaged: false }));
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "deny-origin-"));
    profile = join(root, "alice");
    target = join(profile, ".aws");
    mkdirSync(profile);
    const appHome = join(root, "application-data");
    mkdirSync(appHome);
    vi.stubEnv("HOME", profile);
    vi.stubEnv("USERPROFILE", profile);
    vi.stubEnv("AVE_HOME", appHome);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  function names(entries: readonly (string | { path: string })[] = []): string[] {
    return entries.map(entry => (typeof entry === "string" ? entry : entry.path).replace(/[\\/]+$/u, ""));
  }

  // An absent row is never stamped, whatever named it: the stamp would create it.
  it("never stamps an absent user credential subtree and keeps it once it exists", () => {
    expect(names(buildSandboxConfig({}).filesystem.denyRead)).not.toContain(target);
    expect(names(buildSandboxConfig({ denyRead: ["~/.aws/**"] }).filesystem.denyRead)).not.toContain(target);
    expect(existsSync(target)).toBe(false);
    mkdirSync(target);
    const configured = buildSandboxConfig({ denyRead: ["~/.aws/**"] });
    expect(names(configured.filesystem.denyRead).filter(path => path === target)).toEqual([target]);
  });

  it("keeps an explicit per-command deny on a present protected directory and never creates an absent one", () => {
    expect(names(buildPerCommandSandboxCustomConfig({ denyRead: [`${target}\\`] })?.filesystem?.denyRead)).not.toContain(target);
    expect(existsSync(target)).toBe(false);
    mkdirSync(target);
    const config = buildPerCommandSandboxCustomConfig({ denyRead: [`${target}\\`] });
    expect(names(config?.filesystem?.denyRead)).toContain(target);
  });

  it("drops a shell's restated absent floor row and an explicit one alike, and keeps one row once it exists", () => {
    const shell = getBuiltinShellReadPolicy([root], profile);
    expect(names(shell.denyRead)).toContain(target);
    expect(names(buildPerCommandSandboxCustomConfig({ denyRead: shell.denyRead })?.filesystem?.denyRead)).not.toContain(target);
    const explicit = () => buildPerCommandSandboxCustomConfig({ denyRead: [...shell.denyRead, `${target}\\`] });
    expect(names(explicit()?.filesystem?.denyRead)).not.toContain(target);
    expect(existsSync(target)).toBe(false);
    mkdirSync(target);
    expect(names(explicit()?.filesystem?.denyRead).filter(path => path === target)).toEqual([target]);
  });

  it("admits the literal privacy floor under a bracketed application home", () => {
    const appHome = join(root, "application-data [1]");
    const keys = join(appHome, "keys");
    mkdirSync(keys, { recursive: true });
    vi.stubEnv("AVE_HOME", appHome);

    const config = buildSandboxConfig({ windows: { externalConfinement: true } });
    expect(names(config.filesystem.denyRead)).toContain(appHome);
    expect(names(config.filesystem.denyWrite)).toContain(keys);
  });

  it("keeps strict admission across config updates and per-command composition", async () => {
    const config = buildSandboxConfig({ allowRead: [root], windows: { externalConfinement: true } });
    const strictError = expect.objectContaining({ code: "unadmitted_fs_entry" });
    expect(config.windows?.admittedEntriesOnly).toBe(true);
    const malformed = { ...config, filesystem: { ...config.filesystem, allowRead: [root] } };
    await expect(SandboxManager.initialize(malformed)).rejects.toMatchObject(strictError);
    try {
      SandboxManager.updateConfig(config);
      expect(SandboxManager.getConfig()?.filesystem.allowRead).toEqual(config.filesystem.allowRead);
      expect(() => SandboxManager.updateConfig(malformed)).toThrow(strictError);
      expect(() => SandboxManager.updateConfig({ ...config, windows: { ...config.windows, admittedEntriesOnly: false } }))
        .toThrow(strictError);
      expect(SandboxManager.getConfig()?.filesystem.allowRead?.every(isAdmittedWindowsEntry)).toBe(true);
      const custom = buildPerCommandSandboxCustomConfig({ denyRead: [target] });
      expect(custom?.windows?.admittedEntriesOnly).toBe(true);
      expect(custom?.filesystem?.denyRead.every(isAdmittedWindowsEntry)).toBe(true);
    } finally {
      await SandboxManager.reset();
    }
  });
});
