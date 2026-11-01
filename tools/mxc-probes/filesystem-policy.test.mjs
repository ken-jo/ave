import assert from "node:assert/strict";
import { test } from "node:test";
import { buildProbeFilesystem, filesystemObservation } from "./filesystem-policy.mjs";

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
