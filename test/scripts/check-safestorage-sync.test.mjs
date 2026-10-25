import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import test from "node:test";
import { SAFE_STORAGE_OWNERS, checkSyncSafeStorage, runSyncSafeStorageCli, scanSafeStorageText } from "../../scripts/check-safestorage-sync.mjs";

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
    assert.match(err, /Electron 46 has no synchronous safeStorage methods, and 4 use\(s\) remain/);
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
    assert.match(out, /Electron 45; 4 synchronous use\(s\) left to move before Electron 46/);
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

/** The sync members `text` reaches, as `kind:method@line`. */
function reached(text) {
  return scanSafeStorageText(text).sites.map((site) => `${site.kind}:${site.method}@${site.line}`);
}

test("counts a member reached across lines, with optional chaining and through a member", () => {
  assert.deepEqual(reached("const v = safeStorage\n  .encryptString(x);\n"), ["call:encryptString@1"]);
  assert.deepEqual(reached("safeStorage?.decryptString(b);\n"), ["call:decryptString@1"]);
  assert.deepEqual(reached("this.safeStorage\n  ?.\n  isEncryptionAvailable();\n"), ["call:isEncryptionAvailable@1"]);
  // A reference is a later call.
  assert.deepEqual(reached("register(safeStorage.encryptString);\n"), ["call:encryptString@1"]);
});

test("counts bracket access by a quoted name", () => {
  assert.deepEqual(reached('safeStorage["encryptString"](x);\n'), ["call:encryptString@1"]);
  assert.deepEqual(reached("safeStorage?.['decryptString'](b);\n"), ["call:decryptString@1"]);
  assert.deepEqual(reached("safeStorage[\n  `isEncryptionAvailable`\n]();\n"), ["call:isEncryptionAvailable@1"]);
});

test("counts a sync member destructured out of safeStorage, and fails on it from Electron 46", () => {
  const text = "const {\n  encryptString,\n  decryptString: open,\n  getSelectedStorageBackend,\n} = safeStorage;\n";
  assert.deepEqual(reached(text), ["destructure:encryptString@1", "destructure:decryptString@1"]);
  assert.deepEqual(reached("const { isEncryptionAvailable } = this.safeStorage;\n"), ["destructure:isEncryptionAvailable@1"]);
  const root = fixtureRoot("46.0.0", { "src/main/secret.ts": text });
  try {
    const { code, err } = cli(root);
    assert.equal(code, 1);
    assert.match(err, /src\/main\/secret\.ts:1 {2}\(destructures safeStorage\.encryptString\)/);
    assert.match(err, /src\/main\/secret\.ts:1 {2}\(destructures safeStorage\.decryptString\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

/** Every alias reason the gate reports for `text` at `rel`. */
function aliasesOf(text, rel = "src/main/other.ts") {
  return scanSafeStorageText(text, rel).aliases.map((alias) => `${alias.reason}@${alias.line}`);
}

const BYPASSES = {
  "re-export under another name": 'export { safeStorage as ss } from "electron";\n',
  "re-export of all of Electron": 'export * from "electron";\n',
  "rename out of a default import": 'import electron from "electron";\nconst { safeStorage: s } = electron;\n',
  "rename out of a dynamic import": 'const { safeStorage: s } = await import("electron");\ns.encryptString(x);\n',
  "bracket access on the namespace": 'import * as e from "electron";\ne["safeStorage"].encryptString(x);\n',
  "default export": 'import { safeStorage } from "electron";\nexport default safeStorage;\n',
  "return": 'import { safeStorage } from "electron";\nexport function store() {\n  return safeStorage;\n}\n',
  "array element": 'import { safeStorage } from "electron";\nexport const stores = [safeStorage];\n',
  "ternary": 'import { safeStorage } from "electron";\nexport const store = ready ? safeStorage : null;\n',
  "require then alias": 'const electron = require("electron");\nconst s = electron.safeStorage;\n',
};

for (const [form, text] of Object.entries(BYPASSES)) {
  test(`fails on any Electron for a ${form}`, () => {
    assert.notDeepEqual(aliasesOf(text), [], `${form} was not flagged`);
    const root = fixtureRoot("45.0.0", { "src/main/other.ts": text });
    try {
      const { code, err } = cli(root);
      assert.equal(code, 1);
      assert.match(err, /reach Electron's safeStorage outside src\/main\/desktop-secret-encryption\.ts/);
      assert.match(err, /src\/main\/other\.ts:\d+ {2}\(/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("flags the re-exporting module, so its importer cannot hide the call", () => {
  const root = fixtureRoot("45.0.0", {
    "src/a.ts": 'export { safeStorage as ss } from "electron";\n',
    "src/b.ts": 'import { ss } from "./a.js";\nss.encryptString(x);\n',
  });
  try {
    const { code, err } = cli(root);
    assert.equal(code, 1);
    assert.match(err, /src\/a\.ts:1 {2}\(re-exports Electron's safeStorage\)/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("lets the three owners use safeStorage, and holds even them to no exports", () => {
  assert.deepEqual([...SAFE_STORAGE_OWNERS], [
    "src/main/desktop-secret-encryption.ts",
    "scripts/smoke-live-app.mjs",
    "scripts/smoke-live-model.mjs",
  ]);
  const owner =
    'import { safeStorage } from "electron";\n' +
    "export const adapter = { encryptString: (v) => safeStorage.encryptString(v) };\n" +
    // Destructuring an async member is neither an alias (owners may) nor a sync site.
    "const { encryptStringAsync } = safeStorage;\n";
  const files = Object.fromEntries(SAFE_STORAGE_OWNERS.map((rel) => [rel, owner]));
  const root = fixtureRoot("45.0.0", files);
  try {
    const result = checkSyncSafeStorage(root);
    assert.equal(result.ok, true);
    assert.deepEqual(result.aliases, []);
    assert.deepEqual(result.calls.map((c) => `${c.rel}:${c.method}`), SAFE_STORAGE_OWNERS.map((rel) => `${rel}:encryptString`));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  assert.deepEqual(
    aliasesOf('import { safeStorage } from "electron";\nexport { safeStorage };\n', SAFE_STORAGE_OWNERS[0]),
    ["exports Electron's safeStorage@2"],
  );
});

test("does not take a test file's electron mock for a use, but counts its sync references", () => {
  const mock =
    'vi.mock("electron", () => ({ safeStorage: { encryptString: vi.fn(), isAsyncEncryptionAvailable: vi.fn() } }));\n' +
    'const mockedElectron = vi.mocked(await import("electron"));\n' +
    "mockedElectron.safeStorage.encryptString.mockClear();\n";
  for (const rel of ["src/data/__tests__/settings-store.test.ts", "src/main/thing.test.ts", "scripts/thing.spec.mjs"]) {
    const found = scanSafeStorageText(mock, rel);
    assert.deepEqual(found.aliases, [], `${rel} tripped the alias rule`);
    assert.deepEqual(found.sites.map((site) => site.method), ["encryptString"]);
  }
  // The same text outside a test file is a use.
  assert.notDeepEqual(aliasesOf(mock), []);
});

test("checks this tree with no file outside the owners naming safeStorage beside Electron", () => {
  const result = checkSyncSafeStorage(process.cwd());
  assert.deepEqual(result.aliases, []);
  assert.equal(result.ok, true);
});

test("never counts the async methods", () => {
  const text =
    "await safeStorage.isAsyncEncryptionAvailable();\n" +
    "await safeStorage?.encryptStringAsync(v);\n" +
    "await safeStorage\n  .decryptStringAsync(e);\n" +
    'await safeStorage["encryptStringAsync"](v);\n' +
    "const { encryptStringAsync, decryptStringAsync } = safeStorage;\n";
  assert.deepEqual(reached(text), []);
});
