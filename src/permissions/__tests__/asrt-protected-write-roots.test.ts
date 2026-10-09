/**
 * No wrap is granted a write root, or a read grant, under the protected
 * read-deny floor.
 *
 * Bubblewrap grants a write by binding the host directory read-write over the
 * read deny's tmpfs mask, so on Linux such a root re-opens everything under it.
 * An `allowRead` entry re-allows inside a covering deny on both platforms.
 * Every wrap — the user's shell, plugin children and workers, bundled hooks,
 * MCP stdio servers, the terminal — reaches ASRT through
 * `buildPerCommandSandboxCustomConfig`, and the shared config through
 * `buildSandboxConfig`; the rule lives there so that no caller has to repeat it.
 * A wrap's own temp directory and HOME sit under the sandbox private roots,
 * which the floor restated with them does deny but which are not protected
 * floor: each wrap is granted its own directory there by design.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { derivePluginChildEnvelope } from "../../plugins/isolation/out-of-process-plugin.js";
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
import { createSandboxProcessHome } from "../sandbox-process-home.js";
import { bundledWrappedEnv, wrapBundledCommand } from "../../sandbox/wrap-bundled-command.js";
import { getConfiguredSessionReadPolicy } from "../sensitive-paths.js";
import { asrtCanInitialize } from "./test-helpers.js";

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
    // os.homedir() reads USERPROFILE on Windows, so a HOME-only stub would
    // leave the `.ssh` deny pointing at the real profile there.
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
    // The wrap's OWN private directories, under the private roots the floor it
    // restates read-denies: they must survive the withholding.
    const ownTemp = ensureSandboxTempPrincipalDir({ kind: "plugin", id: "p" }).dir;
    const ownHome = createSandboxProcessHome();
    return { protectedRoots, ordinaryRoots: [...ordinaryRoots, ownTemp, ownHome.path], ownHome };
  }

  // The filesystem each wrap kind hands the wrap, by shape: the shell adds a
  // whole-HOME read deny, plugin-owned code pins its roots, the terminal does
  // neither.
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
    // The builtin shell's saved-session grant and a plugin's `certs` host
    // directory are the two legitimate reads under the floor, and each is
    // opened only for the wrap whose composer asks for it.
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

  it("every ASRT wrap and config change goes through the shared layer", () => {
    // A wrap that handed ASRT its own custom config, or a config change that
    // skipped `buildSandboxConfig`, would skip the rule. Every mention of the
    // identifiers in code — a call, a destructured or bound alias — is listed
    // and compared with the legitimate sites. The Linux runtime probe passes
    // no per-command config and runs under the shared one.
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
      "permissions/asrt-sandbox.ts: updateConfig(buildSandboxConfig(withWorkerUnixSockets(_baseTrustedSettings)));",
      "permissions/asrt-sandbox.ts: updateConfig(buildSandboxConfig(withWorkerUnixSockets(_baseTrustedSettings,socketDir)));",
      "permissions/asrt-sandbox.ts: updateConfig(buildSandboxConfig(withWorkerUnixSockets(trustedSettings)));",
      "permissions/asrt-sandbox.ts: wrapWithSandboxArgv(ASRT_LINUX_RUNTIME_PROBE_COMMAND,undefined,undefined,abortController.signal,process.cwd());",
      "permissions/asrt-sandbox.ts: wrapWithSandboxArgv(command,options.binShell,buildPerCommandSandboxCustomConfig(options.filesystem),options.abortSignal);",
      "permissions/asrt-sandbox.ts: wrapWithSandboxArgv(command,options.binShell,buildPerCommandSandboxCustomConfig(options.filesystem),options.abortSignal);",
    ]);
  });
});

/**
 * Against the real sandbox, with the user data directory somewhere the host
 * guard's default-location globs do not reach — `--user-data-dir`, or
 * XDG_CONFIG_HOME on Linux — and a trusted custom deny. Runs on macOS and on
 * Linux with bubblewrap.
 */
describe("a confined child cannot reach user data through a grant", () => {
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
  });

  afterAll(async () => {
    if (isAsrtSandboxActive()) await resetAsrtSandbox();
    if (!sandboxRuns) return;
    if (previousAveHome === undefined) delete process.env.AVE_HOME;
    else process.env.AVE_HOME = previousAveHome;
    rmSync(root, { recursive: true, force: true });
  });

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

  it("as a plugin child or worker, which keeps its own temp directory and HOME", async () => {
    if (!sandboxRuns) return;
    const home = createSandboxProcessHome();
    try {
      const own = `${probe()}; echo ${OWN_TEMP} > "$TMPDIR/own" && cat "$TMPDIR/own"; echo ${OWN_HOME} > "$HOME/own" && cat "$HOME/own"`;
      const { child, confinement } = await spawnConfinedChild({
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

  it("as a tool command", async () => {
    if (!sandboxRuns) return;
    const { argv, env } = await wrapToolCommand(probe(), {
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

  it("denies a trusted custom deny to a wrap that restates only the sensitive floor", async () => {
    // A per-command deny replaces the shared one; the plugin child, workers,
    // bundled hooks, MCP stdio and the terminal restate the sensitive floor
    // alone, so the wrap has to add the custom denies itself.
    if (!sandboxRuns) return;
    const { argv, env } = await wrapToolCommand(`cat ${join(customDeny, "s")}; echo probe-finished`, {
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

  it("withholds the saved-session root from a bundled hook or MCP stdio server", async () => {
    if (!sandboxRuns) return;
    const sessions = getConfiguredSessionReadPolicy().allowRead[0]!;
    mkdirSync(sessions, { recursive: true });
    writeFileSync(join(sessions, "s.jsonl"), SECRET);
    const home = createSandboxProcessHome();
    try {
      const { argv, env } = await wrapBundledCommand({
        command: "/bin/sh",
        args: ["-c", `cat ${join(sessions, "s.jsonl")}; echo probe-finished`],
        sandboxHome: home,
        // Lands in the bundled wrap's allowRead as well.
        allowWrite: [sessions],
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
