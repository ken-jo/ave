import { afterQueuedCallbacks, deferred } from "../../__tests__/support/deferred.js";
import { spawn } from "node:child_process";
import { promises as dns } from "node:dns";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { directHostFetchTransport } from "../../__tests__/support/host-fetch-transport.js";
import { createDynamicTool } from "../../tools/base.js";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { makeMockWebContents } from "../../__tests__/test-helpers.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { AuditLogger } from "../../audit/audit-logger.js";
import type { PermissionAuditEntry, PermissionAuditEntryInput } from "../../audit/audit-schema.js";
import { ApprovalGate, IPC_APPROVAL_REQUEST } from "../../permissions/approval-gate.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { ToolRegistry } from "../../tools/registry.js";
import { makeWriteProbeTool } from "../../tools/__tests__/approval-memory-test-fixtures.js";
import { userPermissionContext } from "../../tools/__tests__/tool-context-fixture.js";
import type { ReadyBootContext } from "../context.js";

class ObservedAuditLogger extends AuditLogger {
  readonly order: string[] = [];
  beforeAppend?: (entry: PermissionAuditEntryInput, written: Promise<PermissionAuditEntry>) => Promise<void>;
  beforeDeny?: () => Promise<void>;

  override async appendPermissionAuditEntry(entry: PermissionAuditEntryInput): Promise<PermissionAuditEntry> {
    if (entry.decision === "deny") await this.beforeDeny?.();
    const written = super.appendPermissionAuditEntry(entry);
    await this.beforeAppend?.(entry, written);
    const row = await written;
    this.order.push(`append:${entry.decision}`);
    return row;
  }

  override close(): Promise<void> {
    this.order.push("close");
    return super.close();
  }
}

const { killScript } = vi.hoisted(() => ({ killScript: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:child_process")>();
  return { ...original, spawn: vi.fn(original.spawn) };
});
vi.mock("../../main/managed-child-processes.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../main/managed-child-processes.js")>(),
  trackManagedChildProcess: vi.fn(),
  forceKillManagedChildProcess: killScript,
}));

function shutdownContext(audit: AuditLogger, approvalGate: ApprovalGate, abortCurrentTurn = () => {}): ReadyBootContext {
  const stop = () => {};
  return {
    disposeRefreshActiveLlmWildcard: stop,
    memoryMaintenanceCoordinator: { stop },
    memoryCaptureService: { stop },
    preferenceRefreshService: { stop },
    routinesScheduler: { stop },
    alertsService: { stop },
    conversationLoop: { abortCurrentTurn },
    sideChatConversationLoop: { abortCurrentTurn: stop },
    paneChatLoops: { all: () => [] },
    approvalGate,
    askUserQuestionGate: { disposeAll: stop },
    mcpGovernance: { stopPolicyRefresh: stop },
    mcpManager: { disconnectAll: async () => {} },
    bootAuditLogger: audit,
    auditService: { stop },
    tracing: { shutdown: async () => {} },
    lateBinding: { pluginToolInvokerRef: {} },
  } as unknown as ReadyBootContext;
}

describe("shutdown permission audit ordering", () => {
  let root: string;
  let workspace: string;
  let audit: ObservedAuditLogger;
  let gate: ApprovalGate | undefined;

  beforeEach(async () => {
    vi.resetModules();
    root = mkdtempSync(join(tmpdir(), "ave-shutdown-audit-"));
    workspace = join(root, "workspace");
    mkdirSync(workspace);
    vi.stubEnv("AVE_HOME", join(root, "host-home"));
    audit = new ObservedAuditLogger(join(root, "audit"));
    await audit.setupPermissionAuditChain("synthetic-shutdown-audit-secret");
  });

  afterEach(async () => {
    gate?.disposeAll();
    gate = undefined;
    vi.restoreAllMocks();
    await audit.close();
    vi.unstubAllEnvs();
    await cleanupTmpDir(root);
  });

  it.each([
    { state: "pending ask", withTurn: false, queued: false, appendFails: false },
    { state: "pending turn ask", withTurn: true, queued: false, appendFails: false },
    { state: "queued ask append", withTurn: false, queued: true, appendFails: false },
    { state: "pending ask and a failed terminal append", withTurn: false, queued: false, appendFails: true },
  ])("quit with a $state writes the deny row before the audit logger closes", async ({ withTurn, queued, appendFails }) => {
    // The process-wide ledger is fresh for each simulated process.
    const { assembleAppServices: assemble } = await import("../assemble-services.js");
    const { ToolExecutor: Executor } = await import("../../tools/executor.js");
    const { HostExitAbortError } = await import("../../shared/host-exit-abort.js");
    // The gate's host-decision markers live in its module, so it comes from the same fresh graph as the executor.
    const { ApprovalGate: Gate } = await import("../../permissions/approval-gate.js");
    const controller = withTurn ? new AbortController() : undefined;
    const wc = makeMockWebContents();
    const sent = deferred<void>();
    const askQueued = deferred<void>();
    const quitStarted = deferred<void>();
    wc.send.mockImplementation((channel: string) => {
      if (channel === IPC_APPROVAL_REQUEST) sent.resolve();
    });
    const approvalGate = new Gate(wc as never, undefined, undefined, audit);
    gate = approvalGate;
    audit.beforeDeny = async () => {
      await afterQueuedCallbacks();
      if (appendFails) throw new Error("terminal permission audit unavailable");
    };
    audit.beforeAppend = async (entry) => {
      if (queued && entry.decision === "ask") {
        askQueued.resolve();
        await quitStarted.promise;
        await afterQueuedCallbacks();
      }
    };
    const execute = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(execute));
    const manager = new PermissionManager(join(root, "permissions.json"));
    const executor = new Executor(registry, undefined, manager, undefined, approvalGate, undefined, audit);
    const invocation = executor.executeAll([{
      id: "shutdown-write-probe",
      name: "write_probe",
      input: { path: join(workspace, "notes.txt") },
    }], {
      sessionId: "shutdown-session",
      executionCwd: workspace,
      ...(controller ? { abortSignal: controller.signal } : {}),
      permissionContext: userPermissionContext({ additionalDirectories: [workspace] }),
    });
    const result = Promise.allSettled([invocation]);
    await Promise.race([
      queued ? askQueued.promise : sent.promise,
      invocation.then((results) => { throw new Error(`Invocation finished before ask: ${results[0]?.content}`); }),
    ]);
    if (!queued) expect(approvalGate.pendingCount).toBe(1);

    const app = assemble(shutdownContext(audit, approvalGate, () => controller?.abort(new HostExitAbortError())));
    if (!app.shutdown) throw new Error("Shutdown handler missing");
    const shutdown = app.shutdown();
    quitStarted.resolve();
    if (appendFails) {
      await expect(shutdown).rejects.toMatchObject({
        errors: [expect.objectContaining({ message: "shutdown invocation audit failed" })],
      });
      expect(await result).toMatchObject([{ status: "rejected" }]);
      expect(audit.order).toEqual(["append:ask", "close"]);
      return;
    }
    await shutdown;
    const [outcome] = await result;
    const rows = readFileSync(audit.getPermissionAuditLogFile(), "utf8")
      .trim().split("\n").map((line) => JSON.parse(line) as PermissionAuditEntryInput);

    expect(rows).toMatchObject([
      { decision: "ask", toolUseId: "shutdown-write-probe" },
      { decision: "deny", toolUseId: "shutdown-write-probe", denyReasons: [{ reason: "host-shutdown" }], trustOrigin: "unknown" },
    ]);
    expect(audit.order).toEqual(["append:ask", "append:deny", "close"]);
    expect(approvalGate.pendingCount).toBe(0);
    expect(execute).not.toHaveBeenCalled();
    expect(outcome).toMatchObject({ status: "fulfilled", value: [{ is_error: true }] });
  });

  it.each([...Array.from({ length: 13 }, (_, hops) => hops), "close"] as const)(
    "an arrival after the last drained entry (%s) is joined before close or fails the shutdown",
    async (when) => {
      const ledger = await import("../../tools/invocation-ledger.js");
      const { assembleAppServices } = await import("../assemble-services.js");
      const arrive = async (): Promise<"written" | "rejected"> => {
        const admission = ledger.admitToolInvocation("late_probe");
        try {
          await afterQueuedCallbacks();
          await ledger.appendToolInvocationAudit(audit, {
            decision: "deny", ts: new Date().toISOString(), auditId: "late-probe", tool: "late_probe",
            source: "builtin", category: "write", trustOrigin: "unknown",
            denyReasons: [{ reason: "host-shutdown", source: "tool-executor" }],
            pluginOperation: { pluginId: "probe-plugin", operation: "status", outcome: "denied" },
          });
          return "written";
        } catch {
          return "rejected";
        } finally {
          admission.settle();
        }
      };
      let arrival: Promise<"written" | "rejected"> | undefined;
      const close = audit.close.bind(audit);
      vi.spyOn(audit, "close").mockImplementation(async () => {
        if (when === "close") arrival = arrive();
        const closed = close();
        await arrival;
        return closed;
      });
      const last = ledger.admitToolInvocation("last_probe");
      const app = assembleAppServices(shutdownContext(audit, new ApprovalGate(null)));
      if (!app.shutdown) throw new Error("Shutdown handler missing");
      const shutdown = Promise.allSettled([app.shutdown()]);
      await afterQueuedCallbacks();
      if (when !== "close") {
        let hop = Promise.resolve();
        for (let i = 0; i < when; i += 1) hop = hop.then(() => {});
        arrival = hop.then(arrive);
      }
      last.settle();
      const [outcome] = await shutdown;
      if (await arrival === "written") {
        expect(outcome.status).toBe("fulfilled");
        expect(audit.order).toEqual(["append:deny", "close"]);
      } else {
        expect(outcome).toMatchObject({
          status: "rejected",
          reason: { errors: [expect.objectContaining({ message: "shutdown invocation audit failed" })] },
        });
      }
    },
  );

  it("aborts slow HTTP and script lifecycle hooks at seal and drains without advancing timers", async () => {
    const { ToolExecutor } = await import("../../tools/executor.js");
    const { ScriptHookManager } = await import("../../hooks/script-hook-manager.js");
    const { parseHookConfig } = await import("../../hooks/hook-config.js");
    const { assembleAppServices } = await import("../assemble-services.js");
    const hooks = new ScriptHookManager();
    const url = "https://hooks.example.com/check";
    hooks.setTrustedRegistry([], parseHookConfig({ hooks: {
      PostToolUseFailure: [
        { matcher: "http_probe", hooks: [{ type: "http", url }] },
        { matcher: "script_probe", hooks: [{ type: "command", command: "node slow-hook.js" }] },
      ],
    } }).entries.map((entry) => ({ ...entry, configDir: workspace })));
    vi.spyOn(dns, "lookup").mockResolvedValue([{ address: "93.184.216.34", family: 4 }] as never);

    const httpStarted = deferred<AbortSignal>();
    const scriptStarted = deferred<void>();
    const response = deferred<Response>();
    let httpAborted = false;
    hooks.setHttpHookRuntime({
      transport: directHostFetchTransport((_input, init) => {
        const signal = init?.signal;
        if (!signal) throw new Error("HTTP hook signal missing");
        httpStarted.resolve(signal);
        signal.addEventListener("abort", () => {
          httpAborted = true;
          response.resolve(new Response("{}"));
        }, { once: true });
        return response.promise;
      }),
      allowedUrls: [url],
      allowedEnvVars: [],
      auditTarget: vi.fn(),
    });

    const child = Object.assign(new EventEmitter(), {
      pid: 14003, stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(), exitCode: null, signalCode: null,
    });
    child.stdin.once("finish", scriptStarted.resolve);
    vi.mocked(spawn).mockImplementationOnce(() => child as unknown as ReturnType<typeof spawn>);
    killScript.mockImplementationOnce(() => { child.emit("close", null, "SIGKILL"); });
    // A POSIX hook is a process group; the managed runner kills and probes it directly.
    let groupAlive = true;
    const nativeKill = process.kill;
    const groupKill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid !== -child.pid) return nativeKill(pid, signal);
      if (signal === "SIGKILL" && groupAlive) {
        groupAlive = false;
        child.emit("close", null, "SIGKILL");
      }
      if (groupAlive) return true;
      throw Object.assign(new Error("Group exited"), { code: "ESRCH" });
    });

    const registry = new ToolRegistry();
    for (const name of ["http_probe", "script_probe"]) {
      registry.register(createDynamicTool({
        name,
        description: "Failing probe",
        source: "builtin",
        category: "read",
        jsonSchema: { type: "object", properties: {} },
        execute: async () => ({ output: "probe failed", isError: true }),
      }));
    }
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const manager = new PermissionManager(join(root, "hook-permissions.json"));
    const executor = new ToolExecutor(registry, undefined, manager, undefined, undefined, hooks, audit);
    const invocations = Promise.allSettled(["http_probe", "script_probe"].map((name) =>
      executor.executeAll([{ id: name, name, input: {} }], {
        sessionId: name,
        executionCwd: workspace,
        permissionContext: userPermissionContext({ additionalDirectories: [workspace] }),
      })));
    try {
      const [signal] = await Promise.race([
        Promise.all([httpStarted.promise, scriptStarted.promise]),
        invocations.then((results) => { throw new Error(`Hooks did not start: ${JSON.stringify(results)}`); }),
      ]);
      const app = assembleAppServices(shutdownContext(audit, new ApprovalGate(null)));
      await expect(app.shutdown?.()).resolves.toBeUndefined();
      expect(signal.aborted).toBe(true);
      expect(httpAborted).toBe(true);
      if (process.platform === "win32") expect(killScript).toHaveBeenCalledWith(child, "hook caller aborted");
      else expect(groupKill).toHaveBeenCalledWith(-child.pid, "SIGKILL");
      expect(await invocations).toMatchObject([
        { status: "fulfilled", value: [{ is_error: true }] },
        { status: "fulfilled", value: [{ is_error: true }] },
      ]);
      expect(vi.getTimerCount()).toBe(0);
      expect(audit.order.at(-1)).toBe("close");
    } finally {
      response.resolve(new Response("{}"));
      child.emit("close", 0, null);
      await invocations;
      vi.useRealTimers();
      groupKill.mockRestore();
    }
  });
});
