import { mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { ApprovalGate, IPC_APPROVAL_REQUEST } from "../../permissions/approval-gate.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { getBuiltinShellSessionReadPolicy, getDefaultSensitiveReadDenyPaths, getDefaultSensitiveWriteDenyPaths } from "../../permissions/asrt-sandbox.js";
import { canonicalizePathForMatch, caseFoldForMatch, createConfiguredSessionReadPathMatcher, createPathCanonicalizer, createPermissionPathEvidence, getConfiguredSessionReadRoot, isConfiguredSessionReadPath, isSensitivePath } from "../../permissions/sensitive-paths.js";
import * as globMatcher from "../../lib/glob-matcher.js";
import { sessionStorePath } from "../../shared/session-store-path.js";
import { assertReadableFilePath } from "../file-read-core.js";
import { ensureFileAccess } from "../file-access-policy.js";
import { DeleteFileTool, GrepFilesTool, ListFilesTool, MoveFileTool, ReadFileTool, WriteFileTool } from "../file-tools.js";
import type { ToolExecutionContext } from "../types.js";

let root: string;
let profile: string;
let sessions: string;
let transcript: string;
let context: ToolExecutionContext;
const CONTENT = '{"role":"user","content":"saved-history-fixture"}\n';
const canonical = (path: string) => caseFoldForMatch(canonicalizePathForMatch(path));

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "session-read-access-")));
  profile = join(root, "configured-profile");
  sessions = sessionStorePath(profile);
  transcript = join(sessions, "conversation.jsonl");
  mkdirSync(sessions, { recursive: true });
  mkdirSync(join(root, "workspace"));
  writeFileSync(transcript, CONTENT);
  vi.stubEnv("AVE_HOME", profile);
  context = { cwd: join(root, "workspace"), extraAllowedDirectories: [], blockReadsOutsideWorkingDirectories: true, metadata: {} };
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await cleanupTmpDir(root);
});

describe("configured saved-session access", () => {
  it("reuses only fixed pattern compilation while rechecking each configured root", () => {
    expect(getConfiguredSessionReadRoot()).toBe(canonicalizePathForMatch(sessions));
    const compile = vi.spyOn(globMatcher, "compileGlobMatcher");
    try {
      vi.stubEnv("AVE_HOME", join(root, ".ssh"));
      expect(getConfiguredSessionReadRoot()).toBeUndefined();
      const changed = join(root, "another-profile");
      vi.stubEnv("AVE_HOME", changed);
      expect(getConfiguredSessionReadRoot()).toBe(canonicalizePathForMatch(sessionStorePath(changed)));
      expect(compile).not.toHaveBeenCalled();
    } finally { compile.mockRestore(); }
  });

  it("keeps platform case matching while reusing fixed credential patterns", () => {
    vi.stubEnv("AVE_HOME", join(root, ".SSH"));
    if (process.platform === "darwin" || process.platform === "win32") expect(getConfiguredSessionReadRoot()).toBeUndefined();
    else expect(getConfiguredSessionReadRoot()).toBe(canonicalizePathForMatch(sessionStorePath(join(root, ".SSH"))));
  });

  it("keeps read and write evidence separate while sharing root observations", () => {
    const evidence = createPermissionPathEvidence(context.cwd);
    const read = evidence({ lexical: transcript, canonical: canonical(transcript), effect: "read" });
    const write = evidence({ lexical: transcript, canonical: canonical(transcript), effect: "write" });
    expect(read.secret).toBeNull();
    expect(read.admissionDenial).toBeNull();
    expect(write.secret).not.toBeNull();
    expect(write.protectedControl).toBeDefined();
    const hostKey = join(profile, "keys", "host-key.json");
    expect(evidence({ lexical: hostKey, canonical: canonical(hostKey), effect: "read" }).admissionDenial).not.toBeNull();
  });

  it("refreshes session-root authority when a new decision observes a changed directory link", () => {
    const original = createConfiguredSessionReadPathMatcher(createPathCanonicalizer());
    expect(original(canonical(transcript))).toBe(true);
    renameSync(sessions, sessions + "-saved");
    symlinkSync(context.cwd, sessions, "junction");
    const canonicalize = createPathCanonicalizer();
    const fresh = createConfiguredSessionReadPathMatcher(canonicalize);
    expect(getConfiguredSessionReadRoot(canonicalize)).toBeUndefined();
    expect(fresh(canonical(transcript))).toBe(false);
    const evidence = createPermissionPathEvidence(context.cwd);
    expect(evidence({ lexical: transcript, canonical: canonical(transcript), effect: "read" }).secret).not.toBeNull();
  });

  it("reads and discovers real history through the public file surfaces outside the project", async () => {
    expect(getConfiguredSessionReadRoot()).toBe(canonicalizePathForMatch(sessions));
    expect(ensureFileAccess(transcript, context, "read")).toBeNull();
    expect(assertReadableFilePath(transcript, context.cwd, [])).toEqual({ ok: true, resolved: transcript });
    const read = await new ReadFileTool().execute({ path: transcript }, context);
    expect(read.isError, read.output).toBe(false);
    expect(read.output).toContain("saved-history-fixture");
    const listed = await new ListFilesTool().execute({ path: sessions }, context);
    expect(listed.isError, listed.output).toBe(false);
    expect(listed.output).toContain("conversation.jsonl");
    const searched = await new GrepFilesTool().execute({ path: sessions, pattern: "saved-history-fixture" }, context);
    expect(searched.isError, searched.output).toBe(false);
    expect(searched.output).toContain("conversation.jsonl");
  });

  it("protects writes, deletion and moves even with an encompassing directory grant", async () => {
    const broad = { ...context, extraAllowedDirectories: [root] };
    const registry = new ToolRegistry();
    for (const tool of [new WriteFileTool(), new DeleteFileTool(), new MoveFileTool()]) registry.register(tool);
    const manager = new PermissionManager(join(root, "permissions.json"));
    manager.setMode("allow");
    const executor = new ToolExecutor(registry, undefined, manager);
    const results = await executor.executeAll([
      { id: "replace", name: "write_file", input: { path: transcript, content: "changed" } },
      { id: "new", name: "write_file", input: { path: join(sessions, "new.jsonl"), content: "changed" } },
      { id: "delete", name: "delete_file", input: { path: transcript } },
      { id: "move", name: "move_file", input: { sourcePath: transcript, destinationPath: join(context.cwd, "moved.jsonl") } },
    ], { executionCwd: broad.cwd, sessionId: "saved-history", permissionContext: { trustOrigin: "user-keyboard", headless: true, additionalDirectories: broad.extraAllowedDirectories } });
    for (const result of results) {
      expect(result.is_error).toBe(true);
      expect(result.content).toContain("Nobody can approve this request; do not retry.");
    }
    expect(readFileSync(transcript, "utf8")).toBe(CONTENT);
    // Windows directory rows keep their separator for srt-win.
    const sessionsRow = sessions + (process.platform === "win32" ? sep : "");
    expect(getDefaultSensitiveReadDenyPaths()).toContain(sessionsRow);
    expect(getBuiltinShellSessionReadPolicy().denyRead).not.toContain(sessionsRow);
    expect(getDefaultSensitiveWriteDenyPaths()).toContain(sessionsRow);
    expect(isSensitivePath(canonical(transcript))).not.toBeNull();
  });

  it.each(["secrets", "audit", "routine", "subscription-runtimes"])("separates %s credential admission from ordinary file reads", async (namespace) => {
    const target = join(profile, namespace, "record.jsonl");
    mkdirSync(join(profile, namespace)); writeFileSync(target, "private-store-fixture");
    const result = await new ReadFileTool().execute({ path: target }, { ...context, extraAllowedDirectories: [root] });
    if (namespace === "secrets" || namespace === "subscription-runtimes") {
      expect(result.output).toContain("Sensitive path:");
      expect(result.output).not.toContain("private-store-fixture");
    } else {
      expect(result.isError).toBe(false);
      expect(result.output).toContain("private-store-fixture");
    }
    expect(isConfiguredSessionReadPath(canonical(target))).toBe(false);
  });

  it("does not extend the read grant to sibling, copied or isolated session roots", () => {
    for (const path of [join(profile, "ordinary"), join(root, "copy", ".ave", "sessions", "other.jsonl"), join(profile, "side-chat", "sessions", "other.jsonl"), join(profile, "subagent", "sessions", "other.jsonl")]) {
      expect(isConfiguredSessionReadPath(canonical(path))).toBe(false);
      expect(ensureFileAccess(path, context, "read")?.isError).toBe(true);
    }
  });

  it("keeps secret-read classification and host credential admission distinct inside saved history", () => {
    const target = join(sessions, ".ssh", "id_rsa");
    mkdirSync(join(sessions, ".ssh")); writeFileSync(target, "inert-credential-fixture");
    expect(isSensitivePath(canonical(target), "read")).not.toBeNull();
    expect(ensureFileAccess(target, context, "read")).toBeNull();
    const manager = new PermissionManager(join(root, "permissions.json"));
    expect(manager.checkDetailed("read_file", "builtin", "read", undefined, { paths: [{ lexical: target, canonical: target, effect: "read" }] })).toMatchObject({ decision: "ask", reasonCode: "secret-read" });
    const hostCredential = join(sessions, ".ave", "secrets", "token.json");
    expect(ensureFileAccess(hostCredential, context, "read")).toMatchObject({ isError: true });
    const copiedStore = join(sessions, "copy", ".ave", "sessions", "other.jsonl");
    mkdirSync(join(sessions, "copy", ".ave", "sessions"), { recursive: true });
    writeFileSync(copiedStore, "copied-store-fixture");
    expect(ensureFileAccess(copiedStore, context, "read")).toBeNull();
    expect(manager.checkDetailed("read_file", "builtin", "read", undefined, { paths: [{ lexical: copiedStore, canonical: copiedStore, effect: "read" }] })).toMatchObject({ decision: "ask", reasonCode: "secret-read" });
  });

  it.skipIf(process.platform === "win32")("accepts a relocated application root but rejects escaping session links", () => {
    const alias = join(root, "profile-alias");
    symlinkSync(profile, alias);
    vi.stubEnv("AVE_HOME", alias);
    expect(getConfiguredSessionReadRoot()).toBe(sessions);
    expect(ensureFileAccess(join(alias, "sessions", "conversation.jsonl"), context, "read")).toBeNull();
    const outside = join(root, "outside.jsonl"); writeFileSync(outside, "outside-fixture");
    symlinkSync(outside, join(sessions, "escape.jsonl"));
    expect(ensureFileAccess(join(sessions, "escape.jsonl"), context, "read")?.isError).toBe(true);
    expect(assertReadableFilePath(join(sessions, "escape.jsonl"), context.cwd, []).ok).toBe(false);
    const other = join(root, "other-profile"); mkdirSync(other);
    symlinkSync(sessions, join(other, "sessions")); vi.stubEnv("AVE_HOME", other);
    expect(getConfiguredSessionReadRoot()).toBeUndefined();
    expect(isSensitivePath(canonical(transcript), "read")).not.toBeNull();
  });

  it("does not turn a credential-contained or pattern-containing root into a native grant", () => {
    for (const unsafe of [join(root, ".ssh"), join(root, "profile[other]")]) {
      vi.stubEnv("AVE_HOME", unsafe);
      expect(getConfiguredSessionReadRoot()).toBeUndefined();
    }
  });

  it("passes the same read effect through permission and approval gates", async () => {
    const canonicalTargets = [{ filePath: transcript, canonicalPath: canonical(transcript) }];
    const common = { canonicalTargets, allowedDirectories: [canonical(context.cwd)], blockReadsOutsideWorkingDirectories: true };
    expect(PermissionManager.checkPathScope({ ...common, effect: "read" })).toMatchObject({ sensitiveHit: null, outOfAllowed: null });
    expect(PermissionManager.checkPathScope({ ...common, effect: "write" })).toMatchObject({ sensitiveHit: null, outOfAllowed: expect.anything() });
    const manager = new PermissionManager(join(root, "permissions.json"));
    manager.setMode("allow");
    expect(manager.checkDetailed("write_file", "builtin", "write", undefined, { paths: [{ lexical: transcript, canonical: transcript, effect: "write" }] })).toMatchObject({ decision: "ask", forceModal: true, reasonCode: "protected-path" });
    const send = vi.fn();
    const gate = new ApprovalGate({ send, isDestroyed: () => false } as never, undefined, 200);
    const request = { id: "session-read", category: "tool" as const, toolName: "read_file", source: "builtin" as const, args: { path: transcript }, reason: "Read saved conversation", createdAt: Date.now(), target: { filePath: transcript } };
    expect((await gate.requestAndWait(request)).choice).toBe("deny-once");
    expect((await gate.requestAndWait({ ...request, id: "session-write" })).choice).toBe("deny-once");
    expect((await gate.requestAndWait({ ...request, id: "session-directory-grant", kind: "out-of-allowed-dir" })).choice).toBe("deny-once");
    expect(send.mock.calls.filter(([channel]) => channel === IPC_APPROVAL_REQUEST)).toHaveLength(3);
    expect(gate.pendingCount).toBe(0);
  });
});
