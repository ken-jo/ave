/**
 * Sandboxed PluginStorage — verifies path-traversal guards, ENOENT handling,
 * and JSON helpers stay scoped to the host-only storage root.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Reversible fake safeStorage seam. `encryptString` wraps the plaintext in a
// recognizable envelope (so the on-disk bytes are demonstrably NOT plaintext),
// `decryptString` unwraps it; `enc.available` toggles the isEncryptionAvailable
// gate per test. Mirrors the settings-store.test.ts electron-mock pattern.
const mockedElectron = vi.hoisted(() => {
  const enc = { available: true };
  return {
    enc,
    safeStorage: {
      getSelectedStorageBackend: () => "gnome_libsecret" as const,
      isEncryptionAvailable: vi.fn(() => enc.available),
      encryptString: vi.fn((s: string) => Buffer.from(`ENC(${s})`, "utf-8")),
      decryptString: vi.fn((b: Buffer) => {
        const raw = Buffer.from(b).toString("utf-8");
        const m = /^ENC\(([\s\S]*)\)$/.exec(raw);
        if (!m) throw new Error("decryptString: not ciphertext produced by this seam");
        return m[1];
      }),
    },
  };
});
vi.mock("electron", () => ({ safeStorage: mockedElectron.safeStorage }));

import { createPluginStorage } from "../storage.js";
import { ensurePluginDataDir } from "../runtime/sandbox.js";
import { PluginStorageEncryptionUnavailableError } from "../types.js";
import { cleanupTmpDir, removeLinkOnly } from "../../__tests__/support/tmp-dir-teardown.js";

const dirLinkType = process.platform === "win32" ? "junction" : "dir";

let dataDir: string;
let outsideDir: string;

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "ave-plugin-storage-data-"));
  outsideDir = mkdtempSync(join(tmpdir(), "ave-plugin-storage-outside-"));
});

afterEach(async () => {
  await Promise.all([cleanupTmpDir(dataDir), cleanupTmpDir(outsideDir)]);
});

describe("createPluginStorage path guards", () => {
  it("rejects absolute paths", () => {
    const s = createPluginStorage("p", dataDir, mockedElectron.safeStorage);
    expect(() => s.resolve("/etc/passwd")).toThrow(/absolute paths are not allowed/);
  });

  it("rejects relative paths that escape via ..", () => {
    const s = createPluginStorage("p", dataDir, mockedElectron.safeStorage);
    expect(() => s.resolve("..", "evil.txt")).toThrow(/escapes plugin storage root/);
    expect(() => s.resolve("nested", "..", "..", "evil.txt")).toThrow(/escapes plugin storage root/);
  });

  it("allows paths inside the root", () => {
    const s = createPluginStorage("p", dataDir, mockedElectron.safeStorage);
    const target = s.resolve("subdir", "file.txt");
    // Compare against the canonical root (mkdtemp on macOS lives under /tmp,
    // which realpath resolves to /private/tmp).
    const canonicalRoot = realpathSync(dataDir);
    expect(target.startsWith(canonicalRoot + sep)).toBe(true);
  });

  it("rejects writes through symlinks pointing outside the root", async () => {
    // Create a real escape target inside outsideDir, then plant a directory
    // symlink/junction inside dataDir that points to outsideDir. Windows can
    // create junctions without Developer Mode or SeCreateSymbolicLinkPrivilege,
    // so this still exercises real reparse-point traversal locally.
    writeFileSync(join(outsideDir, "escape.txt"), "untouched", "utf-8");
    symlinkSync(outsideDir, join(dataDir, "escape"), dirLinkType);
    const s = createPluginStorage("p", dataDir, mockedElectron.safeStorage);
    // The realpath of `escape/escape.txt` resolves outside the root → reject.
    await expect(s.write(join("escape", "escape.txt"), "tampered")).rejects.toThrow(
      /symlink escapes plugin storage root/,
    );
    // The escape target on disk must remain untouched.
    expect(readFileSync(join(outsideDir, "escape.txt"), "utf-8")).toBe("untouched");
    // Direct attempts to traverse through the link path should be rejected.
    expect(() => s.resolve("..", outsideDir.split(sep).pop()!, "escape.txt"))
      .toThrow(/escapes plugin storage root/);
  });

  it("rejects reads through symlinks pointing outside the root", async () => {
    // Plant a directory symlink/junction inside dataDir whose realpath escapes
    // via outsideDir.
    writeFileSync(join(outsideDir, "secret.txt"), "shhh", "utf-8");
    symlinkSync(outsideDir, join(dataDir, "escape"), dirLinkType);
    const s = createPluginStorage("p", dataDir, mockedElectron.safeStorage);
    await expect(s.read(join("escape", "secret.txt"))).rejects.toThrow(/symlink escapes plugin storage root/);
    await expect(s.readText(join("escape", "secret.txt"))).rejects.toThrow(
      /symlink escapes plugin storage root/,
    );
  });

  it("rejects writes whose existing ancestor is a symlink to outside", async () => {
    // The new file (`payload.txt`) doesn't exist yet, but its closest
    // existing ancestor (`escape/`) is a symlink whose realpath points
    // outside the root. The realpath check must climb up to the symlink
    // and reject before any write touches disk.
    symlinkSync(outsideDir, join(dataDir, "escape"), dirLinkType);
    const s = createPluginStorage("p", dataDir, mockedElectron.safeStorage);
    await expect(s.write("escape/payload.txt", "x")).rejects.toThrow(
      /symlink escapes plugin storage root/,
    );
  });

  it("rejects dangling symlinks (target doesn't exist)", async () => {
    // Plant a symlink inside dataDir whose *target* does not exist. realpath
    // raises ENOENT (because the chain is broken) but lstat sees the
    // symlink. The host cannot validate where the symlink would resolve, so
    // it must fail closed — otherwise a plugin could plant a dangling link
    // whose target is created later out of band.
    const danglingRel = process.platform === "win32" ? join("dangling", "payload.txt") : "dangling.txt";
    symlinkSync(
      join(outsideDir, "does-not-exist"),
      join(dataDir, process.platform === "win32" ? "dangling" : "dangling.txt"),
      process.platform === "win32" ? "junction" : undefined,
    );
    const s = createPluginStorage("p", dataDir, mockedElectron.safeStorage);
    await expect(s.write(danglingRel, "x")).rejects.toThrow(/dangling symlink/);
    await expect(s.read(danglingRel)).rejects.toThrow(/dangling symlink/);
    await expect(s.exists(danglingRel)).rejects.toThrow(/dangling symlink/);
  });
});

/**
 * What an install swap looks like from inside a live storage handle. The swap
 * renames the plugin root aside, renames the promoted payload into its place,
 * and carries `data/` in last — so for those few syscalls the data root this
 * handle was built for is not on disk. A call landing there must be refused,
 * and refused for the right reason: it is not a sandbox escape, and auditing
 * it as one sends whoever reads the log looking for a planted symlink.
 */
describe("createPluginStorage — the data root is never recreated", () => {
  it("refuses a write once the data root has been renamed away, and leaves it absent", async () => {
    const s = createPluginStorage("p", dataDir, mockedElectron.safeStorage);
    const parked = `${dataDir}-parked`;
    renameSync(dataDir, parked);
    try {
      await expect(s.writeJson("state.json", { sessions: 1 })).rejects.toThrow(
        /storage root is absent/,
      );
      await expect(s.write("nested/blob.bin", "bytes")).rejects.toThrow(/storage root is absent/);
      await expect(s.mkdir("nested")).rejects.toThrow(/storage root is absent/);
      expect(existsSync(dataDir)).toBe(false);
    } finally {
      renameSync(parked, dataDir);
    }
  });

  it("refuses the same way whether the root went missing before or after construction", async () => {
    const parked = `${dataDir}-parked`;
    // AFTER construction: the handle exists, the root moves under it.
    const built = createPluginStorage("p", dataDir, mockedElectron.safeStorage);
    renameSync(dataDir, parked);
    try {
      await expect(built.writeJson("state.json", { a: 1 })).rejects.toThrow(
        /storage root is absent/,
      );
      // BEFORE construction: `getPluginStorage` resolves rather than ensures,
      // so it hands an absent directory here on purpose. Same classified,
      // audited refusal — not a raw ENOENT about a path.
      const rejections: string[] = [];
      expect(() => createPluginStorage("p", dataDir, mockedElectron.safeStorage, (message) => {
        rejections.push(message);
      })).toThrow(/storage root is absent/);
      expect(rejections).toEqual(["storage: rejected operation against an absent storage root"]);
    } finally {
      renameSync(parked, dataDir);
    }
  });

  it("still names a real symlink escape a symlink escape", async () => {
    symlinkSync(outsideDir, join(dataDir, "link"), dirLinkType);
    const s = createPluginStorage("p", dataDir, mockedElectron.safeStorage);
    await expect(s.writeJson("link/state.json", { a: 1 })).rejects.toThrow(
      /symlink escapes plugin storage root/,
    );
  });

  it("creates directories BENEATH an existing data root as before", async () => {
    const s = createPluginStorage("p", dataDir, mockedElectron.safeStorage);
    await s.writeJson("nested/deep/state.json", { ok: true });
    expect(existsSync(join(dataDir, "nested", "deep", "state.json"))).toBe(true);
  });
});

/**
 * The root's ancestors are trusted host paths and are resolved; the root itself
 * must be the real directory the host created. No confined child can write the
 * host-only storage root or the plugin root above it; a handle is built per
 * request, so as defense in depth a root that became a link must still not
 * become the canonical root of the next handle.
 */
describe("createPluginStorage — the data root itself is the host's directory", () => {
  it("refuses a root a plugin replaced with a link after the host created it, and writes nothing outside", () => {
    rmSync(dataDir, { recursive: true });
    symlinkSync(outsideDir, dataDir, dirLinkType);
    try {
      const rejections: string[] = [];
      expect(() => createPluginStorage("p", dataDir, mockedElectron.safeStorage, (message) => {
        rejections.push(message);
      })).toThrow(/\[plugin-storage:p\] plugin storage root is a symlink, not the directory the host created/);
      expect(rejections).toEqual(["storage: rejected a storage root that is not the host's directory"]);
      expect(readdirSync(outsideDir)).toEqual([]);
    } finally {
      // The link goes on its own, before the recursive teardown can reach it:
      // on Windows a recursive removal walks into a junction's target.
      removeLinkOnly(dataDir);
    }
  });

  it("refuses a dangling link in the root's place rather than calling the root absent", () => {
    rmSync(dataDir, { recursive: true });
    symlinkSync(join(outsideDir, "absent"), dataDir, dirLinkType);
    try {
      expect(() => createPluginStorage("p", dataDir, mockedElectron.safeStorage))
        .toThrow(/plugin storage root is a symlink/);
      expect(existsSync(join(outsideDir, "absent"))).toBe(false);
    } finally {
      removeLinkOnly(dataDir);
    }
  });

  it("resolves a root reached through a linked ancestor", async () => {
    const realData = join(outsideDir, "volume", "data");
    mkdirSync(realData, { recursive: true });
    const linkedAncestor = `${dataDir}-ancestor`;
    symlinkSync(join(outsideDir, "volume"), linkedAncestor, dirLinkType);
    try {
      const s = createPluginStorage("p", join(linkedAncestor, "data"), mockedElectron.safeStorage);
      await s.writeJson("state.json", { ok: true });
      expect(existsSync(join(realData, "state.json"))).toBe(true);
    } finally {
      removeLinkOnly(linkedAncestor);
    }
  });

  it("is held to the same check at load: a missing root is created, a linked one is refused", () => {
    const pluginsRoot = join(dataDir, "plugins");
    expect(ensurePluginDataDir("fresh", join(pluginsRoot, "fresh", "current"), pluginsRoot))
      .toBe(join(pluginsRoot, "fresh", "data"));
    expect(existsSync(join(pluginsRoot, "fresh", "data"))).toBe(true);
    expect(statSync(join(pluginsRoot, "fresh", "storage")).isDirectory()).toBe(true);
    mkdirSync(join(pluginsRoot, "taken"), { recursive: true });
    symlinkSync(outsideDir, join(pluginsRoot, "taken", "data"), dirLinkType);
    try {
      expect(() => ensurePluginDataDir("taken", join(pluginsRoot, "taken", "current"), pluginsRoot))
        .toThrow(/plugin 'taken': the plugin data root .* is a symlink, not the directory the host created/);
      expect(readdirSync(outsideDir)).toEqual([]);
    } finally {
      removeLinkOnly(join(pluginsRoot, "taken", "data"));
    }
  });
});

describe("ensurePluginDataDir — the host-only storage root", () => {
  it("creates the storage root beside an existing but empty data root", () => {
    const pluginsRoot = join(dataDir, "plugins");
    mkdirSync(join(pluginsRoot, "empty", "data"), { recursive: true });
    ensurePluginDataDir("empty", join(pluginsRoot, "empty", "current"), pluginsRoot);
    expect(statSync(join(pluginsRoot, "empty", "storage")).isDirectory()).toBe(true);
  });

  it("refuses to invent an empty storage root while data/ holds state the migration has not copied", () => {
    const pluginsRoot = join(dataDir, "plugins");
    mkdirSync(join(pluginsRoot, "legacy", "data"), { recursive: true });
    writeFileSync(join(pluginsRoot, "legacy", "data", "session-snapshot.json"), "{}");
    expect(() => ensurePluginDataDir("legacy", join(pluginsRoot, "legacy", "current"), pluginsRoot))
      .toThrow(/storage is missing while .*data holds state; the boot migration creates it/);
    expect(existsSync(join(pluginsRoot, "legacy", "storage"))).toBe(false);
  });

  it("refuses a storage root that is a link, and writes nothing through it", () => {
    const pluginsRoot = join(dataDir, "plugins");
    mkdirSync(join(pluginsRoot, "linked", "data"), { recursive: true });
    symlinkSync(outsideDir, join(pluginsRoot, "linked", "storage"), dirLinkType);
    try {
      expect(() => ensurePluginDataDir("linked", join(pluginsRoot, "linked", "current"), pluginsRoot))
        .toThrow(/is a symlink, not the directory the host created/);
      expect(readdirSync(outsideDir)).toEqual([]);
    } finally {
      removeLinkOnly(join(pluginsRoot, "linked", "storage"));
    }
  });
});

describe("createPluginStorage I/O", () => {
  it("writes and reads bytes / text round-trip", async () => {
    const s = createPluginStorage("p", dataDir, mockedElectron.safeStorage);
    await s.write("a/b/c.txt", "hello");
    expect(await s.readText("a/b/c.txt")).toBe("hello");
    const bytes = await s.read("a/b/c.txt");
    expect(Buffer.from(bytes).toString("utf-8")).toBe("hello");
  });

  it("readJson returns null on missing file, throws on malformed", async () => {
    const s = createPluginStorage("p", dataDir, mockedElectron.safeStorage);
    expect(await s.readJson("missing.json")).toBeNull();
    await s.write("bad.json", "{not-json", "utf-8");
    await expect(s.readJson("bad.json")).rejects.toThrow();
  });

  it("writeJson + readJson round-trip", async () => {
    const s = createPluginStorage("p", dataDir, mockedElectron.safeStorage);
    const value = { name: "meeting", count: 3, nested: { ok: true } };
    await s.writeJson("state.json", value);
    expect(await s.readJson("state.json")).toEqual(value);
  });

  it("rm removes files; recursive removes trees; missing is no-op", async () => {
    const s = createPluginStorage("p", dataDir, mockedElectron.safeStorage);
    await s.write("a/b/c.txt", "x");
    await s.write("f.txt", "x");
    await s.rm("a", { recursive: true });
    await s.rm("f.txt");
    expect(await s.exists("a")).toBe(false);
    expect(await s.exists("f.txt")).toBe(false);
    await expect(s.rm("missing")).resolves.toBeUndefined();
    await expect(s.rm("missing", { recursive: true })).resolves.toBeUndefined();
  });

  it("a recursive rm removes a link inside the tree without following it", async () => {
    // No confined child can write the storage root, so a link here could only
    // come from the host itself; the recursive delete still unlinks it rather
    // than emptying what it points at.
    writeFileSync(join(outsideDir, "keep"), "keep");
    const s = createPluginStorage("p", dataDir, mockedElectron.safeStorage);
    await s.write("a/c.txt", "x");
    symlinkSync(outsideDir, join(dataDir, "a", "link"), dirLinkType);
    await s.rm("a", { recursive: true });
    expect(existsSync(join(dataDir, "a"))).toBe(false);
    expect(readdirSync(outsideDir)).toEqual(["keep"]);
  });

  it("list returns empty array for missing dir", async () => {
    const s = createPluginStorage("p", dataDir, mockedElectron.safeStorage);
    expect(await s.list("does-not-exist")).toEqual([]);
  });

  it("mkdir creates nested directories", async () => {
    const s = createPluginStorage("p", dataDir, mockedElectron.safeStorage);
    await s.mkdir("deeply/nested/folder");
    expect(await s.exists("deeply/nested/folder")).toBe(true);
  });
});

describe("createPluginStorage error shape", () => {
  it("PluginStorageError carries pluginId + attempted path", () => {
    const s = createPluginStorage("meeting", dataDir, mockedElectron.safeStorage);
    try {
      s.resolve("..", "outside.txt");
      throw new Error("should have thrown");
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("plugin-storage:meeting");
      expect(message).toContain("..");
    }
  });
});

describe("createPluginStorage encrypted-at-rest variants", () => {
  beforeEach(() => {
    mockedElectron.enc.available = true;
    mockedElectron.safeStorage.encryptString.mockClear();
    mockedElectron.safeStorage.decryptString.mockClear();
  });

  it("writeEncrypted → readEncrypted round-trips through safeStorage and never writes plaintext", async () => {
    const s = createPluginStorage("p", dataDir, mockedElectron.safeStorage);
    const secret = "s3cr3t-token-値";
    await s.writeEncrypted("auth/token.enc", secret);

    expect(mockedElectron.safeStorage.encryptString).toHaveBeenCalledWith(secret);
    // On-disk bytes are the ciphertext envelope, NOT the plaintext.
    const onDisk = readFileSync(join(dataDir, "auth", "token.enc"), "utf-8");
    expect(onDisk).toBe(`ENC(${secret})`);
    expect(onDisk).not.toBe(secret);

    expect(await s.readEncrypted("auth/token.enc")).toBe(secret);
  });

  it("writeEncrypted fails closed when encryption is unavailable and creates NO file", async () => {
    mockedElectron.enc.available = false;
    const s = createPluginStorage("p", dataDir, mockedElectron.safeStorage);
    await expect(s.writeEncrypted("nope.enc", "secret")).rejects.toBeInstanceOf(
      PluginStorageEncryptionUnavailableError,
    );
    // The plaintext was never persisted (no-fallback rule).
    expect(existsSync(join(dataDir, "nope.enc"))).toBe(false);
    expect(mockedElectron.safeStorage.encryptString).not.toHaveBeenCalled();
  });

  it("the thrown error carries the stable kebab-case code", async () => {
    mockedElectron.enc.available = false;
    const s = createPluginStorage("meeting", dataDir, mockedElectron.safeStorage);
    await s.writeEncrypted("x.enc", "y").catch((err: unknown) => {
      expect(err).toBeInstanceOf(PluginStorageEncryptionUnavailableError);
      expect((err as PluginStorageEncryptionUnavailableError).code).toBe("encryption-unavailable");
      expect((err as Error).name).toBe("PluginStorageEncryptionUnavailableError");
    });
  });

  it("readEncrypted fails closed when encryption is unavailable (even if the file exists)", async () => {
    const s = createPluginStorage("p", dataDir, mockedElectron.safeStorage);
    await s.writeEncrypted("auth/token.enc", "secret"); // encryption available here
    mockedElectron.enc.available = false;
    await expect(s.readEncrypted("auth/token.enc")).rejects.toBeInstanceOf(
      PluginStorageEncryptionUnavailableError,
    );
  });

  it("readEncrypted throws ENOENT for a missing file (matches readText)", async () => {
    const s = createPluginStorage("p", dataDir, mockedElectron.safeStorage);
    await expect(s.readEncrypted("missing.enc")).rejects.toMatchObject({ code: "ENOENT" });
  });

  // POSIX-only: mode bits are meaningful on mac/linux, a no-op on Windows.
  // Pins the storage-namespace rule (0o700 dir / 0o600 file) so the secret
  // ciphertext can never regress to world/group-readable — and asserts the same
  // uniform rule for the plaintext writers + explicit mkdir.
  it.skipIf(process.platform === "win32")(
    "created files are 0o600 inside 0o700 dirs (encrypted + plaintext, POSIX)",
    async () => {
      const s = createPluginStorage("p", dataDir, mockedElectron.safeStorage);
      await s.writeEncrypted("auth/token.enc", "secret");
      expect(statSync(join(dataDir, "auth", "token.enc")).mode & 0o777).toBe(0o600);
      expect(statSync(join(dataDir, "auth")).mode & 0o777).toBe(0o700);

      await s.write("plain/notes.txt", "hi");
      expect(statSync(join(dataDir, "plain", "notes.txt")).mode & 0o777).toBe(0o600);
      expect(statSync(join(dataDir, "plain")).mode & 0o777).toBe(0o700);

      await s.mkdir("madedir");
      expect(statSync(join(dataDir, "madedir")).mode & 0o777).toBe(0o700);
    },
  );

  it("path-escape rejection applies to the encrypted variants too", async () => {
    // Absolute + lexical .. escapes.
    const s = createPluginStorage("p", dataDir, mockedElectron.safeStorage);
    await expect(s.writeEncrypted("/etc/passwd", "x")).rejects.toThrow(
      /absolute paths are not allowed/,
    );
    await expect(s.readEncrypted(join("..", "escape.enc"))).rejects.toThrow(
      /escapes plugin storage root/,
    );

    // Symlink escape: planting a junction inside dataDir that points outside.
    writeFileSync(join(outsideDir, "loot.txt"), "untouched", "utf-8");
    symlinkSync(outsideDir, join(dataDir, "escape"), dirLinkType);
    await expect(s.writeEncrypted(join("escape", "loot.txt"), "tampered")).rejects.toThrow(
      /symlink escapes plugin storage root/,
    );
    expect(readFileSync(join(outsideDir, "loot.txt"), "utf-8")).toBe("untouched");
  });
});
