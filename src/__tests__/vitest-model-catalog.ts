/**
 * Test setup — installs the bundled model catalog, as boot does.
 *
 * Model resolution reads the catalog the process installed and throws when
 * none was (`src/shared/model-catalog/active.ts`). The desktop and headless
 * hosts install it in `bootstrapCoreServices`, and the renderer before it
 * mounts; a test file is its own process for this purpose, so it gets the
 * same verified snapshot here. Installed as a loader: a file that never
 * resolves a model never parses the document. A test that needs a different
 * catalog installs its own and restores this one afterwards.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyModelCatalogDocument } from "../core/model-catalog/document.js";
import { installModelCatalog } from "../shared/model-catalog/active.js";

const SNAPSHOT = join(dirname(fileURLToPath(import.meta.url)), "..", "core", "model-catalog", "bundled-snapshot.json");

installModelCatalog(() => verifyModelCatalogDocument(JSON.parse(readFileSync(SNAPSHOT, "utf-8"))));
