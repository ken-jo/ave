import { afterEach, expect, it } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, lchownSync, lstatSync, mkdirSync, mkdtempSync, readlinkSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { capabilityArgs, wrapCommandWithSandboxLinux, cleanupBwrapMountPoints } from "@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js";
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

  const filesystem = { allowRead: [pluginData], denyWrite: [secrets] };
  const generated = await wrapCommandWithSandboxLinux({
    command: "printf 'plugin command'",
    needsNetworkRestriction: false,
    readConfig: { denyOnly: [secrets, aveHome], allowWithinDeny: filesystem.allowRead },
    writeConfig: { allowOnly: [pluginData], denyWithinAllow: filesystem.denyWrite },
    allowAllUnixSockets: true,
  });
  try {
    const wrapped = hardenLinuxSandboxWrap({
      argv: ["/bin/bash", "-c", generated],
      env: {},
    }, filesystem);
    // Ask a shell to parse the generated command as data; never execute bwrap.
    const words = execFileSync("/bin/bash", ["-c", `set -- ${wrapped.argv[2]}; printf '%s\\n' "$@"`], {
      encoding: "utf8",
    }).trimEnd().split("\n");
    // A nested deny may share its ancestor's mask. Check the final covering
    // mount, so a later bind exposing secrets cannot satisfy this assertion.
    const coveringMask = finalMountCovering(words, mountedSecrets);
    expect(coveringMask?.[0]).toBe("--tmpfs");
    const covering = coveringMask?.[1];
    const mask = words.findIndex((word, index) => word === "--tmpfs" && words[index + 1] === covering);
    const remount = words.findIndex((word, index) => word === "--remount-ro" && words[index + 1] === covering);
    const nestedWrite = words.findLastIndex((word, index) => word === "--bind" && words[index + 1] === mountedPluginData && words[index + 2] === mountedPluginData);
    const command = words.lastIndexOf("--");
    expect(mask).toBeGreaterThan(0);
    expect(remount).toBeGreaterThan(mask);
    expect(remount).toBeGreaterThan(nestedWrite);
    expect(nestedWrite).toBeGreaterThan(mask);
    expect(finalMountCovering(words, mountedPluginData)).toEqual(["--bind", mountedPluginData, mountedPluginData]);
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
  expect(read.denyRead).not.toContain(home);
  expect(write).toContain(home);

  const generated = await wrapCommandWithSandboxLinux({
    command: "printf 'workspace command'",
    needsNetworkRestriction: false,
    // Broad shell reads do not mask HOME. Keep an explicit mask here to test
    // that a same-path write grant still replaces a configured read mask.
    readConfig: { denyOnly: [...read.denyRead, home], allowWithinDeny: [...read.allowRead] },
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
      // Both names resolve to one mount target; the runtime emits one mask.
      const maskIdentities = new Set(masks.map((mask) => realpathSync(mask)));
      const isMask = (target: string | undefined) => target !== undefined && maskIdentities.has(realpathSync(target));
      const emittedMaskIdentities = new Set(words.flatMap((word, index) =>
        word === "--tmpfs" && isMask(words[index + 1]) ? [realpathSync(words[index + 1]!)] : []));
      expect(emittedMaskIdentities).toEqual(maskIdentities);
      const lastMask = words.findLastIndex((word, index) => word === "--tmpfs" && isMask(words[index + 1]));
      const writeBind = words.findLastIndex((word, index) => word === "--bind" && words[index + 2] === write);
      expect(writeBind).toBeGreaterThan(lastMask);
      expect(words.some((word, index) => word === "--remount-ro" && isMask(words[index + 1]))).toBe(false);
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
      const secretIdentities = new Set(secrets.map((secret) => realpathSync(secret)));
      expect(words.some((word, index) => word === "--remount-ro" && secretIdentities.has(realpathSync(words[index + 1]!)))).toBe(true);
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

it.runIf(process.platform !== "win32")("leaves an explicitly granted host temp bind unchanged", () => {
  const wrapped = { argv: ["/bin/bash", "-c", "bwrap --ro-bind / / --bind /tmp /tmp -- /bin/sh -c 'true'"], env: {} };
  expect(hardenLinuxSandboxWrap(wrapped)).toBe(wrapped);
});

it.runIf(process.platform !== "win32").each(["directory", "file", "symlink"])("preserves an existing shared temp leaf: %s", (kind) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ave-temp-leaf-")));
  temporaryRoots.push(root);
  const shared = join(root, "shared");
  const leaf = join(shared, "entry");
  mkdirSync(shared);
  if (kind === "directory") mkdirSync(leaf);
  else if (kind === "file") writeFileSync(leaf, "existing file");
  else symlinkSync(root, leaf, "dir");
  if (process.getuid?.() === 0) lchownSync(leaf, 65534, 65534);
  const before = lstatSync(leaf);
  const link = kind === "symlink" ? readlinkSync(leaf) : undefined;
  const wrapped = {
    argv: ["/bin/bash", "-c", `bwrap --ro-bind / / --bind /tmp /tmp --bind ${shellQuote(shared)} ${shellQuote(shared)} -- /bin/sh -c 'true'`],
    env: {},
  };
  expect(hardenLinuxSandboxWrap(wrapped)).toBe(wrapped);
  const after = lstatSync(leaf);
  expect({ inode: after.ino, uid: after.uid, gid: after.gid, mode: after.mode }).toEqual({
    inode: before.ino, uid: before.uid, gid: before.gid, mode: before.mode,
  });
  if (kind === "symlink") expect(readlinkSync(leaf)).toBe(link);
});

async function wrapSharedTempCommand(command: string) {
  const generated = await wrapCommandWithSandboxLinux({
    command,
    needsNetworkRestriction: false,
    readConfig: { denyOnly: [], allowWithinDeny: [] },
    writeConfig: { allowOnly: ["/tmp"], denyWithinAllow: [] },
    allowAllUnixSockets: true,
  });
  return hardenLinuxSandboxWrap({ argv: ["/bin/bash", "-c", generated], env: {} });
}

it.runIf(process.platform !== "win32")("accepts a generated shared temp wrapper with quoted command operands", async () => {
  const command = "printf 'shared bytes' > '/tmp/shared file'";
  try {
    const wrapped = await wrapSharedTempCommand(command);
    const words = execFileSync("/bin/bash", ["-c", `set -- ${wrapped.argv[2]}; printf '%s\\n' "$@"`], {
      encoding: "utf8",
    }).trimEnd().split("\n");
    expect(words.at(-1)).toBe(command);
  } finally {
    cleanupBwrapMountPoints();
  }
});

it.runIf(process.platform === "linux")("shares newly created temp entries with the host and the next sandbox", async () => {
  const root = mkdtempSync(join(tmpdir(), "ave-shared-temp-"));
  temporaryRoots.push(root);
  const target = join(tmpdir(), `${root.split("/").at(-1)}-new`);
  temporaryRoots.push(target);
  const run = async (command: string) => {
    try {
      const wrapped = await wrapSharedTempCommand(command);
      return spawnSync(wrapped.argv[0], wrapped.argv.slice(1), { encoding: "utf8", env: process.env });
    } finally {
      cleanupBwrapMountPoints();
    }
  };
  const first = await run(`printf shared > ${shellQuote(target)}`);
  expect(first.status, first.stderr).toBe(0);
  expect(execFileSync("cat", [target], { encoding: "utf8" })).toBe("shared");
  const second = await run(`cat ${shellQuote(target)}`);
  expect(second.status, second.stderr).toBe(0);
  expect(second.stdout).toBe("shared");
  writeFileSync(target, "host update");
  const third = await run(`cat ${shellQuote(target)}`);
  expect(third.status, third.stderr).toBe(0);
  expect(third.stdout).toBe("host update");
});


it.runIf(process.platform !== "win32")("accepts a generated namespace-limiting worker wrapper", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ave-userns-option-")));
  temporaryRoots.push(root);
  const bwrap = join(root, "bwrap");
  const workspace = join(root, "workspace");
  mkdirSync(workspace);
  writeFileSync(bwrap, "#!/bin/sh\necho 'usage: bwrap [OPTIONS...] [--] COMMAND\n    --disable-userns  Disable further use of user namespaces'\n");
  chmodSync(bwrap, 0o755);
  const generated = await wrapCommandWithSandboxLinux({
    command: "printf worker-ready", needsNetworkRestriction: false,
    readConfig: { denyOnly: [root], allowWithinDeny: [workspace] },
    writeConfig: { allowOnly: [workspace], denyWithinAllow: [] },
    allowAllUnixSockets: true, bwrapPath: bwrap,
  });
  try {
    expect(generated).toMatch(/(^|\s)'?--disable-userns'?(\s|$)/u);
    for (const filesystem of [{}, { allowRead: [workspace], denyWrite: [] }]) {
      const hardened = hardenLinuxSandboxWrap({ argv: ["/bin/bash", "-c", generated], env: {} }, filesystem);
      expect(hardened.argv[2]).toContain("--disable-userns");
    }
  } finally {
    cleanupBwrapMountPoints();
  }
});

it("accepts only the pinned root-user capability mapping sequence", () => {
  const capabilities = capabilityArgs({ euid: 0, hasSetfcap: true, usesSeccompHelper: true });
  expect(capabilities).toEqual(["--cap-drop", "ALL", "--cap-add", "CAP_SETFCAP"]);
  const command = `bwrap --unshare-user ${capabilities.join(" ")} --ro-bind / / -- /bin/sh -c 'true'`;
  for (const filesystem of [{}, { allowRead: ["/tmp"] }]) {
    expect(() => hardenLinuxSandboxWrap({ argv: ["/bin/bash", "-c", command], env: {} }, filesystem)).not.toThrow();
  }
});

it.each(["CAP_SYS_ADMIN", "ALL"])("refuses a broader capability addition: %s", (capability) => {
  const command = `bwrap --unshare-user --cap-drop ALL --cap-add ${capability} -- /bin/sh -c 'true'`;
  for (const filesystem of [{}, { allowRead: ["/tmp"] }]) {
    expect(() => hardenLinuxSandboxWrap({ argv: ["/bin/bash", "-c", command], env: {} }, filesystem)).toThrow(/unsupported capability/u);
  }
});

it.each([
  "--cap-drop ALL --cap-add CAP_SETFCAP",
  "--unshare-user --cap-add CAP_SETFCAP",
])("refuses capability restoration without its confinement preconditions: %s", (options) => {
  const command = `bwrap ${options} -- /bin/sh -c 'true'`;
  expect(() => hardenLinuxSandboxWrap({ argv: ["/bin/bash", "-c", command], env: {} })).toThrow(/requires an isolated user namespace and dropped capabilities/u);
});
