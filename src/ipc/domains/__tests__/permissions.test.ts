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
/** The ask callback registration handed to the permission manager. */
let askDeferredEntry: ((entry: unknown) => void) | null = null;
const recordApprovalMock = vi.hoisted(() => vi.fn(async () => undefined));

vi.mock("electron", () => ({
  ipcMain: {
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
  },
}));

// `policyGet` must attach the host-derived `editable` flag. loadPolicy itself
// reads real OS paths (/etc/ave, %ProgramData%), so the file layer is stubbed
// while the handler under test — and the predicate it calls — stay real.
const loadPolicyMock = vi.hoisted(() => vi.fn());

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
  // Issue #798: mutating user-approval handlers gate on user-keyboard intent.
  // Auto-inject the intent marker on the relevant channels so existing test
  // fixtures don't need a payload rewrite.
  const intentRequired =
    channel === PERMISSIONS.userApprovalRecord ||
    channel === PERMISSIONS.userApprovalRevoke;
  if (intentRequired && typeof args[0] === "object" && args[0] !== null) {
    const payload = args[0] as Record<string, unknown>;
    if (payload.intent === undefined) {
      args = [{ ...payload, intent: { inputOrigin: "user-keyboard", userActivation: true } }, ...args.slice(1)];
    }
  }
  return fn(hostFrameEvent(), ...args);
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
    // Approving an entry applies its recorded grant; an entry without one
    // cannot be approved at all (see the "no-grant-available" tests below),
    // so the shared fixture carries the out-of-allowed-dir lane's grant.
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
        isDestroyed: vi.fn(() => false),
        send: vi.fn(),
      },
    },
    {
      isDestroyed: vi.fn(() => false),
      webContents: {
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
    removeRulePersist: vi.fn(async () => undefined),
    addAlwaysAllowedPersist: vi.fn(async () => undefined),
    addAlwaysDeniedPersist: vi.fn(async () => undefined),
    removeRule: vi.fn(async () => undefined),
    getVisibilityDenyRules: vi.fn(() => []),
    getDeferredQueue: vi.fn(() => options.queue ?? null),
    isReviewerDegradedToRule: vi.fn(() => false),
    // Registration hands the host's ask surface to the manager; the tests keep
    // the callback so they can drive it the way a newly deferred entry would.
    setDeferredEntryAsk: vi.fn((fn: (entry: unknown) => void) => {
      askDeferredEntry = fn;
    }),
  };
  // Answers by POSITION, not by label: the labels are localized, and a test
  // that spelled one out would be asserting the catalog rather than the map
  // from the user's pick to the resolution.
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
      // #799 + CRITICAL-2 ralph iter 4: server-side ApprovalRequest binding.
      // userApprovalRecord handler reads identity, raw args, and verdict from
      // this host snapshot. Tests opt into HIGH explicitly; renderer claims
      // cannot downgrade it into a persistent allow.
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
  // The lifecycle is no longer a dep field: `ipc/domains/workspace.ts` publishes
  // the one instance and every consumer resolves it through the authority.
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
  return { deps, permissionManager, appWindows, workspaceRootLifecycle, askUserQuestionGate };
}

beforeEach(() => {
  handlers.clear();
  recordApprovalMock.mockClear();
});

describe("permissions IPC handlers", () => {
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

  // ── 3-agent cluster review of PR #1441 — critic minor 2 ────────────────
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

  it("marks only a registered app window main-frame response as native", async () => {
    const { deps, appWindows } = await setup();
    const fn = handlers.get(PERMISSIONS.approvalRespond)!;
    const sender = appWindows[0].webContents;
    const frame = { url: "file:///application/index.html" };
    Object.assign(sender, { mainFrame: frame });
    const decision = { requestId: "host-approval", choice: "allow-once" };
    await fn({ sender, senderFrame: frame }, decision);
    expect(deps.approvalGate.resolveFromDesktopRenderer).toHaveBeenCalledWith("host-approval", decision);
    expect(deps.approvalGate.resolve).not.toHaveBeenCalled();
    deps.approvalGate.resolveFromDesktopRenderer.mockClear();
    await fn({ sender, senderFrame: { url: frame.url } }, decision);
    await fn({ sender: { mainFrame: frame }, senderFrame: frame }, decision);
    expect(deps.approvalGate.resolveFromDesktopRenderer).not.toHaveBeenCalled();
    expect(deps.approvalGate.resolve).toHaveBeenCalledTimes(2);
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
    deps.approvalGate.resolve.mockReturnValueOnce({
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

  // ── What an approval actually GRANTS ──────────────────────────────────────
  // The original call is dead by the time anyone resolves the entry, so these
  // assert the forward-looking grant — the directory reaching the permission
  // scope — not the JSONL `status` field, which is only bookkeeping.

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
    // The observable consequence: the next call under this directory passes
    // Layer 1 without asking.
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
    // The strict-mode reviewer lane defers on an exact (tool, args, source)
    // tuple and keeps only a redacted summary, so no grant is reconstructable.
    // Recording an approval here would tell the user their click did
    // something it did not.
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
    // A sensitive path is refused outright by validateDirectoryAddition
    // ("path matches sensitive pattern '**/.ssh/**'"). The entry must stay
    // pending rather than be marked approved with nothing granted.
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
    // Same widening gate the foreground card renders as a warning checkbox.
    // ".git" warns; ".ssh" would be a hard reject, which is a different path.
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

  // ── approvalSource provenance in the audit row ────────────────────────
  // End-to-end IPC → audit assertion that the surface the user gestured on
  // reaches the audit chain.
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

  // The in-chat approval chip that wrote this provenance is gone, and with it
  // the value: an audit row may still carry it, but nothing may write one.
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

  // An approval the resolve path would refuse is not an option: an entry with
  // no recorded grant can only be denied or left pending.
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

// ─── Helper: create an IPC event with a foreign sender frame ─────────────────
// `invoke` sends the trusted host-renderer frame; these send a frame the guards
// must refuse, exercising the UNAUTHORIZED_FRAME path.

function makeForeignEvent(url = "https://attacker.example.com/pwn") {
  return foreignFrameEvent(url);
}

// ─── MAJOR-4: reviewerProviderHasKey returns UNAUTHORIZED_FRAME ───────────────

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

describe("MAJOR-4: reviewerProviderHasKey returns UNAUTHORIZED_FRAME on invalid sender", () => {
  it("returns UNAUTHORIZED_FRAME (not bare false) when sender is a foreign frame", async () => {
    await setup();
    const result = await invokeRegisteredHandlerWithEvent(handlers,
      PERMISSIONS.reviewerProviderHasKey,
      makeForeignEvent(),
      "openai",
    );
    expect(result).toEqual(UNAUTHORIZED_FRAME);
    // Must NOT be bare false — bare false is indistinguishable from "key absent"
    expect(result).not.toBe(false);
  });
});

// ─── MEDIUM-3: reviewerProviderHasKey input allowlist ────────────────────────

describe("MEDIUM-3: reviewerProviderHasKey input allowlist", () => {
  it("returns false immediately for unknown provider string (not a valid reviewer provider)", async () => {
    await setup();
    // Trusted sender (null) — allowlist check fires, not sender check
    const result = await invoke(PERMISSIONS.reviewerProviderHasKey, "malicious-provider");
    expect(result).toBe(false);
  });

  it("returns false for non-string provider input", async () => {
    await setup();
    const result = await invoke(PERMISSIONS.reviewerProviderHasKey, 42);
    expect(result).toBe(false);
  });

  it("returns false for null provider input", async () => {
    await setup();
    const result = await invoke(PERMISSIONS.reviewerProviderHasKey, null);
    expect(result).toBe(false);
  });

  it("rejects unknown provider names immediately — allowlist short-circuits before touching deps", async () => {
    // Ensure handler is registered before invoking.
    await setup();
    // "not-a-provider" is not in the allowlist → returns false immediately,
    // before touching deps.settingsService (which isn't in this test's makeDeps).
    const result = await invoke(PERMISSIONS.reviewerProviderHasKey, "not-a-provider-2");
    expect(result).toBe(false);
  });
});

// ─── Minor-3 R2: REVIEWER_PROVIDERS_SET single SOT ────────────────────────────

describe("Minor-3 R2: REVIEWER_PROVIDERS_SET is the single SOT for allowed provider names", () => {
  it("accepts all 5 canonical provider names from REVIEWER_PROVIDERS_SET", async () => {
    // Each valid provider name must pass the allowlist without returning false
    // (they still return false if no secret is set, but MUST NOT short-circuit
    //  before reaching the settingsService lookup).
    const { REVIEWER_PROVIDERS_SET } = await import("../../../permissions/permission-settings-store.js");
    const providers = [...REVIEWER_PROVIDERS_SET];
    expect(providers).toHaveLength(5);
    expect(providers).toContain("openai");
    expect(providers).toContain("anthropic");
    expect(providers).toContain("google");
    expect(providers).toContain("foundry");
    expect(providers).toContain("gcp-playground");
  });

  it("reviewerProviderHasKey handler returns false for provider not in REVIEWER_PROVIDERS_SET", async () => {
    await setup();
    // An attacker-supplied string not in the set is rejected without touching deps
    const result = await invoke(PERMISSIONS.reviewerProviderHasKey, "azure-foundry");
    // "azure-foundry" is not a valid ReviewerProvider UI name
    expect(result).toBe(false);
  });
});

// ─── HIGH verdict IPC enforcement: explicit one-shot only ───────────────────

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
    expect(recordApprovalMock).toHaveBeenCalledWith("bash_run", '{"command":"ls"}', "user-keyboard",
      expect.not.objectContaining({ sessionId: expect.anything() }));
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

// ─── Minor-2 R2: vendors optional chain prevents TypeError ────────────────────

describe("Minor-2 R2: vendors?.['azure-foundry']?.baseUrl — no TypeError when vendors is undefined", () => {
  it("reviewerProviderHasKey returns false (no throw) when vendors key is absent from settings", async () => {
    handlers.clear();
    const { deps } = makeDeps();
    // Override settingsService to simulate settings with no vendors key
    const depsWithSettings = {
      ...deps,
      settingsService: {
        getSecret: vi.fn(() => "some-foundry-key"),
        get: vi.fn(() => ({ provider: "openai" })), // no vendors key
        getAll: vi.fn(() => ({})),
      },
    };
    const { registerPermissionsHandlers } = await import("../permissions.js");
    registerPermissionsHandlers(depsWithSettings as never);

    // "foundry" passes the allowlist and reaches the getEndpoint lambda.
    // With optional chain: vendors?.["azure-foundry"]?.baseUrl → undefined → null (no throw).
    // Since endpoint is null, reviewerProviderKeyPresent returns false.
    const result = await invoke(PERMISSIONS.reviewerProviderHasKey, "foundry");
    expect(result).toBe(false); // no throw, no TypeError
  });
});

// ─── Sender-frame guard on the state-mutating permission channels ────────────
// These channels changed the host's permission state, so they must refuse
// anything that is not the host renderer. A plugin UI shell is also a `file://`
// frame — the base `validateSender` accepts it — so the stronger
// `validateHostRendererSender` is what actually turns it away. A frameless
// event (Electron nulls `senderFrame` once the sending frame is destroyed or
// navigated away between `invoke` and handler execution) is refused too: an
// unprovable sender is not a trusted one.

describe("state-mutating permission channels refuse non-host frames", () => {
  const MUTATING: ReadonlyArray<readonly [string, Record<string, unknown>]> = [
    [PERMISSIONS.setMode, { mode: "auto", intent: USER_INTENT }],
    [PERMISSIONS.addRule, { pattern: "write_file:path:/tmp/a.md", action: "allow", intent: USER_INTENT }],
    [PERMISSIONS.removeRule, { pattern: "write_file:path:/tmp/a.md", action: "allow", intent: USER_INTENT }],
    [PERMISSIONS.removeScopedRule, { pattern: "Bash(ls *)", action: "allow", scope: "user", intent: USER_INTENT }],
    [PERMISSIONS.approvalRespond, { requestId: "approval-1", choice: "allow-once" }],
    [PERMISSIONS.policySet, { patch: { requireExplicitApproval: false }, intent: USER_INTENT }],
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
  const rule = { pattern: "Bash(git status *)", scope: "project" };
  const body = { requestId: "live-shell", args: "{}", scope: "persistent", verdictAtApproval: "medium", nlJustification: null, rule };
  const shellRule = { suggestedPattern: rule.pattern, projectCwd: "/srv/project", projectRoot: "/srv/project", persistentAllowed: true, sessionAllowed: true };

  it("writes only the host project rule and never also records an exact decision", async () => {
    const { deps } = await setup({ shellRule, snapshotArgs: { command: "git status --short" } });
    const result = await invoke(PERMISSIONS.userApprovalRecord, { ...body, projectCwd: "/different/project" });
    expect(result).toMatchObject({ ok: true });
    expect(deps.conversationLoop.permissionManager.addRulePersist).toHaveBeenCalledWith({ pattern: rule.pattern, action: "allow" }, { kind: "project", projectCwd: "/srv/project" });
    expect(recordApprovalMock).not.toHaveBeenCalled();
    expect(deps.auditLogger.log).toHaveBeenCalledWith({
      timestamp: expect.any(String), sessionId: "conversation-1", type: "approval",
      output: '[approval:remembered] store=rules decision=allow scope=project toolName="bash_run" source="user-keyboard"',
    });
  });

  it.each(["Bash(sudo *)", "Bash(git push *)", "Bash(*)", "Edit(/srv/project/**)"])("refuses an edited rule that cannot cover the pending command: %s", async (pattern) => {
    const { deps } = await setup({ shellRule, snapshotArgs: { command: "git status" } });
    const result = await invoke(PERMISSIONS.userApprovalRecord, { ...body, rule: { ...rule, pattern } });
    expect(result).toMatchObject({ ok: false, error: "invalid-rule" });
    expect(deps.conversationLoop.permissionManager.addRulePersist).not.toHaveBeenCalled();
    expect(recordApprovalMock).not.toHaveBeenCalled();
  });

  it.each([
    ["Bash( git status * )", "Bash(git status *)"],
    ["Bash(git\tstatus   *)", "Bash(git status *)"],
  ])("saves a hand-spaced rule %s in the canonical form the dock previewed", async (pattern, saved) => {
    const { deps } = await setup({ shellRule, snapshotArgs: { command: "git status --short" } });
    expect(await invoke(PERMISSIONS.userApprovalRecord, { ...body, rule: { ...rule, pattern } })).toMatchObject({ ok: true });
    expect(deps.conversationLoop.permissionManager.addRulePersist).toHaveBeenCalledWith({ pattern: saved, action: "allow" }, { kind: "project", projectCwd: "/srv/project" });
  });

  it.each([
    ["rm notes.txt", "Bash(rm *)"],
    ["chmod +x build.sh", "Bash(chmod *)"],
    ["chown -R me src", "Bash(chown -R *)"],
    ["git clean -n", "Bash(git clean *)"],
    ["truncate -s 1M data.bin", "Bash(truncate *)"],
    ["git checkout main", "Bash(git checkout *)"],
    ["git clean -fdx", "Bash(git clean -fdx)"],
  ])("refuses a forged destructive allow prefix for %s", async (command, pattern) => {
    const { deps } = await setup({ shellRule, snapshotArgs: { command } });
    expect(await invoke(PERMISSIONS.userApprovalRecord, { ...body, rule: { ...rule, pattern } })).toMatchObject({ ok: false, error: "invalid-rule" });
    expect(deps.conversationLoop.permissionManager.addRulePersist).not.toHaveBeenCalled();
  });

  it("reports a storage failure apart from an invalid rule", async () => {
    const { deps } = await setup({ shellRule, snapshotArgs: { command: "git status --short" } });
    deps.conversationLoop.permissionManager.addRulePersist.mockRejectedValueOnce(new Error("permissions.json is corrupt"));
    expect(await invoke(PERMISSIONS.userApprovalRecord, body)).toMatchObject({ ok: false, error: "rule-save-failed", message: "permissions.json is corrupt" });
    expect(deps.auditLogger.log).not.toHaveBeenCalledWith(expect.objectContaining({ type: "approval" }));
  });

  it("refuses a rule that is empty after normalization", async () => {
    const { deps } = await setup({ shellRule, snapshotArgs: { command: "git status" } });
    expect(await invoke(PERMISSIONS.userApprovalRecord, { ...body, rule: { ...rule, pattern: "Bash( \t )" } })).toMatchObject({ ok: false, error: "invalid-rule" });
    expect(deps.conversationLoop.permissionManager.addRulePersist).not.toHaveBeenCalled();
  });

  it("refuses allow persistence for floors even when the renderer submits a valid rule", async () => {
    const { deps } = await setup({ shellRule: { ...shellRule, persistentAllowed: false, sessionAllowed: false }, snapshotArgs: { command: "git status" } });
    expect(await invoke(PERMISSIONS.userApprovalRecord, body)).toMatchObject({ ok: false, error: "one-shot-not-recordable" });
    expect(deps.conversationLoop.permissionManager.addRulePersist).not.toHaveBeenCalled();
  });

  it("allows a persistent command denial to narrow a one-shot request", async () => {
    const { deps } = await setup({ durableApprovalRecordAllowed: false, shellRule: { ...shellRule, persistentAllowed: false }, snapshotArgs: { command: "rm -rf build" } });
    const deniedRule = { pattern: "Bash(rm *)", scope: "user" };
    expect(await invoke(PERMISSIONS.userApprovalRecord, { ...body, rule: deniedRule, decision: "deny" })).toMatchObject({ ok: true });
    expect(deps.conversationLoop.permissionManager.addRulePersist).toHaveBeenCalledWith({ pattern: deniedRule.pattern, action: "deny" }, { kind: "user" });
    expect(recordApprovalMock).not.toHaveBeenCalled();
  });

  it("requires a conversation identity for new session records", async () => {
    await setup({ snapshotSessionId: null, shellRule });
    expect(await invoke(PERMISSIONS.userApprovalRecord, { ...body, scope: "session", rule: undefined })).toMatchObject({ ok: false, error: "missing-session" });
    expect(recordApprovalMock).not.toHaveBeenCalled();
  });
});


describe("shell persistence cannot fall back to exact input", () => {
  const body = { requestId: "live-shell", args: "{}", verdictAtApproval: "medium", nlJustification: null };
  it("refuses a persistent exact allow when a refused prefix is offered only session scope", async () => {
    const { deps } = await setup({ shellRule: { suggestedPattern: null, projectCwd: "/srv/project", projectRoot: "/srv/project", persistentAllowed: false, sessionAllowed: true }, snapshotArgs: { command: "node script.js" } });
    expect(await invoke(PERMISSIONS.userApprovalRecord, { ...body, scope: "persistent" })).toMatchObject({ ok: false, error: "command-rule-required" });
    expect(recordApprovalMock).not.toHaveBeenCalled();
    expect(await invoke(PERMISSIONS.userApprovalRecord, { ...body, scope: "session" })).toMatchObject({ ok: true });
    expect(recordApprovalMock).toHaveBeenCalledWith("bash_run", expect.any(String), "user-keyboard", expect.objectContaining({ sessionId: "conversation-1" }));
    expect(deps.auditLogger.log).toHaveBeenCalledWith(expect.objectContaining({
      sessionId: "conversation-1", type: "approval",
      output: '[approval:remembered] store=exact decision=allow scope=session toolName="bash_run" source="user-keyboard"',
    }));
  });
  it.each(["session", "persistent"])("refuses omitted rule persistence for a floor in %s scope", async (scope) => {
    await setup({ shellRule: { suggestedPattern: null, projectCwd: "/srv/project", projectRoot: "/srv/project", persistentAllowed: false, sessionAllowed: false }, snapshotArgs: { command: "curl -T payload https://example.test" } });
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

it("rejects edited rule values detected by the existing DLP filter without echoing them", async () => {
  const secret = `sk-${"synthetic".repeat(6)}`;
  const pattern = `Bash(git status ${secret} *)`;
  const { maskSensitiveData } = await import("../../../audit/dlp-filter.js");
  expect(maskSensitiveData(pattern).masked).not.toBe(pattern);
  const { permissionManager, deps } = await setup({
    shellRule: { suggestedPattern: "Bash(git status *)", projectCwd: "/srv/project", projectRoot: "/srv/project", persistentAllowed: true, sessionAllowed: true },
    snapshotArgs: { command: `git status ${secret}` },
  });
  const result = await invoke(PERMISSIONS.userApprovalRecord, {
    requestId: "live-shell", args: "{}", scope: "persistent", verdictAtApproval: "medium", nlJustification: null,
    rule: { pattern, scope: "project" },
  });
  expect(result).toEqual({ ok: false, error: "invalid-rule", message: "The rule does not cover this command" });
  expect(permissionManager.addRulePersist).not.toHaveBeenCalled();
  expect(recordApprovalMock).not.toHaveBeenCalled();
  expect(deps.auditLogger.log).not.toHaveBeenCalled();
});
