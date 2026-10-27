import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { detectHostMxcPrerequisites, probeHostMxcPowerShellStart } from "../../permissions/mxc-windows.js";
import { requireMxcCapability } from "./mxc-capability.js";

vi.mock("../../permissions/mxc-windows.js", () => ({
  detectHostMxcPrerequisites: vi.fn(),
  probeHostMxcPowerShellStart: vi.fn(),
}));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(detectHostMxcPrerequisites).mockResolvedValue({ state: "available", windowsBuild: "10.0.26100" });
  vi.mocked(probeHostMxcPowerShellStart).mockResolvedValue({ state: "available", windowsBuild: "10.0.26100" });
});
afterEach(() => { vi.restoreAllMocks(); });

describe("requireMxcCapability", () => {
  it("skips a recognized unsupported tier with its actual reason in the log", async () => {
    vi.mocked(detectHostMxcPrerequisites).mockResolvedValue({ state: "unavailable", windowsBuild: "10.0.26100",
      reason: "tier-unsupported", detail: "tier appcontainer-dacl" });
    const logged = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const skipped = new Error("test skipped");
    const skip = vi.fn((): never => { throw skipped; });
    await expect(requireMxcCapability(skip)).rejects.toBe(skipped);
    expect(skip).toHaveBeenCalledExactlyOnceWith("Native container prerequisite: tier-unsupported: tier appcontainer-dacl");
    expect(logged).toHaveBeenCalledExactlyOnceWith("Native container prerequisite: tier-unsupported: tier appcontainer-dacl");
    expect(probeHostMxcPowerShellStart).not.toHaveBeenCalled();
  });

  it.each([
    ["launcher-mismatch", "launcher hash mismatch"],
    ["probe-failed", "--probe exit 1"],
    ["probe-failed", "tier appcontainer-dacl"],
    ["tier-unsupported", "tier unknown"],
    ["tier-unsupported", "tier future-container"],
    ["request-rejected", "validation rejected"],
    ["binary-missing", "missing launcher"],
  ] as const)("fails for prerequisite %s (%s)", async (reason, detail) => {
    vi.mocked(detectHostMxcPrerequisites).mockResolvedValue({ state: "unavailable", windowsBuild: "10.0.26100", reason, detail });
    const skip = vi.fn((): never => { throw new Error("Unexpected capability skip"); });
    await expect(requireMxcCapability(skip)).rejects.toThrow(`Native container prerequisite: ${reason}: ${detail}`);
    expect(skip).not.toHaveBeenCalled();
    expect(probeHostMxcPowerShellStart).not.toHaveBeenCalled();
  });

  it.each(["powershell-start-failed", "unverified-session"] as const)("fails for native execution %s on an eligible host", async (reason) => {
    vi.mocked(probeHostMxcPowerShellStart).mockResolvedValue({ state: "unavailable", windowsBuild: "10.0.26100", reason, detail: "exit 1" });
    const skip = vi.fn((): never => { throw new Error("Unexpected capability skip"); });
    await expect(requireMxcCapability(skip)).rejects.toThrow(`Native container start: ${reason}: exit 1`);
    expect(skip).not.toHaveBeenCalled();
    expect(probeHostMxcPowerShellStart).toHaveBeenCalledOnce();
  });

  it("propagates thrown probe errors", async () => {
    const error = new Error("broken probe");
    vi.mocked(detectHostMxcPrerequisites).mockRejectedValue(error);
    const skip = vi.fn((): never => { throw new Error("Unexpected capability skip"); });
    await expect(requireMxcCapability(skip)).rejects.toBe(error);
    expect(skip).not.toHaveBeenCalled();
  });

  it("propagates thrown native execution errors on an eligible host", async () => {
    const error = new Error("native launch failed");
    vi.mocked(probeHostMxcPowerShellStart).mockRejectedValue(error);
    const skip = vi.fn((): never => { throw new Error("Unexpected capability skip"); });
    await expect(requireMxcCapability(skip)).rejects.toBe(error);
    expect(skip).not.toHaveBeenCalled();
  });

  it("requires successful native startup on an eligible host", async () => {
    const skip = vi.fn((): never => { throw new Error("Unexpected capability skip"); });
    await expect(requireMxcCapability(skip)).resolves.toEqual({ state: "available", windowsBuild: "10.0.26100" });
    expect(probeHostMxcPowerShellStart).toHaveBeenCalledOnce();
    expect(skip).not.toHaveBeenCalled();
  });
});
