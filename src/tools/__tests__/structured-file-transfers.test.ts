import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import fsPromises from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { create as createTar } from "tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { PermissionManager } from "../../permissions/permission-manager.js";
import type { ToolExecutionContext } from "../base.js";
import { ToolExecutor } from "../executor.js";
import { CopyPathTool, ExtractArchiveTool, createFileTools, withProjectWriteRoots } from "../file-tools.js";
import { canonicalizePathForMatch, caseFoldForMatch } from "../../permissions/sensitive-paths.js";
import { extractTargetFilePaths } from "../pipeline/path-extraction.js";
import { ToolRegistry } from "../registry.js";
import { userPermissionContext } from "./tool-context-fixture.js";
import { readTestFileSnapshot } from "./file-snapshot-fixture.js";
import { createCodeCheckpointTurn } from "../../__tests__/support/code-checkpoint-turn.js";
import { restoreCodeCheckpoint, withRequiredCodeCheckpoint } from "../../memory/code-checkpoints.js";

let root: string;
let workspace: string;
let outside: string;
const PAYLOAD = Buffer.from([0x00, 0xff, 0xfe, 0xc0, 0x80, 0x0d, 0x0a, 0x0a, 0x41]);

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "structured-transfers-")));
  workspace = join(root, "workspace");
  outside = join(root, "outside");
  mkdirSync(workspace);
  mkdirSync(outside);
  writeFileSync(join(workspace, "source.bin"), PAYLOAD);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await cleanupTmpDir(root);
});

function context(extraAllowedDirectories: string[] = []): ToolExecutionContext {
  return { cwd: workspace, extraAllowedDirectories, metadata: {} };
}

function observeCheckpointSave() {
  const rename = fsPromises.rename;
  let saved = false;
  const spy = vi.spyOn(fsPromises, "rename").mockImplementation(async (from, to) => {
    await rename(from, to);
    if (to === join(root, "state/code-checkpoints/turns.json")) saved = true;
  });
  return { wasSaved: () => saved, restore: () => spy.mockRestore() };
}

function executorFor(tool: CopyPathTool | ExtractArchiveTool) {
  const registry = new ToolRegistry();
  registry.register(tool);
  const permissions = new PermissionManager(join(root, "permissions.json"));
  permissions.setMode("allow");
  return new ToolExecutor(registry, undefined, permissions);
}

async function invoke(tool: CopyPathTool | ExtractArchiveTool, input: Record<string, unknown>) {
  const [result] = await executorFor(tool).executeConversationTools(
    [{ id: "transfer-call", name: tool.name, input }],
    { executionCwd: workspace, sessionId: "transfer-session", permissionContext: userPermissionContext() },
  );
  return result!;
}

async function fixtureArchive(gzip = false): Promise<string> {
  const source = join(workspace, "archive-source");
  mkdirSync(source);
  mkdirSync(join(source, "nested"));
  writeFileSync(join(source, "nested", "payload.bin"), PAYLOAD, { mode: 0o700 });
  writeFileSync(join(source, ".ordinary-hidden"), "hidden\r\n");
  const archive = join(workspace, "archive.data");
  await createTar({ cwd: source, file: archive, gzip }, ["nested", ".ordinary-hidden"]);
  return archive;
}

describe("structured transfer registration and permission routing", () => {
  it("rejects a copy destination parent swapped outside the project during checkpoint capture", async () => {
    vi.stubEnv("AVE_HOME", join(root, "state"));
    const parent = join(workspace, "target");
    mkdirSync(parent);
    const source = join(workspace, "source.bin");
    const destination = join(parent, "copy.bin");
    const lstat = fsPromises.lstat;
    let swapped = false;
    try {
      const turn = createCodeCheckpointTurn(() => "copy-swapped-parent");
      await turn("copy-turn", async () => {
        const checkpoint = observeCheckpointSave();
        const statSpy = vi.spyOn(fsPromises, "lstat").mockImplementation(async (path, options) => {
          try { return await lstat(path, options); }
          catch (error) {
            if (path === destination && checkpoint.wasSaved() && !swapped) {
              swapped = true;
              renameSync(parent, join(workspace, "original-target"));
              symlinkSync(outside, parent, "junction");
            }
            throw error;
          }
        });
        syncBuiltinESMExports();
        try {
          await expect(withProjectWriteRoots([caseFoldForMatch(canonicalizePathForMatch(workspace))],
            () => withRequiredCodeCheckpoint(() => new CopyPathTool().execute(
              { sourcePath: source, destinationPath: destination }, context([outside]),
            )))).rejects.toThrow("escaped project roots");
        } finally {
          statSpy.mockRestore();
          checkpoint.restore();
          syncBuiltinESMExports();
        }
      });
      expect(swapped).toBe(true);
      expect(existsSync(join(outside, "copy.bin"))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each(["directory", "regular-file"] as const)("refuses a %s substituted for a checkpoint-captured regular copy source", async (replacement) => {
    vi.stubEnv("AVE_HOME", join(root, "state"));
    const source = join(workspace, "source.bin");
    const destination = join(workspace, "copy.bin");
    const lstat = fsPromises.lstat;
    let replaced = false;
    try {
      const turn = createCodeCheckpointTurn(() => "copy-source-kind");
      await turn("copy-turn", async () => {
        const checkpoint = observeCheckpointSave();
        const statSpy = vi.spyOn(fsPromises, "lstat").mockImplementation(async (path, options) => {
          try { return await lstat(path, options); }
          catch (error) {
            if (path === destination && checkpoint.wasSaved() && !replaced) {
              replaced = true;
              renameSync(source, join(workspace, "original-source.bin"));
              if (replacement === "directory") {
                mkdirSync(source);
                writeFileSync(join(source, "unexpected.txt"), "must not copy this tree");
              } else {
                writeFileSync(source, "must not copy these substituted bytes");
              }
            }
            throw error;
          }
        });
        syncBuiltinESMExports();
        try {
          const result = await withRequiredCodeCheckpoint(() => new CopyPathTool().execute(
            { sourcePath: source, destinationPath: destination }, context(),
          ));
          expect(result.isError).toBe(true);
          expect(result.output).toContain(replacement === "directory"
            ? "Checkpointed copy requires a regular source file"
            : "Copy source changed after checkpoint admission");
        } finally {
          statSpy.mockRestore();
          checkpoint.restore();
          syncBuiltinESMExports();
        }
      });
      expect(replaced).toBe(true);
      expect(existsSync(destination)).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rejects a destination parent swapped while the transfer resolves its source", async () => {
    vi.stubEnv("AVE_HOME", join(root, "state"));
    const parent = join(workspace, "target");
    mkdirSync(parent);
    const source = join(workspace, "source.bin");
    const destination = join(parent, "copy.bin");
    const lstat = fsPromises.lstat;
    let captured = false;
    let swapped = false;
    try {
      const turn = createCodeCheckpointTurn(() => "copy-transfer-parent");
      await turn("copy-turn", async () => {
        const checkpoint = observeCheckpointSave();
        const statSpy = vi.spyOn(fsPromises, "lstat").mockImplementation(async (path, options) => {
          try {
            const info = await lstat(path, options);
            if (captured && !swapped && path === source) {
              swapped = true;
              renameSync(parent, join(workspace, "original-target"));
              symlinkSync(outside, parent, "junction");
            }
            return info;
          } catch (error) {
            if (path === destination && checkpoint.wasSaved()) captured = true;
            throw error;
          }
        });
        syncBuiltinESMExports();
        try {
          const result = await withProjectWriteRoots([caseFoldForMatch(canonicalizePathForMatch(workspace))],
            () => withRequiredCodeCheckpoint(() => new CopyPathTool().execute(
              { sourcePath: source, destinationPath: destination }, context([outside]),
            )));
          expect(result.isError).toBe(true);
          expect(result.output).toContain("escaped project roots");
        } finally {
          statSpy.mockRestore();
          checkpoint.restore();
          syncBuiltinESMExports();
        }
      });
      expect(swapped).toBe(true);
      expect(existsSync(join(outside, "copy.bin"))).toBe(false);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("rewinds a required checkpoint for a regular binary file copy", async () => {
    vi.stubEnv("AVE_HOME", join(root, "state"));
    try {
      const sessionId = "regular-copy";
      const turn = createCodeCheckpointTurn(() => sessionId);
      const destination = join(workspace, "copy.bin");
      await turn("copy-turn", async () => {
        const result = await withRequiredCodeCheckpoint(() => new CopyPathTool().execute(
          { sourcePath: "source.bin", destinationPath: "copy.bin" }, context(),
        ));
        expect(result.isError, result.output).toBe(false);
        expect(readFileSync(destination)).toEqual(PAYLOAD);
      });
      expect(await restoreCodeCheckpoint(sessionId, "copy-turn", context())).toEqual({ ok: true });
      expect(existsSync(destination)).toBe(false);
      expect(readFileSync(join(workspace, "source.bin"))).toEqual(PAYLOAD);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it.each([
    ["copy_path", "sourcePath"],
    ["extract_archive", "archivePath"],
  ] as const)("exposes %s with two guarded endpoints and no model-controlled safety override", (name, sourceField) => {
    const registry = new ToolRegistry();
    for (const tool of createFileTools()) registry.register(tool);
    const tool = registry.findByName(name)!;
    const schema = registry.getToolSchemasForScope({ activePluginIds: [], includeBuiltins: true, includeMcp: false, includeEgress: false })
      .find(entry => entry.name === name);
    expect(schema).toMatchObject({ name, category: "write", source: "builtin" });
    expect(schema?.input_schema).toMatchObject({
      type: "object",
      required: [sourceField, "destinationPath"],
      additionalProperties: false,
    });
    const properties = (schema?.input_schema as { properties: Record<string, unknown> }).properties;
    expect(Object.keys(properties).sort()).toEqual([sourceField, "destinationPath"].sort());
    expect(tool.isReadOnly?.({})).toBe(false);
    expect(tool.awaitCancellationSettlement).toBe(true);
    expect(registry.getToolSchemasForScope({ activePluginIds: [], includeBuiltins: false, includeMcp: false, includeEgress: false })
      .some(entry => entry.name === name)).toBe(false);

    const input = { [sourceField]: "source.bin", destinationPath: "new-directory" };
    const endpoints = extractTargetFilePaths(tool, input, workspace);
    const approval = JSON.parse(tool.approvalCacheKey!(input, { cwd: workspace })!);
    expect(endpoints).toEqual([join(workspace, "source.bin"), join(workspace, "new-directory")]);
    expect([approval[sourceField], approval.destinationPath]).toEqual(endpoints);
  });

  it("copies exact binary bytes through real write permission checks on both endpoints", async () => {
    const checkScope = vi.spyOn(PermissionManager, "checkPathScope");
    const source = join(workspace, "source.bin");
    const before = await readTestFileSnapshot(source);
    const result = await invoke(new CopyPathTool(), { sourcePath: "source.bin", destinationPath: "copy.bin" });
    expect(result.is_error).toBeUndefined();
    expect(JSON.parse(result.content)).toMatchObject({
      ok: true,
      summary: { sourcePath: source, destinationPath: join(workspace, "copy.bin"), files: 1, bytesWritten: PAYLOAD.length },
    });
    expect(readFileSync(join(workspace, "copy.bin"))).toEqual(PAYLOAD);
    const after = await readTestFileSnapshot(source);
    expect(after.bytes).toEqual(PAYLOAD);
    expect(after.stat.mtimeMs).toBe(before.stat.mtimeMs);
    expect(after.stat.ino).toBe(before.stat.ino);
    expect(checkScope.mock.calls.some(([request]) => request.effect === "write"
      && request.canonicalTargets.map(target => target.filePath).join("\0") === [source, join(workspace, "copy.bin")].join("\0"))).toBe(true);
  });

  describe.each([
    ["copy_path", CopyPathTool, "sourcePath"],
    ["extract_archive", ExtractArchiveTool, "archivePath"],
  ] as const)("%s uses mode rules and retains credential admission in allow mode", (_name, ToolClass, sourceField) => {
    it.each(["source", "destination"] as const)("allows the ordinary outside %s in allow mode", async endpoint => {
      const tool = new ToolClass();
      const execute = vi.spyOn(tool, "execute");
      const source = sourceField === "archivePath" ? await fixtureArchive() : join(workspace, "source.bin");
      const outsideSource = join(outside, "source.data");
      if (endpoint === "source") writeFileSync(outsideSource, readFileSync(source));
      const destination = endpoint === "destination" ? join(outside, "copy") : join(workspace, "copy");
      const result = await invoke(tool, {
        [sourceField]: endpoint === "source" ? outsideSource : source,
        destinationPath: destination,
      });
      expect(result.is_error, result.content).toBeUndefined();
      expect(execute).toHaveBeenCalledOnce();
      expect(readFileSync(sourceField === "archivePath" ? join(destination, "nested", "payload.bin") : destination)).toEqual(PAYLOAD);
    });

    it.each(["source", "destination"] as const)("uses ordinary file rules for the secret-file %s in allow mode", async endpoint => {
      const tool = new ToolClass();
      const execute = vi.spyOn(tool, "execute");
      const source = sourceField === "archivePath" ? await fixtureArchive() : join(workspace, "source.bin");
      mkdirSync(join(workspace, ".ssh"));
      const sensitive = join(workspace, ".ssh", "id_rsa");
      if (endpoint === "source") writeFileSync(sensitive, readFileSync(source));
      const destination = endpoint === "destination" ? sensitive : join(workspace, "copy");
      const result = await invoke(tool, {
        [sourceField]: endpoint === "source" ? sensitive : source,
        destinationPath: destination,
      });
      expect(result.is_error, result.content).toBeUndefined();
      expect(execute).toHaveBeenCalledOnce();
      expect(readFileSync(sourceField === "archivePath" ? join(destination, "nested", "payload.bin") : destination)).toEqual(PAYLOAD);
    });

    it.each(["source", "destination"] as const)("denies a host credential-store %s before I/O", async endpoint => {
      const tool = new ToolClass();
      const execute = vi.spyOn(tool, "execute");
      const sensitive = join(workspace, ".ave", "secrets", "store");
      const result = await invoke(tool, {
        [sourceField]: endpoint === "source" ? sensitive : "source.bin",
        destinationPath: endpoint === "destination" ? sensitive : "copy",
      });
      expect(result.is_error).toBe(true);
      expect(execute).not.toHaveBeenCalled();
      expect(existsSync(join(workspace, "copy"))).toBe(false);
    });

    it("rejects invented overwrite and resource-limit arguments before I/O", async () => {
      const tool = new ToolClass();
      await expect(tool.execute({
        [sourceField]: "source.bin", destinationPath: "copy", overwrite: true, maxPayloadBytes: 999_999,
      }, context())).rejects.toThrow();
      expect(existsSync(join(workspace, "copy"))).toBe(false);
    });
  });
});

describe("structured transfer wrapper completion", () => {
  it("honors an already admitted extra directory without changing its contents", async () => {
    const result = await new CopyPathTool().execute({ sourcePath: "source.bin", destinationPath: join(outside, "copy.bin") }, context([outside]));
    expect(result.isError).toBe(false);
    expect(readFileSync(join(outside, "copy.bin"))).toEqual(PAYLOAD);
  });

  it("does not append a source basename to an existing destination directory", async () => {
    mkdirSync(join(workspace, "existing"));
    const result = await new CopyPathTool().execute({ sourcePath: "source.bin", destinationPath: "existing" }, context());
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.output)).toMatchObject({ ok: false, code: "destination-exists", cleanup: "not-created" });
    expect(existsSync(join(workspace, "existing", "source.bin"))).toBe(false);
  });

  it.each([false, true])("extracts content-detected tar with gzip=%s through the registered executor", async gzip => {
    const archive = await fixtureArchive(gzip);
    const before = readFileSync(archive);
    const result = await invoke(new ExtractArchiveTool(), { archivePath: archive, destinationPath: "unpacked" });
    expect(result.is_error).toBeUndefined();
    expect(JSON.parse(result.content)).toMatchObject({
      ok: true,
      summary: { files: 2, directories: 2, bytesWritten: PAYLOAD.length + 8, archiveFormat: gzip ? "tar.gz" : "tar" },
    });
    expect(readFileSync(join(workspace, "unpacked", "nested", "payload.bin"))).toEqual(PAYLOAD);
    expect(readFileSync(join(workspace, "unpacked", ".ordinary-hidden"), "utf8")).toBe("hidden\r\n");
    expect(readFileSync(archive)).toEqual(before);
  });

  it("rolls back a valid member when later archive data is invalid", async () => {
    const archive = await fixtureArchive();
    writeFileSync(archive, Buffer.concat([readFileSync(archive), Buffer.alloc(512, 1)]));
    const before = readFileSync(archive);
    const result = await new ExtractArchiveTool().execute({ archivePath: archive, destinationPath: "unpacked" }, context());
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.output)).toMatchObject({ ok: false, code: "invalid-archive", cleanup: "removed" });
    expect(existsSync(join(workspace, "unpacked"))).toBe(false);
    expect(readFileSync(archive)).toEqual(before);
  });

  it("preserves a numeric extended filename without losing leading zeros", async () => {
    const source = join(workspace, "numeric-source");
    mkdirSync(source);
    const name = "001" + "2".repeat(128);
    writeFileSync(join(source, name), PAYLOAD);
    const archive = join(workspace, "numeric.tar");
    await createTar({ cwd: source, file: archive }, [name]);
    const original = readFileSync(archive);
    expect(original.includes(Buffer.from(`path=${name}\n`))).toBe(true);
    const result = await new ExtractArchiveTool().execute({ archivePath: archive, destinationPath: "numeric-copy" }, context());
    expect(result.isError).toBe(false);
    expect(readFileSync(join(workspace, "numeric-copy", name))).toEqual(PAYLOAD);
    expect(readFileSync(archive)).toEqual(original);
  });

  it.each(["garbage", "corrupt-member"] as const)("rolls back a gzip with ignored compressed %s after a zero byte", async kind => {
    const archive = await fixtureArchive(true);
    const tail = kind === "garbage" ? Buffer.from("unverified compressed tail") : gzipSync(Buffer.alloc(1024));
    if (kind === "corrupt-member") tail[tail.length - 8]! ^= 1;
    const original = Buffer.concat([readFileSync(archive), Buffer.from([0]), tail]);
    writeFileSync(archive, original);
    const result = await new ExtractArchiveTool().execute({ archivePath: archive, destinationPath: "unpacked" }, context());
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.output)).toMatchObject({ ok: false, code: "invalid-archive", cleanup: "removed" });
    expect(existsSync(join(workspace, "unpacked"))).toBe(false);
    expect(readFileSync(archive)).toEqual(original);
  });

  it("finishes cancellation cleanup before returning a transfer error", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled before transfer"));
    const result = await new CopyPathTool().execute({ sourcePath: "source.bin", destinationPath: "copy.bin" }, {
      ...context(), abortSignal: controller.signal,
    });
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.output)).toMatchObject({ ok: false, code: "cancelled", cleanup: "not-created" });
    expect(existsSync(join(workspace, "copy.bin"))).toBe(false);
  });
});
