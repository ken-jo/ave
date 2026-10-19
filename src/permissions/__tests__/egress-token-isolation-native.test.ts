/**
 * Design risk R1: can one confined process read another's egress token?
 *
 * The token is the attribution key the ask callback trusts to decide whose
 * grants apply (`egress-ask.ts`). ASRT puts it in the proxy username
 * (`srt.<base64(token)>`) of the proxy URLs it sets in the wrapped process's
 * environment, so the question is whether a second wrapped process can read
 * the first one's environment or command line while both are alive.
 *
 * The probe runs inside the sandbox and prints counts only, never a key:
 *   - macOS: `sysctl(KERN_PROCARGS2)` for every pid (what `ps -E` uses; `ps`
 *     itself is refused by the profile, so a direct syscall is the stronger
 *     attempt), via the system Python's ctypes;
 *   - Linux: `/proc/<pid>/environ` and `/proc/<pid>/cmdline` for every pid.
 * Its own key, read the same way, is the control that the method works.
 *
 * The answer decides the grant scopes (design R1): if a worker could read a
 * concurrent shell's token, a grant could not be trusted beyond the one
 * conversation, and the workspace and "always" scopes would be unsound.
 */
import { afterEach, describe, expect, it, type TestContext } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  cleanupAsrtSandboxAfterCommand,
  initializeAsrtSandbox,
  isAsrtSandboxActive,
  resetAsrtSandbox,
  wrapToolCommand,
  wrapWorkerCommand,
} from "../asrt-sandbox.js";
import { openEgressInvocation, type EgressInvocationOwner } from "../egress-invocations.js";
import { sandboxCasesRequired, sandboxCasesRun } from "../../plugins/isolation/__tests__/sandbox-cases.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { shellQuote } from "../../lib/shell-resolver.js";

afterEach(async () => {
  if (isAsrtSandboxActive()) await resetAsrtSandbox();
});

const MAC_PYTHON = "/usr/bin/python3";

/** Reads every process's arguments and environment; prints counts, never a key. */
const MAC_PROBE = `
import ctypes, ctypes.util, os, re
libc = ctypes.CDLL(ctypes.util.find_library("c"), use_errno=True)
def procargs(pid):
    size = ctypes.c_size_t(1 << 20)
    buf = ctypes.create_string_buffer(size.value)
    mib = (ctypes.c_int * 3)(1, 49, pid)  # CTL_KERN, KERN_PROCARGS2
    if libc.sysctl(mib, 3, buf, ctypes.byref(size), None, 0) != 0:
        return None
    return buf.raw[: size.value]
keys = lambda b: set(re.findall(rb"srt\\.([A-Za-z0-9%+/=]+)", b or b""))
own = os.getpid()
own_keys = keys(procargs(own))
readable = foreign = 0
for pid in range(1, 99999):
    if pid == own:
        continue
    b = procargs(pid)
    if b is None:
        continue
    readable += 1
    if keys(b) - own_keys:
        foreign += 1
print(f"own_keys={len(own_keys)} readable_other={readable} foreign_key_procs={foreign}")
`;

/**
 * The Linux probe, in POSIX sh: the same counts from /proc. The proxy
 * variables are exported by the wrapper's shell prefix, so the probe shell's
 * own exec-time environ does not hold them; a child does, so the control
 * reads a child's environ the same way it reads everyone else's.
 */
const LINUX_PROBE = [
  "sleep 5 & kid=$!",
  "own=$(tr '\\0' '\\n' < /proc/$kid/environ | grep -o 'srt\\.[A-Za-z0-9%+/=]*' | sort -u)",
  "own_keys=$(printf '%s\\n' \"$own\" | grep -c 'srt\\.')",
  "readable=0; foreign=0",
  "for d in /proc/[0-9]*; do",
  "  [ \"$d\" = /proc/$$ ] && continue",
  "  keys=$(cat \"$d/environ\" \"$d/cmdline\" 2>/dev/null | tr '\\0' '\\n' | grep -o 'srt\\.[A-Za-z0-9%+/=]*' | sort -u) || true",
  "  [ -r \"$d/environ\" ] && readable=$((readable+1))",
  "  for k in $keys; do printf '%s\\n' \"$own\" | grep -qxF \"$k\" || { foreign=$((foreign+1)); break; }; done",
  "done",
  "kill $kid 2>/dev/null",
  "echo \"own_keys=$own_keys readable_other=$readable foreign_key_procs=$foreign\"",
].join("\n");

async function requireNativeCase(context: TestContext): Promise<void> {
  if (!(await sandboxCasesRun())) context.skip("ASRT cannot initialize (sandbox dependencies missing)");
  if (process.platform === "darwin" && !existsSync(MAC_PYTHON)) {
    if (sandboxCasesRequired()) throw new Error(`AVE_REQUIRE_SANDBOX_CASES=1 but ${MAC_PYTHON} is missing`);
    context.skip(`${MAC_PYTHON} is missing`);
  }
}

function run(argv: string[], env: NodeJS.ProcessEnv, cwd: string): { done: Promise<string>; kill: () => void; pid: number | undefined } {
  const [cmd, ...args] = argv;
  const child = spawn(cmd!, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
  const done = new Promise<string>((resolve) => child.once("close", () => resolve(out)));
  return { done, kill: () => child.kill("SIGKILL"), pid: child.pid };
}

describe.runIf(process.platform === "darwin" || process.platform === "linux")("egress token isolation (R1, native)", () => {
  interface ProbeSide { owner: EgressInvocationOwner; wrap: typeof wrapToolCommand }
  const SHELL: ProbeSide = { owner: { kind: "shell", toolName: "bash", toolUseId: "toolu_r1_shell" }, wrap: wrapToolCommand };
  const WORKER: ProbeSide = { owner: { kind: "worker", role: "worker", pluginId: "r1_probe", instanceId: "probe" }, wrap: wrapWorkerCommand };
  async function probeCase(victimSide: ProbeSide, proberSide: ProbeSide, context: TestContext): Promise<void> {
    await requireNativeCase(context);
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "egress-token-r1-")));
    const victim = openEgressInvocation(victimSide.owner);
    const prober = openEgressInvocation(proberSide.owner);
    let sleeper: ReturnType<typeof run> | undefined;
    try {
      await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
      const filesystem = { allowWrite: [dir], allowRead: [dir] };
      const victimWrap = await victimSide.wrap("sleep 10; echo victim-done", { commandId: victim.token, filesystem });
      sleeper = run(victimWrap.argv, victimWrap.env, dir);
      let probeCommand: string;
      if (process.platform === "darwin") {
        const script = join(dir, "probe.py");
        writeFileSync(script, MAC_PROBE);
        probeCommand = `sleep 1; ${MAC_PYTHON} ${shellQuote(script)}`;
      } else {
        probeCommand = `sleep 1; ${LINUX_PROBE}`;
      }
      const proberWrap = await proberSide.wrap(probeCommand, { commandId: prober.token, filesystem });
      const output = await run(proberWrap.argv, proberWrap.env, dir).done;
      cleanupAsrtSandboxAfterCommand();
      cleanupAsrtSandboxAfterCommand();
      const match = /own_keys=(\d+) readable_other=(\d+) foreign_key_procs=(\d+)/.exec(output);
      expect(match, output.slice(0, 500)).not.toBeNull();
      if (process.env.R1_DEBUG_OUT !== undefined) {
        const host = await new Promise<string>((resolve) => {
          const c = spawn(process.platform === "darwin" ? MAC_PYTHON : "sh", process.platform === "darwin" ? [join(dir, "probe.py")] : ["-c", LINUX_PROBE]);
          let o = ""; c.stdout.on("data", (d: Buffer) => { o += d; }); c.once("close", () => resolve(o));
        });
        // Diagnostic only: the same probe from outside the sandbox, as a
        // baseline for what the OS exposes to the same user at all.
        writeFileSync(`${process.env.R1_DEBUG_OUT}.${proberSide.owner.kind}-prober`, `sandboxed: ${match![0]}\nunconfined: ${host}`);
      }
      // Control: the method finds the prober's own key.
      expect(Number(match![1])).toBeGreaterThan(0);
      if (process.platform === "linux") {
        // bwrap's --unshare-pid + fresh /proc: no other invocation is visible.
        expect(Number(match![3])).toBe(0);
      } else {
        // Known gap (design R1, measured 2026-10-19): XNU serves
        // KERN_PROCARGS2 for any same-uid process without consulting Seatbelt
        // (no process-info, sysctl-read or target filter changes it), so no
        // profile rule hides another invocation's key. This pins the measured
        // state so a fix, or an OS change, flips it visibly.
        expect(Number(match![3])).toBeGreaterThan(0);
      }
    } finally {
      if (sleeper !== undefined) {
        sleeper.kill();
        await sleeper.done;
      }
      victim.release();
      prober.release();
      await cleanupTmpDir(dir);
    }
  }

  it("a worker reading a concurrent shell's egress token (isolated on Linux, readable on macOS)", (context) => probeCase(SHELL, WORKER, context), 120_000);
  it("a shell reading a concurrent worker's egress token (isolated on Linux, readable on macOS)", (context) => probeCase(WORKER, SHELL, context), 120_000);
});
