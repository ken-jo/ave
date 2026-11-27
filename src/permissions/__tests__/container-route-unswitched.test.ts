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
  detectMxcShellCapability, getHostShellExecutionPlan, getMacContainerShellInfo, setActiveSandboxCapability, setContainerShellSubstrate, setShellSandboxRequestedAtBoot,
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
    setContainerShellSubstrate({ state: "available" });
    expect(getHostShellExecutionPlan()).toMatchObject({
      identity: "host-shell-execution-plan/v4:darwin:mxc", sandboxed: true,
      egressProtocolCoverage: { dns: "blocked", rawIp: "blocked" },
    });
    expect(getHostShellExecutionPlan("default", "hook").identity).toBe("host-shell-execution-plan/v4:darwin:asrt");
    expect(getMacContainerShellInfo()).toEqual({ state: "available", egressProtocolCoverage: { dns: "blocked", rawIp: "blocked" } });
    setContainerShellSubstrate({ state: "unavailable", reason: "shell-start-failed" });
    expect(getMacContainerShellInfo()).toMatchObject({ state: "unavailable", reason: "shell-start-failed" });
    expect(getHostShellExecutionPlan()).toMatchObject({
      mode: "plain", substrate: "none", requiresExplicitUserApproval: true, fallbackReason: "active-sandbox-not-shell-contained",
    });
    expect(getHostShellExecutionPlan("default", "hook").identity).toBe("host-shell-execution-plan/v4:darwin:asrt");
    __resetActiveSandboxCapabilityForTest();
    expect(getHostShellExecutionPlan().fallbackReason).toBe("requested-sandbox-unavailable");
  });

  it.runIf(platform === "linux")("keeps the Linux shell on its wrap and both container routes off", () => {
    publishWrap();
    expect(isContainerShellRouteEnabled(platform)).toBe(false);
    expect(isContainerHolderRouteEnabled(platform)).toBe(false);
    expect(detectMxcShellCapability()).toBeUndefined();
    expect(getHostShellExecutionPlan().identity).toBe("host-shell-execution-plan/v4:linux:asrt");
  });

  it("starts the relay only on the enabled macOS shell route", async () => {
    try {
      const sandbox = await initializeAsrtSandbox({ allowedDomains: [] }, async () => false);
      expect(sandbox.isCurrent()).toBe(true);
      const lease = openEgressInvocation({ kind: "shell", toolName: "bash", requiresListener: true,
        toolUseId: undefined, context: { approvalSurface: "unavailable", sessionId: undefined, workspaceRoot: undefined } });
      try {
        if (platform === "darwin") {
          expect(egressIdentityStrength("shell", { identity: "listener", attributionKey: lease.token })).toBe("shared");
          const relay = await openEgressRelay(lease.token);
          await relay.close();
        } else {
          await expect(openEgressRelay(lease.token)).rejects.toThrow("the service is not started");
        }
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

  it("shares the request builder between boot verification and the POSIX shell launch", () => {
    expect(callers(/\brankPosixContainerRows\b/u, "src/permissions/mxc-posix.ts"))
      .toEqual(["src/permissions/mxc-macos.ts"]);
    expect(callers(/\bmxc-macos\.[jt]s\b|\bdetectHostMxcMacShellSupport\b/u, "src/permissions/mxc-macos.ts"))
      .toEqual(["src/boot/steps/sandbox-init.ts", "src/tools/mxc-posix-shell-launch.ts"]);
    expect(callers(/\bsetContainerShellSubstrate\s*\(/u, "src/permissions/sandbox-capability.ts"))
      .toEqual(["src/boot/steps/sandbox-init.ts"]);
  });

  it("limits the route selector to relay startup and holder selection", () => {
    const definition = "src/shared/container-platform.ts";
    expect(callers(/\bisContainerRouteEnabled\b/u, definition)).toEqual([]);
    expect(callers(/\bisContainerShellRouteEnabled\s*\(/u, definition)).toEqual([
      "src/boot/steps/sandbox-init.ts", "src/permissions/asrt-sandbox.ts", "src/permissions/sandbox-capability.ts",
    ]);
    expect(callers(/\bisContainerHolderRouteEnabled\s*\(/u, definition))
      .toEqual(["src/permissions/asrt-sandbox.ts", "src/sandbox/wrap-bundled-command.ts"]);
  });
});
