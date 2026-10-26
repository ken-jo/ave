import { TEST_COMMAND_ID, TEST_WORKER_EGRESS_OWNER } from "../../__tests__/support/egress-fixture.js";
// Write and read grants must never reopen the protected deny floor. All wraps share this rule; private temp/HOME roots re-allow only their own process directory.
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import { configureHostResources } from "../../main/host-resources.js";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

beforeAll(() => configureHostResources({ resourcePath: resolve("resources"), isPackaged: false }));

import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { derivePluginChildEnvelope } from "../../plugins/isolation/out-of-process-plugin.js";
import { agentPluginDataRoot } from "../../marketplace/content/agent-plugin-data.js";
import {
  buildPerCommandSandboxCustomConfig,
  buildSandboxConfig,
  cleanupAsrtSandboxAfterCommand,
  ensureSandboxTempPrincipalDir,
  getDefaultSensitiveReadDenyPaths,
  getDefaultSensitiveWriteDenyPaths,
  initializeAsrtSandbox,
  isAsrtSandboxActive,
  protectedReadDenyCovering,
  resetAsrtSandbox,
  wrapToolCommand,
} from "../asrt-sandbox.js";
import { spawnConfinedChild } from "../confined-child.js";
import {
  __resetSandboxRequestedAtBootForTest,
  setPluginWorkerConfinementRequestedAtBoot,
} from "../sandbox-capability.js";
import { createSandboxProcessHome } from "../sandbox-process-home.js";
import { bundledWrappedEnv, wrapBundledCommand } from "../../sandbox/wrap-bundled-command.js";
import { getConfiguredSessionReadPolicy } from "../sensitive-paths.js";
import { asrtCanInitialize } from "./test-helpers.js";

vi.mock("node:os", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:os")>();
  return {
    ...original,
    userInfo: vi.fn(original.userInfo),
  };
});

const hostPlatform = process.platform;
const SECRET = "user-data-the-child-must-not-read";
const OWN_TEMP = "own-temp-written";
const OWN_HOME = "own-home-written";

describe("the shared layer withholds grants under the protected floor", () => {
  let root: string;
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "ave-protected-roots-")));
  });
  afterEach(() => {
    setProcessPlatform(hostPlatform);
    vi.unstubAllEnvs();
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function layout() {
    vi.stubEnv("HOME", root);
    // os.homedir reads USERPROFILE on Windows, so a HOME-only stub would leave the `.ssh` deny pointing at the real profile there.
    vi.stubEnv("USERPROFILE", root);
    vi.stubEnv("AVE_HOME", join(root, ".ave"));
    vi.stubEnv("XDG_CONFIG_HOME", join(root, "xdg"));
    const protectedRoots = [
      join(root, ".ave", "secrets", "work"),
      join(root, ".ave", "audit"),
      join(root, ".ave", "routine", "work"),
      join(root, ".ssh", "work"),
      // The Linux user data fallback, mirroring Electron's XDG resolution.
      join(root, "xdg", "Ave", "Partitions"),
    ];
    for (const path of protectedRoots) mkdirSync(path, { recursive: true });
    const ordinaryRoots = [
      join(root, "work"),
      join(root, ".ave", "plugins", "p", "data"),
      join(root, ".ave", "mcp", "s", "sandbox"),
    ];
    for (const path of ordinaryRoots) mkdirSync(path, { recursive: true });
    // The wrap's OWN private directories, under the private roots the floor it restates read-denies: they must survive the withholding.
    const ownTemp = ensureSandboxTempPrincipalDir({ kind: "plugin", id: "p" }).dir;
    const ownHome = createSandboxProcessHome();
    return { protectedRoots, ordinaryRoots: [...ordinaryRoots, ownTemp, ownHome.path], ownHome };
  }

  // The filesystem each wrap kind hands the wrap, by shape: the shell adds a whole-HOME read deny, plugin-owned code pins its roots, the terminal does neither.
  const wrapShapes = {
    shell: (paths: string[]) => ({
      allowWrite: paths, allowRead: paths, denyRead: [...getDefaultSensitiveReadDenyPaths(), root],
      denyWrite: getDefaultSensitiveWriteDenyPaths(),
    }),
    "plugin-owned": (paths: string[]) => ({
      allowWrite: paths, allowRead: paths, denyRead: getDefaultSensitiveReadDenyPaths(),
      denyWrite: getDefaultSensitiveWriteDenyPaths(), pinWriteRoots: true,
    }),
    terminal: (paths: string[]) => ({
      allowWrite: paths, allowRead: paths, denyRead: getDefaultSensitiveReadDenyPaths(),
      denyWrite: getDefaultSensitiveWriteDenyPaths(),
    }),
  };

  it.each(Object.keys(wrapShapes) as (keyof typeof wrapShapes)[])(
    "on Linux, a %s wrap's grants and the protected floor are disjoint, and its own temp and HOME survive",
    (shape) => {
      setProcessPlatform("linux");
      const { protectedRoots, ordinaryRoots, ownHome } = layout();
      const fs = buildPerCommandSandboxCustomConfig(wrapShapes[shape]([...protectedRoots, ...ordinaryRoots]))?.filesystem;
      expect(fs?.allowWrite).toEqual(ordinaryRoots);
      expect(fs?.allowRead).toEqual(ordinaryRoots);
      ownHome.cleanup();
    },
  );

  it("on Linux, the shared config's grants and the floor are disjoint", () => {
    setProcessPlatform("linux");
    const { protectedRoots, ordinaryRoots, ownHome } = layout();
    const config = buildSandboxConfig({
      allowWrite: [...protectedRoots, ...ordinaryRoots],
      allowRead: [...protectedRoots, ...ordinaryRoots],
    });
    expect(config.filesystem.allowWrite).toEqual(ordinaryRoots);
    expect(config.filesystem.allowRead).toEqual(ordinaryRoots);
    ownHome.cleanup();
  });

  it("on macOS, a write grant stays write-only and passes; a read grant under the floor does not", () => {
    setProcessPlatform("darwin");
    const { protectedRoots, ordinaryRoots, ownHome } = layout();
    const fs = buildPerCommandSandboxCustomConfig(wrapShapes.terminal([...protectedRoots, ...ordinaryRoots]))?.filesystem;
    expect(fs?.allowWrite).toEqual([...protectedRoots, ...ordinaryRoots]);
    // The XDG location is user data on Linux only.
    const xdgUserData = protectedRoots.at(-1)!;
    expect(fs?.allowRead).toEqual([xdgUserData, ...ordinaryRoots]);
    ownHome.cleanup();
  });

  it("names each withheld grant and the deny covering it, so a later EROFS or ENOENT has a cause", () => {
    setProcessPlatform("linux");
    const { protectedRoots, ownHome } = layout();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      buildPerCommandSandboxCustomConfig({ allowWrite: [protectedRoots[0]!], allowRead: [protectedRoots[0]!] });
      const deny = join(root, ".ave", "secrets");
      expect(log).toHaveBeenCalledWith(expect.stringContaining("write root withheld"), { path: protectedRoots[0], deny });
      expect(log).toHaveBeenCalledWith(expect.stringContaining("read grant withheld"), { path: protectedRoots[0], deny });
    } finally {
      log.mockRestore();
      ownHome.cleanup();
    }
  });

  it("keeps a read inside the floor only for the wrap that names it as its own pierce", () => {
    // The builtin shell's saved-session grant and a plugin's `certs` host directory are the two legitimate reads under the floor, and each is opened only for the wrap whose composer asks for it.
    const { ownHome } = layout();
    const certs = join(root, ".ave", "certs");
    const sessions = getConfiguredSessionReadPolicy().allowRead;
    expect(sessions).toHaveLength(1);
    const grants = [certs, join(certs, "corp"), ...sessions, join(root, ".ave", "secrets")];
    const readFor = (floorPierces?: string[]) => buildPerCommandSandboxCustomConfig({
      allowRead: grants, denyRead: getDefaultSensitiveReadDenyPaths(), ...(floorPierces ? { floorPierces } : {}),
    })?.filesystem?.allowRead;
    expect(readFor([...sessions]), "the shell").toEqual([...sessions]);
    expect(readFor([certs]), "a plugin that declared certs").toEqual([certs, join(certs, "corp")]);
    expect(readFor(), "a bundled hook or MCP stdio server").toEqual([]);
    expect(() => readFor([join(root, ".ave", "secrets")])).toThrow(/not a read the host lets re-open/);
    ownHome.cleanup();
  });

  it.each(["darwin", "linux"] as const)("on %s, only an exact regular hook file pierces its protected directory", (platform) => {
    setProcessPlatform(platform);
    const { ownHome } = layout();
    try {
      const hooks = join(root, ".config", "ave", "hooks");
      mkdirSync(hooks, { recursive: true });
      const script = join(hooks, "read-probe.cjs");
      const secret = join(root, ".ssh", "work", "private.cjs");
      writeFileSync(script, "process.exitCode = 0");
      writeFileSync(secret, SECRET);
      const grants = [script, hooks, secret];
      const readFor = (floorPierces?: string[]) => buildPerCommandSandboxCustomConfig({
        allowRead: grants, denyRead: getDefaultSensitiveReadDenyPaths(), floorPierces,
      })?.filesystem?.allowRead;
      expect(readFor()).toEqual([]);
      expect(readFor([script])).toEqual([script]);
      for (const refused of [hooks, secret, join(hooks, "missing.cjs")]) {
        expect(() => readFor([refused])).toThrow(/not a read the host lets re-open/);
      }
    } finally {
      ownHome.cleanup();
    }
  });

  it("every ASRT wrap and config change goes through the shared layer", () => {
    // A wrap that handed ASRT its own custom config, or a config change that skipped `buildSandboxConfig`, would skip the rule. Every mention of the identifiers in code — a call, a destructured or bound alias — is listed and compared with the legitimate sites. The Linux runtime probe passes no per-command config and runs under the shared one.
    const sourceRoot = join(__dirname, "..", "..");
    const sites: string[] = [];
    const visit = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "__tests__" && entry.name !== "node_modules") visit(path);
          continue;
        }
        if (!/\.(c|m)?tsx?$/.test(entry.name) || /\.test\.tsx?$/.test(entry.name)) continue;
        const code = readFileSync(path, "utf-8")
          .replace(/\/\*[\s\S]*?\*\//g, "")
          .replace(/(^|\s)\/\/.*$/gm, "$1");
        for (const match of code.matchAll(/\b(wrapWithSandbox\w*|updateConfig)\b/g)) {
          const rest = code.slice(match.index);
          const statement = rest.slice(0, rest.search(/;|$/) + 1).replace(/\s+/g, "").replace(/,\)/g, ")");
          sites.push(`${relative(sourceRoot, path).split(sep).join("/")}: ${statement}`);
        }
      }
    };
    visit(sourceRoot);
    expect(sites.sort()).toEqual([
      "permissions/asrt-sandbox.ts: updateConfig(buildSandboxConfig(withWorkerUnixSockets(_baseTrustedSettings),_baseReadDenyEvidence,snapshotWindowsLiveGrants(sandboxSession)));",
      "permissions/asrt-sandbox.ts: updateConfig(buildSandboxConfig(withWorkerUnixSockets(_baseTrustedSettings,socketDir),_baseReadDenyEvidence,snapshotWindowsLiveGrants(sandboxSession)));",
      "permissions/asrt-sandbox.ts: updateConfig(buildSandboxConfig(withWorkerUnixSockets(_baseTrustedSettings),_baseReadDenyEvidence,snapshotWindowsLiveGrants(session)));",
      "permissions/asrt-sandbox.ts: updateConfig(buildSandboxConfig(withWorkerUnixSockets(_baseTrustedSettings),_baseReadDenyEvidence,snapshotWindowsLiveGrants(session)));",
      "permissions/asrt-sandbox.ts: wrapWithSandboxArgv(ASRT_LINUX_RUNTIME_PROBE_COMMAND,undefined,undefined,abortController.signal,process.cwd(),{commandId:invocation.token,denyUnixSockets:true});",
      "permissions/asrt-sandbox.ts: wrapWithSandboxArgv(command,options.binShell,customConfig,options.abortSignal,undefined,{commandId:options.commandId,denyUnixSockets:options.denyUnixSockets});",
      "permissions/asrt-sandbox.ts: wrapWithSandboxArgv(command,options.binShell,customConfig,options.abortSignal,undefined,{...wrapOptions,commandId:options.commandId,denyUnixSockets:options.denyUnixSockets});",
    ].sort());
  });
});

// Against the real sandbox, with the user data directory somewhere the host guard's default-location globs do not reach — `--user-data-dir`, or XDG_CONFIG_HOME on Linux — and a trusted custom deny. Runs on macOS and on Linux with bubblewrap.
describe("the plugins root, refused to plugin-owned wraps", () => {
  let root: string;
  beforeAll(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), "ave-plugins-root-")));
  });
  afterEach(() => {
    setProcessPlatform(hostPlatform);
    vi.unstubAllEnvs();
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  function denyFor(platform: NodeJS.Platform) {
    vi.stubEnv("AVE_HOME", join(root, ".ave"));
    setProcessPlatform(platform);
    return buildPerCommandSandboxCustomConfig({
      allowRead: [join(root, ".ave", "plugins", "own")],
      denyRead: [],
      denyWrite: [],
      denyPluginsRoot: true,
    })?.filesystem?.denyRead;
  }

  it("adds every plugin-owned root to the wrap's read denies, spelled exactly on macOS so an allowed ancestor cannot re-emit it over the wrap's own", () => {
    const ave = join(root, ".ave");
    // The plugins root, and the two roots of agent plugins: their data and their installed versions.
    const roots = [join(ave, "plugins"), join(ave, "agent-plugin-data"), join(ave, "packages", "agent-plugin")];
    expect(denyFor("linux")).toEqual(roots);
    // The data root is the one the agent plugin runtimes write and uninstall removes.
    expect(agentPluginDataRoot()).toBe(roots[1]);
    expect(denyFor("darwin")).toEqual(roots.map((path) => `${path.slice(0, -1)}[${path.slice(-1)}]`));
  });

  it("creates each root before the wrap, since bubblewrap skips a deny on a path that is not there", () => {
    rmSync(join(root, ".ave"), { recursive: true, force: true });
    denyFor("linux");
    for (const path of [join(root, ".ave", "plugins"), join(root, ".ave", "agent-plugin-data"), join(root, ".ave", "packages", "agent-plugin")]) {
      expect(existsSync(path), path).toBe(true);
    }
  });

  it("adds nothing without the flag", () => {
    vi.stubEnv("AVE_HOME", join(root, ".ave"));
    expect(buildPerCommandSandboxCustomConfig({ denyRead: [], denyWrite: [] })?.filesystem?.denyRead).toEqual([]);
  });

  it("is refused on Windows, where a deny is an ACE for the one account every confined process shares", () => {
    expect(() => denyFor("win32")).toThrow(/denyPluginsRoot is refused on Windows/);
  });

  it("is refused without the read floor restated, which a per-command deny replaces", () => {
    // Where the flag is honoured at all; Windows refuses it before this check.
    setProcessPlatform("linux");
    expect(() => buildPerCommandSandboxCustomConfig({ denyPluginsRoot: true })).toThrow(/needs denyRead restated/);
    setProcessPlatform("win32");
    expect(() => buildPerCommandSandboxCustomConfig({ denyPluginsRoot: true })).toThrow(/refused on Windows/);
  });
});

// These live probes require POSIX shells and per-process filesystem isolation.
describe.skipIf(hostPlatform === "win32")("a confined child cannot reach user data through a grant", () => {
  let root: string;
  let userData: string;
  let partitions: string;
  let customDeny: string;
  let work: string;
  let previousAveHome: string | undefined;
  let sandboxRuns = false;

  beforeAll(async () => {
    sandboxRuns = await asrtCanInitialize();
    if (!sandboxRuns) {
      if (process.env.AVE_REQUIRE_SANDBOX_CASES === "1") throw new Error("ASRT cannot initialize on this machine");
      return;
    }
    root = realpathSync(mkdtempSync(join(tmpdir(), "ave-protected-wrap-")));
    previousAveHome = process.env.AVE_HOME;
    process.env.AVE_HOME = join(root, ".ave");
    if (hostPlatform === "win32") {
      // srt-win stamps each deny with an ACE on its parent too, and Windows propagates that change through the parent's whole tree. Under the real profile that is a walk of the user's entire home on every initialize, past srt-win's 60s stamp budget on a developer machine. A home the test owns keeps the same floor, as asrt-sandbox.test.ts does.
      vi.stubEnv("USERPROFILE", join(root, "home"));
      vi.stubEnv("HOME", join(root, "home"));
      vi.mocked(userInfo).mockReturnValue({ ...userInfo(), homedir: join(root, "home") });
      mkdirSync(join(root, "home"));
    }
    userData = join(root, "custom-user-data");
    partitions = join(userData, "Partitions");
    customDeny = join(root, "custom-deny");
    work = join(root, "work");
    mkdirSync(partitions, { recursive: true });
    mkdirSync(join(customDeny, "work"), { recursive: true });
    writeFileSync(join(customDeny, "s"), SECRET);
    mkdirSync(work);
    writeFileSync(join(userData, "Cookies"), SECRET);
    writeFileSync(join(partitions, "cookie"), SECRET);
    await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true, userDataDir: userData, denyRead: [customDeny] });
    // The confined-child and bundled wraps below serve extension processes, which are wrapped only while plugin-worker confinement was requested.
    setPluginWorkerConfinementRequestedAtBoot(true);
  });

  afterAll(async () => {
    __resetSandboxRequestedAtBootForTest();
    if (isAsrtSandboxActive()) await resetAsrtSandbox();
    if (!sandboxRuns) return;
    if (previousAveHome === undefined) delete process.env.AVE_HOME;
    else process.env.AVE_HOME = previousAveHome;
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  // A case that spawns a POSIX shell probe through a per-command wrap. Windows has none of these wraps: ASRT there takes no per-exec allowRead/allowWrite (wrapToolCommand refuses them), wrapBundledCommand is the macOS and Linux wrap, and a confined child runs under cmd, not /bin/sh. A Windows plugin child is confined by the holder-PID ACL grant instead, which adversarial-escapes.test.ts measures against the same kind of neighbour. The floor rules these cases rely on run everywhere, above.
  const itPosixWrap = it.runIf(hostPlatform !== "win32");

  const probe = () => [
    `cat ${join(userData, "Cookies")}`,
    `cat ${join(partitions, "cookie")}`,
    `echo planted > ${join(partitions, "planted")}`,
    `echo ok > ${join(work, "ok")}`,
    "echo probe-finished",
  ].join("; ");

  function expectConfined(stdout: string): void {
    expect(stdout, "the probe did not run to completion").toContain("probe-finished");
    expect(stdout).not.toContain(SECRET);
    expect(existsSync(join(partitions, "planted"))).toBe(false);
    // The control: the wrap really granted the ordinary root.
    expect(readFileSync(join(work, "ok"), "utf-8").trim()).toBe("ok");
    rmSync(join(work, "ok"));
  }

  itPosixWrap("as a plugin child or worker, which keeps its own temp directory and HOME", async () => {
    if (!sandboxRuns) return;
    const home = createSandboxProcessHome();
    try {
      const own = `${probe()}; echo ${OWN_TEMP} > "$TMPDIR/own" && cat "$TMPDIR/own"; echo ${OWN_HOME} > "$HOME/own" && cat "$HOME/own"`;
      const { child, confinement } = await spawnConfinedChild({ egressOwner: TEST_WORKER_EGRESS_OWNER,
        command: "/bin/sh",
        args: ["-c", own],
        label: "protected-write-roots",
        grantMode: "allow-list",
        tempPrincipal: { kind: "plugin", id: "protected-write-roots" },
        allowRead: [work, partitions, home.path],
        allowWrite: [partitions, work, home.path],
        pinWriteRoots: true,
        baseEnv: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        extraEnv: { ...home.env },
      });
      let stdout = "";
      child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf-8"); });
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
      await cleanupAsrtSandboxAfterCommand();
      // The spawn reports the wrap it applied, which a live sandbox makes real.
      expect(confinement).not.toBe("unconfined");
      expectConfined(stdout);
      expect(stdout).toContain(OWN_TEMP);
      expect(stdout).toContain(OWN_HOME);
    } finally {
      home.cleanup();
    }
  });

  itPosixWrap("as a tool command", async () => {
    if (!sandboxRuns) return;
    const { argv, env } = await wrapToolCommand(probe(), { commandId: TEST_COMMAND_ID,
      binShell: "/bin/sh",
      filesystem: {
        allowWrite: [partitions, work],
        allowRead: [work, partitions],
        denyRead: getDefaultSensitiveReadDenyPaths(),
        denyWrite: getDefaultSensitiveWriteDenyPaths(),
      },
    });
    const run = spawnSync(argv[0]!, argv.slice(1), { env, encoding: "utf-8", timeout: 30_000 });
    await cleanupAsrtSandboxAfterCommand();
    expectConfined(run.stdout);
  });

  it("holds a trusted custom deny to the same floor", () => {
    if (!sandboxRuns) return;
    const inside = join(customDeny, "work");
    expect(protectedReadDenyCovering(inside)).toBe(customDeny);
    const fs = buildPerCommandSandboxCustomConfig({ allowWrite: [inside, work], allowRead: [inside, work] })?.filesystem;
    expect(fs?.allowRead).toEqual([work]);
    expect(fs?.allowWrite).toEqual(process.platform === "linux" ? [work] : [inside, work]);
  });

  itPosixWrap("denies a trusted custom deny to a wrap that restates only the sensitive floor", async () => {
    // A per-command deny replaces the shared one; the plugin child, workers, bundled hooks, MCP stdio and the terminal restate the sensitive floor alone, so the wrap has to add the custom denies itself.
    if (!sandboxRuns) return;
    const { argv, env } = await wrapToolCommand(`cat ${join(customDeny, "s")}; echo probe-finished`, { commandId: TEST_COMMAND_ID,
      binShell: "/bin/sh",
      filesystem: {
        allowRead: [work], allowWrite: [work],
        denyRead: getDefaultSensitiveReadDenyPaths(), denyWrite: getDefaultSensitiveWriteDenyPaths(),
      },
    });
    const run = spawnSync(argv[0]!, argv.slice(1), { env, encoding: "utf-8", timeout: 30_000 });
    await cleanupAsrtSandboxAfterCommand();
    expect(run.stdout).toContain("probe-finished");
    expect(run.stdout).not.toContain(SECRET);
  });

  itPosixWrap("withholds the saved-session root from a bundled hook or MCP stdio server", async () => {
    if (!sandboxRuns) return;
    const sessions = getConfiguredSessionReadPolicy().allowRead[0]!;
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "s.jsonl"), SECRET);
    const home = createSandboxProcessHome();
    try {
      const { argv, env } = await wrapBundledCommand({
        egressOwner: TEST_WORKER_EGRESS_OWNER,
        command: "/bin/sh",
        args: ["-c", `cat ${join(sessions, "s.jsonl")}; echo probe-finished`],
        sandboxHome: home,
        // Lands in the bundled wrap's allowRead as well.
        allowWrite: [sessions],
        ownPluginReads: [],
        tempPrincipal: { kind: "mcp", id: "protected-write-roots" },
      });
      const run = spawnSync(argv[0]!, argv.slice(1), {
        env: bundledWrappedEnv({ PATH: process.env.PATH ?? "/usr/bin:/bin" }, env, home.env),
        encoding: "utf-8",
        timeout: 30_000,
      });
      await cleanupAsrtSandboxAfterCommand();
      expect(run.stdout).toContain("probe-finished");
      expect(run.stdout).not.toContain(SECRET);
    } finally {
      home.cleanup();
    }
  });

  // Plugins live under `<AVE_HOME>/plugins`, and agent plugins keep their data under `<AVE_HOME>/agent-plugin-data` and their installed versions under `<AVE_HOME>/packages/agent-plugin`; the floor covers none of them. Every wrap of plugin-owned code is refused all three and re-allowed its own directories inside them (`PerCommandFilesystem.denyPluginsRoot`).
  function pluginsLayout() {
    const ave = join(root, ".ave");
    const plugins = join(ave, "plugins");
    const own = join(plugins, "own");
    const ownData = join(own, "data");
    const generation = join(plugins, ".cache", "own", "generations", "g", "payload");
    const neighbourData = join(plugins, "neighbour", "data");
    const agentData = join(ave, "agent-plugin-data");
    const agentPackages = join(ave, "packages", "agent-plugin");
    const ownAgentData = join(agentData, "own");
    const ownAgentGeneration = join(agentPackages, "own", "1.0.0");
    const neighbourAgentData = join(agentData, "neighbour");
    const neighbourAgentGeneration = join(agentPackages, "neighbour", "1.0.0");
    for (const dir of [ownData, generation, neighbourData, ownAgentData, ownAgentGeneration, neighbourAgentData, neighbourAgentGeneration]) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(join(own, "code.txt"), "own-code");
    writeFileSync(join(generation, "hook.txt"), "own-generation");
    writeFileSync(join(ownAgentGeneration, "hook.txt"), "own-agent-generation");
    for (const dir of [neighbourData, neighbourAgentData, neighbourAgentGeneration]) writeFileSync(join(dir, "s"), SECRET);
    writeFileSync(join(plugins, "registry.json"), SECRET);
    for (const dir of [ownData, ownAgentData]) rmSync(join(dir, "written"), { force: true });
    return {
      plugins, own, ownData, generation, neighbourData,
      agentData, agentPackages, ownAgentData, ownAgentGeneration, neighbourAgentData, neighbourAgentGeneration,
    };
  }

  const pluginsProbe = (layout: ReturnType<typeof pluginsLayout>, ownReads: readonly string[], ownData = layout.ownData) => [
    `cat ${join(layout.neighbourData, "s")}`,
    `cat ${join(layout.plugins, "registry.json")}`,
    `ls ${layout.plugins}`,
    `cat ${join(layout.neighbourAgentData, "s")}`,
    `cat ${join(layout.neighbourAgentGeneration, "s")}`,
    `ls ${layout.agentData} ${layout.agentPackages}`,
    ...ownReads.map((file) => `cat ${file}; echo`),
    `echo own-written > ${join(ownData, "written")} && cat ${join(ownData, "written")}`,
    "echo probe-finished",
  ].join("; ");

  function expectOnlyOwnPlugin(stdout: string, ownData: string, ownBytes: readonly string[]): void {
    expect(stdout, "the probe did not run to completion").toContain("probe-finished");
    expect(stdout).not.toContain(SECRET);
    expect(stdout).not.toContain("neighbour");
    // The controls: its own directories are still its own, the data directory writable — on Linux a read re-allow of a directory holding it would otherwise have left it read-only.
    for (const bytes of ownBytes) expect(stdout).toContain(bytes);
    expect(stdout).toContain("own-written");
    expect(readFileSync(join(ownData, "written"), "utf-8").trim()).toBe("own-written");
  }

  itPosixWrap("the probe reads every neighbour sentinel when nothing confines it", () => {
    if (!sandboxRuns) return;
    const layout = pluginsLayout();
    const run = spawnSync("/bin/sh", ["-c", pluginsProbe(layout, [])], { encoding: "utf-8" });
    // Three neighbour sentinels and the registry, read; the listings name the neighbour.
    expect(run.stdout.split(SECRET).length - 1).toBe(4);
    expect(run.stdout).toContain("neighbour");
  });

  itPosixWrap("as a plugin child whose root holds its data directory: the data stays writable and the neighbour unread", async () => {
    if (!sandboxRuns) return;
    const layout = pluginsLayout();
    const home = createSandboxProcessHome();
    try {
      const { child } = await spawnConfinedChild({ egressOwner: TEST_WORKER_EGRESS_OWNER,
        command: "/bin/sh",
        args: ["-c", pluginsProbe(layout, [join(layout.own, "code.txt")])],
        label: "protected-write-roots",
        grantMode: "allow-list",
        tempPrincipal: { kind: "plugin", id: "own" },
        // The shape of a plugin installed where its data lives: the root is read, the data directory inside it written.
        allowRead: [layout.own, layout.ownData, home.path],
        allowWrite: [layout.ownData, home.path],
        pinWriteRoots: true,
        denyPluginsRoot: true,
        baseEnv: { PATH: process.env.PATH ?? "/usr/bin:/bin" },
        extraEnv: { ...home.env },
      });
      let stdout = "";
      child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf-8"); });
      await new Promise<void>((resolve) => child.once("close", () => resolve()));
      await cleanupAsrtSandboxAfterCommand();
      expectOnlyOwnPlugin(stdout, layout.ownData, ["own-code"]);
    } finally {
      home.cleanup();
    }
  });

  itPosixWrap("as a bundled hook: its generation and data are its own, another plugin's data and the registry are not", async () => {
    if (!sandboxRuns) return;
    const layout = pluginsLayout();
    const home = createSandboxProcessHome();
    try {
      const { argv, env } = await wrapBundledCommand({
        egressOwner: TEST_WORKER_EGRESS_OWNER,
        command: "/bin/sh",
        args: ["-c", pluginsProbe(layout, [join(layout.generation, "hook.txt")])],
        sandboxHome: home,
        allowWrite: [layout.ownData],
        ownPluginReads: [layout.generation],
        tempPrincipal: { kind: "plugin", id: "own" },
      });
      const run = spawnSync(argv[0]!, argv.slice(1), {
        env: bundledWrappedEnv({ PATH: process.env.PATH ?? "/usr/bin:/bin" }, env, home.env),
        encoding: "utf-8",
        timeout: 30_000,
      });
      await cleanupAsrtSandboxAfterCommand();
      expectOnlyOwnPlugin(run.stdout, layout.ownData, ["own-generation"]);
    } finally {
      home.cleanup();
    }
  });

  itPosixWrap("as an agent plugin's hook or bundled server: its version and data are its own, a neighbour agent plugin's are not", async () => {
    if (!sandboxRuns) return;
    const layout = pluginsLayout();
    const home = createSandboxProcessHome();
    try {
      // The roots `agent-plugin-hook-runtime.ts` and `agent-plugin-mcp.ts` hand the wrap: the installed version it runs from, the data it writes.
      const { argv, env } = await wrapBundledCommand({
        egressOwner: TEST_WORKER_EGRESS_OWNER,
        command: "/bin/sh",
        args: ["-c", pluginsProbe(layout, [join(layout.ownAgentGeneration, "hook.txt")], layout.ownAgentData)],
        sandboxHome: home,
        allowWrite: [layout.ownAgentData],
        ownPluginReads: [layout.ownAgentGeneration],
        tempPrincipal: { kind: "plugin", id: "agent-plugin/own" },
      });
      const run = spawnSync(argv[0]!, argv.slice(1), {
        env: bundledWrappedEnv({ PATH: process.env.PATH ?? "/usr/bin:/bin" }, env, home.env),
        encoding: "utf-8",
        timeout: 30_000,
      });
      await cleanupAsrtSandboxAfterCommand();
      expectOnlyOwnPlugin(run.stdout, layout.ownAgentData, ["own-agent-generation"]);
    } finally {
      home.cleanup();
    }
  });

  it("refuses a plugin's chosen directory under the configured user data", () => {
    if (!sandboxRuns) return;
    const ave = join(root, ".ave");
    const pluginRoot = join(ave, "plugins", "p");
    const pluginDataDir = join(pluginRoot, "data");
    mkdirSync(pluginDataDir, { recursive: true });
    writeFileSync(join(ave, "settings.json"), JSON.stringify({ permissions: { additionalDirectories: [root] } }));
    const derive = (chosen: string) => derivePluginChildEnvelope({
      pluginId: "p",
      sandbox: { write: [{ kind: "userChosenDirectory", configKey: "workspace", why: "Store project data" }] },
      pluginRoot,
      pluginDataDir,
      configValue: (key) => (key === "workspace" ? chosen : undefined),
    });
    expect(derive(work).write).toContain(work);
    expect(() => derive(partitions)).toThrow(/sandbox read-deny floor/);
  });
});
