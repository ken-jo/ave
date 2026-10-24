import { describe, expect, it, vi } from "vitest";
import {
  decideAveProtocolClientRegistration,
  getPackagedWindowsProtocolMarkerState,
  AVE_NSIS_PER_MACHINE_MARKER_FILENAME,
  type AveProtocolClientRegistrationInput,
  type LstatSync,
  type PackagedWindowsProtocolMarkerState,
} from "../ave-protocol-registration.js";

const CURRENT_EXE = "C:\\Program Files\\Ave\\Ave.exe";
const MARKER_PATH =
  "C:\\Program Files\\Ave\\.ave-nsis-per-machine-v1";

function lstatStub(
  implementation: (...args: Parameters<LstatSync>) => unknown,
): LstatSync {
  return vi.fn(implementation) as unknown as LstatSync;
}

describe("packaged Windows ave protocol marker", () => {
  it("uses a fixed versioned marker filename", () => {
    expect(AVE_NSIS_PER_MACHINE_MARKER_FILENAME).toBe(
      ".ave-nsis-per-machine-v1",
    );
  });

  it("treats only an adjacent regular file as a per-machine marker", () => {
    const inspectMarker = lstatStub(() => ({ isFile: () => true }));

    expect(
      getPackagedWindowsProtocolMarkerState(CURRENT_EXE, inspectMarker),
    ).toBe("present");
    expect(inspectMarker).toHaveBeenCalledWith(MARKER_PATH, {
      throwIfNoEntry: false,
    });
  });

  it.each([
    ["missing marker", undefined],
    ["directory marker", { isFile: () => false }],
    ["non-file marker", { isFile: () => false }],
  ])("treats %s as absent", (_name, result) => {
    const inspectMarker = lstatStub(() => result);

    expect(
      getPackagedWindowsProtocolMarkerState(CURRENT_EXE, inspectMarker),
    ).toBe("absent");
  });

  it("normalizes a local drive-root path before inspecting the marker", () => {
    const inspectMarker = lstatStub(() => undefined);

    expect(
      getPackagedWindowsProtocolMarkerState(
        "c:/Program Files/Ave/./Ave.exe",
        inspectMarker,
      ),
    ).toBe("absent");
    expect(inspectMarker).toHaveBeenCalledWith(
      "c:\\Program Files\\Ave\\.ave-nsis-per-machine-v1",
      { throwIfNoEntry: false },
    );
  });

  it("returns unknown when lstat fails unexpectedly", () => {
    const inspectMarker = lstatStub(() => {
      throw new Error("access denied");
    });

    expect(
      getPackagedWindowsProtocolMarkerState(CURRENT_EXE, inspectMarker),
    ).toBe("unknown");
  });

  it.each([
    ["relative", "Ave.exe"],
    ["drive-relative", "C:Ave.exe"],
    ["whitespace", " " + CURRENT_EXE],
    ["UNC", "\\\\server\\share\\Ave.exe"],
    ["extended UNC", "\\\\?\\UNC\\server\\share\\Ave.exe"],
    ["extended device", "\\\\?\\C:\\Program Files\\Ave\\Ave.exe"],
    ["device", "\\\\.\\C:\\Program Files\\Ave\\Ave.exe"],
    ["NUL", CURRENT_EXE + "\0suffix"],
    ["non-string", null],
  ])("never touches the filesystem for a %s path", (_name, executable) => {
    const inspectMarker = lstatStub(() => ({ isFile: () => true }));

    expect(
      getPackagedWindowsProtocolMarkerState(executable, inspectMarker),
    ).toBe("unknown");
    expect(inspectMarker).not.toHaveBeenCalled();
  });
});

describe("decideAveProtocolClientRegistration", () => {
  const POSIX_HOME = "/Users/example/.ave";
  const WINDOWS_HOME = "C:\\Users\\example\\.ave";

  function input(
    overrides: Partial<AveProtocolClientRegistrationInput> = {},
  ): AveProtocolClientRegistrationInput {
    return {
      isPackaged: true,
      platform: "darwin",
      env: {},
      defaultAveHome: POSIX_HOME,
      hasUserDataDirSwitch: false,
      probeWindowsMarker: () => {
        throw new Error("marker probed off Windows");
      },
      ...overrides,
    };
  }

  function windowsInput(
    marker: PackagedWindowsProtocolMarkerState,
    overrides: Partial<AveProtocolClientRegistrationInput> = {},
  ): AveProtocolClientRegistrationInput {
    return input({
      platform: "win32",
      defaultAveHome: WINDOWS_HOME,
      probeWindowsMarker: () => marker,
      ...overrides,
    });
  }

  it.each(["darwin", "linux"] as const)(
    "registers a packaged app on its real profile (%s)",
    (platform) => {
      expect(decideAveProtocolClientRegistration(input({ platform }))).toEqual({ register: true });
    },
  );

  it("registers a packaged Windows app with no per-machine marker on its real profile", () => {
    expect(decideAveProtocolClientRegistration(windowsInput("absent"))).toEqual({ register: true });
  });

  it("treats AVE_HOME naming the real home as the real profile", () => {
    expect(
      decideAveProtocolClientRegistration(input({ env: { AVE_HOME: `${POSIX_HOME}/` } })),
    ).toEqual({ register: true });
    expect(
      decideAveProtocolClientRegistration(
        windowsInput("absent", { env: { AVE_HOME: "c:\\users\\EXAMPLE\\.ave" } }),
      ),
    ).toEqual({ register: true });
  });

  it("skips an unpackaged launch even on the real profile, without probing the marker", () => {
    const probeWindowsMarker = vi.fn((): PackagedWindowsProtocolMarkerState => "absent");
    expect(
      decideAveProtocolClientRegistration(
        windowsInput("absent", { isPackaged: false, probeWindowsMarker }),
      ),
    ).toEqual({ register: false, reason: "unpackaged" });
    expect(decideAveProtocolClientRegistration(input({ isPackaged: false }))).toEqual({
      register: false,
      reason: "unpackaged",
    });
    expect(probeWindowsMarker).not.toHaveBeenCalled();
  });

  it("skips the E2E runtime (AVE_E2E=1 under NODE_ENV=test)", () => {
    expect(
      decideAveProtocolClientRegistration(input({ env: { AVE_E2E: "1", NODE_ENV: "test" } })),
    ).toEqual({ register: false, reason: "e2e-runtime" });
  });

  it("does not read AVE_E2E alone as the E2E runtime", () => {
    expect(decideAveProtocolClientRegistration(input({ env: { AVE_E2E: "1" } }))).toEqual({
      register: true,
    });
  });

  it("skips an isolated AVE_HOME", () => {
    expect(
      decideAveProtocolClientRegistration(input({ env: { AVE_HOME: "/tmp/ave-home-9222" } })),
    ).toEqual({ register: false, reason: "isolated-ave-home" });
    expect(
      decideAveProtocolClientRegistration(
        windowsInput("absent", { env: { AVE_HOME: "C:\\Temp\\ave-packaged-home-1" } }),
      ),
    ).toEqual({ register: false, reason: "isolated-ave-home" });
  });

  it("skips an explicit --user-data-dir profile", () => {
    expect(decideAveProtocolClientRegistration(input({ hasUserDataDirSwitch: true }))).toEqual({
      register: false,
      reason: "isolated-user-data-dir",
    });
    expect(
      decideAveProtocolClientRegistration(windowsInput("absent", { hasUserDataDirSwitch: true })),
    ).toEqual({ register: false, reason: "isolated-user-data-dir" });
  });

  it("leaves the per-machine installer's HKLM association alone", () => {
    expect(decideAveProtocolClientRegistration(windowsInput("present"))).toEqual({
      register: false,
      reason: "nsis-per-machine-install",
    });
  });

  it("fails closed when the per-machine marker cannot be verified", () => {
    expect(decideAveProtocolClientRegistration(windowsInput("unknown"))).toEqual({
      register: false,
      reason: "nsis-marker-unknown",
    });
  });
});
