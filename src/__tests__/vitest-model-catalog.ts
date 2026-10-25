/** Install the verified catalog lazily per test context; tests replacing it must restore the default. */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyModelCatalogDocument } from "../core/model-catalog/document.js";
import { installModelCatalog } from "../shared/model-catalog/active.js";

const SNAPSHOT = join(dirname(fileURLToPath(import.meta.url)), "..", "core", "model-catalog", "bundled-snapshot.json");

installModelCatalog(() => verifyModelCatalogDocument(JSON.parse(readFileSync(SNAPSHOT, "utf-8"))));
