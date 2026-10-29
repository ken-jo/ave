import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { ToolExecutor } from "../executor.js";
import { ToolRegistry } from "../registry.js";
import { ApplyPatchTool, CopyPathTool, DeleteFileTool, EditFileTool, MultiEditTool, MoveFileTool, ReadFileTool, WriteFileTool } from "../file-tools.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import { AuditLogger } from "../../audit/audit-logger.js";
import { markCodeCheckpointUnavailable, restoreCodeCheckpoint, withCodeCheckpoint } from "../../memory/code-checkpoints.js";
import { canonicalStringify } from "../../shared/canonical-json.js";
import { approvalCacheKeyFor, ARGS_APPROVAL_MEMORY } from "../pipeline/display-mask.js";
import { approvalCacheKeyIdentity, captureApprovalWorkingDirectory, recordApproval, __resetSessionStoreForTest } from "../../permissions/user-approval-store.js";
import type { ExecuteOptions } from "../executor-contract.js";

describe("checkpointed project file writes", () => {
  let root: string, project: string, sessionId: string;
  let manager: PermissionManager, executor: ToolExecutor, audit: AuditLogger;
  const requestAndWait = vi.fn(async (request: { id: string }) => ({ requestId: request.id, choice: "allow-once" as const }));
  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), "ave-project-write-")));
    project = join(root, "project");
    await mkdir(project);
    vi.stubEnv("AVE_HOME", join(root, "state"));
    sessionId = randomUUID();
    __resetSessionStoreForTest();
    requestAndWait.mockClear();
    const registry = new ToolRegistry();
    for (const tool of [new WriteFileTool(), new ReadFileTool(), new EditFileTool(), new MultiEditTool(), new ApplyPatchTool(), new DeleteFileTool(), new MoveFileTool(), new CopyPathTool()]) registry.register(tool);
    manager = new PermissionManager(join(root, "permissions.json"));
    audit = new AuditLogger(join(root, "audit"));
    executor = new ToolExecutor(registry, undefined, manager, undefined, { requestAndWait } as never, undefined, audit);
  });
  afterEach(async () => { await audit.close(); vi.unstubAllEnvs(); __resetSessionStoreForTest(); await rm(root, { recursive: true, force: true }); });
  const run = (name: string, input: Record<string, unknown>, opts: Partial<ExecuteOptions> = {}) => executor.executeAll([{ id: randomUUID(), name, input }], {
    sessionId, executionCwd: project, permissionContext: { trustOrigin: "user-keyboard", additionalDirectories: [] }, ...opts,
  });
  const turn = <T>(fn: () => Promise<T>) => withCodeCheckpoint({ sessionId, messageId: "turn" }, fn);

  it.each(["default", "auto"] as const)("%s writes and rewinds without a card", async (mode) => {
    manager.setMode(mode);
    manager.setInteractiveAutoApprove("medium");
    const path = join(project, "source.txt");
    await turn(async () => {
      expect((await run("write_file", { path, content: "before\n" }))[0].is_error).toBeFalsy();
      await run("read_file", { path });
      expect((await run("edit_file", { path, oldText: "before", newText: "after" }))[0].is_error).toBeFalsy();
      await run("read_file", { path });
      expect((await run("multi_edit", { path, replacements: [{ oldText: "after", newText: "patched" }] }))[0].is_error).toBeFalsy();
      await run("read_file", { path });
      expect((await run("apply_patch", { patch: `*** Begin Patch\n*** Update File: ${path}\n@@\n-patched\n+final\n*** End Patch` }))[0].is_error).toBeFalsy();
      await run("read_file", { path });
      expect((await run("delete_file", { path }))[0].is_error).toBeFalsy();
    });
    expect(requestAndWait).not.toHaveBeenCalled();
    expect(await restoreCodeCheckpoint(sessionId, "turn", { cwd: project, extraAllowedDirectories: [] })).toEqual({ ok: true });
  });

  it("checkpoints both ends of an in-project move", async () => {
    const sourcePath = join(project, "source"); const destinationPath = join(project, "destination");
    await writeFile(sourcePath, "original");
    await turn(async () => {
      await run("read_file", { path: sourcePath });
      expect((await run("move_file", { sourcePath, destinationPath }))[0].is_error).toBeFalsy();
    });
    expect(requestAndWait).not.toHaveBeenCalled();
    expect(await readFile(destinationPath, "utf8")).toBe("original");
    expect(await restoreCodeCheckpoint(sessionId, "turn", { cwd: project, extraAllowedDirectories: [] })).toEqual({ ok: true });
    expect(await readFile(sourcePath, "utf8")).toBe("original");
    await expect(readFile(destinationPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not auto-allow a patch with one outside target", async () => {
    const input = { patch: `*** Begin Patch\n*** Add File: ${join(project, "inside")}\n+inside\n*** Add File: ${join(root, "outside")}\n+outside\n*** End Patch` };
    expect((await turn(() => run("apply_patch", input)))[0].is_error).toBeFalsy();
    expect(requestAndWait).toHaveBeenCalledTimes(1);
  });

  it.each(["add", "update", "delete"])("preserves a legacy exact patch deny for %s", async (operation) => {
    const path = join(project, "denied");
    if (operation !== "add") await writeFile(path, "before\n");
    const section = operation === "add" ? `*** Add File: ${path}\n+after`
      : operation === "delete" ? `*** Delete File: ${path}`
      : `*** Update File: ${path}\n@@\n-before\n+after`;
    const input = { patch: `*** Begin Patch\n${section}\n*** End Patch` };
    const legacyKey = approvalCacheKeyFor(new ApplyPatchTool(), input, project);
    await recordApproval("apply_patch", canonicalStringify(input), "builtin", {
      decision: "deny", scope: "persistent", verdictAtApproval: "low", nlJustification: null,
      trustOrigin: "user-keyboard", workingDirectoryIdentity: captureApprovalWorkingDirectory(project).identity,
      approvalCacheKey: approvalCacheKeyIdentity(legacyKey, ARGS_APPROVAL_MEMORY),
    });
    expect((await turn(() => run("apply_patch", input)))[0].is_error).toBe(true);
    expect(requestAndWait).not.toHaveBeenCalled();
  });

  it("uses configured additional project roots without treating temp grants as project roots", async () => {
    const extra = join(root, "extra"); await mkdir(extra);
    await turn(async () => {
      await run("write_file", { path: join(extra, "file"), content: "ok" }, { permissionContext: { trustOrigin: "user-keyboard", additionalDirectories: [root], projectDirectories: [extra] } });
      expect(requestAndWait).not.toHaveBeenCalled();
      await run("write_file", { path: join(root, "temp-only"), content: "ok" }, { permissionContext: { trustOrigin: "user-keyboard", additionalDirectories: [root], projectDirectories: [extra] } });
      expect(requestAndWait).toHaveBeenCalledTimes(1);
    });
  });

  it("approves an outside write with exactly one directory card", async () => {
    const path = join(root, "outside.txt");
    await turn(async () => expect((await run("write_file", { path, content: "ok" }))[0].is_error).toBeFalsy());
    expect(requestAndWait).toHaveBeenCalledTimes(1);
    expect(requestAndWait).toHaveBeenCalledWith(expect.objectContaining({ kind: "out-of-allowed-dir" }));
    expect(await readFile(path, "utf8")).toBe("ok");
  });

  it.each([".git/config", ".vscode/settings.json", ".husky/pre-commit", ".zshrc"])("keeps %s behind a forced modal", async (relative) => {
    const path = join(project, relative);
    await turn(() => run("write_file", { path, content: "ok" }));
    expect(requestAndWait).toHaveBeenCalledWith(expect.objectContaining({ parentAdjudicationEligible: false, durableApprovalRecordAllowed: false, reviewerVerdict: undefined, reason: expect.stringMatching(/Protected control path|escapes the project/) }));
  });

  it("keeps a symlink escape behind a forced modal", async () => {
    await symlink(root, join(project, "escape"));
    await turn(() => run("write_file", { path: join(project, "escape/outside.txt"), content: "ok" }));
    expect(requestAndWait).toHaveBeenCalledWith(expect.objectContaining({ parentAdjudicationEligible: false, durableApprovalRecordAllowed: false, reviewerVerdict: undefined, reason: expect.stringMatching(/Protected control path|escapes the project/) }));
  });

  it("denies real secrets and allows an environment template", async () => {
    await turn(async () => {
      expect((await run("write_file", { path: join(project, ".env"), content: "secret" }))[0].is_error).toBe(true);
      expect((await run("write_file", { path: join(project, ".env.example"), content: "EXAMPLE=value" }))[0].is_error).toBeFalsy();
    });
    expect(requestAndWait).not.toHaveBeenCalled();
  });

  it.each(["strict", "ask-rule", "staged", "unavailable", "no-turn"])("still asks for %s", async (guard) => {
    if (guard === "strict") manager.setMode("strict");
    if (guard === "ask-rule") manager.setRules([{ pattern: "write_file", action: "ask" }]);
    const action = async () => {
      if (guard === "unavailable") await markCodeCheckpointUnavailable();
      await run("write_file", { path: join(project, "guard.txt"), content: "ok" }, guard === "staged" ? { overlayTriggerOrigin: "overlay:meeting-detection" } : {});
    };
    if (guard === "no-turn") await action(); else await turn(action);
    expect(requestAndWait).toHaveBeenCalledTimes(1);
  });

  it("does not auto-allow a transfer without a before-image contract", async () => {
    const sourcePath = join(project, "source"); await writeFile(sourcePath, "ok");
    await turn(() => run("copy_path", { sourcePath, destinationPath: join(project, "copy") }));
    expect(requestAndWait).toHaveBeenCalledTimes(1);
  });

  it("keeps an unavailable checkpoint in front of a person in auto mode", async () => {
    manager.setMode("auto"); manager.setInteractiveAutoApprove("medium");
    await turn(async () => {
      await markCodeCheckpointUnavailable();
      await run("write_file", { path: join(project, "unrecoverable"), content: "approved" });
    });
    expect(requestAndWait).toHaveBeenCalledTimes(1);
    expect(requestAndWait).toHaveBeenCalledWith(expect.objectContaining({ reviewerVerdict: undefined }));
  });

  it("preserves the existing reviewer lane for supported writes outside project roots", () => {
    manager.setMode("auto"); manager.setInteractiveAutoApprove("medium");
    const result = manager.checkDetailed("write_file", "builtin", "write", undefined, {
      fileWritePolicy: { insideProject: false, directoryApproved: false },
    });
    expect(result.decision).toBe("ask");
    expect(result.reviewer?.route).toBe("foreground-auto");
  });

  it("preserves headless approval policy", async () => {
    const path = join(project, "background");
    const results = await turn(() => run("write_file", { path, content: "no" }, { permissionContext: { trustOrigin: "user-keyboard", headless: true } }));
    expect(results[0].is_error).toBe(true);
    expect(requestAndWait).not.toHaveBeenCalled();
    await expect(readFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
