import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertWriteGrantsOutsideConfinementState, declaredConfinementStatePaths } from "../confinement-state-paths.js";
import { mxcConfinementStatePaths } from "../mxc-runtime-root.js";
import { srtWinConfinementStatePaths } from "../srt-win-integrity.js";

const missingDrive = (): string => {
  const letter = [..."ZYXWVUTSRQPONMLKJIHGFE"].find((candidate) => !existsSync(`${candidate}:\\`));
  if (letter === undefined) throw new Error("every drive letter is mapped");
  return `${letter}:\\`;
};

describe.runIf(process.platform === "win32")("write admission resolves the declared state strictly", () => {
  let base: string;
  let unrelated: string;
  const inheritedBase = process.env.AVE_TEST_SANDBOX_BASE;

  beforeEach(() => {
    base = realpathSync.native(mkdtempSync(join(tmpdir(), "ave-state-strict-")));
    unrelated = join(base, "work");
    mkdirSync(unrelated);
    process.env.AVE_TEST_SANDBOX_BASE = base;
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    if (inheritedBase === undefined) delete process.env.AVE_TEST_SANDBOX_BASE;
    else process.env.AVE_TEST_SANDBOX_BASE = inheritedBase;
    rmSync(base, { recursive: true, force: true });
  });

  const refusesUnresolved = (write: string[], statePaths: readonly string[] | undefined): void => {
    expect(() => assertWriteGrantsOutsideConfinementState(write, statePaths)).toThrow(expect.objectContaining({
      code: "confinement-state-write-grant", path: undefined,
    }));
  };

  it.each([
    ["the per-user helper state on an unmapped drive", () => ({ LOCALAPPDATA: `${missingDrive()}Local`, ProgramData: base })],
    ["the machine helper store on an unmapped drive", () => ({ LOCALAPPDATA: base, ProgramData: `${missingDrive()}Machine` })],
  ])("refuses an unrelated write when %s cannot be resolved, and allows no read-side change", (_name, env) => {
    refusesUnresolved([unrelated], srtWinConfinementStatePaths(env(), base));
    expect(() => assertWriteGrantsOutsideConfinementState([], srtWinConfinementStatePaths(env(), base))).not.toThrow();
  });

  it("refuses an unrelated write when the container runtime root's cache directory cannot be resolved", () => {
    process.env.AVE_TEST_SANDBOX_BASE = `${missingDrive()}cache`;
    refusesUnresolved([unrelated], mxcConfinementStatePaths());
  });

  it("refuses an unrelated write before a backend is chosen when one backend's state cannot be located", () => {
    vi.stubEnv("LOCALAPPDATA", "");
    refusesUnresolved([unrelated], declaredConfinementStatePaths());
  });

  it("keeps a missing state leaf under a proved ancestor and refuses a write at it or above it", () => {
    const state = mxcConfinementStatePaths();
    expect(existsSync(state[0]!)).toBe(false);
    for (const grant of [state[0]!, join(state[0]!, "runs"), base]) {
      expect(() => assertWriteGrantsOutsideConfinementState([grant], state)).toThrow(expect.objectContaining({ path: grant }));
    }
    expect(() => assertWriteGrantsOutsideConfinementState([unrelated], state)).not.toThrow();
  });
});
