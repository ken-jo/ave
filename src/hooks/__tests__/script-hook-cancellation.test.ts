import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PermissionTestResources } from "../../permissions/__tests__/test-resources.js";
import { turnExtensionPolicyContext } from "../../shared/turn-extension-policy.js";
import { deferred } from "../../__tests__/support/deferred.js";
import { runOneHookScript, type RunnableHook } from "../script-hook-runner.js";
import type { ScriptHookStdin } from "../script-hook-types.js";

const resources = new PermissionTestResources();
afterEach(() => resources.cleanup());

const payload: ScriptHookStdin = {
  hookType: "pre", toolName: "write_file", source: "builtin", category: "write",
  input: {}, sessionId: "cancel-hook-session", trustOrigin: "user-keyboard",
};

function waitingHook(pidPath: string): RunnableHook {
  return {
    id: "waiting-command", hookType: "pre", source: "config", hookPath: "node",
    command: ["node", "-e", "require('node:fs').writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000);", pidPath],
  };
}

describe("script hook caller cancellation", () => {
  it("kills only the owned hook child and leaves another hook running", async () => {
    const root = resources.makeTmpDir("ave-hook-cancel-");
    const firstPath = join(root, "first.pid");
    const secondPath = join(root, "second.pid");
    const first = new AbortController();
    const second = new AbortController();
    const firstRun = runOneHookScript(waitingHook(firstPath), payload, { cwd: root, abortSignal: first.signal });
    const secondRun = runOneHookScript(waitingHook(secondPath), payload, { cwd: root, abortSignal: second.signal });
    try {
      let firstPid = 0;
      let secondPid = 0;
      await vi.waitFor(() => {
        firstPid = Number(readFileSync(firstPath, "utf8"));
        secondPid = Number(readFileSync(secondPath, "utf8"));
        expect(firstPid).toBeGreaterThan(0);
        expect(secondPid).toBeGreaterThan(0);
      });
      first.abort(new Error("owner stopped first hook"));
      expect(await firstRun).toMatchObject({ decision: "deny", reason: "Hook execution cancelled", timedOut: false });
      expect(() => process.kill(firstPid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
      expect(() => process.kill(secondPid, 0)).not.toThrow();
    } finally {
      first.abort();
      second.abort();
      await Promise.all([firstRun, secondRun]);
    }
  });

  it("inherits cancellation through the current turn and never spawns after held admission resolves", async () => {
    const root = resources.makeTmpDir("ave-hook-admission-cancel-");
    const pidPath = join(root, "not-started.pid");
    const caller = new AbortController();
    const held = deferred<{ decision: "allow"; reason: string }>();
    const entered = deferred<void>();
    const running = turnExtensionPolicyContext.run({ allowExternalHooks: true, abortSignal: caller.signal }, () =>
      runOneHookScript(waitingHook(pidPath), payload, {
        cwd: root,
        authorizeCommand: async () => { entered.resolve(); return held.promise; },
      }));
    await entered.promise;
    caller.abort(new Error("owner stopped before admission"));
    expect(await running).toMatchObject({ decision: "deny", reason: "Hook execution cancelled", timedOut: false });
    held.resolve({ decision: "allow", reason: "Late approval" });
    await Promise.resolve();
    expect(() => readFileSync(pidPath)).toThrow(expect.objectContaining({ code: "ENOENT" }));
  });
});
