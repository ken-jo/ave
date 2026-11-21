import "../../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { makeMockAveApi, makeMockAveNamespace } from "../../../../../../test/renderer/mock-ave-api.js";
import { handleFolderViewAtRequests, type FolderViewAtRequest } from "../../../utils/app-shell-requests.js";
import { FileEditDiff } from "../../FileEditDiff.js";
import { canShowInFolderView, projectRootOf, showInFolderView } from "../show-in-folder-view.js";

/** A diff card names a file by absolute path only; the folder view needs the project that holds it. */
function install(roots: Array<{ path: string; isDefault: boolean }>): FolderViewAtRequest[] {
  vi.stubGlobal("ave", makeMockAveNamespace({ workspaceRoots: roots }).ns);
  vi.stubGlobal("aveApi", makeMockAveApi().api);
  const requests: FolderViewAtRequest[] = [];
  unregister = handleFolderViewAtRequests((request) => { requests.push(request); });
  return requests;
}

let unregister: (() => void) | null = null;

afterEach(() => {
  unregister?.();
  unregister = null;
  vi.unstubAllGlobals();
});

describe("projectRootOf", () => {
  it("picks the deepest project that holds the path", () => {
    expect(projectRootOf("/ws/app/src/a.ts", ["/ws", "/ws/app", "/other"])).toBe("/ws/app");
  });

  it("does not match a sibling whose name only starts the same", () => {
    expect(projectRootOf("/ws-two/a.ts", ["/ws"])).toBeNull();
  });

  it("matches a drive path with either separator", () => {
    expect(projectRootOf("C:\\proj\\src\\a.ts", ["C:\\proj\\"])).toBe("C:\\proj\\");
  });

  it("does not treat the project folder itself as a file inside it", () => {
    expect(projectRootOf("/ws", ["/ws"])).toBeNull();
  });
});

describe("canShowInFolderView", () => {
  it("accepts absolute paths only", () => {
    expect(canShowInFolderView("/ws/a.ts")).toBe(true);
    expect(canShowInFolderView("C:/ws/a.ts")).toBe(true);
    expect(canShowInFolderView("src/a.ts")).toBe(false);
  });
});

describe("showInFolderView", () => {
  it("asks the shell for a folder view of the holding project with the file selected", async () => {
    const requests = install([{ path: "/ws", isDefault: true }, { path: "/ws/pkg", isDefault: false }]);
    await expect(showInFolderView("/ws/pkg/src/a.ts")).resolves.toBe(true);
    expect(requests).toEqual([{ path: "/ws/pkg/src/a.ts", projectRoot: "/ws/pkg" }]);
  });

  it("reports a file outside every project instead of opening some other folder", async () => {
    const requests = install([{ path: "/ws", isDefault: true }]);
    await expect(showInFolderView("/elsewhere/a.ts")).resolves.toBe(false);
    expect(requests).toEqual([]);
  });
});

describe("diff card header", () => {
  const data = { path: "/ws/src/deep/nested/file-name.ts", tool: "edit_file" as const, hunks: [{ oldText: "a", newText: "b" }] };

  it("opens the folder view from its own button and leaves the card open", async () => {
    const requests = install([{ path: "/ws", isDefault: true }]);
    render(<FileEditDiff data={data} />);
    fireEvent.click(screen.getByTestId("file-diff-show-in-folder-view"));
    await waitFor(() => expect(requests).toEqual([{ path: data.path, projectRoot: "/ws" }]));
    expect(screen.getByRole("button", { expanded: true })).toBeTruthy();
    expect(screen.queryByTestId("file-diff-show-failed")).toBeNull();
  });

  it("says so when no project holds the file", async () => {
    install([{ path: "/other", isDefault: true }]);
    render(<FileEditDiff data={data} />);
    fireEvent.click(screen.getByTestId("file-diff-show-in-folder-view"));
    expect(await screen.findByTestId("file-diff-show-failed")).toBeTruthy();
  });

  it("offers no folder view for a path that is not absolute", () => {
    install([{ path: "/ws", isDefault: true }]);
    render(<FileEditDiff data={{ ...data, path: "src/file-name.ts" }} />);
    expect(screen.queryByTestId("file-diff-show-in-folder-view")).toBeNull();
  });
});
