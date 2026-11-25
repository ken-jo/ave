import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ execFile: vi.fn(), mkdtemp: vi.fn(), refusal: undefined as Error | undefined }));
vi.mock("node:child_process", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:child_process")>(), execFile: h.execFile,
}));
vi.mock("node:fs/promises", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:fs/promises")>(), mkdtemp: h.mkdtemp,
}));
vi.mock("../mxc-runtime-root.js", async (importOriginal) => ({
  ...await importOriginal<typeof import("../mxc-runtime-root.js")>(),
  requireMxcContainerStartRoot: () => { throw h.refusal; },
}));

import { probeHostMxcPowerShellStart } from "../mxc-windows.js";
import { MxcRuntimeRootError } from "../mxc-runtime-root.js";

describe("the host PowerShell start probe", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("reports a runtime root that was not proved under its own reason, starting no container and creating no probe directory", async () => {
    h.refusal = new MxcRuntimeRootError("Container runtime root was not established when the sandbox started");
    expect(await probeHostMxcPowerShellStart()).toEqual({ state: "unavailable", reason: "runtime-root-unproved", windowsBuild: null,
      detail: "runtime root proof failed: Container runtime root was not established when the sandbox started" });
    expect(h.mkdtemp).not.toHaveBeenCalled();
    expect(h.execFile).not.toHaveBeenCalled();
  });

  it("lets any other failure through to the probe's own handling", async () => {
    h.refusal = new Error("unexpected");
    await expect(probeHostMxcPowerShellStart()).rejects.toThrow("unexpected");
    expect(h.execFile).not.toHaveBeenCalled();
  });
});
