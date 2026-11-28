import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  onAuthorized: undefined as (() => void) | undefined,
  onExecutionRefresh: undefined as (() => void) | undefined,
  beforeRename: undefined as ((source: string, target: string) => void) | undefined,
  duringOpen: undefined as ((path: string) => (() => void) | undefined) | undefined,
  unlinks: [] as string[],
  opens: [] as string[],
  candidateRead: vi.fn(),
  pathSearch: vi.fn(),
}));
vi.mock("../../main/managed-child-processes.js", async (original) => {
  const actual = await original<typeof import("../../main/managed-child-processes.js")>();
  return {
    ...actual,
    spawnManaged: (...args: Parameters<typeof actual.spawnManaged>) => {
      if (args[3]?.label === "grep-files-ripgrep" && !args[1]?.includes("--files") && args[1]?.at(-1) !== "-") {
        hooks.pathSearch(args[1]);
      }
      return Reflect.apply(actual.spawnManaged, undefined, args);
    },
  };
});
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof import("node:fs/promises")>();
  return {
    ...actual,
    open: async (...args: Parameters<typeof actual.open>) => {
      hooks.opens.push(String(args[0]));
      const restore = hooks.duringOpen?.(String(args[0]));
      try {
        const handle = await actual.open(...args);
        if (restore) {
          const read = handle.read.bind(handle);
          handle.read = ((...readArgs: Parameters<typeof read>) => {
            hooks.candidateRead();
            return Reflect.apply(read, handle, readArgs);
          }) as typeof handle.read;
        }
        return handle;
      }
      finally { restore?.(); }
    },
    rename: async (source: string, target: string) => {
      hooks.beforeRename?.(source, target);
      await actual.rename(source, target);
    },
    unlink: (...args: Parameters<typeof actual.unlink>) => {
      hooks.unlinks.push(String(args[0]));
      return actual.unlink(...args);
    },
  };
});
vi.unmock("../../shared/windows-drive-locality.js");
vi.mock("../invocation-authorization.js", async (original) => {
  const actual = await original<typeof import("../invocation-authorization.js")>();
  return { ...actual, authorizeToolInvocation: async (...args: Parameters<typeof actual.authorizeToolInvocation>) => {
    const result = await actual.authorizeToolInvocation(...args);
    hooks.onAuthorized?.();
    return result;
  } };
});
vi.mock("../../shared/chat-origin.js", async (original) => {
  const actual = await original<typeof import("../../shared/chat-origin.js")>();
  return { ...actual, refreshRemoteControllerBoundToSession: async (...args: Parameters<typeof actual.refreshRemoteControllerBoundToSession>) => {
    // Only the execution stage's refresh comes after the runner's last check.
    if (new Error().stack?.includes("invocation-execution")) hooks.onExecutionRefresh?.();
    return actual.refreshRemoteControllerBoundToSession(...args);
  } };
});

import { t } from "../../i18n/index.js";
import { configureHostResources } from "../../main/host-resources.js";
import { windowsPathKindHelperUnavailable } from "../../main/windows-path-kind-launcher.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { endUnattendedStage, registerUnattendedStage } from "../../permissions/unattended-lane-registry.js";
import { emptyStageEnvelope } from "../../work-board/workflow/__tests__/stage-fixtures.js";
import { createToolEffectResolver } from "../../permissions/tool-effect-evidence.js";
import { allowKeyMaterialInspectionUnder } from "../../permissions/sensitive-paths.js";
import { sealTargets } from "../../permissions/target-seal.js";
import { localFs } from "../../shared/local-path-io.js";
import { resolvePhysicalFilesystemPath } from "../../shared/shell-filesystem-path.js";
import { setWindowsDriveQueryForTest } from "../../shared/windows-drive-locality.js";
import { answeringRequestAndWait } from "../../__tests__/support/answering-approval-gate.js";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { GrepFilesTool, ReadFileTool, WriteFileTool } from "../file-tools.js";

const LOCAL_DRIVE = String.raw`\Device\HarddiskVolume1`;

describe.runIf(process.platform === "win32")("sealed file targets at handler admission", () => {
  let root: string;
  let project: string;
  let outside: string;

  let manager: PermissionManager;

  beforeEach(() => {
    configureHostResources({ resourcePath: join(process.cwd(), "resources"), isPackaged: false });
    setWindowsDriveQueryForTest(() => LOCAL_DRIVE);
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "ave-sealed-targets-")));
    project = join(root, "project");
    outside = join(root, "outside");
    mkdirSync(join(project, "sub"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(project, "sub", "note.txt"), "before");
    vi.stubEnv("AVE_HOME", join(root, "profile"));
    manager = new PermissionManager(join(root, "permissions.json"));
    manager.setMode("default");
  });

  afterEach(async () => {
    hooks.onAuthorized = undefined;
    hooks.onExecutionRefresh = undefined;
    hooks.beforeRename = undefined;
    hooks.unlinks.length = 0;
    hooks.opens.length = 0;

    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    setWindowsDriveQueryForTest();
    rmSync(root, { recursive: true, force: true });
  });

  it("returns scheduled grep matches for directory and file case aliases", async () => {
    const registry = new ToolRegistry();
    registry.register(new GrepFilesTool());
    manager.setUnattendedToolEffectResolver(createToolEffectResolver(registry));
    const executor = new ToolExecutor(registry, undefined, manager, undefined, undefined, undefined);
    const sessionId = "scheduled-grep-case-alias";
    registerUnattendedStage(sessionId, {
      runKey: "run", stageId: "stage", workspaceRoot: project, isolation: { proven: false }, readOnly: true,
      envelope: { ...emptyStageEnvelope(), tools: ["grep_files"] },
    });
    try {
      for (const path of ["SUB", join("SUB", "NOTE.TXT")]) {
        const [result] = await executor.executeAll([{
          id: "grep", name: "grep_files", input: { path, pattern: "before" },
        }], { executionCwd: project, sessionId, permissionContext: { headless: true, trustOrigin: "llm-tool-arg" } });
        expect(result?.is_error, result?.content).not.toBe(true);
        expect(result?.content).toContain("1: before");
      }
    } finally {
      endUnattendedStage(sessionId);
    }
  });

  async function write(path: string, cwd: string, requestAndWait = answeringRequestAndWait(() => ({ choice: "deny-once" }))) {
    const tool = new WriteFileTool();
    const execute = vi.spyOn(tool, "execute").mockResolvedValue({ output: "written", isError: false });
    const registry = new ToolRegistry();
    registry.register(tool);
    const gate = { requestAndWait };
    const executor = new ToolExecutor(registry, undefined, manager, undefined, gate as never, undefined);
    const [result] = await executor.executeAll([{ id: "sealed-target", name: tool.name, input: { path, content: "changed" } }], {
      executionCwd: cwd, sessionId: "sealed-target", permissionContext: { trustOrigin: "user-keyboard" },
    });
    return { result, execute };
  }

  function refuseRouteAt(path: string, refusal: "incomplete" | "share") {
    if (refusal === "incomplete") {
      const lstat = localFs.lstat;
      vi.spyOn(localFs, "lstat").mockImplementation((verdict) => {
        if (verdict.path === path) throw Object.assign(new Error("access denied"), { code: "EACCES" });
        return lstat(verdict);
      });
    } else {
      const readlink = localFs.readlink;
      vi.spyOn(localFs, "readlink").mockImplementation((verdict) =>
        verdict.path === path ? "\\\\server\\share\\sub" : readlink(verdict));
    }
  }

  it("reads a local file when an unrelated project-write anchor moves", async () => {
    const anchor = join(root, "anchor");
    symlinkSync(project, anchor, "junction");
    hooks.onExecutionRefresh = () => {
      hooks.onExecutionRefresh = undefined;
      unlinkSync(anchor);
      symlinkSync(outside, anchor, "junction");
    };
    const tool = new ReadFileTool();
    const registry = new ToolRegistry();
    registry.register(tool);
    const executor = new ToolExecutor(registry, undefined, manager, undefined, undefined, undefined);
    const [result] = await executor.executeAll([{ id: "read-target", name: tool.name, input: { path: "sub/note.txt" } }], {
      executionCwd: project, sessionId: "read-target", permissionContext: { trustOrigin: "user-keyboard", projectDirectories: [anchor] },
    });
    expect(hooks.onExecutionRefresh).toBeUndefined();
    expect(result?.is_error).not.toBe(true);
    expect(result?.content).toContain("before");
  });

  it("does not open a different local file after waiting for handler transport", async () => {
    const operand = "alias/note.txt";
    const alias = join(project, "alias");
    const replacement = join(project, "replacement");
    mkdirSync(replacement);
    writeFileSync(join(replacement, "note.txt"), "different");
    symlinkSync(join(project, "sub"), alias, "junction");
    const tool = new ReadFileTool();
    const transport = vi.spyOn(tool as unknown as { executionTransport: () => Promise<{ kind: string }> }, "executionTransport");
    transport.mockImplementationOnce(async () => {
      await Promise.resolve();
      unlinkSync(alias);
      symlinkSync(replacement, alias, "junction");
      return { kind: "local" };
    });
    const registry = new ToolRegistry();
    registry.register(tool);
    const executor = new ToolExecutor(registry, undefined, manager, undefined, undefined, undefined);
    const [result] = await executor.executeAll([{ id: "read-target", name: tool.name, input: { path: operand } }], {
      executionCwd: project, sessionId: "read-target", permissionContext: { trustOrigin: "user-keyboard" },
    });
    expect(transport).toHaveBeenCalledOnce();
    expect(result?.is_error).toBe(true);
    expect(hooks.opens.filter((path) => path.endsWith("note.txt"))).toEqual([]);
  });

  it("refuses a rename retry when the original write operand moves", async () => {
    const alias = join(project, "alias");
    const original = join(project, "sub");
    const replacement = join(project, "replacement");
    mkdirSync(replacement);
    symlinkSync(original, alias, "junction");
    const target = join(alias, "new.txt");
    const sealedEntry = join(original, "new.txt");
    const renames: string[] = [];
    hooks.beforeRename = (source, destination) => {
      if (destination !== sealedEntry) return;
      renames.push(destination);
      if (renames.length > 1) return;
      if (!existsSync(source)) throw new Error("missing temporary write");
      unlinkSync(alias);
      symlinkSync(replacement, alias, "junction");
      throw Object.assign(new Error("busy"), { code: "EBUSY" });
    };
    await manager.addRulePersist({ pattern: "Edit(alias/new.txt)", action: "allow" }, { kind: "user" });
    const tool = new WriteFileTool();
    const registry = new ToolRegistry();
    registry.register(tool);
    const executor = new ToolExecutor(registry, undefined, manager, undefined, undefined, undefined);
    const [result] = await executor.executeAll([{ id: "write-target", name: tool.name, input: { path: target, content: "new" } }], {
      executionCwd: project, sessionId: "write-target", permissionContext: { trustOrigin: "user-keyboard" },
    });
    expect(result?.is_error).toBe(true);
    expect(renames, JSON.stringify(result)).toEqual([sealedEntry]);
    expect(existsSync(join(replacement, "new.txt"))).toBe(false);
    expect(readdirSync(original)).toEqual(["note.txt"]);
  });

  it.each([false, true])("disposes its staging file when a drive query fails (after writing: %s)", async (afterWriting) => {
    const parent = join(project, "sub");
    const path = join(parent, "new.txt");
    const stagingFiles = () => readdirSync(parent).filter((name) => name.startsWith("new.txt.ave-tmp-"));
    const seal = sealTargets(() => resolvePhysicalFilesystemPath(path, project, 64));
    const error = new Error("Drive query failed");
    const rename = vi.fn();
    hooks.beforeRename = rename;
    setWindowsDriveQueryForTest(() => {
      const [staged] = stagingFiles();
      if (staged && (!afterWriting || statSync(join(parent, staged)).size > 0)) throw error;
      return LOCAL_DRIVE;
    });
    const tool = new WriteFileTool();
    await expect(tool.execute({ path, content: "new" }, {
      cwd: project, extraAllowedDirectories: [], metadata: {}, fileTargetSeal: seal,
    })).rejects.toBe(error);
    expect(rename).not.toHaveBeenCalled();
    expect(existsSync(path)).toBe(false);
    expect(stagingFiles()).toEqual([]);
    expect(hooks.unlinks.filter((name) => name.includes(".ave-tmp-"))).toEqual([]);
  });

  it("refuses a sealed write when the file leaf is replaced by a symlink", async () => {
    const path = join(project, "sub", "note.txt");
    const original = join(project, "sub", "original.txt");
    const seal = sealTargets(() => resolvePhysicalFilesystemPath(path, project, 64));
    renameSync(path, original);
    symlinkSync(original, path, "file");

    const result = await new WriteFileTool().execute({ path, content: "changed" }, {
      cwd: project, extraAllowedDirectories: [], metadata: {}, fileTargetSeal: seal,
    });
    expect(result).toMatchObject({
      isError: true,
      output: t("be_executor.fileTargetChanged"),
    });
    expect(hooks.opens).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe("before");
  });

  it.each([
    ["changed", "be_executor.fileTargetChanged"],
    ["helper unavailable", "be_executor.fileTargetUnverified"],
    ["incomplete", "be_executor.fileTargetUnverified"],
    ["share", "be_executor.fileTargetUnverified"],
  ] as const)("reports why a sealed write was refused (%s)", async (refusal, key) => {
    const alias = join(project, "alias");
    symlinkSync(join(project, "sub"), alias, "junction");
    const path = join(alias, "note.txt");
    const seal = sealTargets(() => resolvePhysicalFilesystemPath(path, project, 64));
    if (refusal === "helper unavailable") {
      setWindowsDriveQueryForTest(() => { throw windowsPathKindHelperUnavailable("No drive classification"); });
    } else if (refusal === "changed") {
      const replacement = join(project, "replacement");
      mkdirSync(replacement);
      writeFileSync(join(replacement, "note.txt"), "replacement");
      unlinkSync(alias);
      symlinkSync(replacement, alias, "junction");
    } else {
      refuseRouteAt(alias, refusal);
    }

    const result = await new WriteFileTool().execute({ path, content: "changed" }, {
      cwd: project, extraAllowedDirectories: [], metadata: {}, fileTargetSeal: seal,
    });
    expect(result).toMatchObject({
      isError: true,
      output: t(key),
    });
    expect(hooks.opens).toEqual([]);
    expect(readFileSync(join(project, "sub", "note.txt"), "utf8")).toBe("before");
  });

  it("refuses an approved write when its sealed route becomes unavailable while the card is open", async () => {
    const alias = join(project, "alias");
    symlinkSync(join(project, "sub"), alias, "junction");
    manager.setMode("strict");
    const requestAndWait = answeringRequestAndWait(() => {
      refuseRouteAt(alias, "incomplete");
      return { choice: "allow-once" };
    });

    const { result, execute } = await write("alias/note.txt", project, requestAndWait);

    expect(requestAndWait).toHaveBeenCalledOnce();
    expect(execute).not.toHaveBeenCalled();
    expect(hooks.opens.filter((path) => path.endsWith("note.txt"))).toEqual([]);
    expect(readFileSync(join(project, "sub", "note.txt"), "utf8")).toBe("before");
    expect(result).toMatchObject({
      is_error: true,
      content: expect.stringContaining(t("be_executor.fileTargetUnverified")),
    });
  });

  it.each([
    ["onAuthorized", "incomplete"],
    ["onAuthorized", "share"],
    ["onExecutionRefresh", "incomplete"],
  ] as const)("reports a sealed route refusal at %s (%s)", async (stage, refusal) => {
    const alias = join(project, "alias");
    symlinkSync(join(project, "sub"), alias, "junction");
    manager.setMode("allow");
    const refuse = vi.fn(() => {
      hooks[stage] = undefined;
      refuseRouteAt(alias, refusal);
    });
    hooks[stage] = refuse;
    const { result, execute } = await write("alias/note.txt", project);
    expect(refuse).toHaveBeenCalledOnce();
    expect(result).toMatchObject({ is_error: true, content: t("be_executor.fileTargetUnverified") });
    expect(execute).not.toHaveBeenCalled();
    expect(hooks.opens.filter((path) => path.endsWith("note.txt"))).toEqual([]);
    expect(readFileSync(join(project, "sub", "note.txt"), "utf8")).toBe("before");
  });

  it("publishes a sealed write and closes the staging handle without deleting the destination", async () => {
    const parent = join(project, "sub");
    const path = join(parent, "new.txt");
    const seal = sealTargets(() => resolvePhysicalFilesystemPath(path, project, 64));
    const tool = new WriteFileTool();
    const result = await tool.execute({ path, content: "new" }, {
      cwd: project, extraAllowedDirectories: [], metadata: {}, fileTargetSeal: seal,
    });
    expect(result.isError).toBe(false);
    expect(readFileSync(path, "utf8")).toBe("new");
    expect(readdirSync(parent).sort()).toEqual(["new.txt", "note.txt"]);
    unlinkSync(path);
  });

  it.each([false, true])("runs the handler only on the sealed directory (moved during the final wait: %s)", async (moved) => {
    await manager.addRulePersist({ pattern: "Edit(sub/note.txt)", action: "allow" }, { kind: "user" });
    let drifted = 0;
    if (moved) hooks.onExecutionRefresh = () => {
      if (drifted++ > 0) return;
      renameSync(join(project, "sub"), join(project, "sub-before"));
      symlinkSync(outside, join(project, "sub"), "junction");
    };
    const { result, execute } = await write("sub/note.txt", project);
    if (!moved) {
      expect(result?.is_error).not.toBe(true);
      expect(execute).toHaveBeenCalledOnce();
      return;
    }
    expect(drifted).toBeGreaterThan(0);
    expect(result?.is_error).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });

  it.each([false, true])("runs the handler only under the sealed project anchor (moved during the final wait: %s)", async (moved) => {
    const anchor = join(root, "anchor");
    symlinkSync(project, anchor, "junction");
    manager.setMode("allow");
    let drifted = 0;
    if (moved) hooks.onExecutionRefresh = () => {
      if (drifted++ > 0) return;
      unlinkSync(anchor);
      symlinkSync(outside, anchor, "junction");
    };
    const { result, execute } = await write(join(project, "sub", "note.txt"), anchor);
    if (!moved) {
      expect(result?.is_error).not.toBe(true);
      expect(execute).toHaveBeenCalledOnce();
      return;
    }
    expect(drifted).toBeGreaterThan(0);
    expect(result?.is_error).toBe(true);
    expect(execute).not.toHaveBeenCalled();
  });
});

it.skipIf(process.platform === "win32")("keeps a scheduled text read bound to its admitted file", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ave-scheduled-read-")));
  const workspaceRoot = join(root, "workspace");
  const alias = join(workspaceRoot, "alias.txt");
  const admitted = join(workspaceRoot, "admitted.txt");
  const other = join(root, "outside.txt");
  const sessionId = "scheduled-sealed-read";
  mkdirSync(workspaceRoot);
  writeFileSync(admitted, "admitted fixture");
  writeFileSync(other, "outside fixture");
  symlinkSync(admitted, alias);
  const registry = new ToolRegistry();
  registry.register(new ReadFileTool());
  const manager = new PermissionManager(join(root, "permissions.json"));
  manager.setMode("allow");
  manager.setUnattendedToolEffectResolver(createToolEffectResolver(registry));
  const executor = new ToolExecutor(registry, undefined, manager, undefined, undefined, undefined);
  registerUnattendedStage(sessionId, {
    runKey: "run", stageId: "stage", workspaceRoot, isolation: { proven: false }, readOnly: true,
    envelope: { ...emptyStageEnvelope(), tools: ["read_file"] },
  });
  const read = async () => (await executor.executeAll([{ id: "read", name: "read_file", input: { path: alias } }], {
    executionCwd: workspaceRoot, sessionId, permissionContext: { headless: true, trustOrigin: "llm-tool-arg" },
  }))[0];
  try {
    expect(await read()).toMatchObject({ content: expect.stringContaining("admitted fixture") });
    hooks.onAuthorized = () => {
      hooks.onAuthorized = undefined;
      unlinkSync(alias);
      symlinkSync(other, alias);
    };
    const result = await read();
    expect(hooks.onAuthorized).toBeUndefined();
    expect(result).toMatchObject({ is_error: true });
    expect(result?.content).not.toContain("outside fixture");

    unlinkSync(alias);
    symlinkSync(admitted, alias);
    const held = join(workspaceRoot, "held.txt");
    hooks.duringOpen = (path) => {
      if (basename(path) !== basename(admitted)) return undefined;
      hooks.duringOpen = undefined;
      renameSync(admitted, held);
      renameSync(other, admitted);
      return () => {
        renameSync(admitted, other);
        renameSync(held, admitted);
      };
    };
    const replacedDuringOpen = await read();
    expect(hooks.duringOpen).toBeUndefined();
    expect(replacedDuringOpen).toMatchObject({ is_error: true });
    expect(replacedDuringOpen?.content).not.toContain("outside fixture");
  } finally {
    hooks.onAuthorized = undefined;
    hooks.duringOpen = undefined;
    endUnattendedStage(sessionId);
    rmSync(root, { recursive: true, force: true });
  }
});

it("reads scheduled grep candidates only after checking the opened identity", async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "ave-scheduled-grep-")));
  const workspaceRoot = join(root, "workspace");
  const candidate = join(workspaceRoot, "candidate.txt");
  const held = join(root, "held.txt");
  const replacement = join(root, "replacement.txt");
  const sessionId = "scheduled-sealed-grep";
  mkdirSync(workspaceRoot);
  writeFileSync(candidate, "needle admitted fixture\n");
  writeFileSync(replacement, "needle replacement fixture\n");
  const protectedPath = join(workspaceRoot, ".env");
  const keyPath = join(workspaceRoot, "candidate.pem");
  writeFileSync(protectedPath, "needle protected fixture\n");
  writeFileSync(keyPath, "needle possible key fixture\n");
  const registry = new ToolRegistry();
  registry.register(new GrepFilesTool());
  const manager = new PermissionManager(join(root, "permissions.json"));
  manager.setMode("allow");
  manager.setUnattendedToolEffectResolver(createToolEffectResolver(registry));
  const executor = new ToolExecutor(registry, undefined, manager, undefined, undefined, undefined);
  registerUnattendedStage(sessionId, {
    runKey: "run", stageId: "stage", workspaceRoot, isolation: { proven: false }, readOnly: true,
    envelope: { ...emptyStageEnvelope(), tools: ["grep_files"] },
  });
  const grep = async (path: string, outputMode = "content") => (await executor.executeAll([{
    id: "grep", name: "grep_files", input: { path, pattern: "needle", outputMode },
  }], {
    executionCwd: workspaceRoot, sessionId, permissionContext: { headless: true, trustOrigin: "llm-tool-arg" },
  }))[0];
  const withdrawInspection = allowKeyMaterialInspectionUnder(() => [workspaceRoot]);
  const pathOpen = vi.spyOn(localFs, "open");
  if (process.platform === "win32") {
    configureHostResources({ resourcePath: join(process.cwd(), "resources"), isPackaged: false });
    setWindowsDriveQueryForTest(() => LOCAL_DRIVE);
  }
  try {
    hooks.pathSearch.mockClear();
    hooks.opens.length = 0;
    const stable = await grep(".");
    expect(stable).toMatchObject({ content: expect.stringContaining("needle admitted fixture") });
    expect(stable?.content).not.toContain("needle protected fixture");
    expect(stable?.content).not.toContain("needle possible key fixture");
    expect(hooks.opens).not.toContain(protectedPath);
    expect(pathOpen.mock.calls.some(([verdict]) => verdict.path === keyPath)).toBe(false);
    expect(await grep(".", "count")).toMatchObject({ content: expect.stringContaining(`${candidate}: 1`) });
    expect(await grep(".", "files_with_matches")).toMatchObject({ content: expect.stringContaining(candidate) });
    expect(await grep("candidate.txt")).toMatchObject({ content: expect.stringContaining("needle admitted fixture") });
    expect(await grep("candidate.pem")).toMatchObject({ is_error: true });
    expect(pathOpen.mock.calls.some(([verdict]) => verdict.path === keyPath)).toBe(false);
    hooks.candidateRead.mockClear();
    hooks.duringOpen = (path) => {
      if (basename(path) !== basename(candidate)) return undefined;
      hooks.duringOpen = undefined;
      renameSync(candidate, held);
      renameSync(replacement, candidate);
      return () => {
        renameSync(candidate, replacement);
        renameSync(held, candidate);
      };
    };
    const result = await grep(".");
    expect(hooks.duringOpen).toBeUndefined();
    expect(result?.content).toContain("No matches found.");
    expect(result?.content).not.toContain("needle replacement fixture");
    expect(hooks.pathSearch).not.toHaveBeenCalled();
    expect(hooks.candidateRead).not.toHaveBeenCalled();
  } finally {
    hooks.duringOpen = undefined;
    hooks.opens.length = 0;
    pathOpen.mockRestore();
    withdrawInspection();
    if (process.platform === "win32") setWindowsDriveQueryForTest();
    endUnattendedStage(sessionId);
    rmSync(root, { recursive: true, force: true });
  }
});
