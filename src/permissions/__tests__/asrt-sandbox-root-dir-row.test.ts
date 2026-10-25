import { afterEach, describe, expect, it, vi } from "vitest";

// A POSIX-rooted directory row. The shipped table has none today; this proves
// a future one keeps its exact spelling, so the Windows boundary still drops it.
const ROOT_DIR_SEGMENTS = vi.hoisted(() => ["etc", "ave-root-dir-probe"] as const);
const ROOT_DIR_ROW = "/" + ROOT_DIR_SEGMENTS.join("/");

vi.mock("../sensitive-paths.js", async (importOriginal) => {
  const original = await importOriginal<typeof import("../sensitive-paths.js")>();
  return {
    ...original,
    SENSITIVE_PATH_ENTRIES: Object.freeze([
      ...original.SENSITIVE_PATH_ENTRIES,
      { anchor: "root", segments: ROOT_DIR_SEGMENTS, kind: "dir", why: "root directory row probe" },
    ]),
  };
});

import { buildSandboxConfig, getDefaultSensitiveReadDenyPaths } from "../asrt-sandbox.js";
import { setProcessPlatform } from "../../__tests__/support/process-platform.js";
import { useVerifiedAveHomePrivacy } from "../../__tests__/support/ave-home-privacy.js";

useVerifiedAveHomePrivacy();

const ORIGINAL_PLATFORM = process.platform;

afterEach(() => {
  setProcessPlatform(ORIGINAL_PLATFORM);
});

describe("asrt-sandbox — POSIX-rooted directory rows on Windows", () => {
  it("keeps the row's exact spelling in the floor", () => {
    setProcessPlatform("win32");
    const floor = getDefaultSensitiveReadDenyPaths();
    expect(floor).toContain(ROOT_DIR_ROW);
    expect(floor.filter((path) => path.startsWith(ROOT_DIR_ROW))).toEqual([ROOT_DIR_ROW]);
  });

  it("never hands the row to srt-win", () => {
    setProcessPlatform("win32");
    const config = buildSandboxConfig({ allowedDomains: [], strictAllowlist: true });
    const denies = [...config.filesystem.denyRead, ...config.filesystem.denyWrite].map(String);
    expect(denies.filter((path) => path.startsWith(ROOT_DIR_ROW))).toEqual([]);
  });

  it("keeps the row on the platforms that have it", () => {
    setProcessPlatform("linux");
    expect(buildSandboxConfig({ allowedDomains: [], strictAllowlist: true }).filesystem.denyRead.map(String))
      .toContain(ROOT_DIR_ROW);
  });
});
