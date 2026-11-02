/** `spawnMxcBundledHolder`: how an MCP server or hook becomes its own extension holder (design row 5). Row 2's native entry
 * is mocked; these tests pin the layout this adapter hands it and the named refusals it raises before admission. */
import { win32 as winPath } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertSandboxWindowsExtensionPlan } from "../../shared/sandbox-capability-info.js";

const state = vi.hoisted(() => ({
  plan: undefined as unknown,
  live: [] as string[],
  workspaces: [] as string[],
  spawn: vi.fn(),
  files: new Set<string>(),
  dirs: new Set<string>(),
  links: new Map<string, string>(),
  removed: [] as string[],
  readonly: new Set<string>(),
  ops: [] as string[],
  stagingRefusal: undefined as Error | undefined,
  unlinkFail: new Set<string>(),
}));

vi.mock("../../permissions/confined-child.js", () => ({
  spawnMxcConfinedChild: (spec: unknown) => state.spawn(spec),
  spawnConfinedChild: vi.fn(),
  liveMxcHolderWritableRoots: () => state.live,
}));
vi.mock("../../permissions/sandbox-capability.js", async (original) => ({
  ...await original<typeof import("../../permissions/sandbox-capability.js")>(),
  getWindowsExtensionBackendPlan: () => state.plan,
}));
vi.mock("../../permissions/workspace-authorized-roots.js", () => ({ listAuthorizedWorkspaceRoots: () => state.workspaces }));
vi.mock("../../shared/ave-home.js", async (original) => ({
  ...await original<typeof import("../../shared/ave-home.js")>(),
  aveHome: () => "C:\\ave",
}));
// The shared staging-shape check runs for real; a test can make it refuse to prove the adapter defers to it.
vi.mock("../../permissions/mxc-filesystem-ownership.js", async (original) => {
  const actual = await original<typeof import("../../permissions/mxc-filesystem-ownership.js")>();
  return {
    ...actual,
    assertMxcHolderStaging: (input: Parameters<typeof actual.assertMxcHolderStaging>[0]) => {
      if (state.stagingRefusal) throw state.stagingRefusal;
      return actual.assertMxcHolderStaging(input);
    },
  };
});
// A small in-memory Windows drive for drive-letter paths; every other path reaches the real filesystem.
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  const fold = (path: string): string => winPath.normalize(path).toLowerCase();
  const isDrive = (path: unknown): path is string => typeof path === "string" && /^[a-z]:\\/iu.test(path);
  const has = (set: Set<string>, path: string): boolean => [...set].some((entry) => fold(entry) === fold(path));
  const linkOf = (path: string): string | undefined => [...state.links].find(([link]) => fold(link) === fold(path))?.[1];
  const enoent = (path: string): Error => Object.assign(new Error(`ENOENT: ${path}`), { code: "ENOENT" });
  const exists = (path: string): boolean => has(state.files, path) || has(state.dirs, path) || linkOf(path) !== undefined;
  const canonical = (path: string): string => {
    for (const [link, target] of state.links) {
      const key = fold(path);
      if (key === fold(link) || key.startsWith(`${fold(link)}\\`)) return target + winPath.normalize(path).slice(link.length);
    }
    return winPath.normalize(path);
  };
  const realpath = (path: string): string => {
    if (!exists(canonical(path)) && !exists(path)) throw enoent(path);
    return canonical(path);
  };
  return {
    ...actual,
    existsSync: (path: unknown) => isDrive(path) ? exists(path) : actual.existsSync(path as string),
    statSync: ((path: unknown, options?: unknown) => isDrive(path)
      ? { isFile: () => has(state.files, canonical(path)) }
      : actual.statSync(path as string, options as never)) as typeof actual.statSync,
    realpathSync: Object.assign((path: unknown) => isDrive(path) ? realpath(path) : actual.realpathSync(path as string), {
      native: (path: unknown) => isDrive(path) ? realpath(path) : actual.realpathSync.native(path as string),
    }),
    mkdirSync: ((path: unknown, options?: unknown) => {
      if (!isDrive(path)) return actual.mkdirSync(path as string, options as never);
      for (let dir = winPath.normalize(path); winPath.dirname(dir) !== dir; dir = winPath.dirname(dir)) state.dirs.add(dir);
      return undefined;
    }) as typeof actual.mkdirSync,
    lstatSync: ((path: unknown, options?: unknown) => {
      if (!isDrive(path)) return actual.lstatSync(path as string, options as never);
      if (linkOf(path) !== undefined) return { isSymbolicLink: () => true, isDirectory: () => false };
      if (has(state.dirs, path)) return { isSymbolicLink: () => false, isDirectory: () => true };
      if (has(state.files, path)) return { isSymbolicLink: () => false, isDirectory: () => false };
      throw enoent(path);
    }) as typeof actual.lstatSync,
    readdirSync: ((path: unknown, options?: unknown) => {
      if (!isDrive(path)) return actual.readdirSync(path as string, options as never);
      const all = [...state.dirs, ...state.files, ...state.links.keys()];
      return [...new Set(all.filter((entry) => fold(winPath.dirname(entry)) === fold(path) && fold(entry) !== fold(path))
        .map((entry) => winPath.basename(entry)))];
    }) as typeof actual.readdirSync,
    rmdirSync: ((path: unknown) => {
      if (!isDrive(path)) return actual.rmdirSync(path as string);
      state.removed.push(winPath.normalize(path));
      for (const dir of state.dirs) if (fold(dir) === fold(path)) state.dirs.delete(dir);
    }) as typeof actual.rmdirSync,
    renameSync: ((from: unknown, to: unknown) => {
      if (!isDrive(from) || !isDrive(to)) return actual.renameSync(from as string, to as string);
      if (!exists(from)) throw enoent(from);
      state.ops.push(`rename ${winPath.normalize(from)} -> ${winPath.normalize(to)}`);
      const moved = (path: string): string | undefined => fold(path) === fold(from) || fold(path).startsWith(`${fold(from)}\\`)
        ? winPath.normalize(to) + winPath.normalize(path).slice(winPath.normalize(from).length) : undefined;
      for (const set of [state.dirs, state.files, state.readonly]) {
        for (const entry of [...set]) { const next = moved(entry); if (next !== undefined) { set.delete(entry); set.add(next); } }
      }
      for (const [link, target] of [...state.links]) {
        const next = moved(link);
        if (next !== undefined) { state.links.delete(link); state.links.set(next, target); }
      }
    }) as typeof actual.renameSync,
    chmodSync: ((path: unknown, mode: unknown) => {
      if (!isDrive(path)) return actual.chmodSync(path as string, mode as never);
      state.ops.push(`chmod ${winPath.normalize(path)}`);
      if (((mode as number) & 0o200) !== 0) for (const entry of state.readonly) if (fold(entry) === fold(path)) state.readonly.delete(entry);
    }) as typeof actual.chmodSync,
    unlinkSync: ((path: unknown) => {
      if (!isDrive(path)) return actual.unlinkSync(path as string);
      // Windows refuses to delete a file with the read-only attribute.
      if (has(state.readonly, path)) throw Object.assign(new Error(`EPERM: ${path}`), { code: "EPERM" });
      if (has(state.unlinkFail, path)) throw Object.assign(new Error(`EBUSY: ${path}`), { code: "EBUSY" });
      state.ops.push(`unlink ${winPath.normalize(path)}`);
      state.removed.push(winPath.normalize(path));
      for (const file of state.files) if (fold(file) === fold(path)) state.files.delete(file);
      for (const link of state.links.keys()) if (fold(link) === fold(path)) state.links.delete(link);
    }) as typeof actual.unlinkSync,
  };
});

// `renameDirectory` renames through node:fs/promises; drive-letter paths go to the in-memory drive above.
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  const fake = await import("node:fs");
  return {
    ...actual,
    rename: async (from: string, to: string) => /^[a-z]:\\/iu.test(from) ? fake.renameSync(from, to) : actual.rename(from, to),
  };
});

const { readFileSync: actualReadFile } = await vi.importActual<typeof import("node:fs")>("node:fs");
const holderModule = await import("../wrap-bundled-command.js");
const {
  isBashFormCommand,
  isMxcExtensionBackendSelected,
  MxcBashIncompatibleError,
  MxcExecutableNotAdmissibleError,
  MxcHolderEnvironmentRefusedError,
  MxcHolderWorkspaceBusyError,
  registerMxcHolderReadinessProbe,
  spawnMxcBundledHolder,
} = holderModule;
const { planWindowsExtensionHolder } = await import("../../permissions/mxc-extension-readiness.js");
const { MxcCapabilityUnavailableError, MxcProcessCleanupError, MxcProcessContractError } = await import("../../permissions/mxc-extension-errors.js");
const { setProcessPlatform } = await import("../../__tests__/support/process-platform.js");

const READY = planWindowsExtensionHolder({ requested: true, mxc: { state: "available" }, fallback: { version: "0.0.80", ready: false } });
const FALLBACK = planWindowsExtensionHolder({ requested: true, mxc: { state: "unavailable", reason: "native-validation-required" },
  fallback: { version: "0.0.80", ready: true } });
const NODE = "C:\\Program Files\\nodejs\\node.exe";
const REAL_PLATFORM = process.platform;
const probe = vi.fn(async () => { throw new Error("probe is row 2's to call"); });
let unregister: (() => void) | undefined;

type Spec = Record<string, unknown> & { allowRead: string[]; allowWrite: string[]; home: string; temp: string; cwd: string;
  filesystemOwnership: { readRoots: string[]; writeRoots: string[]; hostStorageRoots: string[] } };
const spawned = { process: { id: 7 }, confinement: "windows-mxc" as const, release: vi.fn(async () => undefined) };

function input(overrides: Partial<Parameters<typeof spawnMxcBundledHolder>[0]> = {}): Parameters<typeof spawnMxcBundledHolder>[0] {
  return {
    label: "mcp:fs",
    command: "node",
    args: ["C:\\ave\\plugins\\fs\\gen\\server.js"],
    baseEnv: { PATH: "relative\\bin;C:\\Program Files\\nodejs", SystemRoot: "C:\\Windows" },
    holderEnv: { API_TOKEN: "t" },
    allowRead: ["C:\\ave\\plugins\\fs\\gen"],
    allowWrite: ["C:\\ave\\mcp\\fs\\sandbox"],
    ownedReadRoots: ["C:\\ave\\plugins\\fs\\gen"],
    egressOwner: { kind: "worker", role: "mcp-server", pluginId: undefined, instanceId: "fs" },
    ...overrides,
  };
}

function lastSpec(): Spec {
  return state.spawn.mock.calls.at(-1)![0] as Spec;
}

beforeEach(() => {
  setProcessPlatform("win32");
  state.plan = READY;
  state.live = [];
  state.workspaces = ["D:\\work"];
  state.files = new Set([NODE, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    "C:\\Program Files\\Git\\bin\\bash.exe", "C:\\Program Files\\nodejs\\npx.cmd", "D:\\work\\tool.exe", "C:\\ave\\mcp\\fs\\sandbox\\tool.exe"]);
  state.dirs = new Set(["C:\\ave\\mcp\\fs\\sandbox", "C:\\ave\\plugins\\fs\\gen", "D:\\work"]);
  state.links = new Map();
  state.removed = [];
  state.readonly = new Set();
  state.ops = [];
  state.stagingRefusal = undefined;
  state.unlinkFail = new Set();
  state.spawn.mockReset();
  state.spawn.mockResolvedValue(spawned);
  spawned.release.mockReset();
  spawned.release.mockResolvedValue(undefined);
  unregister = registerMxcHolderReadinessProbe(probe);
});

afterEach(() => {
  unregister?.();
  setProcessPlatform(REAL_PLATFORM);
});

describe("container holder selection", () => {
  it("is selected only by a ready container plan on Windows", () => {
    expect(isMxcExtensionBackendSelected()).toBe(true);
    state.plan = FALLBACK;
    expect(isMxcExtensionBackendSelected()).toBe(false);
    state.plan = READY;
    setProcessPlatform("darwin");
    expect(isMxcExtensionBackendSelected()).toBe(false);
    setProcessPlatform("linux");
    expect(isMxcExtensionBackendSelected()).toBe(false);
  });

  it("stays gated in production: boot still reports native-validation-required, which selects no container holder", () => {
    const source = actualReadFile("src/boot/steps/sandbox-init.ts", "utf8");
    expect(source).toContain('extensionMxc: { state: "unavailable", reason: "native-validation-required" }');
    for (const ready of [true, false]) {
      state.plan = planWindowsExtensionHolder({ requested: true, mxc: { state: "unavailable", reason: "native-validation-required" },
        fallback: { version: "0.0.80", ready } });
      expect(isMxcExtensionBackendSelected()).toBe(false);
    }
  });

  it("refuses to run when the container backend is not selected", async () => {
    state.plan = FALLBACK;
    await expect(spawnMxcBundledHolder(input())).rejects.toBeInstanceOf(MxcProcessContractError);
    expect(state.spawn).not.toHaveBeenCalled();
  });

  it("fails closed with capability-unavailable when no readiness probe is registered", async () => {
    unregister?.();
    unregister = undefined;
    await expect(spawnMxcBundledHolder(input())).rejects.toBeInstanceOf(MxcCapabilityUnavailableError);
    expect(state.spawn).not.toHaveBeenCalled();
    expect([...state.dirs].some((dir) => dir.includes("mxc-staging"))).toBe(false);
  });

  it("allows one registered probe and hands exactly it to the native entry", async () => {
    expect(() => registerMxcHolderReadinessProbe(probe)).toThrow(MxcProcessContractError);
    await spawnMxcBundledHolder(input());
    expect(lastSpec().probe).toBe(probe);
  });
});

describe("bash-incompatible before admission", () => {
  it.each(["bash", "bash.exe", "sh", "C:\\Program Files\\Git\\bin\\bash.exe", "/usr/bin/sh",
    "C:\\Program Files\\Git\\git-bash.exe", "C:\\Program Files\\Git\\usr\\bin\\env.exe"])("refuses %s by name", async (command) => {
    const refusal = await spawnMxcBundledHolder(input({ command })).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(MxcBashIncompatibleError);
    const plan = (refusal as InstanceType<typeof MxcBashIncompatibleError>).plan;
    assertSandboxWindowsExtensionPlan(plan);
    expect(plan).toMatchObject({ reason: "bash-incompatible", readiness: "unavailable", selectedBackend: "none", fallbackVersion: null });
    expect((refusal as { code: string }).code).toBe("bash-incompatible");
    expect(state.spawn).not.toHaveBeenCalled();
  });

  it("refuses an MSYS flavor whatever its name, and leaves a non-bash program alone", () => {
    expect(isBashFormCommand("C:\\msys64\\usr\\bin\\zsh.exe", "msys")).toBe(true);
    // Git for Windows ships its MSYS runtime programs under `usr\bin`, and `git-bash.exe` is its bash launcher.
    expect(isBashFormCommand("C:\\Program Files\\Git\\usr\\bin\\env.exe")).toBe(true);
    expect(isBashFormCommand("C:\\Program Files\\Git\\git-bash.exe")).toBe(true);
    expect(isBashFormCommand("git-bash")).toBe(true);
    expect(isBashFormCommand("C:\\Program Files\\Git\\cmd\\git.exe")).toBe(false);
    expect(isBashFormCommand("C:\\usr\\binaries\\tool.exe")).toBe(false);
    expect(isBashFormCommand("C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")).toBe(false);
    expect(isBashFormCommand("C:\\tools\\bashful.exe")).toBe(false);
    expect(isBashFormCommand(NODE, "wsl")).toBe(false);
  });

  it("starts a PowerShell control", async () => {
    await spawnMxcBundledHolder(input({ command: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" }));
    expect(state.spawn).toHaveBeenCalledTimes(1);
  });
});

describe("executable rule", () => {
  it("resolves a PATH program to its canonical .exe and reads only its directory", async () => {
    await spawnMxcBundledHolder(input());
    const spec = lastSpec();
    expect(spec.command).toBe(NODE);
    expect(spec.allowRead).toEqual(["C:\\ave\\plugins\\fs\\gen", "C:\\Program Files\\nodejs"]);
  });

  it.each([
    ["a relative path", ".\\tool.exe"],
    ["a script shim", "npx.cmd"],
    ["a missing program", "absent"],
    ["a workspace executable", "D:\\work\\tool.exe"],
    ["an executable in its own writable root", "C:\\ave\\mcp\\fs\\sandbox\\tool.exe"],
  ])("refuses %s with a named admission error", async (_case, command) => {
    const refusal = await spawnMxcBundledHolder(input({ command })).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(MxcExecutableNotAdmissibleError);
    expect((refusal as { code: string }).code).toBe("executable-not-admissible");
    expect(state.spawn).not.toHaveBeenCalled();
  });

  it("refuses an executable inside a live holder's writable root", async () => {
    state.live = ["C:\\Program Files\\nodejs"];
    await expect(spawnMxcBundledHolder(input())).rejects.toBeInstanceOf(MxcExecutableNotAdmissibleError);
  });

  it("refuses a workspace executable reached through a junction", async () => {
    state.links.set("C:\\linked", "D:\\work");
    await expect(spawnMxcBundledHolder(input({ command: "C:\\linked\\tool.exe" }))).rejects.toBeInstanceOf(MxcExecutableNotAdmissibleError);
  });

  it("refuses an executable inside the caller-named workspace (a user hook's cwd)", async () => {
    state.workspaces = [];
    state.files.add("E:\\proj\\run.exe");
    await expect(spawnMxcBundledHolder(input({ command: "E:\\proj\\run.exe", workspaceRoots: ["E:\\proj"] })))
      .rejects.toBeInstanceOf(MxcExecutableNotAdmissibleError);
  });
});

describe("workspace concurrency", () => {
  const userHook = (): Parameters<typeof spawnMxcBundledHolder>[0] => input({ label: "hook:user",
    command: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", allowRead: [], allowWrite: ["D:\\work"],
    ownedReadRoots: [], cwd: "D:\\work", workspaceRoots: ["D:\\work"] });

  it("refuses a workspace writer while another live holder writes that workspace, without queueing it", async () => {
    state.live = ["d:\\work\\sub"];
    const refusal = await spawnMxcBundledHolder(userHook()).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(MxcHolderWorkspaceBusyError);
    expect((refusal as { code: string }).code).toBe("holder-workspace-busy");
    expect(state.spawn).not.toHaveBeenCalled();
  });

  it("starts the workspace writer when no live holder writes there", async () => {
    state.live = ["C:\\ave\\plugins\\other\\data"];
    await spawnMxcBundledHolder(userHook());
    expect(lastSpec().allowWrite[0]).toBe("D:\\work");
    expect(lastSpec().cwd).toBe("D:\\work");
  });

  it("leaves a non-workspace overlap to row 2's nesting check", async () => {
    state.live = ["C:\\ave\\mcp\\fs\\sandbox"];
    await spawnMxcBundledHolder(input());
    expect(state.spawn).toHaveBeenCalledTimes(1);
  });
});

describe("environment before admission", () => {
  const stagingRoots = (): number => [...state.dirs].filter((dir) => /mxc-staging\\[0-9a-f]{32}$/u.test(dir)).length;

  it.each([
    [{ NODE_OPTIONS: "--require C:\\x\\loader.js" }, {}, "NODE_OPTIONS"],
    [{}, { NODE_PATH: "C:\\x\\modules" }, "NODE_PATH"],
    [{ ELECTRON_RUN_AS_NODE: "0" }, {}, "ELECTRON_RUN_AS_NODE"],
    [{ node_options: "--inspect=0.0.0.0:9229" }, { AVE_MXC_FFI: "C:\\x" }, "AVE_MXC_FFI, NODE_OPTIONS"],
  ])("refuses %o / %o by key name only, before staging or the native entry", async (baseEnv, holderEnv, keys) => {
    const before = stagingRoots();
    const refusal = await spawnMxcBundledHolder(input({ baseEnv: { ...input().baseEnv, ...baseEnv },
      holderEnv: { ...input().holderEnv, ...holderEnv } })).then(() => undefined, (error: unknown) => error as Error & { code?: string });
    if (refusal === undefined) throw new Error("the holder start was expected to be refused");
    expect(refusal).toBeInstanceOf(MxcHolderEnvironmentRefusedError);
    expect(refusal.code).toBe("holder-environment-refused");
    expect(refusal.message).toMatch(new RegExp(`: ${keys}$`, "u"));
    for (const value of [...Object.values(baseEnv), ...Object.values(holderEnv)]) expect(refusal.message).not.toContain(value);
    expect(state.spawn).not.toHaveBeenCalled();
    expect(stagingRoots()).toBe(before);
  });

  it("admits ELECTRON_RUN_AS_NODE=1, the value the bundled runtime needs", async () => {
    await spawnMxcBundledHolder(input({ holderEnv: { ELECTRON_RUN_AS_NODE: "1" } }));
    expect(state.spawn).toHaveBeenCalledTimes(1);
  });
});

describe("holder layout", () => {
  it("gives the holder its own staging HOME/temp sibling and its own incarnation, passing host env through", async () => {
    await spawnMxcBundledHolder(input());
    const first = lastSpec();
    const match = /^C:\\ave\\mxc-staging\\([0-9a-f]{32})\\home$/u.exec(first.home);
    expect(match).not.toBeNull();
    const root = `C:\\ave\\mxc-staging\\${match![1]}`;
    expect(first.temp).toBe(`${root}\\temp`);
    expect(first.allowWrite).toEqual(["C:\\ave\\mcp\\fs\\sandbox", root]);
    expect(first.filesystemOwnership).toEqual({ readRoots: ["C:\\ave\\plugins\\fs\\gen"],
      writeRoots: ["C:\\ave\\mcp\\fs\\sandbox", root], hostStorageRoots: [] });
    expect(first.cwd).toBe(first.home);
    expect(first.holderEnv).toEqual({ API_TOKEN: "t" });
    expect(first.egressOwner).toEqual({ kind: "worker", role: "mcp-server", pluginId: undefined, instanceId: "fs" });
    await spawnMxcBundledHolder(input());
    const second = lastSpec();
    expect(second.home).not.toBe(first.home);
    expect(second.holder).not.toBe(first.holder);
  });

  it("honors a configured cwd only inside the admitted roots and never adds it", async () => {
    await spawnMxcBundledHolder(input({ cwd: "C:\\ave\\plugins\\fs\\gen" }));
    expect(lastSpec().cwd).toBe("C:\\ave\\plugins\\fs\\gen");
    state.spawn.mockClear();
    const stagingRoots = (): number => [...state.dirs].filter((dir) => /mxc-staging\\[0-9a-f]{32}$/u.test(dir)).length;
    const before = stagingRoots();
    await expect(spawnMxcBundledHolder(input({ cwd: "D:\\elsewhere" }))).rejects.toBeInstanceOf(MxcProcessContractError);
    expect(state.spawn).not.toHaveBeenCalled();
    expect(stagingRoots()).toBe(before);
  });
});

describe("teardown", () => {
  it("removes the staging tree after verified termination without following a planted link", async () => {
    const holder = await spawnMxcBundledHolder(input());
    const temp = lastSpec().temp;
    state.links.set(`${temp}\\escape`, "D:\\work");
    await holder.release();
    await holder.release();
    expect(spawned.release).toHaveBeenCalledTimes(1);
    // Removal runs on the retired sibling, so the link is unlinked under that name.
    expect(state.removed.some((path) => /\\retired-[0-9a-f]{32}\\temp\\escape$/u.test(path))).toBe(true);
    expect(temp).toMatch(/\\temp$/u);
    expect(state.removed.some((path) => path.startsWith("D:\\work"))).toBe(false);
    expect(state.dirs.has("D:\\work")).toBe(true);
    expect([...state.dirs].some((dir) => /mxc-staging\\[0-9a-f]{32}/u.test(dir))).toBe(false);
  });

  it("renames the tree to a random sibling before deleting anything inside it", async () => {
    const holder = await spawnMxcBundledHolder(input());
    const root = winPath.dirname(lastSpec().home);
    state.files.add(`${root}\\temp\\scratch.txt`);
    await holder.release();
    const rename = state.ops.findIndex((op) => op.startsWith(`rename ${root} -> `));
    expect(rename).toBe(0);
    expect(state.ops[0]).toMatch(/ -> C:\\ave\\mxc-staging\\retired-[0-9a-f]{32}$/u);
    expect(state.ops.slice(1).every((op) => !op.includes(root + "\\"))).toBe(true);
    expect(state.removed.some((path) => /retired-[0-9a-f]{32}\\temp\\scratch\.txt$/u.test(path))).toBe(true);
    expect([...state.dirs].some((dir) => /mxc-staging\\(?:retired-)?[0-9a-f]{32}/u.test(dir))).toBe(false);
  });

  it("clears a read-only attribute before unlinking, and never chmods a planted link", async () => {
    const holder = await spawnMxcBundledHolder(input());
    const temp = lastSpec().temp;
    state.files.add(`${temp}\\locked.txt`);
    state.readonly.add(`${temp}\\locked.txt`);
    state.links.set(`${temp}\\escape`, "D:\\work\\tool.exe");
    await holder.release();
    const chmod = state.ops.findIndex((op) => /^chmod .*\\locked\.txt$/u.test(op));
    const unlink = state.ops.findIndex((op) => /^unlink .*\\locked\.txt$/u.test(op));
    expect(chmod).toBeGreaterThan(-1);
    expect(unlink).toBeGreaterThan(chmod);
    expect(state.ops.some((op) => /^chmod .*\\escape$/u.test(op))).toBe(false);
    expect(state.files.has("D:\\work\\tool.exe")).toBe(true);
    expect([...state.dirs].some((dir) => /mxc-staging\\(?:retired-)?[0-9a-f]{32}/u.test(dir))).toBe(false);
  });

  it("sweeps leftover retired trees at the next start without following a link or touching a live holder's tree", async () => {
    const P = "C:\\ave\\mxc-staging";
    const live = `${P}\\0123456789abcdef0123456789abcdef`;
    state.dirs.add(P);
    state.dirs.add(`${P}\\retired-aaaa`);
    state.dirs.add(`${P}\\retired-aaaa\\temp`);
    state.files.add(`${P}\\retired-aaaa\\temp\\locked.txt`);
    state.readonly.add(`${P}\\retired-aaaa\\temp\\locked.txt`);
    state.links.set(`${P}\\retired-x`, "D:\\work");
    state.dirs.add(`${P}\\retired-held`);
    state.dirs.add(live);
    state.live = [`${P}\\retired-held\\temp`, live];
    await spawnMxcBundledHolder(input());
    expect(state.spawn).toHaveBeenCalledTimes(1);
    expect(state.dirs.has(`${P}\\retired-aaaa`)).toBe(false);
    expect(state.files.has(`${P}\\retired-aaaa\\temp\\locked.txt`)).toBe(false);
    // The link is unlinked itself; its target and everything under it stay.
    expect(state.links.has(`${P}\\retired-x`)).toBe(false);
    expect(state.removed).toContain(`${P}\\retired-x`);
    expect(state.removed.some((path) => path.startsWith("D:\\work"))).toBe(false);
    expect(state.files.has("D:\\work\\tool.exe")).toBe(true);
    expect(state.ops.some((op) => op === `chmod ${P}\\retired-x`)).toBe(false);
    expect(state.dirs.has(`${P}\\retired-held`)).toBe(true);
    expect(state.dirs.has(live)).toBe(true);
  });

  it("only warns when a leftover retired tree cannot be removed, and still starts the holder", async () => {
    const P = "C:\\ave\\mxc-staging";
    state.dirs.add(P);
    state.dirs.add(`${P}\\retired-busy`);
    state.files.add(`${P}\\retired-busy\\held.dll`);
    state.unlinkFail.add(`${P}\\retired-busy\\held.dll`);
    await spawnMxcBundledHolder(input());
    expect(state.spawn).toHaveBeenCalledTimes(1);
    expect(state.files.has(`${P}\\retired-busy\\held.dll`)).toBe(true);
  });

  it("forms staging through the shared staging-shape check, before creating a holder directory", async () => {
    state.stagingRefusal = new MxcProcessContractError("shape refused");
    await expect(spawnMxcBundledHolder(input())).rejects.toThrow("shape refused");
    expect(state.spawn).not.toHaveBeenCalled();
    expect([...state.dirs].some((dir) => /mxc-staging\\[0-9a-f]{32}/u.test(dir))).toBe(false);
  });

  it("refuses a staging parent that is a link before creating any holder directory or starting anything", async () => {
    state.links.set("C:\\ave\\mxc-staging", "D:\\work");
    await expect(spawnMxcBundledHolder(input())).rejects.toThrow(/staging parent is a link/u);
    expect(state.spawn).not.toHaveBeenCalled();
    expect([...state.dirs].some((dir) => /^D:\\work\\[0-9a-f]{32}/iu.test(dir) || /mxc-staging\\[0-9a-f]{32}/u.test(dir))).toBe(false);
  });

  it("stays quarantined with its staging tree when termination is unverified, and retries cleanup", async () => {
    const holder = await spawnMxcBundledHolder(input());
    const home = lastSpec().home;
    spawned.release.mockRejectedValueOnce(new MxcProcessCleanupError("death unverified"));
    await expect(holder.release()).rejects.toBeInstanceOf(MxcProcessCleanupError);
    expect(holder.quarantined).toBe(true);
    expect(state.dirs.has(home)).toBe(true);
    await holder.release();
    expect(spawned.release).toHaveBeenCalledTimes(2);
    expect(holder.quarantined).toBe(true);
  });

  it("keeps staging after an unverified startup cleanup and removes it after any other startup failure", async () => {
    state.spawn.mockRejectedValueOnce(new MxcProcessCleanupError("startup cleanup unverified"));
    await expect(spawnMxcBundledHolder(input())).rejects.toBeInstanceOf(MxcProcessCleanupError);
    const kept = (state.spawn.mock.calls[0]![0] as Spec).home;
    expect(state.dirs.has(kept)).toBe(true);
    state.spawn.mockRejectedValueOnce(new MxcProcessContractError("refused"));
    await expect(spawnMxcBundledHolder(input())).rejects.toBeInstanceOf(MxcProcessContractError);
    const removed = (state.spawn.mock.calls[1]![0] as Spec).home;
    expect(state.dirs.has(removed)).toBe(false);
  });
});
