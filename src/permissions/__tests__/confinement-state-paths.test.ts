import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { assertWriteGrantsOutsideConfinementState, declaredConfinementStatePaths } from "../confinement-state-paths.js";
import { mxcConfinementStatePaths } from "../mxc-runtime-root.js";
import { srtWinConfinementStatePaths } from "../srt-win-integrity.js";
import { getLocale, setLocale } from "../../i18n/runtime.js";

// Paths that resolve to a given identity, on any host: a drive letter can map to a network share.
const resolvesTo = vi.hoisted(() => new Map<string, string>());
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof import("node:fs")>();
  const native = (path: string, ...rest: unknown[]) =>
    resolvesTo.get(String(path).toLowerCase()) ?? (actual.realpathSync.native as (...args: unknown[]) => string)(path, ...rest);
  return { ...actual, realpathSync: Object.assign((...args: Parameters<typeof actual.realpathSync>) => actual.realpathSync(...args), { native }) };
});
vi.mock("../srt-win-integrity.js", async (original) => {
  const actual = await original<typeof import("../srt-win-integrity.js")>();
  return { ...actual, srtWinConfinementStatePaths: vi.fn(actual.srtWinConfinementStatePaths) };
});
vi.mock("../mxc-runtime-root.js", async (original) => {
  const actual = await original<typeof import("../mxc-runtime-root.js")>();
  return { ...actual, mxcConfinementStatePaths: vi.fn(actual.mxcConfinementStatePaths) };
});

const missingDrive = (): string => {
  const letter = [..."ZYXWVUTSRQPONMLKJIHGFE"].find((candidate) => !existsSync(`${candidate}:\\`));
  if (letter === undefined) throw new Error("every drive letter is mapped");
  return `${letter}:\\`;
};

describe("a host with no declared confinement state", () => {
  it("admits any write, drive path or not, without resolving it", () => {
    expect(() => assertWriteGrantsOutsideConfinementState(["/home/alice/project", "relative"], [])).not.toThrow();
  });

  it.each(["darwin", "linux"] as const)("declares nothing on %s without looking up either backend's state", (platform) => {
    const real = process.platform;
    vi.mocked(srtWinConfinementStatePaths).mockClear();
    vi.mocked(mxcConfinementStatePaths).mockClear();
    setProcessPlatform(platform);
    try {
      expect(declaredConfinementStatePaths()).toEqual([]);
    } finally {
      setProcessPlatform(real);
    }
    expect(srtWinConfinementStatePaths).not.toHaveBeenCalled();
    expect(mxcConfinementStatePaths).not.toHaveBeenCalled();
  });
});

describe("a grant's resolved identity", () => {
  const state = [{ path: "C:\\example-state\\sandbox-runtime", stateClass: "helper-ledger" as const }];
  beforeEach(() => resolvesTo.set("c:\\example-state", "C:\\example-state"));
  afterEach(() => resolvesTo.clear());

  const refusedAsUnresolved = (grant: string, states = state): void => {
    expect(() => assertWriteGrantsOutsideConfinementState([grant], states)).toThrow(expect.objectContaining({
      code: "confinement-state-write-grant", path: grant, reason: "grant-unresolved",
    }));
  };

  it("refuses a grant that resolves off any drive, such as a mapped drive's share, and every write when the state does", () => {
    resolvesTo.set("c:\\example-mapped", "\\\\server\\share");
    refusedAsUnresolved("C:\\example-mapped\\work");
    resolvesTo.set("c:\\example-state", "\\\\server\\share\\state");
    expect(() => assertWriteGrantsOutsideConfinementState(["C:\\example-other"], state)).toThrow(expect.objectContaining({ path: undefined }));
  });

  it("reads a forward-slash drive path as the drive path it is", () => {
    expect(() => assertWriteGrantsOutsideConfinementState(["C:/example-state/work"], state)).not.toThrow();
    expect(() => assertWriteGrantsOutsideConfinementState(["C:/example-state/sandbox-runtime/x"], state)).toThrow(expect.objectContaining({ reason: "helper-ledger" }));
  });

  it.each(["sandbox-runtime.", "sandbox-runtime ", "work\\new.", "work\\file::$DATA", "work:stream"])(
    "refuses a missing component Windows would open under another name: %s", (tail) => {
      refusedAsUnresolved(`C:\\example-state\\${tail}`);
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

  it("refuses another case spelling and the short name of an existing state folder", (context) => {
    const local = join(base, "Local");
    const helper = join(local, "sandbox-runtime");
    mkdirSync(helper, { recursive: true });
    const state = declaredConfinementStatePaths(srtWinConfinementStatePaths({ LOCALAPPDATA: local, ProgramData: join(base, "Machine") }, base), []);
    const refused = (grant: string) => expect(() => assertWriteGrantsOutsideConfinementState([grant], state), grant)
      .toThrow(expect.objectContaining({ path: grant, reason: "helper-ledger" }));
    refused(join(helper.toUpperCase(), "x"));
    const listing = execFileSync("cmd.exe", ["/d", "/c", "dir", "/x", "/a:d", local], { encoding: "utf8", windowsHide: true });
    const short = /(\S+~\d+)\s+sandbox-runtime\s*$/mu.exec(listing)?.[1];
    if (short === undefined) return context.skip("short names are off on this volume");
    refused(join(local, short, "x"));
  });

  it("passes the holder's own staging root and refuses anything inside it", () => {
    const root = String(mxcConfinementStatePaths()[0]);
    const staging = join(root, "staging", "0".repeat(32));
    const state = declaredConfinementStatePaths([], [root]);
    expect(() => assertWriteGrantsOutsideConfinementState([staging], state, staging)).not.toThrow();
    for (const grant of [join(staging, "home"), join(staging, "temp", "x")]) {
      expect(() => assertWriteGrantsOutsideConfinementState([grant], state, staging), grant)
        .toThrow(expect.objectContaining({ path: grant, reason: "container-runtime" }));
    }
  });
});
