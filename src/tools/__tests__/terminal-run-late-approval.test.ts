import type { UserOwnedSurfaceChoice } from "../../shared/permissions-events.js";
import { NO_APPROVER_MESSAGE } from "../../permissions/decision-pipeline.js";
import { randomBytes, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditLogger } from "../../audit/audit-logger.js";
import { setReviewerForTest } from "../../__tests__/support/reviewer-judge.js";
import { makeRecentlyDeniedStore } from "../../__tests__/support/recently-denied.js";
import { terminalSessionFixture } from "../../__tests__/support/terminal-session-fixtures.js";
import { TERMINAL_TEST_NONCE, terminalMarker } from "../../__tests__/support/terminal-markers.js";
import { TerminalBlockTracker, registerTerminalBlockTracker, __resetTerminalBlocksForTest } from "../../main/terminal/terminal-blocks.js";
import { ApprovalGate, type ApprovalRequest } from "../../permissions/approval-gate.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { PermissionTestResources } from "../../permissions/__tests__/test-resources.js";
import { formatRuleSpecifier } from "../../permissions/rules/rule-specifier.js";
import { ToolExecutor } from "../executor.js";
import * as invocationExecution from "../invocation-execution.js";
import { runWithHostTerminalTurn, noteToolResultsReturnedToModel } from "../host-terminal-turn.js";
import { createTerminalRunTool } from "../terminal-run.js";
import { ToolRegistry } from "../registry.js";
import type { ToolResult } from "../executor.js";
import { userPermissionContext } from "./tool-context-fixture.js";
import { shellQuote } from "../../lib/shell-resolver.js";

const resources = new PermissionTestResources();
const loggers: AuditLogger[] = [];
const SESSION_ID = "late-host-terminal";
const TAB_ID = "terminal:0000c0de-2";
const WINDOW_ID = 8;
const COMMAND = "printf ready";

afterEach(async () => {
  vi.restoreAllMocks();
  __resetTerminalBlocksForTest();
  for (const logger of loggers.splice(0)) await logger.close();
  await resources.cleanup();
});

async function fixture(options: { outside?: boolean; mode?: "default" | "strict"; exactRule?: boolean; holdFinalizer?: boolean; surfaceChoice?: UserOwnedSurfaceChoice; logicalReview?: () => Promise<{ consistent: boolean; reason: string }>; headless?: boolean } = {}) {
  const root = realpathSync(resources.makeTmpDir("ave-late-terminal-"));
  const outside = realpathSync(resources.makeTmpDir("ave-terminal-outside-"));
  const command = options.outside ? `printf ready > ${shellQuote(join(outside, "output.txt"))}` : COMMAND;
  const manager = new PermissionManager(join(root, "permissions.json"));
  manager.setMode(options.mode ?? "auto");
  if (options.holdFinalizer !== false) manager.setUserOwnedSurfaceChoice(SESSION_ID, "host-terminal", "allow");
  if (options.exactRule !== false) await manager.addRulePersist({ pattern: formatRuleSpecifier({
    kind: "host-terminal", shell: "zsh", cwd: root, tokens: command.split(" "),
  }), action: "allow" }, { kind: "user" });
  setReviewerForTest(manager, {
    classifier: { classify: () => ({ level: "high", reason: "Sibling action requires human approval" }), ...(options.logicalReview ? { reviewUserOwnedSurface: options.logicalReview } : {}) },
    cache: resources.makeVerdictCache(join(root, "verdicts.jsonl")),
    recentlyDenied: makeRecentlyDeniedStore(join(root, "recently-denied.json")),
  });
  const pause = async () => {
    for (let index = 0; index < 3; index += 1) await manager.dispatchReviewer("write_probe", {
      invocationId: randomUUID(), sessionId: SESSION_ID, source: "builtin", category: "write", pathFields: ["path"],
      finalInput: { path: join(root, `sibling-${index}.txt`) }, executionCwd: root, allowedDirectories: [root],
      sensitivePathsAdjacent: [], trustOrigin: "user-keyboard",
    });
    expect(manager.isAutomatedApprovalPaused(SESSION_ID)).toBe(true);
  };
  const audit = new AuditLogger(join(root, "audit"));
  loggers.push(audit);
  await audit.setupPermissionAuditChain(randomBytes(32).toString("hex"));
  const tracker = new TerminalBlockTracker({ nonce: TERMINAL_TEST_NONCE, marksPromptEnd: true });
  tracker.recordOutput(`${terminalMarker("D;0")}${terminalMarker(`P;Cwd=${root};Keys=emacs;Paste=1`)}${terminalMarker("A")}% ${terminalMarker("B")}`);
  const terminal = terminalSessionFixture(TAB_ID, "manual");
  registerTerminalBlockTracker(terminal, tracker, WINDOW_ID);
  const typed: string[] = [];
  const registry = new ToolRegistry();
  registry.register(createTerminalRunTool({
    windowIdForHostedSession: sessionId => sessionId === SESSION_ID ? WINDOW_ID : null,
    liveOriginSessionId: () => undefined,
    boundSurface: (_window, sessionId) => sessionId === SESSION_ID ? { kind: "terminal", tabId: TAB_ID } : undefined,
    ensureConversationTerminal: async () => { throw new Error("Unexpected isolated terminal route"); },
    typeCommand: async () => { throw new Error("Unexpected isolated terminal typing"); },
    verifyShell: async () => { throw new Error("Unexpected isolated shell verification"); },
    auditMismatch: () => {},
    host: {
      session: tabId => tabId === TAB_ID ? terminal : undefined,
      placement: () => "workspace", shellName: () => "zsh",
      control: () => ({ mode: "available", generation: 1, agentInput: "supported" }),
      verifyShell: async (_ref, _window, cwd) => ({ ok: true, cwd }),
      typeCommand: async (_ref, _window, request) => {
        const effect = await request.effectCheck();
        if (!effect.ok) return { ok: false, reason: "effect-refused", message: effect.message };
        typed.push(request.line);
        return { ok: true, firstBlockId: 1 };
      },
      waitDisclosure: async (_ref, _window, _session, turnId) => ({
        requestingSessionId: SESSION_ID, turnId, command, cwd: root, blockId: 1,
        state: "done", exitCode: 0, output: "ready", truncated: false,
      }),
    },
  }));
  const cards: ApprovalRequest[] = [];
  const owner = { isDestroyed: () => false, send: (channel: string, card: ApprovalRequest) => {
    if (channel === "ave:approval:request") cards.push(card);
  } };
  const gate = new ApprovalGate(owner as never);
  const request = vi.spyOn(gate, "requestAndWait");
  const approve = (card: ApprovalRequest, native: boolean) => {
    const decision = { requestId: card.id, choice: "allow-once" as const, ...(card.userOwnedSurface && !card.userOwnedSurfaceReviewFallback ? { userOwnedSurfaceChoice: options.surfaceChoice ?? "ask" } : {}), nonce: card.nonce, hmac: card.hmac };
    return native ? gate.resolveFromDesktopRenderer(card.id, decision, owner as never) : gate.resolve(card.id, decision);
  };
  const deny = (card: ApprovalRequest) => gate.resolveFromDesktopRenderer(card.id, {
    requestId: card.id, choice: "deny-once", nonce: card.nonce, hmac: card.hmac,
  }, owner as never);
  let enter!: () => void;
  let release!: () => void;
  const reached = new Promise<void>(resolve => { enter = resolve; });
  const held = new Promise<void>(resolve => { release = resolve; });
  const execute = invocationExecution.executeAuthorizedToolInvocation;
  let attempts = 0;
  vi.spyOn(invocationExecution, "executeAuthorizedToolInvocation").mockImplementation(context => execute({
    ...context, finalizeExecutionRouteGrant: async () => {
      if (attempts++ === 0 && options.holdFinalizer !== false) { enter(); await held; }
      return context.finalizeExecutionRouteGrant?.();
    },
  }));
  const executor = new ToolExecutor(registry, undefined, manager, undefined, gate, undefined, audit);
  const run = () => executor.executeAll([{ id: "late-terminal-command", name: "terminal_run", input: { command, waitSeconds: 0 } }], {
    sessionId: SESSION_ID, executionCwd: root, permissionContext: userPermissionContext({ trustOrigin: "llm-tool-arg", userIntent: "Print ready in the selected terminal.", currentTaskStep: "Run the requested terminal status command.", ...(options.headless ? { headless: true } : {}) }),
  });
  return { manager, pause, typed, cards, request, approve, deny, gate, reached, release, run, command };
}

describe("host terminal late native approval", () => {
  it.each(["native", "non-native", "tainted"] as const)("rechecks a preissued terminal rule before late native authority: %s", async kind => {
    const f = await fixture();
    await runWithHostTerminalTurn({ sessionId: SESSION_ID, turnId: "initial-turn" }, async () => {
      const pending = f.run();
      await f.reached;
      expect(f.cards).toHaveLength(0);
      expect(f.typed).toEqual([]);
      if (kind === "tainted") noteToolResultsReturnedToModel();
      else await f.pause();
      f.release();
      await vi.waitFor(() => expect(f.cards).toHaveLength(1));
      const card = f.cards[0];
      expect(f.request.mock.calls[0]?.[0]).toMatchObject({
        durableApprovalRecordAllowed: false,
        hostTerminal: { tabId: TAB_ID, sessionId: SESSION_ID, command: COMMAND, shell: "zsh" },
      });
      expect(card.sandboxCapability).toMatchObject({ kind: "none", confines: { filesystem: false, process: false, network: false } });
      expect(card.exactRecordAllowed).toBe(false);
      if (kind === "tainted") {
        expect(f.request.mock.calls[0]?.[0]).toMatchObject({ hostTerminal: { afterExternalContent: true }, forceExplicit: true });
        expect(card.allowedChoices).toEqual(["allow-once", "deny-once"]);
        expect(card.shellRule).toMatchObject({ sessionAllowed: false, persistentAllowed: false });
      }
      if (kind === "non-native") {
        expect(f.approve(card, false)).toBeNull();
        expect(f.gate.pendingCount).toBe(1);
        expect(f.typed).toEqual([]);
        f.deny(card);
      } else f.approve(card, true);
      const [result] = await pending;
      if (kind === "non-native") {
        expect(result.is_error).toBe(true);
        expect(f.typed).toEqual([]);
      } else {
        expect(result.is_error, result.content).toBeFalsy();
        expect(f.typed).toEqual([COMMAND]);
      }
      expect(f.cards).toHaveLength(1);
      expect(f.manager.isAutomatedApprovalPaused(SESSION_ID)).toBe(kind !== "tainted");
    });
  });

  it("denies a changed user turn after rule admission before any card or PTY write", async () => {
    const f = await fixture();
    let pending: Promise<ToolResult[]> | undefined;
    await runWithHostTerminalTurn({ sessionId: SESSION_ID, turnId: "initial-turn" }, async () => {
      pending = f.run();
      await f.reached;
    });
    await runWithHostTerminalTurn({ sessionId: SESSION_ID, turnId: "replacement-turn" }, async () => {
      f.release();
      const [result] = await pending!;
      expect(result.is_error).toBe(true);
      expect(f.cards).toHaveLength(0);
      expect(f.typed).toEqual([]);
    });
  });
  it.each(["default", "strict"] as const)("binds the first outside-write card to native terminal authority in %s", async mode => {
    const f = await fixture({ outside: true, mode, exactRule: false, holdFinalizer: false });
    await runWithHostTerminalTurn({ sessionId: SESSION_ID, turnId: "outside-command-turn" }, async () => {
      const pending = f.run();
      await vi.waitFor(() => expect(f.cards).toHaveLength(1));
      const card = f.cards[0];
      expect(card.kind).toBe("out-of-allowed-dir");
      expect(f.request.mock.calls[0]?.[0]).toMatchObject({
        durableApprovalRecordAllowed: false,
        hostTerminal: { tabId: TAB_ID, sessionId: SESSION_ID, command: f.command },
        sandboxCapability: { kind: "none", confines: { filesystem: false, process: false, network: false } },
      });
      expect(f.typed).toEqual([]);
      expect(f.approve(card, false)).toBeNull();
      expect(f.gate.pendingCount).toBe(1);
      expect(f.typed).toEqual([]);
      f.approve(card, true);
      const [result] = await pending;
      expect(result.is_error, result.content).toBeFalsy();
      expect(f.typed).toEqual([f.command]);
      expect(f.cards).toHaveLength(1);
    });
  });

  it.each(["allow", "auto", "ask"] as const)("applies the native %s choice to this and later terminal commands", async choice => {
    const logical = vi.fn(async () => ({ consistent: true, reason: "The status command follows the user's task." }));
    const f = await fixture({ exactRule: false, holdFinalizer: false, surfaceChoice: choice, logicalReview: logical });
    await runWithHostTerminalTurn({ sessionId: SESSION_ID, turnId: "surface-choice-turn" }, async () => {
      const first = f.run();
      await vi.waitFor(() => expect(f.cards).toHaveLength(1));
      expect(f.cards[0].userOwnedSurface).toBe("host-terminal");
      expect(f.typed).toEqual([]);
      f.approve(f.cards[0], true);
      expect((await first)[0].is_error).toBeFalsy();
      expect(f.manager.getUserOwnedSurfaceChoice(SESSION_ID, "host-terminal")).toBe(choice);
      const second = f.run();
      if (choice === "ask") {
        await vi.waitFor(() => expect(f.cards).toHaveLength(2));
        f.approve(f.cards[1], true);
      }
      expect((await second)[0].is_error).toBeFalsy();
      expect(f.typed).toEqual([COMMAND, COMMAND]);
      expect(logical).toHaveBeenCalledTimes(choice === "auto" ? 2 : 0);
      expect(f.cards).toHaveLength(choice === "ask" ? 2 : 1);
    });
  });

  it.each(["allow", "auto"] as const)("keeps a single outside-write selector when the terminal choice is %s", async choice => {
    const logical = vi.fn(async () => ({ consistent: true, reason: "The requested redirected command follows the current task." }));
    const f = await fixture({ outside: true, mode: "strict", exactRule: false, holdFinalizer: false, surfaceChoice: choice, logicalReview: logical });
    await runWithHostTerminalTurn({ sessionId: SESSION_ID, turnId: "outside-choice-turn" }, async () => {
      const pending = f.run();
      await vi.waitFor(() => expect(f.cards).toHaveLength(1));
      expect(f.cards[0]).toMatchObject({ kind: "out-of-allowed-dir", userOwnedSurface: "host-terminal" });
      f.approve(f.cards[0], true);
      const [result] = await pending;
      expect(result.is_error, result.content).toBeFalsy();
      expect(f.cards).toHaveLength(1);
      expect(f.typed).toEqual([f.command]);
      expect(logical).toHaveBeenCalledTimes(choice === "auto" ? 1 : 0);
    });
  });

  it("denies a user-owned terminal in headless mode despite a saved surface Allow", async () => {
    const f = await fixture({ exactRule: false, holdFinalizer: false, headless: true });
    f.manager.setUserOwnedSurfaceChoice(SESSION_ID, "host-terminal", "allow");
    await runWithHostTerminalTurn({ sessionId: SESSION_ID, turnId: "headless-turn" }, async () => {
      const [result] = await f.run();
      expect(result.is_error).toBe(true);
      expect(result.content).toContain(NO_APPROVER_MESSAGE);
      expect(f.cards).toHaveLength(0);
      expect(f.typed).toEqual([]);
    });
  });

  it("refuses an outside command without a current user turn before its first directory card", async () => {
    const f = await fixture({ outside: true, mode: "strict", exactRule: false, holdFinalizer: false });
    const [result] = await runWithHostTerminalTurn(undefined, f.run);
    expect(result.is_error).toBe(true);
    expect(f.cards).toHaveLength(0);
    expect(f.request).not.toHaveBeenCalled();
    expect(f.typed).toEqual([]);
  });

  it("rechecks a replaced turn before outside directory admission", async () => {
    const f = await fixture({ outside: true, mode: "strict", exactRule: false, holdFinalizer: false });
    let entered!: () => void;
    let release!: () => void;
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const held = new Promise<void>(resolve => { release = resolve; });
    const load = f.manager.ensureProjectRulesLoaded.bind(f.manager);
    vi.spyOn(f.manager, "ensureProjectRulesLoaded").mockImplementationOnce(async cwd => {
      await load(cwd);
      entered();
      await held;
    });
    let pending: Promise<ToolResult[]> | undefined;
    await runWithHostTerminalTurn({ sessionId: SESSION_ID, turnId: "original-outside-turn" }, async () => {
      pending = f.run();
      await reached;
    });
    await runWithHostTerminalTurn({ sessionId: SESSION_ID, turnId: "replacement-outside-turn" }, async () => {
      release();
      const [result] = await pending!;
      expect(result.is_error).toBe(true);
      expect(f.request).not.toHaveBeenCalled();
      expect(f.cards).toHaveLength(0);
      expect(f.typed).toEqual([]);
    });
  });

});
