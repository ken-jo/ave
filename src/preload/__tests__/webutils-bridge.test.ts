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

// Resolve real File objects in preload, preserving drop order and excluding empty paths before IPC.
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
    expect(resolveDroppedPaths(files)).toEqual(["/Users/me/real"]);
  });

  it("returns an empty array for an empty drop", () => {
    getPathForFileMock.mockReset();
    expect(resolveDroppedPaths([])).toEqual([]);
    expect(getPathForFileMock).not.toHaveBeenCalled();
  });
});

// Accept File objects only; register OS-backed paths in the same preload step.
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
