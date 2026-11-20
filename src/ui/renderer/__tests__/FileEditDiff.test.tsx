import "../../../../test/renderer/setup.js";
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, fireEvent, screen, waitFor } from "@testing-library/react";
import { FileEditDiff } from "../components/FileEditDiff.js";
import type { FileEditDiffData } from "../utils/file-diff.js";
import type { WriteDiffRecord } from "../../../shared/line-diff.js";
import { makeMockAveApi } from "../../../../test/renderer/mock-ave-api.js";
import { t } from "../../../i18n/runtime.js";

/** Every file-tool card loads the host's whole-file line diff; the tool input is only the fallback. */
const SOURCE = { sessionId: "session-test-1", toolUseId: "tu-test-1" };

const RECORD: WriteDiffRecord = {
  version: 2,
  isNewFile: false,
  view: {
    added: 1, removed: 1, truncated: false,
    hunks: [{ oldStart: 12, newStart: 12, oldCount: 2, newCount: 2, rows: [
      { kind: "context", text: "keep" }, { kind: "removed", text: "old line" }, { kind: "added", text: "new line" },
    ] }],
  },
};

const OVERWRITE: FileEditDiffData = { path: "/tmp/test.ts", tool: "write_file", hunks: [], bytes: 6000, hasSidecar: true };

function stubDiff(impl: () => Promise<WriteDiffRecord | null>) {
  const { api } = makeMockAveApi();
  api.chatGetWriteDiff = vi.fn(impl);
  vi.stubGlobal("aveApi", api);
  return api;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("FileEditDiff stored diff", () => {
  it("loads the stored diff for a write_file overwrite and numbers it from the file", async () => {
    const api = stubDiff(() => Promise.resolve(RECORD));
    render(<FileEditDiff data={OVERWRITE} source={SOURCE} />);
    const card = screen.getByTestId("file-edit-diff");
    await waitFor(() => expect(card).toHaveAttribute("data-numbered", "true"));
    expect(api.chatGetWriteDiff).toHaveBeenCalledWith(SOURCE.sessionId, SOURCE.toolUseId);
    expect(card).toHaveAttribute("data-added", "1");
    expect(card).toHaveAttribute("data-removed", "1");
    expect([...card.querySelectorAll('[data-line-column="old"]')].map(cell => cell.textContent)).toEqual(["12", "13", ""]);
    expect(card).toHaveTextContent("old line");
    expect(card).toHaveTextContent("new line");
    expect(screen.getByTestId("file-diff-bytes")).toHaveTextContent("6,000");
  });

  it("replaces an edit card's input diff with the stored whole-file diff", async () => {
    stubDiff(() => Promise.resolve(RECORD));
    render(<FileEditDiff data={{ path: "/tmp/a.ts", tool: "edit_file", hunks: [{ oldText: "old line", newText: "new line" }], hasSidecar: true }} source={SOURCE} />);
    const card = screen.getByTestId("file-edit-diff");
    expect(card).toHaveAttribute("data-numbered", "false");
    expect(card).toHaveTextContent("new line");
    await waitFor(() => expect(card).toHaveAttribute("data-numbered", "true"));
    expect(screen.getByTestId("file-diff-hunk-header")).toHaveTextContent("@@ -12,2 +12,2 @@");
  });

  it("says the earlier content is not stored when an overwrite has no stored diff", async () => {
    stubDiff(() => Promise.resolve(null));
    render(<FileEditDiff data={OVERWRITE} source={SOURCE} />);
    await waitFor(() => expect(screen.getByTestId("file-diff-unavailable")).toHaveTextContent(t("fileEditDiff.diffNotStored")));
    expect(screen.getByTestId("file-edit-diff").querySelectorAll("[data-diff-kind]")).toHaveLength(0);
  });

  it("keeps the input diff of an edit when no stored diff exists", async () => {
    const api = stubDiff(() => Promise.resolve(null));
    render(<FileEditDiff data={{ path: "/tmp/a.ts", tool: "edit_file", hunks: [{ oldText: "a", newText: "b" }], hasSidecar: true }} source={SOURCE} />);
    await waitFor(() => expect(api.chatGetWriteDiff).toHaveBeenCalled());
    const card = screen.getByTestId("file-edit-diff");
    expect(card).toHaveAttribute("data-added", "1");
    expect(screen.queryByTestId("file-diff-unavailable")).toBeNull();
  });

  it("shows a created file from the tool input without asking the host", () => {
    const api = stubDiff(() => Promise.resolve(null));
    render(<FileEditDiff data={{ path: "/tmp/new.ts", tool: "write_file", isNewFile: true, hunks: [{ oldText: "", newText: "a\nb\n" }], bytes: 4 }} source={SOURCE} />);
    expect(api.chatGetWriteDiff).not.toHaveBeenCalled();
    expect(screen.getByTestId("file-edit-diff")).toHaveAttribute("data-added", "2");
  });

  it("shows a load failure with its reason and loads again on retry", async () => {
    let calls = 0;
    stubDiff(() => (calls++ === 0 ? Promise.reject(new Error("IPC timeout")) : Promise.resolve(RECORD)));
    render(<FileEditDiff data={OVERWRITE} source={SOURCE} />);
    const failure = await screen.findByTestId("file-diff-load-error");
    expect(failure).toHaveTextContent("IPC timeout");
    fireEvent.click(screen.getByRole("button", { name: t("fileEditDiff.retry") }));
    await waitFor(() => expect(screen.getByTestId("file-edit-diff")).toHaveAttribute("data-numbered", "true"));
    expect(screen.queryByTestId("file-diff-load-error")).toBeNull();
  });

  it("ignores a diff that resolves after the card unmounted", async () => {
    let resolveIpc!: (value: WriteDiffRecord | null) => void;
    stubDiff(() => new Promise((resolve) => { resolveIpc = resolve; }));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const { unmount } = render(<FileEditDiff data={OVERWRITE} source={SOURCE} />);
    unmount();
    resolveIpc(RECORD);
    await Promise.resolve();
    expect(errors).not.toHaveBeenCalled();
    errors.mockRestore();
  });
});
