import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { appOwnedSandboxHomeRoot, ensureSandboxTempPrincipalDir } from "../asrt-sandbox.js";
import { sweepSandboxPrivateRoots } from "../../boot/steps/sandbox-init.js";
import {
  createSandboxProcessHome,
  sandboxProcessHomesInUse,
  sandboxProcessProfileEnvironment,
} from "../sandbox-process-home.js";

// The HOMEs are created under `<AVE_HOME>/sandbox/home` on macOS and Linux,
// so the real AVE_HOME is never the one these cases fill.
let aveHomeDir: string;
beforeEach(() => {
  aveHomeDir = mkdtempSync(join(tmpdir(), "ave-process-home-"));
  vi.stubEnv("AVE_HOME", join(aveHomeDir, ".ave"));
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  rmSync(aveHomeDir, { recursive: true, force: true });
});

describe("createSandboxProcessHome", () => {
  it("creates a unique private profile and removes it idempotently", () => {
    const first = createSandboxProcessHome();
    const second = createSandboxProcessHome();
    try {
      expect(first.path).not.toBe(second.path);
      expect(first.env.HOME).toBe(first.path);
      expect(statSync(first.path).isDirectory()).toBe(true);
      if (process.platform !== "win32") {
        expect(statSync(first.path).mode & 0o777).toBe(0o700);
      }

      if (process.platform === "win32") {
        expect(first.env.USERPROFILE).toBe(first.path);
        expect(first.env.APPDATA).toContain(first.path);
        expect(first.env.LOCALAPPDATA).toContain(first.path);
        expect(first.env.HOMEDRIVE).toBeDefined();
        expect(first.env.HOMEPATH).toBeDefined();
      } else {
        expect(first.env.XDG_CONFIG_HOME).toContain(first.path);
        expect(first.env.XDG_DATA_HOME).toContain(first.path);
        expect(first.env.XDG_CACHE_HOME).toContain(first.path);
        expect(first.env.XDG_STATE_HOME).toContain(first.path);
      }

      writeFileSync(`${first.path}/.gitconfig`, "[test]\nvalue = isolated\n", "utf8");
    } finally {
      first.cleanup();
      first.cleanup();
      second.cleanup();
    }

    expect(existsSync(first.path)).toBe(false);
    expect(existsSync(second.path)).toBe(false);
  });

  it.skipIf(process.platform === "win32")(
    "creates each HOME under the app-owned root the read floor denies, and tracks it until removed",
    () => {
      const home = createSandboxProcessHome();
      try {
        expect(dirname(home.path)).toBe(realpathSync(appOwnedSandboxHomeRoot()));
        expect(statSync(appOwnedSandboxHomeRoot()).mode & 0o777).toBe(0o700);
        expect(sandboxProcessHomesInUse().has(home.path)).toBe(true);
      } finally {
        home.cleanup();
      }
      expect(sandboxProcessHomesInUse().has(home.path)).toBe(false);
    },
  );

  it.skipIf(process.platform === "win32")(
    "the boot sweep removes a HOME left by an earlier run and keeps one this process made",
    async () => {
      const live = createSandboxProcessHome();
      const { dir: liveTemp } = ensureSandboxTempPrincipalDir({ kind: "plugin", id: "home-sweep" });
      try {
        writeFileSync(join(live.path, "kept"), "kept");
        const stale = join(appOwnedSandboxHomeRoot(), "ave-sandbox-home-stale");
        mkdirSync(join(stale, "config"), { recursive: true, mode: 0o700 });
        await sweepSandboxPrivateRoots();
        expect(existsSync(stale)).toBe(false);
        expect(readdirSync(live.path)).toContain("kept");
        expect(existsSync(liveTemp)).toBe(true);
      } finally {
        live.cleanup();
      }
    },
  );

  it("keeps the Windows HOME under the host temp directory, as before", () => {
    const home = createSandboxProcessHome("win32");
    try {
      expect(dirname(home.path)).toBe(realpathSync.native(tmpdir()));
      expect(existsSync(appOwnedSandboxHomeRoot())).toBe(false);
    } finally {
      home.cleanup();
    }
  });

  it.skipIf(process.platform === "win32")("refuses a HOME root that is a link, and creates nothing behind it", () => {
    const outside = mkdtempSync(join(aveHomeDir, "outside-"));
    mkdirSync(dirname(appOwnedSandboxHomeRoot()), { recursive: true });
    symlinkSync(outside, appOwnedSandboxHomeRoot());
    expect(() => createSandboxProcessHome()).toThrow(/not a directory the host created/);
    expect(lstatSync(appOwnedSandboxHomeRoot()).isSymbolicLink()).toBe(true);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("overrides the Windows HOME drive pair for a non-drive temp path", () => {
    const path = "\\\\server\\temp\\ave-sandbox-home-test";
    const env = sandboxProcessProfileEnvironment(path, "win32");
    expect(env.HOMEDRIVE).toBe("");
    expect(env.HOMEPATH).toBe(path);
  });

  it("keeps cleanup retryable until the profile is actually absent", () => {
    let attempts = 0;
    const profile = createSandboxProcessHome(process.platform, (path, options) => {
      attempts += 1;
      if (attempts === 1) {
        const err = new Error("locked") as NodeJS.ErrnoException;
        err.code = "EPERM";
        throw err;
      }
      rmSync(path, options);
    });
    profile.cleanup();
    expect(existsSync(profile.path)).toBe(true);
    profile.cleanup();
    expect(attempts).toBe(2);
    expect(existsSync(profile.path)).toBe(false);
  });

  it("automatically retries a transient cleanup failure", () => {
    vi.useFakeTimers();
    let attempts = 0;
    const profile = createSandboxProcessHome(process.platform, (path, options) => {
      attempts += 1;
      if (attempts === 1) {
        const err = new Error("busy") as NodeJS.ErrnoException;
        err.code = "EBUSY";
        throw err;
      }
      rmSync(path, options);
    });

    profile.cleanup();
    expect(existsSync(profile.path)).toBe(true);
    vi.advanceTimersByTime(50);
    expect(attempts).toBe(2);
    expect(existsSync(profile.path)).toBe(false);
  });
});
