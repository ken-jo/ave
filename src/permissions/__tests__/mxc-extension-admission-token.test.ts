import type { ContainerRequest } from "@microsoft/mxc-sdk/v1";
import { describe, expect, it, vi } from "vitest";
import { buildMxcConfinedChildRequest } from "../mxc-confined-child-request.js";
import { createMxcExtensionAdmission, consumeMxcExtensionAdmission, type MxcExtensionAdmission } from "../mxc-extension-admission.js";
import { planWindowsExtensionHolder, type MxcExtensionReadinessEvidence } from "../mxc-extension-readiness.js";

const EVIDENCE: MxcExtensionReadinessEvidence = {
  installedPayloadVerified: true, baseContainerReady: true, exactRequestAccepted: true,
  uiEnabledRuntimeStarted: true, ancestorQueriesSupported: true, standardStreamsRoundTrip: true,
  cleanTermination: true, ownProxySucceeded: true, otherListenerRefused: true,
  directEgressRefused: true, forgedLabelsAttributed: true, noWorkerPort: true, reparseSubstitutionRefused: true,
};
function identity() {
  return {
    holder: Object.freeze({}), executableIdentity: "a".repeat(64),
    bootPlan: planWindowsExtensionHolder({ requested: true, mxc: { state: "available" },
      fallback: { version: "0.0.80", ready: false } }),
    request: buildMxcConfinedChildRequest({ command: "C:\\runtime\\runtime.exe", args: ["D:\\work\\entry.js"],
      cwd: "D:\\work", home: "D:\\work\\home", temp: "D:\\work\\temp",
      grants: { readwrite: ["D:\\work"], readonly: ["C:\\runtime", "C:\\Windows"], denied: [] },
      baseEnv: { SYSTEMROOT: "C:\\Windows", LOCALAPPDATA: "C:\\profile\\AppData\\Local" }, proxyUrl: "http://127.0.0.1:43210" }),
  };
}

describe("native request admission receipt", () => {
  it("requires independently observed readiness, then authorizes one exact request once", async () => {
    const captured = identity();
    const probe = vi.fn(async (_request: ContainerRequest, _signal: AbortSignal) => EVIDENCE);
    const receipt = await createMxcExtensionAdmission({ ...captured, probe });
    expect(probe).toHaveBeenCalledOnce();
    expect(probe.mock.calls[0]?.[0]).not.toBe(captured.request);
    consumeMxcExtensionAdmission(receipt, captured);
    expect(() => consumeMxcExtensionAdmission(receipt, captured)).toThrow(/does not match/);
  });

  it("rejects a structurally forged receipt even with a globally ready plan", () => {
    expect(() => consumeMxcExtensionAdmission({} as MxcExtensionAdmission, identity())).toThrow(/does not match/);
  });

  it.each(["holder", "executable", "boot", "proxy", "command", "filesystem"] as const)("binds receipt to its %s and burns mismatches", async field => {
    const captured = identity();
    const receipt = await createMxcExtensionAdmission({ ...captured, probe: async () => EVIDENCE });
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

  it("rejects mutation of the observed request or production request during probing", async () => {
    const captured = identity();
    await expect(createMxcExtensionAdmission({ ...captured, probe: async request => {
      request.command += " mutated"; return EVIDENCE;
    } })).rejects.toThrow(/changed during readiness/);
    await expect(createMxcExtensionAdmission({ ...captured, probe: async () => {
      captured.request.command += " mutated"; return EVIDENCE;
    } })).rejects.toThrow(/changed during readiness/);
  });

  it("refuses missing observations and a caller-labelled executable", async () => {
    const captured = identity();
    await expect(createMxcExtensionAdmission({ ...captured, probe: async () => ({ ...EVIDENCE, otherListenerRefused: false }) })).rejects.toThrow(/readiness failed/);
    await expect(createMxcExtensionAdmission({ ...captured, executableIdentity: "runtime.exe", probe: async () => EVIDENCE })).rejects.toThrow(/measured executable/);
  });

  it("rejects mutation of the sealed plan after probing", async () => {
    const captured = identity();
    const receipt = await createMxcExtensionAdmission({ ...captured, probe: async () => EVIDENCE });
    captured.bootPlan = Object.assign(captured.bootPlan, { reason: "runtime-unavailable" });
    expect(() => consumeMxcExtensionAdmission(receipt, captured)).toThrow(/does not match/);
  });
});
