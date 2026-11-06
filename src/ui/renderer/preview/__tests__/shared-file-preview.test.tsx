// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileViewer } from "../../components/folder-view/FileViewer.js";
import { FileInfoCard } from "../FileInfoCard.js";
import { TextDocumentPreview } from "../TextDocumentPreview.js";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("shared passive file preview", () => {
  it.each(["folder", "side"] as const)("switches Markdown modes and resets for a new file in the %s surface", async (surface) => {
    const readFile = vi.fn(async () => ({ ok: true, content: "# Shared heading\n", lineCount: 2 }));
    vi.stubGlobal("ave", { preview: { readFile } });
    const preview = (path: string) => surface === "folder"
      ? <FileViewer projectRoot="/workspace" entry={{ name: path.split("/").pop()!, path, type: "file", size: 17, mtimeMs: 1, birthtimeMs: 1 }} />
      : <TextDocumentPreview observe={false} target={{ kind: "file", id: path, path, title: path, canOpenExternal: false, sourceLabel: "file", createdOrder: 0 }} />;
    const view = render(preview("/workspace/first.md"));
    await screen.findByRole("heading", { name: "Shared heading" });
    fireEvent.click(screen.getByTestId("markdown-mode-source"));
    expect(screen.queryByRole("heading", { name: "Shared heading" })).toBeNull();
    expect(screen.getAllByTestId("preview-code-line")[0]!.textContent).toContain("# Shared heading");
    expect(screen.getByTestId("markdown-mode-source").getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByTestId("markdown-mode-view"));
    expect(screen.getByRole("heading", { name: "Shared heading" })).toBeDefined();
    fireEvent.click(screen.getByTestId("markdown-mode-source"));
    view.rerender(preview("/workspace/second.md"));
    await screen.findByRole("heading", { name: "Shared heading" });
    expect(screen.getByTestId("markdown-mode-view").getAttribute("aria-pressed")).toBe("true");
    expect(readFile).toHaveBeenCalledTimes(2);
  });

  it("omits absent file facts and retains an explicitly supplied zero size", () => {
    const view = render(<FileInfoCard name="archive.bin" reason="binary-file" location="/workspace/archive.bin" />);
    const card = screen.getByTestId("file-info");
    expect(card.querySelectorAll("dt")).toHaveLength(1);
    expect(card.querySelector("dd")?.textContent).toBe("/workspace/archive.bin");
    expect(within(card).queryByRole("button")).toBeNull();
    view.rerender(<FileInfoCard name="empty.bin" size={0} />);
    expect(card.querySelectorAll("dt")).toHaveLength(1);
    expect(card.querySelector("dd")?.textContent).toContain("0");
    expect(screen.queryByTestId("file-info-reason")).toBeNull();
  });

  it("uses the same passive body for inline Markdown without reading the disk", () => {
    const readFile = vi.fn();
    vi.stubGlobal("ave", { preview: { readFile } });
    render(<TextDocumentPreview observe={false} target={{ kind: "file", id: "snippet", path: "notes.md", title: "notes.md",
      canOpenExternal: false, sourceLabel: "file", createdOrder: 0, inlineText: "# Inline heading" }} />);
    fireEvent.click(screen.getByTestId("markdown-mode-source"));
    expect(screen.queryByRole("heading", { name: "Inline heading" })).toBeNull();
    expect(screen.getAllByTestId("preview-code-line")[0]!.textContent).toContain("# Inline heading");
    expect(readFile).not.toHaveBeenCalled();
  });
});
