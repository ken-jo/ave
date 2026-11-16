// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FolderView } from "../FolderView.js";
import { notifyWorkspaceFilesChanged } from "../../../utils/workspace-files-signal.js";

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
const readFromDisk = async (path: string): Promise<Record<string, unknown>> => path.endsWith(".log")
  ? { ok: false, error: "too-large", bytes: 155_189_248 }
  : path.endsWith(".png") ? { ok: true, image: { dataUrl: "data:image/png;base64,AAAA", mimeType: "image/png" }, path }
  : path.endsWith(".md") ? { ok: true, content: "# Title\n\n- one\n", truncated: false, lineCount: 3, path }
  : { ok: true, content: "export const MAX = 3;\n", truncated: false, lineCount: 2, path };
const readFile = vi.fn(readFromDisk);

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

// A root chosen in the folder dialog is stored NFC; listDir builds entry paths from the realpath, which is NFD for a Korean
// folder made in Finder.
const NFC_ROOT = "/p/프로젝트".normalize("NFC");
const NFD_ROOT = "/p/프로젝트".normalize("NFD");
listings[NFC_ROOT] = { ok: true, entries: [dir(`${NFD_ROOT}/문서`.normalize("NFD")), file(`${NFD_ROOT}/a.txt`)], truncated: false, hidden: 0 };
listings[`${NFD_ROOT}/문서`.normalize("NFD")] = { ok: true, entries: [file(`${NFD_ROOT}/문서/메모.md`.normalize("NFD"))], truncated: false, hidden: 0 };

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
    const card = await screen.findByTestId("file-info");
    expect(readFile).not.toHaveBeenCalled();
    expect(within(card).getByTestId("file-info-reason").getAttribute("data-reason")).toBe("unsupported");
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
    const card = await screen.findByTestId("file-info");
    expect(within(card).queryByTestId("folder-open-external")).toBeNull();
    expect(within(card).getByTestId("folder-open-external-unavailable")).toBeDefined();
    await waitFor(() => expect(document.activeElement).toBe(within(card).getByTestId("folder-reveal")));
  });

  it("asks main to search the deepest open folder and lists the matches it returns", async () => {
    const searchFiles = vi.fn(async () => ({
      ok: true, truncated: false,
      matches: [{ path: `${ROOT}/src/payments/retry-policy.ts`, relativePath: "payments/retry-policy.ts", root: ROOT, bytes: 10 }],
    }));
    Object.assign(window.ave.workspace, { searchFiles });
    await openView();
    fireEvent.click(row(`${ROOT}/src`));
    await waitFor(() => expect(columns()).toEqual([ROOT, `${ROOT}/src`]));
    fireEvent.change(screen.getByTestId("folder-search"), { target: { value: "retry" } });
    await waitFor(() => expect(searchFiles).toHaveBeenCalledWith("retry", { folder: `${ROOT}/src` }));
    const results = await screen.findByTestId("folder-search-results");
    expect(within(results).getByRole("option").textContent).toBe("payments/retry-policy.ts");
  });

  describe("refresh", () => {
    const SRC = `${ROOT}/src`;
    const original = { root: listings[ROOT], src: listings[SRC] };
    afterEach(() => { listings[ROOT] = original.root; listings[SRC] = original.src; readFile.mockImplementation(readFromDisk); });

    async function openIndex() {
      await openView();
      fireEvent.click(row(SRC));
      await waitFor(() => expect(row(`${SRC}/index.ts`)).toBeDefined());
      fireEvent.click(row(`${SRC}/index.ts`));
      await waitFor(() => expect(screen.getAllByTestId("preview-code-line").length).toBeGreaterThan(0));
    }

    it("lists every open column again and re-reads the open file when files may have changed", async () => {
      await openIndex();
      listings[SRC] = { ok: true, entries: [dir(`${SRC}/payments`), file(`${SRC}/created-later.ts`), { ...file(`${SRC}/index.ts`, 99), mtimeMs: 5 }], truncated: false, hidden: 0 };
      readFile.mockImplementation(async (path: string) => ({ ok: true, content: "export const CHANGED_ON_DISK = 1;\n", truncated: false, lineCount: 2, path }));
      listDir.mockClear();
      act(() => notifyWorkspaceFilesChanged("tool"));
      await waitFor(() => expect(row(`${SRC}/created-later.ts`)).toBeDefined());
      expect(listDir.mock.calls.map(([path]) => path)).toEqual([ROOT, SRC]);
      await waitFor(() => expect(screen.getByTestId("folder-viewer").textContent).toContain("CHANGED_ON_DISK"));
      // The open file stays open, with the fresh size in its header, and the view never went back to "loading".
      expect(screen.getByTestId("folder-viewer").getAttribute("data-path")).toBe(`${SRC}/index.ts`);
      expect(screen.getByTestId("folder-viewer-subtitle").textContent).toContain("99 B");
      expect(screen.queryByTestId("folder-viewer-loading")).toBeNull();
      expect(screen.queryByTestId("folder-column-loading")).toBeNull();
    });

    it("refreshes on window focus and from the refresh button", async () => {
      await openView();
      listings[ROOT] = { ok: true, entries: [dir(`${ROOT}/data`), file(`${ROOT}/from-focus.txt`)], truncated: false, hidden: 0 };
      act(() => { window.dispatchEvent(new Event("focus")); });
      await waitFor(() => expect(row(`${ROOT}/from-focus.txt`)).toBeDefined());
      listings[ROOT] = { ok: true, entries: [dir(`${ROOT}/data`), file(`${ROOT}/from-button.txt`)], truncated: false, hidden: 0 };
      fireEvent.click(screen.getByTestId("folder-refresh"));
      await waitFor(() => expect(row(`${ROOT}/from-button.txt`)).toBeDefined());
      expect(row(`${ROOT}/from-focus.txt`)).toBeUndefined();
    });

    it("closes the open file and its columns when the refreshed listing no longer has them, keeping focus in the view", async () => {
      await openIndex();
      row(`${SRC}/index.ts`).focus();
      listings[ROOT] = { ok: true, entries: [dir(`${ROOT}/data`), file(`${ROOT}/package.json`)], truncated: false, hidden: 0 };
      listings[SRC] = { ok: false, error: "not-found" };
      act(() => notifyWorkspaceFilesChanged("turn"));
      await waitFor(() => expect(columns()).toEqual([ROOT]));
      expect(screen.queryByTestId("folder-viewer")).toBeNull();
      await waitFor(() => expect(document.activeElement).toBe(row(`${ROOT}/data`)));
    });

    it("asks once more after a burst that arrived while a listing was in flight", async () => {
      await openView();
      const pending: Array<(value: unknown) => void> = [];
      listDir.mockClear();
      listDir.mockImplementation(() => new Promise((resolve) => { pending.push(resolve); }) as never);
      act(() => { notifyWorkspaceFilesChanged("tool"); notifyWorkspaceFilesChanged("tool"); notifyWorkspaceFilesChanged("tool"); });
      expect(listDir).toHaveBeenCalledTimes(1);
      await act(async () => { pending.shift()?.(listings[ROOT]); });
      await waitFor(() => expect(listDir).toHaveBeenCalledTimes(2));
      await act(async () => { pending.shift()?.({ ok: true, entries: [file(`${ROOT}/last.txt`)], truncated: false, hidden: 0 }); });
      await waitFor(() => expect(row(`${ROOT}/last.txt`)).toBeDefined());
      expect(listDir).toHaveBeenCalledTimes(2);
      listDir.mockImplementation(async (path: string) => listings[path] ?? { ok: false, error: "not-found" });
    });
  });

  it("says how many items a capped listing leaves out, in the column and in the status line", async () => {
    const MANY = `${ROOT}/data`;
    const before = listings[MANY];
    listings[MANY] = { ok: true, entries: [dir(`${MANY}/zz-folder`), file(`${MANY}/f0000.txt`)], truncated: true, omitted: 101, hidden: 0 };
    try {
      await openView();
      fireEvent.click(row(MANY));
      const note = await screen.findByTestId("folder-column-truncated");
      expect(note.textContent).toBe("처음 2개만 표시합니다. 101개가 더 있습니다.");
      expect(screen.getByTestId("folder-status").textContent).toContain("폴더 1 · 파일 1 · 101개 더 있음");
    } finally {
      listings[MANY] = before;
    }
  });

  it("moves with Home and End, and to the row whose name is typed", async () => {
    await openView();
    await waitFor(() => expect(document.activeElement).toBe(row(`${ROOT}/data`)));
    fireEvent.keyDown(row(`${ROOT}/data`), { key: "End" });
    expect(document.activeElement).toBe(row(`${ROOT}/package.json`));
    fireEvent.keyDown(row(`${ROOT}/package.json`), { key: "Home" });
    expect(document.activeElement).toBe(row(`${ROOT}/data`));
    // "d" from "data" goes to the next row that starts with it; "de" stays on "deploy".
    fireEvent.keyDown(row(`${ROOT}/data`), { key: "d" });
    expect(document.activeElement).toBe(row(`${ROOT}/deploy`));
    fireEvent.keyDown(row(`${ROOT}/deploy`), { key: "e" });
    expect(document.activeElement).toBe(row(`${ROOT}/deploy`));
    // A chord is not typing: the row keeps focus and nothing opens.
    fireEvent.keyDown(row(`${ROOT}/deploy`), { key: "s", metaKey: true });
    expect(document.activeElement).toBe(row(`${ROOT}/deploy`));
    expect(columns()).toEqual([ROOT]);
  });

  it("walks from the search box into the results with the arrows and back, and opens a result with Enter", async () => {
    const searchFiles = vi.fn(async () => ({
      ok: true, truncated: false,
      matches: [
        { path: `${ROOT}/src/index.ts`, relativePath: "src/index.ts", root: ROOT, bytes: 10 },
        { path: `${ROOT}/package.json`, relativePath: "package.json", root: ROOT, bytes: 10 },
      ],
    }));
    Object.assign(window.ave.workspace, { searchFiles });
    await openView();
    const box = screen.getByTestId("folder-search");
    fireEvent.change(box, { target: { value: "i" } });
    const results = await screen.findByTestId("folder-search-results");
    const options = within(results).getAllByRole("option");
    box.focus();
    fireEvent.keyDown(box, { key: "ArrowDown" });
    expect(document.activeElement).toBe(options[0]);
    fireEvent.keyDown(options[0] as HTMLElement, { key: "ArrowDown" });
    expect(document.activeElement).toBe(options[1]);
    fireEvent.keyDown(options[1] as HTMLElement, { key: "Home" });
    expect(document.activeElement).toBe(options[0]);
    fireEvent.keyDown(options[0] as HTMLElement, { key: "ArrowUp" });
    expect(document.activeElement).toBe(box);
    fireEvent.keyDown(box, { key: "ArrowDown" });
    fireEvent.click(document.activeElement as HTMLElement);
    await waitFor(() => expect(screen.getByTestId("folder-viewer").getAttribute("data-path")).toBe(`${ROOT}/src/index.ts`));
  });

  describe("row menu", () => {
    const writeText = vi.fn(async (_text: string) => undefined);
    beforeEach(() => { writeText.mockClear(); Object.assign(navigator, { clipboard: { writeText } }); });
    const items = () => within(screen.getByTestId("file-row-menu")).getAllByRole("menuitem").map((item) => item.getAttribute("data-testid"));

    it("opens on right-click with the row's actions, which act on that row", async () => {
      const onOpenTerminal = vi.fn();
      const onAttachText = vi.fn(() => true as const);
      render(<FolderView projectRoot={ROOT} onOpenTerminal={onOpenTerminal} onAttachText={onAttachText} />);
      await waitFor(() => expect(row(`${ROOT}/src`)).toBeDefined());
      fireEvent.click(row(`${ROOT}/src`));
      await waitFor(() => expect(row(`${ROOT}/src/index.ts`)).toBeDefined());
      fireEvent.contextMenu(row(`${ROOT}/src/index.ts`), { clientX: 300, clientY: 120 });
      expect(items()).toEqual(["file-row-action-reveal", "file-row-action-copy-path", "file-row-action-copy-relative-path",
        "file-row-action-add-to-chat", "file-row-action-open-terminal"]);
      fireEvent.click(screen.getByTestId("file-row-action-copy-relative-path"));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith("src/index.ts"));
      await waitFor(() => expect(screen.queryByTestId("file-row-menu")).toBeNull());

      fireEvent.contextMenu(row(`${ROOT}/src/index.ts`), { clientX: 300, clientY: 120 });
      fireEvent.click(screen.getByTestId("file-row-action-copy-path"));
      await waitFor(() => expect(writeText).toHaveBeenCalledWith(`${ROOT}/src/index.ts`));

      fireEvent.contextMenu(row(`${ROOT}/src/index.ts`), { clientX: 300, clientY: 120 });
      fireEvent.click(screen.getByTestId("file-row-action-reveal"));
      expect(window.ave.workspace.reveal).toHaveBeenCalledWith(`${ROOT}/src/index.ts`);

      fireEvent.contextMenu(row(`${ROOT}/src/index.ts`), { clientX: 300, clientY: 120 });
      fireEvent.click(screen.getByTestId("file-row-action-add-to-chat"));
      expect(onAttachText).toHaveBeenCalledWith(`\`${ROOT}/src/index.ts\``);

      // A file opens the terminal in the folder that holds it; a folder opens itself.
      fireEvent.contextMenu(row(`${ROOT}/src/index.ts`), { clientX: 300, clientY: 120 });
      fireEvent.click(screen.getByTestId("file-row-action-open-terminal"));
      expect(onOpenTerminal).toHaveBeenLastCalledWith(`${ROOT}/src`);
      fireEvent.contextMenu(row(`${ROOT}/src/payments`), { clientX: 300, clientY: 120 });
      fireEvent.click(screen.getByTestId("file-row-action-open-terminal"));
      expect(onOpenTerminal).toHaveBeenLastCalledWith(`${ROOT}/src/payments`);
    });

    it("opens from the keyboard with Shift+F10, returns focus to the row on Escape, and reports a failed action", async () => {
      render(<FolderView projectRoot={ROOT} onAttachText={() => "no-composer"} />);
      await waitFor(() => expect(row(`${ROOT}/package.json`)).toBeDefined());
      row(`${ROOT}/package.json`).focus();
      fireEvent.keyDown(row(`${ROOT}/package.json`), { key: "F10", shiftKey: true });
      // No terminal was offered by the host, so the menu has no such action.
      expect(items()).toEqual(["file-row-action-reveal", "file-row-action-copy-path", "file-row-action-copy-relative-path", "file-row-action-add-to-chat"]);
      fireEvent.keyDown(screen.getByTestId("file-row-menu"), { key: "Escape" });
      await waitFor(() => expect(screen.queryByTestId("file-row-menu")).toBeNull());
      await waitFor(() => expect(document.activeElement).toBe(row(`${ROOT}/package.json`)));
      fireEvent.keyDown(row(`${ROOT}/package.json`), { key: "ContextMenu" });
      fireEvent.click(screen.getByTestId("file-row-action-add-to-chat"));
      expect((await screen.findByTestId("folder-view-alert")).textContent).toBe("이 파일을 추가하려면 먼저 채팅을 여세요.");
    });

    it("offers a link that leaves the project its path only", async () => {
      await openView();
      fireEvent.click(row(`${ROOT}/deploy`));
      await waitFor(() => expect(row(`${ROOT}/deploy/shared-config`)).toBeDefined());
      fireEvent.contextMenu(row(`${ROOT}/deploy/shared-config`), { clientX: 10, clientY: 10 });
      expect(items()).toEqual(["file-row-action-copy-path", "file-row-action-copy-relative-path"]);
    });
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

  it("walks, labels and restores a project whose root is NFC while its entries are NFD", async () => {
    const docs = `${NFD_ROOT}/문서`.normalize("NFD");
    const memo = `${docs}/메모.md`.normalize("NFD");
    const onLocationChange = vi.fn();
    const view = render(<FolderView projectRoot={NFC_ROOT} onLocationChange={onLocationChange} />);
    await waitFor(() => expect(row(docs)).toBeDefined());
    fireEvent.click(row(docs));
    await waitFor(() => expect(row(memo)).toBeDefined());
    fireEvent.click(row(memo));
    await screen.findByTestId("folder-viewer");
    // The path line names the folders under the root, not a slice cut at the NFC root's length.
    expect(screen.getByTestId("folder-status").textContent?.normalize("NFC")).toContain("문서/메모.md");
    expect([...screen.getByTestId("folder-path").querySelectorAll("button")].map((each) => each.textContent?.normalize("NFC")))
      .toEqual(["프로젝트", "문서"]);
    await waitFor(() => expect(onLocationChange).toHaveBeenLastCalledWith({ path: docs, selection: memo }));
    view.unmount();

    // The saved location reopens: the walk matches the NFD entries listDir returns.
    render(<FolderView projectRoot={NFC_ROOT} initialLocation={{ path: docs, selection: memo }} />);
    await screen.findByTestId("folder-viewer");
    expect(columns()).toEqual([NFC_ROOT, docs]);
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
    const reason = await screen.findByTestId("file-info-reason");
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
    // Locked out: revealing the folder to grant access leads, retry is the link beside it.
    expect(within(error).getByTestId("folder-column-reveal").className).toContain("bg-primary");
    expect(within(error).getByTestId("folder-column-retry").className).toContain("underline-offset-4");
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

    fireEvent.click(screen.getByTestId("folder-markdown-view"));
    expect(screen.getByTestId("folder-markdown-rendered").querySelector("h1")?.textContent).toBe("Title");

    fireEvent.click(row(`${ROOT}/src/payments/flow.png`));
    const image = await screen.findByTestId("folder-image-viewer");
    expect(within(image).getByTestId("folder-image-zoom").textContent).toBe("맞춤");
    fireEvent.doubleClick(image.querySelector("img")!);
    expect(within(image).getByTestId("folder-image-zoom").textContent).toBe("100%");
    fireEvent.doubleClick(image.querySelector("img")!);
    expect(within(image).getByTestId("folder-image-zoom").textContent).toBe("맞춤");
  });
});
