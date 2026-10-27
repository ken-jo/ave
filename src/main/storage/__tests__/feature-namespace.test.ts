import { canCreateSymlinks } from "../../../__tests__/support/symlink-capability.js";
/** Check namespace permissions, atomic writes, read defaults, child directories, and traversal rejection.
 * POSIX mode assertions do not apply on Windows. */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, statSync, writeFileSync, readdirSync, existsSync, symlinkSync, readFileSync, lstatSync, mkdirSync, promises as fs, renameSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  openFeatureNamespace,
  readJsonFile,
  writeJsonAtomic,
  writeFileAtomicAtPath,
  adoptLegacyRootFileSync,
} from "../feature-namespace.js";
import { cleanupTmpDir } from "../../../__tests__/support/tmp-dir-teardown.js";
import { ensureAveHomePrivate } from "../../../shared/ave-home.js";
import { setFixtureOwner } from "../../../__tests__/support/fixture-owner.js";
import { configureHostResources } from "../../host-resources.js";

const POSIX = process.platform !== "win32";

describe("feature-namespace", () => {
  let prevAveHome: string | undefined;
  let tempDir: string;

  beforeEach(() => {
    configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
    prevAveHome = process.env.AVE_HOME;
    tempDir = mkdtempSync(join(tmpdir(), "ave-feature-ns-"));
    setFixtureOwner(tempDir);
    process.env.AVE_HOME = tempDir;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (prevAveHome === undefined) {
      delete process.env.AVE_HOME;
    } else {
      process.env.AVE_HOME = prevAveHome;
    }
    await cleanupTmpDir(tempDir);
  });

  it("resolves dir to ~/.ave/<feature>/", () => {
    const ns = openFeatureNamespace("widgets");
    expect(ns.dir).toBe(join(tempDir, "widgets"));
  });

  it.runIf(process.platform === "win32")("asserts all boot-owned boundaries instead of creating them on write", async () => {
    for (const name of ["secrets", "subscription-runtimes", "keys", "certs", "config"]) {
      await expect(openFeatureNamespace(name).writeJson("state.json", {})).rejects.toThrow(`Protected boundary directory "${join(tempDir, name)}"`);
      expect(existsSync(join(tempDir, name))).toBe(false);
    }
  });
  it.runIf(process.platform === "win32")("asserts the boundary before either child creation path", async () => {
    const ns = openFeatureNamespace("subscription-runtimes");
    await expect(ns.childDir("nested/deep")).rejects.toThrow("boot must create it");
    await expect(ns.childDir("exclusive", { exclusive: true })).rejects.toThrow("boot must create it");
    expect(existsSync(ns.dir)).toBe(false);
  });
  it.runIf(process.platform === "win32")("asserts a missing boundary before legacy adoption", () => {
    const legacy = join(tempDir, "legacy.json");
    writeFileSync(legacy, "retained"); setFixtureOwner(legacy);
    expect(() => adoptLegacyRootFileSync("secrets", "adopted.json", "legacy.json")).toThrow("boot must create it");
    expect(existsSync(join(tempDir, "secrets"))).toBe(false);
    expect(readFileSync(legacy, "utf8")).toBe("retained");
  });
  it.runIf(process.platform === "win32")("does not recreate a boundary removed before nested creation", async () => {
    const home = join(tempDir, "home"); process.env.AVE_HOME = home;
    expect(ensureAveHomePrivate(home)).toMatchObject({ enforcement: "win32-dacl" });
    const boundary = join(home, "secrets");
    const mkdir = fs.mkdir.bind(fs);
    vi.spyOn(fs, "mkdir").mockImplementation((async (path, options) => {
      await fs.rmdir(boundary);
      return mkdir(path, options);
    }) as typeof fs.mkdir);
    await expect(openFeatureNamespace("secrets").childDir("nested/deep")).rejects.toMatchObject({ code: "ENOENT" });
    expect(existsSync(boundary)).toBe(false);
  });
  it.runIf(process.platform === "win32")("never asks mkdir to create the boundary as an exclusive child", async () => {
    const home = join(tempDir, "home"); process.env.AVE_HOME = home;
    expect(ensureAveHomePrivate(home)).toMatchObject({ enforcement: "win32-dacl" });
    const mkdir = vi.spyOn(fs, "mkdir");
    await expect(openFeatureNamespace("keys").childDir(".", { exclusive: true })).rejects.toMatchObject({ code: "EEXIST" });
    expect(mkdir).not.toHaveBeenCalled();
  });
  it.runIf(process.platform === "win32")("allows writes children and hardlink adoption after boot creates a boundary", async () => {
    const home = join(tempDir, "home"); process.env.AVE_HOME = home;
    expect(ensureAveHomePrivate(home)).toMatchObject({ enforcement: "win32-dacl" });
    const ns = openFeatureNamespace("secrets");
    await ns.writeJson("state.json", { ok: true });
    expect(await ns.readJson("state.json", {})).toEqual({ ok: true });
    expect(await ns.childDir("nested/deep")).toBe(join(ns.dir, "nested/deep"));
    expect(await ns.childDir("exclusive", { exclusive: true })).toBe(join(ns.dir, "exclusive"));
    writeFileSync(join(home, "legacy.json"), "legacy"); setFixtureOwner(join(home, "legacy.json"));
    adoptLegacyRootFileSync("secrets", "adopted.json", "legacy.json");
    expect(readFileSync(join(ns.dir, "adopted.json"), "utf8")).toBe("legacy");
    expect(existsSync(join(home, "legacy.json"))).toBe(false);
  });

  it("does not create the directory until first write", () => {
    openFeatureNamespace("lazy");
    expect(existsSync(join(tempDir, "lazy"))).toBe(false);
  });

  it("readJson returns the fallback when no file exists", async () => {
    const ns = openFeatureNamespace("widgets");
    const value = await ns.readJson("config.json", { count: 0 });
    expect(value).toEqual({ count: 0 });
  });

  it("writeJson → readJson round-trips", async () => {
    const ns = openFeatureNamespace("widgets");
    await ns.writeJson("config.json", { count: 7, label: "x" });
    const value = await ns.readJson("config.json", { count: 0, label: "" });
    expect(value).toEqual({ count: 7, label: "x" });
  });

  it("readJson falls back on corrupt JSON (parse-with-fallback)", async () => {
    const ns = openFeatureNamespace("widgets");
    await ns.writeJson("config.json", { ok: true });
    writeFileSync(join(tempDir, "widgets", "config.json"), "{ not json", "utf-8");
    const value = await ns.readJson("config.json", { ok: false });
    expect(value).toEqual({ ok: false });
  });

  it("enforces 0o700 dir + 0o600 file modes (POSIX only)", async () => {
    if (!POSIX) return;
    const ns = openFeatureNamespace("widgets");
    await ns.writeJson("config.json", { a: 1 });
    const dirMode = statSync(join(tempDir, "widgets")).mode & 0o777;
    const fileMode = statSync(join(tempDir, "widgets", "config.json")).mode & 0o777;
    expect(dirMode).toBe(0o700);
    expect(fileMode).toBe(0o600);
  });

  it("tightens a pre-existing wider directory back to 0o700 (POSIX only)", async () => {
    if (!POSIX) return;
    const { mkdirSync, chmodSync } = await import("node:fs");
    const dir = join(tempDir, "widgets");
    mkdirSync(dir, { recursive: true, mode: 0o755 });
    chmodSync(dir, 0o755);
    const ns = openFeatureNamespace("widgets");
    await ns.writeJson("config.json", { a: 1 });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });

  it("leaves no .tmp sibling after a completed write (atomic)", async () => {
    const ns = openFeatureNamespace("widgets");
    await ns.writeJson("config.json", { a: 1 });
    const entries = readdirSync(join(tempDir, "widgets"));
    expect(entries).toEqual(["config.json"]);
  });

  it.skipIf(!canCreateSymlinks())("does not write through a symlink planted at the staging path", async () => {
    // The staging name was a FIXED `${target}.tmp`. Anything that could predict the target could therefore plant that path first, and `fs.writeFile` follows a symlink: the payload landed at the planter's destination
    // and the subsequent `rename` moved the LINK over the live path, leaving `~/.ave/<feature>/<file>` pointing wherever they chose. A random name plus O_CREAT|O_EXCL means the writer never opens a path that exists.
    const featureDir = join(tempDir, "widgets");
    mkdirSync(featureDir, { recursive: true, mode: 0o700 });
    const target = join(featureDir, "config.json");
    const outside = join(tempDir, "attacker-owned.json");
    writeFileSync(outside, "untouched");
    const predictableStaging = `${target}.tmp`;
    symlinkSync(outside, predictableStaging);

    await writeFileAtomicAtPath(target, "fresh");

    expect(readFileSync(target, "utf-8")).toBe("fresh");
    // Nothing was written through the link, and the link was not renamed onto the live path.
    expect(readFileSync(outside, "utf-8")).toBe("untouched");
    expect(lstatSync(predictableStaging).isSymbolicLink()).toBe(true);
    expect(lstatSync(target).isSymbolicLink()).toBe(false);
  });

  it("gives two concurrent writers to one target their own staging file", async () => {
    // With a fixed `${target}.tmp` both writers staged into the same file and both renamed it, so the survivor could hold either
    // payload or a splice of the two. work-board-store and routines-store both route here, so that was two live stores under ~/.ave.
    const featureDir = join(tempDir, "widgets");
    mkdirSync(featureDir, { recursive: true, mode: 0o700 });
    const target = join(featureDir, "shared.json");
    const a = "A".repeat(200_000);
    const b = "B".repeat(200_000);
    await Promise.all([
      writeFileAtomicAtPath(target, a),
      writeFileAtomicAtPath(target, b),
    ]);
    expect([a, b]).toContain(readFileSync(target, "utf-8"));
    expect(readdirSync(featureDir)).toEqual(["shared.json"]);
  });

  it("leaves no staging file behind when the write fails", async () => {
    const featureDir = join(tempDir, "widgets");
    mkdirSync(featureDir, { recursive: true, mode: 0o700 });
    const target = join(featureDir, "config.json");
    // A directory at the target makes `rename` fail after the bytes are staged.
    mkdirSync(target, { recursive: true });
    await expect(writeFileAtomicAtPath(target, "fresh")).rejects.toThrow();
    expect(readdirSync(featureDir)).toEqual(["config.json"]);
  });

  it("childDir materializes a 0o700 subdirectory", async () => {
    const ns = openFeatureNamespace("widgets");
    const child = await ns.childDir("sessions");
    expect(child).toBe(join(tempDir, "widgets", "sessions"));
    expect(statSync(child).isDirectory()).toBe(true);
    if (POSIX) {
      expect(statSync(child).mode & 0o777).toBe(0o700);
    }
  });

  it("exclusive childDir refuses an existing slot while ordinary childDir reuses it", async () => {
    const ns = openFeatureNamespace("widgets");
    const child = await ns.childDir("invocation", { exclusive: true });
    expect(statSync(child).isDirectory()).toBe(true);
    if (POSIX) expect(statSync(child).mode & 0o777).toBe(0o700);
    writeFileSync(join(child, "original"), "retained");
    await expect(ns.childDir("invocation", { exclusive: true })).rejects.toMatchObject({ code: "EEXIST" });
    expect(await ns.childDir("invocation")).toBe(child);
    expect(readFileSync(join(child, "original"), "utf8")).toBe("retained");
  });

  it.skipIf(!POSIX)("exclusive childDir never chmods a symbolic replacement after mkdir", async () => {
    const ns = openFeatureNamespace("widgets");
    const outside = join(tempDir, "outside");
    mkdirSync(outside, { mode: 0o755 });
    const originalMode = statSync(outside).mode & 0o777;
    const child = join(ns.dir, "invocation");
    const mkdir = fs.mkdir.bind(fs);
    vi.spyOn(fs, "mkdir").mockImplementation((async (
      path: Parameters<typeof fs.mkdir>[0], options?: Parameters<typeof fs.mkdir>[1],
    ) => {
      const result = await mkdir(path, options);
      if (String(path).endsWith("/invocation")) {
        renameSync(child, `${child}-previous`);
        symlinkSync(outside, child, "dir");
      }
      return result;
    }) as typeof fs.mkdir);
    await expect(ns.childDir("invocation", { exclusive: true })).rejects.toThrow();
    expect(statSync(outside).mode & 0o777).toBe(originalMode);
    expect(lstatSync(child).isSymbolicLink()).toBe(true);
    expect(readdirSync(outside)).toEqual([]);
  });

  it("rejects path-traversal feature ids", () => {
    expect(() => openFeatureNamespace("../escape")).toThrow(/invalid featureId/);
    expect(() => openFeatureNamespace("a/b")).toThrow(/invalid featureId/);
    expect(() => openFeatureNamespace("")).toThrow(/invalid featureId/);
  });

  it("writeFileAtomicAtPath writes raw (non-JSON) bytes with 0o600 + 0o700 parent", async () => {
    const filePath = join(tempDir, "raw-feature", "note.md");
    await writeFileAtomicAtPath(filePath, "# hello\n");
    const { readFileSync } = await import("node:fs");
    expect(readFileSync(filePath, "utf-8")).toBe("# hello\n");
    expect(readdirSync(join(tempDir, "raw-feature"))).toEqual(["note.md"]);
    if (POSIX) {
      expect(statSync(filePath).mode & 0o777).toBe(0o600);
      expect(statSync(join(tempDir, "raw-feature")).mode & 0o777).toBe(0o700);
    }
  });

  it("readJsonFile returns the fallback for a missing path", async () => {
    const value = await readJsonFile(join(tempDir, "missing.json"), { raw: "fallback" });
    expect(value).toEqual({ raw: "fallback" });
  });

  it("writeJsonAtomic overwrites an existing file in place", async () => {
    const dir = join(tempDir, "widgets");
    await writeJsonAtomic(dir, "config.json", { v: 1 });
    await writeJsonAtomic(dir, "config.json", { v: 2 });
    const value = await readJsonFile(join(dir, "config.json"), { v: 0 });
    expect(value).toEqual({ v: 2 });
  });

  describe("adoptLegacyRootFileSync", () => {
    const FEATURE = "skills";
    const DEST = "approvals.json";
    const LEGACY = "skill-approvals.json";
    const payload = JSON.stringify({ version: 2, approvedSkills: [{ name: "a" }] });

    it("moves a legacy root file into the feature namespace and removes the original", () => {
      writeFileSync(join(tempDir, LEGACY), payload);

      adoptLegacyRootFileSync(FEATURE, DEST, LEGACY);

      const dest = join(tempDir, FEATURE, DEST);
      expect(readFileSync(dest, "utf-8")).toBe(payload);
      // Removing the original is the point: a domain-owned file left in the root is exactly what defeats per-domain backup and clear.
      expect(existsSync(join(tempDir, LEGACY))).toBe(false);
      if (POSIX) {
        expect(statSync(join(tempDir, FEATURE)).mode & 0o777).toBe(0o700);
        expect(statSync(dest).mode & 0o777).toBe(0o600);
      }
    });

    it("does nothing when there is no legacy file", () => {
      adoptLegacyRootFileSync(FEATURE, DEST, LEGACY);
      expect(existsSync(join(tempDir, FEATURE, DEST))).toBe(false);
    });

    it("never overwrites an existing destination, and leaves the legacy alone", () => {
      // The destination's existence is the idempotency marker, so a store may call this on every load. If it
      // could overwrite, a second call after a downgrade-and-rerun would clobber current data with a stale copy.
      mkdirSync(join(tempDir, FEATURE), { recursive: true });
      writeFileSync(join(tempDir, FEATURE, DEST), '{"current":true}');
      writeFileSync(join(tempDir, LEGACY), payload);

      adoptLegacyRootFileSync(FEATURE, DEST, LEGACY);

      expect(readFileSync(join(tempDir, FEATURE, DEST), "utf-8")).toBe('{"current":true}');
      expect(existsSync(join(tempDir, LEGACY))).toBe(true);
    });

    it("is idempotent across repeated calls", () => {
      writeFileSync(join(tempDir, LEGACY), payload);
      adoptLegacyRootFileSync(FEATURE, DEST, LEGACY);
      adoptLegacyRootFileSync(FEATURE, DEST, LEGACY);
      adoptLegacyRootFileSync(FEATURE, DEST, LEGACY);
      expect(readFileSync(join(tempDir, FEATURE, DEST), "utf-8")).toBe(payload);
    });

    it("ignores a legacy path that is a directory rather than a file", () => {
      mkdirSync(join(tempDir, LEGACY), { recursive: true });
      adoptLegacyRootFileSync(FEATURE, DEST, LEGACY);
      expect(existsSync(join(tempDir, FEATURE, DEST))).toBe(false);
      expect(statSync(join(tempDir, LEGACY)).isDirectory()).toBe(true);
    });

    it("rejects a traversing feature id", () => {
      expect(() => adoptLegacyRootFileSync("../escape", DEST, LEGACY)).toThrow(/invalid featureId/);
    });
  });
});
