import { describe, expect, it } from "vitest";
import { WINDOWS_COMMAND_LINE_LIMIT, WINDOWS_COMMAND_LINE_MARGIN, windowsCommandLineLength } from "../../shared/windows-command-line.js";

import {
  MXC_BASH_UNAVAILABLE_MESSAGE,
  buildMxcShellRequest,
  classifyMxcStartProbe,
  detectMxcPrerequisites,
  detectMxcSupport,
  isWindowsPathAtOrUnder,
  mxcRequestArgs,
  parseMxcDryRunOutput,
  parseMxcProbeOutput,
  pinnedWxcExecSha256,
  probeMxcPowerShellStart,
  powerShellMxcCommandLine,
  rankMxcFilesystem,
  wxcExecPathFor,
  type DetectMxcSupportDeps,
  type MxcRunResult,
} from "../mxc-windows.js";

// Verbatim shapes captured from wxc-exec 1.0.0 on Windows 11 26300.9711 (2026-10-19).
const PROBE_BASE_CONTAINER = `{
  "tier": "base-container",
  "needsDaclAugmentation": false,
  "warnings": [],
  "probes": { "baseContainerApiPresent": true, "baseContainerSupportsDenyPaths": true,
    "baseContainerSupportsIngressHostLoopbackAllow": true }
}
`;
const DRY_RUN_PASSED = [
  "SECTION: Request simplified",
  "Script code length: 19",
  "Working directory: D:\\cc-verify\\win-mxc-2026-10-19\\m1\\rw",
  "Script timeout: 60000",
  "Container name: CLI",
  "selected isolation tier: base-container",
  "Runner completed in 0ms",
  "Dry run completed. Result: validation passed",
  "",
].join("\r\n");
const DRY_RUN_PROXY_RULE_REJECTED =
  "Request error\r\nConfiguration parse error: runtimeConfig.networkProxy requires network.egress.default='deny' with no direct allow or deny rules\r\n";
// What wxc-exec printed when Windows PowerShell 5.1 started in a container over SSH (session 0, 2026-10-19), and its exit code.
const START_DLL_INIT_FAILED =
  "The target executable exited with STATUS_DLL_INIT_FAILED (0xC0000142). This often means the sandbox is blocking Win32k system calls (UI subsystem access), which is often required to initialize.";
const DRY_RUN_NON_LOOPBACK =
  "Request error\r\nWARNING: filesystem path 'D:\\x\\missing' (in 'readwritePaths') does not exist on the host; the backend may fail at mount time\r\n" +
  "Configuration parse error: runtimeConfig.networkProxy must use localhost, 127.0.0.1, or [::1]\r\n";

describe("parseMxcProbeOutput", () => {
  it("reads the tier from the probe JSON", () => {
    expect(parseMxcProbeOutput(PROBE_BASE_CONTAINER)).toEqual({ tier: "base-container", needsDaclAugmentation: false });
  });
  it("returns undefined for output that is not JSON", () => {
    expect(parseMxcProbeOutput("Request error")).toBeUndefined();
    expect(parseMxcProbeOutput("{ not json")).toBeUndefined();
  });
});

describe("parseMxcDryRunOutput", () => {
  it("accepts only a validated request on the base-container tier", () => {
    expect(parseMxcDryRunOutput(0, DRY_RUN_PASSED, "")).toEqual({ ok: true });
    expect(parseMxcDryRunOutput(0, DRY_RUN_PASSED.replace("base-container", "appcontainer"), "")).toEqual({
      ok: false,
      detail: "selected isolation tier: appcontainer",
    });
  });
  it("keeps the parse error, not the path warnings, as the diagnostic", () => {
    expect(parseMxcDryRunOutput(1, DRY_RUN_PROXY_RULE_REJECTED, "")).toEqual({
      ok: false,
      detail: "Configuration parse error: runtimeConfig.networkProxy requires network.egress.default='deny' with no direct allow or deny rules",
    });
    expect(parseMxcDryRunOutput(1, "", DRY_RUN_NON_LOOPBACK)).toEqual({
      ok: false,
      detail: "Configuration parse error: runtimeConfig.networkProxy must use localhost, 127.0.0.1, or [::1]",
    });
  });
  it("rejects a non-zero exit even when the text looks successful", () => {
    expect(parseMxcDryRunOutput(2, DRY_RUN_PASSED, "")).toMatchObject({ ok: false });
  });
});

function deps(overrides: Partial<DetectMxcSupportDeps> & { runs?: Record<string, MxcRunResult | Error> } = {}): DetectMxcSupportDeps & { calls: string[][] } {
  const calls: string[][] = [];
  const runs: Record<string, MxcRunResult | Error> = {
    "--probe": { code: 0, stdout: PROBE_BASE_CONTAINER, stderr: "" },
    "--dry-run": { code: 0, stdout: DRY_RUN_PASSED, stderr: "" },
    // The real start probe (no --dry-run): PowerShell exits 0.
    "--config-base64": { code: 0, stdout: "", stderr: "" },
    ...overrides.runs,
  };
  return {
    platform: "win32",
    arch: "x64",
    resourcePath: "C:\\Program Files\\Ave\\resources",
    windowsBuild: "10.0.26300",
    exists: () => true,
    sha256: async () => pinnedWxcExecSha256("x64")!,
    probeDirectory: "C:\\Users\\u\\AppData\\Local\\Temp\\ave-mxc-probe-x",
    systemRoot: "C:\\Windows",
    run: async (_file, args) => {
      calls.push([...args]);
      const outcome = runs[args[0]!];
      if (outcome instanceof Error) throw outcome;
      return outcome ?? { code: 1, stdout: "", stderr: "unexpected" };
    },
    ...overrides,
    calls,
  };
}

describe("detectMxcSupport", () => {
  it("is available when the launcher is the pinned build, the request validates and PowerShell starts", async () => {
    const d = deps();
    await expect(detectMxcSupport(d)).resolves.toEqual({ state: "available", windowsBuild: "10.0.26300" });
    expect(d.calls.map((c) => c[0])).toEqual(["--probe", "--dry-run", "--config-base64"]);
    for (const args of d.calls.slice(1)) {
      expect(args).toContain("--config-base64");
      expect(windowsCommandLineLength(wxcExecPathFor(d.resourcePath, d.arch)!, args) + WINDOWS_COMMAND_LINE_MARGIN)
        .toBeLessThan(WINDOWS_COMMAND_LINE_LIMIT);
    }
    // The dry run validates the request Ave launches: proxy mode, no DACL fallback.
    const encoded = d.calls[1]![d.calls[1]!.indexOf("--config-base64") + 1]!;
    const request = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
    expect(request.fallback).toEqual({ allowDaclMutation: false });
    expect(request.runtimeConfig.networkProxy).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(request.network).toEqual({ egress: { default: "deny" }, ingress: { default: "allow", hostLoopback: "allow" } });
    // The start probe is a real container of the same shape running System32 PowerShell 5.1.
    const start = JSON.parse(Buffer.from(d.calls[2]![1]!, "base64").toString("utf8"));
    expect(start.process.commandLine).toMatch(/^"C:\\Windows\\System32\\WindowsPowerShell\\v1\.0\\powershell\.exe" .* -EncodedCommand /);
    expect(start.process.inheritDefaultEnv).toBe(false);
    expect(start.runtimeConfig.networkProxy).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(start.network).toEqual(request.network);
    expect(start.filesystem.readwritePaths).toEqual(["C:\\Users\\u\\AppData\\Local\\Temp\\ave-mxc-probe-x"]);
  });

  it("splits into a boot-path half without the container start and a start half", async () => {
    const boot = deps();
    await expect(detectMxcPrerequisites(boot)).resolves.toEqual({ state: "available", windowsBuild: "10.0.26300" });
    expect(boot.calls.map((c) => c[0])).toEqual(["--probe", "--dry-run"]);
    const later = deps({ runs: { "--config-base64": { code: 0xc0000142, stdout: "", stderr: START_DLL_INIT_FAILED } } });
    await expect(probeMxcPowerShellStart(later)).resolves.toMatchObject({ state: "unavailable", reason: "unverified-session" });
    expect(later.calls.map((c) => c[0])).toEqual(["--config-base64"]);
  });

  it("refuses a launcher that is not the pinned build before running it", async () => {
    const d = deps({ sha256: async () => "0".repeat(64) });
    await expect(detectMxcSupport(d)).resolves.toMatchObject({ state: "unavailable", reason: "launcher-mismatch" });
    expect(d.calls).toEqual([]);
  });

  it("does not claim MXC when PowerShell cannot initialize in this session", async () => {
    const d = deps({ runs: { "--config-base64": { code: 0xc0000142, stdout: "", stderr: START_DLL_INIT_FAILED } } });
    await expect(detectMxcSupport(d)).resolves.toMatchObject({ state: "unavailable", reason: "unverified-session" });
  });

  it.each([
    [{ platform: "darwin" as const }, "not-windows"],
    [{ arch: "ia32" }, "unsupported-arch"],
    [{ exists: () => false }, "binary-missing"],
    [{ runs: { "--probe": { code: 1, stdout: "", stderr: "boom" } } }, "probe-failed"],
    [{ runs: { "--probe": new Error("spawn EACCES") } }, "probe-failed"],
    [{ runs: { "--probe": { code: 0, stdout: PROBE_BASE_CONTAINER.replace("base-container", "appcontainer-dacl"), stderr: "" } } }, "tier-unsupported"],
    [{ runs: { "--dry-run": { code: 1, stdout: DRY_RUN_PROXY_RULE_REJECTED, stderr: "" } } }, "request-rejected"],
    [{ runs: { "--config-base64": { code: 1, stdout: "", stderr: "Access is denied." } } }, "powershell-start-failed"],
    [{ runs: { "--config-base64": new Error("spawn timeout") } }, "powershell-start-failed"],
    [{ sha256: async () => { throw new Error("EACCES"); } }, "probe-failed"],
  ])("reports %o as %s, never as available", async (override, reason) => {
    await expect(detectMxcSupport(deps(override))).resolves.toMatchObject({ state: "unavailable", reason });
  });
});

describe("classifyMxcStartProbe", () => {
  it("treats exit 0 as a start and a UI-subsystem init failure as an unverified session", () => {
    expect(classifyMxcStartProbe(0, "", "")).toEqual({ ok: true });
    expect(classifyMxcStartProbe(3221225794, "", "")).toMatchObject({ ok: false, reason: "unverified-session" });
    expect(classifyMxcStartProbe(-1, START_DLL_INIT_FAILED, "")).toMatchObject({ ok: false, reason: "unverified-session" });
    expect(classifyMxcStartProbe(1, "", "Access is denied.")).toEqual({ ok: false, reason: "powershell-start-failed", detail: "Access is denied." });
  });
});

describe("pinnedWxcExecSha256", () => {
  it("pins the two shipped architectures and nothing else", () => {
    expect(pinnedWxcExecSha256("x64")).toMatch(/^[0-9a-f]{64}$/);
    expect(pinnedWxcExecSha256("arm64")).toMatch(/^[0-9a-f]{64}$/);
    expect(pinnedWxcExecSha256("ia32")).toBeUndefined();
  });
});

describe("wxcExecPathFor", () => {
  it("resolves the per-arch binary under resources/mxc", () => {
    expect(wxcExecPathFor("C:\\R", "x64")).toBe("C:\\R\\mxc\\x64\\wxc-exec.exe");
    expect(wxcExecPathFor("C:\\R", "arm64")).toBe("C:\\R\\mxc\\arm64\\wxc-exec.exe");
    expect(wxcExecPathFor("C:\\R", "ia32")).toBeUndefined();
  });
});

describe("isWindowsPathAtOrUnder", () => {
  it("compares case-insensitively on component boundaries", () => {
    expect(isWindowsPathAtOrUnder("C:\\Work\\Repo\\src", "c:\\work\\repo")).toBe(true);
    expect(isWindowsPathAtOrUnder("C:\\Work\\Repo", "C:\\Work\\Repo\\")).toBe(true);
    expect(isWindowsPathAtOrUnder("C:\\Work\\Repository", "C:\\Work\\Repo")).toBe(false);
    expect(isWindowsPathAtOrUnder("D:\\x", "C:\\")).toBe(false);
    expect(isWindowsPathAtOrUnder("C:\\x", "C:\\")).toBe(true);
  });
});

describe("rankMxcFilesystem", () => {
  const home = "C:\\Users\\u";
  const repo = "C:\\Users\\u\\src\\repo";
  const sandboxHome = "C:\\Users\\u\\AppData\\Roaming\\Ave\\sandbox-homes\\h1";
  const exists = (path: string): boolean => !path.toLowerCase().includes("missing");

  it("maps grants, keeps a credential path inside the workspace denied, and omits ancestor denies", () => {
    const grants = rankMxcFilesystem({
      allowWrite: [repo, sandboxHome],
      allowRead: [repo, "C:\\Program Files\\Git"],
      denyRead: [home, "C:\\Users\\u\\AppData\\Roaming\\Ave\\sandbox-homes", `${repo}\\.env`],
      denyWrite: [`${repo}\\.git\\hooks`, `${repo}\\.missing-rc`],
      protectedFloor: ["C:\\Users\\u\\.ssh", `${repo}\\.aws`],
    }, exists);
    expect(grants.readwrite).toEqual([repo, sandboxHome]);
    // The read grant equal to a write grant is not repeated as read-only.
    expect(grants.readonly).toEqual(["C:\\Program Files\\Git", `${repo}\\.git\\hooks`]);
    // HOME and the sandbox-homes root are ancestors of grants: omitted.
    expect(grants.denied).toEqual([`${repo}\\.missing-rc`, `${repo}\\.env`, `${repo}\\.aws`]);
  });

  it("drops a grant beneath the protected floor and demotes a write grant beneath a write deny", () => {
    const grants = rankMxcFilesystem({
      allowWrite: ["C:\\Users\\u\\.ssh\\work", "C:\\Users\\u\\.config\\fish"],
      allowRead: ["C:\\Users\\u\\.ssh"],
      denyRead: [],
      denyWrite: ["C:\\Users\\u\\.config"],
      protectedFloor: ["C:\\Users\\u\\.ssh"],
    }, exists);
    expect(grants).toEqual({ readwrite: [], readonly: ["C:\\Users\\u\\.config\\fish"], denied: [] });
  });

  it("keeps the saved-session grant that deliberately pierces the floor, with its nested denies", () => {
    const userData = "C:\\Users\\u\\AppData\\Roaming\\Ave";
    const sessions = `${userData}\\sessions`;
    const grants = rankMxcFilesystem({
      allowWrite: [repo],
      allowRead: [repo, sessions],
      denyRead: [`${sessions}\\secrets`],
      denyWrite: [],
      protectedFloor: [userData],
      floorPierces: [sessions],
    }, exists);
    expect(grants.readonly).toEqual([sessions]);
    expect(grants.denied).toEqual([`${sessions}\\secrets`]);
  });

  it("drops grants that do not exist and de-duplicates case variants", () => {
    const grants = rankMxcFilesystem({
      allowWrite: [repo, repo.toUpperCase(), "C:\\missing-dir"],
      allowRead: [],
      denyRead: [],
      denyWrite: [],
      protectedFloor: [],
    }, exists);
    expect(grants.readwrite).toEqual([repo]);
  });
});

describe("buildMxcShellRequest", () => {
  const base = {
    commandLine: "cmd.exe /d /c echo hi",
    cwd: "C:\\work\\repo",
    grants: { readwrite: ["C:\\work\\repo"], readonly: [], denied: ["C:\\work\\repo\\.env"] },
    env: { SYSTEMROOT: "C:\\Windows", LOCALAPPDATA: "C:\\Users\\u\\AppData\\Local", PATH: "C:\\Windows\\System32", HTTP_PROXY: "http://evil:1", no_proxy: "*" },
    proxyUrl: "http://127.0.0.1:5882",
    timeoutMs: 120_000,
  };

  it("pins every security-relevant field", () => {
    const request = buildMxcShellRequest(base);
    expect(request).toEqual({
      version: "1.0.0",
      containment: "processcontainer",
      process: {
        commandLine: "cmd.exe /d /c echo hi",
        cwd: "C:\\work\\repo",
        env: ["SYSTEMROOT=C:\\Windows", "LOCALAPPDATA=C:\\Users\\u\\AppData\\Local", "PATH=C:\\Windows\\System32"],
        inheritDefaultEnv: false,
        timeout: 120_000,
      },
      filesystem: { readwritePaths: ["C:\\work\\repo"], readonlyPaths: [], deniedPaths: ["C:\\work\\repo\\.env"] },
      fallback: { allowDaclMutation: false },
      network: { egress: { default: "deny" }, ingress: { default: "allow", hostLoopback: "allow" } },
      runtimeConfig: { networkProxy: "http://127.0.0.1:5882" },
      ui: { disable: false, clipboard: "none", injection: false },
    });
  });

  it("refuses a proxy that is not this host's loopback, a cwd outside the grants, and an env MXC would reject", () => {
    expect(() => buildMxcShellRequest({ ...base, proxyUrl: "http://10.0.0.1:8080" })).toThrow(/127\.0\.0\.1/);
    expect(() => buildMxcShellRequest({ ...base, proxyUrl: "http://user:pw@127.0.0.1:1" })).toThrow();
    expect(() => buildMxcShellRequest({ ...base, cwd: "C:\\elsewhere" })).toThrow(/working directory/);
    expect(() => buildMxcShellRequest({ ...base, env: { SYSTEMROOT: "C:\\Windows" } })).toThrow(/LOCALAPPDATA/);
  });

  it("round-trips through the base64 argument", () => {
    const request = buildMxcShellRequest(base);
    const [flag, value] = mxcRequestArgs(request, "C:\\Ave\\wxc-exec.exe");
    expect(flag).toBe("--config-base64");
    expect(JSON.parse(Buffer.from(value!, "base64").toString("utf8"))).toEqual(request);
  });
});

describe("powerShellMxcCommandLine", () => {
  it("runs System32 Windows PowerShell with the command UTF-16LE encoded", () => {
    const line = powerShellMxcCommandLine("C:\\Windows", "Write-Output \"a b\"; echo 'x'");
    expect(line.startsWith('"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoLogo -NoProfile -NonInteractive -ExecutionPolicy RemoteSigned -EncodedCommand ')).toBe(true);
    const encoded = line.split(" ").at(-1)!;
    expect(Buffer.from(encoded, "base64").toString("utf16le")).toBe("Write-Output \"a b\"; echo 'x'");
    expect(line).not.toContain("pwsh");
  });
});

describe("MXC_BASH_UNAVAILABLE_MESSAGE", () => {
  it("names the PowerShell tool and the explicit host route", () => {
    expect(MXC_BASH_UNAVAILABLE_MESSAGE).toContain("PowerShell tool");
    expect(MXC_BASH_UNAVAILABLE_MESSAGE).toContain('executionMode "host"');
  });
});
