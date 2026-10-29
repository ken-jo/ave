import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const releaseEgressSessions = vi.fn<(ended: (sessionId: string) => boolean) => void>();
vi.mock("../egress-runtime.js", () => ({ releaseEgressSessions }));
const endAgentBrowserObservationSessions = vi.fn<(ended: (sessionId: string) => boolean) => void>();
vi.mock("../../tools/agent-browser-observation.js", () => ({ endAgentBrowserObservationSessions }));

const releaseConversationTerminals = vi.fn<(ended: (sessionId: string) => boolean) => void>();
vi.mock("../../main/terminal/pty-manager.js", () => ({ releaseConversationTerminals }));

const { PermissionManager } = await import("../permission-manager.js");
const { endSessionScopedPermissions } = await import("../session-scope-end.js");
const { dropSessionApprovals, listSessionApprovals, recordApproval, setApprovalConversationRootResolver, __resetSessionStoreForTest } = await import("../user-approval-store.js");

// The sessions the egress release selected, among the ones named.
function releasedAmong(...sessionIds: string[]): string[] {
  expect(releaseEgressSessions).toHaveBeenCalledTimes(1);
  const ended = releaseEgressSessions.mock.calls[0]![0];
  expect(endAgentBrowserObservationSessions).toHaveBeenCalledTimes(1);
  expect(sessionIds.filter(endAgentBrowserObservationSessions.mock.calls[0]![0])).toEqual(sessionIds.filter(ended));
  expect(releaseConversationTerminals).toHaveBeenCalledTimes(1);
  expect(sessionIds.filter(releaseConversationTerminals.mock.calls[0]![0])).toEqual(sessionIds.filter(ended));
  return sessionIds.filter((sessionId) => ended(sessionId));
}

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "session-scope-end-")));
  vi.stubEnv("AVE_HOME", join(dir, "state"));
  __resetSessionStoreForTest();
  releaseEgressSessions.mockClear();
  releaseConversationTerminals.mockClear();
  endAgentBrowserObservationSessions.mockClear();
});
afterEach(() => {
  __resetSessionStoreForTest();
  vi.unstubAllEnvs();
  rmSync(dir, { recursive: true, force: true });
});

const plain = (command: string, sessionId: string) => ({
  ruleSubject: { kind: "shell" as const, dialect: "bash" as const, command, cwd: dir },
  shellExecution: { runsSandboxed: false },
  sessionId,
});

// Owner 2026-10-25 (five-choice cards): every "This session" choice dies with its conversation.
describe("ending a conversation's session scope", () => {
  it("drops its session shell rules, session approvals and egress session hosts, and only its own", async () => {
    const manager = new PermissionManager(join(dir, "permissions.json"));
    manager.addSessionRule("ending", "Bash(printf ready)");
    manager.addSessionRule("staying", "Bash(printf ready)");
    await recordApproval("web_fetch", "{}", "builtin", { scope: "session", verdictAtApproval: "low", nlJustification: null, sessionId: "ending" });
    await recordApproval("web_fetch", "{}", "builtin", { scope: "session", verdictAtApproval: "low", nlJustification: null, sessionId: "staying" });

    endSessionScopedPermissions("ending", manager);

    expect(manager.checkDetailed("bash", "builtin", "shell", null, plain("printf ready", "ending"))).toMatchObject({ decision: "ask" });
    expect(manager.checkDetailed("bash", "builtin", "shell", null, plain("printf ready", "staying"))).toMatchObject({ decision: "allow", layer: 3 });
    expect(listSessionApprovals().map((entry) => entry.sessionId)).toEqual(["staying"]);
    expect(releasedAmong("ending", "staying")).toEqual(["ending"]);
  });

  it("still drops approvals and egress hosts when no permission manager is wired", async () => {
    await recordApproval("web_fetch", "{}", "builtin", { scope: "session", verdictAtApproval: "low", nlJustification: null, sessionId: "ending" });
    endSessionScopedPermissions("ending", undefined);
    expect(listSessionApprovals()).toEqual([]);
    expect(releasedAmong("ending")).toEqual(["ending"]);
  });

  // A sub-agent session shares its root's session rules and approvals but holds its own egress session hosts.
  const tree: Record<string, string> = { "child-1": "root", "child-2": "root", "other-child": "other" };
  const withTree = () => setApprovalConversationRootResolver((sessionId) => tree[sessionId] ?? sessionId);

  it("ends the whole tree when its root conversation is deleted", async () => {
    withTree();
    const manager = new PermissionManager(join(dir, "permissions.json"));
    manager.addSessionRule("child-1", "Bash(printf ready)");
    manager.addSessionRule("other", "Bash(printf ready)");
    await recordApproval("web_fetch", "{}", "builtin", { scope: "session", verdictAtApproval: "low", nlJustification: null, sessionId: "child-2" });
    await recordApproval("web_fetch", "{}", "builtin", { scope: "session", verdictAtApproval: "low", nlJustification: null, sessionId: "other" });

    endSessionScopedPermissions("root", manager);

    expect(manager.listSessionRules("root")).toEqual([]);
    expect(manager.checkDetailed("bash", "builtin", "shell", null, plain("printf ready", "child-1"))).toMatchObject({ decision: "ask" });
    expect(manager.listSessionRules("other")).toEqual(["Bash(printf ready)"]);
    expect(listSessionApprovals().map((entry) => entry.sessionId)).toEqual(["other"]);
    expect(releasedAmong("root", "child-1", "child-2", "other", "other-child")).toEqual(["root", "child-1", "child-2"]);
  });

  it("ends only a deleted sub-agent session's own egress hosts, keeping its root's rules and approvals", async () => {
    withTree();
    const manager = new PermissionManager(join(dir, "permissions.json"));
    manager.addSessionRule("child-1", "Bash(printf ready)");
    await recordApproval("web_fetch", "{}", "builtin", { scope: "session", verdictAtApproval: "low", nlJustification: null, sessionId: "child-1" });

    endSessionScopedPermissions("child-1", manager);

    expect(manager.listSessionRules("root")).toEqual(["Bash(printf ready)"]);
    expect(manager.checkDetailed("bash", "builtin", "shell", null, plain("printf ready", "child-2"))).toMatchObject({ decision: "allow", layer: 3 });
    expect(listSessionApprovals().map((entry) => entry.sessionId)).toEqual(["root"]);
    expect(releasedAmong("root", "child-1", "child-2")).toEqual(["child-1"]);
  });

  it("refuses to end root-held session state by a sub-agent id", () => {
    withTree();
    const manager = new PermissionManager(join(dir, "permissions.json"));
    expect(() => manager.endSession("child-1")).toThrow(/root conversation/);
    expect(() => dropSessionApprovals("child-1")).toThrow(/root conversation/);
  });

  it("releases counted invocation identities only when the root session ends", () => {
    withTree();
    const manager = new PermissionManager(join(dir, "permissions.json"));
    const breaker = manager.getJudgeBreaker();
    breaker.record("root", "ask", "reviewed-action");
    breaker.record("other", "ask", "other-action");
    endSessionScopedPermissions("child-1", manager);
    expect(breaker.snapshot("root")).toEqual({ consecutive: 1, total: 1, open: false });
    endSessionScopedPermissions("root", manager);
    expect(breaker.snapshot("root")).toEqual({ consecutive: 0, total: 0, open: false });
    breaker.record("root", "ask", "reviewed-action");
    expect(breaker.snapshot("root")).toEqual({ consecutive: 1, total: 1, open: false });
    expect(breaker.snapshot("other")).toEqual({ consecutive: 1, total: 1, open: false });
  });
});
