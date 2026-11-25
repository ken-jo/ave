// One row per permission decision point: what it answers today, in one closed vocabulary.
// A row whose answer differs from the policy core carries `core` and is listed in EXCEPTIONS; fixing it removes both.
// LEAD rule: a fix PR that closes an I-id must flip or delete its exception row in the same PR, and move the id into RESOLVED
// with the row that now proves it. Every I-id sits in exactly one of EXCEPTIONS, INCONSISTENCIES_WITHOUT_ROW and RESOLVED.
// Tree = docs/architecture/permission-decision-tree.md line(s), or "no row".
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { planWindowsSandbox } from "../../boot/steps/windows-sandbox-plan.js";
import { _resetAveHomePrivacyForTest, setAveHomePrivacyAtBoot } from "../../shared/ave-home.js";
import {
  __resetExtensionStartsForTest, EXTENSION_START_CONSENT_REQUIRED_CODE, requestExtensionStartConsent, setExtensionStartAsker,
} from "../extension-start-consent.js";
import { assertExtensionStartAllowed, probeExtensionStart } from "../asrt-sandbox.js";
import {
  decidePermission, NO_APPROVER_MESSAGE, offersFloorSessionAllow,
  type PermissionDecisionRequest, type PermissionFloorCode, type PermissionPipelineOutcome,
} from "../decision-pipeline.js";
import { isLoopbackAddress } from "../egress-relay/address-set.js";
import { isReservedAddress, parseRelayAllowEntry, resolvedAddressPermitted } from "../egress-relay/destination.js";
import {
  buildHostShellExecutionPlan, HOME_PRIVACY_HELPER_UNAVAILABLE_SHELL_DENIAL, requiresUnsandboxedShellAsk,
  type HostShellExecutionPlan,
} from "../host-shell-execution-plan.js";
import { assertLocalEmbeddingRuntime } from "../../main/memory-map/local-runtime.js";
import type { MxcExtensionStartEvidence } from "../mxc-extension-protocol.js";
import { classifyMxcExtensionReadiness, classifyMxcReleaseGate, planWindowsExtensionHolder, type MxcExtensionReleaseGateEvidence } from "../mxc-extension-readiness.js";
import { synthesizeMxcAncestorQueries } from "../mxc-filesystem-policy.js";
import { inspectShellPermissionPaths } from "../rules/literal-shell-inspection.js";
import {
  __resetSandboxRequestedAtBootForTest, __resetWindowsSandboxSubstrateForTest,
  setPluginWorkerConfinementRequestedAtBoot, setWindowsSandboxSubstrate, type SandboxCapability,
} from "../sandbox-capability.js";

// The five outcomes of the policy core, plus two answers that exist today outside it:
// "state" (a capability state, nothing decided) and "unasked" (runs with nothing confining it and nobody asked).
const OUTCOMES = ["allow", "contained", "ask", "ask-human", "deny", "state", "unasked"] as const;
type Outcome = typeof OUTCOMES[number];
// Who may answer and for how long: nobody, one use, this session, any saved scope, or a Settings switch.
const WAIVERS = ["none", "once", "session", "any", "setting"] as const;
type Waiver = typeof WAIVERS[number];
// U1 unknown effect, U2 unknown boundary, U3 unknown judge; "-" when nothing is unknown.
const UNKNOWN_CORE = { U1: ["ask", "ask-human"], U2: ["ask-human"], U3: ["deny", "state"], "-": OUTCOMES } as const;
type UnknownClass = keyof typeof UNKNOWN_CORE;

interface Observation { outcome: Outcome; reason: string; headless?: Outcome; waiver?: Waiver }
interface Row {
  id: string;
  point: string;
  tree: string;
  unknown: UnknownClass;
  today: Observation;
  core?: Partial<Observation>;
  observe: () => Observation | Promise<Observation>;
}

const PIPELINE_NAME: Record<PermissionPipelineOutcome, Outcome> = {
  allow: "allow", "sandbox-auto": "contained", ask: "ask", "ask-forced": "ask-human", deny: "deny",
};
const READ = { name: "read_file", source: "builtin", kind: "read" } as const;
const WRITE = { name: "write_file", source: "builtin", kind: "file-write" } as const;
const SHELL = { name: "shell", source: "builtin", kind: "shell" } as const;
const HOST_SHELL = { sandboxed: false, readOnlyProven: false, unproven: false, destructive: false };

const ATTENDED: PermissionDecisionRequest = { tool: READ, mode: "default", headless: false };

function pipeline(evidence: Partial<PermissionDecisionRequest>): Observation {
  const attended = decidePermission({ ...ATTENDED, ...evidence });
  const headless = decidePermission({ ...ATTENDED, ...evidence, headless: true });
  const observed: Observation = { outcome: PIPELINE_NAME[attended.outcome], reason: attended.reasonCode, headless: PIPELINE_NAME[headless.outcome] };
  if (attended.outcome === "ask-forced") observed.waiver = offersFloorSessionAllow({ pipelineRequest: { ...ATTENDED, ...evidence } }) ? "session" : "once";
  return observed;
}

function headlessDenial(evidence: Partial<PermissionDecisionRequest>): Observation {
  const decision = decidePermission({ ...ATTENDED, ...evidence, headless: true });
  expect(decision.reason).toBe(NO_APPROVER_MESSAGE);
  return { outcome: PIPELINE_NAME[decision.outcome], reason: decision.reasonCode };
}

const capability = (platform: NodeJS.Platform, kind: SandboxCapability["kind"], process = true): SandboxCapability => ({
  kind, confidence: "verified", platform, reason: "fixture", confines: { filesystem: kind !== "none", process: kind !== "none" && process, network: kind !== "none" },
});

// A plan is a route, not a verdict. Read as: confined -> contained, blocked -> deny, the home-privacy floor -> ask-human for the
// session, a per-invocation host authorization -> ask once, otherwise the ordinary policy (any saved scope may answer).
// An explicit host request also sets requiresExplicitUserApproval, yet a saved rule answers it: the rule must be exact
// (the permit mint accepts an issued rule decision only when executionRequest is "host").
function plan(input: Parameters<typeof buildHostShellExecutionPlan>[0]): Observation {
  const built: HostShellExecutionPlan = buildHostShellExecutionPlan(input);
  const reason = `${built.executionRequest}:${built.fallbackReason}`;
  if (built.sandboxed) return { outcome: "contained", reason, waiver: "none" };
  if (built.mode === "blocked") return { outcome: "deny", reason, waiver: "none" };
  if (requiresUnsandboxedShellAsk(built)) return { outcome: "ask-human", reason, waiver: "session" };
  return { outcome: "ask", reason, waiver: built.requiresExplicitUserApproval && built.executionRequest !== "host" ? "once" : "any" };
}

// The permission manager reads this inspection and turns an `analysis-limit` into the admission denial `shell-analysis-limit`.
// The inspection is driven with the facts the manager passes for bash; that one step of the manager is restated here.
function analysisLimit(command: string): Observation {
  const kind = inspectShellPermissionPaths(command, tmpdir(), { dialect: "bash", environment: {} })?.unproven?.kind;
  const evidence = kind === "analysis-limit" ? { admissionDenial: { code: "shell-analysis-limit", reason: "fixture" } } : {};
  return pipeline({ tool: SHELL, shell: { ...HOST_SHELL, unproven: kind !== undefined }, ...evidence });
}

type StartOptions = Parameters<typeof assertExtensionStartAllowed>[0];
type ExtensionState = NonNullable<Parameters<typeof planWindowsSandbox>[0]["extensionMxc"]>;

function publishExtensionPlan(extensionMxc: ExtensionState, srtWinReady = false): string {
  const { substrate } = planWindowsSandbox({ shellRequested: false, workerRequested: true, mxc: { state: "available" }, extensionMxc, windowsBuild: null, srtWinReady });
  setWindowsSandboxSubstrate(substrate);
  return `${substrate.extensionPlan?.readiness}:${substrate.extensionPlan?.reason}`;
}

function extensionStart(options?: StartOptions): { outcome: Outcome; reason: string } {
  try {
    assertExtensionStartAllowed(options);
    return { outcome: "unasked", reason: "none" };
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    // A start that waits for a person's answer to this one start.
    if (code === EXTENSION_START_CONSENT_REQUIRED_CODE) return { outcome: "ask-human", reason: code };
    return { outcome: "deny", reason: typeof code === "string" ? code : `uncoded:${(error as Error).name}` };
  }
}

function refusal(run: () => unknown): string {
  try { run(); } catch (error) {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : `uncoded:${(error as Error).name}`;
  }
  return "none";
}

// Per-start evidence (the holder's own start) and the install's release-gate record: two classifications, never one.
const READY: MxcExtensionStartEvidence = {
  installedPayloadVerified: true, baseContainerReady: true, exactRequestAccepted: true, uiEnabledRuntimeStarted: true,
  ancestorQueriesSupported: true,
};
const RELEASE_GATE: MxcExtensionReleaseGateEvidence = {
  ownProxySucceeded: true, otherListenerRefused: true, directEgressRefused: true, forgedLabelsAttributed: true,
  noWorkerPort: true, reparseSubstitutionRefused: true,
};
const FLOOR_CODES: readonly PermissionFloorCode[] = ["protected-path", "critical-delete", "project-escape", "other-principal"];
const FIXTURE_HOME = "C:\\Users\\alice\\.ave";

const ROWS: readonly Row[] = [
  // Layer 1: the decision pipeline.
  { id: "D1", point: "admission denial", tree: "T:19-20", unknown: "-",
    today: { outcome: "deny", reason: "credential-store", headless: "deny" },
    observe: () => pipeline({ admissionDenial: { code: "credential-store", reason: "fixture" } }) },
  { id: "D2", point: "deny rule", tree: "T:19", unknown: "-",
    today: { outcome: "deny", reason: "rule-deny", headless: "deny" },
    observe: () => pipeline({ rules: { deny: "fixture", allow: "fixture" } }) },
  { id: "D3", point: "unsupported tool kind", tree: "no row", unknown: "-",
    today: { outcome: "deny", reason: "unsupported-tool-kind", headless: "deny" },
    observe: () => pipeline({ tool: { ...READ, kind: "search" as never } }) },
  { id: "D4", point: "floor with nobody present", tree: "T:68, T:170", unknown: "-",
    today: { outcome: "deny", reason: "no-approver" },
    observe: () => headlessDenial({ floor: { code: "protected-path", reason: "fixture" } }) },
  { id: "D5", point: "sandbox-unavailable floor, session waiver held", tree: "T:211-219", unknown: "-",
    today: { outcome: "allow", reason: "floor-session-allow", headless: "deny" },
    observe: () => pipeline({ tool: SHELL, shell: HOST_SHELL, floor: { code: "sandbox-unavailable", reason: "fixture" }, floorSessionEligible: true,
      rules: { floorSession: "fixture", allow: "fixture" } }) },
  { id: "D6", point: "any floor: rules and mode never pass", tree: "T:22-23, T:259", unknown: "-",
    today: { outcome: "ask-human", reason: "protected-path", headless: "deny", waiver: "once" },
    observe: () => pipeline({ mode: "allow", rules: { allow: "fixture" }, floor: { code: "protected-path", reason: "fixture" } }) },
  { id: "D7", point: "manual rerun", tree: "no row", unknown: "-",
    today: { outcome: "ask", reason: "manual-rerun", headless: "deny" },
    observe: () => pipeline({ mode: "allow", manualRerun: true }) },
  { id: "D8", point: "ask rule", tree: "T:26, T:38", unknown: "-",
    today: { outcome: "ask", reason: "rule-ask", headless: "deny" },
    observe: () => pipeline({ rules: { ask: "fixture", allow: "fixture" } }) },
  { id: "D9", point: "user-owned surface", tree: "T:25-36, T:104", unknown: "-",
    today: { outcome: "ask", reason: "user-owned-surface-ask", headless: "deny" },
    observe: () => pipeline({ userOwnedSurface: { kind: "browser", choice: "ask" } }) },
  { id: "D10", point: "agent browser tool", tree: "T:100", unknown: "-",
    today: { outcome: "allow", reason: "agent-browser-tool", headless: "deny" },
    observe: () => pipeline({ agentBrowser: true }) },
  { id: "D11", point: "allow rule", tree: "T:37", unknown: "-",
    today: { outcome: "allow", reason: "rule-allow", headless: "allow" },
    observe: () => pipeline({ tool: SHELL, shell: HOST_SHELL, rules: { allow: "fixture" } }) },
  { id: "D12", point: "exfiltration signal", tree: "T:136-147", unknown: "-",
    today: { outcome: "ask", reason: "exfiltration-guardrail", headless: "deny" },
    observe: () => pipeline({ exfiltration: { reason: "fixture" } }) },
  { id: "D13", point: "ordinary read", tree: "T:40", unknown: "-",
    today: { outcome: "allow", reason: "ordinary-read", headless: "allow" },
    observe: () => pipeline({}) },
  { id: "D14", point: "restorable project write", tree: "T:42-43", unknown: "-",
    today: { outcome: "allow", reason: "project-write", headless: "allow" },
    observe: () => pipeline({ tool: WRITE, fileWrite: { insideProject: true, checkpointAvailable: true } }) },
  { id: "D15", point: "sandboxed shell", tree: "T:45-46", unknown: "-",
    today: { outcome: "contained", reason: "sandboxed-shell", headless: "contained" },
    observe: () => pipeline({ tool: SHELL, shell: { ...HOST_SHELL, sandboxed: true } }) },
  { id: "D16", point: "mode decides an ordinary ask", tree: "T:48-59", unknown: "-",
    today: { outcome: "allow", reason: "allow-mode", headless: "allow" },
    observe: () => pipeline({ tool: SHELL, shell: HOST_SHELL, mode: "allow" }) },
  { id: "D17", point: "ordinary ask with nobody present", tree: "T:52, T:170", unknown: "-",
    today: { outcome: "deny", reason: "no-approver" },
    observe: () => headlessDenial({ tool: SHELL, shell: HOST_SHELL }) },
  { id: "D20", point: "home privacy helper gave no answer", tree: "T:224-226", unknown: "U3",
    today: { outcome: "deny", reason: "default:home-privacy-helper-unavailable", waiver: "none" },
    observe: () => {
      expect(HOME_PRIVACY_HELPER_UNAVAILABLE_SHELL_DENIAL.code).toBe("home-privacy-helper-unavailable");
      return plan({ platform: "win32", requestedSandbox: true, activeCapability: capability("win32", "none"), unconfinedShellDenied: true });
    } },
  { id: "D21", point: "host shell while boot home privacy failed", tree: "T:205-223", unknown: "U2",
    today: { outcome: "ask-human", reason: "sandbox-unavailable", headless: "deny", waiver: "session" },
    observe: () => {
      expect(plan({ platform: "linux", requestedSandbox: true, activeCapability: capability("linux", "none"), unavailableSandboxRequiresAsk: true }))
        .toEqual({ outcome: "ask-human", reason: "default:requested-sandbox-unavailable", waiver: "session" });
      return pipeline({ tool: SHELL, shell: HOST_SHELL, mode: "allow", rules: { allow: "fixture" },
        floor: { code: "sandbox-unavailable", reason: "fixture" }, floorSessionEligible: true });
    } },
  { id: "D22", point: "protected path, critical delete, project escape, other principal", tree: "T:129-131", unknown: "-",
    today: { outcome: "ask-human", reason: "floor", headless: "deny", waiver: "once" },
    observe: () => {
      const seen = FLOOR_CODES.map(code => pipeline({ floor: { code, reason: "fixture" }, floorSessionEligible: true, rules: { floorSession: "fixture" } }));
      expect(seen.map(entry => entry.reason)).toEqual(FLOOR_CODES);
      const shapes = [...new Set(seen.map(entry => JSON.stringify({ ...entry, reason: "floor" })))];
      expect(shapes).toHaveLength(1);
      return JSON.parse(shapes.join()) as Observation;
    } },
  { id: "D23", point: "explicit host request", tree: "T:254", unknown: "-",
    today: { outcome: "ask", reason: "host:none", waiver: "any" },
    observe: () => plan({ platform: "linux", requestedSandbox: true, activeCapability: capability("linux", "asrt"), executionMode: "host" }) },
  { id: "D24", point: "sandbox off by setting", tree: "T:128, T:254", unknown: "-",
    today: { outcome: "ask", reason: "default:disabled-by-setting", waiver: "any" },
    observe: () => plan({ platform: "linux", requestedSandbox: false, activeCapability: capability("linux", "none") }) },
  { id: "D25", point: "sandbox on, no usable backend", tree: "T:128", unknown: "U2",
    // S1 (#664) made this the forced ask the core names.
    today: { outcome: "ask-human", reason: "default:requested-sandbox-unavailable", waiver: "session" },
    observe: () => plan({ platform: "linux", requestedSandbox: true, activeCapability: capability("linux", "none") }) },
  { id: "D26", point: "Windows capability that does not contain shells", tree: "T:128", unknown: "U2",
    today: { outcome: "ask", reason: "default:windows-partial-shell-acl-unsafe", waiver: "once" },
    core: { outcome: "ask-human", waiver: "session" },
    observe: () => plan({ platform: "win32", requestedSandbox: true, activeCapability: capability("win32", "asrt", false) }) },
  // I12 removes this branch with the partial and fs-only kinds (PF3); nothing produces them today. Until then the core answer
  // is the U2 one its neighbours D25 and D26 carry.
  { id: "D27", point: "any other partial substrate", tree: "no row", unknown: "U2",
    today: { outcome: "deny", reason: "default:active-sandbox-not-shell-contained", waiver: "none" },
    core: { outcome: "ask-human", waiver: "session" },
    observe: () => plan({ platform: "linux", requestedSandbox: true, activeCapability: capability("linux", "partial") }) },
  { id: "D30", point: "analysis limit other than the cd budget", tree: "no row", unknown: "U1",
    today: { outcome: "deny", reason: "shell-analysis-limit", headless: "deny" },
    core: { outcome: "ask-human" },
    observe: () => analysisLimit([0, 1, 2, 3, 4, 5, 6].map(index => `if test -f q${index}; then v${index}=1; fi`).join("; ")) },
  // Layer 1: egress destination classes. These rows pin the class predicates; the relay that acts on them is not driven,
  // so the outcome names what the relay does with each answer and the `relay:` reason is a label of this table, not a product code.
  // D32 pins class membership only; what an allow-list entry does with a reserved literal is not pinned here.
  { id: "D32", point: "reserved literal class (link-local, metadata, unspecified, multicast); loopback is outside it", tree: "no row", unknown: "-",
    today: { outcome: "deny", reason: "relay:reserved" },
    observe: () => {
      const literals = ["169.254.169.254", "0.0.0.0", "224.0.0.1", "fe80::1", "fd00:ec2::254", "::ffff:169.254.169.254"];
      expect(["127.0.0.1", "::1"].filter(address => isLoopbackAddress(address) && !isReservedAddress(address))).toHaveLength(2);
      expect(literals.filter(literal => !isReservedAddress(literal))).toEqual([]);
      return { outcome: "deny", reason: "relay:reserved" };
    } },
  { id: "D34.a", point: "a name resolving to loopback or a reserved address", tree: "no row", unknown: "-",
    today: { outcome: "deny", reason: "relay:resolved-local-or-reserved" },
    observe: () => ({ outcome: ["127.0.0.1", "169.254.169.254"].some(address => resolvedAddressPermitted("name.example", address, 443, [], [])) ? "allow" : "deny",
      reason: "relay:resolved-local-or-reserved" }) },
  { id: "D34.b", point: "a name resolving to a reserved address the allow list names", tree: "no row", unknown: "-",
    today: { outcome: "deny", reason: "relay:allow-listed-address" },
    observe: () => ({ outcome: resolvedAddressPermitted("name.example", "169.254.169.254", 80, [parseRelayAllowEntry("169.254.169.254:80")], []) ? "allow" : "deny",
      reason: "relay:allow-listed-address" }) },
  // Layer 2: start and launch admission.
  // The same per-start waiver as L4 and L5: the deadline is a start with no backend, and it keeps its own cause.
  { id: "L1", point: "extension start after the readiness deadline", tree: "T:260", unknown: "U2",
    today: { outcome: "ask-human", reason: "unavailable:readiness-deadline", waiver: "once" },
    observe: () => {
      setProcessPlatform("win32");
      setPluginWorkerConfinementRequestedAtBoot(true);
      setAveHomePrivacyAtBoot({ enforcement: "win32-dacl", home: FIXTURE_HOME, sid: "S-1-5-21-1" });
      const reason = publishExtensionPlan({ state: "unavailable", reason: "readiness-deadline" });
      expect(probeExtensionStart()).toBe("readiness-deadline");
      const first = { outcome: extensionStart().outcome, reason };
      setExtensionStartAsker({ ask: async () => "yes", notify: () => {} });
      const key = "plugin-child:fixture";
      return requestExtensionStartConsent({ key, kind: "plugin-child", label: "fixture", cause: "readiness-deadline" }, { sessionId: "s1", attended: true })
        .then((authority): Observation => {
          const start = () => extensionStart({ start: { key, authority, spend: true } }).outcome;
          if (start() !== "unasked") return { ...first, waiver: "none" };
          return { ...first, waiver: start() === "ask-human" ? "once" : "session" };
        });
    } },
  { id: "L2", point: "container selected, legacy entry", tree: "no row", unknown: "-",
    today: { outcome: "deny", reason: "native-entry-required+worker-transport-unsupported" },
    observe: () => {
      setProcessPlatform("win32");
      expect(publishExtensionPlan({ state: "available" })).toBe("ready:ready");
      expect(extensionStart({ backend: "mxc" }).outcome).toBe("unasked");
      return { outcome: extensionStart().outcome, reason: `${extensionStart().reason}+${extensionStart({ holder: "worker" }).reason}` };
    } },
  { id: "L3", point: "native entry, container not ready", tree: "no row", unknown: "-",
    today: { outcome: "deny", reason: "uncoded:MxcProcessContractError" },
    core: { reason: "registry-code" },
    observe: () => {
      setProcessPlatform("win32");
      expect(publishExtensionPlan({ state: "unavailable", reason: "runtime-start-failed" }, true)).toBe("fallback:runtime-start-failed");
      return extensionStart({ backend: "mxc" });
    } },
  // No setting answers it. The waiver is observed: a person's yes starts one start, and the same yes does not start a second.
  { id: "L4", point: "Windows extension start while home privacy failed", tree: "no row", unknown: "U2",
    today: { outcome: "ask-human", reason: "extension-start-consent-required", waiver: "once" },
    observe: () => {
      setProcessPlatform("win32");
      setPluginWorkerConfinementRequestedAtBoot(true);
      setAveHomePrivacyAtBoot({ enforcement: "none", home: FIXTURE_HOME, category: "read-back-failed", reason: "fixture" });
      const first = extensionStart();
      setExtensionStartAsker({ ask: async () => "yes", notify: () => {} });
      const key = "plugin-child:fixture";
      return requestExtensionStartConsent({ key, kind: "plugin-child", label: "fixture", cause: "home-privacy-unverified" }, { sessionId: "s1", attended: true })
        .then((authority): Observation => {
          const start = () => extensionStart({ start: { key, authority, spend: true } }).outcome;
          if (start() !== "unasked") return { ...first, waiver: "none" };
          return { ...first, waiver: start() === "ask-human" ? "once" : "session" };
        });
    } },
  { id: "L5", point: "Windows extension start, settled with no backend", tree: "T:128", unknown: "U2",
    today: { outcome: "ask-human", reason: "unavailable:runtime-start-failed" },
    observe: () => {
      setProcessPlatform("win32");
      setPluginWorkerConfinementRequestedAtBoot(true);
      setAveHomePrivacyAtBoot({ enforcement: "win32-dacl", home: FIXTURE_HOME, sid: "S-1-5-21-1" });
      const reason = publishExtensionPlan({ state: "unavailable", reason: "runtime-start-failed" });
      return { outcome: extensionStart().outcome, reason };
    } },
  { id: "L6", point: "macOS/Linux extension start: no gate", tree: "no row", unknown: "U2",
    today: { outcome: "unasked", reason: "none" },
    core: { outcome: "ask-human" },
    observe: () => {
      setPluginWorkerConfinementRequestedAtBoot(true);
      return (["darwin", "linux"] as const).map(platform => { setProcessPlatform(platform); return extensionStart(); })
        .reduce((first, next) => { expect(next).toEqual(first); return first; });
    } },
  { id: "L13", point: "container filesystem request shape", tree: "no row", unknown: "-",
    today: { outcome: "deny", reason: "uncoded:Error" },
    core: { reason: "registry-code" },
    observe: () => {
      const grants = (readwrite: string[], denied: string[] = []) => ({ readwrite, readonly: [], denied });
      const reasons = [
        refusal(() => synthesizeMxcAncestorQueries(grants(["C:\\"]))),
        refusal(() => synthesizeMxcAncestorQueries(grants(["C:\\work\\a"]), ["C:\\work\\b"])),
        refusal(() => synthesizeMxcAncestorQueries(grants(["C:\\home\\staging"], ["C:\\home"]))),
      ];
      expect(new Set(reasons).size).toBe(1);
      expect(refusal(() => synthesizeMxcAncestorQueries(grants(["C:\\work\\a"])))).toBe("none");
      return { outcome: "deny", reason: [...new Set(reasons)].join("+") };
    } },
  { id: "L17", point: "readiness classification", tree: "no row", unknown: "-",
    today: { outcome: "state", reason: "unavailable:readiness-deadline" },
    observe: () => {
      expect(classifyMxcExtensionReadiness(READY)).toEqual({ state: "available" });
      expect(classifyMxcExtensionReadiness({ ...READY, ancestorQueriesSupported: false })).toEqual({ state: "unavailable", reason: "ancestor-policy-unsupported" });
      expect(classifyMxcReleaseGate(RELEASE_GATE)).toEqual({ state: "available" });
      expect(classifyMxcReleaseGate({ ...RELEASE_GATE, otherListenerRefused: false })).toEqual({ state: "unavailable", reason: "endpoint-isolation-unverified" });
      const fallback = { version: "0.0.80", ready: false };
      expect(planWindowsExtensionHolder({ requested: true, mxc: { state: "checking" }, fallback }).readiness).toBe("checking");
      const settled = planWindowsExtensionHolder({ requested: true, mxc: { state: "unavailable", reason: "readiness-deadline" }, fallback });
      return { outcome: "state", reason: `${settled.readiness}:${settled.reason}` };
    } },
  // Host-owned code: the extension-start floor never asks about it, and its own gate decides. Today that gate refuses with
  // no OS sandbox; the ruled end state (OQ-14, T:204) is a Settings switch, on by default, that runs it unconfined.
  { id: "L20", point: "local inference child with no confinement backend", tree: "T:203-204", unknown: "-",
    today: { outcome: "deny", reason: "local-runtime-unavailable" },
    core: { outcome: "unasked", waiver: "setting" },
    observe: () => {
      setProcessPlatform("win32");
      setPluginWorkerConfinementRequestedAtBoot(true);
      setAveHomePrivacyAtBoot({ enforcement: "win32-dacl", home: FIXTURE_HOME, sid: "S-1-5-21-1" });
      // The plan production boot publishes for extensions today.
      expect(publishExtensionPlan({ state: "unavailable", reason: "native-validation-required" })).toBe("unavailable:native-validation-required");
      expect(extensionStart().outcome).toBe("ask-human");
      expect(extensionStart({ hostOwned: true })).toEqual({ outcome: "unasked", reason: "none" });
      return { outcome: "deny", reason: refusal(assertLocalEmbeddingRuntime) };
    } },
  { id: "L18", point: "a container route is published under the runtime-wrap name", tree: "T:128", unknown: "-",
    today: { outcome: "contained", reason: "mode=asrt kind=asrt substrate=mxc" },
    core: { reason: "containment-evidence" },
    observe: () => {
      const built = buildHostShellExecutionPlan({ platform: "win32", requestedSandbox: true, activeCapability: capability("win32", "asrt"), shellSubstrate: "mxc" });
      return { outcome: built.sandboxed ? "contained" : "ask", reason: `mode=${built.mode} kind=${built.capability.kind} substrate=${built.substrate}` };
    } },
];

// Inconsistency id (policy design, section 3) -> the rows that still answer differently from the policy core.
const EXCEPTIONS: Readonly<Record<string, readonly string[]>> = {
  I3: ["L20"],
  I11: ["D26"],
  I12: ["D27"],
  I15: ["L3", "L13"],
  I16: ["L18"],
  I18: ["L6"],
  I19: ["D30"],
};

// Closed inconsistency -> the row that proves it, which answers as the policy core does.
const RESOLVED: Readonly<Record<string, string>> = {
  I5: "D34.b",
  I8: "L4",
  I10: "L1",
};

// Inconsistencies no driven row can show, and why.
const INCONSISTENCIES_WITHOUT_ROW: Readonly<Record<string, string>> = {
  I1: "an exact saved host rule on a no-backend host: an open owner question (loosening); D25 shows S1's forced ask, the core answer",
  I2: "one shared card for every waiting start is not built (lane i2-batch-card); L5 shows the per-start ask",
  I4: "lives on the device-path branch, not on main",
  I6: "stage workspaces are not on main",
  I7: "a launch-count budget, not a decision",
  I9: "a checking plan cannot be published (per-holder readiness resolves it), so no start meets it at the gate driven here",
  I13: "boot abort versus degrade: boot step, not driven",
  I14: "headless wording spans the relay and tool results, not driven",
  I17: "absent protected names: native launch, not driven",
  I20: "parked owner carve-out",
  I21: "launch-time pattern expansion: native launch, not driven",
  I22: "worker transport under a container: spawn path, not driven",
  I23: "watched rows are not on main",
  I24: "background shells under the floor: tool layer, not driven",
  I25: "hook starts: hook runner, not driven",
  I26: "staging location is parked; today's refusal is pinned by L13",
  I27: "session scope has one observable today (D5, D21); the other two are not on main",
  I28: "worker parent binding: spawn path, not driven",
};

// Decision points with no row, and why. Nothing here is asserted.
const NOT_DRIVEN: Readonly<Record<string, string>> = {
  D18: "needs a PermissionManager with an unreadable rule store",
  D19: "needs a PermissionManager with a policy change during review",
  D29: "the analysis kind is pinned by shell-path-policy-cwd-tracking.test.ts; the approval path that turns it into an ask is not driven",
  D31: "the analysis kind is pinned by the shell-path-policy tests; the approval path that turns it into a floor is not driven",
  D35: "the ask for a loopback literal is in the relay; D32 pins that loopback is not a reserved literal",
  D28: "route selection needs host-issued plans, capabilities and effect envelopes; pinned by execution-router.test.ts",
  D33: "needs a live relay listener and an ask callback",
  D36: "needs a live relay listener",
  D37: "needs the egress ask callback and its approval surface",
  D38: "needs the egress ask callback and a worker attribution",
  D39: "needs a remote controller session",
  L7: "needs a contained worker spawn",
  L8: "needs a worker spawn with grants",
  L9: "needs a worker spawn and a real link",
  L10: "needs a worker whose termination cannot be verified",
  L11: "needs an out-of-process plugin load",
  L12: "needs an out-of-process plugin load with a catalog",
  L14: "needs the native launcher request with real paths",
  L15: "needs the pinned launcher on disk",
  L16: "needs the native launcher request",
  L19: "boot step with settings and environment",
  L21: "native helper behaviour",
  L22: "not on main",
  L23: "needs the hook runner; its gate is the one L1-L6 drive",
  L24: "needs the MCP stdio client; its gate is the one L1-L6 drive",
  L25: "needs real files and identity probes",
  L26: "not on main",
  L27: "download target volume: outside the permission modules",
  L28: "needs a minted permit with a canonical working directory",
  L29: "a launch-count budget, not a decision",
  L30: "needs the invocation runner and a bound terminal",
  L31: "needs a home that is a link or cannot be listed",
};

const HOST_PLATFORM = process.platform;

afterEach(() => {
  __resetExtensionStartsForTest();
  setProcessPlatform(HOST_PLATFORM);
  __resetSandboxRequestedAtBootForTest();
  __resetWindowsSandboxSubstrateForTest();
  _resetAveHomePrivacyForTest();
});

describe("permission vocabulary contract", () => {
  it.each(ROWS.map(row => [row.id, row.point, row] as const))("%s %s", async (_id, _point, row) => {
    expect(await row.observe()).toEqual(row.today);
  });

  it("keeps every row inside the closed vocabulary", () => {
    for (const row of ROWS) {
      for (const seen of [row.today, row.core ?? {}]) {
        if (seen.outcome !== undefined) expect(OUTCOMES, row.id).toContain(seen.outcome);
        if (seen.headless !== undefined) expect(OUTCOMES, row.id).toContain(seen.headless);
        if (seen.waiver !== undefined) expect(WAIVERS, row.id).toContain(seen.waiver);
      }
      expect(row.tree, row.id).toMatch(/^(?:no row|T:\d+(?:-\d+)?(?:, T:\d+(?:-\d+)?)*)$/u);
      // The outcome the policy core gives this row must be the one its unknown class allows.
      expect(UNKNOWN_CORE[row.unknown], row.id).toContain(row.core?.outcome ?? row.today.outcome);
    }
  });

  it("lists every row that differs from the policy core as an exception, and nothing else", () => {
    const listed = Object.values(EXCEPTIONS).flat();
    expect(new Set(listed).size).toBe(listed.length);
    expect([...listed].sort()).toEqual(ROWS.filter(row => row.core !== undefined).map(row => row.id).sort());
    for (const row of ROWS) {
      if (row.core !== undefined) expect({ ...row.today, ...row.core }, row.id).not.toEqual(row.today);
      // A refusal with no stable code is an exception until the reason registry exists.
      if (row.today.reason.startsWith("uncoded:")) expect(row.core?.reason, row.id).toBe("registry-code");
    }
  });

  it("accounts for every decision point and every inconsistency exactly once", () => {
    const points = [...Array.from({ length: 39 }, (_, index) => `D${index + 1}`), ...Array.from({ length: 31 }, (_, index) => `L${index + 1}`)];
    const driven = [...new Set(ROWS.map(row => row.id.replace(/\..*$/u, "")))];
    expect(new Set(ROWS.map(row => row.id)).size).toBe(ROWS.length);
    expect(driven.filter(id => id in NOT_DRIVEN)).toEqual([]);
    expect([...driven, ...Object.keys(NOT_DRIVEN)].sort()).toEqual([...points].sort());
    const inconsistencies = Array.from({ length: 28 }, (_, index) => `I${index + 1}`);
    expect([...Object.keys(EXCEPTIONS), ...Object.keys(INCONSISTENCIES_WITHOUT_ROW), ...Object.keys(RESOLVED)].sort()).toEqual([...inconsistencies].sort());
    for (const [id, proof] of Object.entries(RESOLVED)) {
      const row = ROWS.find(candidate => candidate.id === proof);
      expect(row, id).toBeDefined();
      expect(row?.core, id).toBeUndefined();
      expect(Object.values(EXCEPTIONS).flat(), id).not.toContain(proof);
    }
  });
});
