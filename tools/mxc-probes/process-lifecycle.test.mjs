import assert from "node:assert/strict";
import { test } from "node:test";
import { finishProcess, pinRuntimeProcesses, ProcessIdentityError } from "./process-lifecycle.mjs";

function record(result) {
  const calls = [];
  return { calls, stdin: { end() { calls.push("end"); } },
    processHandle: { dispose() { calls.push("dispose"); } }, completion: Promise.resolve(result),
    stdout: "output", stderr: "", closed: false, disposed: false };
}

test("an SDK deadline is an error even when the workload exit code is zero", async () => {
  const child = record({ value: { exitCode: 0, timedOut: true } });
  await assert.rejects(finishProcess(child, (promise) => promise), /SDK process deadline exceeded/);
  assert.deepEqual(child.calls, ["end", "dispose"]);
  assert.equal(child.closed, true);
  assert.equal(child.disposed, true);
});

test("terminal success retains output and disposes the owned process", async () => {
  const child = record({ value: { exitCode: 0, timedOut: false } });
  assert.deepEqual(await finishProcess(child, (promise) => promise), {
    exitCode: 0, timedOut: false, stdout: "output", stderr: "",
  });
});

function fixture(identities) {
  const closed = [], terminated = [];
  const native = {
    open(_rights, _inherit, pid) { return pid; },
    identity(handle) { return identities[handle]; },
    wait() { return 258; },
    close(handle) { closed.push(handle); },
    terminate(handle) { terminated.push(handle); },
  };
  return { native, closed, terminated };
}
const RUNTIME = "C:\\runtime\\node.exe";
const parent = { createdAt: 101n, imagePath: RUNTIME };
const grandchild = { createdAt: 102n, imagePath: RUNTIME };

test("old or different-image PIDs are closed without termination or liveness admission", async () => {
  for (const candidate of [
    { ...grandchild, createdAt: 99n },
    { ...grandchild, createdAt: 100n },
    { ...grandchild, imagePath: "C:\\unrelated\\node.exe" },
  ]) {
    const state = fixture({ 10: parent, 11: candidate });
    let confirmed = false;
    await assert.rejects(pinRuntimeProcesses(state.native, [10, 11], 100n, RUNTIME,
      async () => { confirmed = true; }), ProcessIdentityError);
    assert.equal(confirmed, false);
    assert.deepEqual(state.closed, [10, 11]);
    assert.deepEqual(state.terminated, []);
  }
});

test("failed identity queries remain inconclusive without any termination", async () => {
  const state = fixture({ 10: parent });
  state.native.identity = () => { throw new Error("access denied"); };
  await assert.rejects(pinRuntimeProcesses(state.native, [10], 100n, RUNTIME, async () => {}), ProcessIdentityError);
  assert.deepEqual(state.closed, [10]);
  assert.deepEqual(state.terminated, []);
});

test("same-image PID reuse cannot pass without a fresh owned-pipe liveness response", async () => {
  const state = fixture({ 10: parent, 11: grandchild });
  await assert.rejects(pinRuntimeProcesses(state.native, [10, 11], 100n, RUNTIME,
    async () => { throw new Error("liveness response missing"); }), ProcessIdentityError);
  assert.deepEqual(state.closed, [10, 11]);
  assert.deepEqual(state.terminated, []);
});

test("matching live processes become owned only after confirmation", async () => {
  const state = fixture({ 10: parent, 11: { ...grandchild, imagePath: "\\\\?\\C:\\RUNTIME\\NODE.EXE" } });
  let confirmed = false;
  const handles = await pinRuntimeProcesses(state.native, [10, 11], 100n, RUNTIME, async () => { confirmed = true; });
  assert.equal(confirmed, true);
  assert.deepEqual(handles, [10, 11]);
  assert.deepEqual(state.closed, []);
  assert.deepEqual(state.terminated, []);
});

test("lifetime fixture answers a fresh nonce through its owned grandchild pipe", { skip: process.platform === "win32" }, async (t) => {
  const { spawn } = await import("node:child_process");
  const { randomUUID } = await import("node:crypto");
  const { createInterface } = await import("node:readline");
  const { fileURLToPath } = await import("node:url");
  const { loadBudgets } = await import("./probe-common.mjs");
  const { mxcRequestTransportMs } = await loadBudgets();
  const child = spawn(process.execPath, [fileURLToPath(new URL("./child-payload.mjs", import.meta.url)), "lifetime", String(mxcRequestTransportMs)], {
    detached: true, stdio: ["pipe", "pipe", "pipe"],
  });
  const closed = new Promise((resolve) => child.once("close", resolve));
  child.stderr.resume();
  t.after(async () => {
    // This test created an exclusive process group and its root is still our live child.
    if (child.exitCode === null && child.signalCode === null) process.kill(-child.pid, "SIGKILL");
    await closed;
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Fixture challenge deadline")), mxcRequestTransportMs);
    let ready, nonce;
    const lines = createInterface({ input: child.stdout });
    const fail = (error) => { clearTimeout(timer); lines.close(); reject(error); };
    child.once("error", fail);
    lines.on("line", (line) => {
      try {
        const frame = JSON.parse(line);
        if (frame.marker === "long-lived") {
          ready = frame; nonce = randomUUID(); child.stdin.write(JSON.stringify({ nonce }) + "\n");
        } else if (frame.marker === "identity-confirmed") {
          assert.equal(frame.nonce, nonce);
          assert.equal(frame.pid, child.pid);
          assert.equal(frame.grandchildPid, ready.grandchildPid);
          clearTimeout(timer); lines.close(); resolve();
        }
      } catch (error) { fail(error); }
    });
  });
});
