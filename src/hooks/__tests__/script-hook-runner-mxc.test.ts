/** Hooks as extension container holders (design row 5): the user-hook shell-plan selector, bash-incompatible before admission, hook JSON in,
 * stdout/status out, admitted cwd/env and teardown. The holder adapter is mocked; its layout has its own tests. */
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RunnableHook } from "../script-hook-runner.js";
import type { ScriptHookStdin } from "../script-hook-types.js";
import type { HostShellExecutionPlan } from "../../permissions/host-shell-execution-plan.js";

const state = vi.hoisted(() => ({
  selected: true,
  holderSpawn: vi.fn(),
  legacySpawn: vi.fn(),
  shellPlan: undefined as unknown,
  shell: { cmd: "C:\\Program Files\\Git\\bin\\bash.exe", shellArgs: (script: string) => ["-c", script], windowsFlavor: "msys" },
  startAllowed: vi.fn(),
}));

vi.mock("../../sandbox/wrap-bundled-command.js", async (original) => ({
  ...await original<typeof import("../../sandbox/wrap-bundled-command.js")>(),
  isMxcExtensionBackendSelected: () => state.selected,
  spawnMxcBundledHolder: (input: unknown) => state.holderSpawn(input),
  spawnWindowsBundledProcess: (input: unknown) => state.legacySpawn(input),
}));
vi.mock("../../permissions/sandbox-capability.js", async (original) => ({
  ...await original<typeof import("../../permissions/sandbox-capability.js")>(),
  getHostShellExecutionPlan: () => state.shellPlan,
  isIssuedHostShellExecutionPlan: () => true,
  getIssuedHostShellExecutionPlanGeneration: () => "g1",
  getSandboxGeneration: () => "g1",
}));
vi.mock("../../permissions/asrt-sandbox.js", async (original) => ({
  ...await original<typeof import("../../permissions/asrt-sandbox.js")>(),
  isPluginWorkerConfinementActive: () => true,
  assertExtensionStartAllowed: (...args: unknown[]) => state.startAllowed(...args),
  cleanupAsrtSandboxAfterCommand: async () => undefined,
}));
vi.mock("../../lib/shell-resolver.js", async (original) => ({
  ...await original<typeof import("../../lib/shell-resolver.js")>(),
  resolveShell: () => state.shell,
}));
vi.mock("../../main/managed-child-processes.js", async (original) => ({
  ...await original<typeof import("../../main/managed-child-processes.js")>(),
  assertManagedChildProcessAdmissionOpen: () => undefined,
}));

const { runOneHookScript } = await import("../script-hook-runner.js");
const { MxcProcessCleanupError } = await import("../../permissions/mxc-extension-errors.js");
const { FORWARD_ENV_KEYS } = await import("../../tools/safe-env.js");
const { setProcessPlatform } = await import("../../__tests__/support/process-platform.js");

const REAL_PLATFORM = process.platform;
const GEN = "C:\\ave\\plugins\\sample\\gen";
const DATA = "C:\\ave\\plugins\\sample\\data";
const PAYLOAD: ScriptHookStdin = {
  hookType: "pre", toolName: "fs_write", source: "builtin", category: "write", input: { path: "C:\\x" },
  sessionId: "sess-1", trustOrigin: "user-keyboard",
};

function pluginHook(command: string[] = [`${GEN}\\hook.exe`, "--check"]): RunnableHook {
  return {
    id: "sample:pre", hookType: "pre", command, hookPath: command[0]!, source: "config", env: { HOOK_LEVEL: "strict" },
    pluginOwner: { pluginId: "sample", pluginVersion: "1.0.0", activationId: "a", generationId: "gen", localId: "pre", fingerprint: "f" },
    confinement: { kind: "bundled", pluginId: "sample", dataDir: DATA, generationRoot: GEN },
  };
}

function shellPlan(substrate: "asrt" | "mxc"): HostShellExecutionPlan {
  return { mode: "asrt", substrate, identity: `plan-${substrate}` } as unknown as HostShellExecutionPlan;
}

function userHook(command: string[]): RunnableHook {
  return { id: "user:pre", hookType: "pre", command, hookPath: command[0]!, source: "config" };
}

function admitUnder(plan: HostShellExecutionPlan) {
  state.shellPlan = plan;
  return { cwd: "D:\\work", authorizeCommand: async () => ({ decision: "allow" as const, reason: "ok", plan }) };
}

interface FakeRun { code?: number; stdout?: string; stderr?: string; hang?: boolean }

/** An owned process whose stdin is read to EOF, then answers with the given output and status. */
function fakeHolder(run: FakeRun = {}) {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  let settle!: (value: { exitCode: number; timedOut: boolean }) => void;
  let fail!: (error: Error) => void;
  let settled = false;
  const completion = new Promise<{ exitCode: number; timedOut: boolean }>((resolve, reject) => {
    settle = (value) => { settled = true; resolve(value); };
    fail = (error) => { settled = true; reject(error); };
  });
  completion.catch(() => {});
  let input = "";
  stdin.on("data", (chunk: Buffer) => { input += chunk.toString("utf8"); });
  stdin.on("end", () => {
    if (run.hang) return;
    stdout.end(run.stdout ?? "");
    stderr.end(run.stderr ?? "");
    settle({ exitCode: run.code ?? 0, timedOut: false });
  });
  let quarantined = false;
  const release = vi.fn(async () => {
    if (!settled) fail(new Error("sandbox process was disposed before completion"));
    stdout.end();
  });
  const holder = {
    process: { id: 9, stdin, stdout, stderr, completion, dispose: vi.fn(), diagnostics: {} },
    confinement: "windows-mxc" as const,
    release,
    get quarantined() { return quarantined; },
    quarantine() { quarantined = true; },
  };
  return { holder, input: () => input };
}

beforeEach(() => {
  setProcessPlatform("win32");
  state.selected = true;
  state.holderSpawn.mockReset();
  state.legacySpawn.mockReset();
  state.legacySpawn.mockRejectedValue(new Error("legacy route reached"));
  state.startAllowed.mockReset();
  state.shellPlan = shellPlan("asrt");
});

afterEach(() => setProcessPlatform(REAL_PLATFORM));

describe("plugin hook under a selected container backend", () => {
  it("runs as its own holder: JSON in on native stdin, decision JSON out, generation read, data write", async () => {
    const fake = fakeHolder({ stdout: '{"action":"allow","reason":"fine"}' });
    state.holderSpawn.mockResolvedValue(fake.holder);
    const result = await runOneHookScript(pluginHook(), PAYLOAD);
    expect(result).toMatchObject({ decision: "allow", reason: "fine", exitCode: 0 });
    const spec = state.holderSpawn.mock.calls[0]![0] as Record<string, unknown>;
    expect(spec).toMatchObject({ label: "hook:sample", command: `${GEN}\\hook.exe`, args: ["--check"], cwd: GEN,
      allowRead: [GEN], allowWrite: [DATA], ownedReadRoots: [GEN], workspaceRoots: [],
      egressOwner: { kind: "worker", role: "hook", pluginId: "sample" } });
    expect(JSON.parse(fake.input())).toMatchObject({ tool_name: "fs_write" });
    expect(fake.holder.release).toHaveBeenCalled();
    // The legacy guard and srt-win route are not consulted for a contained holder.
    expect(state.startAllowed).not.toHaveBeenCalled();
    expect(state.legacySpawn).not.toHaveBeenCalled();
  });

  it("gives the container the same host-owned variables the legacy route passes", async () => {
    const fake = fakeHolder({ stdout: '{"action":"allow","reason":"ok"}' });
    state.holderSpawn.mockResolvedValue(fake.holder);
    await runOneHookScript(pluginHook(), PAYLOAD);
    const contained = state.holderSpawn.mock.calls[0]![0] as { holderEnv: Record<string, string>; baseEnv: Record<string, string> };
    state.selected = false;
    await runOneHookScript(pluginHook(), PAYLOAD);
    const legacy = (state.legacySpawn.mock.calls[0]![0] as { baseEnv: Record<string, string> }).baseEnv;
    const forwarded = new Set<string>(FORWARD_ENV_KEYS.map((key) => key.toUpperCase()));
    const hostOwned = Object.fromEntries(Object.entries(legacy).filter(([key]) => !forwarded.has(key.toUpperCase())));
    expect(contained.holderEnv).toEqual(hostOwned);
    expect(contained.holderEnv).toMatchObject({ HOOK_LEVEL: "strict", AVE_HOOK_TYPE: "pre", PLUGIN_ROOT: GEN, PLUGIN_DATA: DATA });
    expect(contained.baseEnv).toEqual(legacy);
  });

  it("maps exit 2 to a block with stderr feedback and another non-zero status to a deny", async () => {
    state.holderSpawn.mockResolvedValueOnce(fakeHolder({ code: 2, stderr: "blocked by policy" }).holder);
    expect(await runOneHookScript(pluginHook(), PAYLOAD)).toMatchObject({ decision: "deny", exitCode: 2, blockFeedback: "blocked by policy" });
    state.holderSpawn.mockResolvedValueOnce(fakeHolder({ code: 5 }).holder);
    expect(await runOneHookScript(pluginHook(), PAYLOAD)).toMatchObject({ decision: "deny", exitCode: 5, reason: "hook exited non-zero (5): exit 5" });
    state.holderSpawn.mockResolvedValueOnce(fakeHolder({ stdout: "not json" }).holder);
    expect(await runOneHookScript(pluginHook(), PAYLOAD)).toMatchObject({ decision: "deny", reason: "hook stdout not valid decision JSON" });
  });

  it("disposes the container on timeout and on cancellation", async () => {
    const slow = fakeHolder({ hang: true });
    state.holderSpawn.mockResolvedValueOnce(slow.holder);
    expect(await runOneHookScript({ ...pluginHook(), timeoutMs: 20 }, PAYLOAD)).toMatchObject({ decision: "deny", timedOut: true });
    expect(slow.holder.release).toHaveBeenCalled();
    const cancelled = fakeHolder({ hang: true });
    state.holderSpawn.mockResolvedValueOnce(cancelled.holder);
    const controller = new AbortController();
    const pending = runOneHookScript(pluginHook(), PAYLOAD, { abortSignal: controller.signal });
    await vi.waitFor(() => expect(state.holderSpawn).toHaveBeenCalledTimes(2));
    controller.abort();
    expect(await pending).toMatchObject({ decision: "deny", reason: "Hook execution cancelled" });
    expect(cancelled.holder.release).toHaveBeenCalled();
  });

  it("denies and keeps the lease when termination is unverified", async () => {
    const fake = fakeHolder({ stdout: '{"action":"allow","reason":"ok"}' });
    fake.holder.release.mockRejectedValue(new MxcProcessCleanupError("death unverified"));
    state.holderSpawn.mockResolvedValue(fake.holder);
    const result = await runOneHookScript(pluginHook(), PAYLOAD);
    expect(result.decision).toBe("deny");
    expect(result.reason).toMatch(/termination is unverified/u);
  });

  it("names a refusal's stable code", async () => {
    state.holderSpawn.mockRejectedValue(Object.assign(new Error("Another contained process is writing this workspace"), { code: "holder-workspace-busy" }));
    expect((await runOneHookScript(pluginHook(), PAYLOAD)).reason).toBe("sandbox unavailable (holder-workspace-busy): Another contained process is writing this workspace");
  });

  it.each([["bash", "x.sh"], ["C:\\Program Files\\Git\\usr\\bin\\sh.exe", "-c", "true"]])(
    "refuses a bash-form command %s before admission", async (...command) => {
      const result = await runOneHookScript(pluginHook(command), PAYLOAD);
      expect(result).toMatchObject({ decision: "deny" });
      expect(result.reason).toMatch(/^sandbox unavailable \(bash-incompatible\): Git Bash cannot start/u);
      expect(state.holderSpawn).not.toHaveBeenCalled();
      expect(state.legacySpawn).not.toHaveBeenCalled();
    });

  it("cannot obtain the user-hook route: never srt-win under a container plan, never the exemption under a fallback plan", async () => {
    state.holderSpawn.mockResolvedValue(fakeHolder({ stdout: '{"action":"allow","reason":"ok"}' }).holder);
    await runOneHookScript(pluginHook(), PAYLOAD, { authorizeCommand: async () => ({ decision: "allow", reason: "x", plan: shellPlan("asrt") }) });
    expect(state.legacySpawn).not.toHaveBeenCalled();
    state.selected = false;
    await runOneHookScript(pluginHook(), PAYLOAD);
    expect(state.legacySpawn).toHaveBeenCalledTimes(1);
    expect(state.legacySpawn.mock.calls[0]![0]).not.toHaveProperty("userHookShellPlan");
  });
});

describe("pinned 0.0.80 fallback", () => {
  it("keeps the plugin hook on the srt-win route with its legacy grants and start guard", async () => {
    state.selected = false;
    const result = await runOneHookScript(pluginHook(), PAYLOAD);
    expect(result.reason).toBe("sandbox unavailable: legacy route reached");
    expect(state.startAllowed).toHaveBeenCalledWith();
    expect(state.legacySpawn.mock.calls[0]![0]).toMatchObject({ label: "hook:sample", cwd: GEN, allowRead: [GEN], allowWrite: [DATA] });
    expect(state.holderSpawn).not.toHaveBeenCalled();
  });
});

describe("user hook follows its admitted host-shell plan", () => {
  it("keeps an srt-win plan's route under a container extension backend, carrying the issued plan", async () => {
    const options = admitUnder(shellPlan("asrt"));
    await runOneHookScript(userHook(["C:\\tools\\check.exe"]), PAYLOAD, options);
    expect(state.holderSpawn).not.toHaveBeenCalled();
    expect(state.legacySpawn).toHaveBeenCalledTimes(1);
    expect((state.legacySpawn.mock.calls[0]![0] as { userHookShellPlan: unknown }).userHookShellPlan).toBe(state.shellPlan);
  });

  it("runs contained on a container shell plan with cwd write as a workspace", async () => {
    state.holderSpawn.mockResolvedValue(fakeHolder({ stdout: '{"action":"deny","reason":"no"}' }).holder);
    const options = admitUnder(shellPlan("mxc"));
    const result = await runOneHookScript(userHook(["powershell.exe", "-File", "C:\\hooks\\check.ps1"]), PAYLOAD, options);
    expect(result).toMatchObject({ decision: "deny", reason: "no" });
    expect(state.holderSpawn.mock.calls[0]![0]).toMatchObject({ label: "hook:user", command: "powershell.exe", cwd: "D:\\work",
      allowWrite: ["D:\\work"], workspaceRoots: ["D:\\work"], ownedReadRoots: [],
      egressOwner: { kind: "worker", role: "hook", pluginId: undefined } });
    expect(state.legacySpawn).not.toHaveBeenCalled();
  });

  it("refuses a legacy .sh hook resolved to MSYS bash on a container shell plan before admission", async () => {
    const options = admitUnder(shellPlan("mxc"));
    const result = await runOneHookScript(userHook(["C:\\hooks\\pre.sh"]), PAYLOAD, options);
    expect(result.reason).toMatch(/bash-incompatible/u);
    expect(state.holderSpawn).not.toHaveBeenCalled();
    expect(state.legacySpawn).not.toHaveBeenCalled();
  });

  it("keeps a container shell plan's hook on its existing route while the extension backend is not selected", async () => {
    state.selected = false;
    const options = admitUnder(shellPlan("mxc"));
    await runOneHookScript(userHook(["C:\\hooks\\pre.sh"]), PAYLOAD, options);
    expect(state.legacySpawn).toHaveBeenCalledTimes(1);
    expect(state.legacySpawn.mock.calls[0]![0]).not.toHaveProperty("userHookShellPlan");
  });
});
