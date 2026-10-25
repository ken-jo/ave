import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const releaseEgressSession = vi.fn();
vi.mock("../egress-runtime.js", () => ({ releaseEgressSession }));

const { PermissionManager } = await import("../permission-manager.js");
const { endSessionScopedPermissions } = await import("../session-scope-end.js");
const { listSessionApprovals, recordApproval, __resetSessionStoreForTest } = await import("../user-approval-store.js");

let dir: string;
beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "session-scope-end-")));
  vi.stubEnv("AVE_HOME", join(dir, "state"));
  __resetSessionStoreForTest();
  releaseEgressSession.mockClear();
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

// Owner 2026-10-25 (D1/D3): every "This session" choice dies with its conversation.
describe("ending a conversation's session scope", () => {
  it("drops its session shell rules, session approvals and egress session hosts, and only its own", async () => {
    const manager = new PermissionManager(join(dir, "permissions.json"));
    manager.addSessionShellRule("ending", "Bash(printf ready)");
    manager.addSessionShellRule("staying", "Bash(printf ready)");
    await recordApproval("web_fetch", "{}", "builtin", { scope: "session", verdictAtApproval: "low", nlJustification: null, sessionId: "ending" });
    await recordApproval("web_fetch", "{}", "builtin", { scope: "session", verdictAtApproval: "low", nlJustification: null, sessionId: "staying" });

    endSessionScopedPermissions("ending", manager);

    expect(manager.checkDetailed("bash", "builtin", "shell", null, plain("printf ready", "ending"))).toMatchObject({ decision: "ask" });
    expect(manager.checkDetailed("bash", "builtin", "shell", null, plain("printf ready", "staying"))).toMatchObject({ decision: "allow", layer: 3 });
    expect(listSessionApprovals().map((entry) => entry.sessionId)).toEqual(["staying"]);
    expect(releaseEgressSession).toHaveBeenCalledWith("ending");
  });

  it("still drops approvals and egress hosts when no permission manager is wired", async () => {
    await recordApproval("web_fetch", "{}", "builtin", { scope: "session", verdictAtApproval: "low", nlJustification: null, sessionId: "ending" });
    endSessionScopedPermissions("ending", undefined);
    expect(listSessionApprovals()).toEqual([]);
    expect(releaseEgressSession).toHaveBeenCalledWith("ending");
  });
});
