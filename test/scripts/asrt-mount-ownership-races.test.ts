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
type Descriptor = { entry: unknown; flags: unknown; fd: number; closes: number };

const real = {
  lstat: fs.lstatSync,
  mkdir: fs.mkdirSync,
  rename: fs.renameSync,
  open: fs.openSync,
  close: fs.closeSync,
  fstat: fs.fstatSync,
};

/** Track acquisitions separately: a later open may reuse a closed FD number. */
function observeDescriptors(afterClose?: (descriptor: Descriptor | undefined) => void): Descriptor[] {
  const opened: Descriptor[] = [];
  const active = new Map<number, Descriptor>();
  vi.spyOn(fs, "openSync").mockImplementation(((...args: Parameters<typeof fs.openSync>) => {
    const fd = Reflect.apply(real.open, fs, args);
    const descriptor = { entry: args[0], flags: args[1], fd, closes: 0 };
    opened.push(descriptor);
    active.set(fd, descriptor);
    return fd;
  }) as never);
  vi.spyOn(fs, "closeSync").mockImplementation((fd) => {
    const descriptor = active.get(fd);
    if (descriptor !== undefined) {
      descriptor.closes++;
      active.delete(fd);
    }
    real.close(fd);
    afterClose?.(descriptor);
  });
  syncBuiltinESMExports();
  return opened;
}

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

  async function plan(kind: Kind, denied?: string, binShell?: string): Promise<string> {
    return wrapCommandWithSandboxLinux({
      command: "true",
      needsNetworkRestriction: false,
      allowAllUnixSockets: true,
      mandatoryDenySearchDepth: 0,
      bwrapPath: "/usr/bin/true",
      binShell,
      writeConfig: {
        allowOnly: [root],
        denyWithinAllow: [denied ?? (kind === "directory" ? join(target, "config") : target)],
      },
    });
  }

  function ownedDescriptor(opened: Descriptor[], kind: Kind): Descriptor {
    const descriptor = opened.find(({ entry, flags }) => kind === "file"
      ? entry === target && flags === "wx"
      : typeof entry === "string" && entry.startsWith(root) && entry.includes(".ave-mount-"));
    expect(descriptor).toBeDefined();
    return descriptor!;
  }

  function sourceOf(wrapped: string): string {
    const words = wrapped.split(" ");
    const at = words.findIndex((word, index) => word === target && words[index - 2] === "--ro-bind");
    expect(at).toBeGreaterThan(1);
    return words[at - 1]!;
  }

  function descriptorAt(opened: Descriptor[], entry: string): Descriptor {
    const descriptor = opened.find((item) => item.entry === entry);
    expect(descriptor).toBeDefined();
    return descriptor!;
  }

  it.each(["file", "directory"] as const)(
    "pins an owned %s until cleanup removes it and closes its descriptor once",
    async (kind) => {
      const opened = observeDescriptors();
      await plan(kind);
      const descriptor = ownedDescriptor(opened, kind);
      expect(same(real.fstat(descriptor.fd, { bigint: true }), identityOf(target))).toBe(true);
      expect(descriptor.closes).toBe(0);
      cleanupBwrapMountPoints();
      expect(fs.existsSync(target)).toBe(false);
      expect(descriptor.closes).toBe(1);
      expect(() => real.fstat(descriptor.fd)).toThrow(expect.objectContaining({ code: "EBADF" }));
      cleanupBwrapMountPoints({ force: true });
      expect(descriptor.closes).toBe(1);
    },
  );

  // Real unlink/rmdir with an open descriptor, not a fabricated inode collision.
  // This proves the pin's lifetime; it does not reproduce Linux inode reuse.
  it.each(["file", "directory"] as const)(
    "keeps the unlinked %s pinned and preserves an empty foreign replacement",
    async (kind) => {
      const opened = observeDescriptors();
      await plan(kind);
      const descriptor = ownedDescriptor(opened, kind);
      const owned = real.fstat(descriptor.fd, { bigint: true });
      if (kind === "file") fs.unlinkSync(target);
      else fs.rmdirSync(target);
      if (kind === "file") fs.writeFileSync(target, "");
      else real.mkdir(target);
      const foreign = identityOf(target);
      expect(same(owned, foreign)).toBe(false);
      expect(same(real.fstat(descriptor.fd, { bigint: true }), owned)).toBe(true);
      cleanupBwrapMountPoints();
      expect(same(identityOf(target), foreign)).toBe(true);
      expect(descriptor.closes).toBe(1);
      expect(() => real.fstat(descriptor.fd)).toThrow(expect.objectContaining({ code: "EBADF" }));
    },
  );

  it.each(["file", "directory"] as const)(
    "keeps the %s descriptor open while another planned wrap defers cleanup",
    async (kind) => {
      const opened = observeDescriptors();
      await plan(kind);
      const descriptor = ownedDescriptor(opened, kind);
      await plan(kind);
      cleanupBwrapMountPoints();
      expect(descriptor.closes).toBe(0);
      expect(same(real.fstat(descriptor.fd, { bigint: true }), identityOf(target))).toBe(true);
      cleanupBwrapMountPoints();
      expect(descriptor.closes).toBe(1);
      expect(() => real.fstat(descriptor.fd)).toThrow(expect.objectContaining({ code: "EBADF" }));
    },
  );

  it.each(["file", "directory"] as const)(
    "closes the unregistered %s descriptor when its identity cannot be measured",
    async (kind) => {
      const opened = observeDescriptors();
      vi.spyOn(fs, "fstatSync").mockImplementation(((fd: number, options?: unknown) => {
        const current = opened.find((item) => item.fd === fd && item.closes === 0);
        if (current !== undefined && (kind === "file"
          ? current.entry === target && current.flags === "wx"
          : typeof current.entry === "string" && current.entry.startsWith(root) && current.entry.includes(".ave-mount-"))) {
          throw Object.assign(new Error("identity measurement failed"), { code: "EIO" });
        }
        return Reflect.apply(real.fstat, fs, [fd, options]);
      }) as never);
      syncBuiltinESMExports();
      await expect(plan(kind)).rejects.toThrow("identity measurement failed");
      const descriptor = ownedDescriptor(opened, kind);
      expect(descriptor.closes).toBe(1);
      expect(() => real.fstat(descriptor.fd)).toThrow(expect.objectContaining({ code: "EBADF" }));
      cleanupBwrapMountPoints({ force: true });
      expect(descriptor.closes).toBe(1);
    },
  );

  it.each(["file", "directory"] as const)(
    "retires registered %s descriptors when later command planning fails",
    async (kind) => {
      const opened = observeDescriptors();
      await expect(plan(kind, undefined, "ave-missing-shell-for-fd-test")).rejects.toThrow("not found in PATH");
      const descriptor = ownedDescriptor(opened, kind);
      expect(descriptor.closes).toBe(1);
      expect(fs.existsSync(target)).toBe(false);
      expect(() => real.fstat(descriptor.fd)).toThrow(expect.objectContaining({ code: "EBADF" }));
      const sources = opened.filter(({ entry }) => typeof entry === "string" && /[/\\]claude-empty-[^/\\]+$/u.test(entry));
      if (kind === "directory") expect(sources.length).toBe(1);
      for (const source of sources) expect(source.closes).toBe(1);
    },
  );

  it.each(["file", "directory"] as const)(
    "retires the %s FD even when forced path cleanup is inaccessible",
    async (kind) => {
      const opened = observeDescriptors();
      await plan(kind);
      const descriptor = ownedDescriptor(opened, kind);
      const owned = identityOf(target);
      vi.spyOn(fs, "lstatSync").mockImplementation(((...args: Parameters<typeof fs.lstatSync>) => {
        if (args[0] === target) throw Object.assign(new Error("cleanup denied"), { code: "EACCES" });
        return Reflect.apply(real.lstat, fs, args);
      }) as never);
      syncBuiltinESMExports();
      cleanupBwrapMountPoints({ force: true });
      expect(same(identityOf(target), owned)).toBe(true);
      expect(descriptor.closes).toBe(1);
      expect(() => real.fstat(descriptor.fd)).toThrow(expect.objectContaining({ code: "EBADF" }));
      cleanupBwrapMountPoints({ force: true });
      expect(descriptor.closes).toBe(1);
    },
  );

  it("retires all records after a close error and never closes a reused FD on later cleanup", async () => {
    let descriptor: Descriptor | undefined;
    let injected = false;
    const opened = observeDescriptors((closed) => {
      if (descriptor !== undefined && closed === descriptor && !injected) {
        injected = true;
        throw Object.assign(new Error("reported close failure"), { code: "EIO" });
      }
    });
    const source = sourceOf(await plan("directory"));
    descriptor = ownedDescriptor(opened, "directory");
    expect(() => cleanupBwrapMountPoints({ force: true })).toThrow("Failed to close sandbox mount ownership descriptors");
    expect(descriptor.closes).toBe(1);
    expect(descriptorAt(opened, source).closes).toBe(1);
    const acquired: number[] = [];
    try {
      // Real kernel allocation, bounded to a few descriptors; no mocked FD alias.
      for (let attempt = 0; attempt < 32; attempt++) {
        const fd = fs.openSync(join(root, "external"), "a");
        acquired.push(fd);
        if (fd === descriptor.fd) break;
      }
      expect(acquired).toContain(descriptor.fd);
      cleanupBwrapMountPoints({ force: true });
      expect(() => real.fstat(descriptor!.fd)).not.toThrow();
      expect(descriptor.closes).toBe(1);
    } finally {
      for (const fd of acquired) fs.closeSync(fd);
    }
  });

  it("closes a new source FD when measurement fails and the caller retires earlier mount records", async () => {
    const opened = observeDescriptors();
    vi.spyOn(fs, "fstatSync").mockImplementation(((fd: number, options?: unknown) => {
      const current = opened.find((item) => item.fd === fd && item.closes === 0);
      if (typeof current?.entry === "string" && /[/\\]claude-empty-[^/\\]+$/u.test(current.entry)) {
        throw Object.assign(new Error("source measurement failed"), { code: "EIO" });
      }
      return Reflect.apply(real.fstat, fs, [fd, options]);
    }) as never);
    syncBuiltinESMExports();
    try {
      await expect(plan("directory")).rejects.toThrow("source measurement failed");
      const source = opened.find(({ entry }) => typeof entry === "string" && /[/\\]claude-empty-[^/\\]+$/u.test(entry));
      expect(source).toBeDefined();
      expect(source!.closes).toBe(1);
      expect(ownedDescriptor(opened, "directory").closes).toBe(1);
      expect(fs.existsSync(target)).toBe(false);
      cleanupBwrapMountPoints({ force: true });
      expect(source!.closes).toBe(1);
    } finally {
      for (const { entry } of opened) {
        if (typeof entry === "string" && /[/\\]claude-empty-[^/\\]+$/u.test(entry)) fs.rmSync(entry, { recursive: true, force: true });
      }
    }
  });

  it.each(["non-empty", "busy"] as const)("retains the cached source FD for a %s cleanup retry", async (reason) => {
    const opened = observeDescriptors();
    const source = sourceOf(await plan("directory"));
    const descriptor = descriptorAt(opened, source);
    if (reason === "non-empty") fs.writeFileSync(join(source, "keep"), "kept");
    const lstat = vi.spyOn(fs, "lstatSync").mockImplementation(((...args: Parameters<typeof fs.lstatSync>) => {
      if (reason === "busy" && args[0] === source) throw Object.assign(new Error("busy"), { code: "EBUSY" });
      return Reflect.apply(real.lstat, fs, args);
    }) as never);
    syncBuiltinESMExports();
    try {
      cleanupBwrapMountPoints();
      expect(descriptor.closes).toBe(0);
      expect(same(real.fstat(descriptor.fd, { bigint: true }), identityOf(source))).toBe(true);
      lstat.mockRestore();
      syncBuiltinESMExports();
      if (reason === "non-empty") fs.unlinkSync(join(source, "keep"));
      cleanupBwrapMountPoints({ force: true });
      expect(descriptor.closes).toBe(1);
      expect(fs.existsSync(source)).toBe(false);
    } finally {
      lstat.mockRestore();
      syncBuiltinESMExports();
      fs.rmSync(source, { recursive: true, force: true });
    }
  });

  it("retires an invalid cached source FD before acquiring its replacement", async () => {
    const opened = observeDescriptors();
    const source = sourceOf(await plan("directory"));
    const descriptor = descriptorAt(opened, source);
    real.rename(source, `${source}-aside`);
    real.mkdir(source);
    const foreign = identityOf(source);
    try {
      await plan("directory", join(root, "another", "config"));
      expect(descriptor.closes).toBe(1);
      const replacement = opened.find(({ entry }) => typeof entry === "string" && entry !== source && /[/\\]claude-empty-[^/\\]+$/u.test(entry));
      expect(replacement).toBeDefined();
      expect(replacement!.closes).toBe(0);
      expect(same(real.fstat(replacement!.fd, { bigint: true }), identityOf(replacement!.entry as string))).toBe(true);
      cleanupBwrapMountPoints({ force: true });
      expect(replacement!.closes).toBe(1);
      expect(descriptor.closes).toBe(1);
      expect(same(identityOf(source), foreign)).toBe(true);
    } finally {
      fs.rmSync(source, { recursive: true, force: true });
      fs.rmSync(`${source}-aside`, { recursive: true, force: true });
    }
  });

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
    const opened = observeDescriptors();
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
    const descriptor = ownedDescriptor(opened, "directory");
    expect(descriptor.closes).toBe(1);
    expect(() => real.fstat(descriptor.fd)).toThrow(expect.objectContaining({ code: "EBADF" }));
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
