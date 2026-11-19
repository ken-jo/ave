import { describe, expect, it, vi } from "vitest";
import { isolationAssignments, validateJobHomeRoot } from "../../.github/scripts/isolate-job-home.mjs";

describe("job home isolation", () => {
  it("places Windows fixtures on the system volume instead of the runner temp volume", () => {
    const create = vi.fn(() => "C:\\ave-ci-abc123");
    const values = isolationAssignments({ platform: "win32", runnerTemp: "D:\\a\\_temp", systemRoot: "C:\\Windows" }, create);
    expect(create).toHaveBeenCalledWith("C:\\ave-ci-");
    expect(values.HOME).toBe("C:\\ave-ci-abc123\\home");
    expect(values.AVE_TEST_TMP_ROOT).toBe("C:\\ave-ci-abc123\\home\\.ave-test-tmp");
    expect(values.LOCALAPPDATA).toBe("C:\\ave-ci-abc123\\home\\local-app-data");
    expect(values.APPDATA).toBe("C:\\ave-ci-abc123\\home\\app-data");
    expect(values.TEMP).toBe("C:\\ave-ci-abc123\\tmp");
    expect(values.AVE_CI_JOB_ROOT).toBe("C:\\ave-ci-abc123");
  });
  it("leaves room for socket paths before publishing environment changes", () => {
    expect(() => isolationAssignments({ platform: "darwin", runnerTemp: `/${"a".repeat(80)}`, systemRoot: undefined })).toThrow(/socket path/);
  });
  it("keeps non-Windows homes under runner temp", () => {
    const create = vi.fn();
    expect(isolationAssignments({ platform: "linux", runnerTemp: "/runner/temp", systemRoot: undefined }, create)).toEqual({
      HOME: "/runner/temp/home", USERPROFILE: "/runner/temp/home", AVE_HOME: "/runner/temp/home/.ave",
      TMPDIR: "/runner/temp/tmp", TEMP: "/runner/temp/tmp", TMP: "/runner/temp/tmp",
    });
    expect(create).not.toHaveBeenCalled();
  });
  it.each([undefined, "Windows", "\\\\host\\share\\Windows"])("refuses an invalid system directory before creating a root: %s", systemRoot => {
    const create = vi.fn();
    expect(() => isolationAssignments({ platform: "win32", runnerTemp: "D:\\a\\_temp", systemRoot }, create)).toThrow(/local system volume/);
    expect(create).not.toHaveBeenCalled();
  });
  it("accepts only an isolated job directory directly on the system volume for cleanup", () => {
    expect(validateJobHomeRoot("C:\\ave-ci-abc123", "C:\\Windows")).toBe("C:\\ave-ci-abc123");
    for (const root of ["C:\\", "C:\\Users\\alice", "C:\\ave-ci-abc123\\home", "D:\\ave-ci-abc123", "C:\\other", "C:\\ave-ci-abc123\\..\\other"]) {
      expect(() => validateJobHomeRoot(root, "C:\\Windows")).toThrow(/isolated job root/);
    }
  });
});
