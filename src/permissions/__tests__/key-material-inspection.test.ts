import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Every open and read the classifier makes goes through these, so a test can say that none was made.
const fsCalls = vi.hoisted(() => ({
  open: [] as string[], read: 0, shortReads: false, beforeOpen: undefined as (() => void) | undefined,
  afterOpen: undefined as (() => void) | undefined,
  // Called before each lstat that asks for exact identifiers, which is how the classifier looks at a name.
  beforeIdentityLstat: undefined as ((path: string) => void) | undefined,
  // Find a name only in the decomposed form it is stored in.
  decomposedNamesOnly: false,
  storedAlias: undefined as { named: string; backing: string; requested?: string; unavailable?: "missing" | "unreadable" } | undefined,
}));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const missing = (path: unknown): boolean => {
    const alias = fsCalls.storedAlias;
    return (alias !== undefined && path === alias.named && alias.unavailable === "missing")
      || (fsCalls.decomposedNamesOnly && typeof path === "string" && path !== path.normalize("NFD"));
  };
  const backing = (path: unknown) => {
    const alias = fsCalls.storedAlias;
    return alias && path === alias.named ? alias.backing : path;
  };
  const notFound = (path: unknown): Error => Object.assign(new Error(`ENOENT: no such file or directory, '${String(path)}'`), { code: "ENOENT" });
  const existsSync = ((path: Parameters<typeof actual.existsSync>[0]) => !missing(path) && actual.existsSync(backing(path) as string)) as typeof actual.existsSync;
  const realpathSync = Object.assign(((path: string, options?: unknown) => {
    if (missing(path)) throw notFound(path);
    const alias = fsCalls.storedAlias;
    if (alias && path === alias.requested) {
      if (missing(alias.named)) throw notFound(path);
      return alias.named;
    }
    if (path === fsCalls.storedAlias?.named) return path;
    return actual.realpathSync(path, options as never);
  }) as typeof actual.realpathSync, {
    native: ((path: string, options?: unknown) => {
      if (missing(path)) throw notFound(path);
      const alias = fsCalls.storedAlias;
      if (alias && path === alias.requested) {
        if (missing(alias.named)) throw notFound(path);
        return alias.named;
      }
      if (path === fsCalls.storedAlias?.named) return path;
      return actual.realpathSync.native(path, options as never);
    }) as typeof actual.realpathSync.native,
  });
  const openSync = ((...args: Parameters<typeof actual.openSync>) => {
    if (missing(args[0])) throw notFound(args[0]);
    fsCalls.open.push(String(args[0]));
    const alias = fsCalls.storedAlias;
    if (alias !== undefined && args[0] === alias.named && alias.unavailable === "unreadable") {
      throw Object.assign(new Error("File cannot be read"), { code: "EACCES" });
    }
    fsCalls.beforeOpen?.();
    const descriptor = actual.openSync(backing(args[0]) as string, args[1], args[2]);
    fsCalls.afterOpen?.();
    return descriptor;
  }) as typeof actual.openSync;
  const lstatSync = ((path: string, options?: { bigint?: boolean; throwIfNoEntry?: boolean }) => {
    if (options?.bigint === true) fsCalls.beforeIdentityLstat?.(String(path));
    if (missing(path)) {
      if (options?.throwIfNoEntry === false) return undefined;
      throw notFound(path);
    }
    return actual.lstatSync(backing(path) as string, options as never);
  }) as typeof actual.lstatSync;
  const readSync = ((fd: number, buffer: Buffer, offset: number, length: number, position: number) => {
    fsCalls.read += 1;
    // A read may return fewer bytes than asked for; with `shortReads` each one returns at most 7.
    return actual.readSync(fd, buffer, offset, fsCalls.shortReads ? Math.min(length, 7) : length, position);
  }) as typeof actual.readSync;
  const replaced = { existsSync, lstatSync, openSync, readSync, realpathSync };
  return { ...actual, default: { ...actual, ...replaced }, ...replaced };
});

import { allowKeyMaterialInspectionUnder, createSensitivePathMatcher, isSensitivePath } from "../sensitive-paths.js";
import { createFilePathPolicy, sensitiveFilePattern } from "../../tools/file-access-policy.js";

const KEY_TEXT = ["-----BEGIN", "PRIVATE KEY-----\nFIXTURE\n-----END", "PRIVATE KEY-----\n"].join(" ");
const ZIP = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00]);

let base: string;
let project: string;
let outside: string;
let withdraw: () => void;

beforeEach(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "ave-key-inspection-")));
  project = join(base, "project");
  outside = join(base, "outside");
  mkdirSync(project);
  mkdirSync(outside);
  withdraw = allowKeyMaterialInspectionUnder(() => [project]);
  fsCalls.open.length = 0;
  fsCalls.read = 0;
  fsCalls.shortReads = false;
  fsCalls.beforeOpen = undefined;
  fsCalls.afterOpen = undefined;
  fsCalls.beforeIdentityLstat = undefined;
  fsCalls.decomposedNamesOnly = false;
  fsCalls.storedAlias = undefined;
});

afterEach(() => {
  withdraw();
  rmSync(base, { recursive: true, force: true });
});

describe("looking inside a key-extension file", () => {
  it("opens and reads nothing outside the registered project", () => {
    writeFileSync(join(outside, "deck.key"), ZIP);
    writeFileSync(join(outside, "server.pem"), KEY_TEXT);
    expect(isSensitivePath(join(outside, "deck.key"), "read")).toBe("**/*.key");
    expect(isSensitivePath(join(outside, "server.pem"), "read")).toBe("**/*.pem");
    expect(isSensitivePath(join(outside, "not-there.key"), "read")).toBe("**/*.key");
    expect(fsCalls.open).toEqual([]);
    expect(fsCalls.read).toBe(0);
  });

  it("opens and reads nothing through a link in the project that points outside it", () => {
    writeFileSync(join(outside, "deck.key"), ZIP);
    symlinkSync(join(outside, "deck.key"), join(project, "linked.key"));
    symlinkSync(outside, join(project, "linked-folder"), "junction");
    expect(isSensitivePath(join(project, "linked.key"), "read")).toBe("**/*.key");
    expect(isSensitivePath(join(project, "linked-folder", "deck.key"), "read")).toBe("**/*.key");
    expect(fsCalls.open).toEqual([]);
    expect(fsCalls.read).toBe(0);
  });

  it("reads a project file once, through one open, and finds a harmless one harmless", () => {
    writeFileSync(join(project, "deck.key"), ZIP);
    writeFileSync(join(project, "server.key"), KEY_TEXT);
    expect(isSensitivePath(join(project, "deck.key"), "read")).toBeNull();
    expect(isSensitivePath(join(project, "server.key"), "read")).toBe("**/*.key");
    expect(fsCalls.open).toEqual([join(project, "deck.key"), join(project, "server.key")]);
  });

  it("keeps reading after a short read, and still finds the key", () => {
    fsCalls.shortReads = true;
    writeFileSync(join(project, "bundle.pem"), `${"certificate text\n".repeat(40)}${KEY_TEXT}`);
    writeFileSync(join(project, "chain.pem"), "certificate text\n".repeat(40));
    expect(isSensitivePath(join(project, "bundle.pem"), "read")).toBe("**/*.pem");
    expect(isSensitivePath(join(project, "chain.pem"), "read")).toBeNull();
    expect(fsCalls.read).toBeGreaterThan(2);
  });

  it.skipIf(process.platform === "win32")("judges what it opened, not what the name was a moment before", () => {
    const target = join(project, "swapped.key");
    writeFileSync(target, ZIP);
    // Between the look at the name and the open, the harmless file is replaced by a pipe nobody writes to.
    fsCalls.beforeOpen = () => {
      fsCalls.beforeOpen = undefined;
      rmSync(target);
      execFileSync("mkfifo", [target]);
    };
    // The open does not wait for a writer, the handle is seen not to be a regular file, and nothing is read from it.
    expect(isSensitivePath(target, "read")).toBe("**/*.key");
    expect(fsCalls.open).toEqual([target]);
    expect(fsCalls.read).toBe(0);
  });

  it("judges the file its path names after the read, not one a folder swapped for a link led to meanwhile", () => {
    const certs = join(project, "certs");
    const decoy = join(outside, "decoy");
    mkdirSync(certs);
    mkdirSync(decoy);
    const target = join(certs, "server.pem");
    writeFileSync(target, KEY_TEXT);
    writeFileSync(join(decoy, "server.pem"), "certificate text\n");
    const spelled = (path: string) => path.replace(/\\/g, "/").toLowerCase();
    // From the look at the name until the open, the folder leads to a harmless file; it is back before anything looks
    // again, so the name and the open agree with each other and not with what the path names when the verdict is given.
    fsCalls.beforeIdentityLstat = (path) => {
      if (spelled(path) !== spelled(target)) return;
      fsCalls.beforeIdentityLstat = undefined;
      renameSync(certs, `${certs}.orig`);
      symlinkSync(decoy, certs, "junction");
      fsCalls.afterOpen = () => {
        fsCalls.afterOpen = undefined;
        unlinkSync(certs);
        renameSync(`${certs}.orig`, certs);
      };
    };
    expect(isSensitivePath(target, "read")).toBe("**/*.pem");
    expect(fsCalls.open.map(spelled)).toEqual([spelled(target)]);
    // Nothing is left swapped: the key is still where its name says, and is judged a key when looked at again.
    expect(fsCalls.afterOpen).toBeUndefined();
    expect(isSensitivePath(target, "read")).toBe("**/*.pem");
  });

  it.skipIf(process.platform === "win32")("does not open a name that became a pipe", () => {
    execFileSync("mkfifo", [join(project, "pipe.key")]);
    expect(isSensitivePath(join(project, "pipe.key"), "read")).toBe("**/*.key");
    expect(fsCalls.open).toEqual([]);
  });
});

describe("a key-extension name in either Unicode normalization", () => {
  const decomposed = "cafe\u0301.pem";
  const composed = "caf\u00e9.pem";

  it.each([
    ["single", "named", "key"], ["single", "named", "certificate"], ["single", "named", "sibling"], ["single", "named", "missing"], ["single", "named", "unreadable"],
    ["reusable", "named", "key"], ["reusable", "named", "certificate"], ["reusable", "named", "sibling"], ["reusable", "named", "missing"], ["reusable", "named", "unreadable"],
    ["single", "resolved", "key"], ["single", "resolved", "certificate"], ["single", "resolved", "sibling"], ["single", "resolved", "missing"], ["single", "resolved", "unreadable"],
    ["reusable", "resolved", "key"], ["reusable", "resolved", "certificate"], ["reusable", "resolved", "sibling"], ["reusable", "resolved", "missing"], ["reusable", "resolved", "unreadable"],
  ] as const)("preserves the %s file policy's %s spelling: %s", (policy, form, kind) => {
    const platform = process.platform;
    Object.defineProperty(process, "platform", { value: "linux", configurable: true });
    try {
      const backing = join(project, "stored-bytes");
      writeFileSync(backing, kind === "key" ? KEY_TEXT : "certificate\n");
      const named = join(project, "K.pem");
      const requested = form === "named" ? named : join(project, "linked.txt");
      if (kind === "sibling") writeFileSync(join(project, "K.pem"), KEY_TEXT);
      fsCalls.storedAlias = { named, backing,
        requested,
        unavailable: kind === "missing" || kind === "unreadable" ? kind : undefined };
      const match = policy === "single" ? sensitiveFilePattern : createFilePathPolicy("read").sensitive;
      expect(match(requested)).toBe(kind === "key" || kind === "unreadable" ? "**/*.pem" : null);
      expect(fsCalls.open).toEqual(kind === "missing" ? []
        : (kind === "certificate" || kind === "sibling") && form === "named" ? [named, named] : [named]);
    } finally { Object.defineProperty(process, "platform", { value: platform, configurable: true }); }
  });

  it.each(["key", "certificate", "sibling", "missing", "unreadable"] as const)("retains a name normalized entirely to ASCII for matching: %s", (kind) => {
    const backing = join(project, "stored-bytes");
    writeFileSync(backing, kind === "key" ? KEY_TEXT : "certificate\n");
    const named = join(project, "K.pem");
    if (kind === "sibling") writeFileSync(join(project, "K.pem"), KEY_TEXT);
    fsCalls.storedAlias = { named, backing,
      unavailable: kind === "missing" || kind === "unreadable" ? kind : undefined };
    const match = createSensitivePathMatcher("read", undefined, path => path.normalize("NFC"));
    expect(match(named)).toBe(kind === "key" || kind === "unreadable" ? "**/*.pem" : null);
    expect(fsCalls.open).toEqual(kind === "missing" ? [] : [named]);
  });

  it("judges the name the same in either normalization, without looking at any file", () => {
    for (const name of [decomposed, composed]) {
      expect(isSensitivePath(join(outside, name), "read")).toBe("**/*.pem");
      expect(isSensitivePath(join(outside, "cafe\u0301", ".ssh", "config"), "read")).toBe("**/.ssh/**");
    }
    expect(fsCalls.open).toEqual([]);
  });

  it("looks inside the file under the decomposed name it is stored with, when only that name finds it", () => {
    fsCalls.decomposedNamesOnly = true;
    const stored = join(project, decomposed);
    writeFileSync(stored, KEY_TEXT);
    expect(isSensitivePath(stored, "read")).toBe("**/*.pem");
    expect(fsCalls.open).toEqual([stored]);
  });

  it("retains a mixed-case decomposed operand while matching its folded identity", () => {
    fsCalls.decomposedNamesOnly = true;
    const stored = join(project, "Cafe\u0301.pem");
    writeFileSync(stored, KEY_TEXT);
    expect(isSensitivePath(stored, "read")).toBe("**/*.pem");
    expect(fsCalls.open).toEqual([stored]);
  });

  it("reads a harmless file stored under a decomposed name and finds no key in it", () => {
    fsCalls.decomposedNamesOnly = true;
    const stored = join(project, decomposed);
    writeFileSync(stored, "-----BEGIN CERTIFICATE-----\nFIXTURE\n-----END CERTIFICATE-----\n");
    expect(isSensitivePath(stored, "read")).toBe(null);
    expect(fsCalls.open).toEqual([stored]);
  });

  it("does not read a decomposed sibling when the composed operand is absent", () => {
    fsCalls.decomposedNamesOnly = true;
    writeFileSync(join(project, decomposed), "-----BEGIN CERTIFICATE-----\nFIXTURE\n-----END CERTIFICATE-----\n");
    expect(isSensitivePath(join(project, composed), "read")).toBeNull();
    expect(fsCalls.open).toEqual([]);
  });

  it("still refuses an unreadable exact stored file", () => {
    const named = join(project, decomposed);
    const backing = join(project, "stored-bytes");
    writeFileSync(backing, "certificate\n");
    fsCalls.storedAlias = { named, backing, unavailable: "unreadable" };
    expect(isSensitivePath(named, "read")).toBe("**/*.pem");
    expect(fsCalls.open).toEqual([named]);
  });

  it("follows a link beneath a folder stored under a decomposed name, and opens nothing it leads to outside the project", () => {
    fsCalls.decomposedNamesOnly = true;
    writeFileSync(join(outside, "server.pem"), "-----BEGIN CERTIFICATE-----\nFIXTURE\n-----END CERTIFICATE-----\n");
    symlinkSync(outside, join(project, "dossié"), "junction");
    expect(isSensitivePath(join(project, "dossié", "server.pem"), "read")).toBe("**/*.pem");
    expect(fsCalls.open).toEqual([]);
  });
});
