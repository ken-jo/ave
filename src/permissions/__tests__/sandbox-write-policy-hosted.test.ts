const driveFixture = vi.hoisted(() => ({ enabled: false, backing: "" }));

vi.mock("node:path", async original => {
  const actual = await original<typeof import("node:path")>();
  const paths = Object.fromEntries(Object.entries(actual).map(([key, value]) => [key, typeof value === "function"
    ? (...args: unknown[]) => Reflect.apply(driveFixture.enabled ? actual.win32[key as keyof typeof actual.win32] as (...args: unknown[]) => unknown : value, undefined, args)
    : value]));
  Object.defineProperty(paths, "sep", { get: () => driveFixture.enabled ? "\\" : actual.sep });
  return { ...paths, default: paths };
});

vi.mock("node:fs", async original => {
  const actual = await original<typeof import("node:fs")>();
  const paths = await vi.importActual<typeof import("node:path")>("node:path");
  const toHost = (path: unknown): unknown => {
    if (!driveFixture.enabled || process.platform === "win32" || typeof path !== "string") return path;
    if (/^[Dd]:[\\/]/u.test(path)) return paths.join(driveFixture.backing, ...path.slice(3).split(/[\\/]/u));
    if (/^[\\/]/u.test(path)) return paths.join(driveFixture.backing, ...path.slice(1).split(/[\\/]/u));
    return path;
  };
  const toNative = (path: string): string => path.startsWith(driveFixture.backing)
    ? paths.win32.join("D:\\", paths.relative(driveFixture.backing, path)) : path;
  const wrap = (fn: (...args: unknown[]) => unknown) => (...args: unknown[]) => Reflect.apply(fn, undefined, [toHost(args[0]), ...args.slice(1)]);
  const realpath = (fn: (...args: unknown[]) => string) => (...args: unknown[]) => {
    const value = Reflect.apply(fn, undefined, [toHost(args[0]), ...args.slice(1)]);
    return driveFixture.enabled && process.platform !== "win32" ? toNative(value) : value;
  };
  const realpathSync = Object.assign(realpath(actual.realpathSync as (...args: unknown[]) => string), {
    native: realpath(actual.realpathSync.native as (...args: unknown[]) => string),
  });
  const methods = ["lstatSync", "statSync", "openSync", "opendirSync", "readFileSync", "readdirSync", "mkdirSync", "writeFileSync"] as const;
  return { ...actual, ...Object.fromEntries(methods.map(key => [key, wrap(actual[key] as (...args: unknown[]) => unknown)])), realpathSync,
    symlinkSync: (target: string, path: string, type?: "dir" | "file" | "junction") => actual.symlinkSync(toHost(target) as string, toHost(path) as string, type),
    readlinkSync: (path: string) => {
      const target = actual.readlinkSync(toHost(path) as string);
      return driveFixture.enabled && process.platform !== "win32" ? toNative(target) : target;
    },
  };
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
import { configureHostResources } from "../../main/host-resources.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { buildPerCommandSandboxCustomConfig, getDefaultSensitiveReadDenyPaths, getDefaultSensitiveWriteDenyPaths } from "../asrt-sandbox.js";

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

  it("keeps long native drive roots within the policy budget without reopening the floor", () => {
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    driveFixture.backing = realpathSync(mkdtempSync(join(os.tmpdir(), "sandbox-drive-policy-")));
    driveFixture.enabled = hostPlatform !== "win32";
    setProcessPlatform("darwin");
    const root = hostPlatform === "win32"
      ? join(driveFixture.backing, "a", "_temp", `hosted-checkout-${"x".repeat(48)}`)
      : win32.join("D:\\", "a", "_temp", `native-hosted-runner-${"x".repeat(76)}`, `hosted-checkout-${"x".repeat(48)}`);
    vi.spyOn(os, "homedir").mockReturnValue(root);
    vi.stubEnv("HOME", root);
    vi.stubEnv("USERPROFILE", root);
    vi.stubEnv("AVE_HOME", join(root, ".ave"));
    vi.stubEnv("XDG_CONFIG_HOME", join(root, "xdg"));
    const xdgRoot = join(root, "xdg", "Ave", "Partitions");
    const protectedRoots = [...[".ave/secrets/work", ".ave/audit", ".ave/routine/work", ".ssh/work"]
      .map(path => join(root, ...path.split("/"))), xdgRoot];
    const literalRoot = join(root, "literal[1]", "temp-directory");
    const ordinaryRoots = [...["work", ".ave/plugins/p/data", ".ave/mcp/s/sandbox", "temp/owned"]
      .map(path => join(root, ...path.split("/"))), literalRoot];
    for (const path of [...protectedRoots, ...ordinaryRoots]) mkdirSync(path, { recursive: true });
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
      denyRead: getDefaultSensitiveReadDenyPaths(), denyWrite: [...protectedDenies, ...nonCoveringDenies],
    })?.filesystem;
    expect(filesystem?.allowWrite).toEqual([...protectedRoots, ...ordinaryRoots]);
    expect(filesystem?.allowRead).toEqual([xdgRoot, ...ordinaryRoots]);
    for (const path of [...protectedRoots, ...ordinaryRoots]) {
      const target = join(path, ".bash_profile");
      expect(filesystem?.denyWrite?.some(entry => {
        const base = typeof entry === "string" ? entry : entry.path;
        return target === base || target.startsWith(`${base}\\`);
      }), target).toBe(true);
    }
    expect(filesystem?.denyWrite).toContain(join(root, ".ave", "diff-cache"));
    for (const path of nonCoveringDenies) expect(filesystem?.denyWrite).toContain(path);
    expect(filesystem?.denyWrite).toContainEqual({ path: join(literalRoot, ".vscode"), literal: true });
    for (const target of protectedDenies) {
      expect(filesystem?.denyWrite?.some(entry => {
        const base = typeof entry === "string" ? entry : entry.path;
        const relative = win32.relative(base, target);
        return relative === "" || relative !== ".." && !relative.startsWith("..\\") && !win32.isAbsolute(relative);
      }), target).toBe(true);
    }
  });
});
