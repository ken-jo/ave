import { windowsExtensionPlan, type SandboxWindowsSubstrateInfo } from "../shared/sandbox-capability-info.js";
import { TOOL_TIMEOUT_POLICY } from "../shared/tool-timeout-policy.js";
import {
  checkAsrtDependencies,
  getWindowsAccountConfinementHelperIdentity,
  getWindowsConfinementRoute,
  isWindowsAccountConfinementOperational,
} from "./asrt-sandbox.js";
import { detectHostMxcPrerequisites, getHostWxcExecIdentity, mayIndicateMxcShellStartupFailure, probeHostMxcPowerShellStart, resolveHostWxcExecPath } from "./mxc-windows.js";
import { detectMxcShellCapability, getSandboxGeneration, getExtensionBackendPlan, getWindowsSandboxSubstrate } from "./sandbox-capability.js";

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

  constructor(readonly provider: WindowsBackendEvidenceProvider, private readonly onSuperseded?: () => void) {}

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
    this.onSuperseded?.();
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
    this.onSuperseded?.();
  }

  /** The evidence generation and route a failure observer starts measuring against. */
  observe(): { readonly epoch: number; readonly route: readonly unknown[] | undefined } {
    try {
      return { epoch: this.epoch, route: this.provider.route() };
    } catch {
      return { epoch: this.epoch, route: undefined };
    }
  }

  /** Whether nothing has replaced the evidence since `observe` returned this generation. */
  isObserved(observed: { readonly epoch: number; readonly route: readonly unknown[] | undefined }): boolean {
    if (observed.route === undefined || observed.epoch !== this.epoch) return false;
    try {
      return sameRoute(observed.route, this.provider.route());
    } catch {
      return false;
    }
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

const containerEvidenceListeners = new Set<() => void>();
const containerEvidenceChanged = () => { for (const listener of containerEvidenceListeners) listener(); };

export function onWindowsContainerEvidenceChanged(listener: () => void): () => void {
  containerEvidenceListeners.add(listener);
  return () => { containerEvidenceListeners.delete(listener); };
}

const containerBackend = new WindowsBackendEvidenceOwner({
  route: () => {
    const capability = detectMxcShellCapability();
    const plan = windowsExtensionPlan(getExtensionBackendPlan());
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
    const plan = windowsExtensionPlan(getExtensionBackendPlan());
    return (plan?.selectedBackend === "mxc" && plan.readiness === "ready")
      || (substrate.mxc.state === "available" && substrate.shells === "mxc" && detectMxcShellCapability()?.confidence === "verified");
  },
  isAbsentAtBoot: (substrate) => substrate.mxc.state === "unavailable" && substrate.mxc.reason === "container-unavailable"
    && substrate.mxc.containerBackendAbsent === true,
}, containerEvidenceChanged);

/** Every backend that can confine background work on Windows. Removing a backend removes its entry. */
export const WINDOWS_BACKEND_EVIDENCE = { account: accountBackend, container: containerBackend } as const;
export type WindowsBackend = keyof typeof WINDOWS_BACKEND_EVIDENCE;

/** A failed launch or a withdrawn route: nothing gathered before it may admit work. */
let containerBackendLossEpoch = 0;

export function getWindowsContainerBackendLossEpoch(): number { return containerBackendLossEpoch; }

/** Voids the named evidence now. Asynchronous failure observers report through `reportWindowsBackendLoss` instead. */
export function invalidateWindowsBackendEvidence(backend?: WindowsBackend): void {
  if (backend !== "account") {
    containerBackendLossEpoch += 1;
    containerBackend.invalidate();
  }
  if (backend !== "container") accountBackend.invalidate();
}

declare const WINDOWS_BACKEND_OBSERVATION: unique symbol;
/** What a failure observer measured against: one backend's evidence generation and route. */
export interface WindowsBackendObservation { readonly [WINDOWS_BACKEND_OBSERVATION]: true; readonly backend: WindowsBackend }

type ContainerObservationScope = "shell" | "extension" | "common";
const observations = new WeakMap<WindowsBackendObservation, {
  scope: ContainerObservationScope;
  measured: ReturnType<WindowsBackendEvidenceOwner["observe"]>;
  extensionEpoch: number;
  extensionRoute: readonly unknown[];
}>();
const extensionRoute = () => [getSandboxGeneration(), ...getWindowsConfinementRoute(), windowsExtensionPlan(getExtensionBackendPlan())];

/** Taken before a failure observer starts measuring, so its later report can only reach the evidence it measured. */
export function observeWindowsBackend(backend: WindowsBackend, scope: ContainerObservationScope = "common"): WindowsBackendObservation {
  const observation = Object.freeze({ backend }) as WindowsBackendObservation;
  observations.set(observation, { scope, measured: WINDOWS_BACKEND_EVIDENCE[backend].observe(),
    extensionEpoch: containerBackendLossEpoch, extensionRoute: extensionRoute() });
  return observation;
}

/** Revokes the evidence the observer measured. A report that outlived that evidence is dropped: it changes nothing. */
export function reportWindowsBackendLoss(observation: WindowsBackendObservation): boolean {
  const observed = observations.get(observation);
  if (!observed) return false;
  if (observation.backend === "account") {
    if (!accountBackend.isObserved(observed.measured)) return false;
    accountBackend.invalidate();
    return true;
  }
  const shellLost = observed.scope !== "extension" && containerBackend.isObserved(observed.measured);
  const extensionLost = observed.scope !== "shell" && containerBackendLossEpoch === observed.extensionEpoch
    && sameRoute(observed.extensionRoute, extensionRoute());
  if (shellLost) containerBackend.invalidate();
  if (extensionLost) {
    containerBackendLossEpoch += 1;
    containerEvidenceChanged();
  }
  return shellLost || extensionLost;
}

let confirmation: Promise<void> | undefined;
let confirmationIntervalMs = 0;
let confirmationNotBefore = Number.NEGATIVE_INFINITY;

/**
 * Tests the shared backend with a fixed command after an ambiguous shell completion. One confirmation runs at a time and
 * every completion arriving meanwhile shares it. The next one waits out an interval that doubles while no loss is
 * confirmed. A skipped or inconclusive confirmation establishes nothing: it neither revokes nor admits.
 */
export function recheckWindowsContainerBackendAfterShellFailure(dispatch?: WindowsBackendObservation): Promise<void> {
  if (dispatch !== undefined) {
    const observed = observations.get(dispatch);
    if (dispatch.backend !== "container" || observed === undefined || !containerBackend.isObserved(observed.measured)) return Promise.resolve();
  }
  if (confirmation !== undefined) return confirmation;
  if (performance.now() < confirmationNotBefore) return Promise.resolve();
  const observation = observeWindowsBackend("container", "shell");
  const flight: Promise<void> = (async () => {
    let confirmedLoss = false;
    try {
      const support = await probeContainerPowerShellStart();
      confirmedLoss = support.state === "unavailable" && (support.reason === "unverified-session"
        || (support.reason === "powershell-start-failed" && mayIndicateMxcShellStartupFailure(1, support.detail)));
    } catch { /* An inconclusive check cannot establish shared backend loss. */ }
    if (confirmedLoss) reportWindowsBackendLoss(observation);
    const { windowsContainerConfirmationMinIntervalMs: min, windowsContainerConfirmationMaxIntervalMs: max } = TOOL_TIMEOUT_POLICY;
    confirmationIntervalMs = confirmedLoss ? min : Math.min(max, Math.max(min, confirmationIntervalMs * 2));
    confirmationNotBefore = performance.now() + confirmationIntervalMs;
  })().finally(() => {
    if (confirmation === flight) confirmation = undefined;
  });
  confirmation = flight;
  return flight;
}

/** Probes every backend for the calling operation and returns what each probe established. */
export async function refreshWindowsBackendEvidence(): Promise<ReadonlyMap<WindowsBackendEvidenceOwner, WindowsBackendEvidence | undefined>> {
  const receipts = await Promise.all(Object.values(WINDOWS_BACKEND_EVIDENCE).map(async (owner) => [owner, await owner.refresh()] as const));
  return new Map(receipts);
}
