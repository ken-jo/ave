// Cold-cache keystrokes share one root walk.
import { describe, expect, it, vi } from "vitest";

const { collectFiles } = vi.hoisted(() => ({
  collectFiles: vi.fn(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { ok: true, value: { files: [], truncated: false } };
  }),
}));

vi.mock("../../../tools/file-tools.js", () => ({ collectFiles }));

import { clearWorkspaceFileSearchCache, searchWorkspaceFiles } from "../workspace-file-search.js";

describe("searchWorkspaceFiles in-flight listing", () => {
  it("walks a root once for concurrent searches", async () => {
    clearWorkspaceFileSearchCache();
    const args = (query: string) => ({ query, roots: ["/ws"], cwd: "/ws", extraAllowed: [] });
    await Promise.all([
      searchWorkspaceFiles(args("a")),
      searchWorkspaceFiles(args("ap")),
      searchWorkspaceFiles(args("app")),
    ]);
    expect(collectFiles).toHaveBeenCalledTimes(1);
  });
});
