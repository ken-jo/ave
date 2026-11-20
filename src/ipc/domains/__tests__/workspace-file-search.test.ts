// Offer only files inside the current read scope and outside sensitive paths.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import {
  clearWorkspaceFileSearchCache,
  searchWorkspaceFiles,
} from "../workspace-file-search.js";

let base: string;
let workspace: string;
let outside: string;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "ave-file-search-")));
  workspace = join(base, "workspace");
  outside = join(base, "outside");
  mkdirSync(join(workspace, "src", "deep"), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(workspace, "src", "app.ts"), "x");
  writeFileSync(join(workspace, "src", "deep", "application.md"), "x");
  writeFileSync(join(workspace, "README.md"), "x");
  writeFileSync(join(workspace, ".env"), "SECRET=1");
  mkdirSync(join(workspace, ".ssh"));
  writeFileSync(join(workspace, ".ssh", "id_rsa"), "key");
  writeFileSync(join(outside, "app-secret.ts"), "x");
});

beforeEach(() => {
  clearWorkspaceFileSearchCache();
});

afterAll(async () => {
  await cleanupTmpDir(base);
});

const paths = (r: { matches: Array<{ relativePath: string }> }) => r.matches.map((m) => m.relativePath);

describe("searchWorkspaceFiles", () => {
  it("searches the named folder itself, so a large sibling cannot use up the match cap", async () => {
    const big = join(workspace, "many");
    const docs = join(workspace, "docs");
    mkdirSync(big);
    mkdirSync(docs);
    for (let i = 0; i < 120; i += 1) writeFileSync(join(big, `f${String(i).padStart(4, "0")}.txt`), "x");
    writeFileSync(join(docs, "notes-f0001.txt"), "x");
    writeFileSync(join(docs, "data.csv"), "x");
    const everywhere = await searchWorkspaceFiles({ query: "f0", roots: [workspace], cwd: workspace, extraAllowed: [] });
    expect(everywhere.matches.some((match) => match.path === join(docs, "notes-f0001.txt"))).toBe(false);
    const scoped = await searchWorkspaceFiles({
      query: "f0", roots: [workspace], cwd: workspace, extraAllowed: [], folder: { path: docs, root: workspace },
    });
    expect(scoped.matches).toEqual([{ path: join(docs, "notes-f0001.txt"), relativePath: "notes-f0001.txt", root: workspace, bytes: 1 }]);
    expect(scoped.truncated).toBe(false);
  });

  it("matches file names only in a folder search, and finds a file created after an earlier search", async () => {
    const assets = join(workspace, "assets");
    mkdirSync(join(assets, "ts-icons"), { recursive: true });
    writeFileSync(join(assets, "ts-icons", "blob.bin"), "x");
    const search = () => searchWorkspaceFiles({
      query: "ts", roots: [workspace], cwd: workspace, extraAllowed: [], folder: { path: assets, root: workspace },
    });
    // The folder name contains the query and a path-wide match would list it; the file's own name does not.
    expect((await search()).matches).toEqual([]);
    writeFileSync(join(assets, "parts.txt"), "x");
    expect(paths(await search())).toEqual(["parts.txt"]);
  });

  it("ranks basename-prefix matches first and returns relative paths", async () => {
    const result = await searchWorkspaceFiles({
      query: "app",
      roots: [workspace],
      cwd: workspace,
      extraAllowed: [],
    });
    expect(paths(result)).toEqual(["src/app.ts", "src/deep/application.md"]);
    expect(result.matches[0]).toMatchObject({ path: join(workspace, "src", "app.ts"), root: workspace, bytes: 1 });
  });

  it("never offers a sensitive path, by name or under a sensitive directory", async () => {
    const all = await searchWorkspaceFiles({ query: "", roots: [workspace], cwd: workspace, extraAllowed: [] });
    expect(paths(all)).not.toContain(".env");
    expect(paths(all).some((p) => p.includes(".ssh"))).toBe(false);
    const env = await searchWorkspaceFiles({ query: ".env", roots: [workspace], cwd: workspace, extraAllowed: [] });
    expect(env.matches).toEqual([]);
  });

  it("never offers a path outside the read scope, even when handed a stale root", async () => {
    const result = await searchWorkspaceFiles({
      query: "app",
      roots: [workspace, outside],
      cwd: workspace,
      extraAllowed: [],
    });
    expect(result.matches.every((m) => m.path.startsWith(workspace))).toBe(true);
    expect(paths(result)).not.toContain("app-secret.ts");
  });

  it("offers an additional root once it is in the read scope", async () => {
    const result = await searchWorkspaceFiles({
      query: "app-secret",
      roots: [workspace, outside],
      cwd: workspace,
      extraAllowed: [outside],
    });
    expect(paths(result)).toEqual(["app-secret.ts"]);
  });
});
