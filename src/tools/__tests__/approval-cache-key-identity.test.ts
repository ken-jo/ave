import { setReviewerForTest, wireJudgeForTest } from "../../__tests__/support/reviewer-judge.js";
/** Opted-in approval memory follows target scope; new arguments still need a fresh review no riskier than the stored verdict.
 * Unscoped tools keep exact-argument memory, and recorded identity comes only from the host pending snapshot. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { AuditLogger } from "../../audit/audit-logger.js";
import { ApprovalGate, type ApprovalRequest } from "../../permissions/approval-gate.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { makeRecentlyDeniedStore } from "../../__tests__/support/recently-denied.js";
import { RuleBasedRiskClassifier, type ToolInvocationContext } from "../../permissions/reviewer/risk-classifier.js";
import { VerdictCache } from "../../permissions/reviewer/verdict-cache.js";
import {
  __resetSessionStoreForTest,
  approvalCacheKeyIdentity,
  canonicalStringify,
  captureApprovalWorkingDirectory,
  recordApproval,
} from "../../permissions/user-approval-store.js";
import { ToolUnavailableError, type ToolTrustOrigin } from "../types.js";
import type { Tool } from "../base.js";
import { createDynamicTool } from "../base.js";
import { ToolExecutor } from "../executor.js";
import { ApplyPatchTool, DeleteFileTool, EditFileTool, MoveFileTool, MultiEditTool, ReadFileTool, WriteFileTool } from "../file-tools.js";
import { approvalIdentityFor } from "../pipeline/display-mask.js";
import { ToolRegistry } from "../registry.js";
import { createRoutineScheduleTool } from "../routine-schedule.js";
import { createWebFetchTool } from "../web-fetch.js";
import { userPermissionContext } from "./tool-context-fixture.js";
import { t } from "../../i18n/index.js";

type CardAnswer = "allow-once" | "allow-session" | "deny-exact";

describe("remembered decisions keyed on the tool's opted-in memory scope", () => {
  let dir: string;
  let aveHomeDir: string;
  let prevAveHome: string | undefined;
  let auditLogger: AuditLogger;
  let reviewerCache: VerdictCache | undefined;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ave-memory-scope-"));
    aveHomeDir = mkdtempSync(join(tmpdir(), "ave-home-memory-scope-"));
    prevAveHome = process.env.AVE_HOME;
    process.env.AVE_HOME = aveHomeDir;
    __resetSessionStoreForTest();
    auditLogger = new AuditLogger(join(aveHomeDir, "audit"));
  });

  afterEach(async () => {
    await auditLogger.close();
    await reviewerCache?.flush();
    reviewerCache = undefined;
    if (prevAveHome === undefined) delete process.env.AVE_HOME;
    else process.env.AVE_HOME = prevAveHome;
    __resetSessionStoreForTest();
    await cleanupTmpDir(dir);
    await cleanupTmpDir(aveHomeDir);
  });

  /** One executor with a rule-based reviewer whose approval cards are answered like the desktop card:
   * persisted from the gate snapshot under the same eligibility gate as the record IPC, then resolved. */
  function harness(
    tools: Tool[],
    answer: () => CardAnswer = () => "allow-session",
    options: { reviewer?: boolean } = {},
  ) {
    const registry = new ToolRegistry();
    for (const tool of tools) registry.register(tool);
    const manager = new PermissionManager(join(dir, "permissions.json"));
    // These tests need an actual human grant before examining its later identity.
    // The conservative mode asks even when a recoverable project write is eligible.
    manager.setMode("strict");
    const rules = new RuleBasedRiskClassifier();
    const classify = vi.fn((ctx: ToolInvocationContext) => rules.classify(ctx));
    if (options.reviewer === false) {
      wireJudgeForTest(manager);
      // No reviewer: every card is an unassessed ask, which may be remembered exactly; the lane a tool without a memory scope always uses.
    } else {
      // Fresh target-wide inputs still use this reviewer before reusing consent.
      reviewerCache = new VerdictCache(join(aveHomeDir, "reviewer-cache.jsonl"));
      setReviewerForTest(manager, {
        classifier: { classify },
        cache: reviewerCache,
        recentlyDenied: makeRecentlyDeniedStore(join(aveHomeDir, "deferred.jsonl")),
      });
    }
    const cards: ApprovalRequest[] = [];
    const recordings: Promise<void>[] = [];
    const nativeWebContents = {
      isDestroyed: () => false,
      send: (channel: string, request: ApprovalRequest) => {
        if (channel !== "ave:approval:request") return;
        cards.push(request);
        recordings.push((async () => {
          const snapshot = gate.getRequestSnapshot(request.id)!;
          const choice = answer();
          const remember = choice === "deny-exact" || (choice === "allow-session" && snapshot.persistentAllowAllowed);
          if (remember) await recordApproval(snapshot.toolName, canonicalStringify(snapshot.args), snapshot.source, {
            decision: choice === "deny-exact" ? "deny" : "allow",
            scope: choice === "deny-exact" ? "persistent" : "session",
            // As the record handler does: a session allow is the root conversation's.
            ...(choice === "deny-exact" ? {} : { sessionId: snapshot.sessionId }),
            verdictAtApproval: snapshot.verdictAtApproval,
            nlJustification: null,
            trustOrigin: snapshot.trustOrigin,
            approvalCacheKey: approvalCacheKeyIdentity(snapshot.approvalCacheKey, snapshot.approvalMemory),
            ...(choice === "deny-exact" ? {} : {
              workingDirectoryIdentity: snapshot.workingDirectoryIdentity,
              riskCeilingAtApproval: snapshot.riskCeilingAtApproval,
            }),
          });
          gate.resolveFromDesktopRenderer(request.id, {
            requestId: request.id,
            choice: choice === "deny-exact" ? "deny-once" : "allow-once",
            nonce: request.nonce,
            hmac: request.hmac,
          }, nativeWebContents as never);
        })());
      },
    };
    const gate = new ApprovalGate(nativeWebContents as never);
    const approvalInputs = vi.spyOn(gate, "requestAndWait");
    const executor = new ToolExecutor(registry, undefined, manager, undefined, gate, undefined, auditLogger);
    let seq = 0;
    const run = async (
      name: string,
      input: Record<string, unknown>,
      trustOrigin: ToolTrustOrigin = "user-keyboard",
    ) => {
      const [result] = await executor.executeAll(
        [{ id: `call-${seq += 1}`, name, input }],
        {
          sessionId: "memory-scope",
          executionCwd: dir,
          permissionContext: userPermissionContext({ trustOrigin, additionalDirectories: [dir] }),
        },
      );
      await Promise.all(recordings);
      return result;
    };
    const reviewedUrls = () => classify.mock.calls.map(([ctx]) => (ctx.finalInput as { url?: string }).url);
    const reviewedTools = () => classify.mock.calls.map(([ctx]) => ctx.toolName);
    return { cards, run, reviewedUrls, reviewedTools, approvalInputs, manager };
  }

  /** The real web_fetch identity (keys + schema), with the network stubbed out. */
  function webFetch(execute = vi.fn(async () => ({ output: "ok", isError: false }))) {
    const real = createWebFetchTool(vi.fn() as unknown as typeof fetch);
    const execution = vi.spyOn(real, "execute").mockImplementation(execute);
    return { tool: real, execute: execution };
  }

  it("shares one path memory identity across native text write tools", async () => {
    const path = join(dir, "shared.txt");
    const calls: Array<[Tool, Record<string, unknown>]> = [
      [new WriteFileTool(), { path, content: "next" }],
      [new EditFileTool(), { path, oldText: "old", newText: "next" }],
      [new MultiEditTool(), { path, replacements: [{ oldText: "old", newText: "next" }] }],
      [new ApplyPatchTool(), { patch: `*** Begin Patch\n*** Add File: ${path}\n+next\n*** End Patch` }],
    ];
    const identities = await Promise.all(calls.map(([tool, input]) => approvalIdentityFor(tool, input, dir)));
    expect(identities[0].approvalMemory.kind).toBe("key");
    for (const identity of identities) expect(identity.approvalMemory).toEqual(identities[0].approvalMemory);
    const other = await approvalIdentityFor(new WriteFileTool(), { path: join(dir, "other.txt"), content: "next" }, dir);
    expect(other.approvalMemory).not.toEqual(identities[0].approvalMemory);
  });

  it("uses a session path approval across native text write tools after fresh risk review", async () => {
    const tools = [new WriteFileTool(), new EditFileTool(), new MultiEditTool(), new ApplyPatchTool()];
    const executed = tools.map((tool) => vi.spyOn(tool, "execute").mockResolvedValue({ output: "ok", isError: false }));
    const { cards, run } = harness(tools);
    const path = join(dir, "shared.txt");
    await run("write_file", { path, content: "first" });
    expect(cards).toHaveLength(1);
    expect(cards[0].approvalMemory).toMatchObject({ kind: "key", scope: { kind: "path" } });
    expect((await run("edit_file", { path, oldText: "first", newText: "second" })).is_error).toBeUndefined();
    expect((await run("multi_edit", { path, replacements: [{ oldText: "second", newText: "third" }] })).is_error).toBeUndefined();
    expect((await run("apply_patch", { patch: `*** Begin Patch\n*** Add File: ${path}\n+fourth\n*** End Patch` })).is_error).toBeUndefined();
    expect(cards).toHaveLength(1);
    for (const execute of executed) expect(execute).toHaveBeenCalledTimes(1);
    await run("apply_patch", { patch: `*** Begin Patch\n*** Add File: ${path}\n+fifth\n*** End Patch` });
    expect(cards).toHaveLength(1);
    await run("write_file", { path: join(dir, "other.txt"), content: "other" });
    expect(cards).toHaveLength(2);
  });

  it("freshly reviews a different text write tool even when its raw arguments are identical", async () => {
    const write = new WriteFileTool();
    const edit = new EditFileTool();
    vi.spyOn(write, "execute").mockResolvedValue({ output: "ok", isError: false });
    const edited = vi.spyOn(edit, "execute").mockResolvedValue({ output: "ok", isError: false });
    const { cards, run, reviewedTools } = harness([write, edit]);
    const input = { path: join(dir, "shared.txt"), content: "first", oldText: "first", newText: "second" };
    await run("write_file", input);
    expect(cards).toHaveLength(1);
    await run("edit_file", input);
    expect(cards).toHaveLength(1);
    expect(edited).toHaveBeenCalledTimes(1);
    expect(reviewedTools()).toContain("edit_file");
  });

  it("does not reuse a session edit approval for a delete patch of the same home file", async () => {
    const edit = new EditFileTool();
    const patch = new ApplyPatchTool();
    vi.spyOn(edit, "execute").mockResolvedValue({ output: "ok", isError: false });
    vi.spyOn(patch, "execute").mockResolvedValue({ output: "ok", isError: false });
    const { cards, run } = harness([edit, patch]);
    await run("edit_file", { path: "~/notes.txt", oldText: "old", newText: "next" });
    expect(cards).toHaveLength(1);
    await run("apply_patch", { patch: "*** Begin Patch\n*** Delete File: ~/notes.txt\n*** End Patch" });
    expect(cards).toHaveLength(2);
    expect(cards[1].approvalMemory).toMatchObject({ kind: "key", scope: { kind: "paths" } });
  });

  it("partitions delete patches from update patches with the same touched path set", async () => {
    const tool = new ApplyPatchTool();
    const update = "*** Begin Patch\n*** Update File: a.txt\n@@\n-old\n+new\n*** Update File: b.txt\n@@\n-old\n+new\n*** End Patch";
    const deletion = "*** Begin Patch\n*** Delete File: a.txt\n*** Delete File: b.txt\n*** End Patch";
    const editIdentity = await approvalIdentityFor(tool, { patch: update }, dir);
    const deleteIdentity = await approvalIdentityFor(tool, { patch: deletion }, dir);
    expect(deleteIdentity.approvalMemory).not.toEqual(editIdentity.approvalMemory);
  });

  it("remembers a browser origin independently of the invocation's concrete tab and document", async () => {
    let tabId = "tab-1";
    let documentId = 1;
    const tool = createDynamicTool({
      name: "browser_click",
      description: "Acts on the approved page",
      source: "builtin",
      category: "write",
      jsonSchema: { type: "object" },
      approvalMemoryScope: () => Object.assign({ kind: "browser-origin" as const, origin: "https://a.example:443", tabOpener: "agent" as const }, { tabId, documentId }),
      execute: async () => ({ output: "ok", isError: false }),
    });
    const first = (await approvalIdentityFor(tool, {}, dir)).approvalMemory;
    tabId = "tab-2";
    documentId = 9;
    const second = (await approvalIdentityFor(tool, {}, dir)).approvalMemory;
    expect(first.kind).toBe("key");
    expect(second.kind).toBe("key");
    if (first.kind !== "key" || second.kind !== "key") throw new Error("Expected scoped approval identity");
    expect(second.key).toBe(first.key);
    expect(first.scope).toMatchObject({ tabId: "tab-1", documentId: 1 });
    expect(second.scope).toMatchObject({ tabId: "tab-2", documentId: 9 });
  });

  it("allow-session on one URL covers the same origin after a fresh review, not another host", async () => {
    const { tool, execute } = webFetch();
    const { cards, run, reviewedUrls } = harness([tool]);

    await run("web_fetch", { url: "https://a.example/x" });
    expect(cards).toHaveLength(1);
    expect(cards[0].approvalMemory).toMatchObject({ kind: "key", scope: { kind: "origin", origin: "https://a.example:443" } });

    await run("web_fetch", { url: "https://a.example:443/y?page=2" });
    expect(cards).toHaveLength(1);
    // The new arguments went through the reviewer before the grant was reused.
    expect(reviewedUrls()).toContain("https://a.example:443/y?page=2");

    await run("web_fetch", { url: "https://b.example/" });
    expect(cards).toHaveLength(2);
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["another scheme", "http://a.example/x"],
    ["another port", "https://a.example:8443/x"],
  ])("an origin approval does not cover %s", async (_label, url) => {
    const { tool } = webFetch();
    const { cards, run } = harness([tool]);
    await run("web_fetch", { url: "https://a.example/x" });
    await run("web_fetch", { url });
    expect(cards).toHaveLength(2);
  });

  it("uses a normal card when an exfiltration assessment exceeds the origin approval", async () => {
    const { tool, execute } = webFetch();
    const { cards, run, approvalInputs } = harness([tool]);
    await run("web_fetch", { url: "https://a.example/x" });
    await run("web_fetch", { url: "https://a.example/x?token=sk-live-0123456789abcdefghijklmnop" });
    expect(cards).toHaveLength(2);
    expect(cards[1].allowedChoices).toBeUndefined();
    expect(approvalInputs.mock.calls[1]![0].forceExplicit).not.toBe(true);
    expect(cards[1].reason).toContain("exfiltration");
    await run("web_fetch", { url: "https://a.example/x?token=sk-live-0123456789abcdefghijklmnop" });
    expect(cards).toHaveLength(2);
    expect(execute).toHaveBeenCalledTimes(3);
  });

  describe("without a configured reviewer", () => {
    it("reuses a rules-only origin approval for a benign new path after the rule check", async () => {
      const { tool, execute } = webFetch();
      const { cards, run } = harness([tool], undefined, { reviewer: false });
      await run("web_fetch", { url: "https://a.example/x" });
      expect(cards).toHaveLength(1);
      // An unreviewed prompt must not invent a completed reviewer assessment.
      expect(cards[0].reviewerVerdict).toBeUndefined();
      await run("web_fetch", { url: "https://a.example/docs/y" });
      expect(cards).toHaveLength(1);
      expect(execute).toHaveBeenCalledTimes(2);
    });

    it("asks again when the new query escalates under the rules", async () => {
      const { tool } = webFetch();
      const { cards, run, approvalInputs } = harness([tool], undefined, { reviewer: false });
      await run("web_fetch", { url: "https://a.example/x" });
      await run("web_fetch", { url: "https://a.example/x?token=sk-live-0123456789abcdefghijklmnop" });
      expect(cards).toHaveLength(2);
      expect(approvalInputs.mock.calls[1]![0].forceExplicit).not.toBe(true);
      expect(cards[1].allowedChoices).toBeUndefined();
    });

    it("asks for a row approved under a reviewer, which the rules alone cannot re-check", async () => {
      const { tool } = webFetch();
      const approved = { url: "https://a.example/x" };
      const identity = await approvalIdentityFor(tool, approved, dir);
      // A reviewer-assessed row: a verdict, no rules-only ceiling.
      await recordApproval("web_fetch", canonicalStringify(approved), "builtin", {
        scope: "session",
        sessionId: "memory-scope",
        verdictAtApproval: "low",
        nlJustification: null,
        trustOrigin: "user-keyboard",
        approvalCacheKey: approvalCacheKeyIdentity(identity.approvalCacheKey, identity.approvalMemory),
        workingDirectoryIdentity: captureApprovalWorkingDirectory(dir).identity,
      });
      // A one-shot answer to the new input leaves the original remembered row intact.
      const { cards, run } = harness([tool], () => "allow-once", { reviewer: false });
      await run("web_fetch", { url: "https://a.example/y" });
      expect(cards).toHaveLength(1);
      // The exact approved request is still its own decision.
      await run("web_fetch", approved);
      expect(cards).toHaveLength(1);
    });
  });

  it("a private-network fetch is remembered by exact URL only", async () => {
    const { tool } = webFetch();
    const privateInput = { url: "http://localhost:3000/a", allowPrivateNetwork: true };
    expect((await approvalIdentityFor(tool, privateInput, dir)).approvalMemory).toEqual({ kind: "args" });
    const { cards, run } = harness([tool]);
    await run("web_fetch", privateInput);
    await run("web_fetch", { url: "http://localhost:3000/b", allowPrivateNetwork: true });
    await run("web_fetch", { url: "http://localhost:3001/a", allowPrivateNetwork: true });
    expect(cards).toHaveLength(3);
    expect(cards.every((card) => card.approvalMemory?.kind === "args")).toBe(true);
  });

  it("an approval from one trust origin is never inherited by another", async () => {
    const { tool } = webFetch();
    const { cards, run } = harness([tool]);
    await run("web_fetch", { url: "https://a.example/x" }, "user-keyboard");
    await run("web_fetch", { url: "https://a.example/y" }, "llm-tool-arg");
    expect(cards).toHaveLength(2);
  });

  it("an exact deny applies across the whole origin and nowhere else", async () => {
    const { tool, execute } = webFetch();
    const { cards, run } = harness([tool], () => "deny-exact");
    expect((await run("web_fetch", { url: "https://a.example/x" })).is_error).toBe(true);
    expect((await run("web_fetch", { url: "https://a.example/other" })).is_error).toBe(true);
    expect(cards).toHaveLength(1);
    await run("web_fetch", { url: "https://b.example/" });
    expect(cards).toHaveLength(2);
    expect(execute).not.toHaveBeenCalled();
  });

  it("a path approval covers repeat writes of that path, not another path or a delete", async () => {
    const { cards, run } = harness([new WriteFileTool(), new DeleteFileTool()]);
    const target = join(dir, "notes.md");
    expect((await run("write_file", { path: target, content: "one" })).is_error).toBeUndefined();
    expect((await run("write_file", { path: target, content: "two" })).is_error).toBeUndefined();
    expect(cards).toHaveLength(1);
    expect(cards[0].approvalMemory).toMatchObject({ kind: "key", scope: { kind: "path", path: target } });
    await run("write_file", { path: join(dir, "other.md"), content: "one" });
    expect(cards).toHaveLength(2);
    await run("delete_file", { path: target });
    expect(cards).toHaveLength(3);
    expect(cards[2].toolName).toBe("delete_file");
  });

  it("a move approval without overwrite never covers a move that overwrites", async () => {
    writeFileSync(join(dir, "a.txt"), "a");
    const { cards, run } = harness([new MoveFileTool()]);
    const move = { sourcePath: join(dir, "a.txt"), destinationPath: join(dir, "b.txt") };
    await run("move_file", move);
    expect(cards[0].approvalMemory).toMatchObject({ scope: { kind: "transfer", overwrite: false } });
    await run("move_file", { ...move, overwrite: true });
    expect(cards).toHaveLength(2);
    expect(cards[1].approvalMemory).toMatchObject({ scope: { kind: "transfer", overwrite: true } });
  });

  it("a read approval of a path never answers for a write to it", async () => {
    const target = join(dir, "notes.md");
    writeFileSync(target, "content");
    const read = new ReadFileTool();
    expect((await approvalIdentityFor(read, { path: target }, dir)).approvalMemory).toEqual({ kind: "args" });
    await recordApproval("read_file", canonicalStringify({ path: target }), "builtin", {
      scope: "session", sessionId: "memory-scope", verdictAtApproval: "low", nlJustification: null, trustOrigin: "user-keyboard",
    });
    const { cards, run } = harness([read, new WriteFileTool()]);
    await run("write_file", { path: target, content: "changed" });
    expect(cards).toHaveLength(1);
    expect(cards[0].toolName).toBe("write_file");
  });

  it("a tool without a memory scope keeps exact-args matching", async () => {
    const execute = vi.fn(async () => ({ output: "ok", isError: false }));
    const probe = createDynamicTool({
      name: "shell_probe", description: "probe", source: "builtin", category: "shell",
      jsonSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
      execute,
    });
    const { cards, run } = harness([probe], undefined, { reviewer: false });
    await run("shell_probe", { target: "a" });
    await run("shell_probe", { target: "a" });
    expect(cards).toHaveLength(1);
    await run("shell_probe", { target: "b" });
    expect(cards).toHaveLength(2);
    expect(cards[0].approvalMemory).toEqual({ kind: "args" });
  });

  it("names a tool that cannot run here as unavailable, not as bad input, and offers no rerun of it", async () => {
    const execute = vi.fn(async () => ({ output: "ok", isError: false }));
    const probe = (name: string, failure: Error) => createDynamicTool({
      name, description: "probe", source: "builtin", category: "shell",
      jsonSchema: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      approvalMemoryScope: () => { throw failure; },
      execute,
    });
    const { cards, run, manager } = harness([
      probe("unavailable_probe", new ToolUnavailableError("Terminal requires the OS tool sandbox")),
      probe("bad_input_probe", new Error("command must not be empty")),
    ]);
    const unavailable = await run("unavailable_probe", { command: "Get-Location" });
    expect(unavailable).toMatchObject({ is_error: true });
    expect(unavailable.content).toBe(t("be_executor.toolUnavailable", { name: "unavailable_probe", error: "Terminal requires the OS tool sandbox" }));
    const badInput = await run("bad_input_probe", { command: "" });
    expect(badInput.content).toBe(t("be_executor.invalidToolInput", { name: "bad_input_probe", error: "command must not be empty" }));
    expect(execute).not.toHaveBeenCalled();
    expect(cards).toHaveLength(0);
    expect(await manager.getRecentlyDenied()!.list()).toEqual([]);
  });

  it("declaring only a policy approvalCacheKey never widens memory", async () => {
    const tool = createRoutineScheduleTool({} as never);
    expect(await approvalIdentityFor(tool, { execution: "notification-only", schedule: {} }, dir)).toEqual({
      approvalCacheKey: "routine_schedule:scope:deny-all",
      approvalMemory: { kind: "args" },
    });
  });
});
