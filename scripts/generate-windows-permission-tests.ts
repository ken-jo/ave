import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readWindowsSources } from "../test/scripts/windows-native-test-inventory.js";
import { WINDOWS_TEST_LISTS, windowsPermissionInventory } from "./windows-test-inventory.mjs";

const root = resolve(import.meta.dirname, "..");
writeFileSync(resolve(root, WINDOWS_TEST_LISTS[0]), windowsPermissionInventory(readWindowsSources(root)));
