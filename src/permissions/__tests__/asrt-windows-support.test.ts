import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as asrtSandbox from "../asrt-sandbox.js";
import * as srtWinIntegrity from "../srt-win-integrity.js";
import { classifySandboxDependencyErrors } from "../sandbox-start-failure.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

beforeEach(() => { vi.stubEnv("SystemRoot", "C:\\Windows"); });
afterEach(() => { vi.unstubAllEnvs(); });

import {
  grantAsrtWindowsBackendAcl,
  installAsrtWindowsSandbox,
  isAsrtWindowsReady,
  normalizeAsrtWindowsUserState,
  normalizeAsrtWindowsWfpState,
  readAsrtWindowsStatus,
  resolveAsrtWindowsReady,
} from "../asrt-windows-support.js";

// Mock only the combined async status probe; keep install helpers and errors real.
const { checkWindowsSandboxStatusAsyncMock } = vi.hoisted(() => ({
  checkWindowsSandboxStatusAsyncMock: vi.fn(),
}));
vi.mock("@anthropic-ai/sandbox-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@anthropic-ai/sandbox-runtime")>();
  return {
    ...actual,
    checkWindowsSandboxStatusAsync: checkWindowsSandboxStatusAsyncMock,
  };
});

// Initialization failure must revoke acquired ACLs. Match rollback inside a catch that clears config and rethrows the same error; teardown substrings cannot prove it. Match structure rather than minified identifiers.
function rollsBackWindowsAclOnFailedInitialize(source: string): boolean {
  const failClosed = new RegExp(
    String.raw`catch\s*\(\s*([A-Za-z_$][\w$]*)\s*\)\s*\{([\s\S]{0,1500}?)` +
      String.raw`config\s*=\s*undefined\s*;\s*throw\s+\1\s*;`,
    "g",
  );
  for (const match of source.matchAll(failClosed)) {
    const body = match[2] ?? "";
    if (
      /revokeWindowsAcl\(\s*\{\s*sandboxUserSid\s*:/.test(body)
      && /restoreWindowsAcl\(\s*\{\s*sandboxUserSid\s*:/.test(body)
    ) {
      return true;
    }
  }
  return false;
}

function readAsrtSandboxManagerSource(): string {
  const require = createRequire(import.meta.url);
  const indexPath = require.resolve("@anthropic-ai/sandbox-runtime");
  return readFileSync(join(dirname(indexPath), "sandbox", "sandbox-manager.js"), "utf-8");
}

function readAsrtWindowsUtilsSource(): string {
  const require = createRequire(import.meta.url);
  const indexPath = require.resolve("@anthropic-ai/sandbox-runtime");
  return readFileSync(
    join(dirname(indexPath), "sandbox", "windows-sandbox-utils.js"),
    "utf-8",
  );
}

const READY_USER = {
  provisioned: true,
  sid: "S-1-5-21-1",
  groupExists: true,
  inBuiltinUsers: true,
  inSandboxGroup: true,
  hiddenFromLogon: true,
  credPresent: true,
};

describe("asrt-windows-support adapter", () => {
  it("keeps a development package root unchanged and uses absolute System32 icacls", async () => {
    const exec = vi.fn((
      _file: string,
      _args: readonly string[],
      _options: { readonly env?: NodeJS.ProcessEnv; readonly windowsHide?: boolean },
      callback: (error: Error | null) => void,
    ) => callback(null));
    const packageRoot = String.raw`C:\workspace\ave\node_modules\@anthropic-ai\sandbox-runtime`;

    await grantAsrtWindowsBackendAcl({
      execFile: exec,
      pathExists: () => true,
      resolvePackageRoot: () => packageRoot,
      systemRoot: String.raw`C:\Windows`,
    });

    expect(exec).toHaveBeenCalledWith(
      String.raw`C:\Windows\System32\icacls.exe`,
      [packageRoot, "/grant", "sandbox-runtime-users:(OI)(CI)(RX)", "/T", "/C"],
      { windowsHide: true },
      expect.any(Function),
    );
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("targets the resolved ASRT package root by default", async () => {
    const exec = vi.fn((
      _file: string,
      _args: readonly string[],
      _options: { readonly env?: NodeJS.ProcessEnv; readonly windowsHide?: boolean },
      callback: (error: Error | null) => void,
    ) => callback(null));
    const require = createRequire(import.meta.url);
    const packageRoot = dirname(
      require.resolve("@anthropic-ai/sandbox-runtime/package.json"),
    );

    await grantAsrtWindowsBackendAcl({ execFile: exec });

    expect(exec).toHaveBeenCalledWith(
      expect.stringMatching(/[\\/]System32[\\/]icacls\.exe$/i),
      expect.arrayContaining([packageRoot]),
      { windowsHide: true },
      expect.any(Function),
    );
  });

  it("maps an exact packaged app.asar segment to the physical unpacked package", async () => {
    const exec = vi.fn((
      _file: string,
      _args: readonly string[],
      _options: { readonly env?: NodeJS.ProcessEnv; readonly windowsHide?: boolean },
      callback: (error: Error | null) => void,
    ) => callback(null));
    const virtualRoot = String.raw`C:\Program Files\Ave\resources\app.asar\node_modules\@anthropic-ai\sandbox-runtime`;
    const physicalRoot = String.raw`C:\Program Files\Ave\resources\app.asar.unpacked\node_modules\@anthropic-ai\sandbox-runtime`;
    const pathExists = vi.fn((path: string) => path === physicalRoot);

    await grantAsrtWindowsBackendAcl({
      execFile: exec,
      pathExists,
      resolvePackageRoot: () => virtualRoot,
      systemRoot: String.raw`C:\Windows`,
    });

    expect(pathExists).toHaveBeenCalledWith(physicalRoot);
    expect(exec).toHaveBeenCalledWith(
      String.raw`C:\Windows\System32\icacls.exe`,
      expect.arrayContaining([physicalRoot]),
      { windowsHide: true },
      expect.any(Function),
    );
  });

  it("does not rewrite a non-matching fooapp.asar.backup path segment", async () => {
    const exec = vi.fn((
      _file: string,
      _args: readonly string[],
      _options: { readonly env?: NodeJS.ProcessEnv; readonly windowsHide?: boolean },
      callback: (error: Error | null) => void,
    ) => callback(null));
    const packageRoot = String.raw`C:\Program Files\Ave\resources\fooapp.asar.backup\node_modules\@anthropic-ai\sandbox-runtime`;
    const pathExists = vi.fn((path: string) => path === packageRoot);

    await grantAsrtWindowsBackendAcl({
      execFile: exec,
      pathExists,
      resolvePackageRoot: () => packageRoot,
      systemRoot: String.raw`C:\Windows`,
    });

    expect(pathExists).toHaveBeenCalledWith(packageRoot);
    expect(exec).toHaveBeenCalledWith(
      String.raw`C:\Windows\System32\icacls.exe`,
      expect.arrayContaining([packageRoot]),
      { windowsHide: true },
      expect.any(Function),
    );
  });

  it("does not invoke icacls when the resolved physical target is missing", async () => {
    const exec = vi.fn();
    const warn = vi.fn();
    const virtualRoot = String.raw`C:\Program Files\Ave\resources\app.asar\node_modules\@anthropic-ai\sandbox-runtime`;

    await expect(
      grantAsrtWindowsBackendAcl({
        execFile: exec,
        pathExists: () => false,
        resolvePackageRoot: () => virtualRoot,
        systemRoot: String.raw`C:\Windows`,
        warn,
      }),
    ).resolves.toBeUndefined();

    expect(exec).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      "[sandbox] ASRT backend ACL grant failed (non-fatal)",
      expect.objectContaining({
        message: expect.stringContaining("does not exist"),
      }),
    );
  });

  it("keeps non-access ACL failures non-fatal without attempting elevation", async () => {
    const warn = vi.fn();
    const failure = Object.assign(new Error("spawn icacls ENOENT"), {
      code: "ENOENT",
    });
    const exec = vi.fn((
      _file: string,
      _args: readonly string[],
      _options: { readonly env?: NodeJS.ProcessEnv; readonly windowsHide?: boolean },
      callback: (error: Error | null) => void,
    ) => callback(failure));

    await expect(
      grantAsrtWindowsBackendAcl({
        execFile: exec,
        pathExists: () => true,
        resolvePackageRoot: () => String.raw`C:\asrt`,
        systemRoot: String.raw`C:\Windows`,
        warn,
      }),
    ).resolves.toBeUndefined();

    expect(exec).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "[sandbox] ASRT backend ACL grant failed (non-fatal)",
      failure,
    );
  });

  it.each([5, "EACCES", "EPERM"] as const)(
    "uses the fixed elevated fallback only for access-denied code %s",
    async (code) => {
      const warn = vi.fn();
      const accessDenied = Object.assign(new Error(`icacls access denied: ${code}`), { code });
      const packageRoot = String.raw`C:\Program Files\Ave\resources\app.asar.unpacked\node_modules\@anthropic-ai\sandbox-runtime`;
      let callCount = 0;
      const exec = vi.fn((
        _file: string,
        _args: readonly string[],
        _options: { readonly env?: NodeJS.ProcessEnv; readonly windowsHide?: boolean },
        callback: (error: Error | null) => void,
      ) => {
        callCount += 1;
        callback(callCount === 1 ? accessDenied : null);
      });

      await grantAsrtWindowsBackendAcl({
        execFile: exec,
        pathExists: () => true,
        resolvePackageRoot: () => packageRoot,
        systemRoot: String.raw`C:\Windows`,
        warn,
      });

      expect(exec).toHaveBeenCalledTimes(2);
      const [powershellPath, elevatedArgs, elevatedOptions] = exec.mock.calls[1]!;
      expect(powershellPath).toBe(
        String.raw`C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe`,
      );
      expect(elevatedArgs).toEqual([
        "-NoLogo",
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        expect.any(String),
      ]);
      const encodedCommand = elevatedArgs[elevatedArgs.indexOf("-EncodedCommand") + 1];
      const script = Buffer.from(encodedCommand!, "base64").toString("utf16le");
      expect(script).toContain("Start-Process");
      expect(script).toContain("-Verb RunAs");
      expect(script).not.toContain(packageRoot);
      expect(elevatedOptions).toMatchObject({
        env: {
          AVE_ASRT_ACL_TARGET: packageRoot,
          AVE_ASRT_ICACLS_PATH: String.raw`C:\Windows\System32\icacls.exe`,
        },
        windowsHide: true,
      });
      expect(warn).not.toHaveBeenCalled();
    },
  );

  it.each([1223, 1])(
    "keeps elevated ACL cancellation/non-zero exit %s warning-only and non-fatal",
    async (exitCode) => {
      const warn = vi.fn();
      const accessDenied = Object.assign(new Error("icacls exited 5"), { code: 5 });
      const elevatedFailure = Object.assign(new Error(`elevated icacls exited ${exitCode}`), {
        code: exitCode,
      });
      let callCount = 0;
      const exec = vi.fn((
        _file: string,
        _args: readonly string[],
        _options: { readonly env?: NodeJS.ProcessEnv; readonly windowsHide?: boolean },
        callback: (error: Error | null) => void,
      ) => {
        callCount += 1;
        callback(callCount === 1 ? accessDenied : elevatedFailure);
      });

      await expect(
        grantAsrtWindowsBackendAcl({
          execFile: exec,
          pathExists: () => true,
          resolvePackageRoot: () => String.raw`C:\asrt`,
          systemRoot: String.raw`C:\Windows`,
          warn,
        }),
      ).resolves.toBeUndefined();

      expect(exec).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith(
        "[sandbox] ASRT backend ACL elevated grant failed (non-fatal)",
        elevatedFailure,
      );
    },
  );

  it("awaits the backend ACL grant after install and before WFP verification", async () => {
    const events: string[] = [];

    const result = await installAsrtWindowsSandbox({
      loadRuntime: async () => ({
        installWindowsSandboxAsync: async () => {
          events.push("install");
          return {
            user: {
              provisioned: true,
              sid: "S-1-5-21-1",
              groupExists: true,
              inBuiltinUsers: true,
              inSandboxGroup: true,
              hiddenFromLogon: true,
              credPresent: true,
            },
            wfp: { state: "cannot-read" },
          };
        },
        verifyWindowsWfpEgress: async () => {
          events.push("verify");
          return { stderr: "BLOCKED" };
        },
      }),
      grantBackendAcl: async () => {
        events.push("acl");
      },
    });

    expect(events).toEqual(["install", "acl", "verify"]);
    expect(result).toEqual({
      outcome: "ready",
      userState: "ready",
      wfpState: "cannot-read",
      ready: true,
    });
  });

  it("does not grant the backend ACL when UAC is cancelled", async () => {
    const grantBackendAcl = vi.fn(async () => undefined);
    const verifyWindowsWfpEgress = vi.fn(async () => undefined);

    const result = await installAsrtWindowsSandbox({
      loadRuntime: async () => ({
        installWindowsSandboxAsync: async () => ({ cancelled: true }),
        verifyWindowsWfpEgress,
      }),
      grantBackendAcl,
    });

    expect(result).toEqual({ outcome: "cancelled", cancelled: true });
    expect(grantBackendAcl).not.toHaveBeenCalled();
    expect(verifyWindowsWfpEgress).not.toHaveBeenCalled();
  });

  it("returns timed-out for an install_timeout WindowsSandboxError (UAC left open)", async () => {
    // ASRT 0.0.80 installWindowsSandboxAsync throws WindowsSandboxError with code 'install_timeout' when the self-elevating subprocess is killed by the 120s spawn timeout with the UAC consent dialog still open. The adapter must surface that distinctly (not as a generic failure), and must NOT run the backend ACL grant or the WFP verification.
    const { WindowsSandboxError } = await import("@anthropic-ai/sandbox-runtime");
    const grantBackendAcl = vi.fn(async () => undefined);
    const verifyWindowsWfpEgress = vi.fn(async () => undefined);

    await expect(
      installAsrtWindowsSandbox({
        loadRuntime: async () => ({
          installWindowsSandboxAsync: async () => {
            throw new WindowsSandboxError(
              "install_timeout",
              "srt-win install timed out after 120000ms",
              "install",
            );
          },
          verifyWindowsWfpEgress,
        }),
        grantBackendAcl,
      }),
    ).resolves.toEqual({ outcome: "timed-out" });

    expect(grantBackendAcl).not.toHaveBeenCalled();
    expect(verifyWindowsWfpEgress).not.toHaveBeenCalled();
  });

  it("does not accept an install whose ambient write-deny stamping failed", async () => {
    // ASRT 0.0.73 added an install step that deny-stamps the stock world-writable system dirs for the sandbox user, with its own exit code (17 → 'install_ambient_failed'). The WFP filters and the sandbox user can both be in place when it fails, so the tempting reading is "mostly installed". It is not: the win32 capability Ave publishes claims `filesystem: true`, and that claim assumes those stamps landed. The adapter must reject the install rather than let a half-stamped machine publish filesystem confinement.
    const { WindowsSandboxError } = await import("@anthropic-ai/sandbox-runtime");
    const grantBackendAcl = vi.fn(async () => undefined);
    const verifyWindowsWfpEgress = vi.fn(async () => undefined);

    await expect(
      installAsrtWindowsSandbox({
        loadRuntime: async () => ({
          installWindowsSandboxAsync: async () => {
            throw new WindowsSandboxError(
              "install_ambient_failed",
              "srt-win install: ambient write-deny stamping failed",
              "install",
            );
          },
          verifyWindowsWfpEgress,
        }),
        grantBackendAcl,
      }),
    ).resolves.toEqual({ outcome: "failed", errorCode: "install_ambient_failed" });

    // Fail-closed: neither the backend ACL grant nor the readiness verification may run for an install that was not accepted.
    expect(grantBackendAcl).not.toHaveBeenCalled();
    expect(verifyWindowsWfpEgress).not.toHaveBeenCalled();
  });

  it("returns already-ready without asking for elevation when the sandbox is ready (#1608)", async () => {
    // Main reads status after the IPC entry has validated the click's gesture, so a slow read cannot outlive it; a ready sandbox needs no UAC prompt.
    const installWindowsSandboxAsync = vi.fn();
    const result = await installAsrtWindowsSandbox({
      readStatus: async () => ({ applicable: true, userState: "ready", wfpState: "cannot-read", ready: true, instructions: "" }),
      loadRuntime: async () => ({ installWindowsSandboxAsync, verifyWindowsWfpEgress: vi.fn() }),
      grantBackendAcl: vi.fn(),
    });
    expect(result).toEqual({ outcome: "already-ready", userState: "ready", wfpState: "cannot-read", ready: true });
    expect(installWindowsSandboxAsync).not.toHaveBeenCalled();
  });

  it("still installs when the pre-install status read fails", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const installWindowsSandboxAsync = vi.fn(async () => ({ cancelled: true as const }));
    const result = await installAsrtWindowsSandbox({
      readStatus: async () => {
        throw new Error("status spawn failed");
      },
      loadRuntime: async () => ({ installWindowsSandboxAsync, verifyWindowsWfpEgress: vi.fn() }),
      grantBackendAcl: vi.fn(),
    });
    expect(installWindowsSandboxAsync).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ outcome: "cancelled", cancelled: true });
    warn.mockRestore();
  });

  it("returns installed-unverified when the install ran but readiness is not proven (issue #1608)", async () => {
    // What an already-provisioned machine looks like from a non-elevated app whose WFP check cannot prove the fence: the install succeeds, nothing on the panel changes, and before this outcome the click read as a no-op.
    const { WindowsSandboxError } = await import("@anthropic-ai/sandbox-runtime");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const result = await installAsrtWindowsSandbox({
      loadRuntime: async () => ({
        installWindowsSandboxAsync: async () => ({ user: READY_USER, wfp: { state: "cannot-read" } }),
        verifyWindowsWfpEgress: async () => {
          throw new WindowsSandboxError("wfp_verify_unparseable", "unparseable", "wfp verify");
        },
      }),
      grantBackendAcl: async () => undefined,
    });
    expect(result).toEqual({ outcome: "installed-unverified", userState: "ready", wfpState: "cannot-read", ready: false });
    warn.mockRestore();
  });

  it("returns installed-unverified for an install result without user or WFP state", async () => {
    const result = await installAsrtWindowsSandbox({
      loadRuntime: async () => ({
        installWindowsSandboxAsync: async () => ({}) as never,
        verifyWindowsWfpEgress: vi.fn(),
      }),
      grantBackendAcl: async () => undefined,
    });
    expect(result).toEqual({ outcome: "installed-unverified", userState: "absent", wfpState: "absent", ready: false });
  });

  it("maps every other ASRT install error to failed with its stable code, and keeps the message in the main log", async () => {
    // ASRT's messages carry srt-win stdout/stderr and local paths (the user profile among them). The result crossing IPC carries the code only.
    const { WindowsSandboxError } = await import("@anthropic-ai/sandbox-runtime");
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    for (const code of ["install_wfp_failed", "install_user_failed", "install_config_conflict", "install_failed", "spawn_failed", "srt_win_not_found"] as const) {
      const detail = String.raw`srt-win: ${code} at C:\Users\example\AppData\Local\ave`;
      const result = await installAsrtWindowsSandbox({
        loadRuntime: async () => ({
          installWindowsSandboxAsync: async () => {
            throw new WindowsSandboxError(code, detail, "install");
          },
          verifyWindowsWfpEgress: vi.fn(),
        }),
        grantBackendAcl: vi.fn(),
      });
      expect(result).toEqual({ outcome: "failed", errorCode: code });
      expect(JSON.stringify(result)).not.toContain("AppData");
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Windows sandbox install failed"),
        expect.objectContaining({ errorCode: code, err: expect.objectContaining({ message: detail }) }),
      );
    }
    warn.mockRestore();
  });

  it("maps a non-ASRT install error, and an injected ACL grant that throws, to failed/unexpected", async () => {
    // The default grant is best-effort and never throws; the catch only keeps the never-throw contract against an injected implementation.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const thrown = await installAsrtWindowsSandbox({
      loadRuntime: async () => ({
        installWindowsSandboxAsync: async () => {
          throw new Error("boom");
        },
        verifyWindowsWfpEgress: vi.fn(),
      }),
      grantBackendAcl: vi.fn(),
    });
    expect(thrown).toEqual({ outcome: "failed", errorCode: "unexpected" });

    const acl = await installAsrtWindowsSandbox({
      loadRuntime: async () => ({
        installWindowsSandboxAsync: async () => ({ user: READY_USER, wfp: { state: "installed" } }),
        verifyWindowsWfpEgress: vi.fn(),
      }),
      grantBackendAcl: async () => {
        throw new Error("icacls refused");
      },
    });
    expect(acl).toEqual({ outcome: "failed", errorCode: "unexpected" });
    warn.mockRestore();
  });

  it("pins the srt-win install exit codes the outcomes rest on", () => {
    // 0 ok, 10 UAC cancelled, 12/13/14/17 the mapped failures; a renumbering upstream must come back here.
    const source = readAsrtWindowsUtilsSource();
    expect(source).toMatch(/r\.status === 0 \|\| r\.status === 10/);
    expect(source).toMatch(/r\.status === 10 \? \{ \.\.\.state, cancelled: true \}/);
    for (const [exit, code] of [[12, "install_wfp_failed"], [13, "install_config_conflict"], [14, "install_user_failed"], [17, "install_ambient_failed"]] as const) {
      expect(source).toMatch(new RegExp(`case ${exit}:\\s*throw new WindowsSandboxError\\('${code}'`));
    }
    expect(source).toContain("'install_timeout'");
  });

  it("pins the ambient write-deny exit code the adapter maps", () => {
    // The mapping above is only meaningful while ASRT still emits this code. If upstream renumbers or drops the ambient stamping step, this fails and sends us back to the adapter instead of leaving a mapping for a code that no longer occurs.
    const source = readAsrtWindowsUtilsSource();
    expect(source).toMatch(/case 17:/);
    expect(source).toContain("install_ambient_failed");
  });

  it("pins Windows per-exec filesystem to deny-only", () => {
    // `assertPerExecFilesystemSupported` (asrt-sandbox.ts), the powershell win32 refusal, and the MCP-stdio win32 refusal all rest on ONE upstream fact: `srt-win exec` takes --deny-read/--deny-write but no allow grants. Pin it against the installed bundle so a version bump that ADDS allow grants surfaces here — those refusals would then be over-strict, not honest.
    const source = readAsrtWindowsUtilsSource();
    expect(source).toContain("'--deny-read'");
    expect(source).toContain("'--deny-write'");
    expect(source).not.toContain("'--allow-read'");
    expect(source).not.toContain("'--allow-write'");
  });

  it("reads readiness and profile read warnings in one status snapshot", async () => {
    const ORIGINAL_PLATFORM = process.platform;
    const warnings = [{ path: String.raw`D:\Users\tester\.ssh`, principals: ["Everyone"] as const },
      { path: String.raw`D:\Users\tester\.aws` }];
    const readWarnings = vi.spyOn(asrtSandbox, "getWindowsProfileReadDenyWarnings").mockReturnValue(warnings);
    Object.defineProperty(process, "platform", { value: "win32", configurable: true });
    // On a real Windows host the install cases above already reach `readAsrtWindowsStatus` through this mock, and nothing clears it between cases, so the call count below would include their calls.
    checkWindowsSandboxStatusAsyncMock.mockReset();
    checkWindowsSandboxStatusAsyncMock.mockResolvedValue({
      user: {
        provisioned: true,
        sid: "S-1-5-21-9",
        groupExists: true,
        inBuiltinUsers: true,
        inSandboxGroup: true,
        hiddenFromLogon: true,
        credPresent: true,
        realUserSid: "S-1-5-21-10",
      },
      wfp: { state: "installed", filters: 3 },
    });
    try {
      const status = await readAsrtWindowsStatus();

      // ONE status spawn — not the old two-spawn (user + wfp) path.
      expect(checkWindowsSandboxStatusAsyncMock).toHaveBeenCalledTimes(1);
      // Threaded the EXPLICIT srt-win descriptor (no implicit fallback since 0.0.67).
      expect(checkWindowsSandboxStatusAsyncMock.mock.calls[0]?.[0]).toMatchObject({
        srtWin: expect.objectContaining({ exe: expect.stringContaining("srt-win") }),
      });
      expect(status).toMatchObject({
        applicable: true,
        userState: "ready",
        wfpState: "installed",
        ready: true,
        profileReadDenyWarnings: warnings,
      });
    } finally {
      Object.defineProperty(process, "platform", {
        value: ORIGINAL_PLATFORM,
        configurable: true,
      });
      checkWindowsSandboxStatusAsyncMock.mockReset();
      readWarnings.mockRestore();
    }
  });

  it.each([
    ["srt-win-not-found", "windows-sandbox-missing"],
    ["srt-win-integrity-mismatch", "windows-sandbox-integrity-failed"],
  ] as const)("keeps %s from preparation through the boot dependency boundary", async (code, expected) => {
    const originalPlatform = process.platform;
    const cause = new srtWinIntegrity.SrtWinIntegrityError(code);
    const wrapped = new Error("Preparation failed", { cause });
    const prepare = vi.spyOn(srtWinIntegrity, "prepareSrtWinExecutable").mockImplementation(() => { throw wrapped; });
    const mod = await import("@anthropic-ai/sandbox-runtime");
    const resolver = vi.spyOn(mod, "resolveSrtWin");
    setProcessPlatform("win32");
    try {
      const deps = await asrtSandbox.checkAsrtDependencies();
      expect(deps.dependencyFailure).toBe(wrapped);
      expect(classifySandboxDependencyErrors("win32", deps.errors, deps.dependencyFailure)).toEqual([expected]);
      expect(resolver).not.toHaveBeenCalled();
    } finally {
      prepare.mockRestore();
      resolver.mockRestore();
      setProcessPlatform(originalPlatform);
    }
  });

  it("reports a missing helper without probing provisioned state, and observes restoration on the next read", async () => {
    const originalPlatform = process.platform;
    const originalBytes = readFileSync(asrtSandbox.getVendoredSrtWinExePath());
    const dir = mkdtempSync(join(tmpdir(), "ave-helper-status-"));
    const helperPath = join(dir, "srt-win.exe");
    const path = vi.spyOn(asrtSandbox, "getVendoredSrtWinExePath").mockReturnValue(helperPath);
    setProcessPlatform("win32");
    checkWindowsSandboxStatusAsyncMock.mockReset();
    checkWindowsSandboxStatusAsyncMock.mockResolvedValue({ user: READY_USER, wfp: { state: "installed" } });
    try {
      const missing = await readAsrtWindowsStatus();
      expect(missing).toMatchObject({
        applicable: true, userState: null, wfpState: null, ready: false,
        helperError: "srt-win-not-found",
      });
      expect(JSON.stringify(missing)).not.toContain(helperPath);
      expect(checkWindowsSandboxStatusAsyncMock).not.toHaveBeenCalled();

      // The resolver is real; only the status subprocess is replaced. No executable is launched by this lifecycle test.
      writeFileSync(helperPath, originalBytes);
      const restored = await readAsrtWindowsStatus();
      expect(restored).toMatchObject({ applicable: true, userState: "ready", wfpState: "installed", ready: true });
      expect(restored.helperError).toBeUndefined();
      expect(checkWindowsSandboxStatusAsyncMock).toHaveBeenCalledExactlyOnceWith({
        srtWin: { exe: expect.stringContaining("srt-win.exe"), prependArgs: ["--srt-win"] },
      });

      unlinkSync(helperPath);
      expect(await readAsrtWindowsStatus()).toMatchObject({ ready: false, helperError: "srt-win-not-found" });
      expect(checkWindowsSandboxStatusAsyncMock).toHaveBeenCalledTimes(1);
    } finally {
      path.mockRestore();
      setProcessPlatform(originalPlatform);
      checkWindowsSandboxStatusAsyncMock.mockReset();
      await cleanupTmpDir(dir);
    }
  });

  it.each(["bitflip", "same-size garbage"])("reports %s as an integrity failure without probing readiness", async (kind) => {
    const originalPlatform = process.platform;
    const bytes = readFileSync(asrtSandbox.getVendoredSrtWinExePath());
    const dir = mkdtempSync(join(tmpdir(), "ave-helper-tamper-"));
    const helperPath = join(dir, "srt-win.exe");
    if (kind === "bitflip") bytes[0x20] ^= 1;
    else bytes.fill(0x41);
    writeFileSync(helperPath, bytes);
    const path = vi.spyOn(asrtSandbox, "getVendoredSrtWinExePath").mockReturnValue(helperPath);
    setProcessPlatform("win32");
    checkWindowsSandboxStatusAsyncMock.mockReset();
    try {
      expect(await readAsrtWindowsStatus()).toMatchObject({
        applicable: true, ready: false, userState: null, wfpState: null,
        helperError: "srt-win-integrity-mismatch",
      });
      expect(checkWindowsSandboxStatusAsyncMock).not.toHaveBeenCalled();
    } finally {
      path.mockRestore();
      setProcessPlatform(originalPlatform);
      await cleanupTmpDir(dir);
    }
  });

  it("classifies a missing helper configuration but rethrows unrelated resolver and status failures", async () => {
    const originalPlatform = process.platform;
    setProcessPlatform("win32");
    const mod = await import("@anthropic-ai/sandbox-runtime");
    const resolveSrtWin = mod.resolveSrtWin;
    const resolver = vi.spyOn(mod, "resolveSrtWin");
    checkWindowsSandboxStatusAsyncMock.mockReset();
    try {
      // Exercise malformed configuration from an untyped runtime caller.
      resolver.mockImplementationOnce(() => Reflect.apply(resolveSrtWin, undefined, [{}]));
      expect(await readAsrtWindowsStatus()).toMatchObject({ ready: false, helperError: "srt-win-not-found" });
      expect(checkWindowsSandboxStatusAsyncMock).not.toHaveBeenCalled();

      for (const error of [
        new Error("resolver invariant failed"),
        Object.assign(new Error("foreign error"), { code: "srt_win_not_found" }),
        new mod.WindowsSandboxError("spawn_failed", "configured helper cannot start"),
      ]) {
        resolver.mockImplementationOnce(() => { throw error; });
        await expect(readAsrtWindowsStatus()).rejects.toBe(error);
      }

      resolver.mockReturnValueOnce({ exe: "configured-helper.exe", prependArgs: ["srt-win"] });
      const statusError = new mod.WindowsSandboxError("srt_win_bad_json", "invalid helper response");
      checkWindowsSandboxStatusAsyncMock.mockRejectedValueOnce(statusError);
      await expect(readAsrtWindowsStatus()).rejects.toBe(statusError);
    } finally {
      resolver.mockRestore();
      setProcessPlatform(originalPlatform);
      checkWindowsSandboxStatusAsyncMock.mockReset();
    }
  });

  it("does not resolve or probe a Windows helper on another platform", async () => {
    const originalPlatform = process.platform;
    const path = vi.spyOn(asrtSandbox, "getVendoredSrtWinExePath");
    checkWindowsSandboxStatusAsyncMock.mockReset();
    setProcessPlatform("linux");
    try {
      expect(await readAsrtWindowsStatus()).toEqual({
        applicable: false, userState: null, wfpState: null, ready: false, instructions: "",
      });
      expect(path).not.toHaveBeenCalled();
      expect(checkWindowsSandboxStatusAsyncMock).not.toHaveBeenCalled();
    } finally {
      path.mockRestore();
      setProcessPlatform(originalPlatform);
    }
  });

  it("normalizes the ASRT 0.0.80 ready sandbox-user shape", () => {
    expect(
      normalizeAsrtWindowsUserState({
        provisioned: true,
        sid: "S-1-5-21-1",
        groupExists: true,
        inBuiltinUsers: true,
        inSandboxGroup: true,
        hiddenFromLogon: true,
        credPresent: true,
      }),
    ).toBe("ready");
  });

  it("treats partial sandbox-user provisioning as incomplete, not ready", () => {
    expect(
      normalizeAsrtWindowsUserState({
        provisioned: true,
        sid: "S-1-5-21-1",
        groupExists: true,
      }),
    ).toBe("incomplete");
  });

  it("treats an empty sandbox-user status as absent", () => {
    expect(normalizeAsrtWindowsUserState({})).toBe("absent");
  });

  it("normalizes WFP status conservatively", () => {
    expect(normalizeAsrtWindowsWfpState({ state: "installed" })).toBe("installed");
    expect(normalizeAsrtWindowsWfpState({ state: "cannot-read" })).toBe("cannot-read");
    expect(normalizeAsrtWindowsWfpState({ state: "unexpected-upstream-state" })).toBe("absent");
  });

  it("requires both sandbox user and WFP to be ready", () => {
    expect(isAsrtWindowsReady("ready", "installed")).toBe(true);
    expect(isAsrtWindowsReady("ready", "cannot-read")).toBe(false);
    expect(isAsrtWindowsReady("incomplete", "installed")).toBe(false);
  });

  it("treats cannot-read WFP as ready only when ASRT behavioral verification succeeds", async () => {
    const verified = await resolveAsrtWindowsReady("ready", "cannot-read", async () => ({
      target: "127.0.0.1:49152",
      stderr: "BLOCKED",
    }));
    expect(verified).toBe(true);

    const failed = await resolveAsrtWindowsReady("ready", "cannot-read", async () => {
      throw new Error("WFP egress verification failed");
    });
    expect(failed).toBe(false);

    const absent = await resolveAsrtWindowsReady("ready", "absent", async () => {
      throw new Error("should not verify absent WFP");
    });
    expect(absent).toBe(false);
  });

  it("pins Windows filesystem ACL readiness to ASRT initialize fail-closed behavior", () => {
    const source = readAsrtSandboxManagerSource();
    // Applied at all — whitespace-tolerant, because the argument formatting is the bundler's choice and not a behaviour we are pinning.
    expect(source).toMatch(/grantWindowsAcl\(\s*\{/);
    expect(source).toMatch(/stampWindowsAcl\(\s*\{/);
    // And released again when initialization fails. This is the assertion the test is named for; see the helper for why locating the block matters.
    expect(rollsBackWindowsAclOnFailedInitialize(source)).toBe(true);
  });

  // The assertion above reads a file this repo does not control, so it cannot be mutation-tested without editing `node_modules`. These drive the same predicate over fixtures instead: each is a shape ASRT could plausibly ship, and the first two are exactly what the previous assertions let through.
  describe("the ACL rollback pin", () => {
    // The shape ASRT ships today, minified names and all.
    const FAIL_CLOSED = `
      catch (e) {
        if (windowsFsSbUserSid) {
          revokeWindowsAcl({ sandboxUserSid: windowsFsSbUserSid, srtWin });
          restoreWindowsAcl({ sandboxUserSid: windowsFsSbUserSid, srtWin });
        }
        windowsFsSbUserSid = undefined;
        config = undefined;
        throw e;
      }`;
    // The teardown call site, in a different function. Not a rollback.
    const TEARDOWN = `
      function releaseWindowsHolds() {
        for (const e of revokeWindowsAcl({ sandboxUserSid: sb, srtWin }) ?? []) log(e);
        for (const e of restoreWindowsAcl({ sandboxUserSid: sb, srtWin }) ?? []) log(e);
      }`;

    it("accepts the release-then-rethrow shape", () => {
      expect(rollsBackWindowsAclOnFailedInitialize(FAIL_CLOSED)).toBe(true);
    });

    it("rejects a failure path that keeps the ACLs it took", () => {
    // A failed initialization must revoke its ACL grant; fail-closed startup alone does not prove rollback.
      const kept = `
      catch (e) {
        windowsFsSbUserSid = undefined;
        config = undefined;
        throw e;
      }`;
      expect(rollsBackWindowsAclOnFailedInitialize(kept + TEARDOWN)).toBe(false);
    });

    it("does not accept the teardown call site as the failure path", () => {
      // Both release calls are present in the file, just not where they matter.
      expect(rollsBackWindowsAclOnFailedInitialize(TEARDOWN)).toBe(false);
    });

    it("does not pin the minifier's identifier names", () => {
      const renamed = FAIL_CLOSED
        .replaceAll("windowsFsSbUserSid", "q7")
        .replaceAll("catch (e)", "catch(_x)")
        .replaceAll("throw e;", "throw _x;");
      expect(rollsBackWindowsAclOnFailedInitialize(renamed)).toBe(true);
    });

    it("rejects the shipped source once the release calls are taken out of it", () => {
      // The fixtures above are hand-written, so they prove the predicate's logic and not that it is aimed at the real artifact. This mutates the shipped file in memory instead: strip the release calls and the same predicate that passes on ASRT as published must reject what is left.
      const source = readAsrtSandboxManagerSource();
      expect(rollsBackWindowsAclOnFailedInitialize(source)).toBe(true);

      const stripped = source.replaceAll(
        /^[^\n]*(?:revoke|restore)WindowsAcl\(\s*\{\s*sandboxUserSid[^\n]*\n/gm,
        "",
      );
      // Non-vacuous: a strip that matched nothing would make the assertion below true for the wrong reason.
      expect(stripped.length).toBeLessThan(source.length);
      expect(rollsBackWindowsAclOnFailedInitialize(stripped)).toBe(false);
    });

    it("requires the rethrow to carry the value that was caught", () => {
      // A catch that swallows its own error and throws something else is not failing closed, whatever else the block does.
      const swallowed = FAIL_CLOSED.replace("throw e;", "throw new Error('boom');");
      expect(rollsBackWindowsAclOnFailedInitialize(swallowed)).toBe(false);
    });
  });
});
