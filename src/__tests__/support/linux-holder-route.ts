// Linux with its holder route on: what boot's holder canary would publish, set up for a suite that drives real holders
// (the pinned launcher, the filter helper and the system bwrap). Where any of them is missing this throws: a suite that
// requires sandbox cases fails rather than skips.
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { vi } from "vitest";
import { isContainerHolderRouteEnabled } from "../../shared/container-platform.js";
import { startEgressRelayService, stopEgressRelayService, type EgressRelayAsk } from "../../permissions/egress-relay/relay.js";
import { setProvenLinuxHolderRoute } from "../../permissions/linux-holder-route.js";
import { linuxHolderBwrap, requireMxcLinuxShellPrograms } from "../../permissions/mxc-linux.js";
import { establishLinuxCaptureFolder } from "../../permissions/mxc-linux-holder-launch.js";
import seccompPins from "../../permissions/mxc-linux-seccomp-pins.json" with { type: "json" };
import { currentMxcRuntimeHost, establishMxcRuntimeRoot, requireMxcContainerStartRoot, _forgetMxcRuntimeRootForTest } from "../../permissions/mxc-runtime-root.js";
import { setLinuxHolderSupport, setPluginWorkerConfinementRequestedAtBoot } from "../../permissions/sandbox-capability.js";
import { releaseHolderTestWorkspace } from "./holder-test-workspace.js";

/** True where plugin children, workers, MCP servers and hooks run as Linux holders rather than in the wrap. */
export const LINUX_HOLDER_ROUTE = process.platform === "linux" && isContainerHolderRouteEnabled("linux");

export interface ProvenLinuxHolderRouteFixture {
  /** Undo everything, in reverse: relay, proof, canary result, runtime root, its base directory. */
  release(): Promise<void>;
}

/**
 * Publishes a proven holder route, the canary's `available`, and (unless `extensions: false`) a boot that requested
 * extension isolation. The container runtime root gets a base of its own outside the Ave home. `ask` answers the
 * holders' relay; it denies by default.
 */
export async function provenLinuxHolderRouteFixture(
  options: { readonly ask?: EgressRelayAsk; readonly extensions?: boolean } = {},
): Promise<ProvenLinuxHolderRouteFixture> {
  if (!LINUX_HOLDER_ROUTE) throw new Error("provenLinuxHolderRouteFixture needs Linux with the holder route on");
  const base = realpathSync.native(mkdtempSync(join("/tmp", "ave-holder-route-")));
  vi.stubEnv("AVE_TEST_SANDBOX_BASE", base);
  const cache = currentMxcRuntimeHost().cacheHome;
  establishMxcRuntimeRoot();
  const programs = await requireMxcLinuxShellPrograms({ resourcePath: resolve("resources"), isPackaged: false });
  const pin = seccompPins[process.arch === "arm64" ? "arm64" : "x64"];
  startEgressRelayService({ ask: options.ask ?? (async () => false) });
  setProvenLinuxHolderRoute({
    programs, helperSha256: pin, captureFolder: establishLinuxCaptureFolder(requireMxcContainerStartRoot(), programs.helper, pin),
    bwrap: linuxHolderBwrap("/usr/bin/bwrap"),
  });
  setLinuxHolderSupport({ state: "available" });
  if (options.extensions !== false) setPluginWorkerConfinementRequestedAtBoot(true);
  let released: Promise<void> | undefined;
  return {
    release: () => released ??= (async () => {
      await stopEgressRelayService();
      setProvenLinuxHolderRoute(undefined);
      setLinuxHolderSupport(undefined);
      if (options.extensions !== false) setPluginWorkerConfinementRequestedAtBoot(false);
      _forgetMxcRuntimeRootForTest(cache);
      rmSync(base, { recursive: true, force: true });
      releaseHolderTestWorkspace();
    })(),
  };
}
