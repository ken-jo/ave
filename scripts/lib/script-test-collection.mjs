import { readdirSync } from "node:fs";
import { posix } from "node:path";

const SCRIPT_TEST_DIRECTORY = "test/scripts";
const TEST_DIRECTORY = new URL("../../test/scripts/", import.meta.url);
const isScriptTestName = name => name.endsWith(".test.mjs");

export function isCollectedScriptTest(path) {
  return posix.dirname(path) === SCRIPT_TEST_DIRECTORY && isScriptTestName(posix.basename(path));
}

export function discoverScriptTests(directory = TEST_DIRECTORY) {
  return readdirSync(directory, { withFileTypes: true })
    .filter(entry => entry.isFile() && isScriptTestName(entry.name))
    .map(entry => entry.name)
    .sort();
}
