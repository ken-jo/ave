import { afterEach, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wrapCommandWithSandboxLinux, cleanupBwrapMountPoints } from "@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { buildSandboxConfig } from "../asrt-sandbox.js";
import { hardenLinuxSandboxWrap } from "../linux-sandbox-wrap.js";

const priorAveHome = process.env.AVE_HOME;
const temporaryRoots: string[] = [];

afterEach(async () => {
  if (priorAveHome === undefined) delete process.env.AVE_HOME;
  else process.env.AVE_HOME = priorAveHome;
  for (const root of temporaryRoots.splice(0)) await cleanupTmpDir(root);
});

it.runIf(process.platform !== "win32")("makes the generated Linux secrets mask read-only while preserving a nested write mount", async () => {
  const root = mkdtempSync(join(tmpdir(), "ave-floor-"));
  temporaryRoots.push(root);
  const aveHome = join(root, "host's home");
  const secrets = join(aveHome, "secrets");
  const pluginData = join(aveHome, "plugins", "example", "data");
  mkdirSync(secrets, { recursive: true });
  mkdirSync(pluginData, { recursive: true });
  writeFileSync(join(secrets, "key.txt"), "host secret");
  const mountedSecrets = realpathSync(secrets);
  const mountedPluginData = realpathSync(pluginData);
  process.env.AVE_HOME = aveHome;

  const config = buildSandboxConfig({ allowedDomains: [] });
  expect(config.filesystem.denyRead).toContain(secrets);
  expect(config.filesystem.denyWrite).toContain(secrets);

  const generated = await wrapCommandWithSandboxLinux({
    command: "printf 'plugin command'",
    needsNetworkRestriction: false,
    readConfig: { denyOnly: [secrets, aveHome], allowWithinDeny: [pluginData] },
    writeConfig: { allowOnly: [pluginData], denyWithinAllow: [secrets] },
    allowAllUnixSockets: true,
  });
  try {
    const wrapped = hardenLinuxSandboxWrap({
      argv: ["/bin/bash", "-c", generated],
      env: {},
    });
    // Ask a shell to parse the generated command as data; never execute bwrap.
    const words = execFileSync("/bin/bash", ["-c", `set -- ${wrapped.argv[2]}; printf '%s\\n' "$@"`], {
      encoding: "utf8",
    }).trimEnd().split("\n");
    const mask = words.findIndex((word, index) => word === "--tmpfs" && words[index + 1] === mountedSecrets);
    const remount = words.findIndex((word, index) => word === "--remount-ro" && words[index + 1] === mountedSecrets);
    const nestedWrite = words.findIndex((word, index) => word === "--bind" && words[index + 2] === mountedPluginData);
    const command = words.lastIndexOf("--");
    expect(mask).toBeGreaterThan(0);
    expect(remount).toBeGreaterThan(mask);
    expect(remount).toBeGreaterThan(nestedWrite);
    expect(command).toBeGreaterThan(remount);
    expect(words[command + 1]).toMatch(/\/bash$/);
    expect(words[command + 2]).toBe("-c");
    expect(words.at(-1)).toContain("plugin command");
  } finally {
    cleanupBwrapMountPoints();
  }
});

it("refuses a wrapper whose mount options cannot be located", () => {
  expect(() => hardenLinuxSandboxWrap({ argv: ["/bin/bash", "-c", "printf unconfined"], env: {} }))
    .toThrow(/bubblewrap/);
});
