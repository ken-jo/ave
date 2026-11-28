import assert from "node:assert/strict";
import test from "node:test";
import {
  HEADLESS_FORBIDDEN_INHERITED_ENV,
  headlessLaunchArgs,
  prepareHeadlessLaunchEnv,
} from "../../scripts/lib/headless-launch-options.mjs";

test("scrubs inherited module-loader and process-role inputs from native launches", () => {
  const env = {
    ELECTRON_NO_ASAR: "1",
    ELECTRON_RUN_AS_NODE: "1",
    NODE_CHANNEL_FD: "9",
    NODE_CHANNEL_SERIALIZATION_MODE: "advanced",
    NODE_OPTIONS: "--require=/untrusted/preload.cjs",
    NODE_PATH: "/untrusted/modules",
    NODE_UNIQUE_ID: "worker-role",
    AVE_HOME: "/preserved/ave-home",
  };

  assert.equal(prepareHeadlessLaunchEnv(env), env);
  for (const name of HEADLESS_FORBIDDEN_INHERITED_ENV) {
    assert.equal(env[name], undefined);
  }
  assert.equal(env.AVE_HOME, "/preserved/ave-home");
});

test("routes supported native command forms with their values intact", () => {
  for (const args of [
    ["--exec", "hello"], ["--exec=hello"],
    ["--set-secret", "llm.apiKey.openai"], ["--set-secret=llm.apiKey.openai"],
    ["--serve"], ["--runtime-check"], ["--exec=hello", "--exec-keep-alive"],
    ["--exec=hello", "--exec-operator-attestation=/run/ave/attestation.json"],
    ["--exec-operator-attestation=/run/ave/attestation.json"],
    [
      "--exec=hello",
      "--exec-workload-broker=/run/ave/workload.sock",
      "--exec-workload-capability=/run/ave/capability.json",
    ],
  ]) {
    assert.deepEqual(headlessLaunchArgs(args), args);
    assert.deepEqual(headlessLaunchArgs(["dist/src/main/main.js", ...args]), args);
  }
});

test("retired verification flags do not select a native command", () => {
  assert.equal(headlessLaunchArgs(["--verify-permission-audit=old"]), null);
  assert.equal(headlessLaunchArgs(["--create-permission-audit-self-test=old"]), null);
});
