import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuditLogger } from "../../audit/audit-logger.js";
import { HookRunner, type HookContext } from "../../hooks/hook-runner.js";
import {
  decideTurnChangeHunk,
  getTurnChangeReview,
  withCodeCheckpoint,
} from "../../memory/code-checkpoints.js";
import { ApprovalGate } from "../../permissions/approval-gate.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import type { TurnChangeReview } from "../../shared/turn-change-review.js";
import { ToolExecutor } from "../executor.js";
import { createFileTools } from "../file-tools.js";
import { ToolRegistry } from "../registry.js";

const broker = vi.hoisted(() => {
  const createCapability = (cwd: string) => Object.freeze({
    version: "brokered-workload-capability/v1" as const,
    workload: Object.freeze({
      id: "a".repeat(64), generation: "review-generation",
      boundaryFingerprint: "b".repeat(64), imageDigest: `sha256:${"c".repeat(64)}`,
      cwd, home: "/home/example", platform: "linux" as const,
    }),
    expiresAt: "2099-01-01T00:00:00.000Z",
    allowedOperations: Object.freeze(["file.read", "file.write", "file.delete"]),
  });
  return { active: false, capability: createCapability("/git"), createCapability, execute: vi.fn(), acquire: vi.fn() };
});

vi.mock("../../workload/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../workload/runtime.js")>()),
  isWorkloadBrokerActive: () => broker.active,
  acquireBrokeredWorkloadCapability: broker.acquire,
  isIssuedActiveBrokeredWorkloadCapability: (value: unknown) => broker.active && value === broker.capability,
  isActiveWorkloadBrokerCwd: () => broker.active,
  resolveBrokeredWorkloadPath: (_capability: unknown, path: string) => path,
  executeBrokeredWorkloadRequest: broker.execute,
}));

let root: string;
let file: string;
let sessionId: string;
let executor: ToolExecutor;
let permissions: PermissionManager;
let hooks: HookRunner;
let approval: ApprovalGate;
let audit: AuditLogger;
const TURN_ID = "tracked-turn";
const ORIGINAL = "original line\r\nunchanged line\r\n";
const EDITED = "agent line\r\nunchanged line\r\n";

beforeEach(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), "ave-turn-review-governance-")));
  vi.stubEnv("AVE_HOME", join(root, "profile"));
  file = join(root, "source.txt");
  sessionId = randomUUID();
  broker.active = false;
  broker.capability = broker.createCapability(root);
  broker.acquire.mockReset().mockResolvedValue(broker.capability);
  broker.execute.mockReset().mockResolvedValue({ output: "guest sentinel", isError: false });
  const registry = new ToolRegistry();
  for (const tool of createFileTools()) registry.register(tool);
  permissions = new PermissionManager(join(root, "permissions.json"));
  permissions.setMode("allow");
  hooks = new HookRunner();
  approval = new ApprovalGate({ isDestroyed: () => false, send: vi.fn() } as never);
  audit = new AuditLogger(join(root, "audit"));
  executor = new ToolExecutor(registry, hooks, permissions, undefined, approval, undefined, audit);
});

afterEach(async () => {
  broker.active = false;
  vi.restoreAllMocks();
  await audit?.close();
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});

function context() { return { cwd: root, extraAllowedDirectories: [] }; }

async function invoke(name: string, input: Record<string, unknown>) {
  const [result] = await executor.executeAll([{ id: randomUUID(), name, input }], {
    sessionId,
    executionCwd: root,
    permissionContext: {
      trustOrigin: "user-keyboard", approvalSurface: "interactive",
      additionalDirectories: [], getAdditionalDirectories: () => [],
    },
  });
  return result;
}

async function checkpoint(kind: "edit" | "create" | "delete" = "edit"): Promise<TurnChangeReview> {
  if (kind !== "create") await writeFile(file, ORIGINAL);
  await withCodeCheckpoint({ sessionId, messageId: TURN_ID }, async () => {
    if (kind !== "create") expect((await invoke("read_file", { path: file })).is_error).not.toBe(true);
    const result = kind === "delete"
      ? await invoke("delete_file", { path: file })
      : await invoke("write_file", { path: file, content: EDITED });
    expect(result.is_error, result.content).not.toBe(true);
  });
  const result = await getTurnChangeReview(sessionId, TURN_ID, context);
  expect(result.ok, JSON.stringify(result)).toBe(true);
  if (!result.ok) throw new Error("Checkpoint review was unavailable");
  expect(result.review.files).toHaveLength(1);
  expect(result.review.files[0].hunks).toHaveLength(1);
  return result.review;
}

function rejection(review: TurnChangeReview) {
  const execute = vi.fn(async (mutation: { path: string; content: string | null; expectedHash: string | null }) => {
    if (mutation.expectedHash !== null && mutation.content !== null) {
      const read = await invoke("read_file", { path: mutation.path });
      if (read.is_error) return { ok: false };
    }
    const result = mutation.content === null
      ? await invoke("delete_file", { path: mutation.path })
      : await invoke("write_file", { path: mutation.path, content: mutation.content });
    return { ok: result.is_error !== true };
  });
  return {
    execute,
    run: () => decideTurnChangeHunk({
      sessionId, turnId: TURN_ID, version: review.version,
      hunkId: review.files[0].hunks[0].id, decision: "reject",
    }, context, execute),
  };
}

async function storedTurnIds() {
  const ledger = JSON.parse(await readFile(join(root, "profile/code-checkpoints/turns.json"), "utf8"));
  return ledger.turns.map((turn: { messageId: string }) => turn.messageId);
}

describe("turn hunk rejection through native tool governance", () => {
  it("restores exact bytes through the executor without adding another checkpoint", async () => {
    const review = await checkpoint();
    expect(await storedTurnIds()).toEqual([TURN_ID]);
    const operation = rejection(review);
    const result = await operation.run();
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect(await readFile(file, "utf8")).toBe(ORIGINAL);
    expect(operation.execute).toHaveBeenCalledOnce();
    expect(await storedTurnIds()).toEqual([TURN_ID]);
    const reloaded = await getTurnChangeReview(sessionId, TURN_ID, context);
    expect(reloaded).toMatchObject({ ok: true, review: { files: [{ hunks: [{ decision: "rejected" }] }] } });
  });

  it.each(["create", "delete"] as const)("reverses tracked %s through canonical file tools", async (kind) => {
    const review = await checkpoint(kind);
    const result = await rejection(review).run();
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (kind === "create") await expect(readFile(file)).rejects.toMatchObject({ code: "ENOENT" });
    else expect(await readFile(file, "utf8")).toBe(ORIGINAL);
    expect(await storedTurnIds()).toEqual([TURN_ID]);
  });

  it("honors an explicit write denial without changing files or deciding the hunk", async () => {
    const review = await checkpoint();
    permissions.setRules([{ pattern: "write_file", action: "deny" }]);
    const check = vi.spyOn(permissions, "checkDetailed");
    const result = await rejection(review).run();
    expect(result).toMatchObject({ ok: false, error: "turn-review-write-denied" });
    expect(check.mock.results.some((entry) => entry.type === "return" && entry.value.decision === "deny")).toBe(true);
    expect(await readFile(file, "utf8")).toBe(EDITED);
    expect(await getTurnChangeReview(sessionId, TURN_ID, context)).toMatchObject({
      ok: true, review: { files: [{ hunks: [{ decision: "pending" }] }] },
    });
  });

  it.each(["path", "content"] as const)("refuses a hook-modified inverse %s and preserves both files", async (field) => {
    const review = await checkpoint();
    const other = join(root, "other.txt");
    await writeFile(other, "unrelated sentinel");
    expect((await invoke("read_file", { path: other })).is_error).not.toBe(true);
    const hook = vi.fn(({ toolName, toolInput }: HookContext) => toolName === "write_file"
      ? { action: "modify" as const, updatedInput: {
          ...toolInput, [field]: field === "path" ? other : "rewritten content",
        } }
      : { action: "allow" as const });
    hooks.registerPreHook("rewrite inverse", hook);
    const result = await rejection(review).run();
    expect(result).toMatchObject({ ok: false, error: "turn-review-write-denied" });
    expect(hook.mock.calls.some(([input]) => input.toolName === "write_file")).toBe(true);
    expect(await readFile(file, "utf8")).toBe(EDITED);
    expect(await readFile(other, "utf8")).toBe("unrelated sentinel");
  });

  it("refuses an external change that arrives while write approval is pending", async () => {
    const review = await checkpoint();
    permissions.setMode("strict");
    permissions.setRules([{ pattern: "read_file", action: "allow" }]);
    let approvalStarted!: () => void;
    const entered = new Promise<void>((resolve) => { approvalStarted = resolve; });
    let releaseApproval!: () => void;
    const released = new Promise<void>((resolve) => { releaseApproval = resolve; });
    const request = vi.spyOn(approval, "requestAndWait").mockImplementation(async (input) => {
      if (input.toolName === "write_file") {
        approvalStarted();
        await released;
      }
      return { requestId: "review-approval", choice: "allow-once" };
    });
    const operation = rejection(review);
    const pending = operation.run();
    const first = await Promise.race([
      entered.then(() => "approval" as const),
      pending.then(() => "settled" as const),
    ]);
    expect(first).toBe("approval");
    await writeFile(file, "external during approval\n");
    releaseApproval();
    const result = await pending;
    expect(request.mock.calls.filter(([input]) => input.toolName === "write_file")).toHaveLength(1);
    expect(result).toMatchObject({ ok: false, error: "turn-review-conflict", conflictingFiles: [file] });
    expect(await readFile(file, "utf8")).toBe("external during approval\n");
  }, 15_000);

  it("refuses a stale checkpoint hash without refreshing file-read state or running a callback", async () => {
    const review = await checkpoint();
    await writeFile(file, "external after review\n");
    const execute = vi.spyOn(executor, "executeAll");
    const operation = rejection(review);
    expect(await operation.run()).toMatchObject({ ok: false, error: "turn-review-conflict" });
    expect(operation.execute).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(await readFile(file, "utf8")).toBe("external after review\n");
  });

  it("refuses an active broker route without either a local effect or a guest request", async () => {
    const review = await checkpoint();
    broker.active = true;
    const result = await rejection(review).run();
    expect(result.ok).toBe(false);
    expect(broker.execute).not.toHaveBeenCalled();
    expect(await readFile(file, "utf8")).toBe(EDITED);
    expect(await storedTurnIds()).toEqual([TURN_ID]);
  });
});
