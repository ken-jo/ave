import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const filesystem = vi.hoisted(() => ({
  active: false,
  brokerActive: false,
  entries: new Map<string, { path: string; directory: boolean; target?: string }>(),
  acquire: vi.fn(),
  execute: vi.fn(),
}));

vi.mock("node:path", async (original) => {
  const actual = await original<typeof import("node:path")>();
  const windows = (args: unknown[]) => filesystem.active && args.some((arg) => typeof arg === "string" && (/^[A-Za-z]:/.test(arg) || /^(?:[\\/]{2}|[\\/]git(?:[\\/]|$))/.test(arg)));
  const functions = Object.fromEntries(Object.entries(actual.win32).filter(([, value]) => typeof value === "function").map(([name, value]) => [name, (...args: unknown[]) => windows(args)
    ? Reflect.apply(value as (...args: unknown[]) => unknown, undefined, name === "resolve" ? ["D:\\", ...args] : args)
    : Reflect.apply(actual[name as keyof typeof actual] as (...args: unknown[]) => unknown, undefined, args)]));
  return { ...actual, ...functions, sep: "\\" };
});

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  const { win32 } = await vi.importActual<typeof import("node:path")>("node:path");
  const isVirtual = (path: unknown): path is string => filesystem.active && typeof path === "string" && /^(?:D:[\\/]$|D:[\\/](?:Fixture|git)(?:[\\/]|$))/i.test(path);
  const lookup = (path: string): string => {
    const normalized = win32.normalize(path);
    const direct = filesystem.entries.get(normalized.toLowerCase());
    if (direct) return direct.target ? lookup(direct.target) : direct.path;
    const parent = win32.dirname(normalized);
    if (parent !== normalized && filesystem.entries.has(parent.toLowerCase())) {
      const candidate = win32.join(lookup(parent), win32.basename(normalized));
      const entry = filesystem.entries.get(candidate.toLowerCase());
      if (entry) return entry.target ? lookup(entry.target) : entry.path;
    }
    throw Object.assign(new Error("Virtual path does not exist"), { code: "ENOENT" });
  };
  const realpath = (path: Parameters<typeof actual.realpathSync.native>[0], options?: unknown) => isVirtual(path) ? lookup(path) : actual.realpathSync.native(path, options as never);
  const realpathSync = Object.assign(realpath, { native: realpath });
  return { ...actual, realpathSync,
    existsSync: (path: Parameters<typeof actual.existsSync>[0]) => {
      if (!isVirtual(path)) return actual.existsSync(path);
      try { lookup(path); return true; } catch { return false; }
    },
    lstatSync: (path: Parameters<typeof actual.lstatSync>[0], options?: { throwIfNoEntry?: boolean }) => {
      if (!isVirtual(path)) return actual.lstatSync(path, options as never);
      const entry = filesystem.entries.get(win32.normalize(path).toLowerCase());
      if (!entry) {
        if (options?.throwIfNoEntry === false) return undefined;
        throw Object.assign(new Error("Virtual path does not exist"), { code: "ENOENT" });
      }
      return { isSymbolicLink: () => entry.target !== undefined, isDirectory: () => entry.directory, isFile: () => !entry.directory };
    },
    statSync: (path: Parameters<typeof actual.statSync>[0], options?: unknown) => {
      if (!isVirtual(path)) return actual.statSync(path, options as never);
      const entry = filesystem.entries.get(lookup(path).toLowerCase());
      if (entry === undefined) throw new Error("Virtual entry is missing");
      return { isDirectory: () => entry.directory, isFile: () => !entry.directory };
    },
    readlinkSync: (path: Parameters<typeof actual.readlinkSync>[0], options?: unknown) => {
      if (!isVirtual(path)) return actual.readlinkSync(path, options as never);
      const target = filesystem.entries.get(win32.normalize(path).toLowerCase())?.target;
      if (target === undefined) throw new Error("Virtual link is missing");
      return target;
    },
  };
});
vi.mock("../../shared/windows-path-facts.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedWindowsPathFacts(await original()));
vi.mock("../../shared/windows-configuration-handles.js", async original => (await import("../../__tests__/support/simulated-win32-drive.js")).simulatedConfigurationHandles(await original()));
vi.mock("../../workload/runtime.js", async original => ({ ...await original<typeof import("../../workload/runtime.js")>(),
  isWorkloadBrokerActive: () => filesystem.brokerActive,
  isActiveWorkloadBrokerCwd: () => filesystem.brokerActive,
  acquireBrokeredWorkloadCapability: filesystem.acquire,
  executeBrokeredWorkloadRequest: filesystem.execute,
}));

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AuditLogger } from "../../audit/audit-logger.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import type { ApprovalRequestInput } from "../../permissions/approval-gate.js";
import { caseFoldForMatch, createProjectMembership, foldCanonicalPathSeparators } from "../../permissions/sensitive-paths.js";
import { evaluateScopedRules } from "../../permissions/rules/scoped-rule-matcher.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { createDynamicTool, type Tool, type ToolExecutionContext } from "../base.js";
import { ApplyPatchTool, ReadFileTool, WriteFileTool, createFileTools } from "../file-tools.js";
import { answeringRequestAndWait } from "../../__tests__/support/answering-approval-gate.js";

const ORIGINAL_PLATFORM = process.platform;
const PROJECT = String.raw`D:\Fixture\Project`;
const OUTSIDE = String.raw`D:\Fixture\Outside-Target.txt`;
const LINKED_ROOT = String.raw`D:\Fixture\Linked-Root`;
let root: string;
let audit: AuditLogger;
let manager: PermissionManager;
let requests: ApprovalRequestInput[];

function entry(path: string, directory: boolean, target?: string) {
  filesystem.entries.set(path.toLowerCase(), { path, directory, target });
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "ave-windows-file-paths-"));
  vi.stubEnv("AVE_HOME", join(root, "profile"));
  audit = new AuditLogger(join(root, "audit"));
  manager = new PermissionManager(join(root, "permissions.json"));
  manager.setMode("default");
  requests = [];
  filesystem.entries.clear();
  for (const path of ["D:\\", String.raw`D:\Fixture`, PROJECT, String.raw`D:\git`]) entry(path, true);
  entry(OUTSIDE, false);
  entry(String.raw`D:\Fixture\Project\inside.txt`, false);
  entry(String.raw`D:\Fixture\Project\linked.txt`, false, OUTSIDE);
  entry(String.raw`D:\Fixture\Project\a-inside-link.txt`, false, String.raw`D:\Fixture\Project\inside.txt`);
  entry(String.raw`D:\Fixture\Project\b-outside-link.txt`, false, OUTSIDE);
  entry(LINKED_ROOT, true, PROJECT);
  filesystem.acquire.mockReset();
  filesystem.execute.mockReset();
  filesystem.active = true;
  filesystem.brokerActive = false;
  setProcessPlatform("win32");
});
afterEach(async () => {
  filesystem.active = false;
  filesystem.brokerActive = false;
  setProcessPlatform(ORIGINAL_PLATFORM);
  await audit.close();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

async function run(tool: Tool, input: Record<string, unknown>, cwd = PROJECT, additionalDirectories: string[] = []) {
  const registry = new ToolRegistry();
  registry.register(tool);
  const gate = { requestAndWait: answeringRequestAndWait(async (request: ApprovalRequestInput) => { requests.push(request); return { requestId: request.id, choice: "deny-once" }; }) };
  const executor = new ToolExecutor(registry, undefined, manager, undefined, gate as never, undefined, audit);
  const [result] = await executor.executeAll([{ id: "windows-file-target", name: tool.name, input }], {
    executionCwd: cwd, sessionId: "windows-file-target", permissionContext: {
      trustOrigin: "user-keyboard", additionalDirectories,
      ...(filesystem.brokerActive ? { approvalSurface: "unavailable" as const } : {}),
    },
  });
  return result;
}

describe("native Windows file permission targets", () => {
  it.each((["allow", "always-allow"] as const).flatMap(mode => [
    { name: "delete_file", input: { path: "src/secret/keep.txt" } },
    { name: "move_file", input: { sourcePath: "src/public.txt", destinationPath: "src/secret/moved.txt" } },
    { name: "move_file", input: { sourcePath: "src/secret/keep.txt", destinationPath: "src/moved.txt" } },
    { name: "copy_path", input: { sourcePath: "src/public.txt", destinationPath: "src/secret/copied.txt" } },
    { name: "copy_path", input: { sourcePath: "src/secret/keep.txt", destinationPath: "src/copied.txt" } },
    { name: "extract_archive", input: { archivePath: "src/public.txt", destinationPath: "src/secret/extracted" } },
  ].map(call => ({ mode, ...call }))))("denies scoped $name $input with native targets in $mode mode", async ({ mode, name, input }) => {
    entry(PROJECT + String.raw`\Src`, true);
    entry(PROJECT + String.raw`\Src\SeCrEt`, true);
    const targets = new Map([
      ["src/public.txt", PROJECT + String.raw`\Src\Public.txt`],
      ["src/secret/keep.txt", PROJECT + String.raw`\Src\SeCrEt\Keep.txt`],
      ["src/secret/moved.txt", PROJECT + String.raw`\Src\SeCrEt\Moved.txt`],
      ["src/moved.txt", PROJECT + String.raw`\Src\Moved.txt`],
      ["src/secret/copied.txt", PROJECT + String.raw`\Src\SeCrEt\Copied.txt`],
      ["src/copied.txt", PROJECT + String.raw`\Src\Copied.txt`],
      ["src/secret/extracted", PROJECT + String.raw`\Src\SeCrEt\Extracted`],
    ]);
    for (const target of targets.values()) entry(target, false);
    const tool = createFileTools().find(candidate => candidate.name === name);
    if (tool === undefined) throw new Error("File tool is missing");
    if (mode === "allow") manager.setMode("allow");
    else await manager.addAlwaysAllowedPersist(name);
    await manager.loadRulesFromFile();
    const rule = { pattern: "Edit(src/secret/**)", action: "deny" as const };
    await manager.addRulePersist(rule, { kind: "user" });
    const execute = vi.spyOn(tool, "execute");
    const check = vi.spyOn(manager, "checkDetailed");
    const result = await run(tool, input);
    expect(result).toMatchObject({ is_error: true, content: expect.stringContaining(rule.pattern) });
    expect(execute).not.toHaveBeenCalled();
    expect(requests).toEqual([]);
    for (const path of Object.values(input)) {
      expect(check.mock.lastCall?.[4]?.paths).toContainEqual(expect.objectContaining({
        canonical: `d:/fixture/project/${path}`, runtimePath: targets.get(path),
      }));
    }
    const subject = check.mock.lastCall?.[4]?.ruleSubject;
    if (subject?.kind !== "edit") throw new Error("Edit subject is missing");
    expect(subject.targets).toEqual(Object.values(input).map(path => ({
      filePath: `${PROJECT}\\${path.replaceAll("/", "\\")}`,
      canonicalPath: `d:/fixture/project/${path}`,
      runtimePath: targets.get(path),
    })));
    // Only the sealed resolved targets reach the deny; every lexical operand is public.
    const publicPaths = subject.paths.map((_, index) => `src/public-${index}.txt`);
    const readRuntimePath = vi.fn(() => String.raw`Z:\Public\Unrelated.txt`);
    const matchingTargets = subject.targets?.map((target, index) => Object.defineProperty({
      filePath: `${PROJECT}\\src\\public-${index}.txt`, canonicalPath: target.canonicalPath,
    }, "runtimePath", {
      get: readRuntimePath,
    }));
    expect(evaluateScopedRules({ ...subject, paths: publicPaths, targets: matchingTargets }, PROJECT, [rule])).toMatchObject({ decision: "deny", pattern: rule.pattern });
    expect(readRuntimePath).not.toHaveBeenCalled();
  });

  it.each(["file", "directory"])("keeps the native spelling of a %s directory suggestion", async (kind) => {
    const directory = String.raw`D:\Fixture\Café-Folder`;
    const target = kind === "directory" ? directory : directory + String.raw`\Leaf.txt`;
    entry(directory, true);
    if (kind === "file") entry(target, false);
    entry(PROJECT + String.raw`\linked.txt`, kind === "directory", target);
    const tool = new WriteFileTool();
    const execute = vi.spyOn(tool, "execute");
    const result = await run(tool, { path: "linked.txt", content: "changed" });
    expect(result.is_error).toBe(true);
    expect(execute).not.toHaveBeenCalled();
    expect(requests).toHaveLength(1);
    expect(requests[0]?.target?.canonicalPath).toBe(target);
    expect(requests[0]?.outOfAllowedDir?.suggestedParent).toBe(directory);
  });

  it.each(["/git", "\\git"])("refuses a broker lookalike under unresolved root %s without issuing authority", async (cwd) => {
    filesystem.brokerActive = true;
    manager.setMode("allow");
    let context: ToolExecutionContext | undefined;
    const execute = vi.fn(async (_input: unknown, supplied?: ToolExecutionContext) => { context = supplied; return { output: "plugin-local", isError: false }; });
    const tool = createDynamicTool({ name: "read_file", source: "plugin", pluginId: "file-lookalike", description: "file lookalike",
      category: "read", pathFields: ["path"], isReadOnly: () => true,
      jsonSchema: { type: "object", properties: { path: { type: "string" } }, required: ["path"] }, execute });
    const result = await run(tool, { path: cwd === "/git" ? "/git/plugin.txt" : "plugin.txt" }, cwd);
    expect(result.is_error).toBe(true);
    expect(result.authorizationRequired?.state).toMatchObject({ reason: "approval-surface-unavailable", source: "plugin" });
    expect(execute).not.toHaveBeenCalled();
    expect(context).toBeUndefined();
    expect(filesystem.acquire).not.toHaveBeenCalled();
    expect(filesystem.execute).not.toHaveBeenCalled();
    const local = await run(tool, { path: String.raw`D:\git\plugin.txt` }, String.raw`D:\git`);
    expect(local.content).toBe("plugin-local");
    expect(execute).toHaveBeenCalledOnce();
    expect(context?.executionRouteGrant).toBeUndefined();
    expect(filesystem.acquire).not.toHaveBeenCalled();
    expect(filesystem.execute).not.toHaveBeenCalled();
  });

  it("keeps a drive-relative root out of canonical project membership", () => {
    const canonicalize = vi.fn(() => String.raw`D:\git`);
    expect(createProjectMembership("D:git", canonicalize)(String.raw`D:\git\plugin.txt`)).toBe(false);
    expect(canonicalize).not.toHaveBeenCalled();
  });

  it.each(["read escape", "outside-directory write", "granted-directory write", "later patch escape", "relative linked-root write", "absolute linked-root write", "decomposed target"])("retains native target spelling for %s", async (scenario) => {
    const linkedRoot = scenario.includes("linked-root");
    const outside = scenario === "decomposed target" ? String.raw`D:\Fixture\Café-Target.txt` : OUTSIDE;
    entry(outside, false);
    entry(`${PROJECT}\\linked.txt`, false, outside);
    const tool = scenario === "read escape" ? new ReadFileTool() : scenario === "later patch escape" ? new ApplyPatchTool() : new WriteFileTool();
    const input = scenario === "later patch escape" ? { patch: ["*** Begin Patch", "*** Update File: a-inside-link.txt", "@@", "-inside", "+changed", "*** Update File: b-outside-link.txt", "@@", "-outside", "+changed", "*** End Patch"].join("\n") }
      : { path: linkedRoot ? scenario.startsWith("absolute") ? `${LINKED_ROOT}\\notes.txt` : "notes.txt" : "linked.txt", content: "changed" };
    const check = vi.spyOn(manager, "checkDetailed");
    const result = await run(tool, input, linkedRoot ? LINKED_ROOT : PROJECT, scenario === "outside-directory write" ? [] : [String.raw`D:\Fixture`]);
    expect(result.is_error).toBe(true);
    expect(requests).toHaveLength(1);
    const nativeTarget = linkedRoot ? `${PROJECT}\\notes.txt` : outside;
    expect(requests[0]?.target?.canonicalPath).toBe(nativeTarget);
    expect(requests[0]?.reasonCode).toBe(linkedRoot ? "file-write" : "project-escape");
    if (scenario === "later patch escape") expect(requests[0]?.target?.filePath).toBe(`${PROJECT}\\b-outside-link.txt`);
    const identity = caseFoldForMatch(foldCanonicalPathSeparators(nativeTarget));
    expect(check.mock.results.at(-1)?.value.pipelineRequest.paths).toContainEqual(expect.objectContaining({ canonical: identity }));
    if (linkedRoot) expect(requests[0]?.forceExplicit).toBeUndefined();
    else expect(requests[0]).toMatchObject({ forceExplicit: true, allowedChoices: ["allow-once", "deny-once"] });
  });
});
