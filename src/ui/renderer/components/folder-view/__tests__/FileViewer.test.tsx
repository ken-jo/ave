// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileViewer } from "../FileViewer.js";
import { VIEWER_HEADER_COMPACT_WIDTH } from "../ViewerHeader.js";
import type { FolderEntry } from "../folder-columns.js";

const ROOT = "/p/checkout-service";
const entry = (name: string, extra: Partial<FolderEntry> = {}): FolderEntry =>
  ({ name, path: `${ROOT}/${name}`, type: "file", size: 10, mtimeMs: 1_762_000_000_000, birthtimeMs: 1_757_000_000_000, ...extra });

const reveal = vi.fn(async (_path: string) => ({ ok: true }) as { ok: boolean; error?: string });
const openPath = vi.fn(async () => ({ ok: true }));
const readFile = vi.fn(async (path: string): Promise<Record<string, unknown>> => path.endsWith("big.ts") || path.endsWith("big.log")
  ? { ok: false, error: "too-large" }
  : path.endsWith(".md") ? { ok: true, content: "# Title\n", truncated: false, lineCount: 2, path }
  : { ok: true, content: "export const MAX = 3;\n", truncated: false, lineCount: 2, path });
const writeText = vi.fn(async (_text: string) => undefined);
let headerWidth = 900;

beforeEach(() => {
  headerWidth = 900;
  reveal.mockClear();
  openPath.mockClear();
  writeText.mockClear();
  Object.assign(window, { ave: { workspace: { reveal, openPath }, preview: { readFile } } });
  Object.assign(navigator, { clipboard: { writeText } });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const width = this.getAttribute("data-testid") === "folder-viewer-header" ? headerWidth : 0;
    return { width, height: 40, top: 0, left: 0, right: width, bottom: 40, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const action = (id: string) => screen.queryByTestId(`folder-viewer-action-${id}`);

describe("FileViewer header", () => {
  it("gives a code file the file manager and copy path, next to copy contents and add to chat", async () => {
    render(<FileViewer projectRoot={ROOT} entry={entry("index.ts")} onAttachText={() => true} />);
    await waitFor(() => expect(action("copy-content")).not.toBeNull());
    expect(within(screen.getByTestId("folder-viewer-actions")).getAllByRole("button").map((button) => button.getAttribute("data-testid")))
      .toEqual(["folder-viewer-action-copy-content", "folder-viewer-action-add-context", "folder-viewer-action-reveal", "folder-viewer-action-copy-path"]);
    // A `.ts` file is not handed to the default app, so no such action is offered.
    expect(action("open-external")).toBeNull();
    fireEvent.click(action("reveal") as HTMLElement);
    expect(reveal).toHaveBeenCalledWith(`${ROOT}/index.ts`);
    fireEvent.click(action("copy-path") as HTMLElement);
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${ROOT}/index.ts`));
  });

  it("says so when the file manager could not show the file", async () => {
    reveal.mockResolvedValueOnce({ ok: false, error: "not-found" });
    render(<FileViewer projectRoot={ROOT} entry={entry("index.ts")} />);
    await waitFor(() => expect(action("reveal")).not.toBeNull());
    fireEvent.click(action("reveal") as HTMLElement);
    expect((await screen.findByTestId("folder-viewer-alert")).textContent).toBe("파일 관리자에서 이 파일을 보여 주지 못했습니다.");
  });

  it("keeps the two exits on every header: loading, a file with no viewer, and a link (no file manager for one that leaves the project)", async () => {
    const { rerender } = render(<FileViewer projectRoot={ROOT} entry={entry("mock.psd")} />);
    expect(action("reveal")).not.toBeNull();
    expect(action("copy-path")).not.toBeNull();
    rerender(<FileViewer projectRoot={ROOT} entry={entry("inside", { type: "link", outside: false })} />);
    expect(action("reveal")).not.toBeNull();
    expect(action("copy-path")).not.toBeNull();
    rerender(<FileViewer projectRoot={ROOT} entry={entry("shared-config", { type: "link", outside: true })} />);
    expect(action("reveal")).toBeNull();
    expect(action("copy-path")).not.toBeNull();
  });

  it("moves every action into one menu when the header is narrower than the action row needs", async () => {
    headerWidth = VIEWER_HEADER_COMPACT_WIDTH - 1;
    render(<FileViewer projectRoot={ROOT} entry={entry("README.md")} onAttachText={() => true} />);
    const more = await screen.findByTestId("folder-viewer-more");
    await waitFor(() => expect(screen.getByTestId("folder-markdown-rendered")).toBeDefined());
    expect(screen.queryByTestId("folder-viewer-actions")).toBeNull();
    expect(screen.queryByTestId("folder-markdown-source")).toBeNull();
    fireEvent.pointerDown(more, { button: 0, ctrlKey: false });
    const menu = await screen.findByTestId("folder-viewer-more-menu");
    expect(within(menu).getAllByRole("menuitem").map((item) => item.getAttribute("data-testid"))).toEqual([
      "folder-viewer-action-markdown-mode", "folder-viewer-action-copy-content", "folder-viewer-action-add-context",
      "folder-viewer-action-reveal", "folder-viewer-action-copy-path", "folder-viewer-action-open-external",
    ]);
    fireEvent.click(within(menu).getByTestId("folder-viewer-action-markdown-mode"));
    await waitFor(() => expect(screen.queryByTestId("folder-markdown-rendered")).toBeNull());
  });
});

describe("FileViewer large-file notice", () => {
  it("points to the default app only for a type that is handed to it", async () => {
    const { rerender } = render(<FileViewer projectRoot={ROOT} entry={entry("big.ts", { size: 2_100_000 })} />);
    const reason = await screen.findByTestId("file-info-reason");
    expect(reason.getAttribute("data-reason")).toBe("too-large");
    expect(reason.textContent).toBe("2 MB 가 넘는 파일은 미리 보지 않습니다. 이 파일은 2.0 MB 입니다. 파일 관리자에서 보거나 터미널에서 여세요.");
    expect(screen.queryByTestId("folder-open-external")).toBeNull();
    rerender(<FileViewer projectRoot={ROOT} entry={entry("big.log", { size: 2_100_000 })} />);
    await waitFor(() => expect(screen.getByTestId("file-info-reason").textContent)
      .toBe("2 MB 가 넘는 파일은 미리 보지 않습니다. 이 파일은 2.0 MB 입니다. 기본 앱이나 터미널에서 여세요."));
    expect(screen.getByTestId("folder-open-external")).toBeDefined();
  });
});
