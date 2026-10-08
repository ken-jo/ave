import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { McpGovernance } from "../mcp-governance.js";
import { buildPolicy, stdioApproval } from "./test-helpers.js";
import type { McpGovernancePolicy, McpServerApproval } from "../types.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture(allowUserApprovedServers: boolean, bundledServers: McpGovernancePolicy["bundledServers"] = []) {
  const dir = mkdtempSync(join(tmpdir(), "mcp-admission-"));
  dirs.push(dir);
  const path = join(dir, "policy.json");
  const policy: McpGovernancePolicy = { ...buildPolicy([]), bundledServers,
    globalRules: { ...buildPolicy([]).globalRules, allowUserApprovedServers } };
  const write = (next: McpGovernancePolicy) => writeFileSync(path, JSON.stringify(next));
  write(policy);
  return { governance: new McpGovernance(path), policy, write };
}

function approval(): McpServerApproval {
  return stdioApproval("plugin_deadbeef", "/sealed/server/run", { provenance: "user",
    bundled: { package: "agent-plugin/writer", server: "notes", fingerprint: "a".repeat(64) } });
}

describe("bundled runtime policy admission", () => {
  it("refuses user approval at every insertion when the organization rule is off", () => {
    const { governance } = fixture(false);
    const user = approval();
    expect(governance.isRuntimeApprovalAdmitted(user)).toBe(false);
    expect(() => governance.registerRuntimeApproval(user)).toThrow("runtime approval not admitted by policy");
    expect(() => governance.scopedRuntimeApproval(user)).toThrow("runtime approval not admitted by policy");
    expect(() => governance.replaceRuntimeApprovals([], [user])).toThrow("runtime approval not admitted by policy");
    expect(() => governance.prepareRuntimeApprovals([], [user])).toThrow("runtime approval not admitted by policy");
  });

  it("keeps a listed fingerprint under the rule and withdraws it on policy reload", () => {
    const user = approval();
    const bundled = user.bundled!;
    const { governance, policy, write } = fixture(false, [bundled]);
    const approved = governance.policyFingerprintApproval(user)!;
    expect(approved.provenance).toBe("policy-fingerprint");
    governance.registerRuntimeApproval(approved);
    expect(governance.getApproval(user.id)).toEqual(approved);
    write({ ...policy, bundledServers: [] });
    expect(governance.reloadPolicy()).toEqual([user.id]);
    expect(governance.getApproval(user.id)).toBeUndefined();
  });

  it("rejects publication against the policy current at publish time", () => {
    const user = approval();
    const { governance, policy, write } = fixture(true);
    const prepared = governance.prepareRuntimeApprovals([], [user]);
    write({ ...policy, globalRules: { ...policy.globalRules, allowUserApprovedServers: false } });
    governance.reloadPolicy();
    expect(() => prepared.publish()).toThrow("runtime approval not admitted by policy");
    expect(governance.getApproval(user.id)).toBeUndefined();
  });
});
