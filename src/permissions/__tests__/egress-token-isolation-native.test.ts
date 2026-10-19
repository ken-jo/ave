/**
 * Design risk R1: can one confined invocation act as another on the network?
 *
 * The egress ask callback decides by who opened a connection
 * (`egress-ask.ts`), so that identity must not be borrowable. Two layers are
 * measured here, natively, in both directions (a worker against a concurrent
 * shell and a shell against a concurrent worker):
 *
 * 1. Impersonation (the boundary). Each invocation has its own proxy listener
 *    and its sandbox profile reaches no other (`openInvocationListener`, the
 *    carried ASRT patch). So even a process that holds another invocation's
 *    key cannot be attributed to it: through its own listener the key does not
 *    match and is refused, and the other invocation's listener is unreachable.
 *    Before the patch the key alone (the proxy username) was the identity.
 * 2. Reading the key (defense in depth). The key is in the proxy username of
 *    the proxy URLs in each wrapped process's environment. On Linux, bwrap's
 *    pid namespace hides every other invocation. On macOS a same-uid process
 *    can read another's environment through `sysctl(KERN_PROCARGS2)`, which
 *    Seatbelt does not gate by itself (sandbox-runtime#160); the patch's
 *    `(deny process-info* (target others))` plus `kern.procargs` sysctl deny
 *    refuse it for processes in another session, and every wrap is spawned in
 *    a session of its own (`detached`). The probe prints counts only, never a
 *    key, and runs once unconfined as the control that the method works.
 */
import { afterEach, describe, expect, it, type TestContext } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxManager, type SandboxAskContext } from "@anthropic-ai/sandbox-runtime";
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
import { TEST_SHELL_EGRESS_CONTEXT } from "../../__tests__/support/egress-fixture.js";
import { shellQuote } from "../../lib/shell-resolver.js";

afterEach(async () => {
  if (isAsrtSandboxActive()) await resetAsrtSandbox();
});

const MAC_PYTHON = "/usr/bin/python3";

/**
 * Counts the proxy keys in its own environment and in every other process's
 * arguments and environment; prints counts, never a key.
 */
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
own_keys = keys("\\n".join(os.environ.values()).encode())
own = os.getpid()
foreign = 0
for pid in range(1, 99999):
    if pid == own:
        continue
    if keys(procargs(pid)) - own_keys:
        foreign += 1
print(f"own_keys={len(own_keys)} foreign_key_procs={foreign}")
`;

/** The Linux probe, in POSIX sh: the same counts from the environment and /proc. */
const LINUX_PROBE = [
  "own=$(env | grep -o 'srt\\.[A-Za-z0-9%+/=]*' | sort -u)",
  "own_keys=$(printf '%s\\n' \"$own\" | grep -c 'srt\\.')",
  "foreign=0",
  "for d in /proc/[0-9]*; do",
  "  [ \"$d\" = /proc/$$ ] && continue",
  "  keys=$(cat \"$d/environ\" \"$d/cmdline\" 2>/dev/null | tr '\\0' '\\n' | grep -o 'srt\\.[A-Za-z0-9%+/=]*' | sort -u) || true",
  "  for k in $keys; do printf '%s\\n' \"$own\" | grep -qxF \"$k\" || { foreign=$((foreign+1)); break; }; done",
  "done",
  "echo \"own_keys=$own_keys foreign_key_procs=$foreign\"",
].join("\n");

async function requireNativeCase(context: TestContext): Promise<void> {
  if (!(await sandboxCasesRun())) context.skip("ASRT cannot initialize (sandbox dependencies missing)");
  if (process.platform === "darwin" && !existsSync(MAC_PYTHON)) {
    if (sandboxCasesRequired()) throw new Error(`AVE_REQUIRE_SANDBOX_CASES=1 but ${MAC_PYTHON} is missing`);
    context.skip(`${MAC_PYTHON} is missing`);
  }
}

/** Spawn as production spawns a wrap: in a process session of its own. */
function run(argv: readonly string[], env: NodeJS.ProcessEnv, cwd: string): { done: Promise<string>; kill: () => void } {
  const [cmd, ...args] = argv;
  const child = spawn(cmd!, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true });
  let out = "";
  child.stdout.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
  child.stderr.on("data", (chunk: Buffer) => { out += chunk.toString("utf8"); });
  const done = new Promise<string>((resolve) => child.once("close", () => resolve(out)));
  const kill = (): void => {
    if (child.pid === undefined) return;
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch {
      // already gone
    }
  };
  return { done, kill };
}

/**
 * The attributed proxy URL a wrap carries: in its environment, or (macOS) as
 * an assignment in the wrapped command line. Used inside this process only.
 */
function proxyUrlOf(wrap: { argv: readonly string[]; env: NodeJS.ProcessEnv }): URL {
  const haystack = [wrap.env.HTTP_PROXY ?? "", ...wrap.argv].join("\n");
  const spelled = /(http:\/\/srt\.[^'"\s:@]+:[^'"\s@]+@[^'"\s/]+)/u.exec(haystack)?.[1];
  if (spelled === undefined) throw new Error("wrap carries no attributed proxy URL");
  return new URL(spelled);
}

type ListenerTarget = { readonly port: number } | { readonly path: string };

function listenerTarget(endpoint: { port?: number; socketPath?: string }): ListenerTarget {
  if (endpoint.port !== undefined) return { port: endpoint.port };
  if (endpoint.socketPath !== undefined) return { path: endpoint.socketPath };
  throw new Error("listener has neither a port nor a socket path");
}

/**
 * A CONNECT from this (unconfined) process to a proxy listener, presenting
 * `username` with the session credential from `proxy`. Answers the status line.
 */
async function connectThrough(target: ListenerTarget, proxy: URL, username: string): Promise<string> {
  const authorization = Buffer.from(`${username}:${decodeURIComponent(proxy.password)}`).toString("base64");
  return new Promise((resolve, reject) => {
    const onConnect = (): void => {
      socket.write(
        "CONNECT r1.example.invalid:443 HTTP/1.1\r\nHost: r1.example.invalid:443\r\n"
          + `Proxy-Authorization: Basic ${authorization}\r\n\r\n`,
      );
    };
    const socket = "port" in target ? connect(target.port, "127.0.0.1", onConnect) : connect(target.path, onConnect);
    let head = "";
    socket.setTimeout(10_000, () => socket.destroy(new Error("proxy did not answer")));
    socket.on("data", (chunk: Buffer) => {
      head += chunk.toString("latin1");
      if (head.includes("\r\n")) socket.end();
    });
    socket.on("close", () => resolve(head.split("\r\n")[0] ?? ""));
    socket.on("error", reject);
  });
}

interface ProbeSide { owner: EgressInvocationOwner; wrap: typeof wrapToolCommand }
const SHELL: ProbeSide = {
  owner: { kind: "shell", toolName: "bash", toolUseId: "toolu_r1_shell", context: TEST_SHELL_EGRESS_CONTEXT },
  wrap: wrapToolCommand,
};
const WORKER: ProbeSide = { owner: { kind: "worker", role: "worker", pluginId: "r1_probe", instanceId: "probe" }, wrap: wrapWorkerCommand };

interface Pair {
  readonly dir: string;
  readonly asked: Array<{ host: string; context: SandboxAskContext | undefined }>;
  readonly victim: { readonly token: string; readonly wrap: { argv: string[]; env: NodeJS.ProcessEnv } };
  readonly prober: {
    readonly token: string;
    wrap(command: string): Promise<{ argv: string[]; env: NodeJS.ProcessEnv }>;
  };
}

async function withPair(
  victimSide: ProbeSide,
  proberSide: ProbeSide,
  context: TestContext,
  body: (pair: Pair) => Promise<void>,
): Promise<void> {
  await requireNativeCase(context);
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "egress-token-r1-")));
  const victim = openEgressInvocation(victimSide.owner);
  const prober = openEgressInvocation(proberSide.owner);
  const asked: Pair["asked"] = [];
  let sleeper: ReturnType<typeof run> | undefined;
  try {
    // Boot's network shape: non-strict, nothing pre-allowed, every
    // connection decided by the callback (here: recorded and refused).
    await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: false }, async ({ host }, askContext) => {
      asked.push({ host, context: askContext });
      return { allow: false, reason: "r1 probe" };
    });
    const filesystem = { allowWrite: [dir], allowRead: [dir] };
    const victimWrap = await victimSide.wrap("sleep 10; echo victim-done", { commandId: victim.token, filesystem });
    sleeper = run(victimWrap.argv, victimWrap.env, dir);
    await body({
      dir,
      asked,
      victim: { token: victim.token, wrap: victimWrap },
      prober: {
        token: prober.token,
        wrap: (command) => proberSide.wrap(command, { commandId: prober.token, filesystem }),
      },
    });
    cleanupAsrtSandboxAfterCommand();
    cleanupAsrtSandboxAfterCommand();
  } finally {
    sleeper?.kill();
    await sleeper?.done;
    victim.release();
    prober.release();
    await cleanupTmpDir(dir);
  }
}

async function readCase(victimSide: ProbeSide, proberSide: ProbeSide, context: TestContext): Promise<void> {
  await withPair(victimSide, proberSide, context, async ({ dir, prober }) => {
    let probeCommand: string;
    let unconfined: string[];
    if (process.platform === "darwin") {
      const script = join(dir, "probe.py");
      writeFileSync(script, MAC_PROBE);
      probeCommand = `sleep 1; ${MAC_PYTHON} ${shellQuote(script)}`;
      unconfined = [MAC_PYTHON, script];
    } else {
      probeCommand = `sleep 1; ${LINUX_PROBE}`;
      unconfined = ["sh", "-c", LINUX_PROBE];
    }
    const proberWrap = await prober.wrap(probeCommand);
    const output = await run(proberWrap.argv, proberWrap.env, dir).done;
    const sandboxed = /own_keys=(\d+) foreign_key_procs=(\d+)/u.exec(output);
    expect(sandboxed, output.slice(0, 500)).not.toBeNull();
    // Control: unconfined, the same probe finds the concurrent invocation's
    // key, so a zero below is the sandbox's doing, not a broken method.
    const control = await run(unconfined, process.env, dir).done;
    const baseline = /foreign_key_procs=(\d+)/u.exec(control);
    expect(baseline, control.slice(0, 500)).not.toBeNull();
    expect(Number(baseline![1])).toBeGreaterThan(0);
    // The prober holds a key of its own …
    expect(Number(sandboxed![1])).toBeGreaterThan(0);
    // … and reads no one else's.
    expect(Number(sandboxed![2])).toBe(0);
  });
}

async function impersonationCase(victimSide: ProbeSide, proberSide: ProbeSide, context: TestContext): Promise<void> {
  await withPair(victimSide, proberSide, context, async ({ dir, asked, victim, prober }) => {
    const victimProxy = proxyUrlOf(victim.wrap);
    const proberWrap = await prober.wrap("true");
    const proberProxy = proxyUrlOf(proberWrap);
    // The wrap already opened each listener; asking again returns it.
    const victimTarget = listenerTarget(await SandboxManager.openInvocationListener(victim.token));
    const proberTarget = listenerTarget(await SandboxManager.openInvocationListener(prober.token));
    if ("port" in victimTarget && "port" in proberTarget) {
      // macOS: each wrap's proxy URL names its own listener's port.
      expect(Number(victimProxy.port)).toBe(victimTarget.port);
      expect(Number(proberProxy.port)).toBe(proberTarget.port);
      expect(victimTarget.port).not.toBe(proberTarget.port);
    }
    const stolenKey = decodeURIComponent(victimProxy.username);
    const ownKey = decodeURIComponent(proberProxy.username);

    // Holding the victim's key and presenting it on the prober's own
    // listener: refused before the callback, as a mismatch.
    expect(await connectThrough(proberTarget, proberProxy, stolenKey)).toMatch(/^HTTP\/1\.1 403/u);
    // The prober's key on the victim's listener: refused the same way.
    expect(await connectThrough(victimTarget, proberProxy, ownKey)).toMatch(/^HTTP\/1\.1 403/u);
    // Only the prober's own key on its own listener reaches the callback,
    // which is told the listener vouches for it.
    expect(await connectThrough(proberTarget, proberProxy, ownKey)).toMatch(/^HTTP\/1\.1 403/u);
    expect(asked).toEqual([{ host: "r1.example.invalid", context: { attributionKey: prober.token, identity: "listener" } }]);

    if (process.platform === "darwin") {
      // From inside the sandbox the victim's listener is not reachable at
      // all: the prober's profile allows loopback to its own port only.
      const probe = await prober.wrap(
        `curl -s -o /dev/null -w '%{http_code}' --max-time 5 --noproxy '*' http://127.0.0.1:${victimProxy.port}/ ; echo " exit=$?"`,
      );
      const reach = await run(probe.argv, probe.env, dir).done;
      expect(reach).toMatch(/000 exit=[1-9]\d*/u);
    } else if ("path" in victimTarget) {
      // Linux: from inside the prober's bwrap, try the victim's socket path
      // with the prober's own credential and with the victim's key. Either
      // the socket cannot be opened at all, or the proxy refuses the
      // mismatch; the callback is never asked on the victim's behalf.
      const script = join(dir, "hop.py");
      writeFileSync(script, LINUX_HOP_PROBE);
      const password = decodeURIComponent(proberProxy.password);
      for (const key of [ownKey, stolenKey]) {
        const probe = await prober.wrap(`python3 ${shellQuote(script)} ${shellQuote(victimTarget.path)} ${shellQuote(key)} ${shellQuote(password)}`);
        const reach = (await run(probe.argv, probe.env, dir).done).trim();
        expect(reach).toMatch(/^(reply HTTP\/1\.1 403|connect-failed \d+)/u);
        console.info(`[R1] linux hop onto another invocation's socket: ${reach.split(" ").slice(0, 2).join(" ")}`);
      }
      expect(asked).toHaveLength(1);
    }
  });
}

/** Opens a Unix socket path and sends one CONNECT; prints only the status line or the errno. */
const LINUX_HOP_PROBE = [
  "import base64, socket, sys",
  "path, user, password = sys.argv[1:4]",
  "try:",
  "    s = socket.socket(socket.AF_UNIX)",
  "    s.settimeout(5)",
  "    s.connect(path)",
  "    auth = base64.b64encode(f'{user}:{password}'.encode()).decode()",
  "    s.sendall(f'CONNECT r1.example.invalid:443 HTTP/1.1\\r\\nHost: r1.example.invalid:443\\r\\nProxy-Authorization: Basic {auth}\\r\\n\\r\\n'.encode())",
  "    print('reply', s.recv(64).split(b'\\r\\n')[0].decode())",
  "except OSError as error:",
  "    print('connect-failed', error.errno)",
  "",
].join("\n");

describe.runIf(process.platform === "darwin" || process.platform === "linux")("egress identity isolation (R1, native)", () => {
  it("a worker cannot read a concurrent shell's egress key", (context) => readCase(SHELL, WORKER, context), 120_000);
  it("a shell cannot read a concurrent worker's egress key", (context) => readCase(WORKER, SHELL, context), 120_000);
  it("a worker holding a concurrent shell's key is not attributed as that shell", (context) => impersonationCase(SHELL, WORKER, context), 120_000);
  it("a shell holding a concurrent worker's key is not attributed as that worker", (context) => impersonationCase(WORKER, SHELL, context), 120_000);
});
