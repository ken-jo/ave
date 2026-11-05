import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { checkSafeStorageMessages, readExpectedMessages, runSafeStorageMessagesCli } from "../../scripts/check-safestorage-messages.mjs";

const FAILED = "Error while decrypting the ciphertext provided to safeStorage.decryptStringAsync.";
const TRANSIENT = "safeStorage.decryptStringAsync is temporarily unavailable. Please try again.";

function fixtureRoot(binaryText) {
  const root = mkdtempSync(join(tmpdir(), "safestorage-messages-"));
  mkdirSync(join(root, "src/audit"), { recursive: true });
  writeFileSync(join(root, "src/audit/hmac-chain.ts"),
    `export const ELECTRON_DECRYPT_FAILED_MESSAGE = "${FAILED}";\nexport const ELECTRON_DECRYPT_TEMPORARILY_UNAVAILABLE_MESSAGE = "${TRANSIENT}";\n`);
  if (binaryText !== null) {
    mkdirSync(join(root, "node_modules/electron/dist"), { recursive: true });
    writeFileSync(join(root, "node_modules/electron/index.js"), 'module.exports = require("node:path").join(__dirname, "dist", "electron");');
    writeFileSync(join(root, "node_modules/electron/dist/electron"), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(binaryText), Buffer.from([0])]));
  }
  return root;
}

function cli(root) {
  const err = [];
  const code = runSafeStorageMessagesCli({ root, stdout: () => {}, stderr: (line) => err.push(line) });
  return { code, err: err.join("\n") };
}

test("passes when the installed Electron ships both messages", () => {
  const root = fixtureRoot(`${FAILED}\0${TRANSIENT}`);
  try {
    assert.equal(cli(root).code, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("names the message the installed Electron no longer ships", () => {
  const root = fixtureRoot(FAILED);
  try {
    const { code, err } = cli(root);
    assert.equal(code, 1);
    assert.match(err, /no longer contains ELECTRON_DECRYPT_TEMPORARILY_UNAVAILABLE_MESSAGE/);
    assert.doesNotMatch(err, /ELECTRON_DECRYPT_FAILED_MESSAGE/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails closed when no Electron binary is installed", () => {
  const root = fixtureRoot(null);
  try {
    assert.equal(cli(root).code, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reads the messages this tree's audit store matches on", () => {
  const messages = readExpectedMessages().map(({ message }) => message);
  assert.deepEqual(messages, [FAILED, TRANSIENT]);
});

test("checks this tree's installed Electron", () => {
  assert.deepEqual(checkSafeStorageMessages(), { ok: true, problems: [] });
});
