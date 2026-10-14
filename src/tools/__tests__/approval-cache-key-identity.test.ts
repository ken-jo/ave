/**
 * Remembered decisions follow the tool's approval cache key, not its args.
 *
 * When a tool declares `approvalCacheKey` and the key is a complete consent
 * identity, Store B records and looks up a decision under that key INSTEAD of
 * the canonical input: "allow for this session" on web_fetch covers the
 * destination host, a write approval covers its target path. Tools without a
 * key, and tools whose key is only a policy scope, stay on exact-args
 * identity. Trust origin, source and working directory stay in every key.
 *
 * Drives the real ToolExecutor + PermissionManager + ApprovalGate + store,
 * recording each decision the way the `userApprovalRecord` IPC does: from the
 * gate's host-owned request snapshot.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { AuditLogger } from "../../audit/audit-logger.js";
import { ApprovalGate, type ApprovalRequest } from "../../permissions/approval-gate.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import {
  __resetSessionStoreForTest,
  approvalCacheKeyIdentity,
  canonicalStringify,
  recordApproval,
} from "../../permissions/user-approval-store.js";
import type { ToolTrustOrigin } from "../types.js";
import type { Tool } from "../base.js";
import { createDynamicTool } from "../base.js";
import { ToolExecutor } from "../executor.js";
import { ReadFileTool, WriteFileTool } from "../file-tools.js";
import { approvalIdentityFor } from "../pipeline/display-mask.js";
import { ToolRegistry } from "../registry.js";
import { createRoutineScheduleTool } from "../routine-schedule.js";
import { createWebFetchTool } from "../web-fetch.js";
import { userPermissionContext } from "./tool-context-fixture.js";

type CardAnswer = "allow-session" | "deny-exact";

describe("remembered decisions keyed on the tool's approval cache key", () => {
  let dir: string;
  let aveHomeDir: string;
  let prevAveHome: string | undefined;
  let auditLogger: AuditLogger;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ave-cache-key-identity-"));
    aveHomeDir = mkdtempSync(join(tmpdir(), "ave-home-cache-key-identity-"));
    prevAveHome = process.env.AVE_HOME;
    process.env.AVE_HOME = aveHomeDir;
    __resetSessionStoreForTest();
    auditLogger = new AuditLogger(join(aveHomeDir, "audit"));
  });

  afterEach(async () => {
    await auditLogger.close();
    if (prevAveHome === undefined) delete process.env.AVE_HOME;
    else process.env.AVE_HOME = prevAveHome;
    __resetSessionStoreForTest();
    await cleanupTmpDir(dir);
    await cleanupTmpDir(aveHomeDir);
  });

  /**
   * One executor whose approval cards are answered like the desktop card:
   * the decision is persisted from the gate snapshot (as the record IPC
   * does), then the card resolves.
   */
  function harness(tools: Tool[], answer: () => CardAnswer = () => "allow-session") {
    const registry = new ToolRegistry();
    for (const tool of tools) registry.register(tool);
    const manager = new PermissionManager(join(dir, "permissions.json"));
    manager.setMode("auto");
    manager.setInteractiveAutoApprove("low");
    const cards: ApprovalRequest[] = [];
    const recordings: Promise<void>[] = [];
    const gate = new ApprovalGate({
      isDestroyed: () => false,
      send: (channel: string, request: ApprovalRequest) => {
        if (channel !== "ave:approval:request") return;
        cards.push(request);
        recordings.push((async () => {
          const snapshot = gate.getRequestSnapshot(request.id)!;
          const choice = answer();
          // Same eligibility gate as the record IPC: it refuses to remember
          // an allow the host request does not permit (the card still runs
          // once).
          const remember = choice === "deny-exact" || snapshot.persistentAllowAllowed;
          if (remember) await recordApproval(snapshot.toolName, canonicalStringify(snapshot.args), snapshot.source, {
            decision: choice === "deny-exact" ? "deny" : "allow",
            scope: choice === "deny-exact" ? "persistent" : "session",
            verdictAtApproval: snapshot.verdictAtApproval,
            nlJustification: null,
            trustOrigin: snapshot.trustOrigin,
            approvalCacheKey: approvalCacheKeyIdentity(snapshot.approvalCacheKey, snapshot.approvalMemoryIdentity),
            // The IPC scopes allows to the frozen working directory and keeps
            // exact denies unscoped.
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
          });
        })());
      },
    } as never);
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
          sessionId: "cache-key-identity",
          executionCwd: dir,
          permissionContext: userPermissionContext({ trustOrigin, additionalDirectories: [dir] }),
        },
      );
      await Promise.all(recordings);
      return result;
    };
    return { cards, run };
  }

  /** The real web_fetch identity (key + schema), with the network stubbed out. */
  function webFetch(execute = vi.fn(async () => ({ output: "ok", isError: false }))) {
    const real = createWebFetchTool(vi.fn() as unknown as typeof fetch);
    return { tool: { ...real, execute } as Tool, execute };
  }

  it("allow-session on one URL covers another URL on the same host, not another host", async () => {
    const { tool, execute } = webFetch();
    const { cards, run } = harness([tool]);

    await run("web_fetch", { url: "https://a.example/x" });
    expect(cards).toHaveLength(1);
    expect(cards[0].approvalMemoryIdentity).toBe("approval-cache-key");

    await run("web_fetch", { url: "https://a.example/y?page=2" });
    expect(cards).toHaveLength(1);

    await run("web_fetch", { url: "https://b.example/" });
    expect(cards).toHaveLength(2);
    expect(execute).toHaveBeenCalledTimes(3);
  });

  it("a public-host approval does not cover a private-network fetch of that host", async () => {
    const { tool } = webFetch();
    const { cards, run } = harness([tool]);

    await run("web_fetch", { url: "https://a.example/x" });
    await run("web_fetch", { url: "https://a.example/x", allowPrivateNetwork: true });
    expect(cards).toHaveLength(2);
    expect(cards[1].approvalCacheKey).toBe("web_fetch:web_fetch:host:private-network:a.example");
  });

  it("an approval from one trust origin is never inherited by another", async () => {
    const { tool } = webFetch();
    const { cards, run } = harness([tool]);

    await run("web_fetch", { url: "https://a.example/x" }, "user-keyboard");
    await run("web_fetch", { url: "https://a.example/y" }, "llm-tool-arg");
    expect(cards).toHaveLength(2);
    expect(cards[1].trustOrigin).toBe("llm-tool-arg");
  });

  it("an exact deny applies across the whole key and nowhere else", async () => {
    const { tool, execute } = webFetch();
    const { cards, run } = harness([tool], () => "deny-exact");

    const first = await run("web_fetch", { url: "https://a.example/x" });
    expect(first.is_error).toBe(true);
    expect(cards).toHaveLength(1);

    const sameHost = await run("web_fetch", { url: "https://a.example/other" });
    expect(sameHost.is_error).toBe(true);
    expect(cards).toHaveLength(1);

    await run("web_fetch", { url: "https://b.example/" });
    expect(cards).toHaveLength(2);
    expect(execute).not.toHaveBeenCalled();
  });

  it("a path approval covers repeat writes of that path, not another path", async () => {
    const { cards, run } = harness([new WriteFileTool()]);
    const target = join(dir, "notes.md");

    expect((await run("write_file", { path: target, content: "one" })).is_error).toBeUndefined();
    expect(cards).toHaveLength(1);
    expect((await run("write_file", { path: target, content: "two" })).is_error).toBeUndefined();
    expect(cards).toHaveLength(1);
    await run("write_file", { path: join(dir, "other.md"), content: "one" });
    expect(cards).toHaveLength(2);
  });

  it("a read approval of a path never answers for a write to it", async () => {
    const target = join(dir, "notes.md");
    writeFileSync(target, "content");
    const read = new ReadFileTool();
    const readInput = { path: target };
    // read_file declares no key, so its decision is exact-args identity —
    // derived here exactly as the executor derives it.
    const readIdentity = approvalIdentityFor(read, readInput, dir);
    expect(readIdentity).toEqual({ approvalCacheKey: undefined, approvalMemoryIdentity: undefined });
    await recordApproval("read_file", canonicalStringify(readInput), "builtin", {
      scope: "session",
      verdictAtApproval: "low",
      nlJustification: null,
      trustOrigin: "user-keyboard",
    });

    const { cards, run } = harness([read, new WriteFileTool()]);
    await run("write_file", { path: target, content: "changed" });
    expect(cards).toHaveLength(1);
    expect(cards[0].toolName).toBe("write_file");
  });

  it("a tool without a key keeps exact-args matching", async () => {
    const execute = vi.fn(async () => ({ output: "ok", isError: false }));
    const probe = createDynamicTool({
      name: "shell_probe", description: "probe", source: "builtin", category: "shell",
      jsonSchema: { type: "object", properties: { target: { type: "string" } }, required: ["target"] },
      execute,
    });
    const { cards, run } = harness([probe]);

    await run("shell_probe", { target: "a" });
    await run("shell_probe", { target: "a" });
    expect(cards).toHaveLength(1);
    await run("shell_probe", { target: "b" });
    expect(cards).toHaveLength(2);
    expect(cards[0].approvalMemoryIdentity).toBeUndefined();
  });

  it("routine_schedule keeps exact-args identity because its scope key is not a consent identity", () => {
    const tool = createRoutineScheduleTool({} as never);
    const identity = approvalIdentityFor(tool, { execution: "notification-only", schedule: {} }, dir);
    expect(identity).toEqual({
      approvalCacheKey: "routine_schedule:scope:deny-all",
      approvalMemoryIdentity: "args",
    });
  });
});
