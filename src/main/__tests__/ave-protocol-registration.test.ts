import { describe, expect, it, vi } from "vitest";
import {
  ensurePackagedWindowsAveProtocolClient,
  isSameWindowsExecutablePath,
  shouldDeferPackagedWindowsProtocolRegistration,
} from "../ave-protocol-registration.js";

const CURRENT_EXE = "C:\\Program Files\\Ave\\Ave.exe";

describe("packaged Windows ave protocol registration", () => {
  it("defers only packaged Windows registration", () => {
    expect(shouldDeferPackagedWindowsProtocolRegistration(true, "win32")).toBe(
      true,
    );
    expect(shouldDeferPackagedWindowsProtocolRegistration(false, "win32")).toBe(
      false,
    );
    expect(shouldDeferPackagedWindowsProtocolRegistration(true, "darwin")).toBe(
      false,
    );
    expect(shouldDeferPackagedWindowsProtocolRegistration(true, "linux")).toBe(
      false,
    );
  });

  it("compares normalized absolute Windows executable paths", () => {
    expect(
      isSameWindowsExecutablePath(
        "c:/PROGRAM FILES/Ave/./Ave.exe",
        CURRENT_EXE,
      ),
    ).toBe(true);
    expect(
      isSameWindowsExecutablePath(
        "\\\\?\\C:\\Program Files\\Ave\\Ave.exe",
        CURRENT_EXE,
      ),
    ).toBe(true);
    expect(isSameWindowsExecutablePath("Ave.exe", CURRENT_EXE)).toBe(false);
    expect(isSameWindowsExecutablePath(" " + CURRENT_EXE, CURRENT_EXE)).toBe(
      false,
    );
    expect(isSameWindowsExecutablePath(null, CURRENT_EXE)).toBe(false);
    expect(
      isSameWindowsExecutablePath("\\\\server\\share\\Ave.exe", CURRENT_EXE),
    ).toBe(false);
    expect(
      isSameWindowsExecutablePath(
        "\\\\?\\UNC\\server\\share\\Ave.exe",
        CURRENT_EXE,
      ),
    ).toBe(false);
    expect(
      isSameWindowsExecutablePath(
        "\\\\.\\C:\\Program Files\\Ave\\Ave.exe",
        CURRENT_EXE,
      ),
    ).toBe(false);
  });

  it("does not create an HKCU registration when HKCR resolves to this executable", async () => {
    const getApplicationInfoForProtocol = vi
      .fn()
      .mockResolvedValue({ path: "c:/PROGRAM FILES/Ave/Ave.exe" });
    const setAsDefaultProtocolClient = vi.fn(() => true);

    await expect(
      ensurePackagedWindowsAveProtocolClient(
        { getApplicationInfoForProtocol, setAsDefaultProtocolClient },
        CURRENT_EXE,
      ),
    ).resolves.toBe(true);

    expect(getApplicationInfoForProtocol).toHaveBeenCalledWith("ave://");
    expect(setAsDefaultProtocolClient).not.toHaveBeenCalled();
  });

  it.each([
    ["missing path", {}],
    ["malformed relative path", { path: "Ave.exe" }],
    ["mismatched executable", { path: "C:\\Other\\Ave.exe" }],
  ])("falls back to Electron for %s", async (_name, application) => {
    const setAsDefaultProtocolClient = vi.fn(() => true);

    await expect(
      ensurePackagedWindowsAveProtocolClient(
        {
          getApplicationInfoForProtocol: vi.fn().mockResolvedValue(application),
          setAsDefaultProtocolClient,
        },
        CURRENT_EXE,
      ),
    ).resolves.toBe(true);

    expect(setAsDefaultProtocolClient).toHaveBeenCalledOnce();
    expect(setAsDefaultProtocolClient).toHaveBeenCalledWith("ave");
  });

  it("falls back when the Windows association lookup rejects", async () => {
    const setAsDefaultProtocolClient = vi.fn(() => true);

    await expect(
      ensurePackagedWindowsAveProtocolClient(
        {
          getApplicationInfoForProtocol: vi
            .fn()
            .mockRejectedValue(new Error("missing")),
          setAsDefaultProtocolClient,
        },
        CURRENT_EXE,
      ),
    ).resolves.toBe(true);

    expect(setAsDefaultProtocolClient).toHaveBeenCalledOnce();
  });

  it("soft-fails when Electron's setter throws", async () => {
    const setAsDefaultProtocolClient = vi.fn(() => {
      throw new Error("registry denied");
    });

    await expect(
      ensurePackagedWindowsAveProtocolClient(
        {
          getApplicationInfoForProtocol: vi.fn().mockResolvedValue(null),
          setAsDefaultProtocolClient,
        },
        CURRENT_EXE,
      ),
    ).resolves.toBe(false);

    expect(setAsDefaultProtocolClient).toHaveBeenCalledOnce();
  });

  it("propagates Electron's registration failure result", async () => {
    await expect(
      ensurePackagedWindowsAveProtocolClient(
        {
          getApplicationInfoForProtocol: vi.fn().mockResolvedValue(null),
          setAsDefaultProtocolClient: vi.fn(() => false),
        },
        CURRENT_EXE,
      ),
    ).resolves.toBe(false);
  });
});
