import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { captureChild, loadBudgets, parseOptions, PROBE_NAMES, safeEnvironment, spawnWithoutTelemetry, windowsQuote } from "./probe-common.mjs";

test("native spawn receives one argument and cannot opt into telemetry", async () => {
  const calls = [];
  const sdk = { spawn(...args) { calls.push(args); return "handle"; } };
  const request = { command: "probe" };
  assert.equal(await spawnWithoutTelemetry(sdk, request), "handle");
  assert.deepEqual(calls, [[request]]);
  await assert.rejects(spawnWithoutTelemetry(sdk, request, { telemetry: undefined }), /omitted/);
  await assert.rejects(spawnWithoutTelemetry(sdk, { telemetry: undefined }), /omitted/);
  assert.equal(calls.length, 1);
});

test("standalone budgets come from the shared policy", async () => {
  const budgets = await loadBudgets();
  assert.ok(budgets.windowsAclHostStartupMs >= budgets.mxcRequestTransportMs);
  assert.ok(budgets.pluginShutdownHandlerMs > budgets.processGroupPollMs);
});

test("child environment contains no inherited SDK override, auth token or default home", () => {
  const env = safeEnvironment("probe-temp");
  assert.equal(env.USERPROFILE, "probe-temp");
  assert.equal(env.LOCALAPPDATA, "probe-temp");
  assert.equal(env.ELECTRON_RUN_AS_NODE, "1");
  assert.ok(!Object.hasOwn(env, "MXC_FFI_DIR"));
  assert.ok(!Object.hasOwn(env, "OPENAI_API_KEY"));
});

test("command quoting preserves trailing separators and embedded quotes", () => {
  assert.equal(windowsQuote('C:\\probe dir\\'), '"C:\\probe dir\\\\"');
  assert.equal(windowsQuote('a"b'), '"a\\"b"');
  assert.throws(() => windowsQuote("line\nline"), /Invalid/);
});

test("supervisor crash capture retains status instead of parsing it as success", async () => {
  const { mxcRequestTransportMs } = await loadBudgets();
  const result = await captureChild(spawn(process.execPath, ["-e", "process.stderr.write('native-load-failed'); process.exit(7)"], {
    stdio: ["ignore", "pipe", "pipe"],
  }), mxcRequestTransportMs);
  assert.equal(result.code, 7);
  assert.equal(result.stderr, "native-load-failed");
  assert.equal(result.timedOut, false);
});

test("each entry point reports exactly one unavailable JSON verdict off Windows", { skip: process.platform === "win32" }, async () => {
  const { mxcRequestTransportMs } = await loadBudgets();
  for (const name of PROBE_NAMES) {
    const child = spawn(process.execPath, [new URL(`./${name}.mjs`, import.meta.url).pathname], { stdio: ["ignore", "pipe", "pipe"] });
    const result = await captureChild(child, mxcRequestTransportMs);
    assert.equal(result.code, 2);
    assert.equal(result.stdout.trim().split("\n").length, 1);
    assert.equal(JSON.parse(result.stdout).verdict, "unavailable");
    assert.equal(result.stderr, "");
  }
});


test("path options reject implicit paths, duplicates and a shell outside its declared root", () => {
  const root = process.platform === "win32" ? "C:\\probe" : "/probe";
  const runtime = root + "/node.exe";
  assert.throws(() => parseOptions(["--sdk-root", "relative", "--runtime", runtime]), /absolute/);
  assert.throws(() => parseOptions(["--sdk-root", root, "--runtime", runtime, "--runtime", runtime]), /unique/);
  assert.throws(() => parseOptions(["--sdk-root", root, "--runtime", runtime,
    "--git-root", root + "/git", "--git-bash", root + "/git-other/bash.exe"]), /within/);
});

test("a stalled child is bounded and cannot be reported as completed", async () => {
  const { processGroupPollMs } = await loadBudgets();
  const result = await captureChild(spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
    stdio: ["ignore", "pipe", "pipe"],
  }), processGroupPollMs);
  assert.equal(result.timedOut, true);
});
