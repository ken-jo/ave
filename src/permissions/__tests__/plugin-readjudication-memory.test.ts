import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import type { PluginReadjudicationEvidence, UserApprovalScope } from "../../shared/permissions-events.js";
import { withholdSessionAuthorityFor } from "../../shared/turn-extension-policy.js";
import {
  __resetSessionStoreForTest,
  canonicalStringify,
  captureApprovalWorkingDirectory,
  dropSessionApprovals,
  listApprovals,
  lookupApproval,
  lookupReadjudicationApproval,
  lookupUserDecision,
  recordApproval,
  revokeApprovalByKey,
  userApprovalFilePath,
} from "../user-approval-store.js";
import { RuleBasedRiskClassifier } from "../reviewer/risk-classifier.js";
import * as sandboxCapability from "../sandbox-capability.js";
import { tryUserApprovalMemorySkip } from "../../tools/pipeline/approval-memory-skip.js";

const TOOL = "plugin_document_update";
const SESSION = "readjudication-session";
const ORIGIN = "llm-tool-arg";
const INPUT = { operation: "update", value: "same input" };
const EVIDENCE: PluginReadjudicationEvidence = {
  pluginId: "document-tools",
  artifactSha256: "a".repeat(64),
  signerKeyId: "receipt-signer",
  staticReason: "write-path-not-declared",
};

describe("exact plugin re-adjudication memory", () => {
  let root: string;
  let first: string;
  let second: string;
  let previousAveHome: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(homedir(), "ave-readjudication-memory-"));
    previousAveHome = process.env.AVE_HOME;
    process.env.AVE_HOME = join(root, "state");
    first = join(root, "first");
    second = join(root, "second");
    await mkdir(first);
    await mkdir(second);
    __resetSessionStoreForTest();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    __resetSessionStoreForTest();
    if (previousAveHome === undefined) delete process.env.AVE_HOME;
    else process.env.AVE_HOME = previousAveHome;
    await cleanupTmpDir(root);
  });

  async function save(scope: UserApprovalScope, evidence = EVIDENCE): Promise<void> {
    await recordApproval(TOOL, canonicalStringify(INPUT), "plugin", {
      scope,
      ...(scope === "session" ? { sessionId: SESSION } : {}),
      ...(scope === "global" ? {} : { projectCwd: first }),
      workingDirectoryIdentity: captureApprovalWorkingDirectory(first).identity,
      verdictAtApproval: "medium",
      nlJustification: null,
      trustOrigin: ORIGIN,
      readjudication: evidence,
    });
  }

  const find = (cwd: string, sessionId = SESSION) => lookupReadjudicationApproval(
    TOOL, canonicalStringify(INPUT), "plugin", EVIDENCE.pluginId, ORIGIN, cwd, sessionId,
  );

  it.each(["session", "persistent", "global"] as const)("remembers exact input at %s scope without entering the ordinary matcher", async scope => {
    await save(scope);
    expect(await find(first)).toMatchObject({ scope, verdictAtApproval: "medium", readjudication: EVIDENCE });
    expect(await lookupApproval(TOOL, canonicalStringify(INPUT), "plugin", ORIGIN, undefined, first, SESSION)).toBeNull();
    expect(await lookupUserDecision(TOOL, canonicalStringify(INPUT), "plugin", ORIGIN, undefined, first, SESSION)).toBeNull();
    expect(await find(first, "another-session")).toEqual(scope === "session" ? null : expect.objectContaining({ scope }));
    expect(await find(second)).toEqual(scope === "global" ? expect.objectContaining({ scope }) : null);
  });

  it.each(["persistent", "global"] as const)("retains %s evidence as history across a process-cache reset", async scope => {
    await save(scope);
    __resetSessionStoreForTest();
    expect(await find(first)).toMatchObject({ readjudication: EVIDENCE, verdictAtApproval: "medium" });
  });

  it("ends session memory with its conversation and does not inherit it during a scheduled wake", async () => {
    await save("session");
    const release = withholdSessionAuthorityFor(SESSION);
    try {
      expect(await find(first)).toBeNull();
    } finally {
      release();
    }
    expect(await find(first)).not.toBeNull();
    expect(dropSessionApprovals(SESSION)).toBe(1);
    expect(await find(first)).toBeNull();
  });

  it.each(["session", "persistent", "global"] as const)("revokes the dedicated %s record through the existing approval list", async scope => {
    await save(scope);
    const entries = await listApprovals();
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    if (!entry) throw new Error("Expected the remembered approval");
    await revokeApprovalByKey(entry.key);
    expect(await find(first)).toBeNull();
    __resetSessionStoreForTest();
    expect(await find(first)).toBeNull();
  });

  it.each([
    ["arguments", TOOL, canonicalStringify({ ...INPUT, value: "changed" }), "plugin", EVIDENCE.pluginId, ORIGIN],
    ["tool", "plugin_document_remove", canonicalStringify(INPUT), "plugin", EVIDENCE.pluginId, ORIGIN],
    ["plugin", TOOL, canonicalStringify(INPUT), "plugin", "another-plugin", ORIGIN],
    ["source", TOOL, canonicalStringify(INPUT), "mcp", EVIDENCE.pluginId, ORIGIN],
    ["trust origin", TOOL, canonicalStringify(INPUT), "plugin", EVIDENCE.pluginId, "plugin-emitted"],
  ])("does not widen a grant when %s changes", async (_name, tool, args, source, pluginId, origin) => {
    await save("global");
    expect(await lookupReadjudicationApproval(tool, args, source, pluginId, origin, first, SESSION)).toBeNull();
  });

  it("rejects broad policy keys and invalid evidence at recording rather than widening exact input", async () => {
    const entry = {
      scope: "global" as const,
      verdictAtApproval: "medium" as const,
      nlJustification: null,
      readjudication: EVIDENCE,
    };
    await expect(recordApproval(TOOL, canonicalStringify(INPUT), "plugin", {
      ...entry, approvalCacheKey: { key: "policy", memoryKey: "all-inputs" },
    })).rejects.toThrow("Invalid plugin re-adjudication record");
    await expect(recordApproval(TOOL, canonicalStringify(INPUT), "plugin", {
      ...entry, readjudication: { ...EVIDENCE, artifactSha256: "unverified" },
    })).rejects.toThrow("Invalid plugin re-adjudication record");
    await expect(recordApproval(TOOL, canonicalStringify(INPUT), "plugin", {
      ...entry, verdictAtApproval: "high",
    })).rejects.toThrow("Invalid plugin re-adjudication record");
    await expect(recordApproval(TOOL, canonicalStringify(INPUT), "builtin", entry)).rejects.toThrow("Invalid plugin re-adjudication record");
    expect(await listApprovals()).toHaveLength(0);
  });

  it.each([null, {}, { ...EVIDENCE, staticReason: "outside-project" }])("never treats malformed evidence as an ordinary allow", async readjudication => {
    await recordApproval(TOOL, canonicalStringify(INPUT), "plugin", {
      scope: "persistent", verdictAtApproval: "medium", nlJustification: null,
      trustOrigin: ORIGIN, workingDirectoryIdentity: captureApprovalWorkingDirectory(first).identity,
    });
    const path = userApprovalFilePath();
    const file = JSON.parse(await readFile(path, "utf8")) as { approvals: Record<string, Record<string, unknown>> };
    for (const row of Object.values(file.approvals)) row.readjudication = readjudication;
    await writeFile(path, JSON.stringify(file));
    __resetSessionStoreForTest();
    expect(await lookupApproval(TOOL, canonicalStringify(INPUT), "plugin", ORIGIN, undefined, first, SESSION)).toBeNull();
    expect(await find(first)).toBeNull();
  });

  it("keeps an ordinary remembered decision separate when both kinds exist", async () => {
    await save("persistent");
    await recordApproval(TOOL, canonicalStringify(INPUT), "plugin", {
      scope: "persistent", verdictAtApproval: "high", nlJustification: null,
      trustOrigin: ORIGIN, workingDirectoryIdentity: captureApprovalWorkingDirectory(first).identity,
    });
    expect(await listApprovals()).toHaveLength(2);
    expect(await lookupApproval(TOOL, canonicalStringify(INPUT), "plugin", ORIGIN, undefined, first, SESSION)).toMatchObject({ verdictAtApproval: "high" });
    expect(await find(first)).toMatchObject({ verdictAtApproval: "medium" });
  });

  it("does not treat a present but undefined evidence marker as an ordinary session allow", async () => {
    await recordApproval(TOOL, canonicalStringify(INPUT), "plugin", {
      scope: "session", sessionId: SESSION, verdictAtApproval: "medium", nlJustification: null,
      trustOrigin: ORIGIN, workingDirectoryIdentity: captureApprovalWorkingDirectory(first).identity,
    });
    const entry = await lookupApproval(TOOL, canonicalStringify(INPUT), "plugin", ORIGIN, undefined, first, SESSION);
    if (!entry) throw new Error("Expected the ordinary session approval");
    Object.defineProperty(entry, "readjudication", { value: undefined });
    expect(await lookupApproval(TOOL, canonicalStringify(INPUT), "plugin", ORIGIN, undefined, first, SESSION)).toBeNull();
    expect(await find(first)).toBeNull();
  });

  it("reuses human memory without querying present confinement, classification or a reviewer", async () => {
    await save("persistent");
    __resetSessionStoreForTest();
    const classify = vi.spyOn(RuleBasedRiskClassifier.prototype, "classify").mockImplementation(() => {
      throw new Error("Reuse must not classify the saved request again");
    });
    const capability = vi.spyOn(sandboxCapability, "resolveReviewerSandboxCapability").mockImplementation(() => {
      throw new Error("Reuse must not inspect current confinement");
    });
    const review = vi.fn();
    const disclose = vi.fn();
    const result = await tryUserApprovalMemorySkip(TOOL, "plugin", "write", ["path"], INPUT,
      first, [], [], { trustOrigin: ORIGIN, approvalMemory: { kind: "args" } }, undefined, {},
      "invocation", undefined, "different-worker", EVIDENCE.pluginId, undefined, undefined,
      SESSION, disclose, review);
    expect(result).toMatchObject({ decision: "allow", reason: "prior human re-adjudication (scope=persistent)" });
    expect(classify).not.toHaveBeenCalled();
    expect(capability).not.toHaveBeenCalled();
    expect(review).not.toHaveBeenCalled();
    expect(disclose).toHaveBeenCalledWith({ toolName: TOOL, scope: "persistent", verdictAtApproval: "medium" });
  });

  it("does not use dedicated memory for another principal or against an exact deny", async () => {
    await save("persistent");
    const invoke = (otherPrincipal = false) => tryUserApprovalMemorySkip(TOOL, "plugin", "write", [], INPUT,
      first, [], [], { trustOrigin: ORIGIN, approvalMemory: { kind: "args" }, otherPrincipal },
      undefined, {}, "invocation", undefined, undefined, EVIDENCE.pluginId, undefined, undefined, SESSION);
    expect(await invoke(true)).toBeNull();
    await recordApproval(TOOL, canonicalStringify(INPUT), "plugin", {
      decision: "deny", scope: "persistent", verdictAtApproval: "high", nlJustification: null,
      trustOrigin: ORIGIN, workingDirectoryIdentity: captureApprovalWorkingDirectory(first).identity,
    });
    expect(await invoke()).toBeNull();
  });

  it("uses the explicit re-adjudication before an ordinary MEDIUM approval that would reclassify HIGH", async () => {
    await recordApproval(TOOL, canonicalStringify(INPUT), "plugin", {
      scope: "persistent", verdictAtApproval: "medium", nlJustification: null,
      trustOrigin: ORIGIN, workingDirectoryIdentity: captureApprovalWorkingDirectory(first).identity,
    });
    await save("persistent");
    expect(new RuleBasedRiskClassifier().classify({
      toolName: TOOL, source: "plugin", category: "write", pathFields: ["path"], finalInput: INPUT,
      executionCwd: first, allowedDirectories: [], sensitivePathsAdjacent: [], trustOrigin: ORIGIN,
      sandboxCapability: { kind: "none", confidence: "verified", platform: process.platform, reason: "No confinement" },
    })).toEqual({ level: "high", reason: "write path not declared" });
    const classify = vi.spyOn(RuleBasedRiskClassifier.prototype, "classify").mockImplementation(() => {
      throw new Error("An ordinary record cannot trigger review of an explicit re-adjudication");
    });
    const result = await tryUserApprovalMemorySkip(TOOL, "plugin", "write", ["path"], INPUT,
      first, [], [], { trustOrigin: ORIGIN, approvalMemory: { kind: "args" } }, undefined, {},
      "invocation", undefined, undefined, EVIDENCE.pluginId, undefined, undefined, SESSION);
    expect(result).toMatchObject({ decision: "allow", reason: "prior human re-adjudication (scope=persistent)" });
    expect(classify).not.toHaveBeenCalled();
  });

  it("does not reuse a retained depth-limited identity for different deeply nested input", async () => {
    let firstInput: Record<string, unknown> = { value: "first" };
    let secondInput: Record<string, unknown> = { value: "second" };
    for (let depth = 0; depth < 105; depth += 1) {
      firstInput = { nested: firstInput };
      secondInput = { nested: secondInput };
    }
    expect(canonicalStringify(firstInput)).toBe(canonicalStringify(secondInput));
    await save("global");
    const path = userApprovalFilePath();
    const file = JSON.parse(await readFile(path, "utf8")) as { approvals: Record<string, unknown> };
    const row = Object.values(file.approvals)[0];
    expect(row).toMatchObject({ scope: "global", readjudication: EVIDENCE });
    // Retained row under the depth-limited identity of firstInput, before strict exact-input encoding.
    file.approvals = { a17bf8ba84daff3020c224782c1f73d6771c55a2a53c7ac225427e8a5c471e4e: row };
    await writeFile(path, JSON.stringify(file));
    __resetSessionStoreForTest();
    await expect(lookupReadjudicationApproval(TOOL, JSON.stringify(secondInput), "plugin", EVIDENCE.pluginId,
      ORIGIN, first, SESSION)).rejects.toThrow("Exact input exceeds the nesting limit");
    const result = await tryUserApprovalMemorySkip(TOOL, "plugin", "write", [], secondInput,
      first, [], [], { trustOrigin: ORIGIN, approvalMemory: { kind: "args" } }, undefined, {},
      "invocation", undefined, undefined, EVIDENCE.pluginId, undefined, undefined, SESSION);
    expect(result).toBeNull();
  });
});
