import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rm, mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";

// Point AVE_HOME at an isolated temp dir so tests don't touch ~/.ave
const TEST_HOME = join(tmpdir(), `ave-test-ua-${randomBytes(4).toString("hex")}`);

// Must set env before importing the module
process.env.AVE_HOME = TEST_HOME;

import {
  approvalCacheKeyIdentity,
  captureApprovalWorkingDirectory,
  isExactArgsDecision,
  recordApproval,
  lookupApproval,
  lookupUserDecision,
  revokeApproval,
  revokeApprovalByKey,
  listApprovals,
  readApprovals,
  canonicalStringify,
  __resetSessionStoreForTest,
} from "../user-approval-store.js";

// Every session approval belongs to a conversation (owner decision 2026-10-23).
const SESSION = "11111111-1111-4111-8111-111111111111";

// An args-identity key: narrows the exact-input identity, never replaces it.
const argsKey = (key: string) => approvalCacheKeyIdentity(key, { kind: "args" })!;

beforeEach(async () => {
  await mkdir(TEST_HOME, { recursive: true });
  __resetSessionStoreForTest();
});

afterEach(async () => {
  await rm(TEST_HOME, { recursive: true, force: true });
  __resetSessionStoreForTest();
});

describe("recordApproval + lookupApproval (session scope)", () => {
  it("returns the entry on lookup after recording (session)", async () => {
    await recordApproval("bash_run", '{"command":"ls"}', "user-keyboard", {
      scope: "session",
      sessionId: SESSION,
      verdictAtApproval: "medium",
      nlJustification: null,
    });

    const hit = await lookupApproval("bash_run", '{"command":"ls"}', "user-keyboard", undefined, undefined, undefined, SESSION);
    expect(hit).not.toBeNull();
    expect(hit!.scope).toBe("session");
    expect(hit!.verdictAtApproval).toBe("medium");
    expect(hit!.revokedAt).toBeNull();
  });

  it("returns null for unknown triple", async () => {
    const miss = await lookupApproval("bash_run", '{"command":"rm"}', "user-keyboard", undefined, undefined, undefined, SESSION);
    expect(miss).toBeNull();
  });

  it("does NOT write to disk for session scope", async () => {
    await recordApproval("bash_run", '{"command":"ls"}', "user-keyboard", {
      scope: "session",
      sessionId: SESSION,
      verdictAtApproval: "low",
      nlJustification: null,
    });

    // readApprovals reads disk only — session entry must not appear
    const file = await readApprovals();
    expect(Object.keys(file.approvals)).toHaveLength(0);
  });
});

describe("recordApproval + lookupApproval (persistent scope)", () => {
  it("writes to disk and returns entry on lookup", async () => {
    await recordApproval("memory_write", '{"content":"x"}', "builtin", {
      scope: "persistent",
      verdictAtApproval: "low",
      nlJustification: null,
    });

    const file = await readApprovals();
    expect(Object.keys(file.approvals)).toHaveLength(1);

    const hit = await lookupApproval("memory_write", '{"content":"x"}', "builtin", undefined, undefined, undefined, SESSION);
    expect(hit).not.toBeNull();
    expect(hit!.scope).toBe("persistent");
  });

  it("keeps an exact deny visible to policy checks but never returns it as an approval", async () => {
    await recordApproval("bash_run", '{"command":"rm build.tmp"}', "user-keyboard", {
      decision: "deny",
      scope: "persistent",
      verdictAtApproval: "medium",
      nlJustification: null,
      trustOrigin: "user-keyboard",
    });

    const decision = await lookupUserDecision(
      "bash_run",
      '{"command":"rm build.tmp"}',
      "user-keyboard",
      "user-keyboard",
      undefined,
      undefined,
      SESSION,
    );
    expect(decision?.decision).toBe("deny");
    await expect(lookupApproval(
      "bash_run",
      '{"command":"rm build.tmp"}',
      "user-keyboard",
      "user-keyboard",
      undefined,
      undefined,
      SESSION,
    )).resolves.toBeNull();
  });

  it("uses raw input only for exact matching and never persists or lists it", async () => {
    const secret = "sk-live-super-secret-value";
    const args = canonicalStringify({ token: secret, path: "/tmp/report.txt" });
    await recordApproval("file_read", args, "builtin", {
      decision: "deny",
      scope: "persistent",
      verdictAtApproval: "medium",
      nlJustification: null,
      trustOrigin: "plugin-local-indexer",
      approvalCacheKey: argsKey("/tmp/report.txt"),
    });

    const file = await readApprovals();
    expect(JSON.stringify(file)).not.toContain(secret);
    const list = await listApprovals();
    expect(JSON.stringify(list)).not.toContain(secret);
    expect(list[0]).not.toHaveProperty("args");
    expect(list[0]).not.toHaveProperty("trustOrigin");
    expect(list[0]).not.toHaveProperty("approvalCacheKey");

    const hit = await lookupUserDecision(
      "file_read",
      args,
      "builtin",
      "plugin-local-indexer",
      argsKey("/tmp/report.txt"),
      undefined,
      SESSION,
    );
    expect(hit?.decision).toBe("deny");
  });

  it("HIGH verdict with nlJustification persists the justification", async () => {
    await recordApproval("bash_run", '{"command":"rm -rf /tmp/foo"}', "user-keyboard", {
      scope: "session",
      sessionId: SESSION,
      verdictAtApproval: "high",
      nlJustification: "사용자 요청에 따른 임시 파일 삭제",
    });

    const hit = await lookupApproval("bash_run", '{"command":"rm -rf /tmp/foo"}', "user-keyboard", undefined, undefined, undefined, SESSION);
    expect(hit?.nlJustification).toBe("사용자 요청에 따른 임시 파일 삭제");
    expect(hit?.verdictAtApproval).toBe("high");
  });
});

describe("revokeApproval", () => {
  it("makes lookupApproval return null after revocation", async () => {
    await recordApproval("bash_run", '{"command":"ls"}', "user-keyboard", {
      scope: "persistent",
      verdictAtApproval: "medium",
      nlJustification: null,
    });

    await revokeApproval("bash_run", '{"command":"ls"}', "user-keyboard");

    const result = await lookupApproval("bash_run", '{"command":"ls"}', "user-keyboard", undefined, undefined, undefined, SESSION);
    expect(result).toBeNull();
  });

  it("is idempotent on unknown triple", async () => {
    await expect(revokeApproval("unknown_tool", "{}", "builtin")).resolves.toBeUndefined();
  });
});

describe("revokeApprovalByKey", () => {
  it("marks persistent entry as revoked on disk", async () => {
    await recordApproval("file_read", '{"path":"/tmp/x"}', "builtin", {
      scope: "persistent",
      verdictAtApproval: "low",
      nlJustification: null,
    });

    const list = await listApprovals();
    expect(list).toHaveLength(1);
    const key = list[0].key;

    await revokeApprovalByKey(key);

    const file = await readApprovals();
    expect(file.approvals[key].revokedAt).not.toBeNull();
  });
});

describe("listApprovals", () => {
  it("lists active (non-revoked) persistent entries", async () => {
    await recordApproval("file_read", '{"path":"/tmp/a"}', "builtin", {
      scope: "persistent",
      verdictAtApproval: "low",
      nlJustification: null,
    });
    await recordApproval("bash_run", '{"command":"ls"}', "user-keyboard", {
      scope: "persistent",
      verdictAtApproval: "medium",
      nlJustification: null,
    });

    const list = await listApprovals();
    expect(list).toHaveLength(2);
    expect(list.every((a) => a.revokedAt === null)).toBe(true);
  });

  it("includes session-only entries in the listing", async () => {
    await recordApproval("mcp_tool", '{}', "mcp", {
      scope: "session",
      sessionId: SESSION,
      verdictAtApproval: "low",
      nlJustification: null,
    });

    const list = await listApprovals();
    expect(list.some((a) => a.scope === "session")).toBe(true);
  });

  it("includes revoked entries (revokedAt set) but lookupApproval ignores them", async () => {
    await recordApproval("file_read", '{"path":"/tmp/b"}', "builtin", {
      scope: "persistent",
      verdictAtApproval: "low",
      nlJustification: null,
    });
    const list1 = await listApprovals();
    const key = list1[0].key;
    await revokeApprovalByKey(key);

    // listApprovals includes revoked entries for audit purposes (revokedAt set)
    const list2 = await listApprovals();
    const revoked = list2.find((a) => a.key === key);
    expect(revoked).toBeDefined();
    expect(revoked!.revokedAt).not.toBeNull();

    // But lookupApproval skips revoked entries
    const lookup = await lookupApproval("file_read", '{"path":"/tmp/b"}', "builtin", undefined, undefined, undefined, SESSION);
    expect(lookup).toBeNull();
  });
});

describe("atomicWrite safety", () => {
  it("concurrent writes do not corrupt the file", async () => {
    const writes = Array.from({ length: 10 }, (_, i) =>
      recordApproval(`tool_${i}`, `{"n":${i}}`, "builtin", {
        scope: "persistent",
        verdictAtApproval: "low",
        nlJustification: null,
      }),
    );
    await Promise.all(writes);

    const file = await readApprovals();
    // At least one write must have landed; JSON must be valid (no corruption)
    expect(typeof file.approvals).toBe("object");
  });
});

// CRITICAL-4: trustOrigin cache identity isolation

describe("CRITICAL-4: different trustOrigin values produce distinct cache keys", () => {
  it("approval recorded with trustOrigin A is not visible under trustOrigin B", async () => {
    await recordApproval("bash_run", '{"command":"ls"}', "user-keyboard", {
      scope: "session",
      sessionId: SESSION,
      verdictAtApproval: "high",
      nlJustification: "user approved",
      trustOrigin: "user-keyboard",
    });

    // Same tool/args/source but different trustOrigin — must not get a hit
    const miss = await lookupApproval(
      "bash_run",
      '{"command":"ls"}',
      "user-keyboard",
      "plugin-untrusted",
      undefined,
      undefined,
      SESSION,
    );
    expect(miss).toBeNull();
  });

  it("approval recorded with trustOrigin is found under same trustOrigin", async () => {
    await recordApproval("bash_run", '{"command":"ls"}', "user-keyboard", {
      scope: "session",
      sessionId: SESSION,
      verdictAtApproval: "medium",
      nlJustification: null,
      trustOrigin: "mcp-server-abc",
    });

    const hit = await lookupApproval(
      "bash_run",
      '{"command":"ls"}',
      "user-keyboard",
      "mcp-server-abc",
      undefined,
      undefined,
      SESSION,
    );
    expect(hit).not.toBeNull();
    expect(hit!.verdictAtApproval).toBe("medium");
  });

  it("approval recorded without trustOrigin is not found when trustOrigin is supplied", async () => {
    await recordApproval("bash_run", '{"command":"ls"}', "user-keyboard", {
      scope: "session",
      sessionId: SESSION,
      verdictAtApproval: "low",
      nlJustification: null,
    });

    const miss = await lookupApproval(
      "bash_run",
      '{"command":"ls"}',
      "user-keyboard",
      "plugin-abc",
      undefined,
      undefined,
      SESSION,
    );
    expect(miss).toBeNull();
  });

  it("different approvalCacheKey values produce distinct cache entries", async () => {
    await recordApproval("bash_run", '{"command":"ls"}', "user-keyboard", {
      scope: "session",
      sessionId: SESSION,
      verdictAtApproval: "low",
      nlJustification: null,
      approvalCacheKey: argsKey("key-alpha"),
    });

    const miss = await lookupApproval(
      "bash_run",
      '{"command":"ls"}',
      "user-keyboard",
      undefined,
      argsKey("key-beta"),
      undefined,
      SESSION,
    );
    expect(miss).toBeNull();

    const hit = await lookupApproval(
      "bash_run",
      '{"command":"ls"}',
      "user-keyboard",
      undefined,
      argsKey("key-alpha"),
      undefined,
      SESSION,
    );
    expect(hit).not.toBeNull();
  });
});

// HIGH-2: canonicalStringify key-order invariance

describe("HIGH-2: canonicalStringify produces key-order-invariant output", () => {
  it("{a,b} and {b,a} produce the same string", () => {
    expect(canonicalStringify({ a: 1, b: 2 })).toBe(canonicalStringify({ b: 2, a: 1 }));
  });

  it("nested objects are also sorted", () => {
    const x = { outer: { z: 3, a: 1 }, b: 2 };
    const y = { b: 2, outer: { a: 1, z: 3 } };
    expect(canonicalStringify(x)).toBe(canonicalStringify(y));
  });

  it("arrays are not reordered (only object keys are sorted)", () => {
    expect(canonicalStringify([3, 1, 2])).toBe("[3,1,2]");
  });

  it("null is handled", () => {
    expect(canonicalStringify(null)).toBe("null");
  });

  it("callers that pre-canonicalize args get key-order-invariant store hits", async () => {
    // The store's public API takes pre-stringified args; key-order invariance is the caller's responsibility (permission-manager.ts uses canonicalStringify before calling lookupApproval). This test verifies that if two callers both use canonicalStringify they get the same canonical string and therefore the same store key.
    const argsObj1 = { path: "/tmp/a", mode: "r" };
    const argsObj2 = { mode: "r", path: "/tmp/a" };
    const canonical1 = canonicalStringify(argsObj1);
    const canonical2 = canonicalStringify(argsObj2);

    // Both canonical forms must be identical
    expect(canonical1).toBe(canonical2);

    // Record using canonical form of argsObj1
    await recordApproval("file_read", canonical1, "builtin", {
      scope: "session",
      sessionId: SESSION,
      verdictAtApproval: "low",
      nlJustification: null,
    });

    // Lookup using canonical form of argsObj2 — must hit
    const hit = await lookupApproval("file_read", canonical2, "builtin", undefined, undefined, undefined, SESSION);
    expect(hit).not.toBeNull();
  });
});

// Target-wide memory identity (v2) and rows written before it

describe("target-wide memory key as the remembered identity", () => {
  const policyKey = "web_fetch:web_fetch:host:a.example";
  const originMemory = (origin: string) => ({
    kind: "key" as const,
    key: `web_fetch:${origin}`,
    scope: { kind: "origin" as const, origin },
  });
  const atOrigin = (origin: string) => approvalCacheKeyIdentity(policyKey, originMemory(origin))!;
  const urlArgs = (url: string) => canonicalStringify({ url });
  const allow = { scope: "persistent" as const, verdictAtApproval: "low" as const, nlJustification: null, trustOrigin: "user-keyboard" };
  const A = "https://a.example:443";

  it("replaces the args, and records an args hash to tell exact hits from target-wide ones", async () => {
    await recordApproval("web_fetch", urlArgs("https://a.example/x"), "builtin", { ...allow, approvalCacheKey: atOrigin(A) });
    __resetSessionStoreForTest();
    const same = await lookupApproval("web_fetch", urlArgs("https://a.example/x"), "builtin", "user-keyboard", atOrigin(A), undefined, SESSION);
    const other = await lookupApproval("web_fetch", urlArgs("https://a.example/y"), "builtin", "user-keyboard", atOrigin(A), undefined, SESSION);
    expect(same && isExactArgsDecision(same, urlArgs("https://a.example/x"), "web_fetch")).toBe(true);
    expect(other && isExactArgsDecision(other, urlArgs("https://a.example/y"), "web_fetch")).toBe(false);
    expect(await lookupApproval("web_fetch", urlArgs("http://a.example/x"), "builtin", "user-keyboard", atOrigin("http://a.example:80"), undefined, SESSION)).toBeNull();
    expect(await lookupApproval("web_fetch", urlArgs("https://a.example:8443/x"), "builtin", "user-keyboard", atOrigin("https://a.example:8443"), undefined, SESSION)).toBeNull();
    const rows = Object.values((await readApprovals()).approvals);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ rememberBy: "key", argsIdentity: expect.stringMatching(/^[a-f0-9]{64}$/) });
    expect(JSON.stringify(rows)).not.toContain("a.example/x");
  });

  it("keeps trust origin, source and working directory separate under the memory key", async () => {
    const first = await mkdir(join(TEST_HOME, "wd-first"), { recursive: true }).then(() => join(TEST_HOME, "wd-first"));
    const second = await mkdir(join(TEST_HOME, "wd-second"), { recursive: true }).then(() => join(TEST_HOME, "wd-second"));
    await recordApproval("web_fetch", urlArgs("https://a.example/x"), "builtin", {
      ...allow, approvalCacheKey: atOrigin(A),
      workingDirectoryIdentity: captureApprovalWorkingDirectory(first).identity,
    });
    __resetSessionStoreForTest();
    const args = urlArgs("https://a.example/y");
    expect(await lookupApproval("web_fetch", args, "builtin", "user-keyboard", atOrigin(A), first, SESSION)).not.toBeNull();
    expect(await lookupApproval("web_fetch", args, "builtin", "user-keyboard", atOrigin(A), second, SESSION)).toBeNull();
    expect(await lookupApproval("web_fetch", args, "builtin", "llm-tool-arg", atOrigin(A), first, SESSION)).toBeNull();
    expect(await lookupApproval("web_fetch", args, "plugin", "user-keyboard", atOrigin(A), first, SESSION)).toBeNull();
  });

  it("a policy key without opted-in memory still requires identical input", async () => {
    const argsOnly = approvalCacheKeyIdentity("routine_schedule:scope:deny-all", { kind: "args" })!;
    await recordApproval("routine_schedule", '{"prompt":"a"}', "builtin", { ...allow, approvalCacheKey: argsOnly });
    expect(await lookupApproval("routine_schedule", '{"prompt":"a"}', "builtin", "user-keyboard", argsOnly, undefined, SESSION)).not.toBeNull();
    expect(await lookupApproval("routine_schedule", '{"prompt":"b"}', "builtin", "user-keyboard", argsOnly, undefined, SESSION)).toBeNull();
  });

  it("does not honour an allow written under the pre-v2 args+key formula", async () => {
    const legacy = approvalCacheKeyIdentity(policyKey, { kind: "args" })!;
    await recordApproval("web_fetch", urlArgs("https://a.example/x"), "builtin", { ...allow, approvalCacheKey: legacy });
    __resetSessionStoreForTest();
    expect(await lookupApproval("web_fetch", urlArgs("https://a.example/x"), "builtin", "user-keyboard", atOrigin(A), undefined, SESSION)).toBeNull();
  });

  it("keeps honouring an exact deny written under the pre-v2 args+key formula", async () => {
    const legacy = approvalCacheKeyIdentity(policyKey, { kind: "args" })!;
    await recordApproval("web_fetch", urlArgs("https://a.example/x"), "builtin", { ...allow, decision: "deny", approvalCacheKey: legacy });
    await recordApproval("web_fetch", urlArgs("https://a.example/other"), "builtin", { ...allow, approvalCacheKey: atOrigin(A) });
    __resetSessionStoreForTest();
    expect(await lookupUserDecision("web_fetch", urlArgs("https://a.example/x"), "builtin", "user-keyboard", atOrigin(A), undefined, SESSION))
      .toMatchObject({ decision: "deny" });
    expect(await lookupUserDecision("web_fetch", urlArgs("https://a.example/y"), "builtin", "user-keyboard", atOrigin(A), undefined, SESSION))
      .toMatchObject({ decision: "allow" });
  });

  it("refuses a policy key without a memory mode and an empty memory key", () => {
    expect(() => approvalCacheKeyIdentity(policyKey, undefined)).toThrow(/remembered-identity mode/);
    expect(() => approvalCacheKeyIdentity(policyKey, { kind: "key", key: "", scope: { kind: "origin", origin: A } })).toThrow(/non-empty/);
    expect(() => approvalCacheKeyIdentity("", { kind: "args" })).toThrow(/non-empty/);
    expect(approvalCacheKeyIdentity(undefined, { kind: "args" })).toBeUndefined();
    expect(approvalCacheKeyIdentity(undefined, undefined)).toBeUndefined();
    expect(approvalCacheKeyIdentity(undefined, originMemory(A))).toEqual({ memoryKey: `web_fetch:${A}` });
  });
});

// Owner decision 2026-10-25: "Always allow everywhere" for an exact tool approval is a user-global scope. A deny at any scope beats it, and Settings revokes it.
describe("global scope", () => {
  const ARGS = '{"path":"notes.md"}';
  async function projects(): Promise<[string, string]> {
    const a = join(TEST_HOME, "project-a");
    const b = join(TEST_HOME, "project-b");
    await mkdir(a, { recursive: true });
    await mkdir(b, { recursive: true });
    return [a, b];
  }
  const record = (scope: "persistent" | "global", decision: "allow" | "deny", cwd?: string) =>
    recordApproval("read_file", ARGS, "builtin", {
      decision, scope, verdictAtApproval: "medium", nlJustification: null,
      ...(cwd === undefined ? {} : { workingDirectoryIdentity: captureApprovalWorkingDirectory(cwd).identity, projectCwd: cwd }),
    });

  it("a global allow recorded in one project applies in another, and to no other input", async () => {
    const [a, b] = await projects();
    await recordApproval("read_file", ARGS, "builtin", {
      scope: "global", verdictAtApproval: "medium", nlJustification: null,
      workingDirectoryIdentity: captureApprovalWorkingDirectory(a).identity,
    });
    const hit = await lookupApproval("read_file", ARGS, "builtin", undefined, undefined, b);
    expect(hit?.scope).toBe("global");
    expect(await lookupApproval("read_file", '{"path":"other.md"}', "builtin", undefined, undefined, b)).toBeNull();
  });

  it("a project deny beats a global allow, and a global deny beats a project allow", async () => {
    const [a, b] = await projects();
    await record("global", "allow");
    await record("persistent", "deny", b);
    expect((await lookupUserDecision("read_file", ARGS, "builtin", undefined, undefined, b))?.decision).toBe("deny");
    expect((await lookupUserDecision("read_file", ARGS, "builtin", undefined, undefined, a))?.decision).toBe("allow");
    __resetSessionStoreForTest();
    await rm(TEST_HOME, { recursive: true, force: true });
    const [c] = await projects();
    await record("persistent", "allow", c);
    await record("global", "deny");
    expect((await lookupUserDecision("read_file", ARGS, "builtin", undefined, undefined, c))?.decision).toBe("deny");
  });

  it("a session allow does not hide a global deny", async () => {
    const [a] = await projects();
    await record("global", "deny");
    await recordApproval("read_file", ARGS, "builtin", {
      scope: "session", sessionId: SESSION, verdictAtApproval: "medium", nlJustification: null,
      workingDirectoryIdentity: captureApprovalWorkingDirectory(a).identity,
    });
    expect((await lookupUserDecision("read_file", ARGS, "builtin", undefined, undefined, a, SESSION))?.decision).toBe("deny");
  });

  it("is listed with its scope and no project, and revoking it ends it everywhere", async () => {
    const [, b] = await projects();
    await record("global", "allow");
    const rows = (await listApprovals()).filter((row) => row.scope === "global");
    expect(rows).toHaveLength(1);
    expect(rows[0]!.projectCwd).toBeUndefined();
    await revokeApprovalByKey(rows[0]!.key);
    expect(await lookupApproval("read_file", ARGS, "builtin", undefined, undefined, b)).toBeNull();
    __resetSessionStoreForTest();
    expect(await lookupApproval("read_file", ARGS, "builtin", undefined, undefined, b)).toBeNull();
  });

  it("refuses a project directory on a global approval", async () => {
    const [a] = await projects();
    await expect(recordApproval("read_file", ARGS, "builtin", {
      scope: "global", verdictAtApproval: "medium", nlJustification: null, projectCwd: a,
    })).rejects.toThrow("A global approval names no project");
  });
});

describe("shared builtin file-write path memory", () => {
  const pathMemory = (path: string, prefix = "file-write-path") => approvalCacheKeyIdentity(undefined, {
    kind: "key", key: `${prefix}:${canonicalStringify({ scope: { kind: "path", path }, executionPlan: null })}`,
    scope: { kind: "path", path },
  })!;
  const allow = {
    scope: "session" as const, sessionId: SESSION, verdictAtApproval: "low" as const,
    nlJustification: null, trustOrigin: "user-keyboard",
  };

  it.each(["write_file", "edit_file", "multi_edit", "apply_patch"])("reuses a path decision for %s with a different input", async (toolName) => {
    const memory = pathMemory(join(TEST_HOME, "target.txt"));
    await recordApproval("write_file", '{"content":"first"}', "builtin", { ...allow, approvalCacheKey: memory });
    const hit = await lookupApproval(toolName, '{"content":"next"}', "builtin", "user-keyboard", memory, undefined, SESSION);
    expect(hit).not.toBeNull();
    expect(isExactArgsDecision(hit!, '{"content":"next"}', toolName)).toBe(false);
  });

  it("keeps target, source, trust, conversation and unrelated tools separate", async () => {
    const memory = pathMemory(join(TEST_HOME, "target.txt"));
    await recordApproval("write_file", '{}', "builtin", { ...allow, approvalCacheKey: memory });
    expect(await lookupApproval("edit_file", '{}', "builtin", "user-keyboard", pathMemory(join(TEST_HOME, "other.txt")), undefined, SESSION)).toBeNull();
    expect(await lookupApproval("edit_file", '{}', "plugin", "user-keyboard", memory, undefined, SESSION)).toBeNull();
    expect(await lookupApproval("edit_file", '{}', "builtin", "llm-tool-arg", memory, undefined, SESSION)).toBeNull();
    expect(await lookupApproval("edit_file", '{}', "builtin", "user-keyboard", memory, undefined, "other-conversation")).toBeNull();
    expect(await lookupApproval("delete_file", '{}', "builtin", "user-keyboard", memory, undefined, SESSION)).toBeNull();
  });

  it("identical raw arguments across tools still require fresh risk review", async () => {
    const memory = pathMemory(join(TEST_HOME, "target.txt"));
    const args = '{"content":"next","oldText":"old","newText":"next"}';
    await recordApproval("write_file", args, "builtin", { ...allow, approvalCacheKey: memory });
    const hit = await lookupApproval("edit_file", args, "builtin", "user-keyboard", memory, undefined, SESSION);
    expect(hit).not.toBeNull();
    expect(isExactArgsDecision(hit!, args, "write_file")).toBe(true);
    expect(isExactArgsDecision(hit!, args, "edit_file")).toBe(false);
    const unnamed = { ...hit! };
    delete unnamed.toolName;
    expect(isExactArgsDecision(unnamed, args, "write_file")).toBe(false);
  });

  it("keeps per-project path decisions bound to their working directory", async () => {
    const first = join(TEST_HOME, "first");
    const second = join(TEST_HOME, "second");
    await mkdir(first);
    await mkdir(second);
    const memory = pathMemory(join(TEST_HOME, "target.txt"));
    await recordApproval("write_file", '{}', "builtin", {
      ...allow, approvalCacheKey: memory, workingDirectoryIdentity: captureApprovalWorkingDirectory(first).identity,
    });
    expect(await lookupApproval("apply_patch", '{}', "builtin", "user-keyboard", memory, first, SESSION)).not.toBeNull();
    expect(await lookupApproval("apply_patch", '{}', "builtin", "user-keyboard", memory, second, SESSION)).toBeNull();
  });

  it.each(["session", "persistent", "global"] as const)("preserves old per-tool path denies at %s scope", async (scope) => {
    const path = join(TEST_HOME, "target.txt");
    await recordApproval("edit_file", '{}', "builtin", {
      ...allow, scope, ...(scope === "session" ? { sessionId: SESSION } : { sessionId: undefined }),
      decision: "deny", approvalCacheKey: pathMemory(path, "edit_file"),
    });
    await recordApproval("write_file", '{}', "builtin", { ...allow, approvalCacheKey: pathMemory(path) });
    expect(await lookupUserDecision("edit_file", '{}', "builtin", "user-keyboard", pathMemory(path), undefined, SESSION)).toMatchObject({ decision: "deny" });
    expect(await lookupApproval("edit_file", '{}', "builtin", "user-keyboard", pathMemory(path), undefined, SESSION)).toBeNull();
  });

  it("does not widen an old per-tool path allow", async () => {
    const path = join(TEST_HOME, "target.txt");
    await recordApproval("write_file", '{}', "builtin", { ...allow, approvalCacheKey: pathMemory(path, "write_file") });
    expect(await lookupApproval("edit_file", '{}', "builtin", "user-keyboard", pathMemory(path), undefined, SESSION)).toBeNull();
  });

  it.each([
    ["session", "deny"], ["persistent", "deny"], ["global", "deny"],
    ["session", "allow"], ["persistent", "allow"], ["global", "allow"],
  ] as const)("preserves restrictive legacy patch args decisions at %s scope (%s)", async (scope, decision) => {
    const path = join(TEST_HOME, "target.txt");
    const args = canonicalStringify({ patch: `*** Begin Patch\n*** Add File: ${path}\n+next\n*** End Patch` });
    const policyKey = `apply_patch:${JSON.stringify({ operation: "apply_patch", paths: [path] })}`;
    await recordApproval("apply_patch", args, "builtin", {
      scope, decision, verdictAtApproval: "low", nlJustification: null, trustOrigin: "user-keyboard",
      ...(scope === "session" ? { sessionId: SESSION } : {}),
      ...(scope === "global" ? {} : { workingDirectoryIdentity: captureApprovalWorkingDirectory(TEST_HOME).identity }),
      approvalCacheKey: argsKey(policyKey),
    });
    const currentIdentity = { ...pathMemory(path), key: policyKey };
    const hit = await lookupUserDecision("apply_patch", args, "builtin", "user-keyboard", currentIdentity, TEST_HOME, SESSION);
    if (decision === "deny") expect(hit).toMatchObject({ decision: "deny" });
    else expect(hit).toBeNull();
  });
});
