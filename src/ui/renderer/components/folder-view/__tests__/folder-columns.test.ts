import { describe, expect, it } from "vitest";
import {
  collapseMiddle,
  columnsHiddenLeft,
  currentFolder,
  folderFileKind,
  folderKeyIntent,
  folderReducer,
  FOLDER_COLUMN_WIDTH,
  FOLDER_VIEWER_MIN_WIDTH,
  initialFolderState,
  pathSegments,
  relativeToRoot,
  viewerEntry,
  viewerReplacesColumns,
  type FolderEntry,
} from "../folder-columns.js";

const ROOT = "/p/checkout-service";
const entry = (path: string, type: FolderEntry["type"] = "directory"): FolderEntry =>
  ({ name: path.split("/").pop()!, path, type, size: 0, mtimeMs: 0, birthtimeMs: 0 });

function opened() {
  let state = initialFolderState(ROOT);
  state = folderReducer(state, { type: "loaded", dir: ROOT, result: { ok: true, entries: [entry(`${ROOT}/src`), entry(`${ROOT}/docs`)] } });
  state = folderReducer(state, { type: "select", column: 0, entry: entry(`${ROOT}/src`) });
  state = folderReducer(state, { type: "loaded", dir: `${ROOT}/src`, result: { ok: true, entries: [entry(`${ROOT}/src/payments`)] } });
  state = folderReducer(state, { type: "select", column: 1, entry: entry(`${ROOT}/src/payments`) });
  return state;
}

describe("folderReducer", () => {
  it("opens a column for a chosen folder and shows a chosen file in the viewer", () => {
    let state = opened();
    expect(state.columns.map((column) => column.dir)).toEqual([ROOT, `${ROOT}/src`, `${ROOT}/src/payments`]);
    expect(state.columns[2]!.status).toBe("loading");
    expect(currentFolder(state)).toBe(`${ROOT}/src/payments`);
    state = folderReducer(state, { type: "loaded", dir: `${ROOT}/src/payments`, result: { ok: true, entries: [] } });
    state = folderReducer(state, { type: "select", column: 2, entry: entry(`${ROOT}/src/payments/retry.ts`, "file") });
    expect(state.columns).toHaveLength(3);
    expect(viewerEntry(state)?.path).toBe(`${ROOT}/src/payments/retry.ts`);
  });

  it("closes every later column when an earlier column's choice changes", () => {
    const state = folderReducer(opened(), { type: "select", column: 0, entry: entry(`${ROOT}/docs`) });
    expect(state.columns.map((column) => column.dir)).toEqual([ROOT, `${ROOT}/docs`]);
    expect(state.selected.map((each) => each.path)).toEqual([`${ROOT}/docs`]);
    expect(viewerEntry(state)).toBeNull();
  });

  it("drops a listing that arrives for a column already closed", () => {
    const before = folderReducer(opened(), { type: "select", column: 0, entry: entry(`${ROOT}/docs`) });
    const after = folderReducer(before, { type: "loaded", dir: `${ROOT}/src/payments`, result: { ok: true, entries: [] } });
    expect(after).toBe(before);
  });

  it("marks a refused folder as locked and clears the mark when a retry lists it", () => {
    let state = folderReducer(opened(), { type: "loaded", dir: `${ROOT}/src/payments`, result: { ok: false, error: "permission-denied" } });
    expect(state.columns[2]).toMatchObject({ status: "error", error: "permission-denied" });
    expect(state.locked.has(`${ROOT}/src/payments`)).toBe(true);
    state = folderReducer(state, { type: "retry", dir: `${ROOT}/src/payments` });
    expect(state.columns[2]!.status).toBe("loading");
    state = folderReducer(state, { type: "loaded", dir: `${ROOT}/src/payments`, result: { ok: true, entries: [] } });
    expect(state.locked.has(`${ROOT}/src/payments`)).toBe(false);
  });

  it("keeps the hidden count and the truncation flag of a listing", () => {
    const state = folderReducer(initialFolderState(ROOT), { type: "loaded", dir: ROOT, result: { ok: true, entries: [], hidden: 2, truncated: true } });
    expect(state.columns[0]).toMatchObject({ hidden: 2, truncated: true });
  });

  it("truncates back to a column, keeping that column's parent selection", () => {
    const state = folderReducer(opened(), { type: "truncate", column: 1 });
    expect(state.columns.map((column) => column.dir)).toEqual([ROOT, `${ROOT}/src`]);
    expect(state.selected.map((each) => each.path)).toEqual([`${ROOT}/src`]);
  });

  it("lets a link be chosen without opening it", () => {
    const state = folderReducer(opened(), { type: "select", column: 1, entry: { ...entry(`${ROOT}/src/shared`, "link"), outside: true } });
    expect(state.columns).toHaveLength(2);
    expect(viewerEntry(state)?.type).toBe("link");
  });
});

describe("folder view layout rules", () => {
  it("replaces the columns with the viewer below 380 plus two columns", () => {
    const threshold = FOLDER_VIEWER_MIN_WIDTH + 2 * FOLDER_COLUMN_WIDTH;
    expect(threshold).toBe(820);
    expect(viewerReplacesColumns(threshold - 1)).toBe(true);
    expect(viewerReplacesColumns(threshold)).toBe(false);
  });

  it("maps the column keys", () => {
    expect(["ArrowUp", "ArrowDown", "ArrowRight", "Enter", "ArrowLeft", " ", "a"].map(folderKeyIntent))
      .toEqual(["up", "down", "open", "open", "back", "preview", null]);
  });

  it("collapses the middle of a deep path into one hidden run", () => {
    const segments = ["checkout-service", "src", "payments", "gateway", "handlers", "webhooks", "retry"];
    expect(collapseMiddle(segments)).toEqual({
      head: ["checkout-service"], hidden: ["src", "payments", "gateway"], tail: ["handlers", "webhooks", "retry"],
    });
    expect(collapseMiddle(["a", "b", "c"])).toEqual({ head: ["a", "b", "c"], hidden: [], tail: [] });
  });

  it("counts columns scrolled fully out on the left", () => {
    expect(columnsHiddenLeft([220, 440, 660, 880], 450)).toBe(2);
    expect(columnsHiddenLeft([220, 440], 0)).toBe(0);
  });

  it("names paths under the root", () => {
    expect(pathSegments(ROOT, ROOT)).toEqual(["checkout-service"]);
    expect(pathSegments(ROOT, `${ROOT}/src/payments`)).toEqual(["checkout-service", "src", "payments"]);
    expect(relativeToRoot(ROOT, `${ROOT}/data/settlement.sqlite`)).toBe("data/settlement.sqlite");
  });

  it("derives a file kind from the extension with the preview tables", () => {
    expect(["retry-policy.ts", "README.md", "flow.png", "report.pdf", "deck.pptx", "ledger.xlsx", "settlement.sqlite",
      "receipt.psd", "payments.log", "notes.txt", "core.dump"].map(folderFileKind))
      .toEqual(["code", "markdown", "image", "pdf", "page", "table", "database", "design", "log", "text", "unknown"]);
  });
});
