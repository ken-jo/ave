import { describe, expect, it } from "vitest";
import { deriveWorkspaceChanges } from "../workspace-changes.js";
import type { TurnChangeReview } from "../../../../shared/turn-change-review.js";
import type { WorkspaceFileItem } from "../preview-targets.js";

const files: WorkspaceFileItem[] = [
  { id: "old", path: "/work/project/src/old.ts", label: "old.ts", detail: "", sourceLabel: "edit_file", operation: "modify", previewTargetId: "old-diff", canOpenExternal: false },
  { id: "current", path: "/work/project/src/current.ts", label: "current.ts", detail: "", sourceLabel: "edit_file", operation: "modify", previewTargetId: "current-diff", canOpenExternal: false },
  { id: "artifact", path: "/work/notes/result.md", label: "result.md", detail: "", sourceLabel: "attachment", operation: "attachment", canOpenExternal: true },
];
const review: TurnChangeReview = { sessionId: "session", turnId: "turn", files: [{ path: "src/current.ts", bytes: 4, lineCount: 1,
  added: 2, removed: 1, operation: "modify", countsKnown: true, referenceable: false, hunks: [],
}] };

describe("workspace change derivation", () => {
  it("shares recorded latest totals with the tree while keeping earlier changes and session artifacts", () => {
    const result = deriveWorkspaceChanges({ files, targets: [
      { id: "old-diff", kind: "diff", title: "old.ts", sourceLabel: "builtin", createdOrder: 1, path: files[0]!.path,
        diff: { path: files[0]!.path, tool: "edit_file", hunks: [{ oldText: "a\n", newText: "b\nc\n" }] } },
    ], workspaceRoot: "/work/project", review });
    expect(result.latestFiles.map((file) => file.path)).toEqual(["/work/project/src/current.ts"]);
    expect(result.changedFiles).toHaveLength(2);
    expect(result.changedFiles.find((file) => file.latest)).toMatchObject({ added: 2, removed: 1, countsKnown: true });
    expect(result.changedFiles.find((file) => !file.latest)).toMatchObject({ added: 2, removed: 1, displayPath: "src/old.ts" });
    expect(result.sessionFiles).toEqual([files[2]]);
    expect(result).toMatchObject({ added: 2, removed: 1, countsKnown: true });
  });
  it("retains captured turn order and masks unrecoverable historical counts", () => {
    const result = deriveWorkspaceChanges({ files: [], targets: [], workspaceRoot: "/work/project", review: {
      ...review, files: [{ ...review.files[0]!, path: "b.ts" }, { ...review.files[0]!, path: "a.ts", countsKnown: false, added: 0, removed: 0 }],
    } });
    expect(result.latestFiles.map((file) => file.displayPath)).toEqual(["b.ts", "a.ts"]);
    expect(result.countsKnown).toBe(false);
  });
  it("does not promote earlier session changes into an empty latest turn", () => {
    const result = deriveWorkspaceChanges({ files, targets: [], workspaceRoot: "/work/project", review: { ...review, files: [] } });
    expect(result.latestFiles).toEqual([]);
    expect(result.changedFiles).toHaveLength(2);
  });
});

it("anchors resumed-session paths to the host review root rather than a different selected project", () => {
  const result = deriveWorkspaceChanges({ files: [], targets: [], workspaceRoot: "/other/project", review: { ...review, workspaceRoot: "/work/project" } });
  expect(result.workspaceRoot).toBe("/work/project");
  expect(result.latestFiles[0]?.path).toBe("/work/project/src/current.ts");
});
