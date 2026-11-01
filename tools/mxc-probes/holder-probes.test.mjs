// Portable self-test of the row-5 holder probes. The fixtures and the measurement logic run here as ordinary host child
// processes behind a fake container context; only the Windows peer run measures real containment.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { HOLDER_ENV_MARKER, holderLayout, runHolderHookProbe, runHolderMcpProbe } from "./holder-probes.mjs";
import { captureChild, loadBudgets } from "./probe-common.mjs";

const payload = fileURLToPath(new URL("./holder-payload.mjs", import.meta.url));

/** A container stand-in: the request carries the program, and records mirror the supervisor's launch records. */
async function fakeContext(temp) {
  const budgets = await loadBudgets();
  const children = new Map();
  const ctx = {
    temp, budgets, ioBudget: budgets.mxcRequestTransportMs, pollMs: budgets.processGroupPollMs,
    runtime: process.execPath, options: {},
    pause: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    async bounded(promise, ms = budgets.windowsAclHostStartupMs) {
      let timer;
      try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("deadline")), ms); })]); }
      finally { clearTimeout(timer); }
    },
    request: (executable, args) => ({ executable, args }),
    async launch(config) {
      const child = spawn(config.executable, config.args, { cwd: config.workingDirectory,
        env: { PATH: process.env.PATH, ...config.environment }, stdio: ["pipe", "pipe", "pipe"] });
      children.set(child.pid, child);
      const record = { filesystemPolicy: null, stdin: child.stdin, stdout: "", stderr: "", disposed: false, closed: false,
        processHandle: { id: child.pid, dispose: () => child.kill("SIGKILL"), kill: () => child.kill("SIGKILL") } };
      child.stdout.on("data", (chunk) => { record.stdout += chunk; });
      child.stderr.on("data", (chunk) => { record.stderr += chunk; });
      record.completion = new Promise((resolve) => child.once("close", (code, signal) => resolve(signal
        ? { error: "sandbox process was disposed before completion" } : { value: { exitCode: code, timedOut: false } })));
      await new Promise((resolve, reject) => { child.once("spawn", resolve); child.once("error", reject); });
      return record;
    },
    async finish(record) {
      record.stdin.end();
      const result = await ctx.bounded(record.completion);
      if (result.error) throw new Error(result.error);
      record.closed = true; record.disposed = true;
      return { ...result.value, stdout: record.stdout, stderr: record.stderr };
    },
    native: {
      now: () => 0n,
      open: (_access, _inherit, pid) => ({ pid }),
      identity: () => ({ createdAt: 1n, imagePath: process.execPath }),
      wait: (handle) => { try { process.kill(handle.pid, 0); return 258; } catch { return 0; } },
      terminate: (handle) => children.get(handle.pid)?.kill("SIGKILL"),
      close: () => true,
    },
  };
  return ctx;
}

async function withTemp(run) {
  const temp = await realpath(await mkdtemp(path.join(tmpdir(), "ave-holder-probe-test-")));
  try { await run(temp); } finally { await rm(temp, { recursive: true, force: true }); }
}

test("the MCP fixture answers the dual-era handshake, calls and identity over stdio, and exits on EOF", async () => {
  const { mxcRequestTransportMs } = await loadBudgets();
  const child = spawn(process.execPath, [payload, "mcp-server"], { stdio: ["pipe", "pipe", "pipe"], env: { AVE_PROBE_TOKEN: HOLDER_ENV_MARKER } });
  const done = captureChild(child, mxcRequestTransportMs);
  const lines = [
    { id: 1, method: "server/discover" }, { id: 2, method: "initialize", params: {} }, { method: "notifications/initialized" },
    { id: 3, method: "tools/list" }, { id: 4, method: "tools/call", params: { name: "echo", arguments: { probe: "call" } } },
    { id: 5, method: "tools/call", params: { name: "hang" } }, { id: 6, method: "probe/identity", params: { nonce: "n" } },
  ];
  for (const line of lines) child.stdin.write(JSON.stringify({ jsonrpc: "2.0", ...line }) + "\n");
  child.stdin.end();
  const result = await done;
  assert.equal(result.code, 0);
  const replies = new Map(result.stdout.trim().split("\n").map((line) => JSON.parse(line)).map((reply) => [reply.id, reply]));
  assert.equal(replies.get(1).error.code, -32601);
  assert.equal(replies.get(2).result.protocolVersion, "2024-11-05");
  assert.deepEqual(replies.get(3).result.tools.map((tool) => tool.name), ["echo", "hang"]);
  assert.equal(JSON.parse(replies.get(4).result.content[0].text).holderVariables.AVE_PROBE_TOKEN, HOLDER_ENV_MARKER);
  assert.equal(replies.has(5), false);
  assert.deepEqual(replies.get(6).result, { pid: child.pid, nonce: "n" });
});

test("the hook fixture maps each variant to its decision, stderr and status", async () => {
  const { mxcRequestTransportMs } = await loadBudgets();
  const input = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "fs_write" }) + "\n";
  const run = async (variant) => {
    const child = spawn(process.execPath, [payload, "hook", variant], { stdio: ["pipe", "pipe", "pipe"], env: { AVE_HOOK_TYPE: "pre" } });
    const done = captureChild(child, mxcRequestTransportMs);
    child.stdin.end(input);
    return done;
  };
  const allow = await run("allow");
  assert.equal(allow.code, 0);
  assert.deepEqual(JSON.parse(allow.stdout).observed.tool, "fs_write");
  const blocked = await run("exit2");
  assert.equal(blocked.code, 2);
  assert.equal(blocked.stderr, "holder-probe-blocked");
  assert.equal((await run("exit5")).code, 5);
});

test("each holder layout is a fresh opaque staging tree inside the run's own temp", async () => withTemp(async (temp) => {
  const first = await holderLayout(temp, { AVE_PROBE_TOKEN: "x" });
  const second = await holderLayout(temp, { AVE_PROBE_TOKEN: "x" });
  assert.match(path.relative(temp, first.home), /^mxc-staging[\\/][0-9a-f]{32}[\\/]home$/u);
  assert.notEqual(first.home, second.home);
  assert.equal(first.environment.HOME, first.home);
  assert.equal(first.environment.TEMP, first.temp);
  assert.equal(first.environment.AVE_PROBE_TOKEN, "x");
  assert.equal(first.environment.PWD, first.data);
}));

test("the MCP measurement accepts initialize, call, cancel-by-disposal and a fresh reconnect", async () => withTemp(async (temp) => {
  const result = await runHolderMcpProbe(await fakeContext(temp));
  assert.deepEqual(result.initialize, { discoverFallback: true, initialized: true, toolNames: ["echo", "hang"] });
  assert.equal(result.call.holderVariable, true);
  assert.equal(result.call.homeStaged, true);
  assert.equal(result.cancel.pendingUnanswered, true);
  assert.equal(result.cancel.processDead, true);
  assert.equal(result.reconnect.freshStaging, true);
  assert.equal(result.reconnect.exitCode, 0);
  assert.equal(result.accepted, true);
}));

test("the hook measurement reports status and JSON per case, and is not accepted without its shell controls", async () => withTemp(async (temp) => {
  const result = await runHolderHookProbe(await fakeContext(temp));
  assert.deepEqual(result.cases.map((entry) => [entry.variant, entry.exitCode, entry.statusMatches]),
    [["allow", 0, true], ["exit2", 2, true], ["exit5", 5, true]]);
  assert.equal(result.cases[0].jsonRoundTrip, true);
  assert.equal(result.cases[0].holderVariables, true);
  assert.equal(result.cases[1].stderrCarried, true);
  assert.equal(result.gitBashControl.unavailable, "Supply --git-bash and --git-root");
  // Missing PowerShell or Git Bash evidence can never pass as an accepted measurement.
  assert.equal(result.accepted, false);
}));

test("the holder probes terminate only pinned handles and delete nothing", async () => {
  const source = await readFile(new URL("./holder-probes.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\b(?:rm|rmdir|unlink|rmSync|unlinkSync)\s*\(/u);
  for (const [call] of source.matchAll(/native\.terminate\([^)]*\)/gu)) assert.equal(call, "native.terminate(handle, 2)");
  assert.match(source, /pinRuntimeProcesses\(ctx\.native/u);
});
