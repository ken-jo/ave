import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkSyncSafeStorage, runSyncSafeStorageCli } from "../../scripts/check-safestorage-sync.mjs";

/** A root with an installed electron of `version` (null: none) and `files`. */
function fixtureRoot(version, files) {
  const root = mkdtempSync(join(tmpdir(), "safestorage-sync-"));
  if (version !== null) {
    mkdirSync(join(root, "node_modules/electron"), { recursive: true });
    writeFileSync(join(root, "node_modules/electron/package.json"), JSON.stringify({ name: "electron", version }));
  }
  for (const [rel, content] of Object.entries(files)) {
    const path = join(root, rel);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
  }
  return root;
}

function cli(root, options = {}) {
  const err = [];
  const out = [];
  const code = runSyncSafeStorageCli({ root, ...options, stdout: (l) => out.push(l), stderr: (l) => err.push(l) });
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const SYNC_SITES = {
  "src/main/secret.ts": "export const enc = (v: string) => safeStorage.encryptString(v);\n",
  "src/audit/chain.ts": "if (!this.safeStorage.isEncryptionAvailable()) throw new Error('x');\nconst v = this.safeStorage.decryptString(b);\n",
  "scripts/smoke.mjs": "if (!safeStorage.isEncryptionAvailable()) process.exit(1);\n",
};

test("fires on Electron 46 while a synchronous call remains, listing every site", () => {
  const root = fixtureRoot("45.0.0", SYNC_SITES);
  try {
    const { code, err } = cli(root, { electronMajor: 46 });
    assert.equal(code, 1);
    assert.match(err, /Electron 46 has no synchronous safeStorage methods, and 4 call\(s\) remain/);
    assert.match(err, /src\/main\/secret\.ts:1 {2}\(safeStorage\.encryptString\)/);
    assert.match(err, /src\/audit\/chain\.ts:1 {2}\(safeStorage\.isEncryptionAvailable\)/);
    assert.match(err, /src\/audit\/chain\.ts:2 {2}\(safeStorage\.decryptString\)/);
    assert.match(err, /scripts\/smoke\.mjs:1 {2}\(safeStorage\.isEncryptionAvailable\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reads the major from the installed electron package", () => {
  const root = fixtureRoot("46.1.0", SYNC_SITES);
  try {
    const result = checkSyncSafeStorage(root);
    assert.equal(result.major, 46);
    assert.equal(result.ok, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("passes below Electron 46, counting the sites still to move", () => {
  const root = fixtureRoot("45.0.0", SYNC_SITES);
  try {
    const { code, out } = cli(root);
    assert.equal(code, 0);
    assert.match(out, /Electron 45; 4 synchronous call\(s\) left to move before Electron 46/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("passes on Electron 46 once only the async methods are called", () => {
  const root = fixtureRoot("46.0.0", {
    "src/main/secret.ts":
      "if (await safeStorage.isAsyncEncryptionAvailable()) {\n" +
      "  const e = await safeStorage.encryptStringAsync(v);\n" +
      "  const { result } = await safeStorage.decryptStringAsync(e);\n}\n",
  });
  try {
    const result = checkSyncSafeStorage(root);
    assert.equal(result.ok, true);
    assert.equal(result.calls.length, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails clearly when no electron is installed", () => {
  const root = fixtureRoot(null, SYNC_SITES);
  try {
    const { code, err } = cli(root);
    assert.equal(code, 1);
    assert.match(err, /cannot read the installed electron package/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
