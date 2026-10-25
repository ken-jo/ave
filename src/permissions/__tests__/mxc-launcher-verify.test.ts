import { afterEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  resourcePath: String.raw`C:\Program Files\Ave\resources`,
  readFile: vi.fn(async (_path: string) => Buffer.from("not the launcher")),
}));

vi.mock("../../main/host-resources.js", () => ({
  getHostResources: () => ({ resourcePath: h.resourcePath }),
}));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs/promises")>()),
  readFile: h.readFile,
}));

import { resolveHostWxcExecPath } from "../mxc-windows.js";

afterEach(() => {
  h.readFile.mockClear();
});

describe.runIf(process.arch === "x64" || process.arch === "arm64")("resolveHostWxcExecPath", () => {
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
