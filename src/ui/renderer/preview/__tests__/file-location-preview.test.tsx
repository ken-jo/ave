// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreviewBody } from "../../components/ChatSidePanelPreview.js";
import { collectChatPreviewModel, type ChatPreviewTarget } from "../preview-targets.js";
import { formatFileMentionReference } from "../../../../shared/file-mention-reference.js";
import { userEntry } from "../../../../__tests__/test-helpers.js";

const reference = { path: "src/example.md", startLine: 700, endLine: 701, turnId: "source-turn" };
const target: ChatPreviewTarget = {
  id: "file-location", kind: "file", title: "src/example.md:700-701", sourceLabel: "reference", createdOrder: 0,
  path: reference.path, canOpenExternal: false, startLine: 700, endLine: 701, sourceTurnId: reference.turnId,
};

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("file location preview", () => {
  it("reconstructs a preview target from a saved user marker without attachments", () => {
    const model = collectChatPreviewModel({ entries: [userEntry(formatFileMentionReference(1, reference))], attachments: [] });
    expect(model.targets).toEqual([expect.objectContaining({ kind: "file", path: reference.path, startLine: 700, endLine: 701, sourceTurnId: reference.turnId })]);
  });

  it("reads the selected line window and renders source line numbers instead of formatting the fragment", async () => {
    const readFile = vi.fn().mockResolvedValue({ ok: true, content: "# selected heading\nplain second line", path: "/workspace/src/example.md", truncated: false });
    vi.stubGlobal("ave", { preview: { readFile } });
    render(<PreviewBody api={{} as never} target={target} />);
    await waitFor(() => expect(readFile).toHaveBeenCalledWith("src/example.md", { offset: 699, limit: 2 }));
    const first = await screen.findByTestId("file-preview-line-700");
    expect(first.textContent).toContain("# selected heading");
    expect(first.getAttribute("data-selected")).toBe("true");
    expect(screen.getByTestId("file-preview-line-701").textContent).toContain("plain second line");
    expect(screen.queryByRole("heading", { name: "selected heading" })).toBeNull();
    expect(screen.getByTestId("chat-side-panel-file-preview").textContent).not.toContain("/workspace/");
  });

  it("rereads a different range in the same file", async () => {
    const readFile = vi.fn().mockResolvedValue({ ok: true, content: "line", truncated: false });
    vi.stubGlobal("ave", { preview: { readFile } });
    const view = render(<PreviewBody api={{} as never} target={target} />);
    await screen.findByTestId("file-preview-line-700");
    view.rerender(<PreviewBody api={{} as never} target={{ ...target, startLine: 20, endLine: 20 }} />);
    await waitFor(() => expect(readFile).toHaveBeenLastCalledWith("src/example.md", { offset: 19, limit: 1 }));
    await screen.findByTestId("file-preview-line-20");
  });

  it("keeps selected ranges behind the normal read policy even when a target carries inline text", async () => {
    const readFile = vi.fn().mockResolvedValue({ ok: false, error: "path-not-allowed" });
    vi.stubGlobal("ave", { preview: { readFile } });
    render(<PreviewBody api={{} as never} target={{ ...target, inlineText: "unread source" }} />);
    await screen.findByTestId("chat-side-panel-file-error");
    expect(readFile).toHaveBeenCalledWith(target.path, { offset: 699, limit: 2 });
    expect(screen.queryByText("unread source")).toBeNull();
    expect(screen.queryByTestId("file-preview-selected-range")).toBeNull();
  });

  it("does not invent a selected source line when a location is beyond the current file", async () => {
    const readFile = vi.fn().mockResolvedValue({ ok: true, content: "", lineCount: 0, truncated: false });
    vi.stubGlobal("ave", { preview: { readFile } });
    render(<PreviewBody api={{} as never} target={target} />);
    await screen.findByTestId("file-preview-selected-range");
    expect(screen.queryByTestId("file-preview-line-700")).toBeNull();
  });

  it("forwards the workspace resolution hint while keeping its label relative", async () => {
    const readFile = vi.fn().mockResolvedValue({ ok: true, content: "line", lineCount: 1 });
    vi.stubGlobal("ave", { preview: { readFile } });
    render(<PreviewBody api={{} as never} target={{ ...target, workspaceRoot: "/workspace/project" }} />);
    await screen.findByTestId("file-preview-line-700");
    expect(readFile).toHaveBeenCalledWith(target.path, { offset: 699, limit: 2, workspaceRoot: "/workspace/project" });
    expect(screen.getByTestId("chat-side-panel-file-preview").textContent).not.toContain("/workspace/project");
  });
});
