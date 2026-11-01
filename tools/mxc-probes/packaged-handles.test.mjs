import assert from "node:assert/strict";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { releasePackagedPins } from "./packaged-processes.mjs";
import { pinnedProcessIdentity } from "./packaged-protocol.mjs";

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

test("PID query failures and mismatches precede any identity query", () => {
  for (const actualPid of [0, 12345]) {
    let queried = false;
    const native = { pid: () => actualPid, identity() { queried = true; throw new Error("Generic identity failure"); } };
    const message = actualPid === 0 ? "GetProcessId returned zero for expected PID 59400; possible handle-lifetime race"
      : `Measured process PID mismatch; possible handle-lifetime race: expected 59400, got ${actualPid}`;
    assert.throws(() => pinnedProcessIdentity(native, "duplicate", 59400), { message });
    assert.equal(queried, false);
  }
});

test("a matching PID cannot hide a failed identity query", () => {
  const cause = new Error("QueryFullProcessImageNameW failed (31)");
  const native = { pid: () => 59400, identity() { throw cause; } };
  assert.throws(() => pinnedProcessIdentity(native, "duplicate", 59400), (error) => error === cause);
});
