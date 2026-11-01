import assert from "node:assert/strict";
import { test } from "node:test";
import { assertEnumerationSupport, buildProbeFilesystem, filesystemObservation, recordFilesystemObservation } from "./filesystem-policy.mjs";

const TEMP = "D:\\cc-verify\\mxc\\mxc-run-tmp\\ave-mxc-probes-fixture";
const RUNTIME = "C:\\staged-app\\electron.exe";

test("entry resolution gets ancestor query access without drive-root file reads", () => {
  const policy = buildProbeFilesystem(RUNTIME, TEMP, "C:\\Windows");
  assert.deepEqual(policy.enumeratePaths, ["D:\\cc-verify\\mxc\\mxc-run-tmp", "D:\\cc-verify\\mxc", "D:\\cc-verify", "D:\\", "C:\\"]);
  assert.deepEqual(policy.filesystem.readwritePaths, [TEMP]);
  assert.deepEqual(policy.filesystem.readonlyPaths, ["C:\\staged-app", "C:\\Windows"]);
  assert.ok(!policy.filesystem.readonlyPaths.some((entry) => /^[a-z]:\\$/i.test(entry)));
  assert.deepEqual(filesystemObservation(policy, "script-file"), {
    ancestorAccess: "query-enumerate-only", enumeratePaths: policy.enumeratePaths, driveRootRead: false, entryVariant: "script-file",
  });
});

test("shared ancestors are deduplicated and admitted subtrees are not redundantly enumerated", () => {
  const policy = buildProbeFilesystem("D:\\cc-verify\\runtime\\electron.exe", TEMP, "C:\\Windows", ["D:\\cc-verify"]);
  assert.deepEqual(policy.enumeratePaths, ["D:\\", "C:\\"]);
});

test("runtime/data/system-root inputs cannot silently turn into broad root grants", () => {
  assert.throws(() => buildProbeFilesystem("D:\\electron.exe", TEMP, "C:\\Windows"), /drive-root/);
  assert.throws(() => buildProbeFilesystem(RUNTIME, "D:\\", "C:\\Windows"), /drive-root/);
  assert.throws(() => buildProbeFilesystem(RUNTIME, TEMP, "C:\\Windows", ["D:\\"]), /drive-root/);
  assert.throws(() => buildProbeFilesystem(RUNTIME, TEMP, "relative"), /absolute drive/);
});

test("missing enumeration support reports its prerequisite even when base-container is unavailable", () => {
  assert.throws(() => assertEnumerationSupport(["D:\\"], { tier: "unavailable", probes: {} }), /PSEC 1.1/);
  assert.throws(() => assertEnumerationSupport(["D:\\"], { tier: "base-container", probes: { baseContainerSupportsEnumeratePaths: false } }), /PSEC 1.1/);
  assert.doesNotThrow(() => assertEnumerationSupport(["D:\\"], { probes: { baseContainerSupportsEnumeratePaths: true } }));
  assert.doesNotThrow(() => assertEnumerationSupport([], {}));
});

test("observations describe actual script and native launches without a misleading mixed summary", () => {
  const observation = { filesystemPolicy: null, filesystemPolicies: [] };
  const script = recordFilesystemObservation(observation, ["D:\\"], "script-file");
  assert.deepEqual(observation.filesystemPolicy, script);
  recordFilesystemObservation(observation, ["D:\\"], "script-file");
  assert.equal(observation.filesystemPolicies.length, 1);
  const native = recordFilesystemObservation(observation, ["C:\\", "D:\\"], "native-command");
  assert.equal(observation.filesystemPolicy, null);
  assert.deepEqual(observation.filesystemPolicies, [script, native]);
  const kernel = {};
  recordFilesystemObservation(kernel, ["C:\\"], "native-command");
  assert.equal(kernel.filesystemPolicy.entryVariant, "native-command");
});
