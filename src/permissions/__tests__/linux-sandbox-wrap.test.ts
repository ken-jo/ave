import { afterEach, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { wrapCommandWithSandboxLinux, cleanupBwrapMountPoints } from "@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { buildSandboxConfig, getBuiltinShellReadPolicy } from "../asrt-sandbox.js";
import { hardenLinuxSandboxWrap } from "../linux-sandbox-wrap.js";
import { shellQuote } from "../../lib/shell-resolver.js";
import { deriveSandboxWritePaths } from "../sandbox-write-jail.js";

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

it.runIf(process.platform !== "win32")("keeps a generated same-path workspace write bind over its read mask", async () => {
  const root = mkdtempSync(join(tmpdir(), "ave-floor-workspace-"));
  temporaryRoots.push(root);
  const homePath = join(root, "approved home");
  mkdirSync(homePath, { recursive: true });
  const home = realpathSync(homePath);
  const read = getBuiltinShellReadPolicy([home], home);
  const write = deriveSandboxWritePaths({ allowedDirectories: [home] });
  expect(read.allowRead).toContain(home);
  expect(read.denyRead).toContain(home);
  expect(write).toContain(home);

  const generated = await wrapCommandWithSandboxLinux({
    command: "printf 'workspace command'",
    needsNetworkRestriction: false,
    readConfig: { denyOnly: [...read.denyRead], allowWithinDeny: [...read.allowRead] },
    writeConfig: { allowOnly: write, denyWithinAllow: [] },
    allowAllUnixSockets: true,
  });
  try {
    const wrapped = hardenLinuxSandboxWrap({ argv: ["/bin/bash", "-c", generated], env: {} });
    const words = execFileSync("/bin/bash", ["-c", `set -- ${wrapped.argv[2]}; printf '%s\\n' "$@"`], {
      encoding: "utf8",
    }).trimEnd().split("\n");
    const mask = words.findIndex((word, index) => word === "--tmpfs" && words[index + 1] === home);
    const writeBind = words.findLastIndex((word, index) => word === "--bind" && words[index + 1] === home && words[index + 2] === home);
    expect(mask).toBeGreaterThan(0);
    expect(writeBind).toBeGreaterThan(mask);
    expect(words.some((word, index) => word === "--remount-ro" && words[index + 1] === home)).toBe(false);
  } finally {
    cleanupBwrapMountPoints();
  }
});

it.skipIf(process.platform === "win32").each([
  "alias before real path",
  "nested alias",
])("tracks generated mounts by filesystem identity: %s", async (arrangement) => {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "ave-floor-alias-")));
    temporaryRoots.push(root);
    const actual = join(root, "actual");
    const alias = join(root, "alias");
    const nested = arrangement === "nested alias";
    const realParent = nested ? join(actual, "nested") : actual;
    const realWork = join(realParent, "work");
    const realSecrets = join(realParent, "secrets");
    const pluginData = join(root, "plugin-data");
    mkdirSync(realWork, { recursive: true });
    mkdirSync(realSecrets);
    mkdirSync(pluginData);
    symlinkSync(actual, alias, "dir");
    if (nested) symlinkSync(realParent, join(actual, "nested-alias"), "dir");
    const aliasParent = nested ? join(alias, "nested-alias") : alias;
    const aliasWork = join(aliasParent, "work");
    const aliasSecrets = join(aliasParent, "secrets");
    const masks = [aliasWork, realWork];
    const write = realWork;

    const generated = await wrapCommandWithSandboxLinux({
      command: "printf 'workspace command'",
      needsNetworkRestriction: false,
      readConfig: { denyOnly: masks, allowWithinDeny: [write] },
      writeConfig: { allowOnly: [write], denyWithinAllow: [] },
      allowAllUnixSockets: true,
    });
    try {
      const wrapped = hardenLinuxSandboxWrap({ argv: ["/bin/bash", "-c", generated], env: {} });
      const words = execFileSync("/bin/bash", ["-c", `set -- ${wrapped.argv[2]}; printf '%s\\n' "$@"`], {
        encoding: "utf8",
      }).trimEnd().split("\n");
      for (const mask of masks) {
        expect(words.some((word, index) => word === "--tmpfs" && words[index + 1] === mask)).toBe(true);
      }
      const lastMask = words.findLastIndex((word, index) => word === "--tmpfs" && masks.includes(words[index + 1]));
      const writeBind = words.findLastIndex((word, index) => word === "--bind" && words[index + 2] === write);
      expect(writeBind).toBeGreaterThan(lastMask);
      expect(words.some((word, index) => word === "--remount-ro" && masks.includes(words[index + 1]))).toBe(false);
    } finally {
      cleanupBwrapMountPoints();
    }

    const secrets = [aliasSecrets, realSecrets];
    const secretCommand = await wrapCommandWithSandboxLinux({
      command: "printf 'secret command'",
      needsNetworkRestriction: false,
      readConfig: { denyOnly: secrets, allowWithinDeny: [pluginData] },
      writeConfig: { allowOnly: [pluginData], denyWithinAllow: secrets },
      allowAllUnixSockets: true,
    });
    try {
      const wrapped = hardenLinuxSandboxWrap({ argv: ["/bin/bash", "-c", secretCommand], env: {} });
      const words = execFileSync("/bin/bash", ["-c", `set -- ${wrapped.argv[2]}; printf '%s\\n' "$@"`], {
        encoding: "utf8",
      }).trimEnd().split("\n");
      expect(words.some((word, index) => word === "--remount-ro" && secrets.includes(words[index + 1]))).toBe(true);
    } finally {
      cleanupBwrapMountPoints();
    }
});

it.runIf(process.platform !== "win32")("preserves a same-path write bind through reverse alias order", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ave-floor-reverse-alias-")));
  temporaryRoots.push(root);
  const real = join(root, "actual", "work");
  const alias = join(root, "alias", "work");
  mkdirSync(real, { recursive: true });
  symlinkSync(join(root, "actual"), join(root, "alias"), "dir");
  const command = `bwrap --ro-bind / / --tmpfs '${real}' --tmpfs '${alias}' --bind '${alias}' '${alias}' -- /bin/sh -c 'true'`;
  const wrapped = hardenLinuxSandboxWrap({ argv: ["/bin/bash", "-c", command], env: {} });
  expect(wrapped.argv[2]).not.toContain("--remount-ro");

  const realSecrets = join(root, "actual", "secrets");
  const aliasSecrets = join(root, "alias", "secrets");
  mkdirSync(realSecrets);
  const secretsCommand = `bwrap --ro-bind / / --tmpfs '${realSecrets}' --tmpfs '${aliasSecrets}' -- /bin/sh -c 'true'`;
  const secretsWrapped = hardenLinuxSandboxWrap({ argv: ["/bin/bash", "-c", secretsCommand], env: {} });
  expect(secretsWrapped.argv[2]).toContain(`'--remount-ro' '${aliasSecrets}'`);
});

it.runIf(process.platform !== "win32")("refuses a mount whose alias identity cannot be established", () => {
  const root = mkdtempSync(join(tmpdir(), "ave-floor-dangling-"));
  temporaryRoots.push(root);
  const dangling = join(root, "dangling");
  symlinkSync(join(root, "missing"), dangling, "dir");
  expect(() => hardenLinuxSandboxWrap({
    argv: ["/bin/bash", "-c", `bwrap --tmpfs '${join(dangling, "work")}' -- /bin/sh -c 'true'`],
    env: {},
  })).toThrow(/identity/);
});

it("remounts a mask that is the final mount at its target", () => {
  const command = "bwrap --tmpfs /tmp/example --bind /tmp/example /tmp/example --tmpfs /tmp/example -- /bin/sh -c 'true'";
  const wrapped = hardenLinuxSandboxWrap({ argv: ["/bin/bash", "-c", command], env: {} });
  expect(wrapped.argv[2]).toContain("'--remount-ro' '/tmp/example' --");
});

it("refuses a wrapper whose mount options cannot be located", () => {
  expect(() => hardenLinuxSandboxWrap({ argv: ["/bin/bash", "-c", "printf unconfined"], env: {} }))
    .toThrow(/bubblewrap/);
});

it.each([
  "--args 9",
  "--overlay-src /tmp/example",
  "--tmpfs=/tmp/example",
  "--new-session=1",
  "--bind /tmp/other /tmp/example",
])("refuses an unsupported wrapper option form: %s", (option) => {
  expect(() => hardenLinuxSandboxWrap({
    argv: ["/bin/bash", "-c", `bwrap ${option} -- /bin/sh -c 'true'`],
    env: {},
  })).toThrow(/unsupported/);
});

/**
 * A plugin installed where its data lives: the plugins root is read-denied, the
 * plugin's root is a read re-allow inside it, and its data directory — inside
 * that root — is a write root. ASRT binds the write first and the read re-allow
 * after it, so the read-only bind of the parent covers the writable one.
 */
function pluginRootHoldingData() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ave-floor-plugin-")));
  temporaryRoots.push(root);
  const plugins = join(root, "plugins");
  const pluginRoot = join(plugins, "example");
  const pluginData = join(pluginRoot, "data");
  mkdirSync(pluginData, { recursive: true });
  mkdirSync(join(plugins, "neighbour", "data"), { recursive: true });
  return { plugins, pluginRoot, pluginData };
}

/** The last mount whose target is `path` or one of its ancestors: what the child sees there. */
function finalMountCovering(words: readonly string[], path: string): readonly string[] | undefined {
  let found: readonly string[] | undefined;
  for (let index = 0; index < words.length && words[index] !== "--"; index++) {
    const option = words[index];
    const arity = option === "--bind" || option === "--ro-bind" ? 2 : option === "--tmpfs" || option === "--remount-ro" ? 1 : 0;
    const target = words[index + arity];
    if (arity > 0 && option !== "--remount-ro" && (path === target || path.startsWith(`${target}/`))) {
      found = words.slice(index, index + arity + 1);
    }
  }
  return found;
}

it.runIf(process.platform !== "win32")(
  "binds a write root again after a read re-allow of the directory that holds it",
  async () => {
    const { plugins, pluginRoot, pluginData } = pluginRootHoldingData();
    const generated = await wrapCommandWithSandboxLinux({
      command: "printf 'plugin command'",
      needsNetworkRestriction: false,
      readConfig: { denyOnly: [plugins], allowWithinDeny: [pluginRoot, pluginData] },
      writeConfig: { allowOnly: [pluginData], denyWithinAllow: [] },
      allowAllUnixSockets: true,
    });
    try {
      const parse = (command: string) => execFileSync("/bin/bash", ["-c", `set -- ${command}; printf '%s\\n' "$@"`], {
        encoding: "utf8",
      }).trimEnd().split("\n");
      // What ASRT emits on its own: the parent's read-only bind is the last
      // mount over the data directory.
      const unhardened = parse(hardenLinuxSandboxWrap({ argv: ["/bin/bash", "-c", generated], env: {} }).argv[2]!);
      expect(finalMountCovering(unhardened, pluginData)).toEqual(["--ro-bind", pluginRoot, pluginRoot]);
      // Told which reads are re-allows, the hardener puts the write back on top.
      const words = parse(
        hardenLinuxSandboxWrap(
          { argv: ["/bin/bash", "-c", generated], env: {} },
          { allowRead: [pluginRoot, pluginData], denyWrite: [] },
        ).argv[2]!,
      );
      expect(finalMountCovering(words, pluginData)).toEqual(["--bind", pluginData, pluginData]);
      expect(finalMountCovering(words, join(pluginRoot, "plugin.json"))).toEqual(["--ro-bind", pluginRoot, pluginRoot]);
      // The rest of the plugins root stays masked, read-only.
      expect(finalMountCovering(words, join(plugins, "neighbour", "data"))).toEqual(["--tmpfs", plugins]);
      expect(words.some((word, index) => word === "--remount-ro" && words[index + 1] === plugins)).toBe(true);
      expect(words.at(-1)).toContain("plugin command");
    } finally {
      cleanupBwrapMountPoints();
    }
  },
);

it.runIf(process.platform !== "win32")("does not put back a write root that one of the wrap's write denies covers", () => {
  const { plugins, pluginRoot, pluginData } = pluginRootHoldingData();
  const command = `bwrap --ro-bind / / --bind '${pluginData}' '${pluginData}' --tmpfs '${plugins}' `
    + `--bind '${pluginData}' '${pluginData}' --ro-bind '${pluginRoot}' '${pluginRoot}' -- /bin/sh -c 'true'`;
  const replayed = hardenLinuxSandboxWrap(
    { argv: ["/bin/bash", "-c", command], env: {} },
    { allowRead: [pluginRoot], denyWrite: [] },
  );
  expect(replayed.argv[2]).toMatch(new RegExp(`'--ro-bind' '${pluginRoot}' '${pluginRoot}' '--bind' '${pluginData}' '${pluginData}'`));
  const denied = hardenLinuxSandboxWrap(
    { argv: ["/bin/bash", "-c", command], env: {} },
    { allowRead: [pluginRoot], denyWrite: [pluginRoot] },
  );
  expect(denied.argv[2]).not.toMatch(new RegExp(`'${pluginRoot}' '${pluginRoot}' '--bind'`));
  // A read-only bind that is not one of the wrap's re-allows is not a re-allow.
  const notReallowed = hardenLinuxSandboxWrap({ argv: ["/bin/bash", "-c", command], env: {} }, { allowRead: [pluginData] });
  expect(notReallowed.argv[2]).not.toMatch(new RegExp(`'${pluginRoot}' '${pluginRoot}' '--bind'`));
});

it.runIf(process.platform !== "win32").each(["", "--bind /tmp/claude /tmp/claude", "--ro-bind /tmp/claude /tmp/claude", "--ro-bind /dev/null /tmp/claude"])("masks the shared temporary root without a host source: %s", (priorMount) => {
  const before = lstatSync("/tmp/claude", { throwIfNoEntry: false });
  const wrapped = hardenLinuxSandboxWrap({ argv: ["/bin/bash", "-c", `bwrap --ro-bind / / --bind /tmp /tmp ${priorMount} -- /bin/sh -c 'true'`], env: {} }, { denySharedTempRoot: true });
  const words = execFileSync("/bin/bash", ["-c", `set -- ${wrapped.argv[2].split("\n# Run the confined command\n").at(-1)!.split("\naveTmpStatus=")[0]}; printf '%s\\n' "$@"`], { encoding: "utf8" }).trimEnd().split("\n");
  expect(words.some((word, index) => word === "--tmpfs" && words[index + 1] === "/tmp")).toBe(true);
  expect(words.some((word, index) => word === "--tmpfs" && words[index + 1] === "/tmp/claude")).toBe(true);
  expect(words.some((word, index) => word === "--remount-ro" && words[index + 1] === "/tmp/claude")).toBe(true);
  expect(words.some((word, index) => ["--bind", "--bind-try", "--ro-bind", "--ro-bind-try"].includes(word) && ["/tmp/claude"].includes(words[index + 1]!))).toBe(false);
  expect(words.some((word, index) => word === "--bind" && words[index + 1] === "/tmp" && words[index + 2] === "/tmp")).toBe(false);
  expect(lstatSync("/tmp/claude", { throwIfNoEntry: false })?.ino).toBe(before?.ino);
});

it.runIf(process.platform === "linux").each([false, true])("refuses a replaced source before startup hooks and workload code: %s", (startupHook) => {
  const root = mkdtempSync(join(tmpdir(), "ave-tmp-source-"));
  const target = mkdtempSync(join(tmpdir(), "ave-tmp-target-'\n$(echo unsafe)-"));
  const moved = `${root}-moved`;
  temporaryRoots.push(root, target, moved);
  const launcher = join(root, "bwrap");
  writeFileSync(join(target, "startup"), "echo startup-ran\n");
  writeFileSync(launcher, [
    "#!/bin/bash",
    `mv -- ${shellQuote(root)} ${shellQuote(moved)}`,
    `ln -s -- ${shellQuote(target)} ${shellQuote(root)}`,
    'exec /usr/bin/bwrap "$@"',
    "",
  ].join("\n"), { mode: 0o755 });
  const wrapped = hardenLinuxSandboxWrap({
    argv: ["/bin/bash", "-c", `${shellQuote(launcher)} --unshare-user --unshare-pid --ro-bind / / --bind /tmp /tmp --dev /dev --proc /proc -- /bin/sh -c 'echo workload-ran'`],
    env: startupHook ? { BASH_ENV: join(root, "startup") } : {},
  }, { denySharedTempRoot: true });
  const result = spawnSync(wrapped.argv[0], wrapped.argv.slice(1), { encoding: "utf8", env: { ...process.env, ...wrapped.env } });
  expect(result.status, result.stderr).toBe(126);
  expect(result.stderr).toContain("Sandbox temporary mount changed");
  expect(result.stdout).not.toContain("workload-ran");
  expect(result.stdout).not.toContain("startup-ran");
});
