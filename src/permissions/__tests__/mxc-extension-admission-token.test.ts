import { afterEach, describe, expect, it, vi } from "vitest";
import { buildMxcConfinedChildRequest } from "../mxc-confined-child-request.js";
import {
  admitMxcExtensionStart, assertMxcReleaseGateEvidence, consumeMxcExtensionAdmission, createMxcExtensionAdmission,
  registerMxcReleaseGateEvidence, type MxcExtensionAdmission,
} from "../mxc-extension-admission.js";
import { MxcCapabilityUnavailableError } from "../mxc-extension-errors.js";
import { mxcRequestDigest, type MxcExtensionStartEvidence, type MxcExtensionStartRecord } from "../mxc-extension-protocol.js";
import { planWindowsExtensionHolder, type MxcExtensionReleaseGateEvidence } from "../mxc-extension-readiness.js";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";

// Fields 1-5: what the holder's own start reports on its ready frame.
const START: MxcExtensionStartEvidence = {
  installedPayloadVerified: true, baseContainerReady: true, exactRequestAccepted: true,
  uiEnabledRuntimeStarted: true, ancestorQueriesSupported: true,
};
// Fields 8-13: the install-wide release-gate record.
const RELEASE_GATE: MxcExtensionReleaseGateEvidence = {
  ownProxySucceeded: true, otherListenerRefused: true, directEgressRefused: true,
  forgedLabelsAttributed: true, noWorkerPort: true, reparseSubstitutionRefused: true,
};
function identity(proxyPort = 43210) {
  return {
    holder: Object.freeze({}), executableIdentity: "a".repeat(64),
    bootPlan: planWindowsExtensionHolder({ requested: true, mxc: { state: "available" },
      fallback: { version: "0.0.80", ready: false } }),
    request: buildMxcConfinedChildRequest({ command: "C:\\runtime\\runtime.exe", args: ["D:\\work\\entry.js"],
      cwd: "D:\\work", home: "D:\\work\\home", temp: "D:\\work\\temp",
      grants: { readwrite: ["D:\\work"], readonly: ["C:\\runtime", "C:\\Windows"], denied: [] },
      baseEnv: { SYSTEMROOT: "C:\\Windows", LOCALAPPDATA: "C:\\profile\\AppData\\Local" }, proxyUrl: `http://127.0.0.1:${proxyPort}` }),
  };
}
type Identity = ReturnType<typeof identity>;

/** A holder's own start: spends the receipt at the native boundary, then reports what its ready frame carried. */
function ownStart(receipt: MxcExtensionAdmission, captured: Identity, record?: (own: MxcExtensionStartRecord) => MxcExtensionStartRecord | undefined) {
  return async (): Promise<MxcExtensionStartRecord | undefined> => {
    consumeMxcExtensionAdmission(receipt, captured);
    const own = { requestDigest: mxcRequestDigest(captured.request), evidence: START };
    return record ? record(own) : own;
  };
}

let unregister: (() => void) | undefined;
function withReleaseGate(evidence: MxcExtensionReleaseGateEvidence = RELEASE_GATE): void {
  unregister = registerMxcReleaseGateEvidence(evidence);
}
afterEach(() => { unregister?.(); unregister = undefined; vi.useRealTimers(); });

describe("native request admission receipt", () => {
  it("authorizes one exact request once", () => {
    withReleaseGate();
    const captured = identity();
    const receipt = createMxcExtensionAdmission(captured);
    consumeMxcExtensionAdmission(receipt, captured);
    expect(() => consumeMxcExtensionAdmission(receipt, captured)).toThrow(/does not match/);
  });

  it("rejects a structurally forged receipt even with a globally ready plan", () => {
    withReleaseGate();
    expect(() => consumeMxcExtensionAdmission({} as MxcExtensionAdmission, identity())).toThrow(/does not match/);
  });

  it.each(["holder", "executable", "boot", "proxy", "command", "filesystem"] as const)("binds receipt to its %s and burns mismatches", field => {
    withReleaseGate();
    const captured = identity();
    const receipt = createMxcExtensionAdmission(captured);
    const changed = { ...captured, request: structuredClone(captured.request) };
    if (field === "holder") changed.holder = {};
    if (field === "executable") changed.executableIdentity = "b".repeat(64);
    if (field === "boot") changed.bootPlan = { ...captured.bootPlan };
    if (field === "proxy") changed.request.network!.runtimeConfig!.networkProxy = "http://127.0.0.1:43211";
    if (field === "command") changed.request.command += " changed";
    if (field === "filesystem") changed.request.filesystem!.readwritePaths = ["D:\\other"];
    expect(() => consumeMxcExtensionAdmission(receipt, changed)).toThrow(/does not match/);
    expect(() => consumeMxcExtensionAdmission(receipt, captured)).toThrow(/does not match/);
  });

  it("refuses a caller-labelled executable", () => {
    withReleaseGate();
    expect(() => createMxcExtensionAdmission({ ...identity(), executableIdentity: "runtime.exe" })).toThrow(/measured executable/);
  });

  it("rejects mutation of the sealed plan after the receipt", () => {
    withReleaseGate();
    const captured = identity();
    const receipt = createMxcExtensionAdmission(captured);
    captured.bootPlan = Object.assign(captured.bootPlan, { reason: "runtime-unavailable" });
    expect(() => consumeMxcExtensionAdmission(receipt, captured)).toThrow(/does not match/);
  });
});

describe("release-gate evidence (fields 8-13) is an install record, checked and never gathered per start", () => {
  it("refuses every receipt while no record is registered", () => {
    expect(() => assertMxcReleaseGateEvidence()).toThrow(/No release-gate evidence is registered/);
    expect(() => createMxcExtensionAdmission(identity())).toThrow(/No release-gate evidence is registered/);
  });

  it.each(Object.keys(RELEASE_GATE) as (keyof MxcExtensionReleaseGateEvidence)[])("refuses a record whose %s is not observed", field => {
    withReleaseGate({ ...RELEASE_GATE, [field]: false });
    expect(() => createMxcExtensionAdmission(identity())).toThrow(/Release-gate evidence is incomplete/);
  });

  it("holds one record per installation", () => {
    withReleaseGate();
    expect(() => registerMxcReleaseGateEvidence(RELEASE_GATE)).toThrow(/already registered/);
  });
});

describe("per-start admission (fields 1-5) on the holder's own start", () => {
  it("admits a start whose ready frame carries all five fields for this request", async () => {
    withReleaseGate();
    const captured = identity();
    const receipt = createMxcExtensionAdmission(captured);
    const start = vi.fn(ownStart(receipt, captured));
    await expect(admitMxcExtensionStart(receipt, { ...captured, start })).resolves.toBeUndefined();
    // One start, the holder's own: no separate probe start supplies fields 8-13.
    expect(start).toHaveBeenCalledOnce();
  });

  it("refuses a start that carried no ready-frame evidence", async () => {
    withReleaseGate();
    const captured = identity();
    const receipt = createMxcExtensionAdmission(captured);
    await expect(admitMxcExtensionStart(receipt, { ...captured, start: ownStart(receipt, captured, () => undefined) }))
      .rejects.toThrow(/no ready-frame evidence/);
  });

  it("refuses another holder's start evidence", async () => {
    withReleaseGate();
    const captured = identity();
    const other = identity(43211);
    const receipt = createMxcExtensionAdmission(captured);
    await expect(admitMxcExtensionStart(receipt, { ...captured,
      start: ownStart(receipt, captured, () => ({ requestDigest: mxcRequestDigest(other.request), evidence: START })) }))
      .rejects.toThrow(/another holder's start/);
  });

  it.each([
    ["installedPayloadVerified", "native-validation-required"],
    ["baseContainerReady", "native-validation-required"],
    ["exactRequestAccepted", "native-validation-required"],
    ["uiEnabledRuntimeStarted", "runtime-start-failed"],
    ["ancestorQueriesSupported", "ancestor-policy-unsupported"],
  ] as const)("refuses a start whose %s was not observed", async (field, reason) => {
    withReleaseGate();
    const captured = identity();
    const receipt = createMxcExtensionAdmission(captured);
    await expect(admitMxcExtensionStart(receipt, { ...captured,
      start: ownStart(receipt, captured, own => ({ ...own, evidence: { ...START, [field]: false } })) }))
      .rejects.toThrow(`Native admission readiness failed: ${reason}`);
  });

  it("refuses at the readiness deadline, cancels the start and never selects another backend", async () => {
    withReleaseGate();
    vi.useFakeTimers();
    const captured = identity();
    const receipt = createMxcExtensionAdmission(captured);
    let startSignal: AbortSignal | undefined;
    const refused = expect(admitMxcExtensionStart(receipt, { ...captured,
      start: signal => { startSignal = signal; return new Promise(() => {}); } }))
      .rejects.toThrow("Native admission readiness failed: readiness-deadline (beneath an admitted holder)");
    await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.mxcExtensionReadinessMs);
    await refused;
    expect(startSignal?.aborted).toBe(true);
    // The receipt went with the refusal: a late start cannot spend it.
    expect(() => consumeMxcExtensionAdmission(receipt, captured)).toThrow(/does not match/);
  });

  it("refuses with the start's own capability failure, not an ancestor or deadline reason", async () => {
    withReleaseGate();
    const captured = identity();
    const receipt = createMxcExtensionAdmission(captured);
    const failure = new MxcCapabilityUnavailableError("Required native containment is unavailable");
    await expect(admitMxcExtensionStart(receipt, { ...captured, start: async () => { throw failure; } })).rejects.toBe(failure);
    expect(() => consumeMxcExtensionAdmission(receipt, captured)).toThrow(/does not match/);
  });

  it("refuses a cancelled start", async () => {
    withReleaseGate();
    const captured = identity();
    const receipt = createMxcExtensionAdmission(captured);
    const controller = new AbortController();
    const refused = expect(admitMxcExtensionStart(receipt, { ...captured, signal: controller.signal, start: () => new Promise(() => {}) }))
      .rejects.toThrow(/changed during readiness/);
    controller.abort();
    await refused;
  });

  it("refuses evidence from a start that never passed admission at the native boundary", async () => {
    withReleaseGate();
    const captured = identity();
    const receipt = createMxcExtensionAdmission(captured);
    await expect(admitMxcExtensionStart(receipt, { ...captured,
      start: async () => ({ requestDigest: mxcRequestDigest(captured.request), evidence: START }) }))
      .rejects.toThrow(/did not pass admission/);
  });

  it("refuses a request or plan changed while the start was pending", async () => {
    withReleaseGate();
    const captured = identity();
    const receipt = createMxcExtensionAdmission(captured);
    await expect(admitMxcExtensionStart(receipt, { ...captured, start: async () => {
      const own = await ownStart(receipt, captured)();
      captured.request.command += " mutated";
      return own;
    } })).rejects.toThrow(/changed during readiness/);
  });

  it("is single use: a second start cannot borrow the first start's admission", async () => {
    withReleaseGate();
    const captured = identity();
    const receipt = createMxcExtensionAdmission(captured);
    await admitMxcExtensionStart(receipt, { ...captured, start: ownStart(receipt, captured) });
    const again = vi.fn(async () => ({ requestDigest: mxcRequestDigest(captured.request), evidence: START }));
    await expect(admitMxcExtensionStart(receipt, { ...captured, start: again })).rejects.toThrow(/does not match/);
    expect(again).not.toHaveBeenCalled();
    // Nor another holder with the same request.
    await expect(admitMxcExtensionStart(createMxcExtensionAdmission(captured), { ...captured, holder: {}, start: again })).rejects.toThrow(/does not match/);
  });
});
