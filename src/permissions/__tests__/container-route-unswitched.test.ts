import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { isContainerHolderRouteEnabled, isContainerShellRouteEnabled } from "../../shared/container-platform.js";
import { configureHostResources } from "../../main/host-resources.js";
import { initializeAsrtSandbox, resetAsrtSandbox } from "../asrt-sandbox.js";
import { openEgressRelay } from "../egress-relay/relay.js";
import {
  __resetActiveSandboxCapabilityForTest, __resetSandboxRequestedAtBootForTest,
  detectMxcShellCapability, getHostShellExecutionPlan, setActiveSandboxCapability, setShellSandboxRequestedAtBoot,
} from "../sandbox-capability.js";

const platform = process.platform;

describe.runIf(platform === "darwin" || platform === "linux")("existing POSIX container route boundaries", () => {
  beforeAll(() => configureHostResources({ resourcePath: resolve("resources"), isPackaged: false }));
  afterEach(() => {
    __resetActiveSandboxCapabilityForTest();
    __resetSandboxRequestedAtBootForTest();
  });

  it("keeps the live shell plan on ASRT when sandboxing is requested", () => {
    setShellSandboxRequestedAtBoot(true);
    setActiveSandboxCapability({
      platform, kind: "asrt", confidence: "verified", reason: "Active sandbox",
      confines: { filesystem: true, process: true, network: true },
    });
    expect(isContainerShellRouteEnabled(platform)).toBe(false);
    expect(isContainerHolderRouteEnabled(platform)).toBe(false);
    expect(detectMxcShellCapability()).toBeUndefined();
    expect(getHostShellExecutionPlan().identity).toBe(`host-shell-execution-plan/v4:${platform}:asrt`);
  });

  it("keeps the container relay unstarted after sandbox initialization", async () => {
    try {
      const sandbox = await initializeAsrtSandbox({ allowedDomains: [] }, async () => false);
      expect(sandbox.isCurrent()).toBe(true);
      await expect(openEgressRelay("container-route-test-token")).rejects.toThrow("the service is not started");
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

  it("keeps the POSIX ranker disconnected from production launches", () => {
    expect(callers(/\bmxc-posix\.[jt]s\b|\brankPosixContainerRows\b/u, "src/permissions/mxc-posix.ts")).toEqual([]);
  });

  it("limits the route selector to relay startup and holder selection", () => {
    const definition = "src/shared/container-platform.ts";
    expect(callers(/\bisContainerRouteEnabled\b/u, definition)).toEqual([]);
    expect(callers(/\bisContainerShellRouteEnabled\s*\(/u, definition)).toEqual(["src/permissions/asrt-sandbox.ts"]);
    expect(callers(/\bisContainerHolderRouteEnabled\s*\(/u, definition))
      .toEqual(["src/permissions/asrt-sandbox.ts", "src/sandbox/wrap-bundled-command.ts"]);
  });
});
