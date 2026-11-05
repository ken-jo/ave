// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FolderView } from "../FolderView.js";

const ROOT = "/p/checkout-service";
type Entry = { name: string; path: string; type: "file" | "directory" | "link"; outside?: boolean; size: number; mtimeMs: number; birthtimeMs: number };
const dir = (path: string): Entry => ({ name: path.split("/").pop()!, path, type: "directory", size: 0, mtimeMs: 1, birthtimeMs: 1 });
const file = (path: string, size = 10): Entry => ({ name: path.split("/").pop()!, path, type: "file", size, mtimeMs: 1_762_000_000_000, birthtimeMs: 1_757_000_000_000 });

const listings: Record<string, unknown> = {
  [ROOT]: { ok: true, entries: [dir(`${ROOT}/data`), dir(`${ROOT}/deploy`), dir(`${ROOT}/src`), file(`${ROOT}/package.json`)], truncated: false, hidden: 0 },
  [`${ROOT}/src`]: { ok: true, entries: [dir(`${ROOT}/src/payments`), file(`${ROOT}/src/index.ts`)], truncated: false, hidden: 0 },
  [`${ROOT}/src/payments`]: { ok: true, entries: [file(`${ROOT}/src/payments/retry-policy.ts`), file(`${ROOT}/src/payments/flow.png`), file(`${ROOT}/src/payments/README.md`)], truncated: false, hidden: 0 },
  [`${ROOT}/data`]: { ok: true, entries: [file(`${ROOT}/data/settlement.sqlite`, 3_984_384), file(`${ROOT}/data/big.log`, 155_189_248), file(`${ROOT}/data/mock.psd`, 2_048)], truncated: false, hidden: 0 },
  [`${ROOT}/deploy`]: { ok: true, entries: [dir(`${ROOT}/deploy/keys`), { ...dir(`${ROOT}/deploy/shared-config`), type: "link", outside: true }, dir(`${ROOT}/deploy/empty`)], truncated: false, hidden: 0 },
  [`${ROOT}/deploy/keys`]: { ok: false, error: "permission-denied" },
  [`${ROOT}/deploy/empty`]: { ok: true, entries: [], truncated: false, hidden: 0 },
};

const listDir = vi.fn(async (path: string) => listings[path] ?? { ok: false, error: "not-found" });
const openPath = vi.fn(async () => ({ ok: true }));
const readFile = vi.fn(async (path: string) => path.endsWith(".log")
  ? { ok: false, error: "too-large", bytes: 155_189_248 }
  : path.endsWith(".png") ? { ok: true, image: { dataUrl: "data:image/png;base64,AAAA", mimeType: "image/png" }, path }
  : path.endsWith(".md") ? { ok: true, content: "# Title\n\n- one\n", truncated: false, lineCount: 3, path }
  : { ok: true, content: "export const MAX = 3;\n", truncated: false, lineCount: 2, path });

let width = 1_000;

beforeEach(() => {
  width = 1_000;
  listDir.mockClear();
  openPath.mockClear();
  readFile.mockClear();
  Object.assign(window, {
    ave: {
      workspace: { listDir, openPath, reveal: vi.fn(async () => ({ ok: true })), searchFiles: vi.fn(async () => ({ ok: true, matches: [], truncated: false })) },
      preview: { readFile },
    },
  });
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const w = this.getAttribute("data-testid") === "folder-view" ? width : 0;
    return { width: w, height: 600, top: 0, left: 0, right: w, bottom: 600, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
  });
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { callback(0); return 0; });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const row = (path: string) => screen.getAllByTestId("folder-row").find((node) => node.getAttribute("data-path") === path)!;
const columns = () => screen.getAllByTestId("folder-column").map((node) => node.getAttribute("data-dir"));

async function openView() {
  render(<FolderView projectRoot={ROOT} onOpenTerminal={vi.fn()} />);
  await waitFor(() => expect(row(`${ROOT}/data`)).toBeDefined());
}

describe("FolderView", () => {
  it("lists the project root first, folders before files, with the first row focused and the key hint", async () => {
    await openView();
    expect(columns()).toEqual([ROOT]);
    expect(screen.getByRole("tree")).toBeDefined();
    expect(within(screen.getAllByTestId("folder-column")[0]!).getAllByRole("treeitem")).toHaveLength(4);
    await waitFor(() => expect(document.activeElement).toBe(row(`${ROOT}/data`)));
    expect(screen.getByTestId("folder-hint")).toBeDefined();
  });

  it("opens a column per chosen folder and closes later columns when an earlier choice changes", async () => {
    await openView();
    fireEvent.click(row(`${ROOT}/src`));
    await waitFor(() => expect(row(`${ROOT}/src/payments`)).toBeDefined());
    fireEvent.click(row(`${ROOT}/src/payments`));
    await waitFor(() => expect(columns()).toEqual([ROOT, `${ROOT}/src`, `${ROOT}/src/payments`]));
    expect(row(`${ROOT}/src`).getAttribute("data-state")).toBe("on-path");
    expect(row(`${ROOT}/src/payments`).getAttribute("data-state")).toBe("selected");
    fireEvent.click(row(`${ROOT}/data`));
    await waitFor(() => expect(columns()).toEqual([ROOT, `${ROOT}/data`]));
  });

  it("walks with the keys: ↓ moves, Enter opens and enters, ← goes back, Space previews into the viewer, Esc returns", async () => {
    await openView();
    await waitFor(() => expect(document.activeElement).toBe(row(`${ROOT}/data`)));
    fireEvent.keyDown(row(`${ROOT}/data`), { key: "ArrowDown" });
    fireEvent.keyDown(row(`${ROOT}/deploy`), { key: "ArrowDown" });
    expect(document.activeElement).toBe(row(`${ROOT}/src`));
    fireEvent.keyDown(row(`${ROOT}/src`), { key: "Enter" });
    await waitFor(() => expect(document.activeElement).toBe(row(`${ROOT}/src/payments`)));
    fireEvent.keyDown(row(`${ROOT}/src/payments`), { key: "ArrowLeft" });
    expect(document.activeElement).toBe(row(`${ROOT}/src`));
    fireEvent.keyDown(row(`${ROOT}/src`), { key: "ArrowRight" });
    await waitFor(() => expect(document.activeElement).toBe(row(`${ROOT}/src/payments`)));
    fireEvent.keyDown(row(`${ROOT}/src/payments`), { key: "ArrowDown" });
    expect(document.activeElement).toBe(row(`${ROOT}/src/index.ts`));
    fireEvent.keyDown(row(`${ROOT}/src/index.ts`), { key: " " });
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId("folder-viewer")));
    await waitFor(() => expect(screen.getAllByTestId("preview-code-line").length).toBeGreaterThan(0));
    fireEvent.keyDown(screen.getByTestId("folder-viewer"), { key: "Escape" });
    expect(document.activeElement).toBe(row(`${ROOT}/src/index.ts`));
  });

  it("asks for a side chat about the viewed file, or the deepest open folder when no file is open", async () => {
    const onOpenSideChat = vi.fn();
    render(<FolderView projectRoot={ROOT} onOpenSideChat={onOpenSideChat} />);
    await waitFor(() => expect(row(`${ROOT}/data`)).toBeDefined());
    fireEvent.click(screen.getByTestId("folder-side-chat"));
    expect(onOpenSideChat).toHaveBeenLastCalledWith(ROOT);
    fireEvent.click(row(`${ROOT}/src`));
    await waitFor(() => expect(row(`${ROOT}/src/index.ts`)).toBeDefined());
    fireEvent.click(screen.getByTestId("folder-side-chat"));
    expect(onOpenSideChat).toHaveBeenLastCalledWith(`${ROOT}/src`);
    fireEvent.click(row(`${ROOT}/src/index.ts`));
    await screen.findByTestId("folder-viewer");
    fireEvent.click(screen.getByTestId("folder-side-chat"));
    expect(onOpenSideChat).toHaveBeenLastCalledWith(`${ROOT}/src/index.ts`);
  });

  it("gives a format without a viewer the info card, opening it externally with the project root", async () => {
    await openView();
    fireEvent.click(row(`${ROOT}/data`));
    await waitFor(() => expect(row(`${ROOT}/data/settlement.sqlite`)).toBeDefined());
    fireEvent.click(row(`${ROOT}/data/settlement.sqlite`));
    const card = await screen.findByTestId("folder-file-info");
    expect(readFile).not.toHaveBeenCalled();
    expect(within(card).getByTestId("folder-file-info-reason").getAttribute("data-reason")).toBe("unsupported");
    expect(card.textContent).toContain("3,984,384");
    expect(card.textContent).toContain("checkout-service/data/settlement.sqlite");
    const button = within(card).getByTestId("folder-open-external");
    expect(document.activeElement).toBe(button);
    fireEvent.click(button);
    await waitFor(() => expect(openPath).toHaveBeenCalledWith(ROOT, `${ROOT}/data/settlement.sqlite`));
  });

  it("offers no default-app open for a type it is not given, and focuses the file manager instead", async () => {
    await openView();
    fireEvent.click(row(`${ROOT}/data`));
    await waitFor(() => expect(row(`${ROOT}/data/mock.psd`)).toBeDefined());
    fireEvent.click(row(`${ROOT}/data/mock.psd`));
    const card = await screen.findByTestId("folder-file-info");
    expect(within(card).queryByTestId("folder-open-external")).toBeNull();
    expect(within(card).getByTestId("folder-open-external-unavailable")).toBeDefined();
    await waitFor(() => expect(document.activeElement).toBe(within(card).getByTestId("folder-reveal")));
  });

  it("reopens on a restored location and reports where it is", async () => {
    const onLocationChange = vi.fn();
    render(<FolderView projectRoot={ROOT} initialLocation={{ path: `${ROOT}/src`, selection: `${ROOT}/src/index.ts` }}
      onLocationChange={onLocationChange} />);
    await screen.findByTestId("folder-viewer");
    expect(columns()).toEqual([ROOT, `${ROOT}/src`]);
    await waitFor(() => expect(onLocationChange).toHaveBeenLastCalledWith({ path: `${ROOT}/src`, selection: `${ROOT}/src/index.ts` }));
    // Nothing is reported for the root while the restore is still walking there.
    expect(onLocationChange).not.toHaveBeenCalledWith({ path: ROOT, selection: null });
    fireEvent.click(row(`${ROOT}/data`));
    await waitFor(() => expect(onLocationChange).toHaveBeenLastCalledWith({ path: `${ROOT}/data`, selection: `${ROOT}/data` }));
  });

  it("ignores a restored location outside its project", async () => {
    const onLocationChange = vi.fn();
    render(<FolderView projectRoot={ROOT} initialLocation={{ path: "/elsewhere", selection: "/elsewhere/a.txt" }} onLocationChange={onLocationChange} />);
    await waitFor(() => expect(row(`${ROOT}/data`)).toBeDefined());
    expect(columns()).toEqual([ROOT]);
    await waitFor(() => expect(onLocationChange).toHaveBeenLastCalledWith({ path: ROOT, selection: null }));
  });

  it("explains a too-large file on the same card, with the reason from the preview reader", async () => {
    await openView();
    fireEvent.click(row(`${ROOT}/data`));
    await waitFor(() => expect(row(`${ROOT}/data/big.log`)).toBeDefined());
    expect(row(`${ROOT}/data/big.log`).textContent).toContain("148.0 MB");
    fireEvent.click(row(`${ROOT}/data/big.log`));
    const reason = await screen.findByTestId("folder-file-info-reason");
    expect(reason.getAttribute("data-reason")).toBe("too-large");
  });

  it("shows a refused folder as locked with retry, a link greyed as outside, and an empty folder's copy", async () => {
    await openView();
    fireEvent.click(row(`${ROOT}/deploy`));
    await waitFor(() => expect(row(`${ROOT}/deploy/keys`)).toBeDefined());
    expect(row(`${ROOT}/deploy/shared-config`).getAttribute("aria-disabled")).toBe("true");
    expect(within(row(`${ROOT}/deploy/shared-config`)).getByTestId("folder-row-outside")).toBeDefined();
    fireEvent.click(row(`${ROOT}/deploy/shared-config`));
    expect(columns()).toEqual([ROOT, `${ROOT}/deploy`]);
    expect(await screen.findByTestId("folder-link-note")).toBeDefined();

    fireEvent.click(row(`${ROOT}/deploy/keys`));
    const error = await screen.findByTestId("folder-column-error");
    const calls = listDir.mock.calls.filter(([path]) => path === `${ROOT}/deploy/keys`).length;
    fireEvent.click(within(error).getByTestId("folder-column-retry"));
    await waitFor(() => expect(listDir.mock.calls.filter(([path]) => path === `${ROOT}/deploy/keys`).length).toBe(calls + 1));

    fireEvent.click(row(`${ROOT}/deploy/empty`));
    const empty = await screen.findByTestId("folder-column-empty");
    expect(empty.textContent).toContain("숨김 파일도 없습니다");
    expect(within(empty).getByTestId("folder-column-terminal")).toBeDefined();
  });

  it("lets the viewer replace the columns below 380 plus two columns, with ← or Esc back to the columns", async () => {
    width = 760;
    await openView();
    fireEvent.click(row(`${ROOT}/package.json`));
    await waitFor(() => expect(screen.getByTestId("folder-viewer")).toBeDefined());
    expect(screen.queryByTestId("folder-columns")).toBeNull();
    expect(screen.getByTestId("folder-viewer-back").textContent).toContain("checkout-service");
    expect(screen.getByTestId("folder-status-right").textContent).toContain("Esc");
    act(() => { screen.getByTestId("folder-viewer").focus(); });
    fireEvent.keyDown(screen.getByTestId("folder-viewer"), { key: "Escape" });
    await waitFor(() => expect(screen.getByTestId("folder-columns")).toBeDefined());
    expect(document.activeElement).toBe(row(`${ROOT}/package.json`));
  });

  it("keeps viewer and columns side by side at 820 and wider", async () => {
    width = 820;
    await openView();
    fireEvent.click(row(`${ROOT}/package.json`));
    await waitFor(() => expect(screen.getByTestId("folder-viewer")).toBeDefined());
    expect(screen.getByTestId("folder-columns")).toBeDefined();
    expect(screen.queryByTestId("folder-viewer-back")).toBeNull();
  });

  it("renders Markdown with a view and source switch, and images with fit, zoom and double-click for 100%", async () => {
    await openView();
    fireEvent.click(row(`${ROOT}/src`));
    await waitFor(() => expect(row(`${ROOT}/src/payments`)).toBeDefined());
    fireEvent.click(row(`${ROOT}/src/payments`));
    await waitFor(() => expect(row(`${ROOT}/src/payments/README.md`)).toBeDefined());
    fireEvent.click(row(`${ROOT}/src/payments/README.md`));
    const rendered = await screen.findByTestId("folder-markdown-rendered");
    expect(rendered.querySelector("h1")?.textContent).toBe("Title");
    fireEvent.click(screen.getByTestId("folder-markdown-source"));
    expect(screen.queryByTestId("folder-markdown-rendered")).toBeNull();
    expect(screen.getAllByTestId("preview-code-line")[0]!.textContent).toContain("# Title");

    fireEvent.click(row(`${ROOT}/src/payments/flow.png`));
    const image = await screen.findByTestId("folder-image-viewer");
    expect(within(image).getByTestId("folder-image-zoom").textContent).toBe("맞춤");
    fireEvent.doubleClick(image.querySelector("img")!);
    expect(within(image).getByTestId("folder-image-zoom").textContent).toBe("100%");
    fireEvent.doubleClick(image.querySelector("img")!);
    expect(within(image).getByTestId("folder-image-zoom").textContent).toBe("맞춤");
  });
});
