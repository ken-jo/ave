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
    readlinkSync: (path: Parameters<typeof actual.readlinkSync>[0], options?: unknown) => isVirtual(path)
      ? filesystem.entries.get(win32.normalize(path).toLowerCase())!.target
      : actual.readlinkSync(path, options as never),
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
import { caseFoldForMatch, foldCanonicalPathSeparators } from "../../permissions/sensitive-paths.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import type { Tool } from "../base.js";
import { ApplyPatchTool, ReadFileTool, WriteFileTool } from "../file-tools.js";

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
  const gate = { requestAndWait: async (request: ApprovalRequestInput) => { requests.push(request); return { requestId: request.id, choice: "deny-once" }; } };
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
