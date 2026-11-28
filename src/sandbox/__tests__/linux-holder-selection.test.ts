import { afterEach, describe, expect, it, vi } from "vitest";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";

const route = vi.hoisted(() => ({ linux: false }));
vi.mock("../../shared/container-platform.js", async (actual) => {
  const real = await actual<typeof import("../../shared/container-platform.js")>();
  return { ...real, isContainerHolderRouteEnabled: (platform: NodeJS.Platform) => platform === "linux" ? route.linux : real.isContainerHolderRouteEnabled(platform) };
});

const { isMxcExtensionBackendSelected } = await import("../wrap-bundled-command.js");
const { setProvenLinuxHolderRoute } = await import("../../permissions/linux-holder-route.js");
const { __resetSandboxRequestedAtBootForTest, setPluginWorkerConfinementRequestedAtBoot } = await import("../../permissions/sandbox-capability.js");

const PROVEN = {
  programs: { launcher: "/opt/ave/lxc-exec", helper: "/opt/ave/apply-seccomp", env: {}, validate: () => {} },
  helperSha256: "0".repeat(64), captureFolder: "/run/ave/bwrap-capture", bwrap: { path: "/usr/bin/bwrap", identity: "1:2:3:4:5" },
};

const ORIGINAL_PLATFORM = process.platform;

describe("Linux holder selection", () => {
  afterEach(() => {
    setProvenLinuxHolderRoute(undefined);
    __resetSandboxRequestedAtBootForTest();
    route.linux = false;
    setProcessPlatform(ORIGINAL_PLATFORM);
  });

  it("selects the container for every holder caller only with the route switched on and proven this app run", () => {
    setProcessPlatform("linux");
    setPluginWorkerConfinementRequestedAtBoot(true);
    expect(isMxcExtensionBackendSelected()).toBe(false);
    setProvenLinuxHolderRoute(PROVEN);
    // Proven but switched off: the callers stay where they are.
    expect(isMxcExtensionBackendSelected()).toBe(false);
    route.linux = true;
    expect(isMxcExtensionBackendSelected()).toBe(true);
    // Switched on but unproven: no holder start.
    setProvenLinuxHolderRoute(undefined);
    expect(isMxcExtensionBackendSelected()).toBe(false);
  });
});
