import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  resourcePath: String.raw`C:\Program Files\Ave\resources`,
  readFile: vi.fn(async (_path: string) => Buffer.from("not the launcher")),
  launcherFile: true,
}));

vi.mock("../../main/host-resources.js", () => ({
  getHostResources: () => ({ resourcePath: h.resourcePath }),
}));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  readFile: h.readFile,
}));
vi.mock("node:fs", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs")>(),
  lstatSync: vi.fn(() => h.launcherFile ? { isFile: () => true } : undefined),
}));

import { requireHostWxcExecFile, resolveHostWxcExecPath } from "../mxc-windows.js";

afterEach(() => {
  h.readFile.mockClear();
  h.launcherFile = true;
});

describe.runIf(process.arch === "x64" || process.arch === "arm64")("resolveHostWxcExecPath", () => {
  it("requires a launcher file at the current installed path on every call", async () => {
    expect(requireHostWxcExecFile()).toBe(`${h.resourcePath}\\mxc\\${process.arch}\\wxc-exec.exe`);
    h.launcherFile = false;
    expect(() => requireHostWxcExecFile()).toThrow("launcher is missing");
    await expect(resolveHostWxcExecPath()).rejects.toThrow("launcher is missing");
    expect(h.readFile).not.toHaveBeenCalled();
  });

  it("fails closed when the shipped launcher is not the pinned build", async () => {
    h.resourcePath = String.raw`C:\Ave-a\resources`;
    await expect(resolveHostWxcExecPath()).rejects.toThrow(/not the pinned build/);
    expect(h.readFile).toHaveBeenCalledWith(`${h.resourcePath}\\mxc\\${process.arch}\\wxc-exec.exe`);
  });

  it("hashes a launcher path once per process and keeps refusing it", async () => {
    h.resourcePath = String.raw`C:\Ave-b\resources`;
    await expect(resolveHostWxcExecPath()).rejects.toThrow(/not the pinned build/);
    await expect(resolveHostWxcExecPath()).rejects.toThrow(/not the pinned build/);
    expect(h.readFile).toHaveBeenCalledTimes(1);
  });
});
