/**
 * The boot sweep refuses, in a test process, a sandbox root inside the
 * developer's real `~/.ave` (other than `test-tmp`): what is there belongs to a
 * running app, and a sweep deletes it.
 *
 * `homedir()` is a throwaway directory here, never the real one, so a guard
 * that stopped working would empty that directory — which these cases see —
 * and nothing of the developer's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const fake = vi.hoisted(() => ({ home: "" }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, default: { ...actual, homedir: () => fake.home }, homedir: () => fake.home };
});

import { tmpdir } from "node:os";
import { sweepSandboxPrivateRoot, sweepSandboxPrivateRoots } from "../steps/sandbox-init.js";
import { makeTestTreeWritable } from "../../plugins/__tests__/test-helpers.js";

let ave: string;
let planted: string[];
let scratch: string[];

function plant(path: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "kept");
  return path;
}

beforeEach(() => {
  fake.home = mkdtempSync(join(tmpdir(), "ave-sweep-guard-"));
  scratch = [fake.home];
  ave = join(fake.home, ".ave");
  planted = [
    plant(join(ave, "sandbox", "home", "ave-sandbox-home-live", "kept")),
    plant(join(ave, "sandbox", "tmp", "plugin-61", "kept")),
    plant(join(ave, "plugins", "kept")),
  ];
});

afterEach(async () => {
  vi.unstubAllEnvs();
  for (const dir of scratch) {
    // A sweep that did not reclaim them leaves modes and flags rm cannot pass.
    await makeTestTreeWritable(dir);
    rmSync(dir, { recursive: true, force: true });
  }
});

function expectNothingRemoved(): void {
  for (const path of planted) expect(existsSync(path), `${path} was removed`).toBe(true);
}

describe("the sandbox sweep in a test process", () => {
  it("refuses a root under the real ~/.ave and touches nothing there", async () => {
    await expect(sweepSandboxPrivateRoot(join(ave, "sandbox", "home"), new Set())).rejects.toThrow(
      /refusing to sweep .* from a test process/,
    );
    await expect(sweepSandboxPrivateRoot(ave, new Set())).rejects.toThrow(/refusing to sweep/);
    expectNothingRemoved();
  });

  it.runIf(process.platform !== "linux")("refuses it in another letter case, the same directory there", async () => {
    await expect(sweepSandboxPrivateRoot(join(fake.home, ".AVE", "sandbox", "home"), new Set())).rejects.toThrow(
      /refusing to sweep/,
    );
    expectNothingRemoved();
  });

  it("refuses a root named by its real path when HOME is reached through a link", async () => {
    // HOME is `<link>`, which resolves to the planted home: `/tmp/<x>` against
    // `/private/tmp/<x>` on macOS, here made explicit on every platform.
    const links = mkdtempSync(join(tmpdir(), "ave-sweep-guard-link-"));
    scratch.push(links);
    const realHome = realpathSync(fake.home);
    const linkedHome = join(links, "home");
    symlinkSync(realHome, linkedHome);
    fake.home = linkedHome;
    await expect(sweepSandboxPrivateRoot(join(realHome, ".ave", "sandbox", "tmp"), new Set())).rejects.toThrow(
      /refusing to sweep/,
    );
    await expect(sweepSandboxPrivateRoot(join(realHome, ".ave"), new Set())).rejects.toThrow(/refusing to sweep/);
    expectNothingRemoved();
  });

  it("fails the paired boot sweep instead of logging, with neither root touched", async () => {
    vi.stubEnv("AVE_HOME", ave);
    await expect(sweepSandboxPrivateRoots()).rejects.toThrow(/refusing to sweep/);
    expectNothingRemoved();
  });

  it("sweeps a root under ~/.ave/test-tmp, which is the tests' own", async () => {
    const root = join(ave, "test-tmp", "sbx-case", "home");
    mkdirSync(join(root, "stale"), { recursive: true });
    // What a confined process can leave in its own directory, which a plain
    // `rm` cannot take: a directory it closed to its owner, and on macOS a
    // file and a directory it made user-immutable.
    const closed = join(root, "closed");
    mkdirSync(join(closed, "inner"), { recursive: true });
    writeFileSync(join(closed, "inner", "file"), "x");
    chmodSync(join(closed, "inner"), 0o000);
    chmodSync(closed, 0o000);
    if (process.platform === "darwin") {
      const flagged = join(root, "flagged");
      mkdirSync(flagged);
      writeFileSync(join(flagged, "file"), "x");
      execFileSync("/usr/bin/chflags", ["uchg", join(flagged, "file")]);
      execFileSync("/usr/bin/chflags", ["uchg", flagged]);
    }
    await sweepSandboxPrivateRoot(root, new Set());
    expect(readdirSync(root)).toEqual([]);
    expectNothingRemoved();
  });
});
