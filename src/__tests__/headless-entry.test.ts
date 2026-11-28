import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { _resetForTest, getIsPackaged } from "../boot/dev-flags.js";
import { headlessPackagedMarkerPath } from "../../scripts/lib/headless-packaged-marker.mjs";

const savedEnv = { ...process.env };
const savedArgv = [...process.argv];
const savedExitCode = process.exitCode;
let root: string | undefined;

afterEach(() => {
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  process.argv.splice(0, process.argv.length, ...savedArgv);
  process.exitCode = savedExitCode;
  _resetForTest();
  vi.resetModules();
  vi.restoreAllMocks();
  if (root) rmSync(root, { recursive: true, force: true });
  root = undefined;
});

describe("headless direct entry", () => {
  it("normalizes hostile packaged env before the host module imports", async () => {
    root = mkdtempSync(join(tmpdir(), "ave-headless-entry-"));
    writeFileSync(headlessPackagedMarkerPath(root), new Uint8Array());
    process.env.NODE_ENV = "test";
    process.env.VITEST = "1";
    process.env.AVE_DEV = "1";
    process.env.AVE_WHITELIST_OFFLINE = "1";

    const observed: NodeJS.ProcessEnv[] = [];
    const runs: NodeJS.ProcessEnv[] = [];
    vi.doMock("../main/main-paths.js", () => ({ projectRoot: root }));
    vi.doMock("../headless-host.js", () => {
      observed.push({ ...process.env });
      return { runHeadlessHost: () => { runs.push({ ...process.env }); } };
    });

    await import("../headless.js");

    expect(observed).toHaveLength(1);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ NODE_ENV: "production" });
    expect(observed[0]).toMatchObject({ NODE_ENV: "production" });
    expect(observed[0]?.VITEST).toBeUndefined();
    expect(observed[0]?.AVE_DEV).toBeUndefined();
    expect(observed[0]?.AVE_WHITELIST_OFFLINE).toBeUndefined();
    expect(getIsPackaged()).toBe(true);
  });
});
