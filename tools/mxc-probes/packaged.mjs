import { spawn } from "node:child_process";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { cp, copyFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";
import { tmpdir, release } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as pause } from "node:timers/promises";
import { openPackagedObserver } from "./packaged-observer.mjs";
import { pinRuntimeProcesses } from "./process-lifecycle.mjs";
import { loadBudgets, safeEnvironment } from "./probe-common.mjs";
import { exactOwnedPath, finalizePackagedObservation, packagedProbeOptions, stdioObservation } from "./packaged-protocol.mjs";

async function assertOrdinaryTree(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if ((await lstat(file)).isSymbolicLink()) throw new Error("Packaged probe refuses redirected source files");
    if (entry.isDirectory()) await assertOrdinaryTree(file);
  }
}

function jsonChild(executable, entry, directory, mode, token, budgets) {
  const child = spawn(executable, [entry, directory, mode, token], { cwd: directory, env: safeEnvironment(directory), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const frames = [];
  let pending = "", diagnostic = "", bytes = 0, ended = false, failure;
  const closed = new Promise((resolve) => {
    child.once("error", (error) => { failure = error; ended = true; resolve({ error: error.message }); });
    child.once("close", (code, signal) => { ended = true; resolve({ code, signal }); });
  });
  child.stdin.on("error", (error) => { failure ??= error; });
  child.stdout.on("data", (chunk) => {
    bytes += chunk.length;
    if (bytes > 1024 * 1024) { failure = new Error("Packaged probe output exceeds bound"); child.kill(); return; }
    pending += chunk;
    while (pending.includes("\n")) {
      const at = pending.indexOf("\n"), line = pending.slice(0, at); pending = pending.slice(at + 1);
      try { const frame = JSON.parse(line); if (!frame || typeof frame !== "object") throw new Error("Invalid observation"); frames.push(frame); }
      catch (error) { failure = error; child.kill(); return; }
    }
  });
  child.stderr.on("data", (chunk) => { diagnostic = (diagnostic + chunk).slice(-32768); });
  return {
    child, frames, closed,
    send(frame) { child.stdin.write(JSON.stringify(frame) + "\n"); },
    async waitFor(predicate) {
      const until = Date.now() + budgets.windowsAclHostStartupMs;
      while (Date.now() < until) {
        const found = frames.find(predicate);
        if (found) return found;
        const error = frames.find((frame) => frame.event === "failure");
        if (error || failure || ended) throw new Error(JSON.stringify(error ?? { message: failure?.message ?? "Packaged main exited", diagnostic }));
        await pause(Math.min(budgets.processGroupPollMs, 50));
      }
      throw new Error("Packaged observation deadline exceeded");
    },
    async finish() {
      let timer;
      try {
        return await Promise.race([closed, new Promise((_, reject) => { timer = setTimeout(() => { child.kill(); reject(new Error("Packaged main close deadline")); }, budgets.windowsAclHostStartupMs); })]);
      } finally { clearTimeout(timer); }
    },
  };
}

async function main() {
  const result = { probe: "packaged-extension-process", verdict: "inconclusive", nativeVerified: false, observations: [], cleanupVerified: false };
  if (process.platform !== "win32" || process.arch !== "x64") {
    return { ...result, verdict: "unavailable", reason: "Run from a standard-user interactive Windows x64 desktop session" };
  }
  const { executable } = packagedProbeOptions(process.argv.slice(2));
  const original = await realpath(executable);
  const native = openPackagedObserver(original);
  const sessionId = native.session();
  const elevated = native.elevated();
  if (elevated) return { ...result, verdict: "unavailable", elevated, standardUser: false, reason: "Use a standard-user non-elevated session" };
  if (sessionId === 0) return { ...result, verdict: "unavailable", reason: "Interactive desktop session required" };
  const budgets = await loadBudgets();
  const root = await mkdtemp(path.join(tmpdir(), "ave-mxc-packaged-"));
  const copyRoot = exactOwnedPath(root, path.join(root, "app"));
  result.temp = root;
  result.runtime = { original, sha256: createHash("sha256").update(await readFile(original)).digest("hex"), node: process.versions.node, arch: process.arch, windowsRelease: release(), sessionId, elevated, standardUser: !elevated };
  let cleanupVerified = true;
  const processes = [];
  try {
    await assertOrdinaryTree(path.dirname(original));
    await cp(path.dirname(original), copyRoot, { recursive: true, dereference: false });
    const copiedExecutable = path.join(copyRoot, path.basename(original));
    const entry = path.join(copyRoot, "resources/app.asar/dist/src/main/mxc-packaged-probe.js");
    const launch = async (name, mode) => {
      const directory = exactOwnedPath(root, path.join(root, name));
      await mkdir(directory);
      await copyFile(new URL("./packaged-fixture.mjs", import.meta.url), path.join(directory, "fixture.mjs"));
      const launchedAfter = native.now();
      const run = jsonChild(copiedExecutable, entry, directory, mode, randomBytes(16).toString("hex"), budgets);
      processes.push(run);
      return { ...run, launchedAfter };
    };
    const observe = async (name, operation) => {
      try { const observation = await operation(); result.observations.push({ name, ...observation }); }
      catch (error) { cleanupVerified = false; result.observations.push({ name, passed: false, error: error.message,
        processes: processes.slice(-1).map((run) => ({ mainPid: run.child.pid, observations: run.frames })) }); }
    };
    await observe("packaged-stdio-backpressure-eof", async () => {
      const run = await launch("stdio", "echo");
      const owned = await run.waitFor((frame) => frame.event === "owned");
      const stdio = stdioObservation(await run.waitFor((frame) => frame.event === "stdio"));
      const exit = await run.finish();
      return { ...stdio, resolvedNativeModules: owned.diagnostics.nativeModules, ownerHandle: owned.diagnostics.ownerHandle,
        verifyBeforeLoad: "production bootstrap completed; installed-byte pins and whole native directory checks precede addon require", exit,
        passed: stdio.passed && exit.code === 0 && !exit.signal
          && Array.isArray(owned.diagnostics.nativeModules)
          && ["mxc_ffi.dll", "koffi.node"].every((name) => owned.diagnostics.nativeModules.some((file) => path.basename(file).toLowerCase() === name)) };
    });
    for (const action of ["dispose", "main-death", "supervisor-death"]) {
      await observe(action, async () => {
        const run = await launch(action, "lifetime");
        const owned = await run.waitFor((frame) => frame.event === "owned");
        const started = await run.waitFor((frame) => frame.event === "lifecycle" && frame.type === "supervisor-started");
        const fixture = await run.waitFor((frame) => frame.event === "fixture" && frame.frame.marker === "ready");
        const pids = [run.child.pid, started.pid, fixture.frame.pid, fixture.frame.grandchildPid];
        const handles = await pinRuntimeProcesses(native, pids, run.launchedAfter, copiedExecutable, async () => {
          const nonce = randomUUID(); run.send({ action: "challenge", nonce });
          await run.waitFor((frame) => frame.event === "fixture" && frame.frame.marker === "confirmed" && frame.frame.nonce === nonce
            && frame.frame.pid === pids[2] && frame.frame.grandchildPid === pids[3]);
        });
        let inheritance;
        try {
          const supervisorModules = native.modules(handles[1]);
          try {
            inheritance = native.observeOwnerHandle(handles[1], handles.slice(2), owned.diagnostics.ownerHandle);
            inheritance.passed = !inheritance.supervisorInheritable && inheritance.descendants.every((entry) => !entry.inherited);
          } catch (error) { inheritance = { passed: false, inconclusive: error.message }; }
          const liveBeforeAction = handles.map((handle) => native.wait(handle, 0) === 258);
          if (!liveBeforeAction.every(Boolean)) throw new Error("Measured process exited before the lifetime action");
          if (action === "dispose") { run.send({ action: "dispose" }); await run.waitFor((frame) => frame.event === "disposed"); }
          else if (!native.terminate(handles[action === "main-death" ? 0 : 1], 73)) throw new Error("Cannot terminate pinned measured process");
          const until = Date.now() + budgets.windowsAclHostStartupMs;
          while (Date.now() < until && handles.some((handle) => native.wait(handle, 0) === 258)) await pause(Math.min(budgets.processGroupPollMs, 50));
          const signals = handles.map((handle) => native.wait(handle, 0));
          const exit = await run.finish();
          const deadBeforeCleanup = signals.map((signal) => signal === 0);
          return { passed: inheritance.passed && deadBeforeCleanup.every(Boolean), pids, liveBeforeAction, deadBeforeCleanup, fd3NonInheritance: inheritance,
            resolvedNativeModules: owned.diagnostics.nativeModules, supervisorModules, exit };
        } finally {
          // Only identity-pinned process objects become eligible for cleanup.
          for (const handle of handles) if (native.wait(handle, 0) === 258) native.terminate(handle, 74);
          const dead = handles.every((handle) => native.wait(handle, budgets.windowsAclHostStartupMs) === 0);
          cleanupVerified &&= dead;
          for (const handle of handles) native.close(handle);
        }
      });
    }
    await observe("cancel-during-native-spawn", async () => {
      const run = await launch("cancel", "cancel");
      const observation = await run.waitFor((frame) => frame.event === "cancel");
      const exit = await run.finish();
      return { passed: observation.pending === true && observation.name === "MxcProcessContractError" && exit.code === 0,
        ...observation, exit, lifecycle: run.frames.filter((frame) => frame.event === "lifecycle"),
        ...(observation.pending === true ? {} : { inconclusive: "Cancellation did not overlap the native spawn await; do not count as a pass" }) };
    });
    await observe("planted-dll-before-load", async () => {
      const planted = exactOwnedPath(root, path.join(copyRoot, "resources/app.asar.unpacked/node_modules/@microsoft/mxc-sdk/bin/x64/planted.dll"));
      await copyFile(path.join(path.dirname(planted), "mxc_ffi.dll"), planted);
      try {
        const run = await launch("planted", "echo");
        const failure = await run.waitFor((frame) => frame.event === "failure");
        const exit = await run.finish();
        const creationStarted = run.frames.some((frame) => frame.event === "lifecycle" && frame.type === "creating");
        return { passed: failure.name === "MxcIntegrityError" && !creationStarted && !run.frames.some((frame) => frame.event === "owned") && exit.code === 2,
          failure, creationStarted, planted, exit, originalInstallationMutated: false };
      } finally { await rm(planted); }
    });
  } catch (error) {
    cleanupVerified = false; result.reason = error.message;
  } finally {
    for (const run of processes) {
      if (run.child.exitCode === null && run.child.signalCode === null) { run.child.kill(); try { await run.finish(); } catch { cleanupVerified = false; } }
    }
    await finalizePackagedObservation(result, root, cleanupVerified);
  }
  return result;
}

try {
  const result = await main();
  process.stdout.write(JSON.stringify(result) + "\n"); process.exitCode = result.verdict === "measured" ? 0 : 2;
} catch (error) {
  process.stdout.write(JSON.stringify({ probe: "packaged-extension-process", verdict: "error", nativeVerified: false, cleanupVerified: false, reason: error.message }) + "\n");
  process.exitCode = 2;
}
