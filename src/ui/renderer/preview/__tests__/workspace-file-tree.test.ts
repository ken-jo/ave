import { describe, expect, it } from "vitest";
import { buildWorkspaceTree, normalizeWorkspaceTreePath } from "../workspace-file-tree.js";
import type { WorkspaceFileItem } from "../preview-targets.js";

const files: WorkspaceFileItem[] = [
  { id: "modified", path: "src/nested/source.ts", label: "source.ts", detail: "src/nested/source.ts", sourceLabel: "edit_file", operation: "modify", canOpenExternal: false },
  { id: "deleted", path: "/ws/deleted.ts", label: "deleted.ts", detail: "deleted.ts", sourceLabel: "delete_file", operation: "delete", canOpenExternal: false },
  { id: "artifact", path: "/elsewhere/image.png", label: "image.png", detail: "image.png", sourceLabel: "attachment", operation: "attachment", canOpenExternal: false },
];
const input = { root: "/ws", roots: ["/ws", "/other"], childrenByPath: { "/ws": [
  { name: "empty", path: "/ws/empty", type: "directory" as const },
  { name: "plain.txt", path: "/ws/plain.txt", type: "file" as const },
] }, files, changes: [], query: "" };

describe("unified workspace tree", () => {
  it("merges virtual ancestors and deleted files, keeps empty directories and rolls up unique changes", () => {
    const { nodes, outsideNodes } = buildWorkspaceTree({ ...input, filter: "all" });
    expect(nodes.map((node) => node.name)).toEqual(["empty", "src", "deleted.ts", "plain.txt"]);
    const src = nodes.find((node) => node.name === "src")!;
    expect(src.changedDescendants).toBe(1);
    expect(src.children[0].changedDescendants).toBe(1);
    expect(src.children[0].children[0]).toMatchObject({ session: false, change: { operation: "modify" } });
    expect(outsideNodes.map((node) => node.name)).toEqual(["image.png"]);
  });
  it("filters one tree and retains ancestors of matched session and change paths", () => {
    const changed = buildWorkspaceTree({ ...input, filter: "changed" });
    expect(changed.nodes.map((node) => node.name)).toEqual(["src", "deleted.ts"]);
    expect(changed.outsideNodes).toEqual([]);
    const searched = buildWorkspaceTree({ ...input, filter: "changed", query: "source" });
    expect(searched.nodes.map((node) => node.name)).toEqual(["src"]);
    expect(searched.nodes[0].children[0].children[0].name).toBe("source.ts");
  });
  it("uses full path boundaries and merges relative and absolute mentions of the same file", () => {
    const duplicate = { ...files[0], id: "absolute", path: "/ws/src/nested/source.ts" };
    const result = buildWorkspaceTree({ ...input, files: [...files, duplicate, { ...files[2], path: "/ws-other/file.png" }], filter: "all" });
    expect(result.nodes.find((node) => node.name === "src")?.changedDescendants).toBe(1);
    expect(result.outsideNodes.map((node) => node.name)).toEqual(["file.png", "image.png"]);
    expect(normalizeWorkspaceTreePath("src\\source.ts", "C:\\work")).toBe("C:/work/src/source.ts");
  });
  it("marks only explicit nonchange artifacts as session members while allowing an attachment/change overlap", () => {
    const changedOnly = buildWorkspaceTree({ ...input, filter: "all" }).nodes.find((node) => node.name === "src")!.children[0]!.children[0]!;
    expect(changedOnly.session).toBe(false);
    const session = buildWorkspaceTree({ ...input, filter: "session" });
    expect(session.nodes).toEqual([]);
    expect(session.outsideNodes.map((node) => node.name)).toEqual(["image.png"]);
    const overlap = { ...files[0]!, id: "attachment", operation: "attachment" as const };
    const nodes = buildWorkspaceTree({ ...input, files: [...files, overlap], filter: "session" }).nodes;
    expect(nodes[0]!.children[0]!.children[0]).toMatchObject({ session: true, change: { operation: "modify" } });
  });
  it("anchors relative session metadata to its conversation project instead of the first granted root", () => {
    const projectFile = { ...files[0]!, path: "src/source.ts" };
    const result = buildWorkspaceTree({ ...input, root: "/projects/active", roots: ["/ws", "/projects/active"],
      workspaceRoot: "/projects/active", childrenByPath: {}, files: [projectFile], filter: "changed" });
    expect(result.nodes[0]?.path).toBe("/projects/active/src");
    expect(result.nodes[0]?.children[0]?.path).toBe("/projects/active/src/source.ts");
    expect(result.outsideNodes).toEqual([]);
  });

});
