import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Use a recognizable ciphertext envelope so tests can distinguish encryption from plaintext persistence.
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
    // Canonicalize the root: macOS resolves /tmp to /private/tmp.
    const canonicalRoot = realpathSync(dataDir);
    expect(target.startsWith(canonicalRoot + sep)).toBe(true);
  });

  it("rejects writes through symlinks pointing outside the root", async () => {
    // A Windows directory junction exercises real traversal without symlink privileges.
    writeFileSync(join(outsideDir, "escape.txt"), "untouched", "utf-8");
    symlinkSync(outsideDir, join(dataDir, "escape"), dirLinkType);
    const s = createPluginStorage("p", dataDir, mockedElectron.safeStorage);
    await expect(s.write(join("escape", "escape.txt"), "tampered")).rejects.toThrow(
      /symlink escapes plugin storage root/,
    );
    expect(readFileSync(join(outsideDir, "escape.txt"), "utf-8")).toBe("untouched");
    expect(() => s.resolve("..", outsideDir.split(sep).pop()!, "escape.txt"))
      .toThrow(/escapes plugin storage root/);
  });

  it("rejects reads through symlinks pointing outside the root", async () => {
    writeFileSync(join(outsideDir, "secret.txt"), "shhh", "utf-8");
    symlinkSync(outsideDir, join(dataDir, "escape"), dirLinkType);
    const s = createPluginStorage("p", dataDir, mockedElectron.safeStorage);
    await expect(s.read(join("escape", "secret.txt"))).rejects.toThrow(/symlink escapes plugin storage root/);
    await expect(s.readText(join("escape", "secret.txt"))).rejects.toThrow(
      /symlink escapes plugin storage root/,
    );
  });

  it("rejects writes whose existing ancestor is a symlink to outside", async () => {
    // For a missing leaf, containment must reject an existing escaping ancestor before any write.
    symlinkSync(outsideDir, join(dataDir, "escape"), dirLinkType);
    const s = createPluginStorage("p", dataDir, mockedElectron.safeStorage);
    await expect(s.write("escape/payload.txt", "x")).rejects.toThrow(
      /symlink escapes plugin storage root/,
    );
  });

  it("rejects dangling symlinks (target doesn't exist)", async () => {
    // Fail closed on dangling links; their targets may be created later.
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

/** A storage root missing during an install swap is unavailable, not a sandbox escape. */
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
    const built = createPluginStorage("p", dataDir, mockedElectron.safeStorage);
    renameSync(dataDir, parked);
    try {
      await expect(built.writeJson("state.json", { a: 1 })).rejects.toThrow(
        /storage root is absent/,
      );
      // A per-request handle may receive an absent root; classify and audit it rather than leaking raw ENOENT.
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

/** Resolve trusted ancestors but refuse a root replaced by a link, even though storage is host-only. */
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
      // Unlink before teardown; recursive removal may follow a Windows junction.
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
    // Even host-only storage deletion must unlink planted links without touching their targets.
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
    // Encryption failure must never persist plaintext.
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
    await s.writeEncrypted("auth/token.enc", "secret");
    mockedElectron.enc.available = false;
    await expect(s.readEncrypted("auth/token.enc")).rejects.toBeInstanceOf(
      PluginStorageEncryptionUnavailableError,
    );
  });

  it("readEncrypted throws ENOENT for a missing file (matches readText)", async () => {
    const s = createPluginStorage("p", dataDir, mockedElectron.safeStorage);
    await expect(s.readEncrypted("missing.enc")).rejects.toMatchObject({ code: "ENOENT" });
  });

  // On POSIX, both plaintext and ciphertext storage require 0o700 directories and 0o600 files.
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
    const s = createPluginStorage("p", dataDir, mockedElectron.safeStorage);
    await expect(s.writeEncrypted("/etc/passwd", "x")).rejects.toThrow(
      /absolute paths are not allowed/,
    );
    await expect(s.readEncrypted(join("..", "escape.enc"))).rejects.toThrow(
      /escapes plugin storage root/,
    );

    writeFileSync(join(outsideDir, "loot.txt"), "untouched", "utf-8");
    symlinkSync(outsideDir, join(dataDir, "escape"), dirLinkType);
    await expect(s.writeEncrypted(join("escape", "loot.txt"), "tampered")).rejects.toThrow(
      /symlink escapes plugin storage root/,
    );
    expect(readFileSync(join(outsideDir, "loot.txt"), "utf-8")).toBe("untouched");
  });
});
