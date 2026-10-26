import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import { join, relative } from "node:path";
import * as runtime from "@anthropic-ai/sandbox-runtime";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TEST_COMMAND_ID } from "../../__tests__/support/egress-fixture.js";
import { useVerifiedAveHomePrivacy } from "../../__tests__/support/ave-home-privacy.js";
import { initializeRequiredSandbox } from "../../__tests__/support/native-sandbox.js";
import { checkAsrtDependencies, isAsrtSandboxActive, resetAsrtSandbox, wrapToolCommand } from "../asrt-sandbox.js";
import { windowsSandboxCanSpawn } from "./test-helpers.js";
import { holdWindowsFilesystemGrant } from "../windows-acl-grant-holder.js";

useVerifiedAveHomePrivacy();

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
}));

describe.runIf(process.platform === "win32")("Windows absent deny native enforcement", () => {
  let root: string;

  beforeEach(async (context) => {
    root = mkdtempSync(join(os.tmpdir(), "deny-absent-native-"));
    vi.stubEnv("HOME", root);
    vi.stubEnv("USERPROFILE", root);
    vi.spyOn(os, "homedir").mockReturnValue(root);
    vi.spyOn(os, "userInfo").mockReturnValue({ ...os.userInfo(), homedir: root });
    const dependencies = await checkAsrtDependencies();
    if (dependencies.errors.length > 0) {
      const reason = `Native Windows sandbox unavailable: ${dependencies.errors.join("; ")}`;
      console.warn(reason);
      context.skip(reason);
    }
    if (!(await windowsSandboxCanSpawn())) context.skip("Native Windows sandbox cannot spawn on this host; see capability warning");
    const manager = runtime.SandboxManager;
    const initialize = manager.initialize.bind(manager);
    const wrap = manager.wrapWithSandboxArgv.bind(manager);
    const inside = (entry: runtime.FilesystemPathEntry) => {
      const path = typeof entry === "string" ? entry : entry.path;
      const rel = relative(root, path);
      return rel === "" || (!rel.startsWith("..") && !rel.includes(":"));
    };
    vi.spyOn(manager, "wrapWithSandboxArgv").mockImplementation((command, shell, custom, ...rest) =>
      wrap(command, shell, custom?.filesystem ? { ...custom, filesystem: { ...custom.filesystem,
        denyRead: custom.filesystem.denyRead?.filter(inside), denyWrite: custom.filesystem.denyWrite?.filter(inside),
      } } : custom, ...rest));
    vi.spyOn(manager, "initialize").mockImplementation(async (next, ask, monitor) => {
      await initialize({ ...next, filesystem: { ...next.filesystem,
        denyRead: next.filesystem.denyRead.filter(inside), denyWrite: next.filesystem.denyWrite.filter(inside),
      } }, ask, monitor);
    });
  });

  afterEach(async () => {
    if (isAsrtSandboxActive()) await resetAsrtSandbox();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it("does not materialize a missing git leaf outside write grants during native initialization and reset", async () => {
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    await initializeRequiredSandbox({ denyWrite: [join(workspace, ".git")] });
    await resetAsrtSandbox();
    expect(lstatSync(join(workspace, ".git"), { throwIfNoEntry: false })).toBeUndefined();
    expect(lstatSync(join(workspace, ".git", "modules"), { throwIfNoEntry: false })).toBeUndefined();
    expect(lstatSync(join(workspace, ".git", "worktrees"), { throwIfNoEntry: false })).toBeUndefined();
  }, 60_000);

  it("does not create an absent deny target during native initialization or execution", async () => {
    const absent = join(root, "absent", "secret");
    await initializeRequiredSandbox({ allowRead: [root], denyRead: [absent], denyWrite: [absent] });
    expect(lstatSync(absent, { throwIfNoEntry: false })).toBeUndefined();
    const wrapped = await wrapToolCommand("echo fixture-ok", { commandId: TEST_COMMAND_ID,
      filesystem: { denyRead: [absent], denyWrite: [absent] } });
    execFileSync(wrapped.argv[0]!, wrapped.argv.slice(1), { env: { ...process.env, ...wrapped.env }, cwd: root, windowsHide: true });
    await resetAsrtSandbox();
    expect(lstatSync(absent, { throwIfNoEntry: false })).toBeUndefined();
    expect(lstatSync(join(root, "absent"), { throwIfNoEntry: false })).toBeUndefined();
  }, 60_000);

  it("protects an earlier native wrap while a later worker grant permits a sibling write", async () => {
    const workspace = join(root, "workspace");
    mkdirSync(workspace);
    const target = join(workspace, "secret");
    const sibling = join(workspace, "allowed");
    await initializeRequiredSandbox({ allowRead: [root], denyRead: [target], denyWrite: [target] });
    const earlier = await wrapToolCommand(`echo unsafe > "${target}"`, { commandId: TEST_COMMAND_ID });
    expect(lstatSync(target, { throwIfNoEntry: false })).toBeUndefined();
    const held = await holdWindowsFilesystemGrant({ label: "absent-deny-native", allowRead: [], allowWrite: [workspace] });
    try {
      expect(lstatSync(target, { throwIfNoEntry: false })).toBeDefined();
      const allowed = await wrapToolCommand(`echo allowed > "${sibling}"`, { commandId: TEST_COMMAND_ID });
      execFileSync(allowed.argv[0]!, allowed.argv.slice(1), { env: { ...process.env, ...allowed.env }, cwd: root, windowsHide: true });
      expect(readFileSync(sibling, "utf8")).toContain("allowed");
      expect(() => execFileSync(earlier.argv[0]!, earlier.argv.slice(1), {
        env: { ...process.env, ...earlier.env }, cwd: root, windowsHide: true,
      })).toThrow();
      expect(readFileSync(target, "utf8")).not.toContain("unsafe");
    } finally {
      held.release();
    }
  }, 60_000);
});
