import assert from "node:assert/strict";
import { test } from "node:test";
import { cancellationObservation, packagedObservation, stdioObservation } from "./packaged-protocol.mjs";

const accounting = { exit: { code: 0, signal: null }, processDeathVerified: true,
  processObservations: [{ role: "container", signaled: true }] };

test("the cancellation row keeps its caller name and separately records the error name", () => {
  const frame = { name: "MxcProcessContractError", pending: true };
  const observation = cancellationObservation(frame, accounting);
  const row = packagedObservation("cancel-during-native-spawn", observation);
  assert.equal(row.name, "cancel-during-native-spawn");
  assert.equal(row.errorName, "MxcProcessContractError");
  assert.equal(row.passed, true);
  assert.equal(Object.hasOwn(observation, "name"), false);
});

test("row identity wins over spread fields and row verdict cannot impersonate the controller", () => {
  const fields = { name: "frame-name", verdict: "measured", passed: false };
  assert.deepEqual(packagedObservation("owned-row", fields), { name: "owned-row", passed: false });
  assert.deepEqual(fields, { name: "frame-name", verdict: "measured", passed: false });
});

test("spread frame fields cannot force a passing cancellation or stdio verdict", () => {
  const injected = { name: "frame-name", passed: true, verdict: "measured" };
  const cancel = packagedObservation("cancel-during-native-spawn", cancellationObservation({ ...injected, pending: true }, accounting));
  const stdio = packagedObservation("packaged-stdio-bytes-eof", stdioObservation(injected));
  for (const row of [cancel, stdio]) {
    assert.equal(row.passed, false);
    assert.equal(Object.hasOwn(row, "verdict"), false);
  }
  assert.equal(cancel.name, "cancel-during-native-spawn");
  assert.equal(stdio.name, "packaged-stdio-bytes-eof");
});
