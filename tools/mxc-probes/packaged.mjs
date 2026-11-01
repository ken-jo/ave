import { spawn } from "node:child_process";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { copyFile, mkdir, mkdtemp, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { tmpdir, release } from "node:os";
import { setTimeout as pause } from "node:timers/promises";
import { openPackagedObserver } from "./packaged-observer.mjs";
import { writeProbeJson } from "./packaged-processes.mjs";
import { pinRuntimeProcesses } from "./process-lifecycle.mjs";
import { loadBudgets, safeEnvironment } from "./probe-common.mjs";
import { cancellationObservation, exactOwnedPath, finalizePackagedObservation, ownerHandleObservationPassed, packagedObservation, packagedProbeOptions, pinnedProcessIdentity, plantedDllRejected, stdioObservation, terminatePinnedProcess } from "./packaged-protocol.mjs";
import { copyPackagedTree } from "./packaged-filesystem.mjs";

function imageKey(file) { return path.win32.normalize(file).toLowerCase(); }

function jsonChild(observation, executable, entry, directory, mode, token, budgets, observerExecutable) {
  const child = spawn(executable, [entry, directory, mode, token, observerExecutable], { cwd: directory, env: safeEnvironment(directory), windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  if (child.pid !== undefined) observation.spawned = true;
  child.once("spawn", () => { observation.spawned = true; });
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
    child, frames, closed, records: [], unverifiedProcesses: [], directory, token,
    send(frame) { child.stdin.write(JSON.stringify(frame) + "\n"); },
    async waitFor(predicate, allowFailure = false) {
      const until = Date.now() + budgets.windowsAclHostStartupMs;
      while (Date.now() < until) {
        const found = frames.find(predicate);
        if (found) return found;
        const error = frames.find((frame) => frame.event === "failure");
        if ((!allowFailure && error) || failure || ended) throw new Error(JSON.stringify(error ?? { message: failure?.message ?? "Packaged main exited", diagnostic }));
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

async function main(result) {
  if (process.platform !== "win32" || process.arch !== "x64") return { ...result, verdict: "unavailable", reason: "Run from a standard-user interactive Windows x64 desktop session" };
  const { executable } = packagedProbeOptions(process.argv.slice(2));
  const original = await realpath(executable);
  const native = openPackagedObserver(original);
  const sessionId = native.session(), elevated = native.elevated();
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
    await copyPackagedTree(path.dirname(original), copyRoot);
    const copiedExecutable = await realpath(path.join(copyRoot, path.basename(original)));
    const entry = path.join(copyRoot, "resources/app.asar/dist/src/main/mxc-packaged-probe.js");
    const addRecord = (run, role, pid, handle, pinTime) => {
      const identity = pinnedProcessIdentity(native, handle, pid, pinTime && { ...pinTime, expectedImagePath: copiedExecutable });
      if (imageKey(identity.imagePath) !== imageKey(copiedExecutable) || identity.createdAt < run.launchedAfter) throw new Error("Measured process identity mismatch");
      const record = { role, pid, handle, createdAt: identity.createdAt.toString(), imagePath: identity.imagePath,
        ...(identity.identityEvidence ? { identityEvidence: identity.identityEvidence, imageQueryErrorCode: identity.imageQueryErrorCode } : {}) };
      run.records.push(record); return record;
    };
    const launch = async (name, mode) => {
      const directory = exactOwnedPath(root, path.join(root, name)); await mkdir(directory);
      await copyFile(new URL("./packaged-fixture.mjs", import.meta.url), path.join(directory, "fixture.mjs"));
      await copyFile(new URL("./packaged-processes.mjs", import.meta.url), path.join(directory, "packaged-processes.mjs"));
      const launchedAfter = native.now();
      const run = jsonChild(result, copiedExecutable, entry, directory, mode, randomBytes(16).toString("hex"), budgets, original);
      run.launchedAfter = launchedAfter; processes.push(run);
      await run.waitFor((frame) => frame.event === "main-ready");
      const [handle] = await pinRuntimeProcesses(native, [run.child.pid], launchedAfter, copiedExecutable, async () => {
        const nonce = randomUUID(); run.send({ action: "owner-challenge", nonce });
        await run.waitFor((frame) => frame.event === "owner-confirmed" && frame.pid === run.child.pid && frame.nonce === nonce);
      });
      try { addRecord(run, "main", run.child.pid, handle); }
      catch (error) { native.close(handle); throw error; }
      run.send({ action: "begin" });
      // The diagnostic main pins this process synchronously in the public spawn
      // callback and retains it even if startup rejection made it exit already.
      const supervisor = await run.waitFor((frame) => frame.event === "supervisor-pinned", true);
      const supervisorHandle = native.duplicateProcessHandle(handle, supervisor.handle);
      try {
        const record = addRecord(run, "supervisor", supervisor.pid, supervisorHandle);
        if (record.createdAt !== supervisor.createdAt || imageKey(record.imagePath) !== imageKey(supervisor.imagePath)) throw new Error("Duplicated supervisor identity mismatch");
      } catch (error) {
        if (run.records.at(-1)?.handle === supervisorHandle) run.records.pop();
        native.close(supervisorHandle); throw error;
      }
      return run;
    };
    const journal = async (run, name, wait) => {
      const until = Date.now() + (wait ? budgets.windowsAclHostStartupMs : 0);
      do {
        try {
          const value = JSON.parse(await readFile(path.join(run.directory, name), "utf8"));
          if (value.token !== run.token || !Number.isInteger(value.pid) || value.pid <= 0) throw new Error("Invalid fixture identity journal");
          return value;
        } catch (error) { if (error.code !== "ENOENT") throw error; }
        if (!wait) return null;
        await pause(Math.min(budgets.processGroupPollMs, 50));
      } while (Date.now() < until);
      throw new Error("Fixture identity journal deadline exceeded");
    };
    const pinFixtures = async (run, includeGrandchild, wait = true) => {
      const entries = [await journal(run, "process.json", wait)];
      if (includeGrandchild) entries.push(await journal(run, "grandchild.json", wait));
      for (let index = 0; index < entries.length; index++) {
        const value = entries[index], role = index ? "grandchild" : "container";
        if (!value) { run.unverifiedProcesses.push({ role, reason: "No independently observable fixture identity before native teardown" }); continue; }
        try {
          const [handle] = await pinRuntimeProcesses(native, [value.pid], BigInt(run.records.at(-1).createdAt), copiedExecutable, async () => {
            const nonce = randomUUID(); await writeProbeJson(run.directory, `challenge-${value.pid}.json`, { nonce });
            const until = Date.now() + budgets.windowsAclHostStartupMs;
            while (Date.now() < until) {
              try {
                const ack = JSON.parse(await readFile(path.join(run.directory, `ack-${value.pid}.json`), "utf8"));
                if (ack.token === run.token && ack.nonce === nonce && ack.pid === value.pid) return;
              } catch (error) { if (error.code !== "ENOENT") throw error; }
              await pause(Math.min(budgets.processGroupPollMs, 50));
            }
            throw new Error("Fixture liveness challenge deadline exceeded");
          });
          addRecord(run, role, value.pid, handle);
        } catch (error) { run.unverifiedProcesses.push({ role, pid: value.pid, reason: error.message }); }
      }
      return run.unverifiedProcesses.length === 0;
    };
    const finishRun = async (run) => {
      await run.waitFor((frame) => frame.event === "case-complete", true);
      run.send({ action: "release" });
      const exit = await run.finish();
      const until = Date.now() + budgets.windowsAclHostStartupMs;
      while (Date.now() < until && run.records.some((record) => native.wait(record.handle, 0) === 258)) await pause(Math.min(budgets.processGroupPollMs, 50));
      const processObservations = run.records.map(({ handle, ...record }) => ({ ...record, signaled: native.wait(handle, 0) === 0 }));
      const survivorsBeforeCleanup = processObservations.filter((record) => !record.signaled);
      return { exit, processObservations, survivorsBeforeCleanup, unverifiedProcesses: [...run.unverifiedProcesses],
        processDeathVerified: survivorsBeforeCleanup.length === 0 && run.unverifiedProcesses.length === 0 };
    };
    const observe = async (name, operation) => {
      try { const observation = await operation(); result.observations.push(packagedObservation(name, observation)); }
      catch (error) { cleanupVerified = false; result.observations.push({ name, passed: false, error: error.message,
        processes: processes.slice(-1).map((run) => ({ mainPid: run.child.pid, observations: run.frames, pinned: run.records.map(({ handle, ...record }) => record), unverifiedProcesses: run.unverifiedProcesses })) }); }
    };
    await observe("packaged-stdio-bytes-eof", async () => {
      const run = await launch("stdio", "echo");
      const owned = await run.waitFor((frame) => frame.event === "owned");
      const containerObservationComplete = await pinFixtures(run, false);
      if (!containerObservationComplete) throw new Error("Cannot independently pin stdio container");
      await writeProbeJson(run.directory, "go.json", {}); run.send({ action: "run" });
      const stdio = stdioObservation(await run.waitFor((frame) => frame.event === "stdio"));
      const accounting = await finishRun(run);
      return { ...stdio, ...accounting, containerObservationComplete, diagnostics: owned.diagnostics,
        passed: stdio.passed && accounting.processDeathVerified && accounting.exit.code === 0 && !accounting.exit.signal
          && ["mxc_ffi.dll", "koffi.node"].every((name) => owned.diagnostics.nativeModules.some((file) => path.basename(file).toLowerCase() === name)) };
    });
    for (const action of ["dispose", "main-death", "supervisor-death"]) {
      await observe(action, async () => {
        const run = await launch(action, "lifetime");
        const owned = await run.waitFor((frame) => frame.event === "owned");
        if (!(await pinFixtures(run, true))) throw new Error("Cannot independently pin lifetime fixtures");
        const supervisor = run.records.find((record) => record.role === "supervisor");
        const descendants = run.records.filter((record) => ["container", "grandchild"].includes(record.role));
        const supervisorModules = native.modules(supervisor.handle);
        let inheritance;
        try { inheritance = native.observeOwnerHandle(supervisor.handle, descendants.map((record) => record.handle), owned.diagnostics.ownerHandle); inheritance.passed = ownerHandleObservationPassed(inheritance); }
        catch (error) { inheritance = { passed: false, inconclusive: error.message }; }
        const liveBeforeAction = run.records.map((record) => native.wait(record.handle, 0) === 258);
        if (!liveBeforeAction.every(Boolean)) throw new Error("Measured process exited before the lifetime action");
        if (action === "dispose") { run.send({ action: "dispose" }); await run.waitFor((frame) => frame.event === "disposed"); }
        else if (!native.terminate(run.records.find((record) => record.role === (action === "main-death" ? "main" : "supervisor")).handle, 73)) throw new Error("Cannot terminate pinned measured process");
        let accounting;
        if (action === "main-death") {
          const exit = await run.finish(), until = Date.now() + budgets.windowsAclHostStartupMs;
          while (Date.now() < until && run.records.some((record) => native.wait(record.handle, 0) === 258)) await pause(Math.min(budgets.processGroupPollMs, 50));
          const processObservations = run.records.map(({ handle, ...record }) => ({ ...record, signaled: native.wait(handle, 0) === 0 }));
          accounting = { exit, processObservations, survivorsBeforeCleanup: processObservations.filter((record) => !record.signaled), processDeathVerified: processObservations.every((record) => record.signaled) };
        } else accounting = await finishRun(run);
        return { ...accounting, passed: inheritance.passed && accounting.processDeathVerified, liveBeforeAction, fd3NonInheritance: inheritance, diagnostics: owned.diagnostics, supervisorModules };
      });
    }
    await observe("cancel-during-native-spawn", async () => {
      const run = await launch("cancel", "cancel");
      const observation = await run.waitFor((frame) => frame.event === "cancel");
      // The main retains a duplicate across cancellation; neither live-child
      // JavaScript nor a post-disposal PID lookup is needed for death evidence.
      const pinned = await run.waitFor((frame) => frame.event === "container-pinned", true);
      const source = run.records.find((record) => record.role === "main");
      const handle = native.duplicateProcessHandle(source.handle, pinned.handle);
      try {
        const record = addRecord(run, "container", pinned.pid, handle, pinned);
        if (record.createdAt !== pinned.createdAt || imageKey(record.imagePath) !== imageKey(pinned.imagePath)) throw new Error("Duplicated container identity mismatch");
      } catch (error) {
        if (run.records.at(-1)?.handle === handle) run.records.pop();
        native.close(handle); throw error;
      }
      const accounting = await finishRun(run);
      return cancellationObservation(observation, accounting);
    });
    await observe("planted-dll-before-load", async () => {
      const relative = "@microsoft/mxc-sdk/bin/x64/planted.dll";
      const planted = exactOwnedPath(root, path.join(copyRoot, "resources/app.asar.unpacked/node_modules", relative));
      await copyFile(path.join(path.dirname(planted), "mxc_ffi.dll"), planted);
      const run = await launch("planted", "echo");
      const failure = await run.waitFor((frame) => frame.event === "failure");
      const accounting = await finishRun(run);
      const creationStarted = run.frames.some((frame) => frame.event === "lifecycle" && frame.type === "creating");
      const containerNotCreated = !creationStarted && !run.frames.some((frame) => frame.event === "owned") && plantedDllRejected(failure, relative);
      return { ...accounting, passed: containerNotCreated && accounting.processDeathVerified && accounting.exit.code === 2,
        failure, containerNotCreated, planted, originalInstallationMutated: false };
    });
  } catch (error) { cleanupVerified = false; result.reason = error.message; }
  finally {
    result.processCleanup = [];
    result.unverifiedProcesses = [];
    for (const run of processes) {
      if (run.child.exitCode === null && run.child.signalCode === null) { run.child.kill(); try { await run.finish(); } catch { cleanupVerified = false; } }
      const started = run.frames.find((frame) => frame.event === "lifecycle" && frame.type === "supervisor-started");
      if (!run.records.some((record) => record.role === "main")) run.unverifiedProcesses.push({ role: "main", pid: run.child.pid, reason: "Main identity challenge did not complete" });
      if (started && !run.records.some((record) => record.role === "supervisor")) run.unverifiedProcesses.push({ role: "supervisor", pid: started.pid, reason: "Supervisor process object was not independently duplicated" });
      if (run.frames.some((frame) => frame.event === "lifecycle" && frame.type === "creating") && !run.records.some((record) => record.role === "container")
        && !run.unverifiedProcesses.some((record) => record.role === "container")) run.unverifiedProcesses.push({ role: "container", reason: "Native creation reached without a pinned container identity" });
      result.unverifiedProcesses.push(...run.unverifiedProcesses.map((record) => ({ runDirectory: run.directory, ...record })));
      for (const record of run.records) {
        const survived = native.wait(record.handle, 0) !== 0;
        let cleanupError;
        if (survived) {
          try { terminatePinnedProcess(native, record.handle, 74); }
          catch (error) { cleanupError = error.message; }
        }
        const dead = native.wait(record.handle, budgets.windowsAclHostStartupMs) === 0;
        result.processCleanup.push({ role: record.role, pid: record.pid, createdAt: record.createdAt, imagePath: record.imagePath, survivorBeforeCleanup: survived, cleanupDeathVerified: dead, ...(cleanupError ? { cleanupError } : {}) });
        cleanupVerified &&= dead && !cleanupError;
        native.close(record.handle);
      }
      if (run.unverifiedProcesses.length) cleanupVerified = false;
    }
    await finalizePackagedObservation(result, root, cleanupVerified);
  }
  return result;
}
const result = { probe: "packaged-extension-process", verdict: "inconclusive", nativeVerified: false, observations: [], cleanupVerified: false, spawned: false };
try {
  const observation = await main(result); process.stdout.write(JSON.stringify(observation) + "\n"); process.exitCode = observation.verdict === "measured" ? 0 : 2;
} catch (error) {
  process.stdout.write(JSON.stringify({ ...result, verdict: "error", nativeVerified: false, cleanupVerified: false, retainedTempRemovalSafe: result.spawned === false, reason: error.message }) + "\n"); process.exitCode = 2;
}
