import { describe, expect, it, vi } from "vitest";
import { _detectMxcMacShellSupportForTest, _seatbeltCanaryPassedForTest, buildSeatbeltShellRequest } from "../mxc-macos.js";
import { buildPolicyModel, policyFloorRow, policyGrantRow } from "../policy-model.js";

describe("macOS container shell detector", () => {
  function makeDependencies() {
    return {
      arch: "arm64",
      launcherPath: vi.fn(() => "/resources/launcher"),
      exists: vi.fn(() => true),
      verifyPin: vi.fn(async () => true),
      requireRuntimeRoot: vi.fn(() => "/runtime"),
      canary: vi.fn(async (): Promise<"available" | "request-rejected" | "shell-start-failed"> => "available"),
    };
  }

  it("checks architecture, launcher, pin and runtime root before proving a real start", async () => {
    const deps = makeDependencies();
    await expect(_detectMxcMacShellSupportForTest(deps)).resolves.toEqual({ state: "available" });
    const order = [deps.launcherPath, deps.exists, deps.verifyPin, deps.requireRuntimeRoot, deps.canary]
      .map(mock => mock.mock.invocationCallOrder[0]);
    expect(order).toEqual([...order].sort((left, right) => Number(left) - Number(right)));
    expect(deps.canary).toHaveBeenCalledExactlyOnceWith("/resources/launcher", "/runtime");
  });

  it("refuses an unsupported architecture before touching the launcher", async () => {
    const deps = { ...makeDependencies(), arch: "x64" };
    await expect(_detectMxcMacShellSupportForTest(deps)).resolves.toEqual({
      state: "unavailable", reason: "unsupported-arch",
    });
    expect(deps.launcherPath).not.toHaveBeenCalled();
  });

  it("refuses a missing launcher before hashing it", async () => {
    const deps = makeDependencies();
    deps.exists.mockReturnValue(false);
    await expect(_detectMxcMacShellSupportForTest(deps)).resolves.toEqual({
      state: "unavailable", reason: "binary-missing",
    });
    expect(deps.verifyPin).not.toHaveBeenCalled();
  });

  it("refuses a mismatched launcher before checking the runtime root", async () => {
    const deps = makeDependencies();
    deps.verifyPin.mockResolvedValue(false);
    await expect(_detectMxcMacShellSupportForTest(deps)).resolves.toEqual({
      state: "unavailable", reason: "launcher-mismatch",
    });
    expect(deps.requireRuntimeRoot).not.toHaveBeenCalled();
  });

  it("refuses an unproved runtime root before starting a canary", async () => {
    const deps = makeDependencies();
    deps.requireRuntimeRoot.mockImplementation(() => { throw new Error("Private directory is unproved"); });
    await expect(_detectMxcMacShellSupportForTest(deps)).resolves.toEqual({
      state: "unavailable", reason: "runtime-root-unproved",
    });
    expect(deps.canary).not.toHaveBeenCalled();
  });

  it.each(["request-rejected", "shell-start-failed"] as const)("reports %s as unavailable", async (reason) => {
    const deps = makeDependencies();
    deps.canary.mockResolvedValue(reason);
    await expect(_detectMxcMacShellSupportForTest(deps)).resolves.toEqual({ state: "unavailable", reason });
  });
});

describe("macOS container shell canary evidence", () => {
  const success = {
    status: 0, timedOut: false, stdout: "container-shell-control\n",
    control: "container-shell-control\n", outsideWrite: false, otherPortConnected: false,
    protectedParentInPlace: true, unixSocketConnected: false, protectedNewFile: false,
  };

  it("requires a working control and each denied effect", () => {
    expect(_seatbeltCanaryPassedForTest(success)).toBe(true);
  });

  it.each([
    ["launcher exit", { status: 255 }],
    ["timeout", { timedOut: true }],
    ["control read failure", { stdout: "" }],
    ["read deny leak", { stdout: `${success.stdout}canary-sealed-file\n` }],
    ["control write failure", { control: null }],
    ["write deny leak", { outsideWrite: true }],
    ["network deny leak", { otherPortConnected: true }],
    ["Unix-socket deny leak", { unixSocketConnected: true }],
    ["new pattern match", { protectedNewFile: true }],
    ["ancestor move", { protectedParentInPlace: false }],
  ] as const)("fails on %s", (_case, evidence) => {
    expect(_seatbeltCanaryPassedForTest({ ...success, ...evidence })).toBe(false);
  });
});

describe("macOS container shell request", () => {
  const model = buildPolicyModel({
    floors: [policyFloorRow("/fixture/private", "denied", "read-boundary", true)],
    launchGrants: [policyGrantRow("/fixture", "ro", "launch-grant", true),
      policyGrantRow("/fixture/private/open", "rw", "launch-grant", true)],
    userGrants: [], extensionManifests: [],
  });
  const input = {
    model, cwd: "/fixture", proxyUrl: "http://127.0.0.1:8444", timeoutMs: 2500,
    env: { HOME: "/fixture/private/open", PATH: "/usr/bin:/bin", HTTPS_PROXY: "http://example.invalid", NO_PROXY: "*" },
    lookups: { home: "/fixture", foldsCase: true, exists: () => true, canonical: (path: string) => path, children: () => [] },
    commandLine: "exec '/bin/sh' '-c' 'printf control'",
  };

  it("serializes one profile override and admits the carved cwd with an explicit environment", () => {
    const { request } = buildSeatbeltShellRequest(input);
    const { profileOverride, ...seatbelt } = request.seatbelt;
    expect(profileOverride).toContain('(allow network-outbound (remote ip "localhost:8444"))');
    expect({ ...request, seatbelt }).toEqual({
      version: "1.0.0", containment: "seatbelt",
      process: { commandLine: "exec '/bin/sh' '-c' 'printf control'", cwd: "/fixture", timeout: 2500,
        inheritDefaultEnv: false, env: ["HOME=/fixture/private/open", "PATH=/usr/bin:/bin"] },
      filesystem: { readwritePaths: ["/fixture/private/open"], readonlyPaths: [], deniedPaths: [] },
      network: { egress: { default: "deny" }, ingress: { default: "deny", hostLoopback: "deny" } },
      runtimeConfig: { networkProxy: "http://127.0.0.1:8444" }, seatbelt: { nestedPty: false },
      ui: { disable: true, clipboard: "none", injection: false },
    });
  });

  it("refuses an ungranted cwd and a non-loopback proxy by name", () => {
    expect(() => buildSeatbeltShellRequest({ ...input, cwd: "/fixture/private/sealed" }))
      .toThrow(expect.objectContaining({ code: "cwd-ungranted" }));
    expect(() => buildSeatbeltShellRequest({ ...input, proxyUrl: "https://127.0.0.1:8444" }))
      .toThrow(expect.objectContaining({ code: "proxy-invalid" }));
  });
});
