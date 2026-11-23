import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readWindowsSources, windowsNativeInventory } from "../test/scripts/windows-native-test-inventory.js";

const root = resolve(import.meta.dirname, "..");
writeFileSync(resolve(root, "config/windows-native-tests.txt"), windowsNativeInventory(readWindowsSources(root)));
