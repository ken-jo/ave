import assert from "node:assert/strict";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { releasePackagedPins } from "./packaged-processes.mjs";
import { PackagedImageQueryError, pinnedProcessIdentity } from "./packaged-protocol.mjs";

function releaseControl() {
  const input = new PassThrough(), controls = createInterface({ input });
  let closed = false, resolve, reject;
  const released = new Promise((yes, no) => { resolve = yes; reject = no; });
  void released.catch(() => {});
  controls.on("line", (line) => { if (JSON.parse(line).action === "release") resolve(); });
  controls.once("close", () => { closed = true; reject(new Error("Probe controller disconnected")); });
  return { input, controls, command(action) {
    assert.equal(action, "release");
    return closed ? Promise.reject(new Error("Probe controller disconnected")) : released;
  } };
}

for (const mode of ["echo", "lifetime", "cancel"]) {
  test(`${mode} pins stay open through case-complete until explicit release (unit handle model)`, async () => {
    const control = releaseControl(), closed = [], frames = [];
    const handles = ["supervisor", "container"];
    let containerClosed = false;
    const closing = (handle) => { closed.push(handle); if (handle === "container") containerClosed = true; };
    try {
      for (const event of ["native-created", "container-pinned", "stopped", "cancel", "case-complete"]) frames.push(event);
      const finishing = releasePackagedPins(control.command, handles, closing);
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(closed, []);
      // A retained model object can be duplicated after cancellation settles.
      // This does not claim a native process handle or Windows death result.
      const native = {
        pid: () => containerClosed ? 999 : 59400,
        identity: () => ({ createdAt: 123n, imagePath: "owned-copy" }),
      };
      assert.deepEqual(pinnedProcessIdentity(native, "duplicated-container", 59400), { createdAt: 123n, imagePath: "owned-copy" });
      assert.equal(frames.at(-1), "case-complete");
      control.input.write(JSON.stringify({ action: "release" }) + "\n");
      await finishing;
      assert.deepEqual(closed, handles);
    } finally { control.controls.close(); control.input.destroy(); }
  });
}

for (const disconnectedFirst of [false, true]) {
  test(`control EOF ${disconnectedFirst ? "before" : "during"} release wait fails without silently closing pins`, async () => {
    const control = releaseControl(), closed = [];
    try {
      if (disconnectedFirst) {
        const ended = once(control.controls, "close"); control.input.end(); await ended;
      }
      const finishing = releasePackagedPins(control.command, ["supervisor", "container"], (handle) => closed.push(handle));
      const rejected = assert.rejects(finishing, /Harness handle-lifetime contract failed: controller disconnected before explicit release/);
      if (!disconnectedFirst) control.input.end();
      await rejected;
      assert.deepEqual(closed, []);
    } finally { control.controls.close(); control.input.destroy(); }
  });
}

test("PID mismatch precedes any identity query", () => {
  let queried = false;
  const native = { pid: () => 12345, identity() { queried = true; throw new Error("Generic identity failure"); } };
  assert.throws(() => pinnedProcessIdentity(native, "duplicate", 59400), { message: "Measured process PID mismatch; possible handle-lifetime race: expected 59400, got 12345" });
  assert.equal(queried, false);
});

test("PID query failure propagates from the native observer before identity", () => {
  const cause = new Error("GetProcessId failed (6)");
  let queried = false;
  const native = { pid() { throw cause; }, identity() { queried = true; } };
  assert.throws(() => pinnedProcessIdentity(native, "duplicate", 59400), (error) => error === cause);
  assert.equal(queried, false);
});

test("a matching PID cannot hide a failed identity query", () => {
  const cause = new Error("QueryFullProcessImageNameW failed (31)");
  const native = { pid: () => 59400, identity() { throw cause; } };
  assert.throws(() => pinnedProcessIdentity(native, "duplicate", 59400), (error) => error === cause);
});

function exitedIdentityModel() {
  const pinTime = { pid: 59400, createdAt: "123", imagePath: "C:\\Owned\\Ave.exe", expectedImagePath: "c:\\owned\\Ave.exe", aliveAtPinTime: true };
  const cause = new PackagedImageQueryError(123n, 31);
  const waits = [];
  const native = { pid: () => 59400, identity() { throw cause; }, wait(handle, timeout) { waits.push([handle, timeout]); return 0; } };
  return { native, cause, waits, pinTime };
}

test("a signaled model handle accepts matching PID, creation time and live pin-time image evidence", () => {
  const f = exitedIdentityModel();
  assert.deepEqual(pinnedProcessIdentity(f.native, "duplicate", 59400, f.pinTime), {
    createdAt: 123n, imagePath: "C:\\Owned\\Ave.exe",
    identityEvidence: "exited-before-duplication: pid+createdAt+pin-time image", imageQueryErrorCode: 31,
  });
  assert.deepEqual(f.waits, [["duplicate", 0]]);
});

test("a running model handle cannot substitute pin-time evidence for a failed image query", () => {
  const f = exitedIdentityModel();
  f.native.wait = () => 258;
  assert.throws(() => pinnedProcessIdentity(f.native, "duplicate", 59400, f.pinTime), (error) => error === f.cause);
});

test("an exited process creation-time mismatch is a hard failure", () => {
  const f = exitedIdentityModel();
  for (const createdAt of ["124", "0", undefined]) {
    assert.throws(() => pinnedProcessIdentity(f.native, "duplicate", 59400, { ...f.pinTime, createdAt }), /creation time mismatch/);
  }
});

test("an exited process requires a resolved image recorded while alive", () => {
  const f = exitedIdentityModel();
  for (const partial of [{ imagePath: undefined }, { imagePath: "" }, { imagePath: "relative.exe" }, { aliveAtPinTime: false }, { aliveAtPinTime: undefined },
    { expectedImagePath: undefined }, { expectedImagePath: "relative.exe" }]) {
    assert.throws(() => pinnedProcessIdentity(f.native, "duplicate", 59400, { ...f.pinTime, ...partial }), /Missing live pin-time image evidence/);
  }
});

test("absent pin frames and image-path resolution errors cannot identify an exited process", () => {
  const f = exitedIdentityModel();
  assert.throws(() => pinnedProcessIdentity(f.native, "duplicate", 59400), (error) => error === f.cause);
  const resolutionFailure = new Error("realpath failed");
  f.native.identity = () => { throw resolutionFailure; };
  assert.throws(() => pinnedProcessIdentity(f.native, "duplicate", 59400, f.pinTime), (error) => error === resolutionFailure);
});

test("a mismatching pin-time image or PID cannot identify an exited process", () => {
  const f = exitedIdentityModel();
  assert.throws(() => pinnedProcessIdentity(f.native, "duplicate", 59400, { ...f.pinTime, imagePath: "C:\\Other\\Ave.exe" }), /pin-time image mismatch/);
  assert.throws(() => pinnedProcessIdentity(f.native, "duplicate", 59400, { ...f.pinTime, pid: 1 }), /creation time mismatch/);
  f.native.pid = () => 1;
  assert.throws(() => pinnedProcessIdentity(f.native, "duplicate", 59400, f.pinTime), /process PID mismatch/);
});

test("time-query failures and failed signal waits cannot use pin-time evidence", () => {
  const f = exitedIdentityModel();
  f.native.wait = () => 0xffffffff;
  assert.throws(() => pinnedProcessIdentity(f.native, "duplicate", 59400, f.pinTime), (error) => error === f.cause);
  const failedTimes = new Error("GetProcessTimes failed (6)");
  f.native.identity = () => { throw failedTimes; };
  assert.throws(() => pinnedProcessIdentity(f.native, "duplicate", 59400, f.pinTime), (error) => error === failedTimes);
});
