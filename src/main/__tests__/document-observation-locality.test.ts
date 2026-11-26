import { EventEmitter } from "node:events";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { session, type IpcMainInvokeEvent } from "electron";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import type { PreviewTableDocument } from "../../shared/preview-document.js";
import { withLocalityDecision } from "../../shared/local-path-io.js";
import { setWindowsDriveQueryForTest } from "../../shared/windows-drive-locality.js";
import { configureHostResources } from "../host-resources.js";

vi.unmock("../../shared/windows-drive-locality.js");
const state = vi.hoisted(() => ({ holder: null as unknown, root: "" }));
vi.mock("electron", () => ({ session: { defaultSession: {} } }));
vi.mock("../app-state.js", () => ({ findSessionMainWindowContents: (id: string) => id === "session-one" ? state.holder : null }));
vi.mock("../../permissions/permission-settings-store.js", () => ({
  readPermissionSettings: () => ({ permissions: { additionalDirectories: [state.root] } }),
}));
import { DocumentObservationRuntime } from "../document-observation.js";

const LOCAL_DRIVE = String.raw`\Device\HarddiskVolume1`;

function table(value: string): PreviewTableDocument {
  return { format: "csv", needsRecalculation: false, sheetNames: ["Sheet1"], totalSheets: 1, sheetsTruncated: false,
    sheet: { index: 0, name: "Sheet1", rows: [[value]], firstRow: 0, firstColumn: 0, totalRows: 1, totalColumns: 1,
      rowsTruncated: false, columnsTruncated: false, cellsTruncated: false, clippedCells: [] } };
}

describe.runIf(process.platform === "win32")("document observation readability per judgment", () => {
  const query = vi.fn<(drive: string) => string | null>();
  let runtime: DocumentObservationRuntime;
  let path: string;
  let event: IpcMainInvokeEvent;

  beforeAll(() => configureHostResources({ resourcePath: resolve("resources"), isPackaged: false }));

  beforeEach(() => {
    state.root = realpathSync.native(mkdtempSync(join(tmpdir(), "ave-observation-locality-")));
    path = join(state.root, "values.csv");
    writeFileSync(path, "old");
    const frame = { url: "file:///app/index.html", detached: false, isDestroyed: () => false };
    const sender = Object.assign(new EventEmitter(), { id: 1, mainFrame: frame, isDestroyed: () => false,
      getType: () => "window", session: session.defaultSession, send: vi.fn() });
    event = { sender, senderFrame: frame } as unknown as IpcMainInvokeEvent;
    state.holder = sender;
    query.mockReset().mockReturnValue(LOCAL_DRIVE);
    setWindowsDriveQueryForTest(query);
    const deps = { getAppWindows: () => [{ isDestroyed: () => false, webContents: sender }], getMainWindow: () => null } as never;
    runtime = new DocumentObservationRuntime(deps, { id: "table-reader", parse: async (bytes) => table(bytes.toString("utf8")) });
  });

  afterEach(async () => {
    runtime.dispose();
    setWindowsDriveQueryForTest();
    await cleanupTmpDir(state.root);
  });

  const register = () => runtime.registerView(event, "session-one", path, Buffer.from("old"), table("old"));

  it("asks the drive again for a later judgment in the same run and refuses on its failed query", () => {
    expect(register()).toBeDefined();
    const queries = query.mock.calls.length;
    query.mockImplementation(() => { throw new Error("drive query failed"); });
    expect(register()).toBeUndefined();
    expect(query.mock.calls.length).toBeGreaterThan(queries);
  });

  it("fails an enclosing judgment whose drive query failed", () => {
    query.mockImplementation(() => { throw new Error("drive query failed"); });
    expect(() => withLocalityDecision(() => register())).toThrow("drive query failed");
  });
});
