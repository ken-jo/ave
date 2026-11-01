import { createHash } from "node:crypto";
import type { ContainerRequest } from "@microsoft/mxc-sdk/v1";
import { canonicalStringify } from "../shared/canonical-json.js";
import { assertSandboxWindowsExtensionPlan, type SandboxWindowsExtensionPlan } from "../shared/sandbox-capability-info.js";
import { MxcCapabilityUnavailableError, MxcProcessContractError } from "./mxc-extension-errors.js";
import { assertMxcExtensionRequest } from "./mxc-extension-request.js";
import { settleWindowsExtensionReadiness, type MxcExtensionReadinessEvidence } from "./mxc-extension-readiness.js";

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
interface AdmissionRecord extends Omit<AdmissionIdentity, "request"> { readonly requestDigest: string; readonly bootPlanDigest: string }
const admissions = new WeakMap<MxcExtensionAdmission, AdmissionRecord>();

function requestDigest(request: ContainerRequest): string {
  return createHash("sha256").update(canonicalStringify(request)).digest("hex");
}

/** The supplied probe must observe this held request; a global available flag cannot mint a receipt. */
export async function createMxcExtensionAdmission(input: AdmissionIdentity & {
  readonly probe: (request: ContainerRequest, signal: AbortSignal) => Promise<MxcExtensionReadinessEvidence>;
  readonly signal?: AbortSignal;
}): Promise<MxcExtensionAdmission> {
  assertMxcExtensionRequest(input.request);
  assertSandboxWindowsExtensionPlan(input.bootPlan);
  if (input.bootPlan.selectedBackend !== "mxc" || input.bootPlan.readiness !== "ready"
      || !/^[a-f0-9]{64}$/u.test(input.executableIdentity) || !input.holder || typeof input.holder !== "object") {
    throw new MxcProcessContractError("Native admission requires a captured holder and measured executable");
  }
  const capturedDigest = requestDigest(input.request);
  const capturedPlanDigest = canonicalStringify(input.bootPlan);
  // Probe a separate snapshot so a callback cannot mutate the later production request.
  const snapshot = JSON.parse(canonicalStringify(input.request)) as ContainerRequest;
  const result = await settleWindowsExtensionReadiness({
    probe: signal => input.probe(snapshot, signal),
    fallback: { version: "0.0.80", ready: false },
    // This holder is itself being admitted under the selected MXC plan: no fallback, no other backend.
    admittedAncestorBackend: () => "mxc",
    signal: input.signal,
  });
  if (input.signal?.aborted || requestDigest(snapshot) !== capturedDigest || requestDigest(input.request) !== capturedDigest
      || canonicalStringify(input.bootPlan) !== capturedPlanDigest) {
    throw new MxcProcessContractError("Native admission request changed during readiness");
  }
  if (result.selectedBackend !== "mxc" || result.readiness !== "ready") {
    throw new MxcCapabilityUnavailableError(`Native admission readiness failed: ${result.reason}`);
  }
  const admission = Object.freeze({}) as MxcExtensionAdmission;
  admissions.set(admission, { holder: input.holder, executableIdentity: input.executableIdentity,
    bootPlan: input.bootPlan, bootPlanDigest: capturedPlanDigest, requestDigest: capturedDigest });
  return admission;
}

/** Consume immediately at the native spawn boundary; mismatch burns the receipt rather than enabling retries. */
export function consumeMxcExtensionAdmission(admission: MxcExtensionAdmission, identity: AdmissionIdentity): void {
  const record = admissions.get(admission);
  admissions.delete(admission);
  if (!record || record.holder !== identity.holder || record.executableIdentity !== identity.executableIdentity
      || record.bootPlan !== identity.bootPlan || record.bootPlanDigest !== canonicalStringify(identity.bootPlan)
      || identity.bootPlan.selectedBackend !== "mxc" || identity.bootPlan.readiness !== "ready"
      || record.requestDigest !== requestDigest(identity.request)) {
    throw new MxcProcessContractError("Native admission evidence does not match this holder request");
  }
  assertMxcExtensionRequest(identity.request);
}
