import { existsSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createLocalAppDataFixtureRoot, resetFixtureAcls, setFixtureOwner } from "./fixture-owner.js";
import { cleanupTmpDir } from "./tmp-dir-teardown.js";
import { ensureAveHomePrivate } from "../../shared/ave-home.js";
import { configureHostResources } from "../../main/host-resources.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) {
    resetFixtureAcls(root);
    await cleanupTmpDir(root);
  }
});

const refusal = /inside the test temporary directory or a registered %LOCALAPPDATA% fixture root/;

it.runIf(process.platform === "win32")("deletes protected owner-only home descriptors after restoring fixture inheritance", async () => {
  configureHostResources({ resourcePath: resolve("resources"), isPackaged: false });
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ave-fixture-acl-")));
  roots.push(root);
  setFixtureOwner(root);
  const home = join(root, "ave");
  expect(ensureAveHomePrivate(home).enforcement).toBe("win32-dacl");
  mkdirSync(join(home, "config", "nested"));
  writeFileSync(join(home, "config", "nested", "state.json"), "{}");
  resetFixtureAcls(root);
  await cleanupTmpDir(root);
  expect(existsSync(root)).toBe(false);
  roots.splice(roots.indexOf(root), 1);
});

it.runIf(process.platform === "win32")("accepts a directory inside the test temporary directory", () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "ave-fixture-owner-")));
  roots.push(directory);
  expect(() => setFixtureOwner(directory)).not.toThrow();
});

it.runIf(process.platform === "win32")("accepts a registered %LOCALAPPDATA% root and paths inside it", () => {
  const root = createLocalAppDataFixtureRoot();
  roots.push(root);
  const child = realpathSync(mkdtempSync(join(root, "child-")));
  expect(() => setFixtureOwner(root)).not.toThrow();
  expect(() => setFixtureOwner(child)).not.toThrow();
});

it.runIf(process.platform === "win32")("rejects paths outside both sanctioned roots", () => {
  const root = createLocalAppDataFixtureRoot();
  roots.push(root);
  // Checked before any ownership command runs, so none of these paths is touched.
  expect(() => setFixtureOwner(tmpdir())).toThrow(refusal);
  expect(() => setFixtureOwner(process.env.LOCALAPPDATA!)).toThrow(refusal);
  expect(() => setFixtureOwner(`${root}-sibling`)).toThrow(refusal);
  expect(() => setFixtureOwner(join(process.env.LOCALAPPDATA!, "ave-fixture-unregistered"))).toThrow(refusal);
  expect(() => setFixtureOwner(join(process.env.SystemRoot!, "System32"))).toThrow(refusal);
});
