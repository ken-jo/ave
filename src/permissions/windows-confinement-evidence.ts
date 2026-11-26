import type { SandboxWindowsSubstrateInfo } from "../shared/sandbox-capability-info.js";
import {
  checkAsrtDependencies,
  getWindowsAccountConfinementHelperIdentity,
  getWindowsConfinementRoute,
  isWindowsAccountConfinementOperational,
} from "./asrt-sandbox.js";
import { detectHostMxcPrerequisites, getHostWxcExecIdentity, mayIndicateMxcShellStartupFailure, probeHostMxcPowerShellStart, resolveHostWxcExecPath } from "./mxc-windows.js";
import { detectMxcShellCapability, getSandboxGeneration, getWindowsExtensionBackendPlan, getWindowsSandboxSubstrate } from "./sandbox-capability.js";

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

/** Owns the epoch and the exact receipt issued by its current probe. */
export class WindowsBackendEvidenceOwner {
  private epoch = 0;
  private settled: (WindowsBackendEvidence & { readonly route: readonly unknown[] }) | undefined;
  private pending: { route: readonly unknown[]; receipt: Promise<WindowsBackendEvidence | undefined> } | undefined;

  constructor(readonly provider: WindowsBackendEvidenceProvider) {}

  /** One probe at a time: callers arriving during a probe share its result. */
  refresh(): Promise<WindowsBackendEvidence | undefined> {
    let route: readonly unknown[];
    try {
      route = this.provider.route();
    } catch {
      this.invalidate();
      return Promise.resolve(undefined);
    }
    if (this.pending !== undefined && sameRoute(this.pending.route, route)) return this.pending.receipt;
    const epoch = ++this.epoch;
    this.settled = undefined;
    const receipt = Promise.resolve().then(() => this.probe(epoch, route)).finally(() => {
      if (this.pending?.receipt === receipt) this.pending = undefined;
    });
    this.pending = { route, receipt };
    return receipt;
  }

  private async probe(epoch: number, route: readonly unknown[]): Promise<WindowsBackendEvidence | undefined> {
    if (epoch !== this.epoch) return undefined;
    let state: WindowsBackendState = "unavailable";
    try {
      if (!sameRoute(route, this.provider.route())) return undefined;
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
    if (epoch !== this.epoch) return undefined;
    try {
      if (sameRoute(route, this.provider.route())) {
        this.settled = { epoch, state, route };
        return this.settled;
      }
    } catch { /* No route identity, no evidence. */ }
    return undefined;
  }

  invalidate(): void {
    this.epoch += 1;
    this.settled = undefined;
    this.pending = undefined;
  }

  isCurrent(receipt: WindowsBackendEvidence): boolean {
    return receipt.epoch === this.epoch && this.current() === receipt;
  }

  current(): WindowsBackendEvidence | undefined {
    if (this.settled?.epoch !== this.epoch) return undefined;
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
  route: () => [getSandboxGeneration(), ...getWindowsConfinementRoute(), getWindowsSandboxSubstrate(), getWindowsAccountConfinementHelperIdentity()],
  probeRoute: () => isWindowsAccountConfinementOperational(),
  probeAbsence: async () => isWindowsAccountBackendAbsent(await checkAsrtDependencies()),
  isRoutePublished: (substrate) => substrate.srtWinReady && substrate.accountBackendAbsent !== true,
  isAbsentAtBoot: (substrate) => substrate.accountBackendAbsent === true && !substrate.srtWinReady,
});

async function probeContainerPowerShellStart() {
  const launcher = getHostWxcExecIdentity();
  await resolveHostWxcExecPath(launcher);
  return await probeHostMxcPowerShellStart(launcher);
}

const containerBackend = new WindowsBackendEvidenceOwner({
  route: () => {
    const capability = detectMxcShellCapability();
    const plan = getWindowsExtensionBackendPlan();
    return [getSandboxGeneration(), ...getWindowsConfinementRoute(), getWindowsSandboxSubstrate(), capability, plan,
      capability?.confidence === "verified" || plan?.selectedBackend === "mxc" ? getHostWxcExecIdentity() : undefined];
  },
  probeRoute: async () => (await probeContainerPowerShellStart()).state === "available",
  probeAbsence: async () => {
    const support = await detectHostMxcPrerequisites();
    return support.state === "unavailable" && support.reason === "container-unavailable"
      && support.containerBackendAbsent === true && support.baseContainerApiPresent === false;
  },
  isRoutePublished: (substrate) => {
    const plan = getWindowsExtensionBackendPlan();
    return (plan?.selectedBackend === "mxc" && plan.readiness === "ready")
      || (substrate.mxc.state === "available" && substrate.shells === "mxc" && detectMxcShellCapability()?.confidence === "verified");
  },
  isAbsentAtBoot: (substrate) => substrate.mxc.state === "unavailable" && substrate.mxc.reason === "container-unavailable"
    && substrate.mxc.containerBackendAbsent === true,
});

/** Every backend that can confine background work on Windows. Removing a backend removes its entry. */
export const WINDOWS_BACKEND_EVIDENCE = { account: accountBackend, container: containerBackend } as const;
export type WindowsBackend = keyof typeof WINDOWS_BACKEND_EVIDENCE;

/** A failed launch or a withdrawn route: nothing gathered before it may admit work. */
let containerBackendLossEpoch = 0;

export function getWindowsContainerBackendLossEpoch(): number { return containerBackendLossEpoch; }

export function invalidateWindowsBackendEvidence(backend?: "account" | "container"): void {
  if (backend !== "account") {
    containerBackendLossEpoch += 1;
    containerBackend.invalidate();
  }
  if (backend !== "container") accountBackend.invalidate();
}

/** Test the shared backend with a fixed command while preserving existing receipts on a healthy start. */
export async function recheckWindowsContainerBackendAfterShellFailure(): Promise<void> {
  try {
    const route = containerBackend.provider.route();
    const lossEpoch = containerBackendLossEpoch;
    const support = await probeContainerPowerShellStart();
    const confirmedLoss = support.state === "unavailable" && (support.reason === "unverified-session"
      || (support.reason === "powershell-start-failed" && mayIndicateMxcShellStartupFailure(1, support.detail)));
    if (confirmedLoss && lossEpoch === containerBackendLossEpoch && sameRoute(route, containerBackend.provider.route())) {
      invalidateWindowsBackendEvidence("container");
    }
  } catch { /* An inconclusive check cannot establish shared backend loss. */ }
}

/** Probes every backend for the calling operation and returns what each probe established. */
export async function refreshWindowsBackendEvidence(): Promise<ReadonlyMap<WindowsBackendEvidenceOwner, WindowsBackendEvidence | undefined>> {
  const receipts = await Promise.all(Object.values(WINDOWS_BACKEND_EVIDENCE).map(async (owner) => [owner, await owner.refresh()] as const));
  return new Map(receipts);
}
