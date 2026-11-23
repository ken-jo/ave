// windows-permission
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import type { ToolExecutionContext } from "../base.js";
import { GrepFilesTool } from "../file-tools.js";
import {
  buildRipgrepArgs,
  GrepFilesInputSchema,
  isWithinAdmittedRoot,
  liesUnderRealRoot,
  resolveBundledRipgrep,
  searchWithRipgrep,
} from "../grep-search.js";
import { resolvePinnedRipgrepExecutable } from "../ripgrep-executable.js";

let workDir: string;

function grep(input: Record<string, unknown>) {
  const context: ToolExecutionContext = { cwd: workDir, extraAllowedDirectories: [], metadata: {} };
  return new GrepFilesTool().execute({ path: ".", ...input }, context);
}

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "ave-grep-search-"));
  mkdirSync(join(workDir, "src"), { recursive: true });
  writeFileSync(join(workDir, "src", "a.ts"), "one\nNeedle alpha\nthree\nfour\nfive\nneedle beta\n", "utf8");
  writeFileSync(join(workDir, "src", "b.py"), "needle gamma\n", "utf8");
  writeFileSync(join(workDir, "notes.md"), "no match here\n", "utf8");
});

afterEach(async () => {
  await cleanupTmpDir(workDir);
});

describe("grep_files ripgrep engine", () => {
  it("reads an explicitly admitted secret target while keeping broad searches filtered", async () => {
    writeFileSync(join(workDir, ".env"), "needle secret-value\n");
    const explicit = await grep({ path: ".env", pattern: "needle" });
    expect(explicit.isError, explicit.output).toBe(false);
    expect(explicit.output).toContain("secret-value");
    const broad = await grep({ pattern: "needle" });
    expect(broad.output).not.toContain("secret-value");
  });

  it("searches an explicitly admitted secret directory while retaining host credential exclusions", async () => {
    mkdirSync(join(workDir, ".ssh"));
    writeFileSync(join(workDir, ".ssh", "id_rsa"), "needle synthetic-key\n");
    writeFileSync(join(workDir, ".ssh", "ave-secrets.json"), "needle host-token\n");
    const result = await grep({ path: ".ssh", pattern: "needle" });
    expect(result.isError, result.output).toBe(false);
    expect(result.output).toContain("synthetic-key");
    expect(result.output).not.toContain("host-token");
  });

  it("does not admit a sibling directory that only shares the admitted secret dir's name prefix", async () => {
    mkdirSync(join(workDir, ".ssh"));
    writeFileSync(join(workDir, ".ssh", "id_rsa"), "needle synthetic-key\n");
    mkdirSync(join(workDir, ".ssh-other"));
    writeFileSync(join(workDir, ".ssh-other", "id_rsa"), "needle sibling-secret\n");
    // The admitted-root membership test uses a separator boundary (root + sep),
    // not a bare string prefix, so admitting ".ssh" never admits ".ssh-other".
    const result = await grep({ path: ".ssh", pattern: "needle" });
    expect(result.isError, result.output).toBe(false);
    expect(result.output).toContain("synthetic-key");
    expect(result.output).not.toContain("sibling-secret");
  });

  it("resolves the ripgrep build of the pinned per-platform package", () => {
    const executable = resolveBundledRipgrep();
    expect(existsSync(executable)).toBe(true);
    expect(executable).toMatch(/@vscode[\\/]ripgrep-[a-z0-9]+-[a-z0-9]+[\\/]bin[\\/]rg(\.exe)?$/);
  });

  it("refuses a target with no pinned package instead of searching PATH", () => {
    const unavailable = new Error("unavailable");
    expect(() => resolvePinnedRipgrepExecutable(() => unavailable, "freebsd", "x64")).toThrow(unavailable);
    expect(() => resolvePinnedRipgrepExecutable(() => unavailable, "linux", "ia32")).toThrow(unavailable);
  });

  it("builds argv that ignores user config and cannot read the pattern or path as flags", () => {
    const args = buildRipgrepArgs("/w", GrepFilesInputSchema.parse({ pattern: "-x" }));
    expect(args[0]).toBe("--no-config");
    expect(args).toContain("--line-buffered");
    expect(args.slice(-4)).toEqual(["--regexp", "-x", "--", "/w"]);
    expect(args.some((arg) => arg.startsWith("--pre") || arg === "--follow" || arg.startsWith("--max-filesize"))).toBe(false);
  });

  it("finds a pattern that starts with a dash", async () => {
    writeFileSync(join(workDir, "flags.txt"), "use --verbose here\n", "utf8");
    const result = await grep({ pattern: "--verbose" });
    expect(result.isError, result.output).toBe(false);
    expect(result.output).toContain("1: use --verbose here");
  });

  it("lists files, counts lines, and filters by case, glob and type", async () => {
    const files = await grep({ pattern: "needle", outputMode: "files_with_matches" });
    expect(files.output).toContain(`${join(workDir, "src", "a.ts")}\n${join(workDir, "src", "b.py")}`);
    expect(files.output).not.toContain("notes.md");

    const counts = await grep({ pattern: "needle", outputMode: "count", caseSensitive: false });
    expect(counts.output).toContain(`${join(workDir, "src", "a.ts")}: 2`);
    expect(counts.output).toContain(`${join(workDir, "src", "b.py")}: 1`);

    const typed = await grep({ pattern: "needle", type: "py" });
    expect(typed.output).toContain("1: needle gamma");
    expect(typed.output).not.toContain("a.ts");

    const globbed = await grep({ pattern: "needle", include: "*.ts" });
    expect(globbed.output).toContain("6: needle beta");
    expect(globbed.output).not.toContain("b.py");
  });

  it("returns context lines and marks gaps between groups", async () => {
    const result = await grep({ pattern: "needle", include: "*.ts", context: 1, caseSensitive: false });
    expect(result.isError, result.output).toBe(false);
    expect(result.output).toContain(
      [join(workDir, "src", "a.ts"), "  1- one", "  2: Needle alpha", "  3- three", "  --", "  5- five", "  6: needle beta"].join("\n"),
    );
  });

  it("matches across lines in multiline mode", async () => {
    const single = await grep({ pattern: "alpha.three" });
    expect(single.output).toContain("No matches found.");
    const multi = await grep({ pattern: "alpha.three", multiline: true });
    expect(multi.output).toContain("2: Needle alpha");
    expect(multi.output).toContain("3: three");
  });

  it.each(["content", "count", "files_with_matches"] as const)("retains an ordinary completed %s no-match", async (outputMode) => {
    const result = await grep({ pattern: "absent from every file", outputMode });
    expect(result.isError, result.output).toBe(false);
    expect(result.output).toContain("No matches found.");
  });

  it("pages with limit and offset and says where to continue", async () => {
    const first = await grep({ pattern: "needle", caseSensitive: false, limit: 2 });
    expect(first.output).toContain("2: Needle alpha");
    expect(first.output).toContain("6: needle beta");
    expect(first.output).toContain("offset=2");
    expect(first.metadata).toMatchObject({ truncated: true, nextOffset: 2 });

    const second = await grep({ pattern: "needle", caseSensitive: false, limit: 2, offset: 2 });
    expect(second.output).toContain("1: needle gamma");
    expect(second.output).not.toContain("alpha");
    expect(second.metadata).toMatchObject({ truncated: false });
  });

  it("respects ignore files, searches hidden files, and skips .git", async () => {
    mkdirSync(join(workDir, ".git"), { recursive: true });
    writeFileSync(join(workDir, ".git", "config"), "needle in git\n", "utf8");
    writeFileSync(join(workDir, ".gitignore"), "generated/\n", "utf8");
    mkdirSync(join(workDir, "generated"), { recursive: true });
    writeFileSync(join(workDir, "generated", "out.ts"), "needle generated\n", "utf8");
    writeFileSync(join(workDir, ".hidden.ts"), "needle hidden\n", "utf8");
    const result = await grep({ pattern: "needle", outputMode: "files_with_matches" });
    expect(result.output).toContain(".hidden.ts");
    expect(result.output).not.toContain("generated");
    expect(result.output).not.toContain(join(".git", "config"));
  });

  it("searches files larger than the former 1 MB skip and caps long lines", async () => {
    writeFileSync(join(workDir, "big.txt"), `${"x".repeat(1_500_000)}\nneedle after a huge line\n`, "utf8");
    const result = await grep({ pattern: "needle after", include: "big.txt" });
    expect(result.output).toContain("2: needle after a huge line");
    writeFileSync(join(workDir, "wide.txt"), `${"y".repeat(5_000)}needle${"z".repeat(5_000)}\n`, "utf8");
    const wide = await grep({ pattern: "needle", include: "wide.txt" });
    expect(wide.output.length).toBeLessThan(2_000);
    expect(wide.output).toContain("omitted");
  });

  it("reports an invalid pattern as a tool error with ripgrep's diagnosis", async () => {
    const result = await grep({ pattern: "(unclosed" });
    expect(result.isError).toBe(true);
    expect(result.output).toContain("regex parse error");
  });

  it("fails clearly when the bundled ripgrep is missing", async () => {
    const result = await searchWithRipgrep(
      workDir,
      GrepFilesInputSchema.parse({ pattern: "needle" }),
      undefined,
      () => { throw new Error("grep_files is unavailable: missing"); },
    );
    expect(result).toEqual({ output: "grep_files is unavailable: missing", isError: true });
  });

  it("searches a single file root", async () => {
    const result = await grep({ path: join("src", "b.py"), pattern: "gamma" });
    expect(result.output).toContain(`${join(workDir, "src", "b.py")}\n  1: needle gamma`);
  });

  it("treats binary and UTF-16 files as the search of the tree does", async () => {
    const folder = join(workDir, "encoded");
    mkdirSync(folder);
    const utf16 = (bom: number[], text: string, encoding: "le" | "be"): Buffer => {
      const units = Buffer.from(text, "utf16le");
      return Buffer.concat([Buffer.from(bom), encoding === "le" ? units : units.swap16()]);
    };
    const filler = "filler line of text\n".repeat(6_000);
    // Zero bytes, but no zero code unit: U+0100, then U+0200 beside a space, which puts two zero bytes side by side.
    writeFileSync(join(folder, "utf16be.txt"), utf16([0xfe, 0xff], "Āneedle Ȁ one\n", "be"));
    writeFileSync(join(folder, "utf16le.txt"), utf16([0xff, 0xfe], "hello\nneedle two\nbye\n", "le"));
    writeFileSync(join(folder, "utf16le-late-nul.txt"), utf16([0xff, 0xfe], `needle early\n${filler}\0\nneedle late\n`, "le"));
    writeFileSync(join(folder, "near-nul.txt"), "needle first\nx\0y\nneedle second\n");
    writeFileSync(join(folder, "late-nul.txt"), `needle early\n${filler}z\0z\nneedle late\n`);
    const search = (outputMode: string) => grep({ path: "encoded", pattern: "needle", outputMode });

    const lines = await search("content");
    expect(lines.output).toContain(`${join(folder, "utf16be.txt")}\n  1: Āneedle Ȁ one`);
    expect(lines.output).toContain(`${join(folder, "utf16le.txt")}\n  2: needle two`);
    // A file that turns binary shows its lines up to its first NUL; one that does at once, none.
    expect(lines.output).toContain(`${join(folder, "utf16le-late-nul.txt")}\n  1: needle early`);
    expect(lines.output).toContain(`${join(folder, "late-nul.txt")}\n  1: needle early`);
    expect(lines.output).not.toContain("needle late");
    expect(lines.output).not.toContain("near-nul.txt");

    const names = await search("files_with_matches");
    for (const name of ["utf16be.txt", "utf16le.txt", "utf16le-late-nul.txt", "late-nul.txt"]) {
      expect(names.output).toContain(join(folder, name));
    }
    expect(names.output).not.toContain("near-nul.txt");

    // A count is of the whole file, and a file binary anywhere has none.
    const counts = await search("count");
    expect(counts.output).toContain(`${join(folder, "utf16be.txt")}: 1`);
    expect(counts.output).toContain(`${join(folder, "utf16le.txt")}: 1`);
    for (const name of ["utf16le-late-nul.txt", "late-nul.txt", "near-nul.txt"]) expect(counts.output).not.toContain(name);
    // Across lines, the binary test reaches only as far as the last match.
    const across = await grep({ path: "encoded", pattern: "early\\n", multiline: true, outputMode: "count" });
    expect(across.output).toContain(`${join(folder, "late-nul.txt")}: 1`);
    expect(across.output).toContain(`${join(folder, "utf16le-late-nul.txt")}: 1`);

    // A file searched by name is searched whole, binary or not: its matches are counted and it is listed, its lines held back.
    const named = (outputMode: string) => grep({ path: join("encoded", "near-nul.txt"), pattern: "needle", outputMode });
    expect((await named("count")).output).toContain(`${join(folder, "near-nul.txt")}: 2`);
    expect((await named("files_with_matches")).output).toContain(join(folder, "near-nul.txt"));
    expect((await named("content")).output).toContain("No matches found.");
  });

  it("stops ripgrep when the turn is aborted", async () => {
    const controller = new AbortController();
    controller.abort(new Error("turn aborted"));
    const result = await searchWithRipgrep(
      workDir,
      GrepFilesInputSchema.parse({ pattern: "needle" }),
      controller.signal,
    );
    expect(result).toMatchObject({ isError: true, output: "turn aborted" });
  });
});

describe("liesUnderRealRoot", () => {
  // Explicit platform arguments so every case runs on every host.
  it("takes a filesystem or drive root as its own boundary", () => {
    expect(liesUnderRealRoot("/", "/", "linux")).toBe(true);
    expect(liesUnderRealRoot("/a/b", "/", "linux")).toBe(true);
    expect(liesUnderRealRoot("C:\\", "C:\\", "win32")).toBe(true);
    expect(liesUnderRealRoot("C:\\x\\y", "C:\\", "win32")).toBe(true);
    expect(liesUnderRealRoot("D:\\x", "C:\\", "win32")).toBe(false);
  });

  it("keeps a prefix-sharing sibling out of any other root", () => {
    expect(liesUnderRealRoot("/w/a", "/w", "linux")).toBe(true);
    expect(liesUnderRealRoot("/w-other/a", "/w", "linux")).toBe(false);
    expect(liesUnderRealRoot("C:\\w\\a", "C:\\w", "win32")).toBe(true);
    expect(liesUnderRealRoot("C:\\w-other\\a", "C:\\w", "win32")).toBe(false);
    // On posix a backslash is a filename byte, not a separator.
    expect(liesUnderRealRoot("/w\\a", "/w", "linux")).toBe(false);
  });
});

describe("isWithinAdmittedRoot", () => {
  // Explicit platform arguments so every case runs on every host.
  it("admits the root and its descendants at a separator boundary on win32", () => {
    expect(isWithinAdmittedRoot("C:\\h\\.ssh", "C:\\h\\.ssh", "win32")).toBe(true);
    expect(isWithinAdmittedRoot("C:\\h\\.ssh\\id_rsa", "C:\\h\\.ssh", "win32")).toBe(true);
    // ripgrep may echo a mixed/forward-slash spelling under the same root.
    expect(isWithinAdmittedRoot("C:/h/.ssh/id_rsa", "C:\\h\\.ssh", "win32")).toBe(true);
  });

  it("admits the root and its descendants at a separator boundary on posix", () => {
    expect(isWithinAdmittedRoot("/h/.ssh", "/h/.ssh", "linux")).toBe(true);
    expect(isWithinAdmittedRoot("/h/.ssh/id_rsa", "/h/.ssh", "linux")).toBe(true);
  });

  it("does not fold a backslash into a separator on posix (it is a legal filename byte)", () => {
    // A file literally named ".ssh\id_rsa" sits beside .ssh, not inside it, so
    // admitting the .ssh directory must not admit that sibling file.
    expect(isWithinAdmittedRoot("/h/.ssh\\id_rsa", "/h/.ssh", "linux")).toBe(false);
  });

  it("keeps a prefix-sharing sibling out on both platforms", () => {
    expect(isWithinAdmittedRoot("C:\\h\\.ssh-other\\id_rsa", "C:\\h\\.ssh", "win32")).toBe(false);
    expect(isWithinAdmittedRoot("/h/.ssh-other/id_rsa", "/h/.ssh", "linux")).toBe(false);
  });

  it("is case-exact, so a differently-cased sibling dir is not admitted on either platform", () => {
    expect(isWithinAdmittedRoot("C:\\h\\.SSH\\id_rsa", "C:\\h\\.ssh", "win32")).toBe(false);
    expect(isWithinAdmittedRoot("/h/.SSH/id_rsa", "/h/.ssh", "linux")).toBe(false);
  });
});
