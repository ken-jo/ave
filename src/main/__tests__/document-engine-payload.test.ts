import { createHash } from "node:crypto";
import { appendFile, chmod, link, mkdir, mkdtemp, open, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canCreateSymlinks } from "../../__tests__/support/symlink-capability.js";
import { assertDocumentEngineArchiveUnchanged, assertDocumentEnginePathIdentities, captureDocumentEnginePathIdentity,
  documentEngineTreeDigest, readDocumentEngineIdentityDigest, readDocumentEngineTree } from "../document-engine-payload.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });
async function root() { const path = await mkdtemp(join(tmpdir(), "ave-engine-tree-")); roots.push(path); return path; }

describe("authenticated document engine payloads", () => {
  it("includes every dependency and refuses mutation after the content hash is captured", async () => {
    const path = await root(); await mkdir(join(path, "program"));
    const file = join(path, "program", "dependency"); await writeFile(file, "expected");
    const identities: ReturnType<typeof captureDocumentEnginePathIdentity>[] = [];
    const before = await readDocumentEngineTree(path, new AbortController().signal, (identity) => identities.push(identity));
    expect(() => assertDocumentEnginePathIdentities(identities)).not.toThrow();
    await writeFile(file, "modified");
    expect(() => assertDocumentEnginePathIdentities(identities)).toThrow("identity changed");
    expect(documentEngineTreeDigest(await readDocumentEngineTree(path, new AbortController().signal))).not.toBe(documentEngineTreeDigest(before));
  });

  it("rejects unexpected hard links even when their bytes match", async () => {
    const path = await root(); const file = join(path, "program"); await writeFile(file, "same bytes");
    await link(file, join(path, "alias"));
    await expect(readDocumentEngineTree(path, new AbortController().signal)).rejects.toThrow("hard link");
  });

  it("rejects payload links outside the authenticated root", async (context) => {
    if (!canCreateSymlinks("file")) context.skip("Symlink creation requires an unavailable privilege");
    const path = await root(); await symlink("../outside", join(path, "escape"));
    await expect(readDocumentEngineTree(path, new AbortController().signal)).rejects.toThrow("leaves its root");
  });

  describe("release archive identity across an external reader", () => {
    const pinned = "pinned archive bytes";
    const sha256 = createHash("sha256").update(pinned).digest("hex");
    const seconds = 1_700_000_000;
    async function heldArchive() {
      const path = join(await root(), "release.dmg");
      await writeFile(path, pinned); await chmod(path, 0o600); await utimes(path, seconds, seconds);
      const held = await open(path, "r");
      return { path, held, identity: captureDocumentEnginePathIdentity(path, "archive") };
    }
    async function settleCtime(): Promise<void> { await new Promise((resolve) => setTimeout(resolve, 20)); }

    it("admits a metadata-only change (an xattr write moves only ctime) after rehashing the held descriptor", async () => {
      const { path, held, identity } = await heldArchive();
      try {
        const before = await stat(path, { bigint: true });
        await settleCtime();
        // A no-op chmod bumps ctime on POSIX, but win32 chmod maps only the read-only bit, so
        // re-applying the existing 0o600 changes nothing there. Toggle the read-only attribute and
        // restore it to produce a real metadata-only change that moves ChangeTime without mtime/size.
        if (process.platform === "win32") { await chmod(path, 0o444); await chmod(path, 0o600); }
        else { await chmod(path, 0o600); }
        const after = await stat(path, { bigint: true });
        expect(after.ctimeNs).not.toBe(before.ctimeNs);
        expect(after.mtimeNs).toBe(before.mtimeNs);
        await expect(assertDocumentEngineArchiveUnchanged(held, identity, sha256)).resolves.toBeUndefined();
        // Installed payload entries keep the strict identity: the same change is refused there.
        expect(() => assertDocumentEnginePathIdentities([captureDocumentEnginePathIdentity(path), { ...identity, archive: undefined }]))
          .toThrow("identity changed");
      } finally { await held.close(); }
    });

    it("refuses same-size content replacement even when mtime is restored", async () => {
      const { path, held, identity } = await heldArchive();
      try {
        await settleCtime();
        await writeFile(path, pinned.toUpperCase()); await utimes(path, seconds, seconds);
        await expect(assertDocumentEngineArchiveUnchanged(held, identity, sha256)).rejects.toThrow("bytes changed");
      } finally { await held.close(); }
    });

    it("refuses an inode replacement with identical bytes and a size change", async () => {
      const replaced = await heldArchive();
      try {
        await rm(replaced.path); await writeFile(replaced.path, pinned); await chmod(replaced.path, 0o600); await utimes(replaced.path, seconds, seconds);
        await expect(assertDocumentEngineArchiveUnchanged(replaced.held, replaced.identity, sha256)).rejects.toThrow("identity changed");
      } finally { await replaced.held.close(); }
      const grown = await heldArchive();
      try {
        await appendFile(grown.path, "x"); await utimes(grown.path, seconds, seconds);
        await expect(assertDocumentEngineArchiveUnchanged(grown.held, grown.identity, sha256)).rejects.toThrow("identity changed");
      } finally { await grown.held.close(); }
    });
  });

  it("binds a payload tree's metadata identity: stable when untouched, changed by any rewrite", async () => {
    const path = await root(); await mkdir(join(path, "program"));
    const file = join(path, "program", "soffice"); await writeFile(file, "engine");
    const recorded = await readDocumentEngineIdentityDigest(path, new AbortController().signal);
    expect(await readDocumentEngineIdentityDigest(path, new AbortController().signal)).toBe(recorded);
    const before = await stat(file, { bigint: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(file, "engine"); await utimes(file, before.atime, before.mtime);
    expect(await readDocumentEngineIdentityDigest(path, new AbortController().signal)).not.toBe(recorded);
  });
});
