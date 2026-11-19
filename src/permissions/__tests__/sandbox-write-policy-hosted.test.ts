const driveFixture = vi.hoisted(() => ({
  enabled: false, backing: "", nativeHost: process.platform,
  toHost: (path: string): string => path,
  toNative: (path: string): string => path,
}));

vi.mock("node:path", async original => {
  const actual = await original<typeof import("node:path")>();
  const paths = Object.fromEntries(Object.entries(actual).map(([key, value]) => [key, typeof value === "function"
    ? (...args: unknown[]) => Reflect.apply(driveFixture.enabled ? actual.win32[key as keyof typeof actual.win32] as (...args: unknown[]) => unknown : value, undefined, args)
    : value]));
  Object.defineProperty(paths, "sep", { get: () => driveFixture.enabled ? "\\" : actual.sep });
  Object.defineProperty(paths, "default", { value: paths });
  return paths;
});

vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  const paths = await vi.importActual<typeof import("node:path")>("node:path");
  const existingCase = (path: string): string => {
    if (path !== driveFixture.backing && !path.startsWith(driveFixture.backing + paths.sep)) return path;
    let parent = driveFixture.backing;
    for (const component of paths.relative(driveFixture.backing, path).split(paths.sep).filter(Boolean)) {
      let names: string[];
      try { names = actual.readdirSync(parent); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; names = []; }
      const stored = names.find(name => name === component) ?? names.find(name => name.toLowerCase() === component.toLowerCase());
      parent = paths.join(parent, stored ?? component);
    }
    return parent;
  };
  const toHost = (path: unknown): unknown => {
    if (!driveFixture.enabled || driveFixture.nativeHost === "win32" || typeof path !== "string") return path;
    if (/^[Dd]:[\\/]/u.test(path)) return existingCase(paths.join(driveFixture.backing, ...path.slice(3).split(/[\\/]/u)));
    if (/^[A-Za-z]:[\\/]/u.test(path)) {
      const drive = path[0];
      if (drive === undefined) throw new Error("Native fixture drive is missing");
      return existingCase(paths.join(driveFixture.backing, "other-drives", drive.toUpperCase(), ...path.slice(3).split(/[\\/]/u)));
    }
    if (/^[\\/]/u.test(path)) return existingCase(paths.join(driveFixture.backing, ...path.slice(1).split(/[\\/]/u)));
    return path;
  };
  const toNative = (path: string): string => {
    const otherDrive = paths.join(driveFixture.backing, "other-drives") + paths.sep;
    if (path.startsWith(otherDrive)) return paths.win32.join(`${path[otherDrive.length]}:\\`, path.slice(otherDrive.length + 2));
    return path.startsWith(driveFixture.backing) ? paths.win32.join("D:\\", paths.relative(driveFixture.backing, path)) : path;
  };
  driveFixture.toHost = path => toHost(path) as string;
  driveFixture.toNative = toNative;
  const wrap = (fn: (...args: unknown[]) => unknown) => (...args: unknown[]) => Reflect.apply(fn, undefined, [toHost(args[0]), ...args.slice(1)]);
  const realpath = (fn: (...args: unknown[]) => string) => (...args: unknown[]) => {
    const value = Reflect.apply(fn, undefined, [toHost(args[0]), ...args.slice(1)]);
    return driveFixture.enabled && driveFixture.nativeHost !== "win32" ? toNative(value) : value;
  };
  const realpathSync = Object.assign(realpath(actual.realpathSync as (...args: unknown[]) => string), {
    native: realpath(actual.realpathSync.native as (...args: unknown[]) => string),
  });
  const methods = ["lstatSync", "statSync", "openSync", "opendirSync", "readFileSync", "readdirSync", "mkdirSync", "writeFileSync"] as const;
  return { ...actual, ...Object.fromEntries(methods.map(key => [key, wrap(actual[key] as (...args: unknown[]) => unknown)])), realpathSync,
    symlinkSync: (target: string, path: string, type?: "dir" | "file" | "junction") => actual.symlinkSync(toHost(target) as string, toHost(path) as string, type),
    readlinkSync: (path: string) => {
      const target = actual.readlinkSync(toHost(path) as string);
      return driveFixture.enabled && driveFixture.nativeHost !== "win32" ? toNative(target) : target;
    },
  };
});

vi.mock("../windows-stamp-targets.js", async original => {
  const targets = (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedStampTargets(await original());
  const filesystem = await import("node:fs");
  return { ...targets, pinWindowsFilesystemConfig: <T extends Partial<import("@anthropic-ai/sandbox-runtime").FilesystemConfig> | undefined>(config: T): T => {
    const checked = targets.pinWindowsFilesystemConfig(config);
    if (!driveFixture.enabled || process.platform !== "win32" || checked === undefined) return checked;
    const pin = (entry: import("@anthropic-ai/sandbox-runtime").FilesystemPathEntry) => ({
      path: filesystem.realpathSync.native(typeof entry === "string" ? entry : entry.path), literal: true as const,
    });
    return { ...checked, allowRead: checked.allowRead?.map(pin), allowWrite: checked.allowWrite?.map(pin) };
  } };
});
vi.mock("node:module", async original =>
  (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedDriveModule(await original()));
vi.mock("../../shared/windows-configuration-handles.js", async original =>
  (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original(), driveFixture.nativeHost));
vi.mock("../../shared/windows-path-facts.js", async original => {
  const facts = await (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original(), driveFixture.nativeHost);
  return { ...facts, pinWindowsPaths: (paths: readonly string[]) => {
    if (!driveFixture.enabled || process.platform !== "win32") return facts.pinWindowsPaths(paths);
    return facts.pinWindowsPaths(paths.map(driveFixture.toHost)).map(row => ({
      ...row, canonical: row.canonical === null ? null : driveFixture.toNative(row.canonical),
    }));
  } };
});

vi.mock("../../shared/policy-home.js", async original => {
  const actual = await original<typeof import("../../shared/policy-home.js")>();
  const os = await import("node:os");
  return { ...actual, policyHomeAnchors: () => [os.homedir()] };
});

vi.mock("node:os", async original => ({ ...(await original<typeof import("node:os")>()) }));

vi.mock("@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js", async original => {
  const actual = await original<typeof import("@anthropic-ai/sandbox-runtime/dist/sandbox/sandbox-utils.js")>();
  const paths = await vi.importActual<typeof import("node:path")>("node:path");
  return { ...actual, normalizePathForSandbox: (path: string, ...args: unknown[]) => driveFixture.enabled && /^[A-Za-z]:[\\/]/u.test(path)
    ? paths.win32.normalize(path) : Reflect.apply(actual.normalizePathForSandbox, undefined, [path, ...args]) };
});

import { mkdtempSync, mkdirSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import * as os from "node:os";
import { join, resolve, win32 } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { expandWindowsFsPaths, rankWindowsFsAccess } from "@anthropic-ai/sandbox-runtime/dist/sandbox/windows-sandbox-utils.js";
import { configureHostResources } from "../../main/host-resources.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { buildPerCommandSandboxCustomConfig, getDefaultSensitiveReadDenyPaths, getDefaultSensitiveWriteDenyPaths } from "../asrt-sandbox.js";
import { buildMandatorySandboxWritePolicy } from "../sandbox-write-policy.js";

const hostPlatform = process.platform;

describe("hosted write policy spellings", () => {
  afterEach(() => {
    driveFixture.enabled = false;
    setProcessPlatform(hostPlatform);
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    if (driveFixture.backing) rmSync(driveFixture.backing, { recursive: true, force: true });
    driveFixture.backing = "";
  });

  it.each([
    { platform: "darwin", prefix: "hosted" },
    { platform: "darwin", prefix: "native-temp" },
    { platform: "win32", prefix: "hosted" },
  ] as const)("keeps long native drive roots within the $platform policy budget under $prefix without reopening the floor", ({ platform, prefix }) => {
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    driveFixture.backing = realpathSync(mkdtempSync(join(os.tmpdir(), "wp-")));
    if (hostPlatform !== "win32") mkdirSync(join(driveFixture.backing, "other-drives", "C"), { recursive: true });
    driveFixture.enabled = hostPlatform !== "win32";
    setProcessPlatform(platform);
    const tempSegments = prefix === "native-temp" ? [".ave-test-tmp"] : ["a", "_temp"];
    const rootPrefix = hostPlatform === "win32"
      ? join(driveFixture.backing, ...tempSegments, "hosted-checkout-")
      : win32.join("D:\\", ...tempSegments, `native-hosted-runner-${"x".repeat(76)}`, "hosted-checkout-");
    const rootBytes = platform === "win32" ? 240 : prefix === "native-temp" ? 179 : 173;
    const paddingBytes = rootBytes - Buffer.byteLength(rootPrefix);
    expect(paddingBytes, `Native fixture prefix exceeds ${rootBytes} bytes: ${rootPrefix}`).toBeGreaterThanOrEqual(0);
    const root = rootPrefix + "x".repeat(paddingBytes);
    expect(Buffer.byteLength(root)).toBe(rootBytes);
    vi.spyOn(os, "homedir").mockReturnValue(root);
    vi.stubEnv("HOME", root);
    vi.stubEnv("USERPROFILE", root);
    vi.stubEnv("AVE_HOME", join(root, ".ave"));
    vi.stubEnv("XDG_CONFIG_HOME", join(root, "xdg"));
    vi.stubEnv("GIT_CONFIG_GLOBAL", join(root, ".gitconfig"));
    vi.stubEnv("GIT_CONFIG_SYSTEM", join(root, "etc", "gitconfig"));
    vi.spyOn(process, "cwd").mockReturnValue(root);
    const xdgRoot = join(root, "xdg", "Ave", "Partitions");
    const protectedRoots = [...[".ave/secrets/work", ".ave/audit", ".ave/routine/work", ".ssh/work"]
      .map(path => join(root, ...path.split("/"))), xdgRoot];
    const literalRoot = join(root, "literal[1]", "temp-directory");
    const deniedParent = join(root, "policy-protected");
    const interveningGrant = join(deniedParent, "workspace");
    const deniedChild = join(interveningGrant, "control");
    const workRoot = platform === "win32" ? join(root, "mixed", "work") : join(root, "work");
    if (platform === "win32") mkdirSync(join(root, "MiXeD"), { recursive: true });
    const ordinaryRoots = [workRoot, ...[".ave/plugins/p/data", ".ave/mcp/s/sandbox", "temp/owned"]
      .map(path => join(root, ...path.split("/"))), literalRoot, interveningGrant];
    for (const path of [...protectedRoots, ...ordinaryRoots]) mkdirSync(path, { recursive: true });
    mkdirSync(join(root, "pattern-files", "key"), { recursive: true });
    const linkedControl = join(root, ".config", "linked-control");
    const externalControl = join(root, "external-control");
    mkdirSync(join(root, ".config"), { recursive: true });
    mkdirSync(externalControl);
    symlinkSync(externalControl, linkedControl, hostPlatform === "win32" ? "junction" : "dir");
    const protectedDenies = getDefaultSensitiveWriteDenyPaths();
    const nonCoveringDenies = ["pattern*", "pattern-files/key", "CaseRoot", "caseroot/data", "caf\u00e9", "cafe\u0301/data"]
      .map(path => join(root, ...path.split("/")));
    nonCoveringDenies.push(linkedControl, join(literalRoot, ".vscode"));
    const filesystem = buildPerCommandSandboxCustomConfig({
      allowWrite: [...protectedRoots, ...ordinaryRoots], allowRead: [...protectedRoots, ...ordinaryRoots],
      denyRead: getDefaultSensitiveReadDenyPaths(), denyWrite: [...protectedDenies, ...nonCoveringDenies, deniedParent, deniedChild],
    })?.filesystem;
    const nativeSpelling = (path: string): string => /^[A-Za-z]:[\\/][^:]*$/u.test(path) ? path.replaceAll("/", "\\") : path;
    const writeDenies = filesystem?.denyWrite?.map(entry => typeof entry === "string"
      ? nativeSpelling(entry) : { ...entry, path: nativeSpelling(entry.path) });
    expect(filesystem?.allowWrite).toEqual(platform === "win32" ? [] : [...protectedRoots, ...ordinaryRoots]);
    expect(filesystem?.allowRead).toEqual([xdgRoot, ...ordinaryRoots].map(path => platform === "win32"
      ? { path: realpathSync.native(path), literal: true } : path));
    for (const path of [...protectedRoots, ...ordinaryRoots]) {
      const target = join(platform === "win32" ? realpathSync.native(path) : path, ".bash_profile");
      expect(writeDenies?.some(entry => {
        const base = typeof entry === "string" ? entry : entry.path;
        return target === base || target.startsWith(`${base}\\`);
      }), target).toBe(true);
    }
    expect(protectedDenies).toContain(join(root, ".ave", "diff-cache") + (platform === "win32" ? "\\" : ""));
    if (platform === "darwin") {
      expect(writeDenies).toContain(join(root, ".ave", "diff-cache"));
      for (const path of nonCoveringDenies) expect(writeDenies).toContain(path);
    }
    expect(writeDenies).toContainEqual({ path: join(literalRoot, ".vscode"), literal: true });
    if (platform === "win32") {
      expect(Buffer.byteLength(JSON.stringify(filesystem?.denyWrite))).toBeGreaterThan(65_536);
      expect(realpathSync.native(workRoot)).toBe(join(root, "MiXeD", "work"));
      expect(writeDenies).toContain(join(root, "MiXeD", "work", ".bash_profile"));
      expect(writeDenies).toContain(deniedChild);
      const denyWrite = expandWindowsFsPaths((filesystem?.denyWrite ?? []).map(entry =>
        typeof entry === "string" ? driveFixture.toHost(entry) : { ...entry, path: driveFixture.toHost(entry.path) }), { mode: "deny" });
      const atOrUnder = (parent: string, path: string): boolean => {
        const relative = win32.relative(parent, path);
        return relative === "" || relative !== ".." && !relative.startsWith("..\\") && !win32.isAbsolute(relative);
      };
      const scope = [...protectedRoots, ...ordinaryRoots];
      const mandatory = buildMandatorySandboxWritePolicy(scope.map(path => ({ path: realpathSync.native(path), literal: true })), undefined, protectedDenies);
      expect(Buffer.byteLength(JSON.stringify(mandatory.denyWrite))).toBeGreaterThan(65_536);
      const currentGrants = scope.map(driveFixture.toHost);
      const ranked = rankWindowsFsAccess({
        allowRead: [], allowWrite: currentGrants, denyRead: [], denyWrite, credentialDeny: [],
        held: { grantRead: [], grantWrite: currentGrants },
      });
      for (const target of [deniedChild, ...scope.map(path => join(path, ".bash_profile"))]) {
        const physical = driveFixture.toHost(target);
        expect(ranked.denyWrite.some(deny => atOrUnder(deny, physical)), target).toBe(true);
      }
      expect(ranked.denyWrite).toContain(driveFixture.toHost(interveningGrant));
      const mandatoryTargets = mandatory.denyWrite.map(entry => typeof entry === "string" ? entry : entry.path);
      for (const target of [...mandatoryTargets, ...protectedDenies, ...nonCoveringDenies.filter(path => !path.includes("*")), externalControl]) {
        const physical = driveFixture.toHost(target);
        if (currentGrants.some(grant => atOrUnder(grant, physical))) {
          expect(ranked.denyWrite.some(deny => atOrUnder(deny, physical)), target).toBe(true);
        } else {
          expect(ranked.grantWrite.some(grant => atOrUnder(grant, physical)), target).toBe(false);
        }
      }
      const grantedWrites = (target: string, denies: readonly string[]): string[] => rankWindowsFsAccess({
        allowRead: [], allowWrite: [driveFixture.toHost(target)], denyRead: [], denyWrite: denies, credentialDeny: [],
      }).grantWrite;
      const patternDeny = expandWindowsFsPaths([driveFixture.toHost(join(root, "pattern*"))], { mode: "deny" });
      expect(patternDeny.length).toBeGreaterThan(0);
      expect(grantedWrites(join(root, "pattern-files", "key"), patternDeny)).toEqual([]);
      const literalDeny = expandWindowsFsPaths([{ path: driveFixture.toHost(join(literalRoot, ".vscode")), literal: true }], { mode: "deny" });
      expect(grantedWrites(join(literalRoot, ".vscode"), literalDeny)).toEqual([]);
      const bracketSibling = join(root, "literal1", "temp-directory", ".vscode");
      expect(grantedWrites(bracketSibling, literalDeny)).toEqual([driveFixture.toHost(bracketSibling)]);
      const nfc = join(root, "caf\u00e9");
      const nfd = join(root, "cafe\u0301", "data");
      expect(grantedWrites(nfd, [driveFixture.toHost(nfc)])).toEqual([driveFixture.toHost(nfd)]);
      expect(grantedWrites(nfd, [driveFixture.toHost(nfd)])).toEqual([]);
      const ordinaryFile = join(workRoot, "ordinary.txt");
      expect(ranked.grantWrite.some(grant => atOrUnder(grant, driveFixture.toHost(ordinaryFile)))).toBe(true);
      expect(ranked.denyWrite.some(deny => atOrUnder(deny, driveFixture.toHost(ordinaryFile)))).toBe(false);
      expect(grantedWrites(ordinaryFile, denyWrite)).toEqual([driveFixture.toHost(ordinaryFile)]);
    }
    for (const target of platform === "darwin" ? protectedDenies : []) {
      expect(filesystem?.denyWrite?.some(entry => {
        const base = typeof entry === "string" ? entry : entry.path;
        const relative = win32.relative(base, target);
        return relative === "" || relative !== ".." && !relative.startsWith("..\\") && !win32.isAbsolute(relative);
      }), target).toBe(true);
    }
  });
});
