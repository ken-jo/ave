import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { isContainerHolderRouteEnabled, isContainerShellRouteEnabled } from "../../shared/container-platform.js";
import { configureHostResources } from "../../main/host-resources.js";
import { initializeAsrtSandbox, resetAsrtSandbox } from "../asrt-sandbox.js";
import { egressIdentityStrength } from "../egress-identity.js";
import { openEgressInvocation } from "../egress-invocations.js";
import { openEgressRelay } from "../egress-relay/relay.js";
import {
  __resetActiveSandboxCapabilityForTest, __resetSandboxRequestedAtBootForTest,
  detectMxcShellCapability, getHostShellExecutionPlan, getContainerShellInfo, setActiveSandboxCapability, setContainerShellSubstrate, setShellSandboxRequestedAtBoot,
} from "../sandbox-capability.js";

const platform = process.platform;

describe.runIf(platform === "darwin" || platform === "linux")("POSIX shell and holder routes", () => {
  beforeAll(() => configureHostResources({ resourcePath: resolve("resources"), isPackaged: false }));
  afterEach(() => {
    __resetActiveSandboxCapabilityForTest();
    __resetSandboxRequestedAtBootForTest();
  });

  function publishWrap() {
    setShellSandboxRequestedAtBoot(true);
    setActiveSandboxCapability({
      platform, kind: "asrt", confidence: "verified", reason: "Active sandbox",
      confines: { filesystem: true, process: true, network: true },
    });
  }

  it.runIf(platform === "darwin")("requires a proved macOS container and keeps the hook wrap independent", () => {
    publishWrap();
    expect(isContainerShellRouteEnabled(platform)).toBe(true);
    expect(isContainerHolderRouteEnabled(platform)).toBe(false);
    // Unmeasured raw IP is unknown; only this boot's measured verdict publishes blocked, on the plan and in Settings.
    setContainerShellSubstrate("darwin", { state: "available" });
    expect(getHostShellExecutionPlan()).toMatchObject({
      identity: "host-shell-execution-plan/v4:darwin:mxc", sandboxed: true,
      egressProtocolCoverage: { dns: "unknown", rawIp: "unknown" },
    });
    const measured = { state: "available", rawIpProbe: { rawIp: "blocked", reason: "blocked", evidenceKind: "measured", reachableTargets: [], udpArrival: "absent" } } as const;
    setContainerShellSubstrate("darwin", measured);
    expect(getHostShellExecutionPlan().egressProtocolCoverage).toEqual({ dns: "unknown", rawIp: "blocked" });
    expect(getHostShellExecutionPlan("default", "hook").identity).toBe("host-shell-execution-plan/v4:darwin:asrt");
    expect(getHostShellExecutionPlan("default", "hook").egressProtocolCoverage.rawIp).toBe("unknown");
    expect(getContainerShellInfo()).toEqual({ ...measured, egressProtocolCoverage: { dns: "unknown", rawIp: "blocked" } });
    setContainerShellSubstrate("darwin", { state: "available", rawIpProbe: { rawIp: "unknown", reason: "ipv6-unmeasured", reachableTargets: [], udpArrival: "absent" } });
    expect(getHostShellExecutionPlan().egressProtocolCoverage.rawIp).toBe("unknown");
    // An explicit host request on a host whose backend is ready keeps ordinary rules and modes (tree: host-shell row).
    expect(getHostShellExecutionPlan("host")).toMatchObject({
      mode: "plain", executionRequest: "host", identity: "host-shell-execution-plan/v4:darwin:explicit-host",
    });
    setContainerShellSubstrate("darwin", { state: "unavailable", reason: "shell-start-failed" });
    expect(getContainerShellInfo()).toEqual({
      state: "unavailable", reason: "shell-start-failed", egressProtocolCoverage: { dns: "unknown", rawIp: "unknown" },
    });
    expect(getHostShellExecutionPlan()).toMatchObject({
      mode: "plain", substrate: "none", requiresExplicitUserApproval: true, fallbackReason: "active-sandbox-not-shell-contained",
    });
    // An unproved container shell puts explicit host requests on the no-confinement floor too; the wrap does not stand in for it.
    const unprovedHost = getHostShellExecutionPlan("host");
    expect(unprovedHost).toMatchObject({ mode: "plain", executionRequest: "host" });
    expect(unprovedHost.identity.startsWith("host-shell-execution-plan/v4:darwin:explicit-host")).toBe(true);
    expect(unprovedHost.identity).not.toBe("host-shell-execution-plan/v4:darwin:explicit-host");
    expect(getHostShellExecutionPlan("default", "hook").identity).toBe("host-shell-execution-plan/v4:darwin:asrt");
    __resetActiveSandboxCapabilityForTest();
    expect(getHostShellExecutionPlan().fallbackReason).toBe("requested-sandbox-unavailable");
  });

  it.runIf(platform === "linux")("requires the Linux container proof for shells and keeps the hook wrap", () => {
    publishWrap();
    expect(isContainerShellRouteEnabled(platform)).toBe(true);
    expect(isContainerHolderRouteEnabled(platform)).toBe(false);
    setContainerShellSubstrate("linux", { state: "unavailable", reason: "tools-missing", detail: ["slirp4netns"] });
    expect(detectMxcShellCapability()).toBeUndefined();
    expect(getHostShellExecutionPlan()).toMatchObject({ substrate: "none", requiresExplicitUserApproval: true,
      fallbackReason: "active-sandbox-not-shell-contained" });
    expect(getContainerShellInfo()).toMatchObject({ state: "unavailable", reason: "tools-missing", detail: ["slirp4netns"] });
    expect(getHostShellExecutionPlan("default", "hook").identity).toBe("host-shell-execution-plan/v4:linux:asrt");
    expect(getContainerShellInfo()?.egressProtocolCoverage).toEqual({ dns: "unknown", rawIp: "unknown" });
    setContainerShellSubstrate("linux", { state: "available" });
    expect(getHostShellExecutionPlan()).toMatchObject({ identity: "host-shell-execution-plan/v4:linux:mxc", sandboxed: true,
      egressProtocolCoverage: { dns: "unknown", rawIp: "unknown" } });
    setContainerShellSubstrate("linux", { state: "available", rawIpProbe: { rawIp: "unknown", reason: "timeout", reachableTargets: [], udpArrival: "absent" } });
    expect(getHostShellExecutionPlan().egressProtocolCoverage).toEqual({ dns: "unknown", rawIp: "unknown" });
    expect(getContainerShellInfo()).toMatchObject({ rawIpProbe: { rawIp: "unknown", reason: "timeout" } });
    setContainerShellSubstrate("linux", { state: "available",
      rawIpProbe: { rawIp: "blocked", reason: "blocked", evidenceKind: "arrival", reachableTargets: [], udpArrival: "absent" } });
    expect(getHostShellExecutionPlan().egressProtocolCoverage).toEqual({ dns: "unknown", rawIp: "blocked" });
    expect(getContainerShellInfo()?.egressProtocolCoverage).toEqual({ dns: "unknown", rawIp: "blocked" });
    // The hook wrap is not the container, so it never carries the container's measurement.
    expect(getHostShellExecutionPlan("default", "hook").egressProtocolCoverage.rawIp).toBe("unknown");
  });

  it("starts the relay on enabled POSIX shell routes", async () => {
    try {
      const sandbox = await initializeAsrtSandbox({ allowedDomains: [] }, async () => false);
      expect(sandbox.isCurrent()).toBe(true);
      const lease = openEgressInvocation({ kind: "shell", toolName: "bash", requiresListener: true,
        toolUseId: undefined, context: { approvalSurface: "unavailable", sessionId: undefined, workspaceRoot: undefined } });
      try {
        expect(egressIdentityStrength("shell", { identity: "listener", attributionKey: lease.token })).toBe("shared");
        const relay = await openEgressRelay(lease.token);
        await relay.close();
      } finally { lease.release(); }
    } finally {
      await resetAsrtSandbox();
    }
  });
});

describe("container route call sites", () => {
  const sources = execFileSync("git", ["ls-files", "-z", "src", "tools", "scripts"], { encoding: "utf8" }).split("\0")
    .filter((file) => /\.[cm]?[jt]sx?$/u.test(file)
      && !/\/(?:__tests__|__probes__)\//u.test(file) && !/\.test\.[cm]?[jt]sx?$/u.test(file))
    .map((file) => ({ file, source: readFileSync(file, "utf8") }));

  function callers(pattern: RegExp, definition: string): string[] {
    return sources.filter(({ file, source }) => file !== definition && pattern.test(source)).map(({ file }) => file);
  }

  it("permits only the boot producer to publish the Windows substrate", () => {
    expect(callers(/\bsetWindowsSandboxSubstrate\s*\(/u, "src/permissions/sandbox-capability.ts"))
      .toEqual(["src/boot/steps/sandbox-init.ts"]);
  });

  it("lets only the offline holder session open a Unix-socket directory, and only the document engine start one (L-O1)", () => {
    expect(callers(/\bunixSocketDirectory\b/u, "src/permissions/seatbelt-holder-launch.ts")).toEqual(["src/sandbox/wrap-bundled-command.ts"]);
    expect(callers(/\bsession:\s*\{\s*writeRoot:/u, "src/sandbox/wrap-bundled-command.ts")).toEqual(["src/permissions/offline-process-sandbox.ts"]);
    expect(callers(/\bstartOfflineProcessHolder\s*\(/u, "src/permissions/offline-process-sandbox.ts")).toEqual(["src/observation/libreoffice-process.ts"]);
  });

  it("shares the request builder between boot verification and the POSIX shell launch", () => {
    // The macOS and Linux holder launches rank their rows with the same function, never a copy.
    expect(callers(/\brankPosixContainerRows\b/u, "src/permissions/mxc-posix.ts"))
      .toEqual(["src/permissions/holder-admission-linux.ts", "src/permissions/mxc-linux.ts", "src/permissions/mxc-macos.ts",
        "src/permissions/seatbelt-holder-launch.ts", "src/tools/mxc-posix-shell-launch.ts"]);
    expect(callers(/\bmxc-macos\.[jt]s\b|\bdetectHostMxcMacShellSupport\b/u, "src/permissions/mxc-macos.ts"))
      .toEqual(["src/boot/steps/sandbox-init.ts", "src/permissions/mxc-shell-supervisor-service.ts", "src/tools/mxc-posix-shell-launch.ts"]);
    expect(callers(/\bsetContainerShellSubstrate\s*\(/u, "src/permissions/sandbox-capability.ts"))
      .toEqual(["src/boot/steps/sandbox-init.ts"]);
  });

  it("keeps workload signalling out of the macOS shell routes", () => {
    const files = [
      "src/tools/mxc-posix-shell-launch.ts",
      "src/permissions/mxc-macos.ts",
      "src/permissions/mxc-shell-supervisor-client.ts",
      "src/permissions/mxc-shell-supervisor.ts",
      "src/permissions/mxc-shell-supervisor-service.ts",
    ];
    const route = files.map(file => readFileSync(file, "utf8")).join("\n");
    expect(route).not.toMatch(/(?:\bexecFile\b|\bps\b|\bpgrep\b|mxc-exec-mac|\bprocess\.kill\b|\bdetached\s*:)/u);
    expect(route.match(/\b\w+\.kill\s*\([^)]*\)/gu)).toEqual(['child.kill("SIGKILL")']);
    expect(route).toMatch(/if \(result\.cleanupUnverified[^\n]*\) \{\s*child\.kill\("SIGKILL"\);/u);
  });

  it("limits the route selector to relay startup and holder selection", () => {
    const definition = "src/shared/container-platform.ts";
    expect(callers(/\bisContainerRouteEnabled\b/u, definition)).toEqual([]);
    expect(callers(/\bisContainerShellRouteEnabled\s*\(/u, definition)).toEqual([
      "src/boot/steps/sandbox-init.ts", "src/permissions/asrt-sandbox.ts", "src/permissions/sandbox-capability.ts",
    ]);
    expect(callers(/\bisContainerHolderRouteEnabled\s*\(/u, definition))
      // Boot runs the macOS holder route check only once the holder route is on.
      // Row 2 admits a macOS user hook on the proven holder route; the hook plan puts it there only on that route.
      // A `process` plugin launch is refused wherever the holder route runs plugins (owner card 2026-11-28).
      .toEqual(["src/boot/steps/sandbox-init.ts", "src/permissions/asrt-sandbox.ts", "src/permissions/confined-child.ts",
        "src/permissions/sandbox-capability.ts", "src/plugins/isolation/out-of-process-plugin.ts", "src/sandbox/wrap-bundled-command.ts"]);
  });
});
