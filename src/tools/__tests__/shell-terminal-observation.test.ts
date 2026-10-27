import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { __resetActiveSandboxCapabilityForTest, __resetSandboxRequestedAtBootForTest, setShellSandboxRequestedAtBoot } from "../../permissions/sandbox-capability.js";
import { runWithInvocationOrigin } from "../../plugins/runtime/origin-chain.js";
import type { ObservationIdentity } from "../../shared/agent-observation.js";
import { runWithAgentObservationInvocation, runWithAgentObservationTurn } from "../agent-observation-context.js";
import { setAgentTerminalObservationSink, type AgentTerminalObservationInput, type AgentTerminalObservationLease } from "../agent-terminal-observation.js";
import { backgroundShellManager, BashTool, controlShellTask, listShellTasks } from "../shell-tools.js";

interface ObservedRun {
  identity: ObservationIdentity;
  input: AgentTerminalObservationInput;
  output: string[];
  finish: ReturnType<typeof vi.fn<AgentTerminalObservationLease["finish"]>>;
  revoke: ReturnType<typeof vi.fn<AgentTerminalObservationLease["revoke"]>>;
}
let directory: string;
let runs: ObservedRun[];
const identity = { sessionId: "shell-observation-session", turnId: "shell-observation-turn", toolUseId: "shell-observation-tool" };

beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "ave-shell-observation-")));
  runs = [];
  __resetActiveSandboxCapabilityForTest();
  __resetSandboxRequestedAtBootForTest();
  setShellSandboxRequestedAtBoot(false);
  setAgentTerminalObservationSink({
    start: (owner, input) => {
      const run: ObservedRun = { identity: owner, input, output: [], finish: vi.fn(), revoke: vi.fn() };
      runs.push(run);
      return { signal: new AbortController().signal, write: (text) => { run.output.push(text); }, finish: run.finish, revoke: run.revoke, bindEgress: vi.fn(), releaseHeldOutput: vi.fn() };
    },
    egress: vi.fn(), releaseSessions: vi.fn(),
  });
});
afterEach(async () => {
  setAgentTerminalObservationSink(undefined);
  backgroundShellManager.disposeSession(identity.sessionId);
  await backgroundShellManager.waitForLocalCleanup(identity.sessionId);
  __resetActiveSandboxCapabilityForTest();
  __resetSandboxRequestedAtBootForTest();
  await cleanupTmpDir(directory);
});

function execute(command: string, background = false, signal?: AbortSignal) {
  return new BashTool().execute({ command, timeoutSeconds: 5, run_in_background: background }, {
    cwd: directory, extraAllowedDirectories: [], metadata: { ...identity }, ...(signal ? { abortSignal: signal } : {}),
  });
}
function agent<T>(run: () => Promise<T>) {
  return runWithAgentObservationTurn(identity, () => runWithAgentObservationInvocation(identity, run));
}

describe("shell command observation provenance and lifetime", () => {
  it("does not observe ordinary shell callers carrying agent-shaped metadata", async () => {
    expect((await execute("printf user-command")).isError).toBe(false);
    expect(runs).toEqual([]);
  });

  it("does not observe UI-origin shell execution inside an existing model turn", async () => {
    const result = await agent(() => runWithInvocationOrigin("ui", undefined, () => execute("printf user-command")));
    expect(result.isError).toBe(false);
    expect(runs).toEqual([]);
  });

  it("streams the admitted command with its real cwd and exit code, excluding private cwd probes", async () => {
    const result = await agent(() => execute("printf 'hello\\n'; printf 'error\\n' >&2; exit 7"));
    expect(result.metadata?.returncode).toBe(7);
    expect(runs).toHaveLength(1);
    expect(runs[0].identity).toEqual(identity);
    expect(runs[0].input).toMatchObject({ kind: "shell", cwd: directory, sandbox: { mode: "unconfined" } });
    expect(runs[0].output.join("")).toBe("hello\nerror\n");
    expect(runs[0].output.join("")).not.toContain("AVE_CWD");
    expect(runs[0].finish).toHaveBeenCalledExactlyOnceWith(7, undefined);
  });

  it("decodes split UTF8 per pipe without cross-pipe corruption", async () => {
    const result = await agent(() => execute("printf '\\360\\237'; sleep 0.05; printf err >&2; sleep 0.05; printf '\\230\\200done\\n'"));
    expect(result.isError).toBe(false);
    expect(runs[0].output.join("")).toBe("err😀done\n");
  });

  it("keeps direct background observation alive after invocation end and beyond model output retention", async () => {
    const result = await agent(() => execute("sleep 0.15; yes x | head -c 210000; sleep 0.15; printf 'observed-tail\\n'; exit 3", true));
    expect(result.metadata?.backgrounded).toBe(true);
    expect(runs).toHaveLength(1);
    expect(runs[0].finish).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(runs[0].finish).toHaveBeenCalledOnce(), { timeout: 5000 });
    expect(runs[0].output.join("")).toContain("observed-tail\n");
    expect(runs[0].output.join("").length).toBeGreaterThan(200_000);
    expect(runs[0].finish).toHaveBeenCalledWith(3, "failed");
  });

  it("retains one observation across foreground handoff and completes only when the child ends", async () => {
    const pending = agent(() => execute("printf before; sleep 0.4; printf 'after\\n'"));
    await vi.waitFor(() => expect(listShellTasks(identity.sessionId)[0]?.output).toContain("before"));
    const transfer = controlShellTask(identity.sessionId, "background");
    if (process.platform === "win32") {
      expect(transfer).toEqual({ ok: false, error: "background-unavailable" });
      expect((await pending).metadata?.backgrounded).not.toBe(true);
    } else {
      expect(transfer.ok).toBe(true);
      expect((await pending).metadata?.backgrounded).toBe(true);
      expect(runs[0].finish).not.toHaveBeenCalled();
    }
    expect(runs).toHaveLength(1);
    await vi.waitFor(() => expect(runs[0].finish).toHaveBeenCalledOnce(), { timeout: 5000 });
    expect(runs[0].output.join("")).toBe("beforeafter\n");
    expect(runs[0].finish).toHaveBeenCalledWith(0, undefined);
  });

  it("finishes cancelled observation after command termination", async () => {
    const controller = new AbortController();
    const pending = agent(() => execute("printf ready; sleep 20", false, controller.signal));
    await vi.waitFor(() => expect(runs[0]?.output.join("")).toContain("ready"));
    controller.abort();
    expect((await pending).metadata?.aborted).toBe(true);
    expect(runs[0].finish).toHaveBeenCalledOnce();
    expect(runs[0].finish.mock.calls[0][1]).toBe("cancelled");
  });

  it("fails observation admission before spawning a child", async () => {
    setAgentTerminalObservationSink({ start: () => { throw new Error("Observation command limit exceeded."); },
      egress: vi.fn(), releaseSessions: vi.fn() });
    await expect(agent(() => execute("printf started > should-not-run"))).rejects.toThrow("Observation command limit exceeded.");
    expect(existsSync(join(directory, "should-not-run"))).toBe(false);
  });
});
