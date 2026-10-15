import { describe, expect, it, vi } from "vitest";

const { getPathForFileMock, invokeMock } = vi.hoisted(() => ({
  getPathForFileMock: vi.fn<(file: File) => string>(),
  invokeMock: vi.fn(async (..._args: unknown[]) => ({ ok: true, token: "t", rejected: [] })),
}));

vi.mock("electron", () => ({
  webUtils: { getPathForFile: getPathForFileMock },
  ipcRenderer: { invoke: invokeMock },
}));

import { CHANNELS } from "../../contract/app-contract.js";
import { prepareFileDrop, resolveDroppedPaths } from "../webutils-bridge.js";

// A dropped `File` cannot cross IPC, so `webUtils.getPathForFile` must be called
// here in preload. These tests pin the two invariants the drop trust flow needs:
// (1) real paths flow through in drop order, (2) non-file drags (which resolve to
// "") are dropped so no empty candidate reaches the main-side dropPrepare gate.
describe("resolveDroppedPaths (webUtils preload bridge, #1458)", () => {
  it("resolves dropped files to their real paths in drop order", () => {
    getPathForFileMock.mockReset();
    getPathForFileMock
      .mockReturnValueOnce("/Users/me/project-a")
      .mockReturnValueOnce("/Users/me/project-b");
    const files = [{ name: "a" }, { name: "b" }] as unknown as File[];
    expect(resolveDroppedPaths(files)).toEqual([
      "/Users/me/project-a",
      "/Users/me/project-b",
    ]);
    expect(getPathForFileMock).toHaveBeenCalledTimes(2);
  });

  it("drops entries webUtils cannot resolve (non-file drag → empty string)", () => {
    getPathForFileMock.mockReset();
    getPathForFileMock
      .mockReturnValueOnce("") // text/url drag — no backing file
      .mockReturnValueOnce("/Users/me/real");
    const files = [{ name: "x" }, { name: "y" }] as unknown as File[];
    // The "" candidate is dropped; only the real path survives.
    expect(resolveDroppedPaths(files)).toEqual(["/Users/me/real"]);
  });

  it("returns an empty array for an empty drop", () => {
    getPathForFileMock.mockReset();
    expect(resolveDroppedPaths([])).toEqual([]);
    expect(getPathForFileMock).not.toHaveBeenCalled();
  });
});

// Composer drop: the main world hands over File objects and never a path. Only
// OS-backed files (non-empty getPathForFile) are registered, in one preload step.
describe("prepareFileDrop (composer drop registration)", () => {
  it("registers only the resolved paths with main and returns its answer", async () => {
    getPathForFileMock.mockReset();
    invokeMock.mockClear();
    getPathForFileMock.mockReturnValueOnce("/Users/me/notes.txt").mockReturnValueOnce("");
    const files = [{ name: "notes.txt" }, { name: "synthetic" }] as unknown as File[];
    await expect(prepareFileDrop(files)).resolves.toEqual({ ok: true, token: "t", rejected: [] });
    expect(invokeMock).toHaveBeenCalledWith(CHANNELS.attach.registerDrop, ["/Users/me/notes.txt"]);
  });

  it("sends nothing for a drop with no OS-backed file", async () => {
    getPathForFileMock.mockReset();
    invokeMock.mockClear();
    getPathForFileMock.mockReturnValue("");
    const files = [{ name: "blob" }] as unknown as File[];
    await expect(prepareFileDrop(files)).resolves.toEqual({ ok: false, error: "nothing-attachable" });
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
