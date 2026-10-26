import { describe, it, expect, vi, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ScopedPermissionRule, ScopedPermissionRuleError } from "../../../shared/permissions-events.js";
import { PERMISSIONS } from "../../../shared/ipc-channels.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { UNAUTHORIZED_FRAME } from "../../gated.js";
import { setWorkspaceRootLifecycle } from "../../../permissions/workspace-root-lifecycle.js";
import {
  foreignFrameEvent,
  framelessEvent,
  hostFrameEvent,
  invokeRegisteredHandlerWithEvent,
  pluginShellFrameEvent,
} from "../../../__tests__/test-helpers.js";

const handlers = new Map<string, (...args: unknown[]) => unknown>();
const USER_INTENT = { inputOrigin: "user-keyboard", userActivation: true };
let nativeApprovalEvent: ReturnType<typeof hostFrameEvent> | null = null;
/** The ask callback registration handed to the permission manager. */
let askDeferredEntry: ((entry: unknown) => void) | null = null;
const recordApprovalMock = vi.hoisted(() => vi.fn(async () => undefined));

const resolveProxyMock = vi.hoisted(() => vi.fn(async (_url: string) => "DIRECT"));
const readWindowsStatusMock = vi.hoisted(() => vi.fn());
vi.mock("../../../permissions/asrt-windows-support.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../permissions/asrt-windows-support.js")>();
  return { ...actual, readAsrtWindowsStatus: readWindowsStatusMock };
});
vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
  session: { defaultSession: { resolveProxy: resolveProxyMock } },
}));

// `policyGet` must attach the host-derived `editable` flag. loadPolicy itself reads real OS paths (/etc/ave,
// %ProgramData%), so the file layer is stubbed while the handler under test; and the predicate it calls; stay real.
const loadPolicyMock = vi.hoisted(() => vi.fn());
const egressRuntimeMock = vi.hoisted(() => ({
  listEgressGrants: vi.fn(async (): Promise<unknown[]> => []),
  revokeEgressGrant: vi.fn(async (_target: unknown) => ({ removed: true, closed: 0 })),
}));
vi.mock("../../../permissions/egress-runtime.js", () => egressRuntimeMock);

vi.mock("../../../permissions/policy-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../permissions/policy-store.js")>();
  return { ...actual, loadPolicy: loadPolicyMock };
});

vi.mock("../../../permissions/user-approval-store.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../permissions/user-approval-store.js")>();
  return {
    ...actual,
    recordApproval: recordApprovalMock,
  };
});

function invoke(channel: string, ...args: unknown[]): unknown {
  const fn = handlers.get(channel);
  if (!fn) throw new Error(`No handler registered for: ${channel}`);
  // mutating user-approval handlers gate on user-keyboard intent. Auto-inject the intent marker on the relevant channels so existing test fixtures don't need a payload rewrite.
  const intentRequired =
    channel === PERMISSIONS.userApprovalRecord ||
    channel === PERMISSIONS.userApprovalRevoke;
  if (intentRequired && typeof args[0] === "object" && args[0] !== null) {
    const payload = args[0] as Record<string, unknown>;
    if (payload.intent === undefined) {
      args = [{ ...payload, intent: { inputOrigin: "user-keyboard", userActivation: true } }, ...args.slice(1)];
    }
  }
  const event = channel === PERMISSIONS.approvalRespond || channel === PERMISSIONS.approvalPending ||
    channel === PERMISSIONS.userApprovalRecord || channel === PERMISSIONS.approvalSentenceSelect
    ? nativeApprovalEvent : hostFrameEvent();
  if (!event) throw new Error("Native approval fixture is not registered");
  return fn(event, ...args);
}

function makeDeferredEntry(overrides: Record<string, unknown> = {}) {
  return {
    id: "deferred-1",
    ts: "2026-05-10T00:00:00Z",
    toolName: "bash",
    source: "builtin",
    category: "shell",
    inputSummary: "bash command",
    verdict: { level: "high", reason: "test" },
    // Approving an entry applies its recorded grant; an entry without one cannot be approved at all (see the
    // "no-grant-available" tests below), so the shared fixture carries the out-of-allowed-dir lane's grant.
    grant: { kind: "directory", path: "/srv/app/data" },
    status: "pending",
    ...overrides,
  };
}

function makeDeps(options: {
  approvalChoice?: "allow-once" | "allow-session" | "allow-always" | "deny-once";
  auditReady?: boolean;
  auditAppendError?: Error;
  queue?: Record<string, unknown> | null;
  mode?: string;
  interactiveAutoApprove?: "off" | "low" | "medium";
  hasReviewer?: boolean;
  workspaceLifecycleAvailable?: boolean;
  durableApprovalRecordAllowed?: boolean;
  persistentAllowAllowed?: boolean;
  workingDirectoryIdentity?: string;
  snapshotArgs?: unknown;
  snapshotSessionId?: string | null;
  shellRule?: import("../../../shared/permissions-events.js").ShellRuleApproval;
  snapshotVerdict?: "low" | "medium" | "high";
  snapshotApprovalCacheKey?: string;
  snapshotApprovalMemory?: import("../../../shared/permissions-events.js").ApprovalMemory;
  /** Index into the card's own choice list the simulated user picks. */
  answerChoiceIndex?: number;
} = {}) {
  const appWindows = [
    {
      isDestroyed: vi.fn(() => false),
      webContents: {
        mainFrame: { url: "file:///application/index.html" },
        isDestroyed: vi.fn(() => false),
        send: vi.fn(),
      },
    },
    {
      isDestroyed: vi.fn(() => false),
      webContents: {
        mainFrame: { url: "file:///application/index.html" },
        isDestroyed: vi.fn(() => false),
        send: vi.fn(),
      },
    },
  ];
  const permissionManager = {
    getMode: vi.fn(() => options.mode ?? "default"),
    getInteractiveAutoApprove: vi.fn(() => options.interactiveAutoApprove ?? "off"),
    hasReviewer: vi.fn(() => options.hasReviewer ?? false),
    setMode: vi.fn(),
    setModePersist: vi.fn(async () => undefined),
    listPersistedRules: vi.fn(async () => []),
    listScopedRules: vi.fn(async (): Promise<{ rules: ScopedPermissionRule[]; errors: ScopedPermissionRuleError[] }> => ({ rules: [], errors: [] })),
    addRulePersist: vi.fn(async () => undefined),
    addSessionShellRule: vi.fn(() => undefined),
    removeRulePersist: vi.fn(async () => undefined),
    addAlwaysAllowedPersist: vi.fn(async () => undefined),
    addAlwaysDeniedPersist: vi.fn(async () => undefined),
    removeRule: vi.fn(async () => undefined),
    getVisibilityDenyRules: vi.fn(() => []),
    getDeferredQueue: vi.fn(() => options.queue ?? null),
    isReviewerDegradedToRule: vi.fn(() => false),
    // Registration hands the host's ask surface to the manager; the tests keep the callback so they can drive it the way a newly deferred entry would.
    setDeferredEntryAsk: vi.fn((fn: (entry: unknown) => void) => {
      askDeferredEntry = fn;
    }),
  };
  // Answers by POSITION, not by label: the labels are localized, and a test that spelled one out
  // would be asserting the catalog rather than the map from the user's pick to the resolution.
  const askUserQuestionGate = {
    ask: vi.fn(async (input: { questions: { choices: string[] }[] }) =>
      options.answerChoiceIndex === undefined
        ? { requestId: "q-1", dismissed: true }
        : {
            requestId: "q-1",
            answers: [{ choice: input.questions[0].choices[options.answerChoiceIndex] }],
          },
    ),
  };
  const workspaceRootLifecycle = {
    allowDirectory: vi.fn(async (root: string) => [root]),
    denyDirectory: vi.fn(async () => [] as string[]),
  };
  const deps = {
    conversationLoop: {
      permissionManager,
      addSessionAdditionalDirectory: vi.fn(),
    },
    approvalGate: {
      requestAndWait: vi.fn(async (req: { id: string }) => ({
        requestId: req.id,
        choice: options.approvalChoice ?? "allow-once",
      })),
      resolve: vi.fn((_requestId: string, decision: unknown) => decision),
      resolveFromDesktopRenderer: vi.fn((_requestId: string, decision: unknown) => decision),
      listPendingRendererRequests: vi.fn(() => []),
      canAccessRendererRequest: vi.fn(() => true),
      // #799 + CRITICAL-2 ralph iter 4: server-side ApprovalRequest binding. userApprovalRecord handler reads identity, raw args, and
      // verdict from this host snapshot. Tests opt into HIGH explicitly; renderer claims cannot downgrade it into a persistent allow.
      getRequestSnapshot: vi.fn((_requestId: string) => ({
        sessionId: options.snapshotSessionId === null ? undefined : options.snapshotSessionId ?? "conversation-1",
        projectCwd: "/srv/project",
        shellRule: options.shellRule,
        toolName: "bash_run",
        args: options.snapshotArgs ?? { command: "ls" },
        source: "user-keyboard" as const,
        trustOrigin: "user-keyboard",
        approvalCacheKey: options.snapshotApprovalCacheKey,
        approvalMemory: options.snapshotApprovalMemory,
        durableApprovalRecordAllowed: options.durableApprovalRecordAllowed ?? true,
        persistentAllowAllowed: options.persistentAllowAllowed ?? options.snapshotVerdict !== "high",
        workingDirectoryIdentity: options.workingDirectoryIdentity ?? "a".repeat(64),
        verdictAtApproval: options.snapshotVerdict ?? "medium",
      })),
    },
    auditLogger: {
      log: vi.fn(),
      isPermissionAuditChainReady: vi.fn(() => options.auditReady ?? true),
      appendPermissionAuditEntry: vi.fn(async (entry: Record<string, unknown>) => {
        if (options.auditAppendError) throw options.auditAppendError;
        return {
          ...entry,
          prevHash: "h",
        };
      }),
      getAuditDir: vi.fn(() => mkdtempSync(join(tmpdir(), "ave-permission-audit-"))),
      getPermissionAuditSecret: vi.fn(() => "secret"),
      getPermissionAuditSealStore: vi.fn(() => undefined),
    },
    toolRegistry: {
      setDenyRules: vi.fn(),
    },
    rewireReviewerAgent: vi.fn(),
    getMainWindow: vi.fn(() => appWindows[0]),
    getAppWindows: vi.fn(() => appWindows),
    askUserQuestionGate,
  };
  // The lifecycle is no longer a dep field: `ipc/domains/workspace.ts` publishes the one instance and every consumer resolves it through the authority.
  setWorkspaceRootLifecycle(
    options.workspaceLifecycleAvailable === false ? undefined : workspaceRootLifecycle,
  );
  return { deps, permissionManager, appWindows, workspaceRootLifecycle, askUserQuestionGate };
}

async function setup(options: Parameters<typeof makeDeps>[0] = {}) {
  handlers.clear();
  vi.clearAllMocks();
  askDeferredEntry = null;
  const { deps, permissionManager, appWindows, workspaceRootLifecycle, askUserQuestionGate } =
    makeDeps(options);
  const { registerPermissionsHandlers } = await import("../permissions.js");
  registerPermissionsHandlers(deps as never);
  nativeApprovalEvent = { sender: appWindows[0].webContents, senderFrame: appWindows[0].webContents.mainFrame } as unknown as ReturnType<typeof hostFrameEvent>;
  return { deps, permissionManager, appWindows, workspaceRootLifecycle, askUserQuestionGate };
}

beforeEach(() => {
  handlers.clear();
  recordApprovalMock.mockClear();
  readWindowsStatusMock.mockReset();
});

describe("permissions IPC handlers", () => {
  it("returns a typed Windows helper diagnostic unchanged and propagates internal status errors", async () => {
    await setup();
    const diagnostic = {
      applicable: true, userState: null, wfpState: null, ready: false,
      helperError: "srt-win-not-found", instructions: "",
    };
    readWindowsStatusMock.mockResolvedValueOnce(diagnostic);
    await expect(invoke(PERMISSIONS.sandboxWindowsStatus)).resolves.toEqual(diagnostic);

    const error = new Error("status invariant failed");
    readWindowsStatusMock.mockRejectedValueOnce(error);
    await expect(invoke(PERMISSIONS.sandboxWindowsStatus)).rejects.toBe(error);
  });

  it("setMode persists internal durable mode changes with audit but no approval prompt", async () => {
    const { deps, permissionManager } = await setup({ approvalChoice: "allow-once" });

    const result = await invoke(PERMISSIONS.setMode, { mode: "auto", intent: USER_INTENT });

    expect(result).toEqual({ ok: true, mode: "auto" });
    expect(deps.approvalGate.requestAndWait).not.toHaveBeenCalled();
    expect(permissionManager.setModePersist).toHaveBeenCalledWith("auto");
    expect(deps.auditLogger.appendPermissionAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "mode_change",
        fromMode: "default",
        toMode: "auto",
        durable: true,
        confirmationSource: "settings-ui",
      }),
    );
  });

  it("broadcasts successful durable mode changes to all app windows", async () => {
    const { appWindows } = await setup({ approvalChoice: "allow-once" });

    await invoke(PERMISSIONS.setMode, { mode: "auto", intent: USER_INTENT });

    for (const win of appWindows) {
      expect(win.webContents.send).toHaveBeenCalledWith(PERMISSIONS.modeChanged, { mode: "auto" });
    }
  });

  it("setMode ignores approval denial because built-in settings changes do not request approval", async () => {
    const { permissionManager } = await setup({ approvalChoice: "deny-once" });

    const result = await invoke(PERMISSIONS.setMode, { mode: "strict", intent: USER_INTENT });

    expect(result).toEqual({ ok: true, mode: "strict" });
    expect(permissionManager.setModePersist).toHaveBeenCalledWith("strict");
  });

  it("setMode rejects a foreign/invalid sender frame with UNAUTHORIZED_FRAME", async () => {
    const { permissionManager } = await setup({ approvalChoice: "allow-once" });

    const result = await invokeRegisteredHandlerWithEvent(handlers,
      PERMISSIONS.setMode,
      makeForeignEvent(),
      { mode: "auto", intent: USER_INTENT },
    );

    expect(result).toEqual(UNAUTHORIZED_FRAME);
    expect(permissionManager.setModePersist).not.toHaveBeenCalled();
  });

  it("setMode rejects a request missing user-keyboard intent (mirrors addRule)", async () => {
    const { permissionManager } = await setup({ approvalChoice: "allow-once" });

    const result = await invoke(PERMISSIONS.setMode, { mode: "auto" });

    expect(result).toMatchObject({ ok: false, error: "user-keyboard-required" });
    expect(permissionManager.setModePersist).not.toHaveBeenCalled();
  });

  it("setMode fails closed before persisting when permission audit append fails", async () => {
    const { permissionManager } = await setup({
      approvalChoice: "allow-once",
      auditAppendError: new Error("audit disk full"),
    });

    const result = await invoke(PERMISSIONS.setMode, { mode: "auto", intent: USER_INTENT });

    expect(result).toMatchObject({ ok: false, error: "permission-audit-write-failed" });
    expect(permissionManager.setModePersist).not.toHaveBeenCalled();
  });

  it("suggests LLM permission review after repeated default-mode approvals", async () => {
    const { appWindows } = await setup({
      mode: "default",
      interactiveAutoApprove: "off",
      hasReviewer: false,
    });

    await invoke(PERMISSIONS.approvalRespond, { requestId: "approval-1", choice: "allow-once" });
    await invoke(PERMISSIONS.approvalRespond, { requestId: "approval-2", choice: "allow-session" });
    await invoke(PERMISSIONS.approvalRespond, { requestId: "approval-3", choice: "allow-once" });

    for (const win of appWindows) {
      expect(win.webContents.send).toHaveBeenCalledWith(PERMISSIONS.reviewSuggestion, {
        reason: "repeat-allow",
        allowCount: 3,
        allowAlwaysCount: 0,
        threshold: 3,
        windowMs: 300000,
      });
    }
  });

  it("accepts only a registered app window main-frame response as native", async () => {
    const { deps, appWindows } = await setup();
    const fn = handlers.get(PERMISSIONS.approvalRespond)!;
    const sender = appWindows[0].webContents;
    const frame = { url: "file:///application/index.html" };
    Object.assign(sender, { mainFrame: frame });
    const decision = { requestId: "host-approval", choice: "allow-once" };
    await fn({ sender, senderFrame: frame }, decision);
    expect(deps.approvalGate.resolveFromDesktopRenderer).toHaveBeenCalledWith("host-approval", decision, sender);
    expect(deps.approvalGate.resolve).not.toHaveBeenCalled();
    deps.approvalGate.resolveFromDesktopRenderer.mockClear();
    expect(await fn({ sender, senderFrame: { url: frame.url } }, decision)).toEqual(UNAUTHORIZED_FRAME);
    expect(await fn({ sender: { ...sender, mainFrame: frame }, senderFrame: frame }, decision)).toEqual(UNAUTHORIZED_FRAME);
    expect(deps.approvalGate.resolveFromDesktopRenderer).not.toHaveBeenCalled();
    expect(deps.approvalGate.resolve).not.toHaveBeenCalled();
    expect(deps.auditLogger.log.mock.calls.filter(([entry]) => entry.sessionId === "ipc-guard")).toHaveLength(2);
  });

  it("passes a registered main-frame recipient to pending-card filtering", async () => {
    const { deps, appWindows } = await setup();
    expect(await invoke(PERMISSIONS.approvalPending)).toEqual([]);
    expect(deps.approvalGate.listPendingRendererRequests).toHaveBeenCalledWith(appWindows[0].webContents);
    deps.approvalGate.listPendingRendererRequests.mockClear();
    const handler = handlers.get(PERMISSIONS.approvalPending)!;
    const sender = appWindows[0].webContents;
    expect(await handler({ sender, senderFrame: { url: sender.mainFrame.url } })).toEqual(UNAUTHORIZED_FRAME);
    expect(await handler({ sender: { ...sender }, senderFrame: sender.mainFrame })).toEqual(UNAUTHORIZED_FRAME);
    expect(deps.approvalGate.listPendingRendererRequests).not.toHaveBeenCalled();
    expect(deps.auditLogger.log.mock.calls.filter(([entry]) => entry.sessionId === "ipc-guard")).toHaveLength(2);
  });

  it("suggests LLM permission review immediately after allow-always in default mode", async () => {
    const { appWindows } = await setup({
      mode: "default",
      interactiveAutoApprove: "off",
      hasReviewer: false,
    });

    await invoke(PERMISSIONS.approvalRespond, { requestId: "approval-always", choice: "allow-always" });

    for (const win of appWindows) {
      expect(win.webContents.send).toHaveBeenCalledWith(PERMISSIONS.reviewSuggestion, {
        reason: "allow-always",
        allowCount: 1,
        allowAlwaysCount: 1,
        threshold: 3,
        windowMs: 300000,
      });
    }
  });

  it("does not suggest review switching when ApprovalGate forces the response to deny", async () => {
    const { deps, appWindows } = await setup({
      mode: "default",
      interactiveAutoApprove: "off",
      hasReviewer: false,
    });
    deps.approvalGate.resolveFromDesktopRenderer.mockReturnValueOnce({
      requestId: "approval-forced-deny",
      choice: "deny-once",
      rememberPattern: "approval integrity check failed",
    });

    await invoke(PERMISSIONS.approvalRespond, {
      requestId: "approval-forced-deny",
      choice: "allow-always",
    });

    for (const win of appWindows) {
      expect(win.webContents.send).not.toHaveBeenCalledWith(
        PERMISSIONS.reviewSuggestion,
        expect.anything(),
      );
    }
  });

  it("does not suggest review switching when LLM auto-review is already active", async () => {
    const { appWindows } = await setup({
      mode: "default",
      interactiveAutoApprove: "low",
      hasReviewer: true,
    });

    await invoke(PERMISSIONS.approvalRespond, { requestId: "approval-active", choice: "allow-always" });

    for (const win of appWindows) {
      expect(win.webContents.send).not.toHaveBeenCalledWith(
        PERMISSIONS.reviewSuggestion,
        expect.anything(),
      );
    }
  });

  it("addRule and removeRule mutate only through parsed rule commands", async () => {
    const { deps, permissionManager } = await setup();

    await invoke(PERMISSIONS.addRule, {
      pattern: "write_file:path:/tmp/a.md",
      action: "allow",
      intent: USER_INTENT,
    });
    await invoke(PERMISSIONS.removeRule, {
      pattern: "write_file:path:/tmp/a.md",
      action: "allow",
      intent: USER_INTENT,
    });

    expect(permissionManager.addAlwaysAllowedPersist).toHaveBeenCalledWith("write_file:path:/tmp/a.md");
    expect(permissionManager.removeRule).toHaveBeenCalledWith("write_file:path:/tmp/a.md", "allow");
    expect(deps.toolRegistry.setDenyRules).toHaveBeenCalledTimes(2);
  });

  it("dirDispatch applies session additions returned by the slash command", async () => {
    const { deps } = await setup();
    const dir = mkdtempSync(join(tmpdir(), "ave-session-dir-"));
    try {
      const result = await invoke(PERMISSIONS.dirDispatch, {
        rawArgs: `allow --session ${dir}`,
        intent: USER_INTENT,
      });

      expect(result).toMatchObject({ ok: true, verb: "allow", sessionOnly: true });
      expect(deps.conversationLoop.addSessionAdditionalDirectory).toHaveBeenCalledWith(
        (result as { sessionDirectory: string }).sessionDirectory,
      );
    } finally {
      await cleanupTmpDir(dir);
    }
  });

  it("dirDispatch routes persistent Settings allow and deny through the workspace lifecycle", async () => {
    const { workspaceRootLifecycle } = await setup();
    const dir = mkdtempSync(join(tmpdir(), "ave-persisted-dir-"));

    try {
      const allowed = await invoke(PERMISSIONS.dirDispatch, {
        rawArgs: `allow ${dir}`,
        intent: USER_INTENT,
      });

      expect(allowed).toMatchObject({
        ok: true,
        verb: "allow",
        sessionOnly: false,
      });
      expect(workspaceRootLifecycle.allowDirectory).toHaveBeenCalledWith(
        (allowed as { persisted: string[] }).persisted[0],
        "permission-slash",
      );

      const denied = await invoke(PERMISSIONS.dirDispatch, {
        rawArgs: `deny ${dir}`,
        intent: USER_INTENT,
      });

      expect(denied).toMatchObject({ ok: true, verb: "deny" });
      expect(workspaceRootLifecycle.denyDirectory).toHaveBeenCalledWith(
        dir,
        "permission-slash",
      );
    } finally {
      await cleanupTmpDir(dir);
    }
  });

  it("dirDispatch fails closed when the persistent workspace lifecycle is unavailable", async () => {
    await setup({ workspaceLifecycleAvailable: false });
    const dir = mkdtempSync(join(tmpdir(), "ave-missing-lifecycle-"));

    try {
      const result = await invoke(PERMISSIONS.dirDispatch, {
        rawArgs: `allow ${dir}`,
        intent: USER_INTENT,
      });

      expect(result).toEqual({
        ok: false,
        error: "workspace lifecycle unavailable",
      });
    } finally {
      await cleanupTmpDir(dir);
    }
  });

  it("permission mutations reject missing user-keyboard intent", async () => {
    await setup();

    const result = await invoke(PERMISSIONS.addRule, {
      pattern: "write_file:path:/tmp/a.md",
      action: "allow",
    });

    expect(result).toMatchObject({ ok: false, error: "user-keyboard-required" });
  });

  it("refuses broad or irreversible allow rules before persisting", async () => {
    const { permissionManager } = await setup();
    expect(await invoke(PERMISSIONS.addRule, { pattern: "Bash(git *)", action: "allow", intent: USER_INTENT }))
      .toMatchObject({ ok: false, error: "invalid-rule", message: expect.stringContaining("refused allow prefix") });
    expect(await invoke(PERMISSIONS.addRule, { pattern: "Bash(git push --force)", action: "allow", intent: USER_INTENT }))
      .toMatchObject({ ok: false, error: "invalid-rule" });
    expect(permissionManager.addRulePersist).not.toHaveBeenCalled();
    expect(await invoke(PERMISSIONS.addRule, { pattern: "Bash(make build)", action: "allow", intent: USER_INTENT })).toMatchObject({ ok: true });
    expect(permissionManager.addRulePersist).toHaveBeenCalledWith({ pattern: "Bash(make build)", action: "allow" }, { kind: "user" });
  });

  it("reviewerDispatch rejects invalid reviewer slash grammar without mutating local deps", async () => {
    const { permissionManager } = await setup();

    const result = await invoke(PERMISSIONS.reviewerDispatch, { rawArgs: "mode unknown" });

    expect(result).toMatchObject({ ok: false });
    expect(permissionManager.setModePersist).not.toHaveBeenCalled();
  });

  it("reviewerDispatch show does not rewire reviewer runtime", async () => {
    const { deps } = await setup();

    const result = await invoke(PERMISSIONS.reviewerDispatch, { rawArgs: "show" });

    expect(result).toMatchObject({ ok: true, verb: "show" });
    expect(deps.rewireReviewerAgent).not.toHaveBeenCalled();
  });

  it("reviewerDispatch rejects valid mutations without user-keyboard intent", async () => {
    const { deps } = await setup();

    const result = await invoke(PERMISSIONS.reviewerDispatch, { rawArgs: "mode rule" });

    expect(result).toMatchObject({ ok: false, error: "user-keyboard-required" });
    expect(deps.rewireReviewerAgent).not.toHaveBeenCalled();
  });

  it("reviewerDispatch restores reviewer settings when runtime rewire fails", async () => {
    const oldHome = process.env.HOME;
    const reviewerHome = mkdtempSync(join(tmpdir(), "ave-reviewer-ipc-home-"));
    try {
      process.env.HOME = reviewerHome;
      const { deps } = await setup();
      await invoke(PERMISSIONS.reviewerDispatch, {
        rawArgs: "mode rule",
        intent: USER_INTENT,
      });
      deps.rewireReviewerAgent.mockImplementation(() => {
        throw new Error("rewire failed");
      });

      const result = await invoke(PERMISSIONS.reviewerDispatch, {
        rawArgs: "mode llm",
        intent: USER_INTENT,
      });
      const current = await invoke(PERMISSIONS.reviewerDispatch, { rawArgs: "show" });

      expect(result).toMatchObject({
        ok: false,
        error: expect.stringContaining("reviewer-rewire-failed"),
      });
      expect(current).toMatchObject({
        ok: true,
        settings: expect.objectContaining({ mode: "rule" }),
      });
      expect(deps.rewireReviewerAgent).toHaveBeenCalledTimes(3);
    } finally {
      if (oldHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = oldHome;
      }
      await cleanupTmpDir(reviewerHome);
    }
  });

  it("deferredResolve rejects missing user-keyboard intent before queue lookup", async () => {
    const entry = makeDeferredEntry();
    const queue = {
      get: vi.fn(() => entry),
      resolve: vi.fn(async () => ({ ...entry, status: "approved", resolvedAt: "2026-05-10T00:00:01Z" })),
    };
    const { deps } = await setup({ queue });

    const result = await invoke(PERMISSIONS.deferredResolve, {
      id: "deferred-1",
      decision: "approved",
    });

    expect(result).toMatchObject({ ok: false, error: "user-keyboard-required" });
    expect(queue.get).not.toHaveBeenCalled();
    expect(queue.resolve).not.toHaveBeenCalled();
    expect(deps.auditLogger.appendPermissionAuditEntry).not.toHaveBeenCalled();
  });

  it.each(["approved", "rejected"] as const)(
    "deferredResolve audits before queue mutation on %s",
    async (decision) => {
      const entry = makeDeferredEntry();
      const order: string[] = [];
      const queue = {
        get: vi.fn(() => entry),
        resolve: vi.fn(async (_id: string, status: string) => {
          order.push("resolve");
          return { ...entry, status, resolvedAt: "2026-05-10T00:00:01Z" };
        }),
      };
      const { deps } = await setup({ queue });
      deps.auditLogger.appendPermissionAuditEntry.mockImplementation(async (auditEntry: Record<string, unknown>) => {
        order.push("audit");
        return { ...auditEntry, prevHash: "h" };
      });

      const result = await invoke(PERMISSIONS.deferredResolve, {
        id: "deferred-1",
        decision,
        reason: "reviewed by user",
        approvalSource: "button",
        intent: USER_INTENT,
      });

      expect(result).toMatchObject({
        ok: true,
        entry: expect.objectContaining({ id: "deferred-1", status: decision }),
      });
      expect(order).toEqual(["audit", "resolve"]);
      expect(queue.resolve).toHaveBeenCalledWith(
        "deferred-1",
        decision,
        "reviewed by user",
        decision === "approved" ? "session" : undefined,
      );
      expect(deps.auditLogger.appendPermissionAuditEntry).toHaveBeenCalledWith(
        expect.objectContaining({
          decision: "deferred_resolve",
          resolution: decision,
          reason: "reviewed by user",
          queueId: "deferred-1",
          reviewerVerdict: entry.verdict,
          approvalSource: "button",
        }),
      );
    },
  );

  // The original call is dead by the time anyone resolves the entry, so these assert the forward-looking grant
  // — the directory reaching the permission scope — not the JSONL `status` field, which is only bookkeeping.

  it("approving a deferred entry registers its directory for the session", async () => {
    const entry = makeDeferredEntry();
    const queue = {
      get: vi.fn(() => entry),
      resolve: vi.fn(async (_id: string, status: string) => ({ ...entry, status })),
    };
    const { deps } = await setup({ queue });

    const result = await invoke(PERMISSIONS.deferredResolve, {
      id: "deferred-1",
      decision: "approved",
      approvalSource: "button",
      intent: USER_INTENT,
    });

    expect(result).toMatchObject({ ok: true });
    // The observable consequence: the next call under this directory passes Layer 1 without asking.
    expect(deps.conversationLoop.addSessionAdditionalDirectory).toHaveBeenCalledWith(
      expect.stringContaining("srv/app/data"),
    );
  });

  it("approving with scope 'always' persists the directory through the lifecycle", async () => {
    const entry = makeDeferredEntry();
    const queue = {
      get: vi.fn(() => entry),
      resolve: vi.fn(async (_id: string, status: string) => ({ ...entry, status })),
    };
    const { workspaceRootLifecycle, deps } = await setup({ queue });

    const result = await invoke(PERMISSIONS.deferredResolve, {
      id: "deferred-1",
      decision: "approved",
      approvalSource: "button",
      scope: "always",
      intent: USER_INTENT,
    });

    expect(result).toMatchObject({ ok: true });
    expect(workspaceRootLifecycle.allowDirectory).toHaveBeenCalledWith(
      expect.stringContaining("srv/app/data"),
      "permission-slash",
    );
    // A persisted grant is not also a session grant.
    expect(deps.conversationLoop.addSessionAdditionalDirectory).not.toHaveBeenCalled();
  });

  it("an omitted scope grants the narrowest breadth, never a persisted one", async () => {
    const entry = makeDeferredEntry();
    const queue = {
      get: vi.fn(() => entry),
      resolve: vi.fn(async (_id: string, status: string) => ({ ...entry, status })),
    };
    const { workspaceRootLifecycle, deps } = await setup({ queue });

    await invoke(PERMISSIONS.deferredResolve, {
      id: "deferred-1",
      decision: "approved",
      approvalSource: "button",
      intent: USER_INTENT,
    });

    expect(workspaceRootLifecycle.allowDirectory).not.toHaveBeenCalled();
    expect(deps.conversationLoop.addSessionAdditionalDirectory).toHaveBeenCalled();
  });

  it("refuses to approve an entry whose lane recorded no grant", async () => {
    // The strict-mode reviewer lane defers on an exact (tool, args, source) tuple and keeps only a redacted summary, so
    // no grant is reconstructable. Recording an approval here would tell the user their click did something it did not.
    const entry = makeDeferredEntry({ grant: undefined });
    const queue = {
      get: vi.fn(() => entry),
      resolve: vi.fn(async () => ({ ...entry, status: "approved" })),
    };
    const { deps } = await setup({ queue });

    const result = await invoke(PERMISSIONS.deferredResolve, {
      id: "deferred-1",
      decision: "approved",
      approvalSource: "button",
      intent: USER_INTENT,
    });

    expect(result).toMatchObject({ ok: false, error: "no-grant-available" });
    expect(queue.resolve).not.toHaveBeenCalled();
    expect(deps.auditLogger.appendPermissionAuditEntry).not.toHaveBeenCalled();
    expect(deps.conversationLoop.addSessionAdditionalDirectory).not.toHaveBeenCalled();
  });

  it("rejecting an entry with no grant still works — a rejection grants nothing", async () => {
    const entry = makeDeferredEntry({ grant: undefined });
    const queue = {
      get: vi.fn(() => entry),
      resolve: vi.fn(async (_id: string, status: string) => ({ ...entry, status })),
    };
    await setup({ queue });

    const result = await invoke(PERMISSIONS.deferredResolve, {
      id: "deferred-1",
      decision: "rejected",
      approvalSource: "button",
      intent: USER_INTENT,
    });

    expect(result).toMatchObject({ ok: true });
  });

  it("does not record an approval when applying the grant fails", async () => {
    // A sensitive path is refused outright by validateDirectoryAddition ("path matches sensitive pattern
    // '**/.ssh/**'"). The entry must stay pending rather than be marked approved with nothing granted.
    const entry = makeDeferredEntry({
      grant: { kind: "directory", path: "/srv/app/.ssh" },
    });
    const queue = {
      get: vi.fn(() => entry),
      resolve: vi.fn(async (_id: string, status: string) => ({ ...entry, status })),
    };
    const { deps } = await setup({ queue });

    const result = await invoke(PERMISSIONS.deferredResolve, {
      id: "deferred-1",
      decision: "approved",
      approvalSource: "button",
      intent: USER_INTENT,
    });

    expect(result).toMatchObject({ ok: false, error: "grant-failed" });
    expect(queue.resolve).not.toHaveBeenCalled();
    expect(deps.auditLogger.appendPermissionAuditEntry).not.toHaveBeenCalled();
  });

  it("holds the adjacency gate instead of acknowledging on the user's behalf", async () => {
    // Same widening gate the foreground card renders as a warning checkbox. ".git" warns; ".ssh" would be a hard reject, which is a different path.
    const entry = makeDeferredEntry({
      grant: { kind: "directory", path: "/srv/app/.git" },
    });
    const queue = {
      get: vi.fn(() => entry),
      resolve: vi.fn(async (_id: string, status: string) => ({ ...entry, status })),
    };
    const { deps } = await setup({ queue });

    const blocked = await invoke(PERMISSIONS.deferredResolve, {
      id: "deferred-1",
      decision: "approved",
      approvalSource: "button",
      intent: USER_INTENT,
    });

    expect(blocked).toMatchObject({ ok: false, requiresAcknowledgement: true });
    expect(deps.conversationLoop.addSessionAdditionalDirectory).not.toHaveBeenCalled();

    const acknowledged = await invoke(PERMISSIONS.deferredResolve, {
      id: "deferred-1",
      decision: "approved",
      approvalSource: "button",
      acknowledgeWarnings: true,
      intent: USER_INTENT,
    });

    expect(acknowledged).toMatchObject({ ok: true });
    expect(deps.conversationLoop.addSessionAdditionalDirectory).toHaveBeenCalled();
  });

  it("rejects an out-of-range scope rather than coercing it", async () => {
    const entry = makeDeferredEntry();
    const queue = {
      get: vi.fn(() => entry),
      resolve: vi.fn(async () => ({ ...entry, status: "approved" })),
    };
    await setup({ queue });

    const result = await invoke(PERMISSIONS.deferredResolve, {
      id: "deferred-1",
      decision: "approved",
      approvalSource: "button",
      scope: "forever",
      intent: USER_INTENT,
    });

    expect(result).toMatchObject({ ok: false, error: "invalid-params" });
    expect(queue.resolve).not.toHaveBeenCalled();
  });

  it("deferredResolve fails closed before queue mutation when audit chain is not ready", async () => {
    const entry = makeDeferredEntry();
    const queue = {
      get: vi.fn(() => entry),
      resolve: vi.fn(async () => ({ ...entry, status: "approved", resolvedAt: "2026-05-10T00:00:01Z" })),
    };
    const { deps } = await setup({ auditReady: false, queue });

    const result = await invoke(PERMISSIONS.deferredResolve, {
      id: "deferred-1",
      decision: "approved",
      approvalSource: "button",
      intent: USER_INTENT,
    });

    expect(result).toEqual({ ok: false, error: "permission-audit-not-ready" });
    expect(queue.resolve).not.toHaveBeenCalled();
    expect(deps.auditLogger.appendPermissionAuditEntry).not.toHaveBeenCalled();
  });

  it("deferredResolve rejects a contradictory stale resolution without audit side effects", async () => {
    const entry = makeDeferredEntry({
      status: "approved",
      resolvedAt: "2026-05-10T00:00:01Z",
    });
    const queue = {
      get: vi.fn(() => entry),
      resolve: vi.fn(),
    };
    const { deps } = await setup({ queue });

    const result = await invoke(PERMISSIONS.deferredResolve, {
      id: "deferred-1",
      decision: "rejected",
      approvalSource: "button",
      intent: USER_INTENT,
    });

    expect(result).toMatchObject({
      ok: false,
      error: "already-resolved",
      entry,
    });
    expect(queue.resolve).not.toHaveBeenCalled();
    expect(deps.auditLogger.appendPermissionAuditEntry).not.toHaveBeenCalled();
  });

  it("deferredResolve rejects a concurrent second resolution before writing a conflicting audit row", async () => {
    const entry = makeDeferredEntry();
    let releaseAudit!: () => void;
    const auditStarted = new Promise<void>((resolve) => {
      releaseAudit = resolve;
    });
    const queue = {
      get: vi.fn(() => entry),
      resolve: vi.fn(async (_id: string, status: string) => ({
        ...entry,
        status,
        resolvedAt: "2026-05-10T00:00:01Z",
      })),
    };
    const { deps } = await setup({ queue });
    deps.auditLogger.appendPermissionAuditEntry.mockImplementation(async (auditEntry: Record<string, unknown>) => {
      await auditStarted;
      return { ...auditEntry, prevHash: "h" };
    });

    const first = invoke(PERMISSIONS.deferredResolve, {
      id: "deferred-1",
      decision: "approved",
      approvalSource: "button",
      intent: USER_INTENT,
    }) as Promise<unknown>;
    await new Promise((resolve) => setTimeout(resolve, 0));

    const second = await invoke(PERMISSIONS.deferredResolve, {
      id: "deferred-1",
      decision: "rejected",
      approvalSource: "button",
      intent: USER_INTENT,
    });

    expect(second).toEqual({ ok: false, error: "already-resolving" });
    expect(deps.auditLogger.appendPermissionAuditEntry).toHaveBeenCalledOnce();
    releaseAudit();
    await expect(first).resolves.toMatchObject({ ok: true });
    expect(queue.resolve).toHaveBeenCalledOnce();
  });

  it("deferredResolve reports a post-audit stale queue mutation result", async () => {
    const entry = makeDeferredEntry();
    const resolvedElsewhere = {
      ...entry,
      status: "rejected",
      resolvedAt: "2026-05-10T00:00:01Z",
    };
    const queue = {
      get: vi.fn(() => entry),
      resolve: vi.fn(async () => resolvedElsewhere),
    };
    const { deps } = await setup({ queue });

    const result = await invoke(PERMISSIONS.deferredResolve, {
      id: "deferred-1",
      decision: "approved",
      approvalSource: "button",
      intent: USER_INTENT,
    });

    expect(result).toMatchObject({
      ok: false,
      error: "already-resolved",
      entry: resolvedElsewhere,
    });
    expect(deps.auditLogger.appendPermissionAuditEntry).toHaveBeenCalledOnce();
    expect(queue.resolve).toHaveBeenCalledWith("deferred-1", "approved", undefined, "session");
  });

  it("deferredResolve reports no queue without audit side effects", async () => {
    const { deps } = await setup({ queue: null });

    const result = await invoke(PERMISSIONS.deferredResolve, {
      id: "deferred-1",
      decision: "rejected",
      approvalSource: "button",
      intent: USER_INTENT,
    });

    expect(result).toEqual({ ok: false, error: "no-deferred-queue" });
    expect(deps.auditLogger.appendPermissionAuditEntry).not.toHaveBeenCalled();
  });

  it("deferredResolve fails closed before queue mutation when audit append fails", async () => {
    const entry = makeDeferredEntry();
    const queue = {
      get: vi.fn(() => entry),
      resolve: vi.fn(async () => ({ ...entry, status: "approved", resolvedAt: "2026-05-10T00:00:01Z" })),
    };
    const { deps } = await setup({
      queue,
      auditAppendError: new Error("audit write failed"),
    });

    const result = await invoke(PERMISSIONS.deferredResolve, {
      id: "deferred-1",
      decision: "approved",
      approvalSource: "button",
      intent: USER_INTENT,
    });

    expect(result).toMatchObject({ ok: false, error: "permission-audit-write-failed" });
    expect(queue.resolve).not.toHaveBeenCalled();
    expect(deps.auditLogger.appendPermissionAuditEntry).toHaveBeenCalledOnce();
  });

  // End-to-end IPC → audit assertion that the surface the user gestured on reaches the audit chain.
  it("deferredResolve records the question-card provenance in the audit entry", async () => {
    const entry = makeDeferredEntry();
    const queue = {
      get: vi.fn(() => entry),
      resolve: vi.fn(async (_id: string, status: string) => ({
        ...entry,
        status,
        resolvedAt: "2026-05-10T00:00:01Z",
      })),
    };
    const { deps } = await setup({ queue });

    const result = await invoke(PERMISSIONS.deferredResolve, {
      id: "deferred-1",
      decision: "approved",
      approvalSource: "question-card",
      intent: USER_INTENT,
    });

    expect(result).toMatchObject({ ok: true });
    expect(deps.auditLogger.appendPermissionAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "deferred_resolve",
        resolution: "approved",
        approvalSource: "question-card",
        queueId: "deferred-1",
      }),
    );
    expect(queue.resolve).toHaveBeenCalledWith("deferred-1", "approved", undefined, "session");
  });

  // The in-chat approval chip that wrote this provenance is gone, and with it the value: an audit row may still carry it, but nothing may write one.
  it("deferredResolve refuses the retired natural-language provenance", async () => {
    const entry = makeDeferredEntry();
    const queue = { get: vi.fn(() => entry), resolve: vi.fn() };
    const { deps } = await setup({ queue });

    const result = await invoke(PERMISSIONS.deferredResolve, {
      id: "deferred-1",
      decision: "approved",
      approvalSource: "natural-language",
      intent: USER_INTENT,
    });

    expect(result).toEqual({ ok: false, error: "invalid-params" });
    expect(queue.resolve).not.toHaveBeenCalled();
    expect(deps.auditLogger.appendPermissionAuditEntry).not.toHaveBeenCalled();
  });

  it("deferredResolve rejects omitted approvalSource as invalid-params", async () => {
    const entry = makeDeferredEntry();
    const queue = {
      get: vi.fn(() => entry),
      resolve: vi.fn(async (_id: string, status: string) => ({
        ...entry,
        status,
        resolvedAt: "2026-05-10T00:00:01Z",
      })),
    };
    const { deps } = await setup({ queue });

    const result = await invoke(PERMISSIONS.deferredResolve, {
      id: "deferred-1",
      decision: "approved",
      intent: USER_INTENT,
    });

    expect(result).toEqual({ ok: false, error: "invalid-params" });
    expect(queue.get).not.toHaveBeenCalled();
    expect(queue.resolve).not.toHaveBeenCalled();
    expect(deps.auditLogger.appendPermissionAuditEntry).not.toHaveBeenCalled();
  });

  it("deferredResolve rejects an unknown approvalSource value as invalid-params", async () => {
    const entry = makeDeferredEntry();
    const queue = {
      get: vi.fn(() => entry),
      resolve: vi.fn(async () => ({ ...entry, status: "approved" })),
    };
    const { deps } = await setup({ queue });

    const result = await invoke(PERMISSIONS.deferredResolve, {
      id: "deferred-1",
      decision: "approved",
      approvalSource: "voice-assistant",
      intent: USER_INTENT,
    });

    expect(result).toEqual({ ok: false, error: "invalid-params" });
    expect(queue.resolve).not.toHaveBeenCalled();
    expect(deps.auditLogger.appendPermissionAuditEntry).not.toHaveBeenCalled();
  });
});

describe("a deferred approval is asked as a question in the tile that raised it", () => {
  function makeQueue(entry: Record<string, unknown>) {
    return {
      get: vi.fn(() => entry),
      resolve: vi.fn(async (_id: string, status: string) => ({ ...entry, status })),
    };
  }

  it("asks the conversation whose turn deferred the call", async () => {
    const entry = makeDeferredEntry({ sessionId: "session-a" });
    const { askUserQuestionGate } = await setup({ queue: makeQueue(entry) });

    askDeferredEntry?.(entry);
    await vi.waitFor(() => expect(askUserQuestionGate.ask).toHaveBeenCalledOnce());

    expect(askUserQuestionGate.ask.mock.calls[0][0]).toMatchObject({
      sessionId: "session-a",
    });
  });

  it("two conversations each get their own question, never the other's", async () => {
    const first = makeDeferredEntry({ id: "deferred-a", sessionId: "session-a" });
    const second = makeDeferredEntry({ id: "deferred-b", sessionId: "session-b" });
    const { askUserQuestionGate } = await setup({ queue: makeQueue(first) });

    askDeferredEntry?.(first);
    askDeferredEntry?.(second);
    await vi.waitFor(() => expect(askUserQuestionGate.ask).toHaveBeenCalledTimes(2));

    const asked = askUserQuestionGate.ask.mock.calls.map(
      (call) => (call[0] as unknown as { sessionId: string }).sessionId,
    );
    expect(asked).toEqual(["session-a", "session-b"]);
  });

  it("an entry raised outside a conversation is not asked", async () => {
    const entry = makeDeferredEntry();
    const { askUserQuestionGate } = await setup({ queue: makeQueue(entry) });

    askDeferredEntry?.(entry);

    expect(askUserQuestionGate.ask).not.toHaveBeenCalled();
  });

  it("approving applies the entry's grant at the narrowest breadth", async () => {
    const entry = makeDeferredEntry({ sessionId: "session-a" });
    const queue = makeQueue(entry);
    const { deps } = await setup({ queue, answerChoiceIndex: 0 });

    askDeferredEntry?.(entry);
    await vi.waitFor(() => expect(queue.resolve).toHaveBeenCalledOnce());

    expect(queue.resolve).toHaveBeenCalledWith("deferred-1", "approved", undefined, "session");
    expect(deps.auditLogger.appendPermissionAuditEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: "deferred_resolve",
        resolution: "approved",
        approvalSource: "question-card",
        grantScope: "session",
      }),
    );
  });

  it("denying rejects the entry", async () => {
    const entry = makeDeferredEntry({ sessionId: "session-a" });
    const queue = makeQueue(entry);
    await setup({ queue, answerChoiceIndex: 1 });

    askDeferredEntry?.(entry);
    await vi.waitFor(() => expect(queue.resolve).toHaveBeenCalledOnce());

    expect(queue.resolve).toHaveBeenCalledWith("deferred-1", "rejected", undefined, undefined);
  });

  it("keeping it deferred leaves the entry pending", async () => {
    const entry = makeDeferredEntry({ sessionId: "session-a" });
    const queue = makeQueue(entry);
    const { deps, askUserQuestionGate } = await setup({ queue, answerChoiceIndex: 2 });

    askDeferredEntry?.(entry);
    await vi.waitFor(() => expect(askUserQuestionGate.ask).toHaveBeenCalledOnce());

    expect(queue.resolve).not.toHaveBeenCalled();
    expect(deps.auditLogger.appendPermissionAuditEntry).not.toHaveBeenCalled();
  });

  it("an unanswered question leaves the entry pending", async () => {
    const entry = makeDeferredEntry({ sessionId: "session-a" });
    const queue = makeQueue(entry);
    const { askUserQuestionGate } = await setup({ queue });

    askDeferredEntry?.(entry);
    await vi.waitFor(() => expect(askUserQuestionGate.ask).toHaveBeenCalledOnce());

    expect(queue.resolve).not.toHaveBeenCalled();
  });

  // An approval the resolve path would refuse is not an option: an entry with no recorded grant can only be denied or left pending.
  it("offers no approval for an entry that recorded no grant", async () => {
    const entry = makeDeferredEntry({ sessionId: "session-a", grant: undefined });
    const queue = makeQueue(entry);
    const { askUserQuestionGate } = await setup({ queue, answerChoiceIndex: 0 });

    askDeferredEntry?.(entry);
    await vi.waitFor(() => expect(queue.resolve).toHaveBeenCalledOnce());

    const question = (askUserQuestionGate.ask.mock.calls[0][0] as {
      questions: { choices: string[] }[];
    }).questions[0];
    expect(question.choices).toHaveLength(2);
    expect(queue.resolve).toHaveBeenCalledWith("deferred-1", "rejected", undefined, undefined);
  });
});

// `invoke` sends the trusted host-renderer frame; these send a frame the guards must refuse, exercising the UNAUTHORIZED_FRAME path.

function makeForeignEvent(url = "https://attacker.example.com/pwn") {
  return foreignFrameEvent(url);
}

describe("policyGet exposes host-derived editability", () => {
  const base = {
    version: 1 as const,
    requireExplicitApproval: true,
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  it.each([
    ["admin-dir policy without managed:true", { ...base, managed: false, source: "admin" as const, adminPath: "/etc/ave/policy.json" }, false],
    ["merged admin+user policy without managed:true", { ...base, managed: false, source: "merged" as const, adminPath: "/etc/ave/policy.json" }, false],
    ["user policy with managed:true", { ...base, managed: true, source: "user" as const }, false],
    ["plain user policy", { ...base, managed: false, source: "user" as const }, true],
    ["no policy files", { ...base, managed: false, source: "defaults" as const }, true],
  ])("%s", async (_label, loaded, expected) => {
    await setup();
    loadPolicyMock.mockResolvedValueOnce(loaded);

    const result = await invoke(PERMISSIONS.policyGet) as { editable: boolean; source: string };

    expect(result.editable).toBe(expected);
    // The rest of the LoadedPolicy still passes through untouched.
    expect(result.source).toBe(loaded.source);
  });
});

// HIGH verdict IPC enforcement: explicit one-shot only

describe("CRITICAL-2: user-approval-record HIGH verdict IPC enforcement", () => {
  it("records a conservative HIGH display only when the live host snapshot permits persistence", async () => {
    await setup({ snapshotVerdict: "high", persistentAllowAllowed: true });
    const result = await invoke(PERMISSIONS.userApprovalRecord, {
      requestId: "req-unavailable-reviewer",
      args: '{"command":"ls"}',
      scope: "persistent",
      verdictAtApproval: "high",
      nlJustification: null,
    });
    expect(result).toMatchObject({ ok: true });
    expect(recordApprovalMock).toHaveBeenCalledWith("bash_run", '{"command":"ls"}', "user-keyboard",
      expect.objectContaining({ scope: "persistent", verdictAtApproval: "high" }));
  });

  it("records under the host-captured cache-key identity, never a renderer-supplied one", async () => {
    await setup({
      snapshotApprovalCacheKey: "web_fetch:web_fetch:host:a.example",
      snapshotApprovalMemory: {
        kind: "key",
        key: "web_fetch:origin-a",
        scope: { kind: "origin", origin: "https://a.example:443" },
      },
    });
    const result = await invoke(PERMISSIONS.userApprovalRecord, {
      requestId: "req-host-key",
      args: '{"command":"ls"}',
      scope: "session",
      verdictAtApproval: "medium",
      nlJustification: null,
      approvalCacheKey: "web_fetch:web_fetch:host:attacker.example",
    });
    expect(result).toMatchObject({ ok: true });
    expect(recordApprovalMock).toHaveBeenCalledWith("bash_run", '{"command":"ls"}', "user-keyboard",
      expect.objectContaining({
        approvalCacheKey: { key: "web_fetch:web_fetch:host:a.example", memoryKey: "web_fetch:origin-a" },
      }));
  });

  it("refuses a persistent allow for a session-only browser scope and records it for the session", async () => {
    const browserMemory = {
      kind: "key" as const,
      key: "browser_click:origin-a",
      scope: { kind: "browser-origin" as const, origin: "https://a.example:443", tabOpener: "agent" as const, tabId: "tab-1", documentId: 1 },
    };
    await setup({ snapshotApprovalCacheKey: undefined, snapshotApprovalMemory: browserMemory });
    const persistent = await invoke(PERMISSIONS.userApprovalRecord, {
      requestId: "req-browser-persistent",
      args: '{"command":"ls"}',
      scope: "persistent",
      verdictAtApproval: "medium",
      nlJustification: null,
    });
    expect(persistent).toMatchObject({ ok: false, error: "session-only-scope" });
    expect(recordApprovalMock).not.toHaveBeenCalled();

    const session = await invoke(PERMISSIONS.userApprovalRecord, {
      requestId: "req-browser-session",
      args: '{"command":"ls"}',
      scope: "session",
      verdictAtApproval: "medium",
      nlJustification: null,
    });
    expect(session).toMatchObject({ ok: true });
    expect(recordApprovalMock).toHaveBeenCalledWith("bash_run", '{"command":"ls"}', "user-keyboard",
      expect.objectContaining({ scope: "session" }));
    // A browser session allow belongs to the root conversation, like a shell one.
    expect(recordApprovalMock).toHaveBeenCalledWith("bash_run", '{"command":"ls"}', "user-keyboard",
      expect.objectContaining({ sessionId: "conversation-1" }));
  });

  it("refuses a non-shell session approval whose request names no conversation", async () => {
    const browserMemory = {
      kind: "key" as const,
      key: "browser_click:origin-a",
      scope: { kind: "browser-origin" as const, origin: "https://a.example:443", tabOpener: "agent" as const, tabId: "tab-1", documentId: 1 },
    };
    await setup({ snapshotApprovalCacheKey: undefined, snapshotApprovalMemory: browserMemory, snapshotSessionId: null });
    const result = await invoke(PERMISSIONS.userApprovalRecord, {
      requestId: "req-browser-no-session",
      args: '{"command":"ls"}',
      scope: "session",
      verdictAtApproval: "medium",
      nlJustification: null,
    });
    expect(result).toMatchObject({ ok: false, error: "missing-session" });
    expect(recordApprovalMock).not.toHaveBeenCalled();
  });

  it("refuses to record a host key that carries no remembered-identity mode", async () => {
    await setup({ snapshotApprovalCacheKey: "web_fetch:web_fetch:host:a.example" });
    const result = await invoke(PERMISSIONS.userApprovalRecord, {
      requestId: "req-key-without-mode",
      args: '{"command":"ls"}',
      scope: "session",
      verdictAtApproval: "medium",
      nlJustification: null,
    });
    expect(result).toMatchObject({ ok: false, error: "managed", message: expect.stringMatching(/remembered-identity mode/) });
    expect(recordApprovalMock).not.toHaveBeenCalled();
  });

  it("does not accept a renderer claim that a non-recordable request can be remembered", async () => {
    await setup({ persistentAllowAllowed: false });
    const result = await invoke(PERMISSIONS.userApprovalRecord, {
      requestId: "req-one-shot",
      args: '{}',
      scope: "persistent",
      verdictAtApproval: "medium",
      persistentAllowAllowed: true,
      reviewerOutcome: "unavailable",
    });
    expect(result).toMatchObject({ ok: false, error: "one-shot-not-recordable" });
    expect(recordApprovalMock).not.toHaveBeenCalled();
  });

  it("requires a host-captured directory identity for every new allow", async () => {
    await setup({ persistentAllowAllowed: true, workingDirectoryIdentity: "" });
    const result = await invoke(PERMISSIONS.userApprovalRecord, {
      requestId: "missing-scope", args: '{}', scope: "persistent", verdictAtApproval: "medium",
    });
    expect(result).toMatchObject({ ok: false, error: "one-shot-not-recordable" });
    expect(recordApprovalMock).not.toHaveBeenCalled();
  });

  it("keeps an exact persistent rejection independent of the current directory", async () => {
    await setup({ workingDirectoryIdentity: "a".repeat(64) });
    const result = await invoke(PERMISSIONS.userApprovalRecord, {
      requestId: "req-global-exact-deny", args: '{}', decision: "deny",
      scope: "persistent", verdictAtApproval: "medium",
    });
    expect(result).toMatchObject({ ok: true });
    const entry = (recordApprovalMock.mock.calls as unknown as [string, string, string, Record<string, unknown>][])[0]?.[3];
    expect(entry).toMatchObject({ decision: "deny" });
    expect(entry).not.toHaveProperty("workingDirectoryIdentity");
    expect(entry).not.toHaveProperty("riskCeilingAtApproval");
  });

  it.each([
    ["session", null],
    ["session", "권한 감사 에이전트가 생성한 사유"],
    ["persistent", "권한 감사 에이전트가 생성한 사유"],
  ] as const)("rejects HIGH exact allow memory for %s scope regardless of justification", async (scope, nlJustification) => {
    await setup({ snapshotVerdict: "high" });

    const result = await invoke(PERMISSIONS.userApprovalRecord, {
      requestId: `req-high-${scope}-${nlJustification === null ? "none" : "reason"}`,
      toolName: "bash_run",
      args: '{"command":"rm -rf /tmp"}',
      source: "user-keyboard",
      scope,
      verdictAtApproval: "high",
      nlJustification,
    });

    expect(result).toMatchObject({ ok: false, error: "high-is-one-shot" });
    expect(recordApprovalMock).not.toHaveBeenCalled();
  });

  it("allows MEDIUM verdict with persistent scope (no HIGH restriction)", async () => {
    await setup();

    const result = await invoke(PERMISSIONS.userApprovalRecord, {
      requestId: "req-test-5",
      toolName: "bash_run",
      args: '{"command":"ls"}',
      source: "user-keyboard",
      scope: "persistent",
      verdictAtApproval: "medium",
      nlJustification: null,
    });

    expect(result).toMatchObject({ ok: true });
  });

  it("records a persistent exact deny without turning it into a HIGH approval", async () => {
    await setup({ snapshotArgs: { command: "rm build.tmp" }, snapshotVerdict: "high" });

    const result = await invoke(PERMISSIONS.userApprovalRecord, {
      requestId: "req-exact-deny",
      toolName: "renderer-spoofed-tool",
      args: '{"renderer":"spoofed"}',
      source: "plugin",
      decision: "deny",
      scope: "persistent",
      verdictAtApproval: "high",
      nlJustification: null,
    });

    expect(result).toMatchObject({ ok: true });
    expect(recordApprovalMock).toHaveBeenCalledWith(
      "bash_run",
      '{"command":"rm build.tmp"}',
      "user-keyboard",
      expect.objectContaining({ decision: "deny", scope: "persistent" }),
    );
  });

  it("rejects a non-persistent exact deny", async () => {
    await setup();
    const result = await invoke(PERMISSIONS.userApprovalRecord, {
      requestId: "req-exact-deny-session",
      toolName: "bash_run",
      args: '{"command":"ls"}',
      source: "user-keyboard",
      decision: "deny",
      scope: "session",
      verdictAtApproval: "medium",
      nlJustification: null,
    });
    expect(result).toMatchObject({ ok: false, error: "deny-requires-persistent-scope" });
    expect(recordApprovalMock).not.toHaveBeenCalled();
  });

  it("rejects a one-shot approval record at the Host boundary", async () => {
    await setup({ durableApprovalRecordAllowed: false });

    const result = await invoke(PERMISSIONS.userApprovalRecord, {
      requestId: "req-one-shot",
      toolName: "portal_checkin_write",
      args: '{"operation":"clock"}',
      source: "plugin",
      scope: "session",
      verdictAtApproval: "medium",
      nlJustification: null,
    });

    expect(result).toMatchObject({
      ok: false,
      error: "one-shot-not-recordable",
    });
    expect(recordApprovalMock).not.toHaveBeenCalled();
  });

  it("ignores spoofed renderer args and records the host-bound input", async () => {
    await setup({ snapshotVerdict: "low" });

    const result = await invoke(PERMISSIONS.userApprovalRecord, {
      requestId: "req-test-6",
      toolName: "bash_run",
      args: "not valid json",
      source: "user-keyboard",
      scope: "session",
      verdictAtApproval: "low",
    });

    expect(result).toMatchObject({ ok: true });
    expect(recordApprovalMock).toHaveBeenCalledWith(
      "bash_run",
      '{"command":"ls"}',
      "user-keyboard",
      expect.objectContaining({ decision: "allow" }),
    );
  });

  it("rejects a renderer attempt to downgrade the host verdict", async () => {
    await setup({ snapshotVerdict: "high" });

    const result = await invoke(PERMISSIONS.userApprovalRecord, {
      requestId: "req-verdict-downgrade",
      toolName: "bash_run",
      args: '{"command":"rm -rf build"}',
      source: "user-keyboard",
      scope: "persistent",
      verdictAtApproval: "medium",
      nlJustification: null,
    });

    expect(result).toMatchObject({ ok: false, error: "verdict-mismatch" });
    expect(recordApprovalMock).not.toHaveBeenCalled();
  });

  it("rejects a non-object host-bound input with args-not-object error", async () => {
    await setup({ snapshotArgs: "just a string", snapshotVerdict: "low" });

    const result = await invoke(PERMISSIONS.userApprovalRecord, {
      requestId: "req-test-7",
      toolName: "bash_run",
      args: '{"renderer":"cannot-replace-host-input"}',
      source: "user-keyboard",
      scope: "session",
      verdictAtApproval: "low",
    });

    expect(result).toMatchObject({
      ok: false,
      error: "args-not-object",
    });
    expect(recordApprovalMock).not.toHaveBeenCalled();
  });
});

// These channels changed the host's permission state, so they must refuse anything that is not the host renderer. A plugin UI shell is also a `file://` frame; the base `validateSender` accepts it; so the stronger
// `validateHostRendererSender` is what actually turns it away. A frameless event (Electron nulls `senderFrame` once the sending frame is destroyed or navigated away between `invoke` and handler execution) is refused too: an unprovable sender is not a trusted one.

describe("state-mutating permission channels refuse non-host frames", () => {
  const MUTATING: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    [PERMISSIONS.setMode, { mode: "auto", intent: USER_INTENT }],
    [PERMISSIONS.addRule, { pattern: "write_file:path:/tmp/a.md", action: "allow", intent: USER_INTENT }],
    [PERMISSIONS.removeRule, { pattern: "write_file:path:/tmp/a.md", action: "allow", intent: USER_INTENT }],
    [PERMISSIONS.removeScopedRule, { pattern: "Bash(ls *)", action: "allow", scope: "user", intent: USER_INTENT }],
    [PERMISSIONS.approvalRespond, { requestId: "approval-1", choice: "allow-once" }],
    [PERMISSIONS.policySet, { patch: { requireExplicitApproval: false }, intent: USER_INTENT }],
    [PERMISSIONS.egressGrantRevoke, { scope: "always", host: "github.com", port: 443, intent: USER_INTENT }],
    [PERMISSIONS.upstreamProxySet, { mode: "off", intent: USER_INTENT }],
    [
      PERMISSIONS.userApprovalRecord,
      {
        requestId: "req-frame-guard",
        toolName: "bash_run",
        args: '{"command":"echo hi"}',
        source: "user-keyboard",
        scope: "session",
        verdictAtApproval: "low",
        intent: USER_INTENT,
      },
    ],
  ];

  it.each(MUTATING)("%s refuses a plugin-ui-shell frame", async (channel, payload) => {
    const { deps, permissionManager } = await setup();

    const result = await invokeRegisteredHandlerWithEvent(handlers, channel, pluginShellFrameEvent(), payload);

    expect(result).toEqual(UNAUTHORIZED_FRAME);
    expect(permissionManager.setModePersist).not.toHaveBeenCalled();
    expect(permissionManager.addAlwaysAllowedPersist).not.toHaveBeenCalled();
    expect(permissionManager.removeRule).not.toHaveBeenCalled();
    expect(recordApprovalMock).not.toHaveBeenCalled();
    expect(deps.approvalGate.resolve).not.toHaveBeenCalled();
  });

  it.each(MUTATING)("%s refuses an event whose sender frame is gone", async (channel, payload) => {
    const { permissionManager } = await setup();

    const result = await invokeRegisteredHandlerWithEvent(handlers, channel, framelessEvent(), payload);

    expect(result).toEqual(UNAUTHORIZED_FRAME);
    expect(permissionManager.setModePersist).not.toHaveBeenCalled();
    expect(permissionManager.addAlwaysAllowedPersist).not.toHaveBeenCalled();
    expect(recordApprovalMock).not.toHaveBeenCalled();
  });

  it("still accepts the host renderer frame on the same channels", async () => {
    const { permissionManager } = await setup();

    const result = await invokeRegisteredHandlerWithEvent(handlers,
      PERMISSIONS.setMode,
      hostFrameEvent(),
      { mode: "auto", intent: USER_INTENT },
    );

    expect(result).toEqual({ ok: true, mode: "auto" });
    expect(permissionManager.setModePersist).toHaveBeenCalledWith("auto");
  });
});


describe("command rules recorded from live approvals", () => {
  // Owner 2026-10-25 (five-choice shell card): the renderer names only a save scope; the host stores the exact rule it derived.
  const exactRule = "Bash(git status --short)";
  const body = { requestId: "live-shell", args: "{}", scope: "persistent", verdictAtApproval: "medium", nlJustification: null, rule: { scope: "project" } };
  const shellRule = { exactRule, projectCwd: "/srv/project", projectRoot: "/srv/project", persistentAllowed: true, sessionAllowed: true };

  it("writes only the host's exact project rule and never also records an exact decision", async () => {
    const { deps } = await setup({ shellRule, snapshotArgs: { command: "git status --short" } });
    const result = await invoke(PERMISSIONS.userApprovalRecord, { ...body, projectCwd: "/different/project" });
    expect(result).toMatchObject({ ok: true });
    expect(deps.conversationLoop.permissionManager.addRulePersist).toHaveBeenCalledWith({ pattern: exactRule, action: "allow" }, { kind: "project", projectCwd: "/srv/project" });
    expect(recordApprovalMock).not.toHaveBeenCalled();
    expect(deps.auditLogger.log).toHaveBeenCalledWith({
      timestamp: expect.any(String), sessionId: "conversation-1", type: "approval",
      output: `[approval:remembered] store=rules decision=allow scope=project rule=${JSON.stringify(exactRule)} toolName="bash_run" source="user-keyboard"`,
    });
  });

  it("writes the exact rule to the user-global rules for Always", async () => {
    const { deps } = await setup({ shellRule, snapshotArgs: { command: "git status --short" } });
    expect(await invoke(PERMISSIONS.userApprovalRecord, { ...body, rule: { scope: "always" } })).toMatchObject({ ok: true });
    expect(deps.conversationLoop.permissionManager.addRulePersist).toHaveBeenCalledWith({ pattern: exactRule, action: "allow" }, { kind: "user" });
  });

  it("holds the exact rule for This session in the conversation, never on disk", async () => {
    const { deps } = await setup({ shellRule, snapshotArgs: { command: "git status --short" } });
    expect(await invoke(PERMISSIONS.userApprovalRecord, { ...body, scope: "session", rule: { scope: "session" } })).toMatchObject({ ok: true });
    expect(deps.conversationLoop.permissionManager.addSessionShellRule).toHaveBeenCalledWith("conversation-1", exactRule);
    expect(deps.conversationLoop.permissionManager.addRulePersist).not.toHaveBeenCalled();
    expect(recordApprovalMock).not.toHaveBeenCalled();
  });

  it.each([
    [{ scope: "project", pattern: "Bash(git status *)" }, "persistent"],
    [{ scope: "project", pattern: exactRule }, "persistent"],
    [{ scope: "user" }, "persistent"],
    [{ scope: "workspace" }, "persistent"],
    [{ scope: "conversation" }, "session"],
    [{ scope: "session" }, "persistent"],
    [{ scope: "always" }, "session"],
    [{}, "persistent"],
  ])("refuses a renderer pattern, an unknown or mismatched scope: %j (%s)", async (rule, scope) => {
    const { deps } = await setup({ shellRule, snapshotArgs: { command: "git status --short" } });
    expect(await invoke(PERMISSIONS.userApprovalRecord, { ...body, scope, rule })).toMatchObject({ ok: false, error: "invalid-rule" });
    expect(deps.conversationLoop.permissionManager.addRulePersist).not.toHaveBeenCalled();
    expect(deps.conversationLoop.permissionManager.addSessionShellRule).not.toHaveBeenCalled();
    expect(recordApprovalMock).not.toHaveBeenCalled();
  });

  it("refuses a rule decision that is not an allow", async () => {
    const { deps } = await setup({ shellRule, snapshotArgs: { command: "git status --short" } });
    expect(await invoke(PERMISSIONS.userApprovalRecord, { ...body, decision: "deny" })).toMatchObject({ ok: false, error: "invalid-rule" });
    expect(deps.conversationLoop.permissionManager.addRulePersist).not.toHaveBeenCalled();
  });

  it("refuses a host rule that no longer covers the live command exactly", async () => {
    const { deps } = await setup({ shellRule: { ...shellRule, exactRule: "Bash(git status *)" }, snapshotArgs: { command: "git status --short" } });
    expect(await invoke(PERMISSIONS.userApprovalRecord, body)).toMatchObject({ ok: true });
    expect(deps.conversationLoop.permissionManager.addRulePersist).toHaveBeenCalledWith({ pattern: "Bash(git status *)", action: "allow" }, expect.anything());
    deps.conversationLoop.permissionManager.addRulePersist.mockClear();
    await setup({ shellRule: { ...shellRule, exactRule: "Bash(git push)" }, snapshotArgs: { command: "git status --short" } });
    expect(await invoke(PERMISSIONS.userApprovalRecord, body)).toMatchObject({ ok: false, error: "invalid-rule" });
  });

  it("reports a storage failure apart from an invalid rule", async () => {
    const { deps } = await setup({ shellRule, snapshotArgs: { command: "git status --short" } });
    deps.conversationLoop.permissionManager.addRulePersist.mockRejectedValueOnce(new Error("permissions.json is corrupt"));
    expect(await invoke(PERMISSIONS.userApprovalRecord, body)).toMatchObject({ ok: false, error: "rule-save-failed", message: "permissions.json is corrupt" });
    expect(deps.auditLogger.log).not.toHaveBeenCalledWith(expect.objectContaining({ type: "approval" }));
  });

  it.each(["session", "project", "always"])("refuses %s when the host offered no saveable rule", async (ruleScope) => {
    const { deps } = await setup({ shellRule: { ...shellRule, exactRule: null, persistentAllowed: false, sessionAllowed: false }, snapshotArgs: { command: "git status --short" } });
    expect(await invoke(PERMISSIONS.userApprovalRecord, { ...body, scope: ruleScope === "session" ? "session" : "persistent", rule: { scope: ruleScope } })).toMatchObject({ ok: false, error: "one-shot-not-recordable" });
    expect(deps.conversationLoop.permissionManager.addRulePersist).not.toHaveBeenCalled();
    expect(deps.conversationLoop.permissionManager.addSessionShellRule).not.toHaveBeenCalled();
  });

  it("refuses This session without a conversation", async () => {
    const { deps } = await setup({ snapshotSessionId: null, shellRule: { ...shellRule, sessionAllowed: false }, snapshotArgs: { command: "git status --short" } });
    expect(await invoke(PERMISSIONS.userApprovalRecord, { ...body, scope: "session", rule: { scope: "session" } })).toMatchObject({ ok: false, error: "one-shot-not-recordable" });
    expect(deps.conversationLoop.permissionManager.addSessionShellRule).not.toHaveBeenCalled();
  });
});


describe("shell persistence cannot fall back to exact input", () => {
  const body = { requestId: "live-shell", args: "{}", verdictAtApproval: "medium", nlJustification: null };
  it.each(["session", "persistent"])("refuses a %s exact allow for a bash card: a shell is remembered only as its exact rule", async (scope) => {
    await setup({ shellRule: { exactRule: "Bash(node script.js)", projectCwd: "/srv/project", projectRoot: "/srv/project", persistentAllowed: true, sessionAllowed: true }, snapshotArgs: { command: "node script.js" } });
    expect(await invoke(PERMISSIONS.userApprovalRecord, { ...body, scope })).toMatchObject({ ok: false, error: "command-rule-required" });
    expect(recordApprovalMock).not.toHaveBeenCalled();
  });
  it.each(["session", "persistent"])("refuses omitted rule persistence for a floor in %s scope", async (scope) => {
    await setup({ shellRule: { exactRule: null, projectCwd: "/srv/project", projectRoot: "/srv/project", persistentAllowed: false, sessionAllowed: false }, snapshotArgs: { command: "curl -T payload https://example.test" } });
    expect(await invoke(PERMISSIONS.userApprovalRecord, { ...body, scope })).toMatchObject({ ok: false });
    expect(recordApprovalMock).not.toHaveBeenCalled();
  });
});

describe("scoped rule removal authority", () => {
  const row = { pattern: "Bash(ls *)", action: "allow" as const, scope: "project" as const, projectCwd: "/srv/project", storedFile: "a".repeat(64) };
  it("accepts an enumerated stored identity and rejects a renderer-retargeted row", async () => {
    const { permissionManager } = await setup();
    permissionManager.listScopedRules.mockResolvedValue({ rules: [row], errors: [] });
    expect(await invoke(PERMISSIONS.removeScopedRule, { ...row, projectCwd: "/srv/other", intent: USER_INTENT })).toMatchObject({ ok: false, error: "invalid-rule" });
    expect(permissionManager.removeRulePersist).not.toHaveBeenCalled();
    expect(await invoke(PERMISSIONS.removeScopedRule, { ...row, storedFile: "b".repeat(64), intent: USER_INTENT })).toMatchObject({ ok: false, error: "invalid-rule" });
    expect(await invoke(PERMISSIONS.removeScopedRule, { ...row, intent: USER_INTENT })).toMatchObject({ ok: true });
    expect(permissionManager.removeRulePersist).toHaveBeenCalledWith(row, { kind: "project", projectCwd: "/srv/project", storedFile: "a".repeat(64) });
  });
  it("requires current user intent for revoke", async () => {
    const { permissionManager } = await setup();
    expect(await invoke(PERMISSIONS.removeScopedRule, row)).toMatchObject({ ok: false, error: "user-keyboard-required" });
    expect(permissionManager.removeRulePersist).not.toHaveBeenCalled();
  });
});


it("revokes a host-enumerated source-scoped rule without dropping its source", async () => {
  const { permissionManager } = await setup();
  const row = { pattern: "custom_tool", action: "deny" as const, scope: "user" as const, source: "plugin" };
  permissionManager.listScopedRules.mockResolvedValue({ rules: [row], errors: [] });
  expect(await invoke(PERMISSIONS.removeScopedRule, { ...row, intent: USER_INTENT })).toMatchObject({ ok: true });
  expect(permissionManager.removeRulePersist).toHaveBeenCalledWith(row, { kind: "user" });
});

it("lists and revokes in-memory sessions through IPC while the persistent file stays corrupt", async () => {
  const home = mkdtempSync(join(tmpdir(), "ave-session-list-"));
  vi.stubEnv("AVE_HOME", home);
  const store = await vi.importActual<typeof import("../../../permissions/user-approval-store.js")>("../../../permissions/user-approval-store.js");
  store.__resetSessionStoreForTest();
  try {
    await setup();
    await store.recordApproval("bash", "{}", "builtin", { scope: "session", verdictAtApproval: "low", nlJustification: null, sessionId: "live-conversation" });
    mkdirSync(join(home, "permissions"));
    const path = join(home, "permissions", "user-approvals.json");
    writeFileSync(path, "{broken");
    await expect(invoke(PERMISSIONS.userApprovalList)).rejects.toBeInstanceOf(store.UserApprovalStoreCorruptError);
    const rows = await invoke(PERMISSIONS.userApprovalList, { scope: "session" }) as Awaited<ReturnType<typeof store.listApprovals>>;
    expect(rows).toEqual([expect.objectContaining({ sessionId: "live-conversation", scope: "session" })]);
    expect(await invoke(PERMISSIONS.userApprovalRevoke, { key: rows[0].key, intent: USER_INTENT })).toMatchObject({ ok: true });
    expect(await invoke(PERMISSIONS.userApprovalList, { scope: "session" })).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe("{broken");
  } finally {
    store.__resetSessionStoreForTest();
    vi.unstubAllEnvs();
    cleanupTmpDir(home);
  }
});

describe("shell egress grants in Settings", () => {
  it("passes an egress-host answer's scope through to the gate unchanged", async () => {
    const { deps, appWindows } = await setup();
    const sender = appWindows[0].webContents;
    const frame = { url: "file:///application/index.html" };
    Object.assign(sender, { mainFrame: frame });
    const decision = { requestId: "egress-1", choice: "allow-once", egressScope: "workspace", nonce: "n", hmac: "h" };
    await handlers.get(PERMISSIONS.approvalRespond)!({ sender, senderFrame: frame }, decision);
    // The answering window goes to the gate: a terminal tab's ask is answered only from the window that owns the tab.
    expect(deps.approvalGate.resolveFromDesktopRenderer).toHaveBeenCalledWith("egress-1", decision, sender);
  });

  it("lists persistent grants, and reports an unreadable store as an error", async () => {
    await setup();
    const grant = { scope: "always", host: "github.com", port: 443, grantedAt: "2026-10-19T00:00:00.000Z" };
    egressRuntimeMock.listEgressGrants.mockResolvedValueOnce([grant]);
    expect(await invoke(PERMISSIONS.egressGrantsList)).toEqual({ ok: true, grants: [grant] });
    egressRuntimeMock.listEgressGrants.mockRejectedValueOnce(new Error("grant file is not valid"));
    expect(await invoke(PERMISSIONS.egressGrantsList)).toEqual({
      ok: false, error: "egress-grant-store-unreadable", message: "grant file is not valid",
    });
  });

  it("revokes exactly the named grant, closes what it let through, and audits it", async () => {
    const { deps } = await setup();
    egressRuntimeMock.revokeEgressGrant.mockResolvedValueOnce({ removed: true, closed: 2 });
    expect(await invoke(PERMISSIONS.egressGrantRevoke, {
      scope: "project", origin: "shell", projectRoot: "/work/project", host: "pypi.org", port: 443, intent: USER_INTENT,
    })).toEqual({ ok: true });
    expect(egressRuntimeMock.revokeEgressGrant).toHaveBeenCalledWith({
      scope: "project", origin: "shell", projectRoot: "/work/project", host: "pypi.org", port: 443,
    });
    expect(deps.auditLogger.log).toHaveBeenCalledWith(expect.objectContaining({
      output: "[egress-grant:revoke] scope=project origin=shell host=pypi.org port=443 removed=true closedConnections=2",
    }));
    expect(await invoke(PERMISSIONS.egressGrantRevoke, {
      scope: "always", origin: "terminal", host: "pypi.org", port: 443, intent: USER_INTENT,
    })).toEqual({ ok: true });
    expect(egressRuntimeMock.revokeEgressGrant).toHaveBeenLastCalledWith({ scope: "always", origin: "terminal", host: "pypi.org", port: 443 });
    expect(await invoke(PERMISSIONS.egressGrantRevoke, {
      scope: "session", sessionId: "session-1", host: "pypi.org", port: 443, intent: USER_INTENT,
    })).toEqual({ ok: true });
    expect(egressRuntimeMock.revokeEgressGrant).toHaveBeenLastCalledWith({ scope: "session", sessionId: "session-1", host: "pypi.org", port: 443 });
    expect(await invoke(PERMISSIONS.egressGrantRevoke, {
      scope: "tab", tabId: "terminal:0a1b2c3d-1", host: "pypi.org", port: 443, intent: USER_INTENT,
    })).toEqual({ ok: true });
    expect(egressRuntimeMock.revokeEgressGrant).toHaveBeenLastCalledWith({ scope: "tab", tabId: "terminal:0a1b2c3d-1", host: "pypi.org", port: 443 });
    egressRuntimeMock.revokeEgressGrant.mockResolvedValueOnce({ removed: false, closed: 0 });
    expect(await invoke(PERMISSIONS.egressGrantRevoke, { scope: "always", origin: "shell", host: "pypi.org", port: 443, intent: USER_INTENT }))
      .toMatchObject({ ok: false, error: "not-found" });
  });

  it("refuses a revoke without user intent or with a malformed grant, before touching the store", async () => {
    await setup();
    egressRuntimeMock.revokeEgressGrant.mockClear();
    expect(await invoke(PERMISSIONS.egressGrantRevoke, { scope: "always", host: "pypi.org", port: 443 }))
      .toMatchObject({ ok: false, error: "user-keyboard-required" });
    for (const [payload, error] of [
      [{ scope: "session", sessionId: "s", host: "pypi.org", port: 443, network: "reserved" }, "invalid-egress-grant-destination"],
      [{ scope: "session", sessionId: "s", host: "pypi.org", port: 443, network: null }, "invalid-egress-grant-destination"],
      [{ scope: "once", host: "pypi.org", port: 443 }, "invalid-egress-grant-scope"],
      // The pre-2026-10-25 names are refused, never mapped (owner five-choice network card decision).
      [{ scope: "conversation", sessionId: "s", host: "pypi.org", port: 443 }, "invalid-egress-grant-scope"],
      [{ scope: "workspace", origin: "shell", projectRoot: "/w", host: "pypi.org", port: 443 }, "invalid-egress-grant-scope"],
      [{ scope: "project", origin: "shell", workspaceRoot: "/w", host: "pypi.org", port: 443 }, "invalid-egress-grant-project"],
      [{ scope: "session", host: "pypi.org", port: 443 }, "invalid-egress-grant-session"],
      [{ scope: "always", origin: "shell", sessionId: "s", host: "pypi.org", port: 443 }, "invalid-egress-grant-session"],
      [{ scope: "always", origin: "shell", host: "", port: 443 }, "invalid-egress-grant-destination"],
      [{ scope: "always", origin: "shell", host: "pypi.org", port: "443" }, "invalid-egress-grant-destination"],
      [{ scope: "project", origin: "shell", host: "pypi.org", port: 443 }, "invalid-egress-grant-project"],
      [{ scope: "always", origin: "shell", projectRoot: "/w", host: "pypi.org", port: 443 }, "invalid-egress-grant-project"],
      [{ scope: "always", host: "pypi.org", port: 443 }, "invalid-egress-grant-origin"],
      [{ scope: "always", origin: "worker", host: "pypi.org", port: 443 }, "invalid-egress-grant-origin"],
      [{ scope: "project", origin: "terminal", projectRoot: "/w", host: "pypi.org", port: 443 }, "invalid-egress-grant-origin"],
      [{ scope: "session", origin: "shell", sessionId: "s", host: "pypi.org", port: 443 }, "invalid-egress-grant-origin"],
      [{ scope: "tab", host: "pypi.org", port: 443 }, "invalid-egress-grant-tab"],
      [{ scope: "tab", tabId: "browser:0a1b2c3d-1", host: "pypi.org", port: 443 }, "invalid-egress-grant-tab"],
      [{ scope: "always", origin: "terminal", tabId: "terminal:0a1b2c3d-1", host: "pypi.org", port: 443 }, "invalid-egress-grant-tab"],
    ] as const) {
      expect(await invoke(PERMISSIONS.egressGrantRevoke, { ...payload, intent: USER_INTENT })).toMatchObject({ ok: false, error });
    }
    expect(egressRuntimeMock.revokeEgressGrant).not.toHaveBeenCalled();
  });

  it.each(["public", "local", "unverified"] as const)("revokes only the named %s class", async (network) => {
    await setup();
    const grant = { scope: "session", sessionId: "session-1", host: "pypi.org", port: 443, network };
    expect(await invoke(PERMISSIONS.egressGrantRevoke, { ...grant, intent: USER_INTENT })).toEqual({ ok: true });
    expect(egressRuntimeMock.revokeEgressGrant).toHaveBeenLastCalledWith(grant);
  });
});

/** The settings reads/writes the upstream proxy handlers use, in memory. */
function upstreamSettingsFake(initial: Partial<import("../../../shared/upstream-proxy.js").UpstreamProxySettings> = {}) {
  const secrets = new Map<string, string>();
  let upstreamProxy = { mode: "system", manualUrl: "", bypass: "", resolvesNames: false, ...initial };
  return {
    secrets,
    service: {
      get: vi.fn((key: string) => {
        if (key !== "upstreamProxy") throw new Error(`unexpected settings read: ${key}`);
        return structuredClone(upstreamProxy);
      }),
      set: vi.fn(async (key: string, value: typeof upstreamProxy) => {
        if (key !== "upstreamProxy") throw new Error(`unexpected settings write: ${key}`);
        upstreamProxy = structuredClone(value);
      }),
      getSecret: vi.fn((key: string) => secrets.get(key) ?? null),
      hasStoredSecret: vi.fn((key: string) => secrets.has(key)),
      setSecret: vi.fn(async (key: string, value: string) => { secrets.set(key, value); }),
      deleteSecret: vi.fn(async (key: string) => { secrets.delete(key); }),
    },
  };
}

describe("upstream proxy in Settings", () => {
  let windowSender: { mainFrame: { url: string } } | undefined;

  async function setupUpstream(initial: Parameters<typeof upstreamSettingsFake>[0] = {}) {
    const ctx = await setup();
    const fake = upstreamSettingsFake(initial);
    (ctx.deps as unknown as { settingsService: unknown }).settingsService = fake.service;
    windowSender = ctx.appWindows[0].webContents as unknown as { mainFrame: { url: string } };
    Object.assign(windowSender, { mainFrame: { url: "file:///application/index.html" } });
    return { ...ctx, ...fake };
  }

  /** A call from the main frame of one of Ave's windows (the only sender the setter accepts). */
  function fromAppWindow(channel: string, payload?: unknown): unknown {
    const handler = handlers.get(channel);
    if (!handler || !windowSender) throw new Error(`no handler or window for ${channel}`);
    return handler({ sender: windowSender, senderFrame: windowSender.mainFrame }, payload);
  }

  it("answers the setting, whether credentials are stored, and the effective upstream from the OS resolver", async () => {
    await setupUpstream();
    resolveProxyMock.mockResolvedValueOnce("PROXY proxy.test:8080; DIRECT");
    const saved = { HTTPS_PROXY: process.env.HTTPS_PROXY, https_proxy: process.env.https_proxy, ALL_PROXY: process.env.ALL_PROXY, all_proxy: process.env.all_proxy, HTTP_PROXY: process.env.HTTP_PROXY, http_proxy: process.env.http_proxy };
    for (const name of Object.keys(saved)) delete process.env[name];
    try {
      expect(await invoke(PERMISSIONS.upstreamProxyGet)).toEqual({
        settings: { mode: "system", manualUrl: "", bypass: "", resolvesNames: false },
        hasCredentials: false,
        diagnostic: {
          url: "https://example.com/",
          source: "system",
          routes: [{ kind: "http", endpoint: "proxy.test:8080" }, { kind: "direct" }],
          skipped: [],
        },
      });
      expect(resolveProxyMock).toHaveBeenCalledWith("https://example.com/");
    } finally {
      for (const [name, value] of Object.entries(saved)) if (value !== undefined) process.env[name] = value;
    }
  });

  it("stores a manual URL without its credentials, keeps them in the secret store, and never answers them", async () => {
    const { service, secrets, deps } = await setupUpstream();
    const result = await fromAppWindow(PERMISSIONS.upstreamProxySet, {
      mode: "manual", manualUrl: "http://alice:p%40ss@Proxy.Test:3128", bypass: " .lan, 10.0.0.0/8 ", intent: USER_INTENT,
    });
    expect(result).toMatchObject({
      ok: true,
      view: {
        settings: { mode: "manual", manualUrl: "http://proxy.test:3128", bypass: " .lan, 10.0.0.0/8 ", resolvesNames: false },
        hasCredentials: true,
        diagnostic: { source: "manual", routes: [{ kind: "http", endpoint: "proxy.test:3128", credentials: true }] },
      },
    });
    expect(JSON.stringify(result)).not.toMatch(/alice|p%40ss|p@ss/u);
    expect(service.set).toHaveBeenCalledWith("upstreamProxy", { mode: "manual", manualUrl: "http://proxy.test:3128", bypass: " .lan, 10.0.0.0/8 ", resolvesNames: false });
    expect(JSON.parse(secrets.get("upstreamProxy.manualCredentials")!)).toEqual({ username: "alice", password: "p@ss", origin: "http://proxy.test:3128" });
    const audit = JSON.stringify((deps.auditLogger.log as ReturnType<typeof vi.fn>).mock.calls);
    expect(audit).toContain("[upstream-proxy:set] mode=manual manual=http://proxy.test:3128 credentials=replaced bypassEntries=2 resolvesNames=false");
    expect(audit).not.toMatch(/alice|p@ss/u);
    // The same origin spelled again (and other changes) keeps them; clearCredentials removes them.
    expect(await fromAppWindow(PERMISSIONS.upstreamProxySet, { manualUrl: "http://PROXY.test:3128", bypass: "", intent: USER_INTENT }))
      .toMatchObject({ ok: true, view: { hasCredentials: true } });
    expect(await fromAppWindow(PERMISSIONS.upstreamProxySet, { clearCredentials: true, intent: USER_INTENT })).toMatchObject({ ok: true, view: { hasCredentials: false } });
    expect(secrets.has("upstreamProxy.manualCredentials")).toBe(false);
  });

  it("preserves bypass whitespace so only an exact singleton asterisk bypasses all", async () => {
    const { service } = await setupUpstream();
    const padded = await fromAppWindow(PERMISSIONS.upstreamProxySet, {
      mode: "manual", manualUrl: "http://proxy.test:80", bypass: " * ", intent: USER_INTENT,
    });
    expect(padded).toMatchObject({ ok: true, view: { settings: { bypass: " * " }, diagnostic: { source: "manual", routes: [{ kind: "http", endpoint: "proxy.test:80" }] } } });
    expect(service.set).toHaveBeenLastCalledWith("upstreamProxy", expect.objectContaining({ bypass: " * " }));
    const singleton = await fromAppWindow(PERMISSIONS.upstreamProxySet, { bypass: "*", intent: USER_INTENT });
    expect(singleton).toMatchObject({ ok: true, view: { settings: { bypass: "*" }, diagnostic: { source: "manual-bypass", routes: [{ kind: "direct" }] } } });
  });

  it("removes stored credentials when the manual proxy's host, port or scheme changes, and says so", async () => {
    for (const changed of ["http://other.test:3128", "http://proxy.test:8080", "https://proxy.test:3128", ""]) {
      const { secrets, deps } = await setupUpstream();
      await fromAppWindow(PERMISSIONS.upstreamProxySet, { mode: "manual", manualUrl: "http://alice:pw@proxy.test:3128", intent: USER_INTENT });
      expect(secrets.has("upstreamProxy.manualCredentials")).toBe(true);
      const result = await fromAppWindow(PERMISSIONS.upstreamProxySet, { mode: changed === "" ? "system" : "manual", manualUrl: changed, intent: USER_INTENT });
      expect(result, changed).toMatchObject({ ok: true, credentialsRemoved: true, view: { hasCredentials: false } });
      expect(secrets.has("upstreamProxy.manualCredentials"), changed).toBe(false);
      expect(JSON.stringify((deps.auditLogger.log as ReturnType<typeof vi.fn>).mock.calls)).toContain("credentials=removed");
    }
  });

  it.each([
    ["http://alice:pw@proxy.test:1080", "http://proxy.test:80"],
    ["http://alice:pw@proxy.test:80", "http://proxy.test:1080"],
    ["http://alice:pw@proxy.test", "proxy.test:80"],
    ["alice:pw@proxy.test:80", "http://proxy.test"],
    ["http://alice:pw@[2001:db8::1]:80", "http://[2001:db8::1]"],
    ["http://alice:pw@[2001:db8::1]", "[2001:db8::1]:80"],
  ])("clears credentials when effective service changes from %s to %s", async (initial, changed) => {
    const { secrets } = await setupUpstream();
    await fromAppWindow(PERMISSIONS.upstreamProxySet, { mode: "manual", manualUrl: initial, intent: USER_INTENT });
    expect(secrets.has("upstreamProxy.manualCredentials")).toBe(true);
    const result = await fromAppWindow(PERMISSIONS.upstreamProxySet, { manualUrl: changed, intent: USER_INTENT });
    expect(result).toMatchObject({ ok: true, credentialsRemoved: true, view: { hasCredentials: false } });
    expect(secrets.has("upstreamProxy.manualCredentials")).toBe(false);
  });

  it.each([
    ["http://alice:pw@proxy.test:80", "proxy.test:80", "http://proxy.test:80"],
    ["http://alice:pw@proxy.test", "http://proxy.test:1080", "http://proxy.test:1080"],
    ["https://alice:pw@proxy.test", "https://proxy.test:443", "https://proxy.test:443"],
    ["http://alice:pw@[2001:db8::1]", "[2001:db8::1]:1080", "http://[2001:db8::1]:1080"],
  ])("keeps credentials when effective service is unchanged from %s to %s", async (initial, changed, origin) => {
    const { secrets } = await setupUpstream();
    await fromAppWindow(PERMISSIONS.upstreamProxySet, { mode: "manual", manualUrl: initial, intent: USER_INTENT });
    expect(JSON.parse(secrets.get("upstreamProxy.manualCredentials")!)).toMatchObject({ origin });
    const result = await fromAppWindow(PERMISSIONS.upstreamProxySet, { manualUrl: changed, intent: USER_INTENT });
    expect(result).toMatchObject({ ok: true, view: { hasCredentials: true, settings: { manualUrl: origin } } });
    expect(secrets.has("upstreamProxy.manualCredentials")).toBe(true);
  });

  it("treats a stored entry without its origin, or bound to another proxy, as no credentials", async () => {
    const { secrets } = await setupUpstream({ mode: "manual", manualUrl: "http://proxy.test:3128" });
    secrets.set("upstreamProxy.manualCredentials", JSON.stringify({ username: "u", password: "p" }));
    expect(await invoke(PERMISSIONS.upstreamProxyGet)).toMatchObject({ hasCredentials: false, diagnostic: { routes: [{ kind: "http", endpoint: "proxy.test:3128" }] } });
    secrets.set("upstreamProxy.manualCredentials", JSON.stringify({ username: "u", password: "p", origin: "http://elsewhere.test:3128" }));
    expect(await invoke(PERMISSIONS.upstreamProxyGet)).toMatchObject({ hasCredentials: false, diagnostic: { routes: [{ kind: "http", endpoint: "proxy.test:3128" }] } });
    // The next save removes the stale entry.
    expect(await fromAppWindow(PERMISSIONS.upstreamProxySet, { resolvesNames: true, intent: USER_INTENT })).toMatchObject({ ok: true, credentialsRemoved: true });
    expect(secrets.has("upstreamProxy.manualCredentials")).toBe(false);
  });

  it("toggles the trusted resolves-names opt-in and the mode", async () => {
    const { service } = await setupUpstream();
    expect(await fromAppWindow(PERMISSIONS.upstreamProxySet, { resolvesNames: true, intent: USER_INTENT })).toMatchObject({ ok: true, view: { settings: { resolvesNames: true } } });
    expect(await fromAppWindow(PERMISSIONS.upstreamProxySet, { mode: "off", intent: USER_INTENT })).toMatchObject({ ok: true, view: { settings: { mode: "off" }, diagnostic: { source: "off", routes: [{ kind: "direct" }] } } });
    expect(service.set).toHaveBeenCalledTimes(2);
  });

  it("refuses without user intent, and refuses invalid input before writing anything", async () => {
    const { service } = await setupUpstream();
    expect(await fromAppWindow(PERMISSIONS.upstreamProxySet, { mode: "off" })).toMatchObject({ ok: false, error: "user-keyboard-required" });
    for (const [payload, error] of [
      [{ mode: "pac" }, "invalid-upstream-proxy-mode"],
      [{ resolvesNames: "yes" }, "invalid-upstream-proxy-resolves-names"],
      [{ bypass: 7 }, "invalid-upstream-proxy-bypass"],
      [{ manualUrl: "socks5://s:1080" }, "upstream-proxy-socks-unsupported"],
      [{ manualUrl: "http://p:1/path" }, "invalid-upstream-proxy-url"],
      [{ mode: "manual" }, "upstream-proxy-url-required"],
      [{ mode: "manual", manualUrl: "  " }, "upstream-proxy-url-required"],
    ] as const) {
      expect(await fromAppWindow(PERMISSIONS.upstreamProxySet, { ...payload, intent: USER_INTENT }), JSON.stringify(payload)).toMatchObject({ ok: false, error });
    }
    expect(service.set).not.toHaveBeenCalled();
    expect(service.setSecret).not.toHaveBeenCalled();
  });

  it("accepts a change only from the main frame of one of Ave's windows", async () => {
    const { service, appWindows } = await setupUpstream();
    const handler = handlers.get(PERMISSIONS.upstreamProxySet)!;
    const payload = { mode: "off", intent: USER_INTENT };
    const mainFrame = (appWindows[0].webContents as unknown as { mainFrame: { url: string } }).mainFrame;
    // A host-renderer URL in a subframe of the window, or in another webContents.
    expect(await handler({ sender: appWindows[0].webContents, senderFrame: { url: mainFrame.url } }, payload)).toEqual(UNAUTHORIZED_FRAME);
    expect(await handler({ sender: { mainFrame }, senderFrame: mainFrame }, payload)).toEqual(UNAUTHORIZED_FRAME);
    expect(await invoke(PERMISSIONS.upstreamProxySet, payload)).toEqual(UNAUTHORIZED_FRAME);
    expect(service.set).not.toHaveBeenCalled();
    expect(await fromAppWindow(PERMISSIONS.upstreamProxySet, payload)).toMatchObject({ ok: true });
    expect(service.set).toHaveBeenCalledOnce();
  });

  it("refuses a read from a plugin frame", async () => {
    await setupUpstream();
    expect(await invokeRegisteredHandlerWithEvent(handlers, PERMISSIONS.upstreamProxyGet, pluginShellFrameEvent(), undefined)).toEqual(UNAUTHORIZED_FRAME);
    expect(await invokeRegisteredHandlerWithEvent(handlers, PERMISSIONS.upstreamProxyGet, foreignFrameEvent("https://attacker.example/"), undefined)).toEqual(UNAUTHORIZED_FRAME);
  });
});
