// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, createEvent, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { createRef, useRef, useState } from "react";
import { Composer, composerDropZoneProps, type ComposerHandle } from "../Composer.js";
import type { Attachment } from "../../types/attachments.js";
import { TEST_IDS } from "../../../../shared/test-ids.js";
import { FILE_MENTION_DRAG_MIME } from "../../../../shared/file-mention-reference.js";

const MATCHES = [
  { path: "/ws/src/app.ts", relativePath: "src/app.ts", root: "/ws", bytes: 12 },
  { path: "/ws/src/deep/application.md", relativePath: "src/deep/application.md", root: "/ws", bytes: 40 },
];

function installWorkspace(searchFiles = vi.fn(async () => ({ ok: true, matches: MATCHES, truncated: false }))) {
  (window as unknown as { ave?: unknown }).ave = { workspace: { searchFiles } };
  return searchFiles;
}

let lastAttachments: Attachment[] = [];

function Harness({
  filesEnabled,
  onDropFiles,
}: { filesEnabled?: boolean; onDropFiles?: (files: FileList | readonly File[]) => void }) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const counter = useRef(0);
  lastAttachments = attachments;
  return (
    <Composer
      text={text}
      onTextChange={setText}
      attachments={attachments}
      onAttachmentsChange={setAttachments}
      allocateN={() => ++counter.current}
      saveClipboardImage={vi.fn(async () => ({ ok: false }))}
      onSend={vi.fn()}
      filesEnabled={filesEnabled}
      onDropFiles={onDropFiles}
    />
  );
}

const textarea = () => screen.getByTestId(TEST_IDS.composerTextarea) as HTMLTextAreaElement;

describe("Composer changed-location references", () => {
  const reference = { path: "src/app.ts", startLine: 3, endLine: 5, turnId: "turn-1", hunkId: "hunk-1" };
  function ReferenceHarness({ disabled = false, filesEnabled = true }: { disabled?: boolean; filesEnabled?: boolean }) {
    const [text, setText] = useState("before selected after");
    const [attachments, setAttachments] = useState<Attachment[]>([]);
    const counter = useRef(0);
    lastAttachments = attachments;
    return <>
      <button onClick={() => setText("replacement draft")}>Replace draft</button>
      <Composer ref={handle} text={text} onTextChange={setText} attachments={attachments}
        onAttachmentsChange={setAttachments} allocateN={() => ++counter.current}
        saveClipboardImage={vi.fn(async () => ({ ok: false }))} onSend={vi.fn()}
        disabled={disabled} filesEnabled={filesEnabled} />
    </>;
  }
  const handle = createRef<ComposerHandle>();

  it("inserts at the live middle selection and commits the marker with its attachment", () => {
    render(<ReferenceHarness />);
    const ta = textarea();
    ta.focus();
    ta.setSelectionRange(7, 15);
    let result: unknown;
    act(() => { result = handle.current?.insertFileReference(reference); });
    expect(result).toEqual({ inserted: true });
    expect(ta.value).toBe("before [File #1] after");
    expect(lastAttachments).toEqual([expect.objectContaining({ path: "src/app.ts", reference: true,
      location: { startLine: 3, endLine: 5, turnId: "turn-1", hunkId: "hunk-1" } })]);
    expect(screen.getByTestId("chip-count-badge").textContent).toContain("src/app.ts:3-5");
  });

  it("retains the selection on blur and never applies it to a replaced draft", () => {
    render(<ReferenceHarness />);
    const ta = textarea();
    ta.focus();
    ta.setSelectionRange(7, 15);
    act(() => { ta.blur(); });
    ta.setSelectionRange(0, 0);
    act(() => { handle.current?.insertFileReference(reference); });
    expect(ta.value).toBe("before [File #1] after");
    fireEvent.click(screen.getByText("Replace draft"));
    act(() => { handle.current?.insertFileReference({ ...reference, hunkId: "hunk-2" }); });
    expect(ta.value).toBe("replacement draft[File #2]");
  });

  it("inserts an ordinary file mention without a line range at the selection", () => {
    render(<ReferenceHarness />);
    const ta = textarea();
    ta.focus();
    ta.setSelectionRange(7, 15);
    act(() => { expect(handle.current?.insertFileMention("src/app.ts")).toEqual({ inserted: true }); });
    expect(ta.value).toBe("before [File #1] after");
    expect(lastAttachments).toEqual([expect.objectContaining({ path: "src/app.ts", reference: true })]);
    expect(lastAttachments[0]).not.toHaveProperty("location");
    expect(screen.getByTestId("chip-count-badge").textContent).toBe("@src/app.ts");
  });

  it("preserves a native file path while deriving its filename independently of directory separators", () => {
    render(<ReferenceHarness />);
    act(() => { handle.current?.insertFileMention("C:\\work\\project.v2\\source"); });
    expect(lastAttachments[0]).toMatchObject({ path: "C:\\work\\project.v2\\source", name: "source", ext: "" });
    expect(screen.getByTestId("chip-count-badge").textContent).toBe("@source");
  });

  it("ignores repeated file and location inserts without allocating a marker or changing the draft", () => {
    render(<ReferenceHarness />);
    const insert = handle.current!.insertFileReference;
    act(() => { expect(insert(reference)).toEqual({ inserted: true }); });
    const previous = textarea().value;
    act(() => { expect(insert(reference)).toEqual({ inserted: false }); });
    expect(textarea().value).toBe(previous);
    expect(lastAttachments).toHaveLength(1);
    act(() => { expect(handle.current?.insertFileMention("src/app.ts")).toEqual({ inserted: true }); });
    const plainDraft = textarea().value;
    act(() => { expect(handle.current?.insertFileMention("src/app.ts")).toEqual({ inserted: false }); });
    expect(textarea().value).toBe(plainDraft);
    expect(lastAttachments.map((attachment) => attachment.n)).toEqual([1, 2]);
    act(() => { expect(insert({ ...reference, hunkId: "hunk-2" })).toEqual({ inserted: true }); });
    expect(lastAttachments.map((attachment) => attachment.n)).toEqual([1, 2, 3]);
  });

  it("removes a reference chip and its marker while preserving adjacent text and other references", () => {
    render(<ReferenceHarness />);
    act(() => { handle.current?.insertFileReference(reference); });
    act(() => { handle.current?.insertFileMention("src/other.ts"); });
    const first = lastAttachments[0];
    expect(first).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /참조 제거.*src\/app.ts:3-5|Remove reference.*src\/app.ts:3-5/ }));
    expect(textarea().value).not.toContain("[File #1]");
    expect(textarea().value).toContain("[File #2]");
    expect(textarea().value).toContain("before selected after");
    expect(lastAttachments).toEqual([expect.objectContaining({ path: "src/other.ts" })]);
  });

  it("refuses the sixth reference atomically", () => {
    render(<ReferenceHarness />);
    const insert = handle.current!.insertFileReference;
    for (let index = 0; index < 5; index += 1) {
      act(() => { expect(insert({ ...reference, hunkId: `hunk-${index}` })).toEqual({ inserted: true }); });
    }
    const previous = textarea().value;
    act(() => { expect(insert({ ...reference, hunkId: "sixth" })).toEqual({ inserted: false }); });
    expect(textarea().value).toBe(previous);
    expect(lastAttachments).toHaveLength(5);
  });

  it("keeps a newer caret selection when a pending insertion frame runs", () => {
    render(<ReferenceHarness />);
    const frames: FrameRequestCallback[] = [];
    const frame = vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => { frames.push(callback); return frames.length; });
    try {
      const ta = textarea();
      ta.focus();
      ta.setSelectionRange(7, 15);
      act(() => { handle.current?.insertFileReference(reference); });
      ta.setSelectionRange(0, 0);
      act(() => { for (const callback of frames) callback(0); });
      expect(ta.selectionStart).toBe(0);
      expect(ta.selectionEnd).toBe(0);
    } finally { frame.mockRestore(); }
  });

  it("preserves an active composition and rejects invalid selectors without consuming a marker number", () => {
    render(<ReferenceHarness />);
    const ta = textarea();
    fireEvent.compositionStart(ta);
    act(() => { expect(handle.current?.insertFileReference(reference)).toEqual({ inserted: false }); });
    fireEvent.compositionEnd(ta);
    act(() => { expect(handle.current?.insertFileReference({ ...reference, path: "../outside.ts" })).toEqual({ inserted: false }); });
    expect(lastAttachments).toEqual([]);
    expect(ta.value).toBe("before selected after");
    act(() => { expect(handle.current?.insertFileReference(reference)).toEqual({ inserted: true }); });
    expect(lastAttachments[0]?.n).toBe(1);
  });

  it.each([{ disabled: true }, { filesEnabled: false }])("honors composer runtime gates: %j", (props) => {
    render(<ReferenceHarness {...props} />);
    act(() => { expect(handle.current?.insertFileReference(reference)).toEqual({ inserted: false }); });
    expect(textarea().value).toBe("before selected after");
    expect(lastAttachments).toEqual([]);
  });
});

afterEach(() => {
  delete (window as unknown as { ave?: unknown }).ave;
  lastAttachments = [];
});

describe("Composer — @file mention", () => {
  it("is fully keyboard-driven: type, arrow to a row, Enter attaches a path reference", async () => {
    const searchFiles = installWorkspace();
    render(<Harness />);
    const ta = textarea();
    ta.focus();
    fireEvent.change(ta, { target: { value: "explain @app" } });

    await waitFor(() => expect(screen.getAllByTestId(/^resource-mention-item-/)).toHaveLength(2));
    expect(searchFiles).toHaveBeenLastCalledWith("app");
    expect(screen.getByTestId("resource-mention-hint").textContent).toMatch(/reference|참조/);

    await act(async () => { fireEvent.keyDown(ta, { key: "ArrowDown" }); });
    expect(screen.getByTestId("resource-mention-item-1").getAttribute("aria-selected")).toBe("true");
    await act(async () => { fireEvent.keyDown(ta, { key: "Enter" }); });

    // The mention token became a marker; no file content is in the body.
    expect(ta.value).toBe("explain [File #1] ");
    expect(lastAttachments).toEqual([
      expect.objectContaining({
        kind: "file",
        n: 1,
        path: "/ws/src/deep/application.md",
        name: "application.md",
        ext: "md",
        bytes: 40,
        reference: true,
      }),
    ]);
    expect(screen.queryByTestId("resource-mention-menu")).toBeNull();
    expect(document.activeElement).toBe(ta);
  });

  it("drops the previous query's rows while the next search is pending", async () => {
    let resolveSecond: (value: unknown) => void = () => {};
    const searchFiles = vi.fn(async (query: string) => {
      if (query === "app") return { ok: true, matches: MATCHES, truncated: false };
      return new Promise((resolve) => { resolveSecond = resolve; });
    });
    installWorkspace(searchFiles as never);
    render(<Harness />);
    const ta = textarea();
    ta.focus();
    fireEvent.change(ta, { target: { value: "@app" } });
    await waitFor(() => expect(screen.getAllByTestId(/^resource-mention-item-/)).toHaveLength(2));

    fireEvent.change(ta, { target: { value: "@zzz" } });
    // The rows for "app" are gone at once, so Enter cannot attach one of them.
    expect(screen.queryAllByTestId(/^resource-mention-item-/)).toHaveLength(0);
    await act(async () => { fireEvent.keyDown(ta, { key: "Enter" }); });
    expect(lastAttachments).toEqual([]);

    await waitFor(() => expect(searchFiles).toHaveBeenLastCalledWith("zzz"));
    await act(async () => { resolveSecond({ ok: true, matches: [MATCHES[1]], truncated: false }); });
    await waitFor(() => expect(screen.getAllByTestId(/^resource-mention-item-/)).toHaveLength(1));
  });

  it("Escape closes the menu without attaching", async () => {
    installWorkspace();
    render(<Harness />);
    const ta = textarea();
    fireEvent.change(ta, { target: { value: "@app" } });
    await waitFor(() => expect(screen.getByTestId("resource-mention-menu")).toBeTruthy());
    await act(async () => { fireEvent.keyDown(ta, { key: "Escape" }); });
    expect(screen.queryByTestId("resource-mention-menu")).toBeNull();
    expect(lastAttachments).toEqual([]);
    expect(ta.value).toBe("@app");
  });

  it("offers no file rows when the runtime cannot take file attachments", async () => {
    const searchFiles = installWorkspace();
    render(<Harness filesEnabled={false} />);
    fireEvent.change(textarea(), { target: { value: "@app" } });
    await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
    expect(searchFiles).not.toHaveBeenCalled();
    expect(screen.queryByTestId("resource-mention-menu")).toBeNull();
  });
});

/** The composer inside a surface that is its drop zone, with a conversation area beside the input, as both chats mount it. */
function Surface({ onDropFiles, disabled = false }: { onDropFiles?: (files: FileList | readonly File[]) => void; disabled?: boolean }) {
  const [text, setText] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const counter = useRef(0);
  const composer = useRef<ComposerHandle | null>(null);
  lastAttachments = attachments;
  return (
    <div data-testid="surface" {...composerDropZoneProps(composer)}>
      <div data-testid="conversation">transcript</div>
      <Composer ref={composer} text={text} onTextChange={setText} attachments={attachments}
        onAttachmentsChange={setAttachments} allocateN={() => ++counter.current}
        saveClipboardImage={vi.fn(async () => ({ ok: false }))} onSend={vi.fn()}
        onDropFiles={onDropFiles} disabled={disabled} />
    </div>
  );
}

describe("Composer — drop zone and pasted files", () => {
  function fileDrag(type: string, files: File[] = []) {
    return { dataTransfer: { types: ["Files"], files, dropEffect: "none" }, type };
  }
  function mentionDrag(path: string) {
    return {
      dataTransfer: {
        types: ["text/plain", FILE_MENTION_DRAG_MIME],
        files: [],
        dropEffect: "none",
        getData: (type: string) => (type === FILE_MENTION_DRAG_MIME || type === "text/plain" ? path : ""),
      },
    };
  }

  it("shows the drop affordance on a file drag and hands the dropped files over once", () => {
    const onDropFiles = vi.fn();
    render(<Surface onDropFiles={onDropFiles} />);
    const target = screen.getByTestId(TEST_IDS.composer);
    fireEvent.dragEnter(target, fileDrag("dragenter"));
    expect(screen.getByTestId("composer-drop-overlay")).toBeTruthy();
    const file = new File(["x"], "notes.txt");
    fireEvent.drop(target, fileDrag("drop", [file]));
    expect(onDropFiles).toHaveBeenCalledTimes(1);
    expect(Array.from(onDropFiles.mock.calls[0][0] as File[])).toEqual([file]);
    expect(screen.queryByTestId("composer-drop-overlay")).toBeNull();
  });

  it("attaches a file dropped on the conversation area, and claims the event so the window guard has nothing to discard", () => {
    const onDropFiles = vi.fn();
    render(<Surface onDropFiles={onDropFiles} />);
    const conversation = screen.getByTestId("conversation");
    fireEvent.dragOver(conversation, fileDrag("dragover"));
    expect(screen.getByTestId("composer-drop-overlay")).toBeTruthy();
    const file = new File(["x"], "report.pdf");
    const claimed = !fireEvent.drop(conversation, fileDrag("drop", [file]));
    expect(claimed).toBe(true);
    expect(onDropFiles).toHaveBeenCalledTimes(1);
    expect(Array.from(onDropFiles.mock.calls[0][0] as File[])).toEqual([file]);
  });

  it("keeps the affordance while the drag moves inside the surface and drops it when the drag leaves", () => {
    render(<Surface onDropFiles={vi.fn()} />);
    const surface = screen.getByTestId("surface");
    fireEvent.dragEnter(screen.getByTestId("conversation"), fileDrag("dragenter"));
    // The test DOM has no DragEvent, so the element the drag moves to is set on the event by hand.
    const leave = (from: HTMLElement, to: HTMLElement) => {
      const event = createEvent.dragLeave(from);
      Object.defineProperty(event, "relatedTarget", { value: to });
      fireEvent(from, event);
    };
    leave(screen.getByTestId("conversation"), screen.getByTestId(TEST_IDS.composer));
    expect(screen.getByTestId("composer-drop-overlay")).toBeTruthy();
    leave(surface, document.body);
    expect(screen.queryByTestId("composer-drop-overlay")).toBeNull();
  });

  it("ignores a drag that carries neither files nor a file row", () => {
    const onDropFiles = vi.fn();
    render(<Surface onDropFiles={onDropFiles} />);
    const target = screen.getByTestId(TEST_IDS.composer);
    const text = { dataTransfer: { types: ["text/plain"], files: [], getData: () => "/w/notes.md" } };
    fireEvent.dragEnter(target, text);
    expect(screen.queryByTestId("composer-drop-overlay")).toBeNull();
    expect(fireEvent.drop(target, text)).toBe(true);
    expect(onDropFiles).not.toHaveBeenCalled();
    expect(lastAttachments).toEqual([]);
  });

  it("turns a dragged file row into a file mention, wherever on the surface it is dropped", () => {
    render(<Surface />);
    const conversation = screen.getByTestId("conversation");
    fireEvent.dragEnter(conversation, mentionDrag("/w/src/app.ts"));
    expect(screen.getByTestId("composer-drop-overlay")).toBeTruthy();
    const claimed = !fireEvent.drop(conversation, mentionDrag("/w/src/app.ts"));
    expect(claimed).toBe(true);
    expect(lastAttachments).toEqual([expect.objectContaining({ kind: "file", path: "/w/src/app.ts", name: "app.ts", reference: true })]);
    expect(textarea().value).toBe("[File #1]");
    expect(screen.getByTestId("composer-reference-strip").textContent).toContain("app.ts");
  });

  it("takes nothing while the composer is disabled, leaving the drop to the window guard", () => {
    const onDropFiles = vi.fn();
    render(<Surface onDropFiles={onDropFiles} disabled />);
    const conversation = screen.getByTestId("conversation");
    fireEvent.dragEnter(conversation, fileDrag("dragenter"));
    expect(screen.queryByTestId("composer-drop-overlay")).toBeNull();
    expect(fireEvent.drop(conversation, fileDrag("drop", [new File(["x"], "notes.txt")]))).toBe(true);
    expect(fireEvent.drop(conversation, mentionDrag("/w/src/app.ts"))).toBe(true);
    expect(onDropFiles).not.toHaveBeenCalled();
    expect(lastAttachments).toEqual([]);
  });

  function paste(files: File[], text = "") {
    const items = files.map((file) => ({ kind: "file", type: file.type, getAsFile: () => file }));
    return fireEvent.paste(textarea(), {
      clipboardData: { files, items, types: ["Files"], getData: (type: string) => (type === "text/plain" ? text : "") },
    });
  }

  it("sends a pasted file that is not an image down the drop path, and keeps its name out of the field", () => {
    const onDropFiles = vi.fn();
    render(<Surface onDropFiles={onDropFiles} />);
    const pdf = new File(["%PDF-1.4"], "report.pdf", { type: "application/pdf" });
    const notes = new File(["notes"], "notes.md", { type: "" });
    // A file-manager copy also puts the file names on the clipboard as text.
    const claimed = !paste([pdf, notes], "report.pdf\nnotes.md");
    expect(claimed).toBe(true);
    expect(onDropFiles).toHaveBeenCalledTimes(1);
    expect(onDropFiles.mock.calls[0][0]).toEqual([pdf, notes]);
    expect(textarea().value).toBe("");
  });

  it("leaves a pasted image to the clipboard-image path", async () => {
    const onDropFiles = vi.fn();
    render(<Surface onDropFiles={onDropFiles} />);
    await act(async () => { paste([new File(["png"], "shot.png", { type: "image/png" })]); });
    expect(onDropFiles).not.toHaveBeenCalled();
  });
});
