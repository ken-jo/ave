import { afterQueuedCallbacks, deferred } from "../../__tests__/support/deferred.js";
import { spawn } from "node:child_process";
import { promises as dns } from "node:dns";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { directHostFetchTransport } from "../../__tests__/support/host-fetch-transport.js";
import { createDynamicTool } from "../../tools/base.js";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchPermissionEvents } from "../../__tests__/support/permission-events.js";
import { makeMockWebContents } from "../../__tests__/test-helpers.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { ApprovalGate, IPC_APPROVAL_REQUEST } from "../../permissions/approval-gate.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { ToolRegistry } from "../../tools/registry.js";
import { makeWriteProbeTool } from "../../tools/__tests__/approval-memory-test-fixtures.js";
import { userPermissionContext } from "../../tools/__tests__/tool-context-fixture.js";
import type { ReadyBootContext } from "../context.js";

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

function shutdownContext(approvalGate: ApprovalGate, abortCurrentTurn = () => {}): ReadyBootContext {
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
    tracing: { shutdown: async () => {} },
    lateBinding: { pluginToolInvokerRef: {} },
  } as unknown as ReadyBootContext;
}

describe("shutdown invocation settlement", () => {
  let root: string;
  let workspace: string;
  let gate: ApprovalGate | undefined;

  beforeEach(async () => {
    vi.resetModules();
    await import("../../__tests__/vitest-approval-presentation.js");
    root = mkdtempSync(join(tmpdir(), "ave-invocation-shutdown-"));
    workspace = join(root, "workspace");
    mkdirSync(workspace);
    vi.stubEnv("AVE_HOME", join(root, "host-home"));

  });

  afterEach(async () => {
    gate?.disposeAll();
    gate = undefined;
    vi.restoreAllMocks();

    vi.unstubAllEnvs();
    await cleanupTmpDir(root);
  });

  it.each([
    { state: "pending ask", withTurn: false, brokenLog: false },
    { state: "pending turn ask", withTurn: true, brokenLog: false },
    { state: "pending ask with a broken log sink", withTurn: false, brokenLog: true },
  ])("settles a $state during shutdown", async ({ withTurn, brokenLog }) => {
    const { assembleAppServices } = await import("../assemble-services.js");
    const { ToolExecutor } = await import("../../tools/executor.js");
    const { HostExitAbortError } = await import("../../shared/host-exit-abort.js");
    const { ApprovalGate: Gate } = await import("../../permissions/approval-gate.js");
    const controller = withTurn ? new AbortController() : undefined;
    const wc = makeMockWebContents();
    const sent = deferred<void>();
    wc.send.mockImplementation((channel: string) => {
      if (channel === IPC_APPROVAL_REQUEST) sent.resolve();
    });
    gate = new Gate(wc as never);
    const observed: Record<string, unknown>[] = [];
    watchPermissionEvents((event) => {
      if (event.event !== "permission_decision" || event.toolUseId !== "shutdown-write-probe") return;
      observed.push(event);
      if (brokenLog && event.decision === "deny") throw new Error("log sink unavailable");
    });
    const execute = vi.fn(async () => "wrote");
    const registry = new ToolRegistry();
    registry.register(makeWriteProbeTool(execute));
    const manager = new PermissionManager(join(root, "permissions.json"));
    const executor = new ToolExecutor(registry, undefined, manager, undefined, gate);
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
    await Promise.race([
      sent.promise,
      invocation.then((results) => { throw new Error(`Invocation finished before ask: ${results[0]?.content}`); }),
    ]);
    expect(gate.pendingCount).toBe(1);

    const app = assembleAppServices(shutdownContext(gate, () => controller?.abort(new HostExitAbortError())));
    await expect(app.shutdown?.()).resolves.toBeUndefined();
    expect(await invocation).toMatchObject([{ is_error: true }]);
    expect(gate.pendingCount).toBe(0);
    expect(execute).not.toHaveBeenCalled();
    expect(observed).toMatchObject([
      { decision: "ask" },
      { decision: "deny", terminalKind: "cancelled", trustOrigin: "unknown" },
    ]);
  });

  it("waits for an active invocation and closes admission", async () => {
    const ledger = await import("../../tools/invocation-ledger.js");
    const { assembleAppServices } = await import("../assemble-services.js");
    const admission = ledger.admitToolInvocation("active_probe");
    const app = assembleAppServices(shutdownContext(new ApprovalGate(null)));
    let finished = false;
    const shutdown = app.shutdown?.().then(() => { finished = true; });
    await afterQueuedCallbacks();
    expect(finished).toBe(false);
    expect(admission.signal.aborted).toBe(true);
    await admission.terminal.commit(async (row) => {
      await row({ kind: "cancelled", entry: {
        decision: "deny", ts: new Date().toISOString(), auditId: "active-probe", tool: "active_probe",
        source: "builtin", category: "write", trustOrigin: "unknown",
        denyReasons: [{ reason: "host-shutdown", source: "tool-executor" }],
      } });
    });
    admission.settle();
    await shutdown;
    expect(finished).toBe(true);
    expect(ledger.admitToolInvocationWhileOpen("late_probe")).toBeUndefined();
  });

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
    const executor = new ToolExecutor(registry, undefined, manager, undefined, undefined, hooks);
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
      const app = assembleAppServices(shutdownContext(new ApprovalGate(null)));
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
    } finally {
      response.resolve(new Response("{}"));
      child.emit("close", 0, null);
      await invocations;
      vi.useRealTimers();
      groupKill.mockRestore();
    }
  });
});
