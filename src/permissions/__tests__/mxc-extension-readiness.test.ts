import { afterEach, describe, expect, it, vi } from "vitest";
import { TOOL_TIMEOUT_POLICY } from "../../shared/tool-timeout-policy.js";
import { MxcCapabilityUnavailableError, MxcProcessContractError } from "../mxc-extension-errors.js";
import {
  classifyMxcExtensionReadiness,
  planWindowsExtensionHolder,
  settleWindowsExtensionReadiness,
  type MxcExtensionReadinessEvidence,
} from "../mxc-extension-readiness.js";

const EVIDENCE: MxcExtensionReadinessEvidence = {
  installedPayloadVerified: true, baseContainerReady: true, exactRequestAccepted: true,
  uiEnabledRuntimeStarted: true, ancestorQueriesSupported: true, standardStreamsRoundTrip: true,
  cleanTermination: true, ownProxySucceeded: true, otherListenerRefused: true,
  directEgressRefused: true, forgedLabelsAttributed: true, noWorkerPort: true, reparseSubstitutionRefused: true,
};
const FALLBACK = { version: "0.0.80", ready: true };

afterEach(() => vi.useRealTimers());

describe("extension request readiness", () => {
  it("requires every observation independently and rejects absent evidence", () => {
    expect(classifyMxcExtensionReadiness(EVIDENCE)).toEqual({ state: "available" });
    for (const key of Object.keys(EVIDENCE) as (keyof MxcExtensionReadinessEvidence)[]) {
      expect(classifyMxcExtensionReadiness({ ...EVIDENCE, [key]: false }).state, key).toBe("unavailable");
      const absent: Partial<MxcExtensionReadinessEvidence> = { ...EVIDENCE };
      delete absent[key];
      expect(classifyMxcExtensionReadiness(absent as MxcExtensionReadinessEvidence).state, key).toBe("unavailable");
    }
  });

  it.each([
    ["ancestorQueriesSupported", "ancestor-policy-unsupported"],
    ["uiEnabledRuntimeStarted", "runtime-start-failed"],
    ["otherListenerRefused", "endpoint-isolation-unverified"],
  ] as const)("reports the observed %s failure", (key, reason) => {
    expect(classifyMxcExtensionReadiness({ ...EVIDENCE, [key]: false })).toEqual({ state: "unavailable", reason });
  });

  it("selects a compatible request without a fallback dependency", async () => {
    const probe = vi.fn(async () => EVIDENCE);
    const plan = await settleWindowsExtensionReadiness({ probe, fallback: { version: "missing", ready: false }, admittedAncestorBackend: () => undefined });
    expect(plan).toMatchObject({ selectedBackend: "mxc", readiness: "ready", uiPolicy: "ui-enabled", egressIdentity: "kernel-channel", proxyOwnerVerified: false });
    expect(probe).toHaveBeenCalledOnce();
  });

  it.each([
    ["0.0.80", true, undefined, "srt-win", "fallback"],
    ["0.0.80", false, undefined, "none", "rejected"],
    ["0.0.81", true, undefined, "none", "rejected"],
    ["0.0.80", true, "mxc", "none", "rejected"],
    ["0.0.80", true, "srt-win", "none", "rejected"],
  ] as const)("settles a deadline against version=%s ready=%s ancestor=%s", async (version, ready, ancestor, backend, readiness) => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const result = settleWindowsExtensionReadiness({
      probe: async captured => { signal = captured; return new Promise(() => {}); },
      fallback: { version, ready }, admittedAncestorBackend: () => ancestor,
    });
    await vi.advanceTimersByTimeAsync(TOOL_TIMEOUT_POLICY.mxcExtensionReadinessMs);
    expect(await result).toMatchObject({ selectedBackend: backend, readiness });
    expect(signal?.aborted).toBe(true);
  });

  it("rechecks ancestor admission when the queued probe settles", async () => {
    let ancestor: "srt-win" | undefined;
    let finish!: (evidence: MxcExtensionReadinessEvidence) => void;
    const result = settleWindowsExtensionReadiness({ probe: () => new Promise(resolve => { finish = resolve; }), fallback: FALLBACK, admittedAncestorBackend: () => ancestor });
    await Promise.resolve();
    ancestor = "srt-win";
    finish({ ...EVIDENCE, exactRequestAccepted: false });
    expect(await result).toMatchObject({ selectedBackend: "none", readiness: "rejected", reason: "ancestor-already-admitted" });
  });

  it("cancels a queued start without admitting a fallback", async () => {
    const controller = new AbortController();
    const result = settleWindowsExtensionReadiness({ probe: () => new Promise(() => {}), fallback: FALLBACK, admittedAncestorBackend: () => undefined, signal: controller.signal });
    controller.abort();
    expect(await result).toMatchObject({ selectedBackend: "none", readiness: "rejected", reason: "request-rejected" });
  });

  it("settles external capability unavailability but propagates internal contract violations", async () => {
    const input = { fallback: FALLBACK, admittedAncestorBackend: () => undefined };
    expect(await settleWindowsExtensionReadiness({ ...input, probe: async () => { throw new MxcCapabilityUnavailableError("Native runtime unavailable"); } })).toMatchObject({ selectedBackend: "srt-win", reason: "probe-failed" });
    await expect(settleWindowsExtensionReadiness({ ...input, probe: async () => { throw new MxcProcessContractError("Invalid request"); } })).rejects.toThrow("Invalid request");
  });

  it("refuses a Bash-class request before admission with its visible reason", () => {
    expect(planWindowsExtensionHolder({ requested: true, mxc: { state: "unavailable", reason: "bash-incompatible" }, fallback: FALLBACK })).toMatchObject({ selectedBackend: "srt-win", reason: "bash-incompatible" });
    expect(planWindowsExtensionHolder({ requested: true, mxc: { state: "unavailable", reason: "bash-incompatible" }, fallback: FALLBACK, admittedAncestorBackend: "mxc" })).toMatchObject({ selectedBackend: "none", readiness: "rejected" });
  });

  it.each([
    [undefined, "mxc", "ready"],
    ["mxc", "mxc", "ready"],
    ["srt-win", "none", "rejected"],
    ["none", "none", "rejected"],
  ] as const)("selects available MXC beneath an admitted %s ancestor only when that ancestor is MXC", (ancestor, backend, readiness) => {
    const plan = planWindowsExtensionHolder({ requested: true, mxc: { state: "available" }, fallback: FALLBACK,
      ...(ancestor !== undefined ? { admittedAncestorBackend: ancestor } : {}) });
    expect(plan).toMatchObject({ selectedBackend: backend, readiness });
    if (readiness === "rejected") expect(plan.reason).toBe("ancestor-already-admitted");
  });

  it("requires the reparse-substitution refusal observation for readiness", () => {
    expect(classifyMxcExtensionReadiness({ ...EVIDENCE, reparseSubstitutionRefused: false }))
      .toEqual({ state: "unavailable", reason: "native-validation-required" });
  });
});
