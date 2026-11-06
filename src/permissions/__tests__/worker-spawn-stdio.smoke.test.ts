// A real Node worker speaking worker stdio control v1 over its own stdin/stdout: no socket, no port. The unconfined cases run everywhere; the macOS case drives the same worker under real ASRT and proves its egress, write jail and state directory.
import { describe, it, expect, afterEach, beforeEach, vi } from "vitest";
import { writeFileSync, mkdtempSync, statSync, existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import {
  isAsrtSandboxActive,
  initializeAsrtSandbox,
  resetAsrtSandbox,
} from "../asrt-sandbox.js";
import { spawnWorker, WORKER_STATE_DIR_ENV, type StdioControlWorker } from "../worker-spawn.js";
import { workerOutputFlowOf } from "../worker-flow.js";
import {
  __resetSandboxRequestedAtBootForTest,
  __resetWrappedPluginWorkersForTest,
  setPluginWorkerConfinementRequestedAtBoot,
} from "../sandbox-capability.js";
import { WorkerControlError, type PluginWorkerExitInfo } from "../../plugins/public-contract.js";
import { asrtCanInitialize } from "./test-helpers.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";

// The worker, written verbatim to a temp file. Logs go to stderr: in this mode stdout carries frames only.
const WORKER_SOURCE = String.raw`
const fs = require("node:fs");
const { execFile } = require("node:child_process");
const send = (frame) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...frame }) + "\n");
const asked = new Map();
let nextAsk = 0;
function curlCode(url, cb) {
  // curl picks up the proxy ASRT bakes into the wrapped command on mac/linux.
  execFile("curl", ["-sS", "-o", "/dev/null", "-w", "%{http_code}", "--max-time", "8", url],
    { timeout: 12000 }, (err, stdout) => cb(err ? null : (stdout || "").trim()));
}
function handle(frame) {
  if (frame.method === "$/ai.agent-connector.ave/hello") {
    return send({ id: frame.id, result: { protocol: frame.params.protocol, version: "1" } });
  }
  if (frame.method === "$/ai.agent-connector.ave/shutdown") process.exit(0);
  if (frame.method === "$/ai.agent-connector.ave/cancel") return;
  if (frame.method === undefined) {
    // A response to a request this worker sent to its plugin.
    const original = asked.get(frame.id);
    asked.delete(frame.id);
    if (original !== undefined) send({ id: original, result: frame.error ? { pluginError: frame.error.code } : { pluginAnswered: frame.result } });
    return;
  }
  if (!("id" in frame)) {
    if (frame.method === "emit_progress") send({ method: "progress", params: frame.params });
    return;
  }
  const { id, method, params } = frame;
  switch (method) {
    case "echo": return send({ id, result: params });
    case "state_dir": return send({ id, result: { dir: process.env.${WORKER_STATE_DIR_ENV} ?? null } });
    case "write_file":
      try { fs.writeFileSync(params.path, "x"); return send({ id, result: { wrote: true } }); }
      catch (e) { return send({ id, result: { error: String((e && e.code) || e) } }); }
    case "egress":
      return curlCode(params.url, (code) => send({ id, result: { httpCode: code } }));
    case "ask_plugin": {
      const askId = "ask-" + nextAsk++;
      asked.set(askId, id);
      return send({ id: askId, method: "egress_fetch", params: { url: params.url } });
    }
    case "fail": return send({ id, error: { code: -32000, message: "the worker refused" } });
    case "hang": return;
    case "stall_and_ask":
      // Stop reading stdin, then ask the plugin for more than the host may queue toward a worker that does not read.
      process.stdin.pause();
      for (let index = 0; index < 64; index += 1) send({ id: "blob-" + index, method: "fetch_blob" });
      return;
    case "break": return process.stdout.write("this is a log line, not a frame\n");
    default: return send({ id, error: { code: -32601, message: "no method " + method } });
  }
}
let buffered = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffered += chunk;
  let newline;
  while ((newline = buffered.indexOf("\n")) >= 0) {
    const line = buffered.slice(0, newline);
    buffered = buffered.slice(newline + 1);
    if (line.trim()) handle(JSON.parse(line));
  }
});
// stdin EOF is the liveness signal: the host is gone or stopped this incarnation.
process.stdin.on("end", () => process.exit(0));
process.stderr.write("worker ready\n");
`;

// RunAsNode makes `process.execPath` the Electron binary under this repo's test runner; `ELECTRON_RUN_AS_NODE` makes it behave as Node.
const NODE_COMMAND = process.env.AVE_TEST_NODE_EXEC_PATH ?? process.execPath;
const NODE_ENV = { ELECTRON_RUN_AS_NODE: "1" };

let tmpRoot: string | undefined;
const workers: StdioControlWorker[] = [];

function exitOf(worker: StdioControlWorker): Promise<PluginWorkerExitInfo> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("worker did not exit")), 10_000);
    worker.onExit((info) => {
      clearTimeout(timer);
      resolve(info);
    });
  });
}

function writeWorker(): string {
  const temporaryBase = process.platform === "darwin" ? "/private/tmp" : process.platform === "win32" ? tmpdir() : "/tmp";
  tmpRoot = mkdtempSync(join(temporaryBase, "ave-stdio-"));
  vi.stubEnv("AVE_HOME", tmpRoot);
  const workerFile = join(tmpRoot, "worker.cjs");
  writeFileSync(workerFile, WORKER_SOURCE, "utf8");
  return workerFile;
}

async function start(workerFile: string, workerId = "stdio-smoke", extra: { allowWritePaths?: string[] } = {}): Promise<StdioControlWorker> {
  const worker = await spawnWorker({
    pluginId: "stdio-smoke-plugin",
    workerId,
    command: NODE_COMMAND,
    args: [workerFile],
    env: NODE_ENV,
    control: "stdio-control-v1",
    stateDirectory: true,
    allowReadPaths: [NODE_COMMAND, workerFile],
    ...extra,
  });
  workers.push(worker);
  return worker;
}

afterEach(async () => {
  try {
    __resetSandboxRequestedAtBootForTest();
    for (const worker of workers.splice(0)) worker.stop();
    if (isAsrtSandboxActive()) await resetAsrtSandbox();
    __resetWrappedPluginWorkersForTest();
  } finally {
    vi.unstubAllEnvs();
    if (tmpRoot) await cleanupTmpDir(tmpRoot);
    tmpRoot = undefined;
  }
});

describe("worker stdio control v1 with a real worker (unconfined)", () => {
  it("answers the hello, then carries requests, notifications and a worker-to-plugin request both ways", async () => {
    const worker = await start(writeWorker());
    expect(worker.control).toBe("stdio-control-v1");

    await expect(worker.request("echo", { text: "hello", n: [1, 2] })).resolves.toEqual({ text: "hello", n: [1, 2] });
    await expect(worker.request("fail")).rejects.toMatchObject({
      code: "worker-request-failed",
      remote: { code: -32000, message: "the worker refused" },
    });

    // The host names the host-made state directory to the worker.
    const { dir } = await worker.request("state_dir") as { dir: string | null };
    expect(dir).toBe(join(tmpRoot!, "plugins", "stdio-smoke-plugin", "workers", "stdio-smoke"));
    if (process.platform !== "win32") expect(statSync(dir!).mode & 0o777).toBe(0o700);

    const progress = new Promise<unknown>((resolve) => worker.onNotification((method, params) => method === "progress" && resolve(params)));
    await worker.notify("emit_progress", { done: 3 });
    await expect(progress).resolves.toEqual({ done: 3 });

    // Egress goes worker → plugin over the same channel; the worker opens no connection of its own.
    worker.onRequest(async (method, params) => ({ method, fetched: (params as { url: string }).url }));
    await expect(worker.request("ask_plugin", { url: "https://example.com/model" })).resolves.toEqual({
      pluginAnswered: { method: "egress_fetch", fetched: "https://example.com/model" },
    });
  }, 30_000);

  it("stops on stdout that is not a frame, reporting a control violation and settling what was pending", async () => {
    const worker = await start(writeWorker());
    const exited = exitOf(worker);
    const pending = worker.request("hang");
    await expect(worker.request("break")).rejects.toBeInstanceOf(WorkerControlError);
    await expect(pending).rejects.toMatchObject({ code: "worker-incarnation-ended" });
    await expect(exited).resolves.toMatchObject({ reason: "control-violation" });
  }, 30_000);

  it("ends the incarnation on stop without replay, and a new incarnation of the same worker starts clean", async () => {
    const workerFile = writeWorker();
    const first = await start(workerFile);
    const exited = exitOf(first);
    const pending = first.request("hang");
    first.stop();
    await expect(pending).rejects.toMatchObject({ code: "worker-incarnation-ended" });
    await expect(first.request("echo", {})).rejects.toMatchObject({ code: "worker-incarnation-ended" });
    const info = await exited;
    expect(info.reason).toBe("stopped");

    const second = await start(workerFile);
    await expect(second.request("echo", { incarnation: 2 })).resolves.toEqual({ incarnation: 2 });
  }, 30_000);

  it("ends as a control violation when the worker stops reading while it is owed more than the queue bound", async () => {
    const worker = await start(writeWorker());
    const exited = exitOf(worker);
    const blob = "x".repeat(8 * 1024 * 1024);
    worker.onRequest(async () => ({ blob }));
    const pending = worker.request("stall_and_ask").catch((error: unknown) => error);
    await expect(exited).resolves.toMatchObject({ reason: "control-violation" });
    await expect(pending).resolves.toMatchObject({ code: "worker-incarnation-ended" });
  }, 30_000);

  it("stops reading the worker's stdout while the host flow is paused, and ends it as output-overflow", async () => {
    const worker = await start(writeWorker());
    const flow = workerOutputFlowOf(worker);
    expect(flow).toBeDefined();
    flow!.pause();
    let answered = false;
    const echoed = worker.request("echo", { n: 1 }).then((value) => {
      answered = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(answered).toBe(false);
    flow!.resume();
    await expect(echoed).resolves.toEqual({ n: 1 });
    const exited = exitOf(worker);
    flow!.end("output-overflow");
    await expect(exited).resolves.toMatchObject({ reason: "output-overflow" });
  }, 30_000);

  it("stops reading an output-only worker's stdout while paused, and delivers what waited on resume", async () => {
    const workerFile = writeWorker();
    writeFileSync(workerFile, "let n = 0; setInterval(() => process.stdout.write(`tick ${n++}\\n`), 20);\n", "utf8");
    const worker = await spawnWorker({
      pluginId: "stdio-smoke-plugin",
      workerId: "ticker",
      command: NODE_COMMAND,
      args: [workerFile],
      env: NODE_ENV,
      control: "output-only-v1",
      allowReadPaths: [NODE_COMMAND, workerFile],
    });
    workers.push(worker as unknown as StdioControlWorker);
    let received = "";
    worker.onStdout((chunk) => {
      received += chunk;
    });
    await vi.waitFor(() => expect(received).toContain("tick 1"), { timeout: 10_000 });
    const flow = workerOutputFlowOf(worker)!;
    flow.pause();
    await new Promise((resolve) => setTimeout(resolve, 50));
    const atPause = received.length;
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(received.length).toBe(atPause);
    flow.resume();
    await vi.waitFor(() => expect(received.length).toBeGreaterThan(atPause), { timeout: 10_000 });
  }, 30_000);

  it("rejects a worker whose first stdout line is not the hello answer as worker-control-failed once it is gone", async () => {
    const workerFile = writeWorker();
    writeFileSync(workerFile, "process.stdout.write('starting\\n'); setInterval(() => {}, 1000);\n", "utf8");
    await expect(start(workerFile)).rejects.toMatchObject({ code: "worker-control-failed" });
  }, 30_000);
});

// The Seatbelt write jail is the macOS worker path; other platforms confine workers differently and are covered elsewhere.
describe.runIf(process.platform === "darwin")("worker stdio control v1 under real ASRT (macOS)", () => {
  beforeEach(() => setPluginWorkerConfinementRequestedAtBoot(true));

  it("drives the wrapped worker over stdio; egress allow/deny enforced; state dir writable; outside the jail denied", async (test) => {
    if (!(await asrtCanInitialize())) {
      // A confinement job asks for real sandbox cases; there a missing sandbox is a failure, not a skip.
      if (process.env.AVE_REQUIRE_SANDBOX_CASES === "1") throw new Error("ASRT cannot initialize on this machine");
      return test.skip("ASRT cannot initialize (sandbox dependencies missing)");
    }
    const workerFile = writeWorker();
    // GENUINELY outside the write jail: a path in HOME is covered by no grant.
    const outsideJail = join(homedir(), `.stdio-smoke-denied-${process.pid}-${Date.now()}.txt`);
    await initializeAsrtSandbox({ allowedDomains: ["example.com"], strictAllowlist: true }, undefined);

    const worker = await start(workerFile, "stdio-smoke", { allowWritePaths: [tmpRoot!] });
    worker.onStderr((chunk) => console.log(`[stdio-smoke][worker-stderr] ${chunk.trim()}`));
    await expect(worker.request("echo", { msg: "hello" })).resolves.toEqual({ msg: "hello" });

    const { dir } = await worker.request("state_dir") as { dir: string };
    const inState = join(dir, "probe.txt");
    await expect(worker.request("write_file", { path: inState })).resolves.toEqual({ wrote: true });
    expect(readFileSync(inState, "utf8")).toBe("x");

    const allow = await worker.request("egress", { url: "https://example.com" }) as { httpCode: string | null };
    const deny = await worker.request("egress", { url: "https://example.org" }) as { httpCode: string | null };
    if (allow.httpCode !== null && /^[23]\d\d$/.test(allow.httpCode)) {
      // Online and the allow side proven: the out-of-union host must not answer 2xx/3xx.
      expect(/^[23]\d\d$/.test(deny.httpCode ?? "")).toBe(false);
    } else {
      console.log("[stdio-smoke] egress allow side not reachable (offline) — egress contrast skipped");
    }

    const outside = await worker.request("write_file", { path: outsideJail }) as { wrote?: boolean; error?: string };
    expect(outside.wrote).not.toBe(true);
    expect(existsSync(outsideJail)).toBe(false);
  }, 90_000);
});
