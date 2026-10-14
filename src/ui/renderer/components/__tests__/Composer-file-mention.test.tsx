// @vitest-environment jsdom
import "../../../../../test/renderer/setup.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useRef, useState } from "react";
import { Composer } from "../Composer.js";
import type { Attachment } from "../../types/attachments.js";
import { TEST_IDS } from "../../../../shared/test-ids.js";

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
}: { filesEnabled?: boolean; onDropFiles?: (files: FileList) => void }) {
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

describe("Composer — file drop", () => {
  function fileDrag(type: string, files: File[] = []) {
    return { dataTransfer: { types: ["Files"], files, dropEffect: "none" }, type };
  }

  it("shows the drop affordance on a file drag and hands the dropped FileList over", () => {
    const onDropFiles = vi.fn();
    render(<Harness onDropFiles={onDropFiles} />);
    const target = screen.getByTestId(TEST_IDS.composer);
    fireEvent.dragEnter(target, fileDrag("dragenter"));
    expect(screen.getByTestId("composer-drop-overlay")).toBeTruthy();
    const file = new File(["x"], "notes.txt");
    fireEvent.drop(target, fileDrag("drop", [file]));
    expect(onDropFiles).toHaveBeenCalledTimes(1);
    expect(Array.from(onDropFiles.mock.calls[0][0] as File[])).toEqual([file]);
    expect(screen.queryByTestId("composer-drop-overlay")).toBeNull();
  });

  it("ignores a non-file drag", () => {
    const onDropFiles = vi.fn();
    render(<Harness onDropFiles={onDropFiles} />);
    const target = screen.getByTestId(TEST_IDS.composer);
    fireEvent.dragEnter(target, { dataTransfer: { types: ["text/plain"], files: [] } });
    expect(screen.queryByTestId("composer-drop-overlay")).toBeNull();
  });
});
