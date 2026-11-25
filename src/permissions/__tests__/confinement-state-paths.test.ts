import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertWriteGrantsOutsideConfinementState, declaredConfinementStatePaths } from "../confinement-state-paths.js";
import { mxcConfinementStatePaths } from "../mxc-runtime-root.js";
import { srtWinConfinementStatePaths } from "../srt-win-integrity.js";
import { getLocale, setLocale } from "../../i18n/runtime.js";

const missingDrive = (): string => {
  const letter = [..."ZYXWVUTSRQPONMLKJIHGFE"].find((candidate) => !existsSync(`${candidate}:\\`));
  if (letter === undefined) throw new Error("every drive letter is mapped");
  return `${letter}:\\`;
};

describe("a host with no declared confinement state", () => {
  it("admits any write, drive path or not, without resolving it", () => {
    expect(() => assertWriteGrantsOutsideConfinementState(["/home/alice/project", "relative"], [])).not.toThrow();
  });
});

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

  const refusesUnresolved = (write: string[], statePaths: ReturnType<typeof declaredConfinementStatePaths>): void => {
    expect(() => assertWriteGrantsOutsideConfinementState(write, statePaths)).toThrow(expect.objectContaining({
      code: "confinement-state-write-grant", path: undefined,
    }));
  };

  it.each([
    ["the per-user helper state on an unmapped drive", () => ({ LOCALAPPDATA: `${missingDrive()}Local`, ProgramData: base })],
    ["the machine helper store on an unmapped drive", () => ({ LOCALAPPDATA: base, ProgramData: `${missingDrive()}Machine` })],
  ])("refuses an unrelated write when %s cannot be resolved, and allows no read-side change", (_name, env) => {
    refusesUnresolved([unrelated], declaredConfinementStatePaths(srtWinConfinementStatePaths(env(), base)));
    expect(() => assertWriteGrantsOutsideConfinementState([], declaredConfinementStatePaths(srtWinConfinementStatePaths(env(), base)))).not.toThrow();
  });

  it("refuses an unrelated write when the container runtime root's cache directory cannot be resolved", () => {
    process.env.AVE_TEST_SANDBOX_BASE = `${missingDrive()}cache`;
    refusesUnresolved([unrelated], declaredConfinementStatePaths([], mxcConfinementStatePaths()));
  });

  it("refuses an unrelated write before a backend is chosen when one backend's state cannot be located", () => {
    vi.stubEnv("LOCALAPPDATA", "");
    refusesUnresolved([unrelated], declaredConfinementStatePaths());
  });

  it("keeps a missing state leaf under a proved ancestor and refuses a write at it or above it", () => {
    const root = String(mxcConfinementStatePaths()[0]);
    const state = declaredConfinementStatePaths([], [root]);
    expect(existsSync(root)).toBe(false);
    for (const grant of [root, join(root, "runs"), base]) {
      expect(() => assertWriteGrantsOutsideConfinementState([grant], state)).toThrow(expect.objectContaining({ path: grant }));
    }
    expect(() => assertWriteGrantsOutsideConfinementState([unrelated], state)).not.toThrow();
  });

  it("checks every backend's declared state and names the kind of state a refused write reaches", () => {
    const local = join(base, "Local");
    vi.stubEnv("LOCALAPPDATA", local);
    vi.stubEnv("ProgramData", join(base, "Machine"));
    const helper = join(local, "sandbox-runtime");
    const container = String(mxcConfinementStatePaths()[0]);
    const previous = getLocale();
    setLocale("en");
    try {
      for (const [grant, reason, named] of [
        [helper, "helper-ledger", "the sandbox helper's permission records"],
        [join(container, "runs"), "container-runtime", "the container sandbox's runtime folder"],
      ] as const) {
        expect(() => assertWriteGrantsOutsideConfinementState([grant], declaredConfinementStatePaths())).toThrow(expect.objectContaining({
          code: "confinement-state-write-grant", path: grant, reason, message: expect.stringContaining(named),
        }));
      }
    } finally {
      setLocale(previous);
    }
    expect(() => assertWriteGrantsOutsideConfinementState([unrelated], declaredConfinementStatePaths())).not.toThrow();
  });
});
