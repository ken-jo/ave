// macOS with its holder route on: what boot's holder check would publish, set up for a suite that drives real holders
// (the launch gate, /usr/bin/sandbox-exec, the ready shim and the label helper built by test:prepare).
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { vi } from "vitest";
import { isContainerHolderRouteEnabled } from "../../shared/container-platform.js";
import { startEgressRelayService, stopEgressRelayService, type EgressRelayAsk } from "../../permissions/egress-relay/relay.js";
import { verifyHolderSweepHelper } from "../../permissions/holder-label-sweep.js";
import { currentMxcRuntimeHost, establishMxcRuntimeRoot, _forgetMxcRuntimeRootForTest } from "../../permissions/mxc-runtime-root.js";
import { __resetMacExtensionPlanForTest, setMacExtensionPlan, setMacHolderCapability } from "../../permissions/sandbox-capability.js";
import { __setProvenSeatbeltHolderRouteForTest } from "../../permissions/seatbelt-holder-boot.js";
import { closeHeldHolderLeases, measureSeatbeltHolderLaunchers } from "../../permissions/seatbelt-holder-launch.js";
import { releaseHolderTestWorkspace } from "./holder-test-workspace.js";

/** True where plugin children, workers, MCP servers and hooks run as holders rather than in the wrap. */
export const MAC_HOLDER_ROUTE = process.platform === "darwin" && isContainerHolderRouteEnabled("darwin");

export interface ProvenMacHolderRoute {
  /** Undo everything, in reverse: leases, relay, proof, plan, runtime root, its base directory. */
  release(): Promise<void>;
}

/**
 * Publishes a proven holder route and a ready extension plan. The container runtime root may not sit in the Ave home,
 * so it gets a base of its own outside it. `ask` answers the holders' relay; it denies by default.
 */
export function provenMacHolderRoute(options: { readonly ask?: EgressRelayAsk; readonly extensions?: boolean } = {}): ProvenMacHolderRoute {
  if (!MAC_HOLDER_ROUTE) throw new Error("provenMacHolderRoute needs macOS with the holder route on");
  const base = realpathSync.native(mkdtempSync(join("/private/tmp", "ave-holder-route-")));
  vi.stubEnv("AVE_TEST_SANDBOX_BASE", base);
  const cache = currentMxcRuntimeHost().cacheHome;
  establishMxcRuntimeRoot();
  startEgressRelayService({ ask: options.ask ?? (async () => false) });
  __setProvenSeatbeltHolderRouteForTest({ helper: verifyHolderSweepHelper(resolve("resources")), launchers: measureSeatbeltHolderLaunchers() });
  setMacHolderCapability({ state: "ready" });
  if (options.extensions !== false) {
    setMacExtensionPlan({ platform: "darwin", requestedBackend: "mxc", selectedBackend: "mxc", readiness: "ready", reason: "ready", egressIdentity: "shared" });
  }
  let released: Promise<void> | undefined;
  return {
    release: () => released ??= (async () => {
      await closeHeldHolderLeases();
      await stopEgressRelayService();
      __setProvenSeatbeltHolderRouteForTest(undefined);
      __resetMacExtensionPlanForTest();
      _forgetMxcRuntimeRootForTest(cache);
      rmSync(base, { recursive: true, force: true });
      releaseHolderTestWorkspace();
    })(),
  };
}
