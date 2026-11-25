import { describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ execFile: vi.fn(), mkdtemp: vi.fn() }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(), execFile: h.execFile,
}));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>(), mkdtemp: h.mkdtemp,
}));
vi.mock("../mxc-runtime-root.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../mxc-runtime-root.js")>(),
  requireMxcContainerStartRoot: () => { throw new Error("Container runtime root was not established when the sandbox started"); },
}));

import { probeHostMxcPowerShellStart } from "../mxc-windows.js";

describe("the host PowerShell start probe", () => {
  it("starts no container and creates no probe directory while the runtime root is not proved", async () => {
    await expect(probeHostMxcPowerShellStart()).rejects.toThrow(/not established/u);
    expect(h.mkdtemp).not.toHaveBeenCalled();
    expect(h.execFile).not.toHaveBeenCalled();
  });
});
