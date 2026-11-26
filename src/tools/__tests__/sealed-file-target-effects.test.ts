import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ onExecutionRefresh: undefined as (() => void) | undefined }));
vi.unmock("../../shared/windows-drive-locality.js");
vi.mock("../../shared/chat-origin.js", async (original) => {
  const actual = await original<typeof import("../../shared/chat-origin.js")>();
  return { ...actual, refreshRemoteControllerBoundToSession: async (...args: Parameters<typeof actual.refreshRemoteControllerBoundToSession>) => {
    // Only the execution stage's refresh comes after the runner's last check.
    if (new Error().stack?.includes("invocation-execution")) hooks.onExecutionRefresh?.();
    return actual.refreshRemoteControllerBoundToSession(...args);
  } };
});

import { AuditLogger } from "../../audit/audit-logger.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { setWindowsDriveQueryForTest } from "../../shared/windows-drive-locality.js";
import { answeringRequestAndWait } from "../../__tests__/support/answering-approval-gate.js";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { ReadFileTool, WriteFileTool } from "../file-tools.js";

const LOCAL_DRIVE = String.raw`\Device\HarddiskVolume1`;

describe.runIf(process.platform === "win32")("sealed file targets at handler admission", () => {
  let root: string;
  let project: string;
  let outside: string;
  let audit: AuditLogger;
  let manager: PermissionManager;

  beforeEach(() => {
    setWindowsDriveQueryForTest(() => LOCAL_DRIVE);
    root = realpathSync.native(mkdtempSync(join(tmpdir(), "ave-sealed-targets-")));
    project = join(root, "project");
    outside = join(root, "outside");
    mkdirSync(join(project, "sub"), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(project, "sub", "note.txt"), "before");
    vi.stubEnv("AVE_HOME", join(root, "profile"));
    audit = new AuditLogger(join(root, "audit"));
    manager = new PermissionManager(join(root, "permissions.json"));
    manager.setMode("default");
  });

  afterEach(async () => {
    hooks.onExecutionRefresh = undefined;
    await audit.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    setWindowsDriveQueryForTest();
    rmSync(root, { recursive: true, force: true });
  });

  async function write(path: string, cwd: string) {
    const tool = new WriteFileTool();
    const execute = vi.spyOn(tool, "execute").mockResolvedValue({ output: "written", isError: false });
    const registry = new ToolRegistry();
    registry.register(tool);
    const gate = { requestAndWait: answeringRequestAndWait(async (request) => ({ requestId: request.id, choice: "deny-once" })) };
    const executor = new ToolExecutor(registry, undefined, manager, undefined, gate as never, undefined, audit);
    const [result] = await executor.executeAll([{ id: "sealed-target", name: tool.name, input: { path, content: "changed" } }], {
      executionCwd: cwd, sessionId: "sealed-target", permissionContext: { trustOrigin: "user-keyboard" },
    });
    return { result, execute };
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
    const executor = new ToolExecutor(registry, undefined, manager, undefined, undefined, undefined, audit);
    const [result] = await executor.executeAll([{ id: "read-target", name: tool.name, input: { path: "sub/note.txt" } }], {
      executionCwd: project, sessionId: "read-target", permissionContext: { trustOrigin: "user-keyboard", projectDirectories: [anchor] },
    });
    expect(hooks.onExecutionRefresh).toBeUndefined();
    expect(result?.is_error).not.toBe(true);
    expect(result?.content).toContain("before");
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
