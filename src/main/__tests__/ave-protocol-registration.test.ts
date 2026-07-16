import { describe, expect, it, vi } from "vitest";
import {
  getPackagedWindowsProtocolMarkerState,
  AVE_NSIS_PER_MACHINE_MARKER_FILENAME,
  type LstatSync,
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
