import { existsSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { sweepSandboxPrivateRoots } from "../../boot/steps/sandbox-init.js";
import { isSensitivePath, createSensitiveLocationMatcher, caseFoldForMatch, canonicalizePathForMatch } from "../sensitive-paths.js";
import { createSandboxActionDirectory, isSandboxActionDirectory, releaseSandboxActionDirectory, sandboxActionDirectoriesInUse } from "../sandbox-action-directory.js";
import { appOwnedSandboxActionRoot, appOwnedSandboxPrivateRoots, buildPerCommandSandboxCustomConfig, getDefaultSensitiveWriteDenyPaths,
  getOwnedSandboxActionWriteDenyPaths, getProtectedReadDenyFloor, wrapToolCommand } from "../asrt-sandbox.js";
import { openEgressInvocation } from "../egress-invocations.js";

describe("private sandbox action directories", () => {
  it("creates unique tracked directories and keeps live data during the boot sweep", async () => {
    const first = createSandboxActionDirectory();
    const second = createSandboxActionDirectory();
    try {
      expect(first.path).not.toBe(second.path);
      expect(dirname(first.path)).toBe(realpathSync.native(appOwnedSandboxActionRoot()));
      expect(isSandboxActionDirectory(first.path)).toBe(true);
      expect(sandboxActionDirectoriesInUse().has(first.path)).toBe(true);
      writeFileSync(join(first.path, "kept"), "kept");
      const stale = join(appOwnedSandboxActionRoot(), "stale-action");
      mkdirSync(stale, { recursive: true });
      await sweepSandboxPrivateRoots();
      expect(existsSync(stale)).toBe(false);
      expect(existsSync(join(first.path, "kept"))).toBe(true);
    } finally { first.cleanup(); second.cleanup(); }
    expect(isSandboxActionDirectory(first.path)).toBe(false);
    expect(existsSync(first.path)).toBe(false);
  });

  it("blocks host file reads, writes and recursive parent scans without changing the protected floor", () => {
    const directory = createSandboxActionDirectory();
    try {
      const workbook = join(directory.path, "workbook.xlsx");
      expect(isSensitivePath(workbook, "read")).toBe("sandbox-action-data");
      expect(isSensitivePath(workbook, "write")).toBe("sandbox-action-data");
      expect(createSensitiveLocationMatcher()(caseFoldForMatch(canonicalizePathForMatch(appOwnedSandboxActionRoot())))).toBeTruthy();
      expect(getDefaultSensitiveWriteDenyPaths()).toContain(appOwnedSandboxActionRoot());
      expect(getOwnedSandboxActionWriteDenyPaths(directory.path)).not.toContain(appOwnedSandboxActionRoot());
      expect(getProtectedReadDenyFloor()).not.toContain(appOwnedSandboxActionRoot());
    } finally { directory.cleanup(); }
  });

  it("releases only minted live capabilities and leaves stale paths untouched", () => {
    const directory = createSandboxActionDirectory();
    releaseSandboxActionDirectory(directory.path);
    expect(existsSync(directory.path)).toBe(false);
    mkdirSync(directory.path);
    try {
      expect(isSandboxActionDirectory(directory.path)).toBe(false);
      directory.cleanup();
      releaseSandboxActionDirectory(directory.path);
      expect(existsSync(directory.path)).toBe(true);
    } finally { rmSync(directory.path, { recursive: true, force: true }); }
  });

  it("retains whole-root denial for ordinary policies and narrows a live action policy", () => {
    const directory = createSandboxActionDirectory();
    try {
      const ordinary = buildPerCommandSandboxCustomConfig({ allowWrite: [dirname(appOwnedSandboxActionRoot())] });
      expect(ordinary?.filesystem?.denyWrite).toContain(appOwnedSandboxActionRoot());
      const owned = buildPerCommandSandboxCustomConfig({ allowWrite: [directory.path] }, undefined, undefined, undefined, {}, directory.path);
      expect(owned?.filesystem?.denyWrite).not.toContain(appOwnedSandboxActionRoot());
      expect(owned?.filesystem?.allowWrite).toContain(directory.path);
    } finally { directory.cleanup(); }
  });

  it("includes the action root in private roots on Windows too", () => {
    const platform = process.platform;
    setProcessPlatform("win32");
    try { expect(appOwnedSandboxPrivateRoots()).toContain(appOwnedSandboxActionRoot()); }
    finally { setProcessPlatform(platform); }
  });

  it("refuses an ordinary actor claiming a live action directory", async () => {
    const directory = createSandboxActionDirectory();
    const invocation = openEgressInvocation({ kind: "worker", role: "worker", pluginId: undefined });
    try {
      await expect(wrapToolCommand("true", { commandId: invocation.token, actionDirectory: directory.path,
        filesystem: { allowWrite: [directory.path] } })).rejects.toThrow("action directory is unauthorized");
    } finally { invocation.release(); directory.cleanup(); }
  });

  it("refuses broad or sibling grants even for a user document actor", async () => {
    const first = createSandboxActionDirectory();
    const second = createSandboxActionDirectory();
    const invocation = openEgressInvocation({ kind: "user-document", action: "workbook" });
    try {
      for (const grant of [appOwnedSandboxActionRoot(), second.path]) {
        await expect(wrapToolCommand("true", { commandId: invocation.token, actionDirectory: first.path,
          filesystem: { allowWrite: [first.path, grant] } })).rejects.toThrow("grants exceed their directory");
      }
    } finally { invocation.release(); first.cleanup(); second.cleanup(); }
  });
});
