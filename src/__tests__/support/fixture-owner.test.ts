import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { createLocalAppDataFixtureRoot, setFixtureOwner } from "./fixture-owner.js";
import { cleanupTmpDir } from "./tmp-dir-teardown.js";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await cleanupTmpDir(root);
});

const refusal = /inside the test temporary directory or a registered %LOCALAPPDATA% fixture root/;

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
