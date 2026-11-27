// Windows search listings observe locality independently.
import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";

const { collectFiles } = vi.hoisted(() => ({
  collectFiles: vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { ok: true, value: { files: [], truncated: false } };
  }),
}));

vi.mock("../../../tools/file-tools.js", () => ({ collectFiles }));

import { clearWorkspaceFileSearchCache, searchWorkspaceFiles } from "../workspace-file-search.js";

describe("searchWorkspaceFiles in-flight listing", () => {
  it("refreshes concurrent Windows listings and coalesces other listings", async () => {
    clearWorkspaceFileSearchCache();
    const args = (query: string) => ({ query, roots: ["/ws"], cwd: "/ws", extraAllowed: [] });
    await Promise.all([
      searchWorkspaceFiles(args("a")),
      searchWorkspaceFiles(args("ap")),
      searchWorkspaceFiles(args("app")),
    ]);
    expect(collectFiles).toHaveBeenCalledTimes(process.platform === "win32" ? 3 : 1);
  });
});

it.skipIf(process.platform === "win32")("resolves the next POSIX workspace root after the previous walk", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "workspace-search-order-")));
  try {
    const [first, original, replacement, alias] = ["first", "original", "replacement", "alias"].map(name => join(directory, name)) as [string, string, string, string];
    for (const path of [first, original, replacement]) mkdirSync(path);
    symlinkSync(original, alias);
    clearWorkspaceFileSearchCache();
    collectFiles.mockClear().mockImplementationOnce(async () => {
      unlinkSync(alias);
      symlinkSync(replacement, alias);
      return { ok: true, value: { files: [], truncated: false } };
    });

    await searchWorkspaceFiles({ query: "notes", roots: [first, alias], cwd: directory, extraAllowed: [] });
    expect(collectFiles.mock.calls).toEqual([[first, expect.any(Number)], [replacement, expect.any(Number)]]);
  } finally {
    await cleanupTmpDir(directory);
  }
});
