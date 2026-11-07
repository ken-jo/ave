const factsOverride = vi.hoisted(() => new Map<string, { reparseTag: number; attributes: number }>());
// The first path of every native pin, so a test can count the helper calls one composition makes.
const pinnedFirstPaths = vi.hoisted(() => [] as string[]);
vi.mock("../../shared/windows-path-facts.js", async original => {
  const facts = await (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original());
  // A seam for reparse tags no fixture can create: the named paths report the given tag on their own native facts.
  const pinWindowsPaths: typeof facts.pinWindowsPaths = (paths) => {
    if (paths[0] !== undefined) pinnedFirstPaths.push(paths[0]);
    return facts.pinWindowsPaths(paths).map((row, index) => ({ ...row, ...factsOverride.get(paths[index]!) }));
  };
  return { ...facts, pinWindowsPaths };
});
vi.mock("../../shared/windows-configuration-handles.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));
const readdirFault = vi.hoisted(() => ({ path: undefined as string | undefined, code: "EACCES" }));
vi.mock("node:fs", async original => {
  const fs = (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationFs(await original());
  const readdirSync = ((...args: Parameters<typeof fs.readdirSync>) => {
    if (readdirFault.path !== undefined && String(args[0]) === readdirFault.path) {
      throw Object.assign(new Error(`${readdirFault.code}: simulated readdir failure`), { code: readdirFault.code });
    }
    return Reflect.apply(fs.readdirSync, undefined, args);
  }) as typeof fs.readdirSync;
  return { ...fs, readdirSync };
});

// The sandbox read deny covers the Ave home as one directory: no per-file rows, every child denied unless re-allowed.
import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fakeHome = vi.hoisted(() => ({ value: undefined as string | undefined }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return {
    ...actual,
    homedir: () => fakeHome.value ?? actual.homedir(),
    userInfo: () => (fakeHome.value === undefined ? actual.userInfo() : { ...actual.userInfo(), homedir: fakeHome.value }),
  };
});

vi.mock("../../shared/policy-home.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../shared/policy-home.js")>();
  const os = await import("node:os");
  return { ...actual, policyHomeAnchors: () => [os.homedir()] };
});

import { aveHome } from "../../shared/ave-home.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { useVerifiedAveHomePrivacy } from "../../__tests__/support/ave-home-privacy.js";
import { AVE_HOME_READ_REALLOWS, isAveHomeReadReallowed } from "../ave-home-read-boundary.js";
import {
  aveHomeReadBoundaryCovering,
  buildPerCommandSandboxCustomConfig,
  buildSandboxConfig,
  cleanupAsrtSandboxAfterCommand,
  createAveHomeBoundarySnapshot,
  getBuiltinShellReadPolicy,
  getDefaultSensitiveReadDenyPaths,
  getDefaultSensitiveWriteDenyPaths,
  getProtectedReadDenyFloor,
  initializeAsrtSandbox,
  isAsrtSandboxActive,
  resetAsrtSandbox,
  wrapWorkerCommand,
} from "../asrt-sandbox.js";
import { SENSITIVE_PATH_ENTRIES } from "../sensitive-paths.js";
import { windowsReadDenyEvidence, windowsReadDenyKey } from "../../shared/windows-read-deny-evidence.js";
import { TEST_COMMAND_ID } from "../../__tests__/support/egress-fixture.js";
import { asrtCanInitialize } from "./test-helpers.js";

useVerifiedAveHomePrivacy();

const HOST_PLATFORM = process.platform;
const trim = (path: string): string => path.replace(/[\\/]+$/, "");
const spelled = (entries: readonly unknown[]): string[] => entries.map((entry) => trim(typeof entry === "string" ? entry : (entry as { path: string }).path));
const aveFileRows = (): string[] => SENSITIVE_PATH_ENTRIES
  .filter((entry) => entry.anchor === "ave-home" && entry.kind === "file").map((entry) => join(aveHome(), ...entry.segments));
const dotfileRows = (): string[] => SENSITIVE_PATH_ENTRIES
  .filter((entry) => entry.anchor === "home" && entry.kind === "file").map((entry) => join(homedir(), ...entry.segments));
const reallowed = (): string[] => [
  join(aveHome(), "workspace", "alice-project"),
  join(aveHome(), "plugins", "alice-plugin", "data"),
  join(aveHome(), "plugins", ".cache", "alice-plugin"),
  join(aveHome(), "agent-plugin-data", "bob-agent"),
  join(aveHome(), "packages", "agent-plugin", "bob-agent", "1.0.0"),
  join(aveHome(), "mcp", "example-server", "sandbox"),
  join(aveHome(), "mcp", "build.json", "sandbox"),
  join(aveHome(), "mcp-data", "example-server"),
  join(aveHome(), "runtime", "python-envs", "example"),
  join(aveHome(), "runtime", "uv"),
  join(aveHome(), "mxc-staging", "alice"),
];
const withheld = (): string[] => [
  aveHome(),
  join(aveHome(), "logs"),
  join(aveHome(), "traces", "alice.jsonl"),
  join(aveHome(), "plugins"),
  join(aveHome(), "plugins", "registry.json"),
  join(aveHome(), "plugins", ".cache"),
  join(aveHome(), "mcp", "servers.json"),
  join(aveHome(), "mcp", "servers.json.bak"),
  join(aveHome(), "mcp", ".cache"),
  join(aveHome(), "mcp-data"),
  join(aveHome(), "packages", "ledger.json"),
  join(aveHome(), "runtime"),
  join(aveHome(), "runtime", "example-tool"),
  join(aveHome(), "future-child", "alice.txt"),
];

afterEach(() => setProcessPlatform(HOST_PLATFORM));

describe("the Ave home re-allow table", () => {
  it("re-opens only named children, never the root or a sibling file", () => {
    expect(isAveHomeReadReallowed([])).toBe(false);
    expect(isAveHomeReadReallowed(["workspace"])).toBe(true);
    expect(isAveHomeReadReallowed(["plugins"])).toBe(false);
    expect(isAveHomeReadReallowed(["plugins", "registry.json"])).toBe(false);
    expect(isAveHomeReadReallowed(["mcp", "servers.json"])).toBe(false);
    expect(isAveHomeReadReallowed(["mcp", ".cache"])).toBe(false);
    expect(isAveHomeReadReallowed(["logs"])).toBe(false);
    expect(isAveHomeReadReallowed(["plugins", "auth-partitions.json.tmp"])).toBe(false);
    expect(isAveHomeReadReallowed(["plugins", ".cache", "plugin-contribution-trust"])).toBe(false);
  });

  it("accepts every MCP server directory the host derives, dotted ids included, and no host record beside them", () => {
    // `ensureStdioSandboxRoot` keeps `[A-Za-z0-9._-]` and strips leading dots.
    for (const id of ["build.json", "servers.json-tool", "a.b.c", "_x", "-y"]) expect(isAveHomeReadReallowed(["mcp", id, "sandbox"]), id).toBe(true);
    for (const name of ["servers.json", "servers.json.bak", "servers.json.lock", ".cache", ".staging"]) expect(isAveHomeReadReallowed(["mcp", name]), name).toBe(false);
  });

  it("re-opens one marketplace data directory per server slug, never the namespace", () => {
    expect(isAveHomeReadReallowed(["mcp-data", "example-server"])).toBe(true);
    expect(isAveHomeReadReallowed(["mcp-data", "example-server", "index.db"])).toBe(true);
    expect(isAveHomeReadReallowed(["mcp-data"])).toBe(false);
    expect(isAveHomeReadReallowed(["mcp-data", ".hidden"])).toBe(false);
    expect(AVE_HOME_READ_REALLOWS.every((row) => row.why.length > 0)).toBe(true);
  });
});

describe.each(["linux", "darwin", "win32"] as const)("the Ave home read boundary on %s", (platform) => {
  it("denies the Ave home root and none of its file rows; home dotfile rows are unchanged", () => {
    setProcessPlatform(platform);
    const floor = spelled(getDefaultSensitiveReadDenyPaths());
    expect(floor).toContain(trim(aveHome()));
    for (const row of aveFileRows()) expect(floor).not.toContain(row);
    for (const row of dotfileRows()) expect(floor).toContain(row);
  });

  it("keeps the Ave home file rows on the protected floor and the write floor", () => {
    setProcessPlatform(platform);
    const write = spelled(getDefaultSensitiveWriteDenyPaths());
    const floor = spelled(getProtectedReadDenyFloor());
    for (const row of aveFileRows()) {
      expect(write).toContain(row);
      expect(floor).toContain(row);
    }
    expect(write).not.toContain(trim(aveHome()));
    expect(floor).not.toContain(trim(aveHome()));
  });

  it("covers every path outside a re-allowed child, the root included", () => {
    setProcessPlatform(platform);
    for (const path of reallowed()) expect(aveHomeReadBoundaryCovering(path), path).toBeUndefined();
    for (const path of withheld()) expect(trim(aveHomeReadBoundaryCovering(path) ?? ""), path).toBe(trim(aveHome()));
    expect(aveHomeReadBoundaryCovering(join(homedir(), "alice-project"))).toBeUndefined();
  });

  it("drops a shell read grant outside the re-allowed children", () => {
    setProcessPlatform(platform);
    const policy = getBuiltinShellReadPolicy([...reallowed(), ...withheld()], homedir());
    const granted = spelled(policy.allowRead);
    for (const path of reallowed()) expect(granted).toContain(trim(path));
    for (const path of withheld()) expect(granted).not.toContain(trim(path));
    expect(spelled(policy.denyRead)).toContain(trim(aveHome()));
  });
});

describe.each(["linux", "darwin"] as const)("the Ave home read boundary in %s wraps", (platform) => {
  it("withholds a per-command read grant outside the re-allowed children", () => {
    setProcessPlatform(platform);
    const config = buildPerCommandSandboxCustomConfig({
      allowRead: [...reallowed(), ...withheld()],
      denyRead: getDefaultSensitiveReadDenyPaths(),
    });
    const granted = spelled(config?.filesystem?.allowRead ?? []);
    for (const path of reallowed()) expect(granted).toContain(trim(path));
    for (const path of withheld()) expect(granted).not.toContain(trim(path));
  });

  it.runIf(platform === "linux")("withholds a Linux write root outside the re-allowed children", () => {
    setProcessPlatform(platform);
    const keep = join(aveHome(), "workspace", "alice-project");
    const drop = join(aveHome(), "logs");
    const config = buildPerCommandSandboxCustomConfig({ allowWrite: [keep, drop], denyRead: getDefaultSensitiveReadDenyPaths() });
    const roots = spelled(config?.filesystem?.allowWrite ?? []);
    expect(roots).toContain(trim(keep));
    expect(roots).not.toContain(trim(drop));
  });

  it.runIf(platform === "darwin")("spells the root deny exactly so a nested re-allow survives late deny emission", () => {
    setProcessPlatform(platform);
    let real = aveHome();
    try { real = realpathSync(aveHome()); } catch { /* not created: the deny still names it */ }
    const exact = `${real.slice(0, -1)}[${real.slice(-1)}]`;
    const denies = spelled(buildSandboxConfig({ allowedDomains: [], strictAllowlist: true }).filesystem.denyRead);
    expect(denies).toContain(exact);
    expect(denies).not.toContain(trim(aveHome()));
  });
});

describe("the Ave home read boundary through the MCP stdio wrap", () => {
  it("keeps a dotted server id's install and sandbox roots, and its own data directory, on Linux", () => {
    setProcessPlatform("linux");
    const install = join(aveHome(), "mcp", "build.json");
    const sandbox = join(install, "sandbox");
    const data = join(aveHome(), "mcp-data", "build.json");
    // The shape wrapBundledCommand gives an MCP server of no plugin: its sandbox root writable, its install and data directories read.
    const config = buildPerCommandSandboxCustomConfig({ allowRead: [install, data, sandbox], allowWrite: [sandbox], denyRead: getDefaultSensitiveReadDenyPaths() });
    expect(spelled(config?.filesystem?.allowRead ?? [])).toEqual(expect.arrayContaining([install, data, sandbox].map(trim)));
    expect(spelled(config?.filesystem?.allowWrite ?? [])).toContain(trim(sandbox));
    expect(spelled(config?.filesystem?.allowWrite ?? [])).not.toContain(trim(data));
  });

  it("lets the Windows grant ceiling accept the same roots", () => {
    setProcessPlatform("win32");
    for (const path of [join(aveHome(), "mcp", "build.json", "sandbox"), join(aveHome(), "mcp-data", "build.json")]) {
      expect(aveHomeReadBoundaryCovering(path), path).toBeUndefined();
    }
  });
});

describe("a profile-child Ave home on Windows", () => {
  // A stamp on a profile child also stamps the profile root, so such a home denies its existing top-level children instead of itself.
  let profile: string;
  let original: string;
  beforeEach(() => {
    profile = mkdtempSync(join(tmpdir(), "ave-boundary-profile-"));
    original = join(profile, ".ave");
    for (const dir of [["plugins", "alice-plugin"], ["mcp", "example-server"], ["workspace", "alice-project"], ["logs"], ["sessions"], ["runtime", "uv"]]) {
      mkdirSync(join(original, ...dir), { recursive: true });
    }
    writeFileSync(join(original, "settings.json"), "fixture");
    writeFileSync(join(original, "plugins", "registry.json"), "fixture");
    fakeHome.value = profile;
    setProcessPlatform("win32");
  });
  afterEach(() => {
    readdirFault.path = undefined;
    factsOverride.clear();
    setProcessPlatform(HOST_PLATFORM);
    fakeHome.value = undefined;
    rmSync(profile, { recursive: true, force: true });
  });

  const refused = expect.objectContaining({ code: "ave-home-boundary-unverified" });
  // Every composer that projects the boundary: the read floor, the shell policy, a per-command wrap and the shared config.
  const composers = (): Array<[string, () => unknown]> => [
    ["read projection", () => getDefaultSensitiveReadDenyPaths()],
    ["shell read policy", () => getBuiltinShellReadPolicy([join(original, "workspace", "alice-project")], profile)],
    ["per-command wrap", () => buildPerCommandSandboxCustomConfig({ allowRead: [join(original, "workspace", "alice-project")] })],
    ["per-command wrap with its own floor", () => buildPerCommandSandboxCustomConfig({ denyRead: [join(profile, ".ssh")] })],
    ["shared config", () => buildSandboxConfig({ allowedDomains: [], strictAllowlist: true })],
  ];
  const noProfileRootRow = (paths: readonly unknown[]): void => {
    expect(spelled(paths).map((path) => path.toLowerCase())).not.toContain(trim(profile).toLowerCase());
    expect(spelled(paths).map((path) => path.toLowerCase())).not.toContain(trim(original).toLowerCase());
  };

  it.each(["EACCES", "EPERM", "EIO"])("refuses every composer when the existing home cannot be enumerated (%s)", (code) => {
    readdirFault.path = original;
    readdirFault.code = code;
    for (const [label, compose] of composers()) expect(compose, label).toThrow(refused);
  });

  it("refuses when a relocated active home leaves a readable profile home that cannot be enumerated", () => {
    // The active home is relocated (beforeEach), so only the original profile spelling is enumerated.
    expect(trim(aveHome()).toLowerCase()).not.toBe(trim(original).toLowerCase());
    readdirFault.path = original;
    for (const [label, compose] of composers()) expect(compose, label).toThrow(refused);
  });

  it("keeps the absent-home residual when the profile home does not exist", () => {
    rmSync(original, { recursive: true, force: true });
    const floor = getDefaultSensitiveReadDenyPaths();
    noProfileRootRow(floor);
    for (const row of ["settings.json", "plugins/registry.json"]) expect(floor).toContain(join(original, ...row.split("/")));
  });

  it("refuses a linked top-level child that is not re-allowed, and keeps a linked re-allowed child", () => {
    const target = mkdtempSync(join(tmpdir(), "ave-boundary-link-"));
    try {
      symlinkSync(target, join(original, "sandbox"), "junction");
      const floor = getDefaultSensitiveReadDenyPaths();
      expect(spelled(floor)).not.toContain(join(original, "sandbox"));
      symlinkSync(target, join(original, "traces"), "junction");
      for (const [label, compose] of composers()) expect(compose, label).toThrow(refused);
    } finally {
      rmSync(target, { recursive: true, force: true });
    }
  });

  const linkHome = (dangling: boolean): string => {
    const target = mkdtempSync(join(tmpdir(), "ave-boundary-home-target-"));
    mkdirSync(join(target, "logs"));
    rmSync(original, { recursive: true, force: true });
    symlinkSync(target, original, "junction");
    if (dangling) rmSync(target, { recursive: true, force: true });
    return target;
  };

  it("refuses a profile home that is a junction at every composer, with the active home relocated", () => {
    expect(trim(aveHome()).toLowerCase()).not.toBe(trim(original).toLowerCase());
    const target = linkHome(false);
    try {
      for (const [label, compose] of composers()) expect(compose, label).toThrow(refused);
    } finally {
      rmdirSync(original);
      rmSync(target, { recursive: true, force: true });
    }
  });

  it("refuses a dangling profile-home junction instead of treating the home as absent", () => {
    linkHome(true);
    try {
      for (const [label, compose] of composers()) expect(compose, label).toThrow(refused);
      // Boot names the refused home and the link reason in Settings (aveHomeBoundaryFailure).
      let caught: { reason?: string; home?: string } | undefined;
      try { getDefaultSensitiveReadDenyPaths(); } catch (error) { caught = error as typeof caught; }
      expect(caught?.reason).toBe("link");
      expect(trim(caught?.home ?? "").toLowerCase()).toBe(trim(original).toLowerCase());
    } finally {
      rmdirSync(original);
    }
  });

  it("refuses a top-level directory behind a reparse point that is not a link", () => {
    // A cloud placeholder tag: the listing and lstat both call it a plain directory.
    factsOverride.set(join(original, "logs"), { reparseTag: 0x9000001a, attributes: 0x410 });
    for (const [label, compose] of composers()) expect(compose, label).toThrow(refused);
  });

  it("never yields a profile-root or home-root row from any composer", () => {
    noProfileRootRow(getDefaultSensitiveReadDenyPaths());
    noProfileRootRow(getBuiltinShellReadPolicy([join(original, "workspace", "alice-project")], profile).denyRead);
    noProfileRootRow(buildPerCommandSandboxCustomConfig({ allowRead: [join(original, "workspace", "alice-project")] })?.filesystem?.denyRead ?? []);
    noProfileRootRow(buildSandboxConfig({ allowedDomains: [], strictAllowlist: true }).filesystem.denyRead);
  });

  it("denies each existing top-level child as a directory, never the home itself", () => {
    const floor = getDefaultSensitiveReadDenyPaths();
    expect(spelled(floor)).not.toContain(trim(original));
    for (const child of ["plugins", "mcp", "logs", "runtime"]) expect(floor).toContain(join(original, child) + sep);
    // Wholly re-allowed children are not denied; `sessions` keeps its own floor row.
    for (const child of ["workspace"]) expect(spelled(floor)).not.toContain(join(original, child));
    expect(floor).toContain(join(original, "sessions") + sep);
    // The relocated home keeps its root deny and none of its file rows.
    expect(spelled(floor)).toContain(trim(aveHome()));
    for (const row of aveFileRows()) expect(floor).not.toContain(row);
  });

  it("keeps root files as file rows and drops the rows a denied child covers", () => {
    const floor = getDefaultSensitiveReadDenyPaths();
    for (const row of ["settings.json", "permissions.json"]) expect(floor).toContain(join(original, row));
    expect(floor).not.toContain(join(original, "plugins", "registry.json"));
    expect(floor).not.toContain(join(original, "mcp", "servers.json"));
    // `agent-plugin-data` does not exist, so the rows inside it stay as they were.
    const absent = SENSITIVE_PATH_ENTRIES.filter((entry) => entry.anchor === "ave-home" && entry.kind === "file" && entry.segments[0] === "packages");
    for (const entry of absent) expect(floor).toContain(join(original, ...entry.segments));
  });

  // One native pin per profile-child home per composition: a shell command's read policy and its wrap, or an extension child's
  // floor and its wrap, share one snapshot; the next command or spawn takes its own.
  it("pins the profile-child home once per composition, and afresh for the next one", () => {
    const pins = (): number => pinnedFirstPaths.filter((path) => trim(path).toLowerCase() === trim(original).toLowerCase()).length;
    const grant = [join(original, "workspace", "alice-project")];
    pinnedFirstPaths.length = 0;
    getBuiltinShellReadPolicy(grant, profile);
    expect(pins()).toBe(1);
    buildPerCommandSandboxCustomConfig({ allowRead: grant });
    expect(pins()).toBe(2);
    const shell = createAveHomeBoundarySnapshot();
    const policy = getBuiltinShellReadPolicy(grant, profile, undefined, shell);
    shell.run(() => buildPerCommandSandboxCustomConfig({ allowRead: [...policy.allowRead], denyRead: [...policy.denyRead] }));
    expect(pins()).toBe(3);
    const child = createAveHomeBoundarySnapshot();
    const floor = child.run(() => getDefaultSensitiveReadDenyPaths());
    child.run(() => buildPerCommandSandboxCustomConfig({ allowRead: grant, denyRead: floor }));
    expect(pins()).toBe(4);
    mkdirSync(join(original, "future-child"));
    expect(createAveHomeBoundarySnapshot().run(() => getDefaultSensitiveReadDenyPaths())).toContain(join(original, "future-child") + sep);
    expect(pins()).toBe(5);
    // A finished composition's snapshot is never consulted again; reusing one would miss the new child.
    expect(spelled(shell.run(() => getDefaultSensitiveReadDenyPaths()))).not.toContain(join(original, "future-child"));
    expect(pins()).toBe(5);
  });

  it("keeps a refusal for the rest of its composition and re-pins the next one", () => {
    readdirFault.path = original;
    const snapshot = createAveHomeBoundarySnapshot();
    expect(() => snapshot.run(() => getDefaultSensitiveReadDenyPaths())).toThrow(refused);
    readdirFault.path = undefined;
    expect(() => snapshot.run(() => buildPerCommandSandboxCustomConfig({ allowRead: [join(original, "workspace", "alice-project")] }))).toThrow(refused);
    expect(() => createAveHomeBoundarySnapshot().run(() => getDefaultSensitiveReadDenyPaths())).not.toThrow();
  });

  it("denies a top-level child created after one projection in the next", () => {
    expect(spelled(getDefaultSensitiveReadDenyPaths())).not.toContain(join(original, "future-child"));
    mkdirSync(join(original, "future-child"));
    expect(getDefaultSensitiveReadDenyPaths()).toContain(join(original, "future-child") + sep);
  });

  it("grants re-allowed children beneath a denied child as under a relocated root", () => {
    const own = join(original, "plugins", "alice-plugin");
    const server = join(original, "mcp", "example-server");
    const workspace = join(original, "workspace", "alice-project");
    const policy = getBuiltinShellReadPolicy([own, server, workspace, join(original, "logs"), join(original, "plugins", "registry.json")], profile);
    expect(spelled(policy.allowRead)).toEqual(expect.arrayContaining([own, server, workspace]));
    expect(spelled(policy.allowRead)).not.toContain(join(original, "logs"));
    expect(spelled(policy.allowRead)).not.toContain(join(original, "plugins", "registry.json"));
    expect(policy.denyRead).toContain(join(original, "plugins") + sep);
    for (const path of [own, server, workspace]) expect(aveHomeReadBoundaryCovering(path), path).toBeUndefined();
    expect(aveHomeReadBoundaryCovering(join(original, "plugins", "registry.json"))).toBe(original);
  });

  it("keeps a denied child in directory form when a grant lies beneath it, and a readable root file row", () => {
    const own = join(original, "plugins", "alice-plugin");
    const settings = join(original, "settings.json");
    const stat = lstatSync(settings, { bigint: true });
    const config = buildSandboxConfig({ allowedDomains: [], strictAllowlist: true },
      new Map([[windowsReadDenyKey(settings), { status: "readable", principals: ["Everyone"],
        identity: { volumeSerialNumber: stat.dev.toString(), fileId: stat.ino.toString() } } as const]]),
      { allowRead: [{ path: own, literal: true }] });
    const denies = config.filesystem.denyRead.map((entry) => typeof entry === "string" ? entry : entry.path);
    expect(denies).toContain(join(original, "plugins") + sep);
    expect(spelled(denies)).toContain(settings);
    expect(spelled(denies)).not.toContain(trim(original));
  });
});

describe.runIf(HOST_PLATFORM === "darwin")("the Ave home read boundary in a macOS wrap", () => {
  afterEach(async () => { if (isAsrtSandboxActive()) await resetAsrtSandbox(); });

  it("reads a granted child and nothing else under the root", async () => {
    if (!(await asrtCanInitialize())) {
      if (process.env.AVE_REQUIRE_SANDBOX_CASES === "1") throw new Error("ASRT cannot initialize on this machine");
      return;
    }
    await initializeAsrtSandbox({ allowedDomains: [], strictAllowlist: true });
    const child = join(aveHome(), "workspace", "alice-project");
    const other = join(aveHome(), "logs");
    mkdirSync(child, { recursive: true });
    mkdirSync(other, { recursive: true });
    writeFileSync(join(child, "a.txt"), "CHILD");
    writeFileSync(join(other, "b.log"), "OTHER");
    const { argv, env } = await wrapWorkerCommand(`cat ${join(child, "a.txt")}; cat ${join(other, "b.log")}; echo done`, {
      commandId: TEST_COMMAND_ID,
      filesystem: { allowRead: [child], denyRead: getDefaultSensitiveReadDenyPaths() },
    });
    const run = spawnSync(argv[0]!, argv.slice(1), { env, encoding: "utf-8", timeout: 30_000 });
    await cleanupAsrtSandboxAfterCommand();
    expect(run.stdout).toContain("CHILD");
    expect(run.stdout).not.toContain("OTHER");
    expect(readFileSync(join(other, "b.log"), "utf8")).toBe("OTHER");
  });
});

describe.runIf(HOST_PLATFORM === "win32")("the Ave home read boundary on a Windows host", () => {
  const rootDeny = (config: ReturnType<typeof buildSandboxConfig>): string | undefined => config.filesystem.denyRead
    .map((entry) => typeof entry === "string" ? entry : entry.path)
    .find((path) => trim(path).toLowerCase() === trim(aveHome()).toLowerCase());

  it("stamps the root in directory form when a grant lies beneath it", () => {
    const workspace = join(aveHome(), "workspace");
    mkdirSync(workspace, { recursive: true });
    const config = buildSandboxConfig({ allowedDomains: [], strictAllowlist: true, allowWrite: [workspace] });
    expect(rootDeny(config)).toBe(`${trim(aveHome())}\\`);
    expect(spelled(config.filesystem.denyRead)).not.toContain(join(aveHome(), "settings.json"));
  });

  it("leaves a private or missing home to its own DACL when no grant lies beneath it", () => {
    const status = windowsReadDenyEvidence(`${trim(aveHome())}\\`).status;
    const kept = rootDeny(buildSandboxConfig({ allowedDomains: [], strictAllowlist: true })) !== undefined;
    expect(kept).toBe(status !== "private" && status !== "missing");
  });
});
