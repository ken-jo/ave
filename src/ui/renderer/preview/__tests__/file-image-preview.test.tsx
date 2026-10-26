// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PreviewBody } from "../../components/ChatSidePanelPreview.js";
import type { ChatPreviewTarget } from "../preview-targets.js";

const target: Extract<ChatPreviewTarget, { kind: "file" }> = {
  id: "directory-image", kind: "file", title: "source.png", sourceLabel: "workspace", createdOrder: 0,
  path: "images/source.png", canOpenExternal: false,
};
const image = { mimeType: "image/png", dataUrl: "data:image/png;base64,iVBORw0KGgo=" };
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe("directory image preview", () => {
  it("keeps an absolute directory target path hidden behind its relative display hint", async () => {
    const actualPath = "/work/project/images/source.png";
    const readFile = vi.fn().mockResolvedValue({ ok: true, image, bytes: 8, path: actualPath });
    vi.stubGlobal("ave", { preview: { readFile } });
    render(<PreviewBody api={{} as never} target={{ ...target, path: actualPath, workspaceRoot: "/work/project" }} />);
    await screen.findByRole("img", { name: "source.png" });
    const body = screen.getByTestId("chat-side-panel-file-preview");
    expect(body.textContent).not.toContain("/work/project");
    expect(body.textContent).toContain("images/source.png");
  });

  it("forwards the workspace resolution hint for a relative image without exposing an absolute label", async () => {
    const readFile = vi.fn().mockResolvedValue({ ok: true, image, bytes: 8, path: "/work/project/images/source.png" });
    vi.stubGlobal("ave", { preview: { readFile } });
    render(<PreviewBody api={{} as never} target={{ ...target, workspaceRoot: "/work/project" }} />);
    await screen.findByRole("img", { name: "source.png" });
    expect(readFile).toHaveBeenCalledWith(target.path, { workspaceRoot: "/work/project" });
    expect(screen.getByTestId("chat-side-panel-file-preview").textContent).not.toContain("/work/project");
  });

  it("renders image data from the governed file preview response", async () => {
    const readFile = vi.fn().mockResolvedValue({ ok: true, image, bytes: 8, path: target.path });
    vi.stubGlobal("ave", { preview: { readFile } });
    render(<PreviewBody api={{} as never} target={target} />);
    const rendered = await screen.findByRole("img", { name: "source.png" });
    expect(rendered).toHaveAttribute("src", image.dataUrl);
    expect(readFile).toHaveBeenCalledWith(target.path);
  });
  it("does not turn a selected line reference into an image preview", async () => {
    const readFile = vi.fn().mockResolvedValue({ ok: false, error: "binary-file" });
    vi.stubGlobal("ave", { preview: { readFile } });
    render(<PreviewBody api={{} as never} target={{ ...target, startLine: 1, endLine: 2, sourceTurnId: "turn" }} />);
    await screen.findByTestId("chat-side-panel-file-error");
    expect(screen.queryByRole("img")).toBeNull();
    expect(readFile).toHaveBeenCalledWith(target.path, { offset: 0, limit: 2 });
  });
});
