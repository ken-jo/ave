import { useConfigurationOwner } from "../../__tests__/support/configuration-owner.js";
import { canCreateSymlinks } from "../../__tests__/support/symlink-capability.js";
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { buildImagePreparationEntry, imageFixturePath } from "../../__tests__/support/image-preparation-runtime.js";
import { IMAGE_PREPARATION_POLICY } from "../../shared/image-preparation-policy.js";
import { trimOversizedToolResult } from "../../shared/tool-result-trim.js";

const imageRuntime = vi.hoisted(() => ({ directory: "" }));
vi.mock("../../main/main-paths.js", async (original) => ({
  ...await original<typeof import("../../main/main-paths.js")>(),
  get mainDir() { return imageRuntime.directory; },
}));

import { ToolRegistry } from "../registry.js";
import {
  ApplyPatchInputSchema,
  ApplyPatchTool,
  createFileTools,
  DeleteFileTool,
  EditFileTool,
  GlobFilesTool,
  GrepFilesTool,
  ListFilesTool,
  MoveFileTool,
  MultiEditTool,
  ReadFileTool,
  ViewImageTool,
  WriteFileTool,
} from "../file-tools.js";
import type { ToolExecutionContext } from "../base.js";
import {
  dispatchPermissionDirCommand,
  parsePermissionDirCommand,
} from "../../permissions/permission-slash.js";
import { parseJsonRecord as parse } from "../../__tests__/test-helpers.js";
import { fileReadKey, recordFileRead, sha256Hex } from "../file-read-state.js";

let workDir: string;
let sessionId: string;

function ctx(): ToolExecutionContext {
  return { cwd: workDir, extraAllowedDirectories: [], metadata: { sessionId } };
}

// Record the session read required before mutation.
async function readFirst(path: string): Promise<void> {
  const read = await new ReadFileTool().execute({ path, offset: 0, limit: 50 }, ctx());
  expect(read.isError, read.output).toBe(false);
}

function readLines(output: string): string[] {
  return output.split("\n").slice(1).map((line) => line.replace(/^ *\d+\t/, ""));
}

function portablePath(path: string): string {
  return path.replace(/\\/g, "/");
}

beforeEach(() => {
  sessionId = randomUUID();
  workDir = mkdtempSync(join(tmpdir(), "ave-file-tools-"));
  mkdirSync(join(workDir, "src", "nested"), { recursive: true });
  writeFileSync(join(workDir, "src", "a.ts"), "alpha\nneedle one\nomega\n", "utf8");
  writeFileSync(join(workDir, "src", "nested", "b.ts"), "beta\nneedle two\n", "utf8");
  writeFileSync(join(workDir, "README.md"), "# Ave\nneedle docs\n", "utf8");
});

afterEach(async () => {
  await cleanupTmpDir(workDir);
});

useConfigurationOwner();

describe("view_image tool", () => {
  beforeAll(async () => { imageRuntime.directory = await buildImagePreparationEntry("file-image-runtime"); });
  afterAll(async () => { await cleanupTmpDir(imageRuntime.directory); });

  it.each(["png", "jpeg", "gif", "webp"])("decodes a valid %s file and returns a bounded visual copy", async (format) => {
    const bytes = readFileSync(imageFixturePath(`grid.${format}`));
    writeFileSync(join(workDir, "image.data"), bytes);
    const res = await new ViewImageTool().execute({ path: "image.data", maxDimension: 4 }, ctx());
    expect(res.isError, res.output).toBe(false);
    expect(res.image).toMatchObject({ mimeType: "image/png", width: 4, height: 2 });
    expect(Buffer.from(res.image!.data, "base64").length).toBe(res.image?.bytes);
    expect(parse(res.output)).toMatchObject({ loaded: true, originalFormat: format, originalWidth: 8, originalHeight: 4, resized: true });
    expect(readFileSync(join(workDir, "image.data"))).toEqual(bytes);
  });

  it("rejects a truncated header that used to pass as an image", async () => {
    writeFileSync(join(workDir, "fake.png"), readFileSync(imageFixturePath("grid.png")).subarray(0, 12));
    const res = await new ViewImageTool().execute({ path: "fake.png" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.image).toBeUndefined();
    expect(res.output).toContain("invalid-image");
  });

  it("reports unsupported input separately from size recovery, including oversized files", async () => {
    writeFileSync(join(workDir, "unsupported.ppm"), "P6\n8 4\n255\n");
    truncateSync(join(workDir, "unsupported.ppm"), IMAGE_PREPARATION_POLICY.maxInputBytes + 1);
    const res = await new ViewImageTool().execute({ path: "unsupported.ppm" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.output).toContain("unsupported-image");
    expect(res.output).toContain("PNG, JPEG, GIF and WebP");
    expect(res.output).toContain("Convert");
    expect(res.image).toBeUndefined();
  });

  it("limits original file reads independently of the output byte budget", async () => {
    writeFileSync(join(workDir, "big.png"), readFileSync(imageFixturePath("grid.png")));
    truncateSync(join(workDir, "big.png"), IMAGE_PREPARATION_POLICY.maxInputBytes + 1);
    const res = await new ViewImageTool().execute({ path: "big.png", maxBytes: 128 }, ctx());
    expect(res.isError).toBe(true);
    expect(res.output).toContain("image-input-limit");
    expect(res.output).toContain("derived output");
    expect(res.image).toBeUndefined();
  });

  it("rejects a path outside the allowed scope (same guard as read_file)", async () => {
    const res = await new ViewImageTool().execute({ path: "../sneak.png" }, ctx());
    expect(res.isError).toBe(true);
    expect(res.image).toBeUndefined();
  });

  it("is registered by createFileTools", () => {
    expect(createFileTools().map((t) => t.name)).toContain("view_image");
  });
});

describe("file native tools", () => {
  describe.each([
    ["edit_file", EditFileTool],
    ["multi_edit", MultiEditTool],
  ] as const)("%s literal replacement content", (name, ToolClass) => {
    describe.each([false, true])("replaceAll=%s", (replaceAll) => {
      it.each([
        ["matched text token", "$&"],
        ["dollar token", "$$"],
        ["prefix token", "$`"],
        ["suffix token", "$'"],
        ["ordinary text", "updated text"],
      ])("stores the %s as supplied", async (_label, newText) => {
        const path = join(workDir, "literal-replacement.txt");
        writeFileSync(path, "before alpha after\n");
        await readFirst(path);
        const replacement = { oldText: "alpha", newText, replaceAll };
        const result = await new ToolClass().execute(
          name === "edit_file" ? { path, ...replacement } : { path, replacements: [replacement] },
          ctx(),
        );
        expect(result.isError).toBe(false);
        expect(parse(result.output).replacements).toBe(1);
        expect(readFileSync(path, "utf8")).toBe(`before ${newText} after\n`);
      });
    });

    it("stores literal replacement tokens at every match", async () => {
      const path = join(workDir, "literal-global.txt");
      writeFileSync(path, "before alpha middle alpha after\n");
      await readFirst(path);
      const newText = "$& $$ $` $'";
      const replacement = { oldText: "alpha", newText, replaceAll: true };
      const result = await new ToolClass().execute(
        name === "edit_file" ? { path, ...replacement } : { path, replacements: [replacement] },
        ctx(),
      );
      expect(result.isError).toBe(false);
      expect(parse(result.output).replacements).toBe(2);
      expect(readFileSync(path, "utf8")).toBe(`before ${newText} middle ${newText} after\n`);
    });

    it.each(["missing", "ambiguous"] as const)("does not write when the match is %s", async (kind) => {
      const path = join(workDir, "literal-rejected.txt");
      const source = "before alpha middle alpha after\n";
      writeFileSync(path, source);
      await readFirst(path);
      const replacement = { oldText: kind === "missing" ? "absent" : "alpha", newText: "$&" };
      const result = await new ToolClass().execute(
        name === "edit_file" ? { path, ...replacement } : { path, replacements: [replacement] },
        ctx(),
      );
      expect(result.isError).toBe(true);
      expect(result.output).toContain(kind === "missing" ? "oldText not found" : "matched 2 times");
      expect(readFileSync(path, "utf8")).toBe(source);
    });
  });

  describe.each([
    ["edit_file", EditFileTool],
    ["multi_edit", MultiEditTool],
  ] as const)("%s text copied from a numbered read", (name, ToolClass) => {
    it.each([
      ["lf", "\n"],
      ["crlf", "\r\n"],
      ["cr", "\r"],
    ])("edits a %s file from the read lines and keeps its separator", async (_label, separator) => {
      const path = join(workDir, "round-trip.txt");
      writeFileSync(path, `before${separator}alpha${separator}beta${separator}after${separator}`);
      const read = await new ReadFileTool().execute({ path, offset: 1, limit: 2 }, ctx());
      expect(read.isError).toBe(false);
      const oldText = readLines(read.output).join("\n");
      expect(oldText).toBe("alpha\nbeta");
      const replacement = { oldText, newText: "updated\nentry" };
      const edit = await new ToolClass().execute(
        name === "edit_file" ? { path, ...replacement } : { path, replacements: [replacement] },
        ctx(),
      );
      expect(edit.isError, edit.output).toBe(false);
      expect(readFileSync(path, "utf8"))
        .toBe(`before${separator}updated${separator}entry${separator}after${separator}`);
    });

    it("accepts text that still carries the read line-number prefixes", async () => {
      const path = join(workDir, "prefixed.txt");
      writeFileSync(path, "one\ntwo\nthree\n");
      const read = await new ReadFileTool().execute({ path, offset: 0, limit: 10 }, ctx());
      const copied = read.output.split("\n").slice(2, 4).join("\n");
      expect(copied).toBe("     2\ttwo\n     3\tthree");
      const replacement = { oldText: copied, newText: "     2\tTWO\n     3\tTHREE" };
      const edit = await new ToolClass().execute(
        name === "edit_file" ? { path, ...replacement } : { path, replacements: [replacement] },
        ctx(),
      );
      expect(edit.isError, edit.output).toBe(false);
      expect(readFileSync(path, "utf8")).toBe("one\nTWO\nTHREE\n");
    });

    it("keeps exact matching for a file with mixed separators", async () => {
      const path = join(workDir, "mixed.txt");
      const source = "alpha\r\nbeta\ngamma\n";
      writeFileSync(path, source);
      await readFirst(path);
      const replacement = { oldText: "alpha\nbeta", newText: "updated" };
      const edit = await new ToolClass().execute(
        name === "edit_file" ? { path, ...replacement } : { path, replacements: [replacement] },
        ctx(),
      );
      expect(edit.isError).toBe(true);
      expect(edit.output).toContain("oldText not found");
      expect(readFileSync(path, "utf8")).toBe(source);
    });
  });

  describe.each([
    ["edit_file", EditFileTool, { oldText: "alpha", newText: "beta" }],
    ["multi_edit", MultiEditTool, { replacements: [{ oldText: "alpha", newText: "beta" }] }],
    ["write_file", WriteFileTool, { content: "beta\n" }],
  ] as const)("%s read-before-edit guard", (_name, ToolClass, change) => {
    it("refuses an existing file this session has not read", async () => {
      const path = join(workDir, "guarded.txt");
      writeFileSync(path, "alpha\n");
      const result = await new ToolClass().execute({ path, ...change }, ctx());
      expect(result.isError).toBe(true);
      expect(result.output).toContain("read it with read_file in this session first");
      expect(readFileSync(path, "utf8")).toBe("alpha\n");
    });

    it("refuses a file read by another session", async () => {
      const path = join(workDir, "guarded.txt");
      writeFileSync(path, "alpha\n");
      await readFirst(path);
      const other = { ...ctx(), metadata: { sessionId: randomUUID() } };
      const result = await new ToolClass().execute({ path, ...change }, other);
      expect(result.isError).toBe(true);
      expect(readFileSync(path, "utf8")).toBe("alpha\n");
    });

    it("refuses an existing file when the invocation has no session", async () => {
      const path = join(workDir, "guarded.txt");
      writeFileSync(path, "alpha\n");
      const result = await new ToolClass().execute(
        { path, ...change },
        { cwd: workDir, extraAllowedDirectories: [], metadata: {} },
      );
      expect(result.isError).toBe(true);
      expect(result.output).toContain("requires a session");
    });

    it("refuses a file that changed after it was read", async () => {
      const path = join(workDir, "guarded.txt");
      writeFileSync(path, "alpha\n");
      await readFirst(path);
      writeFileSync(path, "alpha changed elsewhere\n");
      const result = await new ToolClass().execute({ path, ...change }, ctx());
      expect(result.isError).toBe(true);
      expect(result.output).toContain("changed after it was read");
      expect(readFileSync(path, "utf8")).toBe("alpha changed elsewhere\n");
    });

    it("admits a file whose modification time changed but whose bytes did not", async () => {
      const path = join(workDir, "guarded.txt");
      writeFileSync(path, "alpha\n");
      await readFirst(path);
      utimesSync(path, new Date(0), new Date(0));
      const result = await new ToolClass().execute({ path, ...change }, ctx());
      expect(result.isError, result.output).toBe(false);
    });

    it("admits a second change after its own write without another read", async () => {
      const path = join(workDir, "guarded.txt");
      writeFileSync(path, "alpha\nother\n");
      await readFirst(path);
      const first = await new ToolClass().execute({ path, ...change }, ctx());
      expect(first.isError, first.output).toBe(false);
      const second = await new EditFileTool().execute({ path, oldText: "beta", newText: "gamma" }, ctx());
      expect(second.isError, second.output).toBe(false);
      expect(readFileSync(path, "utf8")).toContain("gamma");
    });
  });

  it("write_file creates a new file without a prior read and may then change it", async () => {
    const created = await new WriteFileTool().execute({ path: "fresh/new.txt", content: "one\n" }, ctx());
    expect(created.isError, created.output).toBe(false);
    const edited = await new EditFileTool().execute(
      { path: "fresh/new.txt", oldText: "one", newText: "two" },
      ctx(),
    );
    expect(edited.isError, edited.output).toBe(false);
    expect(readFileSync(join(workDir, "fresh", "new.txt"), "utf8")).toBe("two\n");
  });

  it("read_file returns a header and numbered lines for the window", async () => {
    const result = await new ReadFileTool().execute(
      { path: "src/a.ts", offset: 1, limit: 1 },
      ctx(),
    );

    expect(result.isError).toBe(false);
    expect(result.output).toBe(`${join(workDir, "src", "a.ts")} (lines 2-2 of 3)\n     2\tneedle one`);
    expect(result.metadata).toMatchObject({ lineCount: 1, totalLines: 3, truncated: true });
  });

  it("read_file reports an empty file and an offset past the end", async () => {
    writeFileSync(join(workDir, "empty.txt"), "");
    const empty = await new ReadFileTool().execute({ path: "empty.txt" }, ctx());
    expect(empty.output).toBe(`${join(workDir, "empty.txt")} (empty file)`);
    const past = await new ReadFileTool().execute({ path: "src/a.ts", offset: 10 }, ctx());
    expect(past.isError).toBe(false);
    expect(past.output).toContain("no lines at offset 10; the file has 3 lines");
  });

  it("read_file returns the lines that fit and the offset to continue from", async () => {
    const lines = Array.from({ length: 400 }, (_, index) => `line ${index + 1}`);
    writeFileSync(join(workDir, "long.txt"), `${lines.join("\n")}\n`);
    const result = await new ReadFileTool().execute({ path: "long.txt", offset: 10 }, ctx());

    expect(result.isError, result.output).toBe(false);
    expect(trimOversizedToolResult(result.output).truncated).toBeUndefined();
    const shown = Number(result.metadata?.lineCount);
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(390);
    expect(result.output).toContain(`(lines 11-${10 + shown} of 400)`);
    expect(result.output).toContain("    11\tline 11");
    expect(result.output.split("\n").at(-1)).toBe(
      `[Stopped at the result size limit after line ${10 + shown}; continue with offset=${10 + shown}.]`,
    );
    expect(result.metadata).toMatchObject({ truncated: true, totalLines: 400 });

    const next = await new ReadFileTool().execute({ path: "long.txt", offset: 10 + shown }, ctx());
    expect(next.isError).toBe(false);
    expect(next.output).toContain(`\tline ${11 + shown}`);
  });

  it("read_file cuts a very long line, says how to read the rest, and admits edits", async () => {
    const wide = "word ".repeat(20_000);
    writeFileSync(join(workDir, "wide.txt"), `${wide}\nnext\n`);
    const read = await new ReadFileTool().execute({ path: "wide.txt" }, ctx());
    expect(read.isError, read.output).toBe(false);
    expect(trimOversizedToolResult(read.output).truncated).toBeUndefined();
    expect(read.output).toContain(`[line 1 cut: showing 2000 of ${wide.length} characters; read the rest with: ` +
      `sed -n '1p' '${join(workDir, "wide.txt")}' | cut -c2001-]`);
    expect(read.output).toContain("     2\tnext");
    expect(read.metadata).toMatchObject({ lineCount: 2, linesCut: 1, totalLines: 2 });
    const edit = await new EditFileTool().execute(
      { path: "wide.txt", oldText: "word", newText: "w", replaceAll: true },
      ctx(),
    );
    expect(edit.isError, edit.output).toBe(false);
    expect(readFileSync(join(workDir, "wide.txt"), "utf8")).toBe(`${"w ".repeat(20_000)}\nnext\n`);
  });

  it("read_file cuts a long first line further when the default cut still exceeds the limit", async () => {
    writeFileSync(join(workDir, "dense.txt"), `${"가".repeat(30_000)}\n`);
    const read = await new ReadFileTool().execute({ path: "dense.txt" }, ctx());
    expect(read.isError, read.output).toBe(false);
    expect(trimOversizedToolResult(read.output).truncated).toBeUndefined();
    expect(read.output).toContain("[line 1 cut: showing ");
    expect(read.output).toContain("of 30000 characters");
  });

  it("a partial read admits an edit anywhere in the unchanged file", async () => {
    writeFileSync(join(workDir, "partial.txt"), "first\nsecond\nthird\n");
    const read = await new ReadFileTool().execute({ path: "partial.txt", offset: 0, limit: 1 }, ctx());
    expect(read.isError).toBe(false);
    const edit = await new EditFileTool().execute(
      { path: "partial.txt", oldText: "third", newText: "3rd" },
      ctx(),
    );
    expect(edit.isError, edit.output).toBe(false);
  });

  it("list_files returns depth-limited directory entries", async () => {
    const result = await new ListFilesTool().execute(
      { path: ".", depth: 2, limit: 20 },
      ctx(),
    );

    expect(result.isError).toBe(false);
    const body = parse(result.output);
    const entries = body.entries as Array<{ relativePath: string; type: string }>;
    expect(entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relativePath: "README.md", type: "file" }),
        expect.objectContaining({ relativePath: "src", type: "directory" }),
        expect.objectContaining({ relativePath: "src/a.ts", type: "file" }),
      ]),
    );
  });

  it("glob_files matches paths without reading file contents", async () => {
    const result = await new GlobFilesTool().execute(
      { path: ".", pattern: "src/**/*.ts", limit: 20 },
      ctx(),
    );

    expect(result.isError).toBe(false);
    const body = parse(result.output);
    const matches = body.matches as string[];
    expect(matches).toHaveLength(2);
    expect(matches.some((p) => portablePath(p).endsWith("src/a.ts"))).toBe(true);
    expect(matches.some((p) => portablePath(p).endsWith("src/nested/b.ts"))).toBe(true);
  });

  it("grep_files matches content lines with file and line", async () => {
    const result = await new GrepFilesTool().execute(
      { path: ".", pattern: "needle", include: "**/*.ts", limit: 20 },
      ctx(),
    );

    expect(result.isError, result.output).toBe(false);
    expect(result.output).toContain("2 lines in 2 files");
    expect(result.output).toContain(`${join(workDir, "src", "a.ts")}\n  2: needle one`);
    expect(result.output).toContain(`${join(workDir, "src", "nested", "b.ts")}\n  2: needle two`);
    expect(result.output).not.toContain("README.md");
  });

  it("list/glob/grep skip sensitive descendants under an allowed root", async () => {
    mkdirSync(join(workDir, ".ssh"), { recursive: true });
    mkdirSync(join(workDir, ".ave", "secrets"), { recursive: true });
    writeFileSync(join(workDir, ".env"), "needle secret\n", "utf8");
    writeFileSync(join(workDir, ".ssh", "id_rsa"), "needle key\n", "utf8");
    writeFileSync(join(workDir, ".ave", "secrets", "token.txt"), "needle token\n", "utf8");

    const listed = await new ListFilesTool().execute({ path: ".", depth: 4, limit: 50 }, ctx());
    expect(listed.isError).toBe(false);
    const entries = parse(listed.output).entries as Array<{ relativePath: string }>;
    expect(entries.map((entry) => entry.relativePath)).not.toEqual(
      expect.arrayContaining([".env", ".ssh", ".ssh/id_rsa", ".ave/secrets/token.txt"]),
    );

    const globbed = await new GlobFilesTool().execute({ path: ".", pattern: "**/.env", limit: 50 }, ctx());
    expect(globbed.isError).toBe(false);
    expect(parse(globbed.output).matches).toEqual([]);

    for (const outputMode of ["content", "files_with_matches", "count"] as const) {
      const grepped = await new GrepFilesTool().execute({ path: ".", pattern: "needle", limit: 50, outputMode }, ctx());
      expect(grepped.isError, grepped.output).toBe(false);
      expect(grepped.output).toContain("README.md");
      for (const hidden of ["secret", "id_rsa", ".env", "token"]) expect(grepped.output).not.toContain(hidden);
    }
  });

  it.each([".ave", "custom-profile"])("refuses subscription runtime file access in %s", async (profileName) => {
    const profile = join(workDir, profileName);
    const runtime = join(profile, "subscription-runtimes", "codex-v3-home");
    const target = join(runtime, "auth.json");
    const inert = '{"token":"inert-test-value"}\n';
    mkdirSync(runtime, { recursive: true });
    writeFileSync(target, inert, "utf8");
    vi.stubEnv("AVE_HOME", profile);
    try {
      const read = await new ReadFileTool().execute({ path: target }, ctx());
      expect(read.isError).toBe(true);
      expect(read.output).toContain("Sensitive path:");
      expect(read.output).not.toContain("inert-test-value");
      const write = await new WriteFileTool().execute({ path: target, content: "replaced" }, ctx());
      expect(write.isError).toBe(true);
      expect(write.output).toContain("Sensitive path:");
      expect(readFileSync(target, "utf8")).toBe(inert);
      const scanned = await new GrepFilesTool().execute({ path: ".", pattern: "inert-test-value", limit: 50 }, ctx());
      expect(scanned.isError, scanned.output).toBe(false);
      expect(scanned.output).toContain("No matches found.");
      expect(scanned.output).not.toContain("inert-test-value");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("write-capable file tools scope approval cache keys to canonical paths", () => {
    expect(new WriteFileTool().approvalCacheKey({ path: "src/a.ts" }, { cwd: workDir })).toBe(
      `path:${join(workDir, "src", "a.ts")}`,
    );
    expect(new EditFileTool().approvalCacheKey({ path: "~/notes.md" }, { cwd: workDir })).toBe(
      `path:${join(homedir(), "notes.md")}`,
    );
    expect(new MultiEditTool().approvalCacheKey({ path: "README.md" }, { cwd: workDir })).toBe(
      `path:${join(workDir, "README.md")}`,
    );
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "*** Move to: src/z.ts",
      "@@",
      "-alpha",
      "+ALPHA",
      "*** Add File: README.md",
      "+new",
      "*** End Patch",
    ].join("\n");
    expect(JSON.parse(new ApplyPatchTool().approvalCacheKey({ patch }, { cwd: workDir }))).toEqual({
      operation: "apply_patch",
      paths: [join(workDir, "README.md"), join(workDir, "src", "a.ts"), join(workDir, "src", "z.ts")].sort(),
    });
    expect(() => new ApplyPatchTool().approvalCacheKey({ patch: "not a patch" }, { cwd: workDir }))
      .toThrow("invalid patch");
    expect(new DeleteFileTool().approvalCacheKey({ path: "README.md" }, { cwd: workDir })).toBe(
      `path:${join(workDir, "README.md")}`,
    );
    expect(new MoveFileTool().approvalCacheKey(
      { sourcePath: "README.md", destinationPath: "docs/README.md" },
      { cwd: workDir },
    )).toBe(`source:${join(workDir, "README.md")}:destination:${join(workDir, "docs", "README.md")}`);
  });

  it("write-capable approval cache keys require explicit cwd", () => {
    expect(() => new WriteFileTool().approvalCacheKey({ path: "src/a.ts" })).toThrow("explicit cwd");
  });

  it("glob_files filters before applying the result limit", async () => {
    for (let i = 0; i < 8; i += 1) {
      writeFileSync(join(workDir, `aaa-${i}.txt`), "noise\n", "utf8");
    }
    writeFileSync(join(workDir, "zzz-target.ts"), "late\n", "utf8");

    const result = await new GlobFilesTool().execute(
      { path: ".", pattern: "**/*target.ts", limit: 1 },
      ctx(),
    );

    expect(result.isError).toBe(false);
    const body = parse(result.output);
    expect(body.matches).toEqual([expect.stringContaining("zzz-target.ts")]);
  });

  it("grep_files scans beyond early non-matching files before applying the match limit", async () => {
    for (let i = 0; i < 8; i += 1) {
      writeFileSync(join(workDir, `aaa-${i}.txt`), "noise\n", "utf8");
    }
    writeFileSync(join(workDir, "zzz-target.txt"), "needle late\n", "utf8");

    const result = await new GrepFilesTool().execute(
      { path: ".", pattern: "needle late", limit: 1 },
      ctx(),
    );

    expect(result.isError, result.output).toBe(false);
    expect(result.output).toContain("zzz-target.txt\n  1: needle late");
  });

  it("write_file creates parent directories and writes full content", async () => {
    const target = join("generated", "out.txt");
    const result = await new WriteFileTool().execute(
      { path: target, content: "created\n" },
      ctx(),
    );

    expect(result.isError).toBe(false);
    expect(readFileSync(join(workDir, target), "utf8")).toBe("created\n");
  });

  it("write_file uses unique temp files under parallel writes to the same target", async () => {
    const tool = new WriteFileTool();
    const [a, b] = await Promise.all([
      tool.execute({ path: "generated/race.txt", content: "one\n" }, ctx()),
      tool.execute({ path: "generated/race.txt", content: "two\n" }, ctx()),
    ]);

    expect(a.isError).toBe(false);
    expect(b.isError).toBe(false);
    expect(["one\n", "two\n"]).toContain(readFileSync(join(workDir, "generated", "race.txt"), "utf8"));
  });

  it("write_file overwrite emits path and bytes without kind sentinel", async () => {
    writeFileSync(join(workDir, "snap.txt"), "first line\nsecond line\n", "utf8");
    await readFirst("snap.txt");
    const result = await new WriteFileTool().execute(
      { path: "snap.txt", content: "first line\nupdated line\n" },
      ctx(),
    );

    expect(result.isError).toBe(false);
    const parsed = parse(result.output);
    // Diff bodies contain metadata only; full pre/post images live in sidecars.
    expect(parsed.path).toMatch(/snap\.txt$/);
    expect(typeof parsed.bytes).toBe("number");
    expect(parsed.truncated).toBeUndefined();
    expect(parsed.hasSidecar).toBeUndefined();
  });

  it("write_file new file emits path and bytes without truncated flag", async () => {
    const result = await new WriteFileTool().execute(
      { path: "generated/fresh.txt", content: "hello\n" },
      ctx(),
    );

    expect(result.isError).toBe(false);
    const parsed = parse(result.output);
    expect(parsed.path).toMatch(/fresh\.txt$/);
    expect(parsed.bytes).toBe(Buffer.byteLength("hello\n", "utf8"));
    expect(parsed.truncated).toBeUndefined();
  });

  it("write_file large content sets truncated=true in output", async () => {
    const big = "x".repeat(10_000);
    const result = await new WriteFileTool().execute(
      { path: "generated/big.txt", content: big },
      ctx(),
    );

    expect(result.isError).toBe(false);
    const parsed = parse(result.output);
    expect(parsed.truncated).toBe(true);
    expect(parsed.bytes).toBe(Buffer.byteLength(big, "utf8"));
    expect(parsed.after).toBeUndefined();
  });

  it("edit_file replaces a single exact match", async () => {
    await readFirst("README.md");
    const result = await new EditFileTool().execute(
      { path: "README.md", oldText: "needle docs", newText: "updated docs" },
      ctx(),
    );

    expect(result.isError).toBe(false);
    expect(readFileSync(join(workDir, "README.md"), "utf8")).toContain("updated docs");
  });

  it("edit_file fails on ambiguous matches unless replaceAll is explicit", async () => {
    writeFileSync(join(workDir, "dupe.txt"), "x\nx\n", "utf8");
    await readFirst("dupe.txt");

    const result = await new EditFileTool().execute(
      { path: "dupe.txt", oldText: "x", newText: "y" },
      ctx(),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("matched 2 times");
  });

  it("multi_edit applies multiple exact replacements atomically", async () => {
    await readFirst("README.md");
    const result = await new MultiEditTool().execute(
      {
        path: "README.md",
        replacements: [
          { oldText: "# Ave", newText: "# Ave Project" },
          { oldText: "needle docs", newText: "patched docs" },
        ],
      },
      ctx(),
    );

    expect(result.isError).toBe(false);
    expect(readFileSync(join(workDir, "README.md"), "utf8")).toBe("# Ave Project\npatched docs\n");
  });

  it("multi_edit fails before writing when a later replacement is missing", async () => {
    await readFirst("README.md");
    const result = await new MultiEditTool().execute(
      {
        path: "README.md",
        replacements: [
          { oldText: "# Ave", newText: "# Changed" },
          { oldText: "missing hunk", newText: "nope" },
        ],
      },
      ctx(),
    );

    expect(result.isError).toBe(true);
    expect(readFileSync(join(workDir, "README.md"), "utf8")).toBe("# Ave\nneedle docs\n");
  });

  it("move_file renames a file and creates parent directories", async () => {
    const result = await new MoveFileTool().execute(
      { sourcePath: "README.md", destinationPath: "docs/README.md" },
      ctx(),
    );

    expect(result.isError).toBe(false);
    expect(existsSync(join(workDir, "README.md"))).toBe(false);
    expect(readFileSync(join(workDir, "docs", "README.md"), "utf8")).toBe("# Ave\nneedle docs\n");
  });

  it("move_file overwrite=false does not clobber a concurrently-created destination", async () => {
    writeFileSync(join(workDir, "one.txt"), "one\n", "utf8");
    writeFileSync(join(workDir, "two.txt"), "two\n", "utf8");
    const tool = new MoveFileTool();

    const results = await Promise.all([
      tool.execute({ sourcePath: "one.txt", destinationPath: "race/out.txt" }, ctx()),
      tool.execute({ sourcePath: "two.txt", destinationPath: "race/out.txt" }, ctx()),
    ]);

    expect(results.filter((result) => !result.isError)).toHaveLength(1);
    expect(results.filter((result) => result.isError && result.output.includes("destination exists"))).toHaveLength(1);
    expect(["one\n", "two\n"]).toContain(readFileSync(join(workDir, "race", "out.txt"), "utf8"));
  });

  it("delete_file removes a regular file", async () => {
    const result = await new DeleteFileTool().execute(
      { path: "README.md" },
      ctx(),
    );

    expect(result.isError).toBe(false);
    expect(existsSync(join(workDir, "README.md"))).toBe(false);
  });

  it("rejects a WRITE outside the sandbox boundary", async () => {
    const outside = mkdtempSync(join(tmpdir(), "ave-file-tools-outside-"));
    try {
      const result = await new WriteFileTool().execute(
        { path: join(outside, "x.txt"), content: "nope" },
        ctx(),
      );

      expect(result.isError).toBe(true);
      expect(result.output).toContain("Sandbox:");
      expect(existsSync(join(outside, "x.txt"))).toBe(false);
    } finally {
      await cleanupTmpDir(outside);
    }
  });

  // Directory boundaries confine mutations; outside reads remain subject to the sensitive-path deny-list.
  it("reads a path outside the sandbox boundary", async () => {
    const outside = mkdtempSync(join(tmpdir(), "ave-file-tools-outside-read-"));
    try {
      writeFileSync(join(outside, "x.txt"), "outside content\n", "utf8");
      const result = await new ReadFileTool().execute(
        { path: join(outside, "x.txt") },
        ctx(),
      );

      expect(result.isError).toBe(false);
      expect(result.output).toContain("outside content");
    } finally {
      await cleanupTmpDir(outside);
    }
  });

  it("rejects that same read once the user re-fences reads", async () => {
    const outside = mkdtempSync(join(tmpdir(), "ave-file-tools-outside-fenced-"));
    try {
      writeFileSync(join(outside, "x.txt"), "outside content\n", "utf8");
      const result = await new ReadFileTool().execute(
        { path: join(outside, "x.txt") },
        { ...ctx(), blockReadsOutsideWorkingDirectories: true },
      );

      expect(result.isError).toBe(true);
      expect(result.output).toContain("Sandbox:");
    } finally {
      await cleanupTmpDir(outside);
    }
  });

  // Wider directory reads must not relax the sensitive-path deny-list.
  it("still refuses a read of a Layer 0 protected path", async () => {
    const result = await new ReadFileTool().execute(
      { path: join(homedir(), ".ssh", "id_rsa") },
      ctx(),
    );

    expect(result.isError).toBe(true);
    expect(result.output).toContain("Sensitive path:");
  });

  it("honors executor-threaded additionalDirectories for extra workspace roots", async () => {
    const outside = mkdtempSync(join(tmpdir(), "ave-file-tools-extra-"));
    try {
      const target = join(outside, "allowed.txt");
      writeFileSync(target, "outside but authorized\n", "utf8");

      const result = await new ReadFileTool().execute(
        { path: target },
        { cwd: workDir, extraAllowedDirectories: [outside], metadata: {} },
      );

      expect(result.isError).toBe(false);
      expect(readLines(result.output)).toEqual(["outside but authorized"]);
    } finally {
      await cleanupTmpDir(outside);
    }
  });

  it("round-trips a slash-authorized extra dir into read_file sandbox scope", async () => {
    const outside = mkdtempSync(join(tmpdir(), "ave-file-tools-slash-extra-"));
    const settingsPath = join(workDir, "permissions.json");
    try {
      const target = join(outside, "allowed-by-slash.txt");
      writeFileSync(target, "slash authorized\n", "utf8");
      const parsed = parsePermissionDirCommand(`allow ${outside}`);
      if ("ok" in parsed) throw new Error(parsed.error);
      const dirResult = await dispatchPermissionDirCommand(
        parsed,
        settingsPath,
      );
      if (!dirResult.ok) throw new Error(dirResult.error);
      expect(dirResult.verb).toBe("allow");

      const extraAllowedDirectories = dirResult.verb === "allow" ? dirResult.persisted : [];
      const result = await new ReadFileTool().execute(
        { path: target },
        { cwd: workDir, extraAllowedDirectories, metadata: {} },
      );

      expect(result.isError).toBe(false);
      expect(readLines(result.output)).toEqual(["slash authorized"]);
    } finally {
      await cleanupTmpDir(outside);
    }
  });

  it("registers native file tools in the canonical registry", () => {
    const registry = new ToolRegistry();
    for (const tool of createFileTools()) registry.register(tool);

    const expectedPathFields = new Map<string, readonly string[]>([
      ["read_file", ["path"]],
      ["list_files", ["path"]],
      ["glob_files", ["path"]],
      ["grep_files", ["path"]],
      ["write_file", ["path"]],
      ["edit_file", ["path"]],
      ["multi_edit", ["path"]],
      ["apply_patch", ["patch#patch-envelope"]],
      ["copy_path", ["sourcePath", "destinationPath"]],
      ["extract_archive", ["archivePath", "destinationPath"]],
      ["move_file", ["sourcePath", "destinationPath"]],
      ["delete_file", ["path"]],
    ]);
    for (const [name, pathFields] of expectedPathFields) {
      const found = registry.findByName(name);
      expect(found).toBeDefined();
      expect(found?.source).toBe("builtin");
      expect(found?.pathFields).toEqual(pathFields);
    }
    expect(registry.findByName("read_file")?.category).toBe("read");
    expect(registry.findByName("write_file")?.category).toBe("write");
    expect(registry.findByName("multi_edit")?.category).toBe("write");
    expect(registry.findByName("apply_patch")?.category).toBe("write");
    expect(registry.findByName("copy_path")?.category).toBe("write");
    expect(registry.findByName("extract_archive")?.category).toBe("write");
  });
});

describe("apply_patch tool", () => {
  function patchOf(...body: string[]): { patch: string } {
    return { patch: ["*** Begin Patch", ...body, "*** End Patch"].join("\n") };
  }

  it("adds, updates, moves and deletes files in one call", async () => {
    await readFirst("src/a.ts");
    await readFirst("src/nested/b.ts");
    await readFirst("README.md");
    const result = await new ApplyPatchTool().execute(patchOf(
      "*** Add File: docs/new.md",
      "+# New",
      "+body",
      "*** Update File: src/a.ts",
      "@@ alpha",
      "-needle one",
      "+needle ONE",
      "*** Update File: src/nested/b.ts",
      "*** Move to: src/moved/b.ts",
      "@@",
      " beta",
      "-needle two",
      "+needle TWO",
      "*** Delete File: README.md",
    ), ctx());

    expect(result.isError, result.output).toBe(false);
    expect(result.output).toContain(`A ${join(workDir, "docs", "new.md")}`);
    expect(result.output).toContain(`D ${join(workDir, "README.md")}`);
    expect(readFileSync(join(workDir, "docs", "new.md"), "utf8")).toBe("# New\nbody\n");
    expect(readFileSync(join(workDir, "src", "a.ts"), "utf8")).toBe("alpha\nneedle ONE\nomega\n");
    expect(existsSync(join(workDir, "src", "nested", "b.ts"))).toBe(false);
    expect(readFileSync(join(workDir, "src", "moved", "b.ts"), "utf8")).toBe("beta\nneedle TWO\n");
    expect(existsSync(join(workDir, "README.md"))).toBe(false);
  });

  it("writes nothing when a later section fails", async () => {
    await readFirst("src/a.ts");
    const result = await new ApplyPatchTool().execute(patchOf(
      "*** Add File: docs/new.md",
      "+# New",
      "*** Update File: src/a.ts",
      "-not in the file",
      "+replacement",
    ), ctx());

    expect(result.isError).toBe(true);
    expect(result.output).toContain("expected lines not found");
    expect(existsSync(join(workDir, "docs", "new.md"))).toBe(false);
    expect(readFileSync(join(workDir, "src", "a.ts"), "utf8")).toBe("alpha\nneedle one\nomega\n");
  });

  it("refuses to update a file this session has not read", async () => {
    const result = await new ApplyPatchTool().execute(patchOf(
      "*** Update File: src/a.ts",
      "-alpha",
      "+ALPHA",
    ), ctx());
    expect(result.isError).toBe(true);
    expect(result.output).toContain("read it with read_file in this session first");
  });

  it("allows a following edit of a file it updated", async () => {
    await readFirst("src/a.ts");
    const patched = await new ApplyPatchTool().execute(patchOf(
      "*** Update File: src/a.ts",
      "-alpha",
      "+ALPHA",
    ), ctx());
    expect(patched.isError, patched.output).toBe(false);
    const edited = await new EditFileTool().execute({ path: "src/a.ts", oldText: "omega", newText: "OMEGA" }, ctx());
    expect(edited.isError, edited.output).toBe(false);
    expect(readFileSync(join(workDir, "src", "a.ts"), "utf8")).toBe("ALPHA\nneedle one\nOMEGA\n");
  });

  it("refuses to add a file that already exists", async () => {
    const result = await new ApplyPatchTool().execute(patchOf("*** Add File: README.md", "+x"), ctx());
    expect(result.isError).toBe(true);
    expect(result.output).toContain("already exists");
    expect(readFileSync(join(workDir, "README.md"), "utf8")).toBe("# Ave\nneedle docs\n");
  });

  it("refuses a path named by two sections", async () => {
    await readFirst("src/a.ts");
    const result = await new ApplyPatchTool().execute(patchOf(
      "*** Update File: src/a.ts",
      "-alpha",
      "+ALPHA",
      "*** Delete File: src/a.ts",
    ), ctx());
    expect(result.isError).toBe(true);
    expect(result.output).toContain("more than one section");
  });

  it("refuses a write outside the sandbox boundary before touching any file", async () => {
    const outside = mkdtempSync(join(tmpdir(), "ave-apply-patch-outside-"));
    try {
      const result = await new ApplyPatchTool().execute(patchOf(
        "*** Add File: docs/new.md",
        "+inside",
        `*** Add File: ${join(outside, "x.txt")}`,
        "+outside",
      ), ctx());
      expect(result.isError).toBe(true);
      expect(result.output).toContain("Sandbox:");
      expect(existsSync(join(workDir, "docs", "new.md"))).toBe(false);
      expect(existsSync(join(outside, "x.txt"))).toBe(false);
    } finally {
      await cleanupTmpDir(outside);
    }
  });

  it("refuses to delete a file this session has not read", async () => {
    const result = await new ApplyPatchTool().execute(patchOf("*** Delete File: README.md"), ctx());
    expect(result.isError).toBe(true);
    expect(result.output).toContain("read it with read_file in this session first");
    expect(existsSync(join(workDir, "README.md"))).toBe(true);
  });

  it.skipIf(!canCreateSymlinks())("refuses two sections that reach one file through a symlink", async () => {
    await readFirst("src/a.ts");
    symlinkSync(join(workDir, "src", "a.ts"), join(workDir, "alias.ts"));
    const result = await new ApplyPatchTool().execute(patchOf(
      "*** Update File: src/a.ts",
      "-alpha",
      "+ALPHA",
      "*** Update File: alias.ts",
      "-omega",
      "+OMEGA",
    ), ctx());
    expect(result.isError).toBe(true);
    expect(result.output).toContain("more than one section");
    expect(readFileSync(join(workDir, "src", "a.ts"), "utf8")).toBe("alpha\nneedle one\nomega\n");
  });

  it("reports a malformed patch", async () => {
    await expect(new ApplyPatchTool().execute({ patch: "*** Update File: src/a.ts\n-alpha" }, ctx()))
      .rejects.toThrow("invalid patch");
    expect(ApplyPatchInputSchema.safeParse({ patch: "*** Update File: src/a.ts\n-alpha" }).success).toBe(false);
  });
});

describe("WriteFileTool pre-image guard (MAJOR 1)", () => {
  let testHome: string;

  // Record binary or windowed pre-images that read_file cannot show in full.
  async function markRead(path: string, session: string): Promise<void> {
    const bytes = readFileSync(path);
    recordFileRead(session, await fileReadKey(path), {
      mtimeMs: statSync(path).mtimeMs,
      size: bytes.length,
      sha256: sha256Hex(bytes),
    });
  }

  beforeEach(() => {
    testHome = mkdtempSync(join(tmpdir(), "ave-write-guard-"));
    process.env.AVE_HOME = testHome;
  });

  afterEach(async () => {
    delete process.env.AVE_HOME;
    await cleanupTmpDir(testHome);
  });

  it("skips pre-image read and sets skipSidecar for a file exceeding MAX_TEXT_FILE_BYTES", async () => {
    // Use a real oversized file; ESM filesystem exports cannot be reconfigured with spyOn.
    const bigPath = join(workDir, "big.txt");
    const chunk = "x".repeat(1024);
    const buf = Buffer.alloc(2_100_000);
    buf.fill(chunk);
    writeFileSync(bigPath, buf);
    await markRead(bigPath, "s1");

    const result = await new WriteFileTool().execute(
      { path: bigPath, content: "new content" },
      { cwd: workDir, extraAllowedDirectories: [], metadata: { sessionId: "s1", toolUseId: "tu1" } },
    );

    expect(result.isError).toBe(false);
    const body = parse(result.output);
    expect(body.hasSidecar).toBeUndefined();
    expect(readFileSync(bigPath, "utf8")).toBe("new content");
  });

  it("skips pre-image read and sets skipSidecar for a binary pre-existing file", async () => {
    const binPath = join(workDir, "image.bin");
    writeFileSync(binPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0x00, 0x00]));
    await markRead(binPath, "s2");

    // Exceed the preview limit to prove binary pre-images suppress otherwise eligible sidecars.
    const largeAfter = "x".repeat(4097);
    const result = await new WriteFileTool().execute(
      { path: binPath, content: largeAfter },
      { cwd: workDir, extraAllowedDirectories: [], metadata: { sessionId: "s2", toolUseId: "tu2" } },
    );

    expect(result.isError).toBe(false);
    const body = parse(result.output);
    expect(body.truncated).toBe(true);
    // Binary pre-images must suppress sidecar writes even above the preview limit.
    expect(body.hasSidecar).toBe(false);
    expect(readFileSync(binPath, "utf8")).toBe(largeAfter);
  });

  it("writes sidecar normally for a small text pre-existing file", async () => {
    const txtPath = join(workDir, "small.txt");
    writeFileSync(txtPath, "before content", "utf8");
    await markRead(txtPath, "s3");

    const result = await new WriteFileTool().execute(
      { path: txtPath, content: "after content" },
      { cwd: workDir, extraAllowedDirectories: [], metadata: { sessionId: "s3", toolUseId: "tu3" } },
    );

    expect(result.isError).toBe(false);
    expect(readFileSync(txtPath, "utf8")).toBe("after content");
  });
});
