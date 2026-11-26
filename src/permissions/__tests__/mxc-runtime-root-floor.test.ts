import { TEST_COMMAND_ID } from "../../__tests__/support/egress-fixture.js";
/**
 * The container runtime root holds what used to be staged under the Ave home. Moving it out must not make it readable:
 * it is on the same sandbox read floor as the other confined processes' private directories, so a process on the
 * sandbox route cannot read a container run's HOME, temp or sockets.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import * as runtime from "@anthropic-ai/sandbox-runtime";
import { restoreWindowsAcl, stampWindowsAcl } from "@anthropic-ai/sandbox-runtime/dist/sandbox/windows-sandbox-utils.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { hasNativeSrtWinBuildReceipt } from "../../__tests__/support/srt-win-build-receipts.js";
import { configureHostResources } from "../../main/host-resources.js";

import { aveHome } from "../../shared/ave-home.js";
import {
  appOwnedSandboxPrivateRoots, ensureSandboxTempPrincipalDir, getVendoredSrtWinExePath, protectedReadDenyCovering, getDefaultSensitiveReadDenyPaths, getDefaultSensitiveWriteDenyPaths,
  initializeAsrtSandbox, isAsrtSandboxActive, resetAsrtSandbox, wrapWorkerCommand,
} from "../asrt-sandbox.js";
import {
  _forgetMxcRuntimeRootForTest, AVE_APP_ID, createMxcRunStaging, currentMxcRuntimeHost, establishMxcRuntimeRoot, mxcRuntimeRootFloorPath,
  MxcRuntimeRootError, mxcStagingParent, removeMxcRunStaging, requireMxcRuntimeRoot,
} from "../mxc-runtime-root.js";
import { WINDOWS_RUNTIME_HOST, windowsRuntimeRootFailure } from "../mxc-runtime-root-windows.js";
import { readWindowsDenyAcls, WINDOWS_READ_DENY_MASK } from "../windows-deny-acl.js";
import { asrtCanInitialize } from "./test-helpers.js";

const posix = process.platform === "darwin" || process.platform === "linux";
const darwin = process.platform === "darwin";

describe.runIf(posix)("container runtime root on the sandbox read floor", () => {
  it("is one of the private roots every wrap is denied, and lies outside the Ave home", () => {
    const root = mxcRuntimeRootFloorPath();
    expect(appOwnedSandboxPrivateRoots()).toContain(root);
    expect(getDefaultSensitiveReadDenyPaths()).toContain(root);
    const home = aveHome();
    expect(root === home || root.startsWith(`${home}/`) || home.startsWith(`${root}/`)).toBe(false);
  });
});

describe.runIf(darwin)("a sandboxed process and a container run's directories", () => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "ave-rt-floor-")));
  // The run's test directory may itself sit under a denied directory; a base of its own leaves the floor as the only deny that covers the runtime root.
  const inheritedBase = process.env.AVE_TEST_SANDBOX_BASE;
  beforeAll(() => {
    mkdirSync(join(outside, "base"));
    process.env.AVE_TEST_SANDBOX_BASE = join(outside, "base");
  });
  afterAll(async () => {
    await resetAsrtSandbox();
    if (inheritedBase === undefined) delete process.env.AVE_TEST_SANDBOX_BASE;
    else process.env.AVE_TEST_SANDBOX_BASE = inheritedBase;
    rmSync(outside, { recursive: true, force: true });
  });

  it("cannot read or list the run's HOME, while a read outside the floor works", async () => {
    if (!(await asrtCanInitialize())) {
      if (process.env.AVE_REQUIRE_SANDBOX_CASES === "1") throw new Error("ASRT cannot initialize on this machine");
      return;
    }
    await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
    // As sandbox start-up does, before the first wrap.
    establishMxcRuntimeRoot();
    const run = createMxcRunStaging();
    expect(run.root.startsWith(`${outside}/base/`)).toBe(true);
    try {
      writeFileSync(join(run.home, "state"), "private");
      writeFileSync(join(outside, "control"), "readable");
      const { dir: tempDir } = ensureSandboxTempPrincipalDir({ kind: "plugin", id: "runtime-root-floor" });
      const script = [
        `cat '${join(run.home, "state")}' 2>/dev/null; echo "run-read=$?"`,
        `ls '${run.home}' >/dev/null 2>&1; echo "run-list=$?"`,
        `ls '${mxcRuntimeRootFloorPath()}' >/dev/null 2>&1; echo "root-list=$?"`,
        `cat '${join(outside, "control")}' >/dev/null 2>&1; echo "control-read=$?"`,
      ].join("\n");
      const wrapped = await wrapWorkerCommand(script, {
        commandId: TEST_COMMAND_ID,
        filesystem: { allowWrite: [tempDir], allowRead: [], denyWrite: getDefaultSensitiveWriteDenyPaths(), pinWriteRoots: true },
      });
      const [program, ...args] = wrapped.argv;
      const result = spawnSync(program as string, args, { encoding: "utf8" });
      expect(result.stdout).not.toContain("private");
      expect(result.stdout.trim().split("\n")).toEqual([
        expect.stringMatching(/^run-read=[1-9]/u), expect.stringMatching(/^run-list=[1-9]/u),
        expect.stringMatching(/^root-list=[1-9]/u), "control-read=0",
      ]);
    } finally {
      removeMxcRunStaging(run);
    }
  });
});

describe.runIf(posix)("a cache directory that cannot hold the runtime root", () => {
  const outside = realpathSync(mkdtempSync(join(tmpdir(), "ave-rt-broken-")));
  const inheritedBase = process.env.AVE_TEST_SANDBOX_BASE;
  const spelled = join(outside, "base", "mxc-cache", AVE_APP_ID, "mxc-runtime");
  beforeAll(() => {
    mkdirSync(join(outside, "base"));
    // A file where the account's cache directory should be.
    writeFileSync(join(outside, "base", "mxc-cache"), "");
    process.env.AVE_TEST_SANDBOX_BASE = join(outside, "base");
  });
  afterAll(async () => {
    await resetAsrtSandbox();
    if (inheritedBase === undefined) delete process.env.AVE_TEST_SANDBOX_BASE;
    else process.env.AVE_TEST_SANDBOX_BASE = inheritedBase;
    rmSync(outside, { recursive: true, force: true });
  });

  it("still composes the read floor, with the root's path as spelled", () => {
    expect(mxcRuntimeRootFloorPath()).toBe(spelled);
    expect(appOwnedSandboxPrivateRoots()).toContain(spelled);
    expect(getDefaultSensitiveReadDenyPaths()).toContain(spelled);
  });

  it("refuses container starts only", () => {
    expect(() => establishMxcRuntimeRoot()).toThrow(MxcRuntimeRootError);
    expect(() => createMxcRunStaging()).toThrow(MxcRuntimeRootError);
  });

  it.runIf(darwin)("leaves the sandbox initialized and shells sandboxed", async () => {
    if (!(await asrtCanInitialize())) {
      if (process.env.AVE_REQUIRE_SANDBOX_CASES === "1") throw new Error("ASRT cannot initialize on this machine");
      return;
    }
    await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
    expect(isAsrtSandboxActive()).toBe(true);
    writeFileSync(join(outside, "control"), "readable");
    const { dir: tempDir } = ensureSandboxTempPrincipalDir({ kind: "plugin", id: "runtime-root-broken" });
    const wrapped = await wrapWorkerCommand(`cat '${join(outside, "control")}'; echo x > '${join(outside, "written")}' 2>/dev/null; echo "write=$?"`, {
      commandId: TEST_COMMAND_ID,
      filesystem: { allowWrite: [tempDir], allowRead: [], denyWrite: getDefaultSensitiveWriteDenyPaths(), pinWriteRoots: true },
    });
    const [program, ...args] = wrapped.argv;
    const result = spawnSync(program as string, args, { encoding: "utf8" });
    // Sandboxed as ever: it runs, reads, and cannot write outside its grant.
    expect(result.stdout).toMatch(/^readablewrite=[1-9]/u);
  });
});

const windows = process.platform === "win32";

describe.runIf(windows)("container runtime root on the Windows sandbox read floor", () => {
  beforeAll(() => { configureHostResources({ resourcePath: resolve("resources"), isPackaged: false }); });
  it("is the one private root every wrap is denied, and lies outside the Ave home", () => {
    const root = mxcRuntimeRootFloorPath();
    expect(appOwnedSandboxPrivateRoots()).toEqual([root + sep]);
    expect(getDefaultSensitiveReadDenyPaths()).toContain(root + sep);
    const [home, floor] = [aveHome().toLowerCase() + sep, root.toLowerCase() + sep];
    expect(floor.startsWith(home) || home.startsWith(floor)).toBe(false);
  });

  it("covers a run's staged home and temp, and not a sibling of the root", () => {
    const root = mxcRuntimeRootFloorPath();
    const floor = appOwnedSandboxPrivateRoots();
    for (const inside of [root, join(root, "staging"), join(root, "staging", "0123456789abcdef0123456789abcdef", "home"), join(root.toUpperCase(), "staging")]) {
      expect(protectedReadDenyCovering(inside, floor), inside).toBeDefined();
    }
    for (const outside of [`${root}-other`, join(root, ".."), join(root, "..", "sibling")]) {
      expect(protectedReadDenyCovering(outside, floor), outside).toBeUndefined();
    }
  });
});

describe.runIf(windows && hasNativeSrtWinBuildReceipt())("the sandbox account's deny on a real Windows runtime root", () => {
  const cacheHome = realpathSync.native(mkdtempSync(join(tmpdir(), "ave-rt-floor-")));
  const host = { ...currentMxcRuntimeHost(), cacheHome };
  beforeAll(() => { configureHostResources({ resourcePath: resolve("resources"), isPackaged: false }); });
  afterAll(() => {
    _forgetMxcRuntimeRootForTest(cacheHome);
    rmSync(cacheHome, { recursive: true, force: true });
  });

  it("stamps the read deny on the root, keeps the root usable by the host, and restores it", (context) => {
    const srtWin = runtime.resolveSrtWin({ path: getVendoredSrtWinExePath() });
    const sid = runtime.getWindowsSandboxUserStatus({ srtWin }).sid;
    if (!sid) {
      if (process.env.AVE_REQUIRE_SANDBOX_CASES === "1") throw new Error("AVE_REQUIRE_SANDBOX_CASES=1 but the sandbox account has no SID on this machine");
      return context.skip();
    }
    const root = establishMxcRuntimeRoot(host);
    expect(root).toBe(mxcRuntimeRootFloorPath(cacheHome));
    expect(readWindowsDenyAcls([root], sid)[0]?.denyMask).toBe(0);
    try {
      stampWindowsAcl({ sandboxUserSid: sid, srtWin, denyRead: [root], denyWrite: [] });
      const stamped = readWindowsDenyAcls([root], sid)[0];
      expect(stamped?.denyMask).toBe(WINDOWS_READ_DENY_MASK);
      expect(stamped?.inheritableMask).toBe(WINDOWS_READ_DENY_MASK);
      // A deny for another principal takes nothing from the owner-only proof: the root still passes it and still stages.
      expect(windowsRuntimeRootFailure(WINDOWS_RUNTIME_HOST.readFacts(root), root)).toBeUndefined();
      expect(requireMxcRuntimeRoot(host)).toBe(root);
      expect(mxcStagingParent("win32", host)).toBe(join(root, "staging"));
    } finally {
      restoreWindowsAcl({ sandboxUserSid: sid, srtWin });
    }
    expect(readWindowsDenyAcls([root], sid)[0]?.denyMask).toBe(0);
    expect(windowsRuntimeRootFailure(WINDOWS_RUNTIME_HOST.readFacts(root), root)).toBeUndefined();
  });
});
