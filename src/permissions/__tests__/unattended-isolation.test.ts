import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import type { StageEnvelope } from "../../shared/workflow-template-types.js";
import { buildHostShellExecutionPlan, type HostShellExecutionPlan } from "../host-shell-execution-plan.js";
import { proveUnattendedIsolation, type IsolationUnproven, type UnattendedIsolationProfile } from "../unattended-isolation.js";

const home = resolve("test-home");
const workspaceRoot = join(home, ".ave", "worktrees", "project", "run", "stage");
const protectedRoot = join(home, ".ssh");
const envelope: StageEnvelope = {
  tools: [], writePaths: ["out/**"], readRoots: [join(home, "references")], commands: [], network: [],
  mcpReadOnlyTools: [], mcpGenerationTools: [], pluginGenerationTools: [],
  outputs: [], budget: { rounds: 1, minutes: 1, costUsd: 0 },
};
const toolchainRoots = [join(home, ".local", "bin")];
const wrapPlan = buildHostShellExecutionPlan({
  platform: "darwin", requestedSandbox: true,
  activeCapability: { kind: "asrt", confidence: "verified", platform: "darwin", reason: "Confined test plan",
    confines: { filesystem: true, process: true, network: true } },
});
const measuredPlan: HostShellExecutionPlan = {
  ...wrapPlan, substrate: "mxc", egressProtocolCoverage: { dns: "brokered", rawIp: "blocked" },
};
const proofInput = {
  plan: measuredPlan, envelope, workspaceRoot, home, toolchainRoots,
  floorCovers: (path: string) => path === protectedRoot || path === join(protectedRoot, "keys"),
};

describe("unattended isolation proof", () => {
  it.each(["darwin", "linux", "win32"] as const)("uses measured container evidence independent of platform (%s)", platform => {
    const profile: UnattendedIsolationProfile = {
      readRoots: [workspaceRoot, ...envelope.readRoots, ...toolchainRoots],
      writeRoots: [workspaceRoot],
      readDenyRoots: [home], toolchainReadRoots: toolchainRoots,
    };
    expect(proveUnattendedIsolation({ ...proofInput, plan: { ...measuredPlan, platform } })).toEqual({ proven: true, profile });
  });

  it.each(["plain", "blocked"] as const)("refuses an unconfined %s plan before its other evidence", mode => {
    const plan: HostShellExecutionPlan = { ...wrapPlan, mode, sandboxed: false, substrate: "none" };
    expect(proveUnattendedIsolation({ ...proofInput, plan, home: undefined })).toEqual({ proven: false, reason: "sandbox-unavailable" });
  });

  it("refuses a sandboxed wrap before considering raw-IP coverage", () => {
    expect(proveUnattendedIsolation({ ...proofInput, plan: wrapPlan })).toEqual({ proven: false, reason: "platform-not-qualified" });
  });

  it("refuses a container plan with unknown raw-IP coverage before checking read roots", () => {
    const plan: HostShellExecutionPlan = {
      ...measuredPlan, platform: "win32", egressProtocolCoverage: { dns: "host-resolver", rawIp: "unknown" },
    };
    expect(proveUnattendedIsolation({ ...proofInput, plan, home: undefined })).toEqual({ proven: false, reason: "boundary-unverified" });
  });

  it.each([
    { home: undefined }, { home: "relative-home" },
    { workspaceRoot: "relative-workspace" }, { workspaceRoot: protectedRoot },
    { envelope: { ...envelope, readRoots: ["relative-root"] } },
    { envelope: { ...envelope, readRoots: [join(protectedRoot, "keys")] } },
  ])("refuses unresolved or protected paths (%j)", patch => {
    const reason: IsolationUnproven = "read-narrowing-unavailable";
    expect(proveUnattendedIsolation({ ...proofInput, ...patch })).toEqual({ proven: false, reason });
  });

  it("does not widen the roots from generated envelopes and toolchain lists", () => {
    for (let count = 0; count < 8; count++) {
      const readRoots = Array.from({ length: count }, (_, index) => join(home, `input-${index}`));
      const pathRoots = Array.from({ length: 7 - count }, (_, index) => join(home, `tool-${index}`, "bin"));
      expect(proveUnattendedIsolation({ ...proofInput, envelope: { ...envelope, readRoots }, toolchainRoots: pathRoots })).toEqual({
        proven: true,
        profile: { readRoots: [workspaceRoot, ...readRoots, ...pathRoots], writeRoots: [workspaceRoot], readDenyRoots: [home], ...(pathRoots.length && { toolchainReadRoots: pathRoots }) },
      });
    }
  });
});
