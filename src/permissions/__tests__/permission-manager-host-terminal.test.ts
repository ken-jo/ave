import { bindRemoteControllerToSession } from "../../shared/chat-origin.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PermissionManager, type PermissionCheckContext } from "../permission-manager.js";
import type { HostTerminalCommandScope } from "../../tools/terminal-run.js";
import { noteOtherPrincipalGuidance, noteToolResultsReturnedToModel, runWithHostTerminalTurn } from "../../tools/host-terminal-turn.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { NO_APPROVER_MESSAGE } from "../decision-pipeline.js";

let directory: string;
let manager: PermissionManager;
let scope: HostTerminalCommandScope;
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "ave-terminal-admission-"));
  manager = new PermissionManager(join(directory, "permissions.json"));
  manager.setMode("allow");
  scope = { kind: "terminal-command", lane: "manual", commandSha256: "a".repeat(64), tabId: "terminal-tab", terminalSessionId: "terminal-instance", sessionId: "pane", turnId: "typed-turn", shell: "zsh", cwd: directory, physicalCwd: directory, cwdDevice: "1", cwdInode: "2", controlGeneration: 1, cwdForMatch: directory };
});
afterEach(() => cleanupTmpDir(directory));

function check(patch: PermissionCheckContext = {}) {
  return manager.checkDetailed("terminal_run", "builtin", "shell", undefined, {
    sessionId: "pane", trustOrigin: "llm-tool-arg", hostTerminalTurn: scope,
    fileWritePolicy: { insideProject: false, directoryApproved: false, checkpointAvailable: true },
    ...patch,
  });
}

describe("host terminal admission before directory authorization", () => {
  it("admits the bound remote owner through the shared terminal choice", async () => {
    const remoteControllerAuthority = bindRemoteControllerToSession({ kind: "tailnet-controller", actorId: "tailnet:owner" }, "pane");
    manager.setUserOwnedSurfaceChoice("pane", "browser", "allow");
    await runWithHostTerminalTurn({ sessionId: "pane", turnId: "typed-turn" }, async () => {
      expect(check({ remoteControllerAuthority, trustOrigin: "llm-tool-arg" })).toMatchObject({ decision: "allow", reasonCode: "user-owned-surface-allow" });
      noteToolResultsReturnedToModel();
      expect(check({ remoteControllerAuthority, trustOrigin: "file-content" })).toMatchObject({ decision: "ask", forceModal: true, reasonCode: "other-principal" });
    });
  });
  it("normalizes a manual scope to its physical host rule target when the caller omits that target", async () => {
    manager.setMode("default");
    const command = "touch output.txt";
    await manager.addRulePersist({ pattern: `Bash(${command})`, action: "allow" }, { kind: "user" });
    await runWithHostTerminalTurn({ sessionId: "pane", turnId: "typed-turn" }, async () => {
      const context: PermissionCheckContext = { fileWritePolicy: undefined, ruleSubject: { kind: "shell", dialect: "bash", command, cwd: join(directory, "caller-spelling") } };
      const generic = check(context);
      expect(generic.pipelineRequest?.rules?.allow).toBeUndefined();
      expect(generic.decision).toBe("ask");
      expect(check(context)).toMatchObject({ decision: "ask", reasonCode: "user-owned-surface-ask" });
      manager.setUserOwnedSurfaceChoice("pane", "host-terminal", "allow");
      expect(check(context)).toMatchObject({ decision: "allow", reasonCode: "user-owned-surface-allow" });
      expect(check({ ...context, ruleSubject: { kind: "shell", dialect: "bash", command: "touch different.txt", cwd: directory } }).pipelineRequest?.rules?.allow).toBeUndefined();
      noteOtherPrincipalGuidance();
      expect(check(context)).toMatchObject({ decision: "deny", reasonCode: "host-terminal-turn" });
    });
  });

  it("denies a fabricated manual scope without a current user turn before a directory card", () => {
    expect(check()).toMatchObject({ decision: "deny", reasonCode: "host-terminal-turn" });
    expect(check().requiresCodeCheckpoint).toBeUndefined();
  });

  it.each([
    { headless: true },
    { approvalSurface: "unavailable" as const },
    { trustOrigin: "plugin-emitted" as const },
    { trustOrigin: undefined },
    { sessionId: "another-pane" },
  ])("denies an ineligible invocation before any directory fallback: %j", async patch => {
    await runWithHostTerminalTurn({ sessionId: "pane", turnId: "typed-turn" }, async () => {
      expect(check(patch)).toMatchObject({ decision: "deny", reasonCode: "host-terminal-turn" });
    });
  });

  it.each([{ headless: true }, { approvalSurface: "unavailable" as const }])("makes an absent approval surface terminal: %j", async patch => {
    await runWithHostTerminalTurn({ sessionId: "pane", turnId: "typed-turn" }, async () => {
      expect(check(patch)).toMatchObject({ decision: "deny", reason: NO_APPROVER_MESSAGE });
    });
  });

  it("recollects ended turn and late guidance admission facts from the issued host context", async () => {
    const initial = await runWithHostTerminalTurn({ sessionId: "pane", turnId: "typed-turn" }, async () => check({ fileWritePolicy: undefined }));
    expect(manager.recheckPermission(initial)).toMatchObject({ decision: "deny", reasonCode: "host-terminal-turn" });
    await runWithHostTerminalTurn({ sessionId: "pane", turnId: "typed-turn" }, async () => {
      const beforeGuidance = check({ fileWritePolicy: undefined });
      noteOtherPrincipalGuidance();
      expect(manager.recheckPermission(beforeGuidance)).toMatchObject({ decision: "deny", reasonCode: "host-terminal-turn" });
    });
  });

  it("recollects late external content ahead of pause and remembered approval without serializing host context", async () => {
    await runWithHostTerminalTurn({ sessionId: "pane", turnId: "typed-turn" }, async () => {
      const initial = check({ fileWritePolicy: undefined });
      expect(initial.pipelineRequest).not.toHaveProperty("hostTerminalTurn");
      noteToolResultsReturnedToModel();
      for (let index = 0; index < 3; index += 1) manager.getJudgeBreaker().record("pane", "ask", `block-${index}`);
      const refreshed = manager.recheckPermission(initial);
      expect(refreshed).toMatchObject({ decision: "ask", forceModal: true, reasonCode: "other-principal" });
      expect(manager.resolveRememberedPermission(refreshed, "Prior scoped approval")).toMatchObject({ decision: "ask", forceModal: true, reasonCode: "other-principal" });
      expect(manager.recheckPermission(refreshed)).toMatchObject({ decision: "ask", forceModal: true, reasonCode: "other-principal" });
    });
  });

  it("denies a scope bound to another turn and guidance from another principal", async () => {
    await runWithHostTerminalTurn({ sessionId: "pane", turnId: "different-turn" }, async () => {
      expect(check()).toMatchObject({ decision: "deny", reasonCode: "host-terminal-turn" });
    });
    await runWithHostTerminalTurn({ sessionId: "pane", turnId: "typed-turn" }, async () => {
      noteOtherPrincipalGuidance();
      expect(check()).toMatchObject({ decision: "deny", reasonCode: "host-terminal-turn" });
    });
  });

  it("keeps external content as a mandatory principal floor ahead of directory and remembered grants", async () => {
    await runWithHostTerminalTurn({ sessionId: "pane", turnId: "typed-turn" }, async () => {
      noteToolResultsReturnedToModel();
      const result = check({ trustOrigin: "file-content" });
      expect(result).toMatchObject({ decision: "ask", forceModal: true, reasonCode: "other-principal" });
      expect(result.requiresCodeCheckpoint).toBeUndefined();
      expect(manager.resolveRememberedPermission(result, "Prior tool approval")).toMatchObject({ decision: "ask", forceModal: true, reasonCode: "other-principal" });
    });
  });

  it("accepts current untainted turn identity and rejects it after the turn ends", async () => {
    await runWithHostTerminalTurn({ sessionId: "pane", turnId: "typed-turn" }, async () => {
      expect(check().pipelineRequest?.admissionDenial).toBeUndefined();
    });
    expect(check()).toMatchObject({ decision: "deny", reasonCode: "host-terminal-turn" });
  });
});
