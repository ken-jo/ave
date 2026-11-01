import { spawn as spawnHost } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { appendFile, copyFile, mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import http from "node:http";
import path from "node:path";
import { release } from "node:os";
import { pathToFileURL, fileURLToPath } from "node:url";
import { captureChild, safeEnvironment, spawnWithoutTelemetry, windowsQuote } from "./probe-common.mjs";

import { assertEnumerationSupport, buildProbeFilesystem, filesystemObservation, recordFilesystemObservation } from "./filesystem-policy.mjs";
import { runEgressPolicyProbe } from "./egress-policy-run.mjs";
import { evaluateAncestorExposure } from "./ancestor-exposure-results.mjs";
import { finishProcess, pinRuntimeProcesses, ProcessIdentityError } from "./process-lifecycle.mjs";

const { name, options, budgets, temp } = JSON.parse(process.env.MXC_PROBE_INPUT);
const resources = [];
const details = [];
let native, sdk, proxy, observation;
const deadline = budgets.windowsAclHostStartupMs;
const ioBudget = budgets.mxcRequestTransportMs;
const pollMs = budgets.processGroupPollMs;
const pins = JSON.parse(await readFile(new URL("./sdk-pins.json", import.meta.url)));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const journal = (event) => appendFile(path.join(temp, "events.jsonl"), JSON.stringify({ at: new Date().toISOString(), ...event }) + "\n");
const quote = (args) => args.map(windowsQuote).join(" ");

async function initialize() {
  const packageFile = path.join(options["sdk-root"], "package.json");
  const pkg = JSON.parse(await readFile(packageFile));
  if (pkg.name !== "@microsoft/mxc-sdk" || pkg.version !== pins.version) throw new Error("Expected staged SDK 1.0.1");
  const bin = path.join(options["sdk-root"], "bin", process.arch);
  const dll = path.join(bin, "mxc_ffi.dll");
  const digest = createHash("sha256").update(await readFile(dll)).digest("hex");
  if (digest !== pins.native[process.arch]) throw new Error("SDK native DLL hash mismatch");
  // The operator-trusted bootstrap addon loads before these process-local restrictions.
  // Production must establish them in a native supervisor bootstrap before any addon loads.
  const require = createRequire(packageFile);
  const koffi = require("koffi");
  const kernel = koffi.load(path.join(process.env.SYSTEMROOT, "System32", "kernel32.dll"));
  const defaults = kernel.func("bool __stdcall SetDefaultDllDirectories(uint32_t)");
  const add = kernel.func("void * __stdcall AddDllDirectory(str16)");
  if (!defaults(0x800 | 0x400) || !add(bin) || !add(path.dirname(process.execPath))) throw new Error("Restricted DLL search setup failed");
  const session = [0];
  if (!kernel.func("bool __stdcall ProcessIdToSessionId(uint32_t, _Out_ uint32_t *)")(process.pid, session)) throw new Error("Cannot identify session");
  if (session[0] === 0) throw new Error("session-0: run from an interactive desktop session");
  const getTimes = kernel.func("bool __stdcall GetProcessTimes(void *, _Out_ uint64_t *, _Out_ uint64_t *, _Out_ uint64_t *, _Out_ uint64_t *)");
  const getImage = kernel.func("bool __stdcall QueryFullProcessImageNameW(void *, uint32_t, void *, _Inout_ uint32_t *)");
  const getTime = kernel.func("void __stdcall GetSystemTimePreciseAsFileTime(_Out_ uint64_t *)");
  const security = koffi.load(path.join(process.env.SYSTEMROOT, "System32", "advapi32.dll"));
  const getFileSecurity = security.func("bool __stdcall GetFileSecurityW(str16, uint32_t, void *, uint32_t, _Out_ uint32_t *)");
  native = {
    descriptor(directory) {
      const bytes = Buffer.alloc(65536), length = [0];
      if (!getFileSecurity(directory, 7, bytes, bytes.length, length) || !length[0] || length[0] > bytes.length) {
        throw new Error("Cannot snapshot directory security descriptor");
      }
      return bytes.subarray(0, length[0]).toString("hex");
    },

    now() { const value = [0n]; getTime(value); return BigInt(value[0]); },
    identity(handle) {
      const created = [0n], exited = [0n], kernelTime = [0n], userTime = [0n];
      const image = Buffer.alloc(32768 * 2), length = [32768];
      if (!getTimes(handle, created, exited, kernelTime, userTime) || !getImage(handle, 0, image, length)) {
        throw new Error("Cannot query fixture process identity");
      }
      return { createdAt: BigInt(created[0]), imagePath: image.toString("utf16le", 0, length[0] * 2) };
    },
    open: kernel.func("void * __stdcall OpenProcess(uint32_t, bool, uint32_t)"),
    wait: kernel.func("uint32_t __stdcall WaitForSingleObject(void *, uint32_t)"),
    terminate: kernel.func("bool __stdcall TerminateProcess(void *, uint32_t)"),
    close: kernel.func("bool __stdcall CloseHandle(void *)"),
  };
  sdk = await import(pathToFileURL(path.join(options["sdk-root"], "dist", "v1", "index.js")));
  proxy = http.createServer((_request, response) => { response.writeHead(403); response.end(); });
  proxy.on("connect", (_request, socket) => socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n"));
  await new Promise((resolve, reject) => { proxy.once("error", reject); proxy.listen(0, "127.0.0.1", resolve); });
  observation = { node: process.versions.node, arch: process.arch, sessionId: session[0], windowsRelease: release(), sdk: pkg.version, dllSha256: digest,
    telemetryOmitted: true, proxyMode: "identity-less-endpoint-scoped", dllBootstrap: "trusted-addon-before-search-restriction",
    filesystemPolicy: null, filesystemPolicies: [] };
  await copyFile(new URL("./child-payload.mjs", import.meta.url), path.join(temp, "child-payload.mjs"));
}

function request(executable, args, uiDisabled, extraReads = [], longLived = false) {
  const policy = buildProbeFilesystem(options.runtime, temp, process.env.SYSTEMROOT, extraReads);
  return {
    command: quote([executable, ...args]),
    containment: { type: "processcontainer", config: { filesystem: { enumeratePaths: policy.enumeratePaths } } },
    workingDirectory: temp, environment: safeEnvironment(temp), inheritDefaultEnvironment: false,
    filesystem: policy.filesystem,
    network: { egress: { default: "deny" }, ingress: { default: "allow", hostLoopback: "allow" },
      runtimeConfig: { networkProxy: `http://127.0.0.1:${proxy.address().port}` } },
    ui: { disable: uiDisabled, clipboard: "none", allowInputInjection: false },
    ...(longLived ? {} : { timeoutMs: deadline }),
  };
}

async function launch(config, entryVariant) {
  const filesystemPolicy = recordFilesystemObservation(observation, config.containment.config.filesystem.enumeratePaths, entryVariant);
  const probed = sdk.probe(config);
  assertEnumerationSupport(config.containment.config.filesystem.enumeratePaths, probed);
  if (probed.tier !== "base-container" || probed.needsDaclAugmentation) throw new Error(`BaseContainer unavailable: ${JSON.stringify(probed)}`);
  // Intentionally one argument: telemetry must stay absent, including undefined opt-in objects.
  const processHandle = await spawnWithoutTelemetry(sdk, config);
  const stdin = processHandle.standardInput;
  const stdout = processHandle.standardOutput;
  const stderr = processHandle.standardError;
  if (!stdin || !stdout || !stderr) { processHandle.dispose(); throw new Error("Native streams unavailable"); }
  const record = { filesystemPolicy, processHandle, stdin, stdout: "", stderr: "", disposed: false, closed: false };
  stdout.on("data", (chunk) => { record.stdout = (record.stdout + chunk).slice(-1024 * 1024); });
  stderr.on("data", (chunk) => { record.stderr = (record.stderr + chunk).slice(-1024 * 1024); });
  stdout.on("error", () => {}); stderr.on("error", () => {}); stdin.on("error", () => {});
  record.completion = processHandle.wait().then((value) => ({ value }), (error) => ({ error: error.message }));
  resources.push(record);
  await journal({ event: "container-spawned", pid: processHandle.id, command: config.command });
  return record;
}

async function bounded(promise, ms = deadline) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Measurement deadline")), ms); })]); }
  finally { clearTimeout(timer); }
}

async function firstJson(record) {
  const until = Date.now() + deadline;
  while (Date.now() < until) {
    const line = record.stdout.split(/\r?\n/).find((text) => text.startsWith("{"));
    if (line) { const ready = JSON.parse(line); await journal({ event: "child-ready", ...ready }); return ready; }
    const terminal = await Promise.race([record.completion.then(() => true), pause(pollMs).then(() => false)]);
    if (terminal) throw new Error(`No child readiness: ${record.stderr}`);
  }
  throw new Error("Child readiness deadline");
}

async function finish(record) {
  return finishProcess(record, bounded);
}

async function one(executable, args, uiDisabled, extraReads = []) {
  let filesystemPolicy;
  try {
    const config = request(executable, args, uiDisabled, extraReads);
    filesystemPolicy = filesystemObservation({ enumeratePaths: config.containment.config.filesystem.enumeratePaths },
      executable === options.runtime ? "script-file" : "native-command");
    const child = await launch(config, filesystemPolicy.entryVariant);
    const result = await finish(child);
    return { uiDisabled, filesystemPolicy, exitHex: `0x${(result.exitCode >>> 0).toString(16).padStart(8, "0")}`, ...result };
  } catch (error) { return { uiDisabled, filesystemPolicy, error: error.message }; }
}
const payloadArgs = (mode) => [path.join(temp, "child-payload.mjs"), mode, String(ioBudget)];

async function lifetime() {
  const runtimePath = await realpath(options.runtime);
  const launchedAfter = native.now();
  const child = await launch(request(options.runtime, payloadArgs("lifetime"), false, [], true), "script-file");
  const ready = await firstJson(child);
  if (!Number.isInteger(ready.pid) || !Number.isInteger(ready.grandchildPid)) throw new Error("Missing child PIDs");
  const handles = await pinRuntimeProcesses(native, [ready.pid, ready.grandchildPid], launchedAfter, runtimePath, async () => {
    const nonce = randomUUID();
    child.stdin.write(JSON.stringify({ nonce }) + "\n");
    const until = Date.now() + ioBudget;
    while (Date.now() < until) {
      const confirmed = child.stdout.split(/\r?\n/).filter((line) => line.startsWith("{"))
        .map((line) => JSON.parse(line)).some((frame) => frame.marker === "identity-confirmed"
          && frame.nonce === nonce && frame.pid === ready.pid && frame.grandchildPid === ready.grandchildPid);
      if (confirmed) return;
      await pause(pollMs);
    }
    throw new Error("Fixture liveness challenge failed");
  });
  try {
    if (handles.some((handle) => native.wait(handle, 0) !== 258)) throw new Error("Child exited before dispose");
    // Keep stdin open. Observe kernel process handles, not the disposed wait rejection, for death.
    child.processHandle.dispose(); child.disposed = true;
    const until = Date.now() + budgets.pluginShutdownHandlerMs;
    while (Date.now() < until && handles.some((handle) => native.wait(handle, 0) === 258)) await pause(pollMs);
    const signals = handles.map((handle) => native.wait(handle, 0));
    const result = { filesystemPolicy: child.filesystemPolicy, ...ready, processDead: signals[0] === 0, grandchildDead: signals[1] === 0,
      waitAfterDispose: await bounded(child.completion, ioBudget) };
    child.closed = signals.every((signal) => signal === 0);
    return result;
  } finally {
    // Only exact process handles acquired before disposal can be terminated by this cleanup.
    for (const handle of handles) { if (native.wait(handle, 0) === 258) native.terminate(handle, 2); }
    child.closed = handles.every((handle) => native.wait(handle, ioBudget) === 0);
    for (const handle of handles) native.close(handle);
  }
}

async function ancestorExposure() {
  // All synthetic profile data remains below this run's owned temp directory.
  const profile = path.join(temp, "profiles", "sample"), sibling = path.join(profile, "Documents");
  const holder = path.join(profile, "Temp", "holder"), descendant = path.join(sibling, "nested");
  await mkdir(holder, { recursive: true });
  await mkdir(descendant, { recursive: true });
  await writeFile(path.join(sibling, "sibling-name.txt"), "host-only-marker");
  await writeFile(path.join(descendant, "descendant-name.txt"), "descendant-marker");
  const entry = path.join(holder, "child-payload.mjs");
  await copyFile(new URL("./child-payload.mjs", import.meta.url), entry);
  const fixture = { directories: { profile, sibling, descendant }, files: {
    siblingContent: path.join(sibling, "sibling-name.txt"), descendantContent: path.join(descendant, "descendant-name.txt"),
  } };
  const args = [entry, "ancestor-exposure", String(ioBudget), JSON.stringify(fixture)];
  const baseline = await captureChild(spawnHost(options.runtime, args, {
    cwd: holder, env: safeEnvironment(holder), stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  }), deadline);
  if (baseline.code !== 0 || baseline.timedOut) throw new Error("Exposure host control failed");
  const host = JSON.parse(baseline.stdout.trim());
  if (host.observations.siblingContent.contents !== "host-only-marker"
    || host.observations.descendantContent.contents !== "descendant-marker") throw new Error("Exposure fixture control missing");
  const policy = buildProbeFilesystem(options.runtime, holder, process.env.SYSTEMROOT);
  if (policy.enumeratePaths.length > 64) throw new Error("Exposure fixture ancestor limit exceeded");
  const before = policy.enumeratePaths.map((directory) => [directory, native.descriptor(directory)]);
  const config = request(options.runtime, args, false);
  config.workingDirectory = holder;
  config.environment = safeEnvironment(holder);
  config.filesystem = policy.filesystem;
  config.containment.config.filesystem.enumeratePaths = policy.enumeratePaths;
  if (sdk.probe(config).needsDaclAugmentation !== false) throw new Error("No-augmentation policy is unverified");
  const child = await launch(config, "script-file");
  const result = await finish(child);
  const after = policy.enumeratePaths.map((directory) => [directory, native.descriptor(directory)]);
  if (result.exitCode !== 0) throw new Error(`Exposure fixture failed: ${result.stderr}`);
  const measured = JSON.parse(result.stdout.trim());
  const descriptorUnchanged = JSON.stringify(before) === JSON.stringify(after);
  return { filesystemPolicy: child.filesystemPolicy, hostControl: host, measured,
    descriptorUnchanged, descriptorSnapshots: { before, after },
    ...evaluateAncestorExposure(host, measured, descriptorUnchanged),
    rootContentGrants: false, actualUserProfileEnumeratedByFixture: false };
}

async function kernelObjects() {

  const source = fileURLToPath(new URL("./kernel-objects.cs", import.meta.url));
  const executable = path.join(temp, "kernel-objects.exe");
  await copyFile(source, path.join(temp, "kernel-objects.cs"));
  const powershell = path.join(process.env.SYSTEMROOT, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const script = path.join(temp, "compile.ps1");
  await writeFile(script, 'param($Source,$Output)\n$ErrorActionPreference="Stop"\nAdd-Type -Path $Source -OutputAssembly $Output -OutputType ConsoleApplication -ReferencedAssemblies System.dll,System.Core.dll\n');
  const compile = await captureChild(spawnHost(powershell, ["-NoProfile", "-NonInteractive", "-File", script,
    path.join(temp, "kernel-objects.cs"), executable], { cwd: temp, env: safeEnvironment(temp), stdio: ["ignore", "pipe", "pipe"] }), deadline);
  if (compile.code !== 0) throw new Error(`Fixture compilation failed: ${compile.stderr}`);
  const hostName = `ave-mxc-probe-${randomUUID()}`;
  const peerName = `ave-mxc-probe-${randomUUID()}`;
  const args = (mode, id) => [mode, id, String(ioBudget)];
  const host = spawnHost(executable, args("serve", hostName), { cwd: temp, env: safeEnvironment(temp), stdio: ["pipe", "pipe", "pipe"] });
  let hostOutput = "";
  host.stdout.on("data", (chunk) => { hostOutput += chunk; });
  const hostDone = captureChild(host, deadline * 3);
  await journal({ event: "host-fixture", pid: host.pid, executable });
  try {
    await bounded(new Promise((resolve, reject) => {
      const check = () => { if (hostOutput.includes('"ready":true')) resolve(); else if (host.exitCode !== null) reject(new Error("Host fixture failed")); else setTimeout(check, pollMs); }; check();
    }), deadline);
    const baseline = await captureChild(spawnHost(executable, args("read", hostName), { cwd: temp, env: safeEnvironment(temp), stdio: ["ignore", "pipe", "pipe"] }), deadline);
    const containerToHost = await one(executable, args("read", hostName), false);
    const peer = await launch(request(executable, args("serve", peerName), false, [], true), "native-command");
    const peerReady = await firstJson(peer);
    const containerToPeer = await one(executable, args("read", peerName), false);
    const hostToContainer = await captureChild(spawnHost(executable, args("read", peerName), { cwd: temp, env: safeEnvironment(temp), stdio: ["ignore", "pipe", "pipe"] }), deadline);
    await finish(peer);
    return { filesystemPolicy: peer.filesystemPolicy, hostReady: JSON.parse(hostOutput.trim()), peerReady, baseline, containerToHost, containerToPeer, hostToContainer,
      limits: ["Unique fixture names only; never existing Ave pipes", "Registry query only; write isolation remains unknown", "DACL/namespace-specific observations are not universal object isolation proof"] };
  } finally { host.stdin.end(); await bounded(hostDone); }
}

let verdict = "measured", cleanupError;
try {
  await initialize();
  if (name === "node-ui") {
    for (const ui of [true, false]) details.push(await one(options.runtime, payloadArgs("start"), ui));
  } else if (name === "shell-ui") {
    const powershell = path.join(process.env.SYSTEMROOT, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    for (const ui of [true, false]) {
      details.push({ shell: "powershell", ...(await one(powershell, ["-NoProfile", "-NonInteractive", "-Command", `Write-Output "probe-shell-started:${path.basename(temp)}"; exit 0`], ui)) });
      details.push({ shell: "git-bash", ...(options["git-bash"]
        ? await one(options["git-bash"], ["--noprofile", "--norc", "-c", `printf "probe-shell-started:${path.basename(temp)}\\n"`], ui, [options["git-root"]])
        : { uiDisabled: ui, unavailable: "Supply --git-bash and --git-root" }) });
    }
  } else if (name === "loopback") {
    for (const ui of [true, false]) details.push(await one(options.runtime, payloadArgs("loopback"), ui));
  } else if (name === "stdio-lifetime") {
    const result = await lifetime(); details.push(result);
    if (!result.processDead || !result.grandchildDead) verdict = "inconclusive";
  } else if (name === "egress-policy") {
    const results = await runEgressPolicyProbe({ launch, request, temp, ioBudget, observation, bounded });
    details.push(...results);
    if (!results.length || results.some((result) => result.accepted !== true)) verdict = "inconclusive";
  } else if (name === "ancestor-exposure") {

    const result = await ancestorExposure(); details.push(result);
    if (!result.accepted) verdict = "inconclusive";
  } else if (name === "kernel-objects") {

    details.push(await kernelObjects());
    // Partial reach measurements cannot certify the unresolved non-file-object security contract.
    verdict = "inconclusive";
  } else throw new Error("Unknown probe");
  if (details.some((detail) => detail.error || detail.unavailable)) verdict = "inconclusive";
} catch (error) { verdict = error instanceof ProcessIdentityError ? "inconclusive" : error.message.startsWith("session-0:") ? "unavailable" : "error"; details.push({ filesystemPolicy: observation?.filesystemPolicy ?? null, error: error.message }); }
finally {
  for (const resource of resources) {
    try {
      if (!resource.disposed) {
        if (!resource.closed) resource.processHandle.kill();
        const settled = await bounded(resource.completion, ioBudget);
        if (settled.error) throw new Error(settled.error);
        resource.closed = true;
        resource.processHandle.dispose(); resource.disposed = true;
      }
    } catch (error) { cleanupError = error.message; try { resource.processHandle.dispose(); } catch {} }
  }
  if (proxy) await new Promise((resolve) => { proxy.closeAllConnections(); proxy.close(resolve); });
}
const trackedCleanupVerified = resources.every((resource) => resource.closed);
if (!trackedCleanupVerified && verdict === "measured") verdict = "inconclusive";
process.stdout.write(JSON.stringify({ probe: name, verdict: cleanupError ? "error" : verdict, observation, details, trackedCleanupVerified,
  cleanupError, temp, telemetryOmitted: true }) + "\n");
