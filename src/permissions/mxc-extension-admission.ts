import type { ContainerRequest } from "@microsoft/mxc-sdk/v1";
import { canonicalStringify } from "../shared/canonical-json.js";
import { assertSandboxWindowsExtensionPlan, type SandboxWindowsExtensionPlan } from "../shared/sandbox-capability-info.js";
import { MxcCapabilityUnavailableError, MxcProcessContractError } from "./mxc-extension-errors.js";
import { mxcRequestDigest, type MxcExtensionStartRecord } from "./mxc-extension-protocol.js";
import { assertMxcExtensionRequest } from "./mxc-extension-request.js";
import { classifyMxcExtensionReadiness, classifyMxcReleaseGate, settleWindowsExtensionReadiness,
  type MxcExtensionReleaseGateEvidence, type WindowsExtensionMxcState } from "./mxc-extension-readiness.js";

declare const MXC_EXTENSION_ADMISSION: unique symbol;
/** An opaque, single-use receipt for one exact native request and holder incarnation. */
export interface MxcExtensionAdmission { readonly [MXC_EXTENSION_ADMISSION]: true }

interface AdmissionIdentity {
  readonly request: ContainerRequest;
  readonly holder: object;
  /** Digest of the admitted executable's realpath and file identity, re-measured synchronously at spawn. */
  readonly executableIdentity: string;
  readonly bootPlan: SandboxWindowsExtensionPlan;
}
interface AdmissionRecord extends Omit<AdmissionIdentity, "request"> { readonly requestDigest: string; readonly bootPlanDigest: string; spent: boolean }
const admissions = new WeakMap<MxcExtensionAdmission, AdmissionRecord>();

let releaseGateEvidence: MxcExtensionReleaseGateEvidence | undefined;

/** The install-wide record (contract fields 8-13) the native release gate gathered once for this packaged build. It is an
 * install property: a start checks it and never gathers it. Nothing registers it until that gate has produced it, and
 * until then every holder start fails closed. Returns the unregister function. */
export function registerMxcReleaseGateEvidence(evidence: MxcExtensionReleaseGateEvidence): () => void {
  if (releaseGateEvidence !== undefined) throw new MxcProcessContractError("Release-gate evidence is already registered");
  const record = Object.freeze({ ...evidence });
  releaseGateEvidence = record;
  return () => {
    if (releaseGateEvidence === record) releaseGateEvidence = undefined;
  };
}

export function assertMxcReleaseGateEvidence(): void {
  if (releaseGateEvidence === undefined) {
    throw new MxcCapabilityUnavailableError("No release-gate evidence is registered for this installation; native readiness has not been established");
  }
  const state = classifyMxcReleaseGate(releaseGateEvidence);
  if (state.state === "unavailable") throw new MxcCapabilityUnavailableError(`Release-gate evidence is incomplete: ${state.reason}`);
}

/** Mints the receipt that authorizes native creation for this exact request. It carries no readiness: the holder is
 * admitted only by `admitMxcExtensionStart`, on the evidence of its own start. */
export function createMxcExtensionAdmission(input: AdmissionIdentity): MxcExtensionAdmission {
  assertMxcExtensionRequest(input.request);
  assertSandboxWindowsExtensionPlan(input.bootPlan);
  if (input.bootPlan.selectedBackend !== "mxc" || input.bootPlan.readiness !== "ready"
      || !/^[a-f0-9]{64}$/u.test(input.executableIdentity) || !input.holder || typeof input.holder !== "object") {
    throw new MxcProcessContractError("Native admission requires a captured holder and measured executable");
  }
  assertMxcReleaseGateEvidence();
  const admission = Object.freeze({}) as MxcExtensionAdmission;
  admissions.set(admission, { holder: input.holder, executableIdentity: input.executableIdentity, bootPlan: input.bootPlan,
    bootPlanDigest: canonicalStringify(input.bootPlan), requestDigest: mxcRequestDigest(input.request), spent: false });
  return admission;
}

/** Spend immediately at the native spawn boundary; a mismatch or a second use burns the receipt rather than enabling retries. */
export function consumeMxcExtensionAdmission(admission: MxcExtensionAdmission, identity: AdmissionIdentity): void {
  const record = admissions.get(admission);
  if (!record || record.spent || record.holder !== identity.holder || record.executableIdentity !== identity.executableIdentity
      || record.bootPlan !== identity.bootPlan || record.bootPlanDigest !== canonicalStringify(identity.bootPlan)
      || identity.bootPlan.selectedBackend !== "mxc" || identity.bootPlan.readiness !== "ready"
      || record.requestDigest !== mxcRequestDigest(identity.request)) {
    admissions.delete(admission);
    throw new MxcProcessContractError("Native admission evidence does not match this holder request");
  }
  assertMxcExtensionRequest(identity.request);
  record.spent = true;
}

/** Per-start admission (contract fields 1-5). `start` is this holder's own start and resolves with what its ready frame
 * carried. The holder is admitted only when that start spent this receipt, its evidence names this receipt's request and
 * every field is true, inside the readiness deadline. No evidence, another holder's evidence, a false field, expiry or
 * cancellation refuses; nothing falls back or runs another way. The caller's lifetime owner disposes a refused start. */
export async function admitMxcExtensionStart(admission: MxcExtensionAdmission, input: Pick<AdmissionIdentity, "request" | "holder" | "bootPlan"> & {
  readonly start: (signal: AbortSignal) => Promise<MxcExtensionStartRecord | undefined>;
  readonly signal?: AbortSignal;
}): Promise<void> {
  const record = admissions.get(admission);
  try {
    if (!record || record.spent || record.holder !== input.holder || record.bootPlan !== input.bootPlan
        || record.requestDigest !== mxcRequestDigest(input.request)) {
      throw new MxcProcessContractError("Native admission evidence does not match this holder request");
    }
    let startSignal: AbortSignal | undefined;
    let observed: WindowsExtensionMxcState | undefined;
    let startFailure: MxcCapabilityUnavailableError | undefined;
    const result = await settleWindowsExtensionReadiness({
      probe: async (signal) => {
        startSignal = signal;
        const started = await input.start(signal).catch((error: unknown) => {
          if (error instanceof MxcCapabilityUnavailableError) startFailure = error;
          throw error;
        });
        if (!record.spent) throw new MxcProcessContractError("Extension start did not pass admission at the native boundary");
        if (started === undefined) throw new MxcProcessContractError("Extension start carried no ready-frame evidence");
        if (started.requestDigest !== record.requestDigest) throw new MxcProcessContractError("Start evidence belongs to another holder's start");
        observed = classifyMxcExtensionReadiness(started.evidence);
        return started.evidence;
      },
      fallback: { version: "0.0.80", ready: false },
      // This holder is itself being admitted under the selected MXC plan: no fallback, no other backend.
      admittedAncestorBackend: () => "mxc",
      signal: input.signal,
    });
    if (input.signal?.aborted) throw new MxcProcessContractError("Extension start was cancelled");
    if (mxcRequestDigest(input.request) !== record.requestDigest || canonicalStringify(input.bootPlan) !== record.bootPlanDigest) {
      throw new MxcProcessContractError("Native admission request changed during readiness");
    }
    // The start's own capability refusal keeps its message; the settled plan would only name the ancestor.
    if (startFailure) throw startFailure;
    if (result.selectedBackend !== "mxc" || result.readiness !== "ready") {
      // Only the deadline aborts a start whose caller did not cancel; the plan reason names the ancestor, not the cause.
      const cause = observed?.state === "unavailable" ? observed.reason
        : startSignal?.aborted === true ? "readiness-deadline" : result.reason;
      throw new MxcCapabilityUnavailableError(`Native admission readiness failed: ${cause}`);
    }
  } finally {
    admissions.delete(admission);
  }
}
