import type { SandboxWindowsSubstrateInfo } from "../shared/sandbox-capability-info.js";
import {
  checkAsrtDependencies,
  getWindowsConfinementRoute,
  isWindowsAccountConfinementOperational,
} from "./asrt-sandbox.js";
import { detectHostMxcPrerequisites, probeHostMxcPowerShellStart, requireHostWxcExecFile } from "./mxc-windows.js";
import { detectMxcShellCapability, getWindowsSandboxSubstrate } from "./sandbox-capability.js";

export type WindowsBackendState = "operational" | "absent" | "unavailable";

export interface WindowsBackendEvidence {
  readonly epoch: number;
  readonly state: WindowsBackendState;
}

export interface WindowsBackendEvidenceProvider {
  /** Identities the evidence is bound to. Evidence gathered for other identities is void. */
  readonly route: () => readonly unknown[];
  /** Asks, off the event loop, whether the published route still has every guarantee it was published with. */
  readonly probeRoute: () => Promise<boolean>;
  /** Asks, off the event loop, whether the backend is still cleanly not installed. */
  readonly probeAbsence: () => Promise<boolean>;
  /** Whether the boot record publishes this backend as a confinement route. */
  readonly isRoutePublished: (substrate: SandboxWindowsSubstrateInfo) => boolean;
  /** Whether the boot record holds affirmative absence for this backend. */
  readonly isAbsentAtBoot: (substrate: SandboxWindowsSubstrateInfo) => boolean;
}

function sameRoute(left: readonly unknown[], right: readonly unknown[]): boolean {
  return left.length === right.length && left.every((identity, index) => Object.is(identity, right[index]));
}

/** Holds one backend's evidence. A refresh never demotes settled evidence; only its result, an invalidation or a route change replaces it. */
export class WindowsBackendEvidenceOwner {
  private epoch = 0;
  private settled: (WindowsBackendEvidence & { readonly route: readonly unknown[] }) | undefined;
  private pending: Promise<void> | undefined;

  constructor(readonly provider: WindowsBackendEvidenceProvider) {}

  /** One probe at a time: callers arriving during a probe share its result. */
  refresh(): Promise<void> {
    this.pending ??= this.probe().finally(() => { this.pending = undefined; });
    return this.pending;
  }

  private async probe(): Promise<void> {
    const epoch = ++this.epoch;
    let route: readonly unknown[] | undefined;
    let state: WindowsBackendState = "unavailable";
    try {
      route = this.provider.route();
      // Only the role the boot record gives a backend is worth a native query.
      const substrate = getWindowsSandboxSubstrate();
      if (substrate !== null && this.provider.isRoutePublished(substrate)) {
        if (await this.provider.probeRoute()) state = "operational";
      } else if (substrate !== null && this.provider.isAbsentAtBoot(substrate)) {
        if (await this.provider.probeAbsence()) state = "absent";
      }
    } catch {
      state = "unavailable";
    }
    // An invalidation or a route change during the probe voids its answer.
    if (epoch !== this.epoch) return;
    this.settled = undefined;
    try {
      if (route !== undefined && sameRoute(route, this.provider.route())) this.settled = { epoch, state, route };
    } catch { /* No route identity, no evidence. */ }
  }

  invalidate(): void {
    this.epoch += 1;
    this.settled = undefined;
  }

  current(): WindowsBackendEvidence | undefined {
    if (this.settled === undefined) return undefined;
    try {
      if (sameRoute(this.settled.route, this.provider.route())) return this.settled;
    } catch { /* Fall through to invalidation. */ }
    this.invalidate();
    return undefined;
  }
}

/** Clean inventory evidence that no account backend is installed. Errors and warnings cannot supply it. */
export function isWindowsAccountBackendAbsent(dependencies: Awaited<ReturnType<typeof checkAsrtDependencies>>): boolean {
  return dependencies.accountBackendAbsent === true && dependencies.errors.length === 0
    && dependencies.dependencyFailure === undefined && dependencies.warnings.length === 0;
}

const accountBackend = new WindowsBackendEvidenceOwner({
  route: () => [...getWindowsConfinementRoute(), getWindowsSandboxSubstrate()],
  probeRoute: () => isWindowsAccountConfinementOperational(),
  probeAbsence: async () => isWindowsAccountBackendAbsent(await checkAsrtDependencies()),
  isRoutePublished: (substrate) => substrate.srtWinReady && substrate.accountBackendAbsent !== true,
  isAbsentAtBoot: (substrate) => substrate.accountBackendAbsent === true && !substrate.srtWinReady,
});

const containerBackend = new WindowsBackendEvidenceOwner({
  route: () => [...getWindowsConfinementRoute(), getWindowsSandboxSubstrate(), detectMxcShellCapability()],
  probeRoute: async () => {
    requireHostWxcExecFile();
    return (await probeHostMxcPowerShellStart()).state === "available";
  },
  probeAbsence: async () => {
    const support = await detectHostMxcPrerequisites();
    return support.state === "unavailable" && support.reason === "container-unavailable"
      && support.containerBackendAbsent === true && support.baseContainerApiPresent === false;
  },
  isRoutePublished: (substrate) => substrate.mxc.state === "available" && substrate.shells === "mxc"
    && detectMxcShellCapability()?.confidence === "verified",
  isAbsentAtBoot: (substrate) => substrate.mxc.state === "unavailable" && substrate.mxc.reason === "container-unavailable"
    && substrate.mxc.containerBackendAbsent === true,
});

/** Every backend that can confine background work on Windows. Removing a backend removes its entry. */
export const WINDOWS_BACKEND_EVIDENCE: readonly WindowsBackendEvidenceOwner[] = [accountBackend, containerBackend];

/** A failed launch or a withdrawn route: nothing gathered before it may admit work. */
export function invalidateWindowsBackendEvidence(): void {
  for (const owner of WINDOWS_BACKEND_EVIDENCE) owner.invalidate();
}

/** Probes every backend for the calling operation and returns what each probe established. */
export async function refreshWindowsBackendEvidence(): Promise<ReadonlyMap<WindowsBackendEvidenceOwner, WindowsBackendEvidence | undefined>> {
  await Promise.all(WINDOWS_BACKEND_EVIDENCE.map((owner) => owner.refresh()));
  return new Map(WINDOWS_BACKEND_EVIDENCE.map((owner) => [owner, owner.current()]));
}
