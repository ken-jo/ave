/**
 * Composer `@file` search: main offers only files the read guard would let
 * `read_file` open — inside the current roots, never a Layer-0 sensitive path.
 */
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
    // `outside` is passed as a root but is not in the read scope (cwd + extraAllowed):
    // the read guard, not the walk, decides — so nothing under it is offered.
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
