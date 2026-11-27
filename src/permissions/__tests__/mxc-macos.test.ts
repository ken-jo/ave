import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { _detectMxcMacShellSupportForTest, _seatbeltCanaryPassedForTest, buildSeatbeltShellRequest, mapSeatbeltShellRequest, udpSendOutcome } from "../mxc-macos.js";
import { buildPolicyModel, policyFloorRow, policyGrantRow } from "../policy-model.js";
import type { MacRawIpVerdict } from "../../shared/sandbox-capability-info.js";

const BLOCKED: MacRawIpVerdict = { rawIp: "blocked", reason: "blocked", evidenceKind: "measured", reachableTargets: [], udpArrival: "absent" };

describe("macOS container shell detector", () => {
  function makeDependencies() {
    return {
      arch: "arm64",
      libraryExists: vi.fn(() => true),
      requireRuntimeRoot: vi.fn(() => "/runtime"),
      canary: vi.fn(async (): Promise<{ verdict: "available"; rawIpProbe: MacRawIpVerdict }
          | { verdict: "request-rejected" | "shell-start-failed" | "launcher-mismatch" }> =>
        ({ verdict: "available", rawIpProbe: BLOCKED })),
    };
  }

  it("checks architecture, library presence and runtime root before proving a real start", async () => {
    const deps = makeDependencies();
    await expect(_detectMxcMacShellSupportForTest(deps)).resolves.toEqual({ state: "available", rawIpProbe: BLOCKED });
    const order = [deps.libraryExists, deps.requireRuntimeRoot, deps.canary]
      .map(mock => mock.mock.invocationCallOrder[0]);
    expect(order).toEqual([...order].sort((left, right) => Number(left) - Number(right)));
    expect(deps.canary).toHaveBeenCalledExactlyOnceWith("/runtime");
  });

  it("refuses an unsupported architecture before touching the library", async () => {
    const deps = { ...makeDependencies(), arch: "x64" };
    await expect(_detectMxcMacShellSupportForTest(deps)).resolves.toEqual({
      state: "unavailable", reason: "unsupported-arch",
    });
    expect(deps.libraryExists).not.toHaveBeenCalled();
  });

  it("refuses a missing library before starting a canary", async () => {
    const deps = makeDependencies();
    deps.libraryExists.mockReturnValue(false);
    await expect(_detectMxcMacShellSupportForTest(deps)).resolves.toEqual({
      state: "unavailable", reason: "binary-missing",
    });
    expect(deps.canary).not.toHaveBeenCalled();
  });

  it("refuses an unproved runtime root before starting a canary", async () => {
    const deps = makeDependencies();
    deps.requireRuntimeRoot.mockImplementation(() => { throw new Error("Private directory is unproved"); });
    await expect(_detectMxcMacShellSupportForTest(deps)).resolves.toEqual({
      state: "unavailable", reason: "runtime-root-unproved",
    });
    expect(deps.canary).not.toHaveBeenCalled();
  });

  it.each(["request-rejected", "shell-start-failed", "launcher-mismatch"] as const)("reports %s as unavailable", async (reason) => {
    const deps = makeDependencies();
    // Even a canary that measured blocked cannot publish it on an unavailable container: that arm has no field.
    deps.canary.mockResolvedValue({ verdict: reason });
    await expect(_detectMxcMacShellSupportForTest(deps)).resolves.toEqual({ state: "unavailable", reason });
  });
});

describe("macOS raw-IP UDP send code", () => {
  it("counts only a policy refusal as refused-local; any other failed send was never sent", () => {
    expect(udpSendOutcome("0")).toBe("sent");
    expect(udpSendOutcome("1")).toBe("refused-local");
    expect(udpSendOutcome("13")).toBe("refused-local");
    for (const code of ["49", "51", "65", "61", "x", undefined]) expect(udpSendOutcome(code)).toBe("unmeasured");
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
    ["shell exit", { status: 255 }],
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
    lookups: {
      home: "/fixture", foldsCase: true, exists: () => true, canonical: (path: string) => path,
      children: () => [], readable: () => true, directoryIdentity: () => undefined,
    },
    commandLine: "exec '/bin/sh' '-c' 'printf control'",
  };

  const documentedProcessDefaults = {
    // SDK docs/containment-policy/dev/policy.md:58 specifies false when omitted.
    inheritDefaultEnv: false,
  };

  function normalizeProcessDefaults(process: Record<string, unknown>) {
    return { ...documentedProcessDefaults, ...process };
  }

  async function preparedMapping() {
    const { request } = buildSeatbeltShellRequest(input);
    const sdk = dirname(createRequire(import.meta.url).resolve("@microsoft/mxc-sdk/package.json"));
    const { prepareContainerRequest } = await import(pathToFileURL(join(sdk, "dist/v1/container.js")).href);
    const { containerId, lifecycle, ...wire } = JSON.parse(JSON.stringify(prepareContainerRequest(mapSeatbeltShellRequest(request))));
    return { request, wire, containerId, lifecycle };
  }

  it("lets the SDK name a fresh container per run and destroy it with its policy on exit", async () => {
    const first = await preparedMapping();
    const second = await preparedMapping();
    // Ave sends no container name, so each run gets its own random id; nothing outlives the run.
    expect(first.containerId).toMatch(/^[0-9a-f]{32}$/u);
    expect(second.containerId).toMatch(/^[0-9a-f]{32}$/u);
    expect(first.containerId).not.toBe(second.containerId);
    expect(first.lifecycle).toStrictEqual({ destroyOnExit: true, preservePolicy: false });
    expect(first.request).not.toHaveProperty("containerId");
    expect(first.request).not.toHaveProperty("lifecycle");
  });

  it("maps every wire field, accepting only documented omitted process defaults", async () => {
    const { request, wire } = await preparedMapping();
    expect(wire.process).not.toHaveProperty("inheritDefaultEnv");
    expect(request.process.inheritDefaultEnv).toBe(false);
    expect({ ...wire, process: normalizeProcessDefaults(wire.process) }).toStrictEqual(request);
  });

  it("rejects omission of a wire field outside the documented default allow-list", async () => {
    const { request, wire } = await preparedMapping();
    delete wire.process.commandLine;
    expect(() => expect({ ...wire, process: normalizeProcessDefaults(wire.process) }).toStrictEqual(request)).toThrow();
  });

  it("serializes one profile override and admits the carved cwd with an explicit environment", () => {
    const { request } = buildSeatbeltShellRequest(input);
    expect(`${JSON.stringify(request, null, 2)}\n`)
      .toBe(readFileSync(new URL("./fixtures/seatbelt-shell-request.json", import.meta.url), "utf8"));
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

  it("refuses an environment name the container's /bin/sh could import as a function, or any other non-identifier name", () => {
    for (const name of ["BASH_FUNC_read%%", "BASH_FUNC_pwd%%", "BASH_FUNC_[%%", "1LEADING", "WITH-DASH", "", "A=B"]) {
      expect(() => buildSeatbeltShellRequest({ ...input, env: { ...input.env, [name]: "() { aveHostHandoff=G; }" } }), name)
        .toThrow(expect.objectContaining({ code: "env-invalid" }));
    }
    // Proxy keys are still dropped: the container's proxy is set by its runtime config.
    expect(buildSeatbeltShellRequest(input).request.process.env).toEqual(["HOME=/fixture/private/open", "PATH=/usr/bin:/bin"]);
  });
});
