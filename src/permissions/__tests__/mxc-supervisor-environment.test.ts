import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MxcCapabilityUnavailableError } from "../mxc-extension-errors.js";
import { mxcSupervisorEnvironment } from "../mxc-extension-process.js";

describe("native extension supervisor environment", () => {
  it("drops loader overrides, resolves OS tools first and keeps runtime state under the given directory", () => {
    const root = mkdtempSync(join(tmpdir(), "ave-mxc-supervisor-env-"));
    const state = join(root, "supervisor-state");
    try {
      const env = mxcSupervisorEnvironment({
        SystemRoot: "C:\\Windows",
        Path: "C:\\Tools\\usr\\bin;C:\\Windows\\System32",
        LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local",
        MXC_FFI_DIR: "C:\\planted",
        mxc_bin_dir: "C:\\planted",
        NODE_OPTIONS: "--require planted",
        node_path: "C:\\planted",
        USERPROFILE: "C:\\Users\\alice",
      }, state);
      expect(Object.keys(env).filter((key) => /^(MXC_|NODE_OPTIONS$|NODE_PATH$)/i.test(key))).toEqual([]);
      expect(Object.keys(env).filter((key) => key.toUpperCase() === "PATH")).toEqual(["PATH"]);
      expect(env.PATH?.split(";").slice(0, 3)).toEqual(["C:\\Windows\\System32", "C:\\Windows", "C:\\Tools\\usr\\bin"]);
      expect(Object.keys(env).filter((key) => key.toUpperCase() === "LOCALAPPDATA")).toEqual(["LOCALAPPDATA"]);
      expect(env.LOCALAPPDATA).toBe(state);
      expect(existsSync(state)).toBe(true);
      expect(env.ELECTRON_RUN_AS_NODE).toBe("1");
      expect(env.USERPROFILE).toBe("C:\\Users\\alice");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses to start without the Windows directory", () => {
    const state = join(tmpdir(), "ave-mxc-supervisor-env-unused");
    expect(() => mxcSupervisorEnvironment({ PATH: "C:\\Tools" }, state)).toThrow(MxcCapabilityUnavailableError);
    expect(existsSync(state)).toBe(false);
  });
});
