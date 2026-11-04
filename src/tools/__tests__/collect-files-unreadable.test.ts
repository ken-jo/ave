// One unreadable subfolder must not empty a whole project listing; an unreadable root still fails clearly.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupTmpDir } from "../../__tests__/support/tmp-dir-teardown.js";
import { collectFiles } from "../file-tools.js";
import { clearWorkspaceFileSearchCache, searchWorkspaceFiles } from "../../ipc/domains/workspace-file-search.js";

// chmod 000 does not lock a folder on Windows or for root.
const unlockable = process.platform === "win32" || process.getuid?.() === 0;

let base: string;
let locked: string;
let listOnly: string;

beforeAll(() => {
  base = realpathSync(mkdtempSync(join(tmpdir(), "ave-collect-unreadable-")));
  mkdirSync(join(base, "src", "payments", "retry"), { recursive: true });
  writeFileSync(join(base, "src", "payments", "retry", "handle-retry.ts"), "x");
  writeFileSync(join(base, "README.md"), "x");
  locked = join(base, "deploy", "keys");
  mkdirSync(locked, { recursive: true });
  writeFileSync(join(locked, "k.pem"), "k");
  if (!unlockable) chmodSync(locked, 0o000);
  // Readable but not searchable: readdir lists the names, stat on each is refused.
  listOnly = join(base, "vault");
  mkdirSync(join(listOnly, "inner"), { recursive: true });
  writeFileSync(join(listOnly, "a.txt"), "a");
  if (!unlockable) chmodSync(listOnly, 0o444);
});

beforeEach(() => clearWorkspaceFileSearchCache());

afterAll(async () => {
  if (!unlockable) {
    chmodSync(locked, 0o755);
    chmodSync(listOnly, 0o755);
  }
  await cleanupTmpDir(base);
});

describe.skipIf(unlockable)("collectFiles with an unreadable subfolder", () => {
  it("skips the unreadable subfolder and lists everything else", async () => {
    const listed = await collectFiles(base, 1_000);
    expect(listed.ok).toBe(true);
    if (!listed.ok) return;
    const paths = listed.value.files.map((file) => file.relativePath).sort();
    expect(paths).toEqual(["README.md", "src/payments/retry/handle-retry.ts"]);
    // The locked folder, the file in the list-only folder and its subfolder are named so "unreadable" reads apart from "empty".
    expect(listed.value.skippedUnreadable).toEqual({ count: 3, paths: ["deploy/keys", "vault/a.txt", "vault/inner"] });
  });

  it("keeps workspace file search working when a folder is locked", async () => {
    const result = await searchWorkspaceFiles({ query: "handle-retry", roots: [base], cwd: base, extraAllowed: [] });
    expect(result.matches.map((match) => match.relativePath)).toEqual(["src/payments/retry/handle-retry.ts"]);
  });

  it("still fails clearly when the root itself is unreadable", async () => {
    const listed = await collectFiles(locked, 1_000);
    expect(listed.ok).toBe(false);
  });
});
