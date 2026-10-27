import { link, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canCreateSymlinks } from "../../__tests__/support/symlink-capability.js";
import { assertDocumentEnginePathIdentities, captureDocumentEnginePathIdentity,
  documentEngineTreeDigest, readDocumentEngineTree } from "../document-engine-payload.js";

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
});
