/** `spawnMxcBundledHolder`: how an MCP server or hook becomes its own extension holder (design row 5). Row 2's native entry
 * is mocked; these tests pin the layout this adapter hands it and the named refusals it raises before admission. */
import { win32 as winPath } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SIMULATED_MXC_RUNTIME_ROOT, SYNTHETIC_MXC_STAGING_PARENT } from "../../__tests__/support/mxc-staging-parent.js";
import { escapeRegExp } from "../../shared/escape-reg-exp.js";
import { assertSandboxWindowsExtensionPlan } from "../../shared/sandbox-capability-info.js";

const STAGING_PATH_PREFIX = `${SYNTHETIC_MXC_STAGING_PARENT}\\`;
const STAGING_PARENT_PATTERN = escapeRegExp(SYNTHETIC_MXC_STAGING_PARENT);
const STAGING_ROOT_PATTERN = new RegExp(String.raw`^${STAGING_PARENT_PATTERN}\\[0-9a-f]{32}$`, "u");
const STAGING_TREE_PATTERN = new RegExp(String.raw`^${STAGING_PARENT_PATTERN}\\[0-9a-f]{32}`, "u");

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
  contents: new Map<string, string>(),
  stagingParentRefusal: undefined as Error | undefined,
  /** The call to `mxcStagingParent`, counted from 1, at which the refusal starts. */
  stagingParentRefusalFrom: 1,
  stagingParentCalls: 0,
  renameFail: new Map<string, string>(),
  probe: vi.fn(),
}));

// The in-memory drive has no directory identities: recording the issued HOME is observed, not performed.
vi.mock("../../permissions/sandbox-home-registry.js", async (original) => ({
  ...await original<typeof import("../../permissions/sandbox-home-registry.js")>(),
  recordIssuedContainerHome: vi.fn(), forgetIssuedContainerHome: vi.fn(),
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
// The staging parent start-up establishes under the runtime root, on the in-memory drive below.
vi.mock("../../permissions/mxc-runtime-root.js", async (original) => {
  const { SYNTHETIC_MXC_STAGING_PARENT } = await import("../../__tests__/support/mxc-staging-parent.js");
  return {
    ...await original<typeof import("../../permissions/mxc-runtime-root.js")>(),
    mxcStagingParent: () => {
      state.stagingParentCalls += 1;
      if (state.stagingParentRefusal !== undefined && state.stagingParentCalls >= state.stagingParentRefusalFrom) throw state.stagingParentRefusal;
      return SYNTHETIC_MXC_STAGING_PARENT;
    },
  };
});
vi.mock("../../permissions/windows-process-start-time.js", () => ({ readWindowsProcessRunStates: state.probe }));
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
      if (linkOf(path) !== undefined) return { isSymbolicLink: () => true, isDirectory: () => false, isFile: () => false };
      if (has(state.dirs, path)) return { isSymbolicLink: () => false, isDirectory: () => true, isFile: () => false };
      if (has(state.files, path)) {
        return { isSymbolicLink: () => false, isDirectory: () => false, isFile: () => true, nlink: 1, size: state.contents.get(fold(path))?.length ?? 0 };
      }
      if ((options as { throwIfNoEntry?: boolean } | undefined)?.throwIfNoEntry === false) return undefined;
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
      const refused = [...state.renameFail].find(([path]) => fold(path) === fold(from))?.[1];
      if (refused !== undefined) throw Object.assign(new Error(`${refused}: ${from}`), { code: refused });
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
    writeFileSync: ((path: unknown, data: unknown, options?: unknown) => {
      if (!isDrive(path)) return actual.writeFileSync(path as string, data as string, options as never);
      if ((options as { flag?: string } | undefined)?.flag === "wx" && exists(path)) throw Object.assign(new Error(`EEXIST: ${path}`), { code: "EEXIST" });
      state.files.add(winPath.normalize(path));
      state.contents.set(fold(path), String(data));
    }) as typeof actual.writeFileSync,
    readFileSync: ((path: unknown, options?: unknown) => (isDrive(path) ? state.contents.get(fold(path)) : undefined)
      ?? actual.readFileSync(path as string, options as never)) as typeof actual.readFileSync,
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
const { MxcRuntimeRootError } = await import("../../permissions/mxc-runtime-root.js");
const {
  isBashFormCommand,
  isMxcExtensionBackendSelected,
  MxcBashIncompatibleError,
  MxcExecutableNotAdmissibleError,
  MxcHolderEnvironmentRefusedError,
  MxcHolderWorkspaceBusyError,
  spawnMxcBundledHolder,
} = holderModule;
const { registerMxcReleaseGateEvidence } = await import("../../permissions/mxc-extension-admission.js");
const { forgetIssuedContainerHome, recordIssuedContainerHome } = await import("../../permissions/sandbox-home-registry.js");
const { MXC_RELEASE_GATE_EVIDENCE } = await import("../../__tests__/support/mxc-supervisor.js");
const { prepareMxcPluginChildLaunch } = await import("../../plugins/isolation/mxc-plugin-child-launch.js");
const { resolvePluginHostStorageDir } = await import("../../plugins/plugin-storage-layout.js");
const { planWindowsExtensionHolder } = await import("../../permissions/mxc-extension-readiness.js");
const { MxcCapabilityUnavailableError, MxcProcessCleanupError, MxcProcessContractError } = await import("../../permissions/mxc-extension-errors.js");
const { setProcessPlatform } = await import("../../__tests__/support/process-platform.js");
const { WorkerTransportUnsupportedError, MxcNativeEntryRequiredError, MxcExtensionReadinessRefusedError } = await import("../../permissions/mxc-extension-errors.js");
const { PluginChildTerminationUnverifiedError } = await import("../../plugins/isolation/plugin-child-transport.js");
const { getLocale, setLocale, t } = await import("../../i18n/runtime.js");

const READY = planWindowsExtensionHolder({ requested: true, mxc: { state: "available" }, fallback: { version: "0.0.80", ready: false } });
const FALLBACK = planWindowsExtensionHolder({ requested: true, mxc: { state: "unavailable", reason: "native-validation-required" },
  fallback: { version: "0.0.80", ready: true } });
const NODE = "C:\\Program Files\\nodejs\\node.exe";
const REAL_PLATFORM = process.platform;
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
  state.contents = new Map();
  state.stagingParentRefusal = undefined;
  state.stagingParentRefusalFrom = 1;
  state.stagingParentCalls = 0;
  state.renameFail = new Map();
  state.probe.mockReset();
  state.probe.mockResolvedValue(new Map());
  state.spawn.mockReset();
  state.spawn.mockResolvedValue(spawned);
  spawned.release.mockReset();
  spawned.release.mockResolvedValue(undefined);
  unregister = registerMxcReleaseGateEvidence(MXC_RELEASE_GATE_EVIDENCE);
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

  it("fails closed with capability-unavailable when no release-gate evidence is registered", async () => {
    unregister?.();
    unregister = undefined;
    await expect(spawnMxcBundledHolder(input())).rejects.toBeInstanceOf(MxcCapabilityUnavailableError);
    expect(state.spawn).not.toHaveBeenCalled();
    expect([...state.dirs].some((dir) => dir.includes("\\staging"))).toBe(false);
  });

  it.each(Object.keys(MXC_RELEASE_GATE_EVIDENCE) as (keyof typeof MXC_RELEASE_GATE_EVIDENCE)[])(
    "fails closed when the release-gate record did not observe %s", async (field) => {
      unregister?.();
      unregister = registerMxcReleaseGateEvidence({ ...MXC_RELEASE_GATE_EVIDENCE, [field]: false });
      await expect(spawnMxcBundledHolder(input())).rejects.toBeInstanceOf(MxcCapabilityUnavailableError);
      expect(state.spawn).not.toHaveBeenCalled();
      expect([...state.dirs].some((dir) => dir.includes("mxc-staging"))).toBe(false);
    });

  it("allows one release-gate record per installation and hands the native entry no per-start probe", async () => {
    expect(() => registerMxcReleaseGateEvidence(MXC_RELEASE_GATE_EVIDENCE)).toThrow(MxcProcessContractError);
    await spawnMxcBundledHolder(input());
    expect(lastSpec()).not.toHaveProperty("probe");
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
    ["a relative path", ".\\tool.exe", /is a relative path/u],
    ["a script shim", "npx.cmd", /is not a Windows executable \(\.exe\)/u],
    ["a missing program", "absent", /was not found as a Windows executable/u],
    // The profile-rooted session case is named so the user can see why an npm global program is refused.
    ["a workspace executable", "D:\\work\\tool.exe", /open project folder.*%APPDATA%\\npm/u],
    ["an executable in its own writable root", "C:\\ave\\mcp\\fs\\sandbox\\tool.exe", /a folder a contained process can write/u],
  ])("refuses %s with a named admission error", async (_case, command, detail) => {
    const previous = getLocale();
    setLocale("en");
    const refusal = await spawnMxcBundledHolder(input({ command })).catch((error: unknown) => error).finally(() => setLocale(previous));
    expect(refusal).toBeInstanceOf(MxcExecutableNotAdmissibleError);
    expect((refusal as { code: string }).code).toBe("executable-not-admissible");
    expect((refusal as Error).message).toMatch(detail);
    expect((refusal as Error).message.endsWith("(executable-not-admissible)")).toBe(true);
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
    // An ordinary overlap does not claim the profile / AVE_HOME case.
    expect((refusal as { stagingOverlap: boolean }).stagingOverlap).toBe(false);
    expect((refusal as Error).message).toBe(t("be_wrapBundledCommand.workspaceBusy", { code: "holder-workspace-busy" }));
    expect(state.spawn).not.toHaveBeenCalled();
  });

  it("names the staging overlap when the hook's workspace contains another holder's private folder", async () => {
    // A user hook rooted above the runtime root: its workspace write contains the staging parent, where a live MCP server keeps its staging.
    state.live = [winPath.join(SYNTHETIC_MXC_STAGING_PARENT, "0123456789abcdef0123456789abcdef")];
    const workspace = winPath.dirname(SIMULATED_MXC_RUNTIME_ROOT);
    const refusal = await spawnMxcBundledHolder(input({ label: "hook:user",
      command: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe", allowRead: [], allowWrite: [workspace],
      ownedReadRoots: [], cwd: workspace, workspaceRoots: [workspace] })).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(MxcHolderWorkspaceBusyError);
    expect((refusal as { stagingOverlap: boolean }).stagingOverlap).toBe(true);
    expect((refusal as Error).message).toBe(t("be_wrapBundledCommand.workspaceBusyStaging", { code: "holder-workspace-busy" }));
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
  const stagingRoots = (): number => [...state.dirs].filter((dir) => STAGING_ROOT_PATTERN.test(dir)).length;

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
    expect(refusal.message).toBe(t("be_wrapBundledCommand.environmentRefused", { keys, code: "holder-environment-refused" }));
    for (const value of [...Object.values(baseEnv), ...Object.values(holderEnv)]) expect(refusal.message).not.toContain(value);
    expect(state.spawn).not.toHaveBeenCalled();
    expect(stagingRoots()).toBe(before);
  });

  it("admits ELECTRON_RUN_AS_NODE=1, the value the bundled runtime needs", async () => {
    await spawnMxcBundledHolder(input({ holderEnv: { ELECTRON_RUN_AS_NODE: "1" } }));
    expect(state.spawn).toHaveBeenCalledTimes(1);
  });
});

describe("parent binding", () => {
  it("hands row 2 the parent holder unchanged, and none when the holder has no parent", async () => {
    const parent = { confinement: "windows-mxc" } as NonNullable<Parameters<typeof spawnMxcBundledHolder>[0]["parent"]>;
    await spawnMxcBundledHolder(input({ parent }));
    expect(lastSpec().parent).toBe(parent);
    await spawnMxcBundledHolder(input());
    expect("parent" in lastSpec()).toBe(false);
  });
});

describe("holder layout", () => {
  it("gives the holder its own staging HOME/temp sibling and its own incarnation, passing host env through", async () => {
    await spawnMxcBundledHolder(input());
    const first = lastSpec();
    const match = new RegExp(String.raw`^${STAGING_PARENT_PATTERN}\\([0-9a-f]{32})\\home$`, "u").exec(first.home);
    expect(match).not.toBeNull();
    const root = winPath.join(SYNTHETIC_MXC_STAGING_PARENT, match![1]);
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
    const stagingRoots = (): number => [...state.dirs].filter((dir) => STAGING_ROOT_PATTERN.test(dir)).length;
    const before = stagingRoots();
    await expect(spawnMxcBundledHolder(input({ cwd: "D:\\elsewhere" }))).rejects.toBeInstanceOf(MxcProcessContractError);
    expect(state.spawn).not.toHaveBeenCalled();
    expect(stagingRoots()).toBe(before);
  });

  it("carries the host's floor pierces to the native entry, and none when the host names none", async () => {
    await spawnMxcBundledHolder(input({ allowRead: ["C:\\ave\\plugins\\fs\\gen", "D:\\shared\\catalog"], floorPierces: ["D:\\shared\\catalog"] }));
    expect(lastSpec().floorPierces).toEqual(["D:\\shared\\catalog"]);
    await spawnMxcBundledHolder(input());
    expect(lastSpec()).not.toHaveProperty("floorPierces");
  });
});

describe("teardown", () => {
  it("removes the staging tree after verified termination without following a planted link", async () => {
    const holder = await spawnMxcBundledHolder(input());
    const { home, temp } = lastSpec();
    // Its staging HOME is the one issued to it, until the tree goes.
    expect(recordIssuedContainerHome).toHaveBeenCalledWith(home);
    state.links.set(`${temp}\\escape`, "D:\\work");
    await holder.release();
    await holder.release();
    expect(vi.mocked(forgetIssuedContainerHome).mock.calls.filter(([path]) => path === home)).toHaveLength(1);
    expect(spawned.release).toHaveBeenCalledTimes(1);
    // Removal runs on the retired sibling, so the link is unlinked under that name.
    expect(state.removed.some((path) => /\\[0-9a-f]{32}\.retired\\temp\\escape$/u.test(path))).toBe(true);
    expect(temp).toMatch(/\\temp$/u);
    expect(state.removed.some((path) => path.startsWith("D:\\work"))).toBe(false);
    expect(state.dirs.has("D:\\work")).toBe(true);
    expect([...state.dirs].some((dir) => STAGING_TREE_PATTERN.test(dir))).toBe(false);
  });

  it("removes the AppContainer profile subtree MXC creates under HOME, unlinking any reparse point there unfollowed", async () => {
    const holder = await spawnMxcBundledHolder(input());
    const home = lastSpec().home;
    const moniker = `${home}\\Packages\\sandbox.{4F1C2A9E-0000-4000-8000-00000000AB12}`;
    for (const dir of [`${home}\\Packages`, moniker, `${moniker}\\AC`, `${moniker}\\AC\\Temp`]) state.dirs.add(dir);
    state.files.add(`${moniker}\\AC\\Temp\\scratch.txt`);
    state.readonly.add(`${moniker}\\AC\\Temp\\scratch.txt`);
    // Reparse points at two depths: one inside AC\Temp, one replacing a profile folder, both aimed outside staging.
    state.links.set(`${moniker}\\AC\\Temp\\escape`, "D:\\work");
    state.links.set(`${moniker}\\LocalState`, "D:\\work");
    await holder.release();
    expect([...state.dirs].some((dir) => STAGING_TREE_PATTERN.test(dir))).toBe(false);
    expect([...state.files].some((file) => file.startsWith(STAGING_PATH_PREFIX))).toBe(false);
    expect([...state.links.keys()].some((link) => link.startsWith(STAGING_PATH_PREFIX))).toBe(false);
    expect(state.removed.some((path) => /\\[0-9a-f]{32}\.retired\\home\\Packages\\[^\\]+\\AC\\Temp\\escape$/u.test(path))).toBe(true);
    expect(state.removed.some((path) => /\\[0-9a-f]{32}\.retired\\home\\Packages\\[^\\]+\\LocalState$/u.test(path))).toBe(true);
    expect(state.removed.some((path) => path.startsWith("D:\\work"))).toBe(false);
    expect(state.files.has("D:\\work\\tool.exe")).toBe(true);
    expect(state.ops.some((op) => /^chmod .*(?:escape|LocalState)$/u.test(op))).toBe(false);
  });

  it("renames the tree to its retired sibling before deleting anything inside it", async () => {
    const holder = await spawnMxcBundledHolder(input());
    const root = winPath.dirname(lastSpec().home);
    state.files.add(`${root}\\temp\\scratch.txt`);
    await holder.release();
    const rename = state.ops.findIndex((op) => op.startsWith(`rename ${root} -> `));
    expect(rename).toBe(0);
    expect(state.ops[0]).toMatch(new RegExp(String.raw` -> ${STAGING_PARENT_PATTERN}\\[0-9a-f]{32}\.retired$`, "u"));
    expect(state.ops.slice(1).every((op) => !op.includes(root + "\\"))).toBe(true);
    expect(state.removed.some((path) => /[0-9a-f]{32}\.retired\\temp\\scratch\.txt$/u.test(path))).toBe(true);
    expect([...state.dirs].some((dir) => STAGING_TREE_PATTERN.test(dir))).toBe(false);
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
    expect([...state.dirs].some((dir) => STAGING_TREE_PATTERN.test(dir))).toBe(false);
  });

  describe("leftovers under the shared staging parent", () => {
    const P = SYNTHETIC_MXC_STAGING_PARENT;
    const GONE_PID = 0x7fff_fff0;
    const id = (digit: string): string => digit.repeat(32);
    const owned = (digit: string, owner: unknown, suffix = ""): string => {
      const root = `${P}\\${id(digit)}`;
      state.dirs.add(`${root}${suffix}`);
      state.dirs.add(`${root}${suffix}\\temp`);
      if (owner !== undefined) {
        state.files.add(`${root}.owner`);
        state.contents.set(`${root}.owner`.toLowerCase(), typeof owner === "string" ? owner : JSON.stringify(owner));
      }
      return root;
    };
    const gone = { pid: GONE_PID, start: "1", instance: "feedfeedfeedfeed" };
    const running = { pid: process.ppid, start: null, instance: "feedfeedfeedfeed" };

    beforeEach(() => { state.dirs.add(P); });

    it("writes a holder's owner marker before its tree and removes it after the tree", async () => {
      const holder = await spawnMxcBundledHolder(input());
      const root = winPath.dirname(lastSpec().home);
      const owner = JSON.parse(state.contents.get(`${root}.owner`.toLowerCase()) ?? "null") as { pid: number; start: string | null; instance: string };
      expect(owner).toEqual({ pid: process.pid, start: null, instance: expect.stringMatching(/^[0-9a-f]{16}$/u) });
      await holder.release();
      expect(state.files.has(`${root}.owner`)).toBe(false);
      // The marker is the last thing removed.
      expect(state.removed.at(-1)).toBe(`${root}.owner`);
    });

    it("removes the trees of processes that are gone, without following a link", async () => {
      const crashed = owned("a", gone);
      state.files.add(`${crashed}\\temp\\locked.txt`);
      state.readonly.add(`${crashed}\\temp\\locked.txt`);
      state.links.set(`${crashed}\\temp\\escape`, "D:\\work");
      const interrupted = owned("b", gone, ".retired");
      await spawnMxcBundledHolder(input());
      expect(state.spawn).toHaveBeenCalledTimes(1);
      for (const root of [crashed, interrupted]) {
        expect([...state.dirs].some((dir) => dir.startsWith(root))).toBe(false);
        expect(state.files.has(`${root}.owner`)).toBe(false);
      }
      // The crashed tree is retired before anything inside it is deleted, and the link is unlinked itself.
      expect(state.ops).toContain(`rename ${crashed} -> ${crashed}.retired`);
      expect(state.removed).toContain(`${crashed}.retired\\temp\\escape`);
      expect(state.removed.some((path) => path.startsWith("D:\\work"))).toBe(false);
      expect(state.files.has("D:\\work\\tool.exe")).toBe(true);
    });

    it("keeps every tree it cannot prove abandoned", async () => {
      const otherInstance = owned("a", running);
      const otherCopy = owned("b", { pid: process.pid, start: null, instance: "another-copy" });
      const unmarked = owned("c", undefined);
      const unreadable = owned("d", "not json");
      const wrongShape = owned("e", { pid: "1", start: "1", instance: "x" });
      const held = owned("f", gone);
      state.live = [`${held}\\temp`];
      // A marker beside a link is not a staging tree: the link and its target stay.
      state.links.set(`${P}\\${id("9")}`, "D:\\work");
      state.files.add(`${P}\\${id("9")}.owner`);
      state.contents.set(`${P}\\${id("9")}.owner`.toLowerCase(), JSON.stringify(gone));
      // Names that are not a run id are never read as one.
      state.dirs.add(`${P}\\supervisor-state`);
      state.files.add(`${P}\\supervisor-state.owner`);
      await spawnMxcBundledHolder(input());
      expect(state.spawn).toHaveBeenCalledTimes(1);
      for (const root of [otherInstance, otherCopy, unmarked, unreadable, wrongShape, held]) expect(state.dirs.has(root), root).toBe(true);
      expect(state.links.has(`${P}\\${id("9")}`)).toBe(true);
      expect(state.dirs.has(`${P}\\supervisor-state`)).toBe(true);
      expect(state.removed).toEqual([]);
      // Owners without a recorded creation time are not asked about.
      expect(state.probe).not.toHaveBeenCalled();
    });

    it("removes a running pid's tree only once its creation time is no longer the recorded one", async () => {
      const reused = owned("a", { pid: process.ppid, start: "111", instance: "feedfeedfeedfeed" });
      const same = owned("b", { pid: process.ppid, start: "222", instance: "feedfeedfeedfeed" });
      const answer = { resolve: (_states: Map<number, unknown>): void => {} };
      state.probe.mockReturnValue(new Promise((resolve) => { answer.resolve = resolve; }));
      await spawnMxcBundledHolder(input());
      expect(state.probe).toHaveBeenCalledTimes(1);
      expect(state.probe).toHaveBeenCalledWith([process.ppid]);
      expect(state.dirs.has(reused)).toBe(true);
      // The answer names one creation time for the pid: the tree recorded with another is abandoned, the other is not.
      answer.resolve(new Map([[process.ppid, { running: true, startTime: "222" }]]));
      await vi.waitFor(() => expect(state.dirs.has(reused)).toBe(false));
      expect(state.files.has(`${reused}.owner`)).toBe(false);
      expect(state.dirs.has(same)).toBe(true);
      // The parent's other instances are asked about once per process.
      await spawnMxcBundledHolder(input());
      expect(state.probe).toHaveBeenCalledTimes(1);
    });

    it.each(["EPERM", "EBUSY"])("keeps a leftover whole when its rename fails with %s, and removes it on a later start", async (code) => {
      // A process that outlived its owner still uses the tree.
      const held = owned("a", gone);
      state.dirs.add(`${held}\\home`);
      state.files.add(`${held}\\home\\state.db`);
      state.links.set(`${held}\\temp\\escape`, "D:\\work");
      state.renameFail.set(held, code);
      await spawnMxcBundledHolder(input());
      expect(state.spawn).toHaveBeenCalledTimes(1);
      expect(state.removed).toEqual([]);
      expect(state.ops.some((op) => op.includes(held))).toBe(false);
      for (const dir of [held, `${held}\\home`, `${held}\\temp`]) expect(state.dirs.has(dir), dir).toBe(true);
      expect(state.files.has(`${held}\\home\\state.db`)).toBe(true);
      expect(state.files.has(`${held}.owner`)).toBe(true);
      state.renameFail.clear();
      await spawnMxcBundledHolder(input());
      expect([...state.dirs].some((dir) => dir.startsWith(held))).toBe(false);
      expect(state.files.has(`${held}.owner`)).toBe(false);
      expect(state.ops).toContain(`rename ${held} -> ${held}.retired`);
    });

    it("only warns when a leftover cannot be removed, and still starts the holder", async () => {
      const busy = owned("a", gone);
      state.files.add(`${busy}\\temp\\held.dll`);
      state.unlinkFail.add(`${busy}.retired\\temp\\held.dll`);
      await spawnMxcBundledHolder(input());
      expect(state.spawn).toHaveBeenCalledTimes(1);
      expect(state.files.has(`${busy}.retired\\temp\\held.dll`)).toBe(true);
      // The marker stays with what is left, so a later sweep can still prove whose it is.
      expect(state.files.has(`${busy}.owner`)).toBe(true);
    });
  });

  it("forms staging through the shared staging-shape check, before creating a holder directory", async () => {
    state.stagingRefusal = new MxcProcessContractError("shape refused");
    await expect(spawnMxcBundledHolder(input())).rejects.toThrow("shape refused");
    expect(state.spawn).not.toHaveBeenCalled();
    expect([...state.dirs].some((dir) => STAGING_TREE_PATTERN.test(dir))).toBe(false);
  });

  it("starts nothing when the runtime root refuses the staging parent", async () => {
    state.stagingParentRefusal = new MxcRuntimeRootError("Container runtime root was not established when the sandbox started");
    await expect(spawnMxcBundledHolder(input())).rejects.toBeInstanceOf(MxcRuntimeRootError);
    expect(state.spawn).not.toHaveBeenCalled();
    expect(state.dirs.has(SYNTHETIC_MXC_STAGING_PARENT)).toBe(false);
    expect([...state.dirs].some((dir) => dir.startsWith(STAGING_PATH_PREFIX))).toBe(false);
    expect([...state.files].some((file) => file.startsWith(STAGING_PATH_PREFIX))).toBe(false);
  });

  it("creates no holder directory when the runtime root refuses right before the tree is created", async () => {
    state.stagingParentRefusal = new MxcRuntimeRootError("Container runtime root is no longer reached as it was when the sandbox started");
    state.stagingParentRefusalFrom = 2;
    await expect(spawnMxcBundledHolder(input())).rejects.toBeInstanceOf(MxcRuntimeRootError);
    expect(state.stagingParentCalls).toBe(2);
    expect(state.spawn).not.toHaveBeenCalled();
    expect([...state.dirs].some((dir) => STAGING_TREE_PATTERN.test(dir))).toBe(false);
    expect([...state.files].some((file) => file.startsWith(STAGING_PATH_PREFIX))).toBe(false);
  });

  it("starts no holder in a tree created while the runtime root's path changed, and removes nothing through that path", async () => {
    state.stagingParentRefusal = new MxcRuntimeRootError("Container runtime root is no longer reached as it was when the sandbox started");
    state.stagingParentRefusalFrom = 3;
    await expect(spawnMxcBundledHolder(input())).rejects.toBeInstanceOf(MxcRuntimeRootError);
    expect(state.stagingParentCalls).toBe(3);
    expect(state.spawn).not.toHaveBeenCalled();
    expect(state.removed).toEqual([]);
    // The marker stays beside the tree, so a later sweep can prove whose it is.
    const ownerMarker = new RegExp(String.raw`^${STAGING_PARENT_PATTERN}\\[0-9a-f]{32}\.owner$`, "u");
    expect([...state.files].filter((file) => ownerMarker.test(file))).toHaveLength(1);
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

describe("container refusal copy (row 6 disclosure)", () => {
  const plan = planWindowsExtensionHolder({ requested: true, mxc: { state: "unavailable", reason: "bash-incompatible" },
    fallback: { version: "0.0.80", ready: false } });
  const refusals = (): readonly (Error & { code: string })[] => [
    new holderModule.MxcExecutableNotAdmissibleError("detail"),
    new holderModule.MxcHolderWorkspaceBusyError(),
    new holderModule.MxcHolderWorkspaceBusyError(true),
    new holderModule.MxcBashIncompatibleError(plan),
    new holderModule.MxcHolderEnvironmentRefusedError(["NODE_OPTIONS"]),
    new holderModule.MxcHolderQuarantinedError("mcp:fs"),
    new WorkerTransportUnsupportedError(),
    new MxcNativeEntryRequiredError(),
    new PluginChildTerminationUnverifiedError("demo", {}),
    new MxcExtensionReadinessRefusedError(),
  ];

  it.each(["en", "ko"] as const)("localizes every refusal from a real %s key and keeps its stable code", (locale) => {
    const previous = getLocale();
    setLocale(locale);
    try {
      const codes = refusals().map((error) => {
        // A missing key would render the raw key; a missing placeholder would render the braces.
        expect(error.message).not.toMatch(/be_[A-Za-z]+\.|\{[a-z]+\}/u);
        expect(error.message.endsWith(`(${error.code})`)).toBe(true);
        return error.code;
      });
      expect(codes).toEqual(["executable-not-admissible", "holder-workspace-busy", "holder-workspace-busy", "bash-incompatible", "holder-environment-refused",
        "holder-quarantined", "worker-transport-unsupported", "native-entry-required", "plugin-child-termination-unverified",
        "extension-readiness-refused"]);
    } finally {
      setLocale(previous);
    }
  });

  it.each(["en", "ko"] as const)("resolves the hook and lifecycle quarantine refusals from real %s keys", (locale) => {
    const previous = getLocale();
    setLocale(locale);
    try {
      for (const [key, vars] of [
        ["be_scriptHookRunner.containedSettleDeadline", { ms: 10, code: "hook-settle-deadline" }],
        ["be_scriptHookRunner.containedTerminationUnverified", { detail: "x", code: "hook-termination-unverified" }],
        ["be_runtimeIndex.lifecycleQuarantined", { pluginId: "demo", reason: "x", code: "plugin-lifecycle-quarantined" }],
      ] as const) {
        const text = t(key, vars);
        expect(text).not.toContain(key);
        expect(text).not.toMatch(/\{[a-zA-Z]+\}/u);
        expect(text.endsWith(`(${vars.code})`)).toBe(true);
      }
    } finally {
      setLocale(previous);
    }
  });
});

describe("plugin child start resources", () => {
  const GEN = "C:\\ave\\plugins\\fs\\gen";
  const DATA = "C:\\ave\\mcp\\fs\\sandbox";
  const intent = (overrides: Partial<Parameters<typeof prepareMxcPluginChildLaunch>[0]> = {}): Parameters<typeof prepareMxcPluginChildLaunch>[0] =>
    ({ pluginId: "fs", command: NODE, cwd: GEN, pluginDataDir: DATA, baseEnv: { SYSTEMROOT: "C:\\Windows", ELECTRON_RUN_AS_NODE: "1" }, envelope: { read: [GEN, DATA], write: [DATA] }, ...overrides });
  const stagingExists = (): boolean => [...state.dirs].some((dir) => STAGING_TREE_PATTERN.test(dir));

  it("lays out a fresh staging HOME/temp and the captured ownership, and spawns nothing", async () => {
    const launch = await prepareMxcPluginChildLaunch(intent());
    const staging = winPath.dirname(launch.home);
    expect(staging).toMatch(STAGING_ROOT_PATTERN);
    expect(launch.temp).toBe(winPath.join(staging, "temp"));
    expect(state.dirs.has(launch.home) && state.dirs.has(launch.temp)).toBe(true);
    expect(launch.filesystemOwnership).toEqual({ readRoots: [GEN], writeRoots: [DATA, staging], hostStorageRoots: [resolvePluginHostStorageDir(DATA)] });
    expect(launch).not.toHaveProperty("probe");
    expect(launch.signal.aborted).toBe(false);
    expect(state.spawn).not.toHaveBeenCalled();
    const second = await prepareMxcPluginChildLaunch(intent());
    expect(winPath.dirname(second.home)).not.toBe(staging);
    await launch.release();
    expect(state.dirs.has(launch.home) || state.dirs.has(staging)).toBe(false);
    expect(state.dirs.has(second.home)).toBe(true);
  });

  it("refuses with capability-unavailable while no release-gate evidence is registered, before any staging exists", async () => {
    unregister?.();
    unregister = undefined;
    await expect(prepareMxcPluginChildLaunch(intent())).rejects.toBeInstanceOf(MxcCapabilityUnavailableError);
    expect(stagingExists()).toBe(false);
  });

  it("refuses when the container backend is not selected, and revokes a prepared launch once it is withdrawn", async () => {
    const launch = await prepareMxcPluginChildLaunch(intent());
    expect(() => launch.assertCurrent()).not.toThrow();
    state.plan = FALLBACK;
    expect(() => launch.assertCurrent()).toThrow(MxcProcessContractError);
    await expect(prepareMxcPluginChildLaunch(intent())).rejects.toBeInstanceOf(MxcProcessContractError);
  });

  it("refuses an executable inside its write roots or a live workspace writer, before any staging exists", async () => {
    await expect(prepareMxcPluginChildLaunch(intent({ command: "C:\\ave\\mcp\\fs\\sandbox\\tool.exe" })))
      .rejects.toBeInstanceOf(MxcExecutableNotAdmissibleError);
    state.live = ["D:\\work\\out"];
    await expect(prepareMxcPluginChildLaunch(intent({ envelope: { read: [GEN, "D:\\work"], write: ["D:\\work"] } })))
      .rejects.toBeInstanceOf(MxcHolderWorkspaceBusyError);
    expect(stagingExists()).toBe(false);
  });

  it("refuses a loader or SDK override in the child's environment by name, before any staging exists", async () => {
    for (const baseEnv of [{ NODE_OPTIONS: "--require x" }, { ELECTRON_RUN_AS_NODE: "0" }]) {
      await expect(prepareMxcPluginChildLaunch(intent({ baseEnv }))).rejects.toBeInstanceOf(MxcHolderEnvironmentRefusedError);
    }
    expect(stagingExists()).toBe(false);
  });
});
