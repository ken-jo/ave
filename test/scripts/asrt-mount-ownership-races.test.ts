import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanupBwrapMountPoints,
  wrapCommandWithSandboxLinux,
} from "@anthropic-ai/sandbox-runtime/dist/sandbox/linux-sandbox-utils.js";

// Patch part 6: selected public-name replacement races preserve foreign entries.
// Replacements follow real syscalls; publication failures precede rename.
// The patch preamble documents the remaining path-syscall windows.
// These cases only plan a wrap (bwrapPath is /usr/bin/true); nothing is executed.

type Kind = "file" | "directory";
type Identity = { dev: bigint; ino: bigint };
type Method = "lstatSync" | "mkdirSync" | "renameSync";

const real = { lstat: fs.lstatSync, mkdir: fs.mkdirSync, rename: fs.renameSync };

function identityOf(entry: string): Identity {
  const { dev, ino } = real.lstat(entry, { bigint: true });
  return { dev, ino };
}

function same(left: Identity, right: Identity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** Run `callback` after each real call of `method`, with its arguments. */
function afterCall(method: Method, callback: (args: unknown[]) => void): void {
  const original = fs[method] as (...args: unknown[]) => unknown;
  vi.spyOn(fs, method).mockImplementation(((...args: unknown[]) => {
    const result = Reflect.apply(original, fs, args);
    callback(args);
    return result;
  }) as never);
  syncBuiltinESMExports();
}

function restoreFs(): void {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
}

/** Every name in `dir` the patch uses for a private stage or quarantine. */
function privateNames(dir: string): string[] {
  return fs.readdirSync(dir).filter((name) => name.includes(".ave-"));
}

describe.skipIf(process.platform === "win32")("mount point ownership under syscall races", () => {
  let root: string;
  let target: string;
  let moved = 0;

  beforeEach(() => {
    root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "ave-mount-race-")));
    target = join(root, "denied");
  });

  afterEach(() => {
    restoreFs();
    vi.unstubAllEnvs();
    cleanupBwrapMountPoints({ force: true });
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function plan(kind: Kind): Promise<string> {
    return wrapCommandWithSandboxLinux({
      command: "true",
      needsNetworkRestriction: false,
      allowAllUnixSockets: true,
      mandatoryDenySearchDepth: 0,
      bwrapPath: "/usr/bin/true",
      writeConfig: {
        allowOnly: [root],
        denyWithinAllow: [kind === "directory" ? join(target, "config") : target],
      },
    });
  }

  /** Move whatever is at `entry` aside and put a foreign entry of `kind` there. */
  function replace(entry: string, kind: Kind, content = "unrelated content"): Identity {
    real.rename(entry, join(root, `aside-${moved++}`));
    if (kind === "directory") real.mkdir(entry);
    else fs.writeFileSync(entry, content);
    return identityOf(entry);
  }

  // Review of 31c09d3a0, defect 1: cleanup checked identity, then deleted by path.
  it.each(["file", "directory"] as const)(
    "leaves a foreign %s that replaces the mount point after its identity check",
    async (kind) => {
      await plan(kind);
      const owned = identityOf(target);
      let foreign: Identity | undefined;
      afterCall("lstatSync", ([entry]) => {
        if (entry === target && foreign === undefined) foreign = replace(target, kind);
      });
      cleanupBwrapMountPoints({ force: true });
      expect(foreign).toBeDefined();
      expect(same(owned, foreign!)).toBe(false);
      expect(same(identityOf(target), foreign!)).toBe(true);
      if (kind === "file") expect(fs.readFileSync(target, "utf8")).toBe("unrelated content");
      expect(privateNames(root)).toEqual([]);
    },
  );

  // Review of 31c09d3a0, defect 2: the directory's identity was read by path
  // after it was created there, so a replacement right after creation was
  // recorded as ours and deleted by the next cleanup.
  it("records the directory it made, not one that replaces it right after publication", async () => {
    let staged = false;
    let foreign: Identity | undefined;
    // 31c09d3a0 publishes with mkdir(target); the fix stages under a private
    // name and publishes with rename(staged, target).
    afterCall("mkdirSync", ([entry]) => {
      if (typeof entry === "string" && entry.includes(".ave-mount-")) staged = true;
      if (entry === target && !staged && foreign === undefined) foreign = replace(target, "directory");
    });
    afterCall("renameSync", ([, to]) => {
      if (to === target && foreign === undefined) foreign = replace(target, "directory");
    });
    await plan("directory");
    restoreFs();
    expect(foreign).toBeDefined();
    cleanupBwrapMountPoints();
    expect(fs.existsSync(target)).toBe(true);
    expect(same(identityOf(target), foreign!)).toBe(true);
  });

  it("does not claim a directory that takes the name before publication", async () => {
    let foreign: Identity | undefined;
    afterCall("mkdirSync", ([entry]) => {
      if (typeof entry !== "string" || !entry.includes(".ave-mount-") || foreign !== undefined) return;
      real.mkdir(target);
      foreign = identityOf(target);
    });
    await plan("directory");
    restoreFs();
    expect(foreign).toBeDefined();
    cleanupBwrapMountPoints({ force: true });
    expect(same(identityOf(target), foreign!)).toBe(true);
    expect(privateNames(root)).toEqual([]);
  });

  it("fails closed and keeps a non-empty directory that replaces the reservation", async () => {
    let foreign: Identity | undefined;
    afterCall("mkdirSync", ([entry]) => {
      if (entry !== target || foreign !== undefined) return;
      foreign = replace(target, "directory");
      fs.writeFileSync(join(target, "keep"), "kept");
    });
    await expect(plan("directory")).rejects.toThrow("Sandbox mount publication changed");
    restoreFs();
    expect(same(identityOf(target), foreign!)).toBe(true);
    expect(fs.readFileSync(join(target, "keep"), "utf8")).toBe("kept");
    expect(privateNames(root)).toEqual([]);
  });

  it("reports an unclaimed reservation when publication fails without a replacement", async () => {
    vi.stubEnv("SRT_DEBUG", "1");
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    let reservation: Identity | undefined;
    vi.spyOn(fs, "renameSync").mockImplementation((from, to) => {
      if (to === target && typeof from === "string" && from.includes(".ave-mount-")) {
        reservation = identityOf(target);
        throw Object.assign(new Error("publication denied"), { code: "EACCES" });
      }
      real.rename(from, to);
    });
    syncBuiltinESMExports();
    await expect(plan("directory")).rejects.toThrow("Sandbox mount publication changed");
    expect(reservation).toBeDefined();
    expect(warning).toHaveBeenCalledWith(
      `[SandboxDebug] [Sandbox Linux] Mount publication failed; reservation may remain at ${target} (EACCES)`,
    );
    restoreFs();
    cleanupBwrapMountPoints({ force: true });
    expect(same(identityOf(target), reservation!)).toBe(true);
    expect(privateNames(root)).toEqual([]);
  });

  it.each(["file", "directory"] as const)(
    "deletes only the quarantined %s when a new entry takes the public name meanwhile",
    async (kind) => {
      await plan(kind);
      let quarantine: string | undefined;
      let foreign: Identity | undefined;
      afterCall("renameSync", ([from, to]) => {
        if (from !== target || typeof to !== "string" || quarantine !== undefined) return;
        quarantine = to;
        if (kind === "directory") real.mkdir(target);
        else fs.writeFileSync(target, "new public content");
        foreign = identityOf(target);
      });
      cleanupBwrapMountPoints();
      expect(quarantine).toBeDefined();
      expect(fs.existsSync(quarantine!)).toBe(false);
      expect(same(identityOf(target), foreign!)).toBe(true);
      if (kind === "file") expect(fs.readFileSync(target, "utf8")).toBe("new public content");
    },
  );

  it("keeps a mismatched entry at its private name when the public name is taken again", async () => {
    await plan("file");
    let first: Identity | undefined;
    let quarantine: string | undefined;
    afterCall("lstatSync", ([entry]) => {
      if (entry === target && first === undefined) first = replace(target, "file", "first foreign");
    });
    afterCall("renameSync", ([from, to]) => {
      if (from !== target || typeof to !== "string" || quarantine !== undefined) return;
      quarantine = to;
      fs.writeFileSync(target, "second foreign");
    });
    cleanupBwrapMountPoints();
    expect(quarantine).toBeDefined();
    expect(fs.readFileSync(target, "utf8")).toBe("second foreign");
    expect(same(identityOf(quarantine!), first!)).toBe(true);
    expect(fs.readFileSync(quarantine!, "utf8")).toBe("first foreign");
  });

  it("leaves a foreign directory that replaces the private bind source after its check", async () => {
    const words = (await plan("directory")).split(" ");
    const at = words.findIndex((word, index) => word === target && words[index - 2] === "--ro-bind");
    expect(at).toBeGreaterThan(1);
    const source = words[at - 1]!;
    expect(source).not.toBe(target);
    let foreign: Identity | undefined;
    afterCall("lstatSync", ([entry]) => {
      if (entry !== source || foreign !== undefined) return;
      real.rename(source, `${source}-aside`);
      real.mkdir(source);
      foreign = identityOf(source);
    });
    try {
      cleanupBwrapMountPoints({ force: true });
      expect(foreign).toBeDefined();
      expect(same(identityOf(source), foreign!)).toBe(true);
    } finally {
      fs.rmSync(source, { recursive: true, force: true });
      fs.rmSync(`${source}-aside`, { recursive: true, force: true });
    }
  });
});
