// Row-5 holder measurements: an MCP stdio server and hooks inside UI-enabled containers, over native standard streams.
// Diagnostic only. The request mirrors the production holder layout (admitted cwd, holder variables, a private
// `mxc-staging\<opaque-id>\{home,temp}`), but every grant stays inside this run's own temp directory. Only process
// handles pinned by `pinRuntimeProcesses` are ever terminated, and nothing outside temp is written or deleted.
import { randomUUID } from "node:crypto";
import { copyFile, mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { pinRuntimeProcesses } from "./process-lifecycle.mjs";
import { safeEnvironment } from "./probe-common.mjs";

export const HOLDER_ENV_MARKER = "holder-env-marker";
const STILL_ACTIVE = 258;

/** A holder request: cwd in the admitted data root, HOME/temp in a fresh staging tree, host-owned variables on top. */
export async function holderLayout(temp, holderEnv) {
  const data = path.join(temp, "holder-data");
  const staging = path.join(temp, "mxc-staging", randomUUID().replaceAll("-", ""));
  const home = path.join(staging, "home");
  const holderTemp = path.join(staging, "temp");
  for (const directory of [data, home, holderTemp]) await mkdir(directory, { recursive: true });
  const environment = { ...safeEnvironment(home), TEMP: holderTemp, TMP: holderTemp, TMPDIR: holderTemp, PWD: data, ...holderEnv };
  return { data, home, temp: holderTemp, environment };
}

function holderConfig(ctx, executable, args, layout, longLived, extraReads = []) {
  const config = ctx.request(executable, args, false, extraReads, longLived);
  config.workingDirectory = layout.data;
  config.environment = layout.environment;
  return config;
}

/** Reply lines are read from the record's accumulated stdout; requests never reuse an id. */
function rpcChannel(ctx, record) {
  let nextId = 1;
  const replies = () => record.stdout.split(/\r?\n/).filter((line) => line.startsWith("{")).map((line) => JSON.parse(line));
  return {
    notify(method, params = {}) { record.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n"); },
    send(method, params = {}) {
      const id = nextId++;
      record.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
      return id;
    },
    async reply(id, budget = ctx.ioBudget) {
      const until = Date.now() + budget;
      while (Date.now() < until) {
        const found = replies().find((message) => message.id === id);
        if (found) return found;
        const ended = await Promise.race([record.completion.then(() => true), ctx.pause(ctx.pollMs).then(() => false)]);
        if (ended) throw new Error(`Server ended before reply ${id}: ${record.stderr}`);
      }
      return undefined;
    },
    async call(method, params) { return this.reply(this.send(method, params)); },
  };
}

async function handshake(rpc) {
  const discover = await rpc.call("server/discover");
  const initialize = await rpc.call("initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "ave-probe", version: "1" } });
  rpc.notify("notifications/initialized");
  const tools = await rpc.call("tools/list");
  return {
    discoverFallback: discover?.error?.code === -32601,
    initialized: initialize?.result?.protocolVersion === "2024-11-05",
    toolNames: tools?.result?.tools?.map((tool) => tool.name) ?? null,
  };
}

function echoObservation(reply, layout) {
  const text = reply?.result?.content?.[0]?.text;
  if (typeof text !== "string") return { replied: false };
  const echoed = JSON.parse(text);
  return {
    replied: true,
    cwdAdmitted: path.win32.normalize(echoed.cwd).toLowerCase() === path.win32.normalize(layout.data).toLowerCase(),
    homeStaged: echoed.home === layout.home,
    tempStaged: echoed.temp === layout.temp,
    holderVariable: echoed.holderVariables?.AVE_PROBE_TOKEN === HOLDER_ENV_MARKER,
    argumentsEchoed: echoed.echo?.probe === "call",
  };
}

/** initialize/call over native pipes; cancel by disposing with a request outstanding; reconnect as a new incarnation. */
export async function runHolderMcpProbe(ctx) {
  const payload = path.join(ctx.temp, "holder-payload.mjs");
  await copyFile(new URL("./holder-payload.mjs", import.meta.url), payload);
  const runtimePath = await realpath(ctx.runtime);
  const holderEnv = { AVE_PROBE_TOKEN: HOLDER_ENV_MARKER };

  const firstLayout = await holderLayout(ctx.temp, holderEnv);
  const launchedAfter = ctx.native.now();
  const first = await ctx.launch(holderConfig(ctx, ctx.runtime, [payload, "mcp-server"], firstLayout, true), "script-file");
  const rpc = rpcChannel(ctx, first);
  const initial = await handshake(rpc);
  const call = echoObservation(await rpc.call("tools/call", { name: "echo", arguments: { probe: "call" } }), firstLayout);
  const identity = await rpc.call("probe/identity", { nonce: randomUUID() });
  const pid = identity?.result?.pid;
  if (!Number.isInteger(pid)) throw new Error("Server identity unavailable");
  const handles = await pinRuntimeProcesses(ctx.native, [pid], launchedAfter, runtimePath, async () => {
    const nonce = randomUUID();
    const confirmed = await rpc.call("probe/identity", { nonce });
    if (confirmed?.result?.nonce !== nonce || confirmed.result.pid !== pid) throw new Error("Server liveness challenge failed");
  });
  let cancel;
  try {
    const pendingId = rpc.send("tools/call", { name: "hang", arguments: {} });
    const unanswered = (await rpc.reply(pendingId, ctx.pollMs * 4)) === undefined;
    // Cancellation is disposal of the whole container with input still open; the SDK wait rejection is not death evidence.
    first.processHandle.dispose(); first.disposed = true;
    const until = Date.now() + ctx.budgets.pluginShutdownHandlerMs;
    while (Date.now() < until && handles.some((handle) => ctx.native.wait(handle, 0) === STILL_ACTIVE)) await ctx.pause(ctx.pollMs);
    const processDead = handles.every((handle) => ctx.native.wait(handle, 0) === 0);
    cancel = { pendingUnanswered: unanswered, processDead, waitAfterDispose: await ctx.bounded(first.completion, ctx.ioBudget) };
    first.closed = processDead;
  } finally {
    for (const handle of handles) { if (ctx.native.wait(handle, 0) === STILL_ACTIVE) ctx.native.terminate(handle, 2); }
    first.closed = handles.every((handle) => ctx.native.wait(handle, ctx.ioBudget) === 0);
    for (const handle of handles) ctx.native.close(handle);
  }

  // Reconnect only after the first incarnation is verified dead, with its own staging tree.
  let reconnect = { attempted: false };
  if (cancel.processDead) {
    const secondLayout = await holderLayout(ctx.temp, holderEnv);
    const second = await ctx.launch(holderConfig(ctx, ctx.runtime, [payload, "mcp-server"], secondLayout, true), "script-file");
    const secondRpc = rpcChannel(ctx, second);
    const handshakeAgain = await handshake(secondRpc);
    const callAgain = echoObservation(await secondRpc.call("tools/call", { name: "echo", arguments: { probe: "call" } }), secondLayout);
    const ended = await ctx.finish(second);
    reconnect = { attempted: true, ...handshakeAgain, call: callAgain, freshStaging: secondLayout.home !== firstLayout.home,
      exitCode: ended.exitCode };
  }
  const callOk = (observed) => observed.replied && observed.cwdAdmitted && observed.homeStaged && observed.tempStaged
    && observed.holderVariable && observed.argumentsEchoed;
  const handshakeOk = (observed) => observed.discoverFallback && observed.initialized
    && JSON.stringify(observed.toolNames) === JSON.stringify(["echo", "hang"]);
  const accepted = handshakeOk(initial) && callOk(call) && cancel.pendingUnanswered && cancel.processDead
    && reconnect.attempted && handshakeOk(reconnect) && callOk(reconnect.call) && reconnect.freshStaging && reconnect.exitCode === 0;
  return { probe: "holder-mcp-stdio", filesystemPolicy: first.filesystemPolicy, initialize: initial, call, cancel, reconnect, accepted };
}

const exitHex = (code) => `0x${(code >>> 0).toString(16).padStart(8, "0")}`;

async function oneHook(ctx, executable, args, holderEnv, input, extraReads = []) {
  const layout = await holderLayout(ctx.temp, holderEnv);
  const record = await ctx.launch(holderConfig(ctx, executable, args, layout, false, extraReads),
    executable === ctx.runtime ? "script-file" : "native-command");
  record.stdin.write(input);
  const result = await ctx.finish(record);
  return { layout, exitCode: result.exitCode, exitHex: exitHex(result.exitCode), stdout: result.stdout, stderr: result.stderr };
}

/** Hook JSON in, decision/stdout/status out, admitted cwd and env; PowerShell runs; Git Bash is the D4 negative control. */
export async function runHolderHookProbe(ctx) {
  const payload = path.join(ctx.temp, "holder-payload.mjs");
  await copyFile(new URL("./holder-payload.mjs", import.meta.url), payload);
  const gen = path.join(ctx.temp, "holder-generation");
  const holderEnv = { AVE_HOOK_TYPE: "pre", PLUGIN_ROOT: gen, PLUGIN_DATA: path.join(ctx.temp, "holder-data") };
  const input = JSON.stringify({ hook_event_name: "PreToolUse", tool_name: "fs_write", tool_input: { path: "x" } }) + "\n";
  const cases = [];
  for (const [variant, expected] of [["allow", 0], ["exit2", 2], ["exit5", 5]]) {
    try {
      const run = await oneHook(ctx, ctx.runtime, [payload, "hook", variant], holderEnv, input);
      const decision = variant === "allow" ? JSON.parse(run.stdout.trim().split(/\r?\n/).pop()) : null;
      const observed = decision?.observed;
      cases.push({ variant, exitCode: run.exitCode, statusMatches: run.exitCode === expected,
        stderrCarried: variant === "exit2" ? run.stderr.includes("holder-probe-blocked") : undefined,
        decision: decision ? { action: decision.action, reason: decision.reason } : null,
        jsonRoundTrip: variant === "allow" ? observed?.tool === "fs_write" && observed?.event === "PreToolUse" : undefined,
        cwdAdmitted: observed ? path.win32.normalize(observed.cwd).toLowerCase() === path.win32.normalize(run.layout.data).toLowerCase() : undefined,
        holderVariables: observed ? observed.holderVariables.AVE_HOOK_TYPE === "pre" && observed.holderVariables.PLUGIN_ROOT === gen : undefined });
    } catch (error) { cases.push({ variant, error: error.message }); }
  }
  let powershellControl;
  try {
    const powershell = path.join(process.env.SYSTEMROOT, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const run = await oneHook(ctx, powershell, ["-NoProfile", "-NonInteractive", "-Command",
      "$i=[Console]::In.ReadToEnd(); $p=ConvertFrom-Json $i; Write-Output ('{\"action\":\"allow\",\"reason\":\"' + $p.tool_name + '\"}'); exit 0"], holderEnv, input);
    powershellControl = { exitCode: run.exitCode, decided: run.stdout.includes('"reason":"fs_write"') };
  } catch (error) { powershellControl = { error: error.message }; }
  let gitBashControl;
  if (ctx.options["git-bash"]) {
    try {
      const run = await oneHook(ctx, ctx.options["git-bash"], ["--noprofile", "--norc", "-c", "cat >/dev/null; printf '{\"action\":\"allow\",\"reason\":\"bash\"}\\n'"], holderEnv, input, [ctx.options["git-root"]]);
      // D4 evidence: Git Bash failing to start is the expected, measured incompatibility.
      gitBashControl = { exitHex: run.exitHex, started: run.stdout.includes('"reason":"bash"'), bashIncompatible: run.exitHex === "0xc0000142" };
    } catch (error) { gitBashControl = { error: error.message }; }
  } else {
    gitBashControl = { unavailable: "Supply --git-bash and --git-root" };
  }
  const accepted = cases.length === 3 && cases.every((entry) => !entry.error && entry.statusMatches)
    && cases[0].jsonRoundTrip && cases[0].cwdAdmitted && cases[0].holderVariables && cases[0].decision?.action === "allow"
    && cases[1].stderrCarried && powershellControl.exitCode === 0 && powershellControl.decided
    && gitBashControl.started === false;
  return { probe: "holder-hook-json", cases, powershellControl, gitBashControl, accepted };
}
