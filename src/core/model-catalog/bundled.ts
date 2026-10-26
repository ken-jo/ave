/** Select once per boot: explicit pins fail closed, then verified current cache, then bundled data. Refresh applies next boot; dynamically load and verify the bundled snapshot. */
import { isAbsolute } from "node:path";
import { createLogger } from "../../lib/logger.js";
import { installModelCatalog } from "../../shared/model-catalog/active.js";
import type { ModelCatalogDocument } from "../../shared/model-catalog/types.js";
import { modelCatalogCacheDir, readCachedModelCatalog, readCurrentModelCatalog, readModelCatalogFile } from "./cache.js";
import { verifyModelCatalogDocument } from "./document.js";

const log = createLogger("model-catalog");

async function loadBundledModelCatalog(): Promise<ModelCatalogDocument> {
  const { default: snapshot } = await import("./bundled-snapshot.json", { with: { type: "json" } });
  return verifyModelCatalogDocument(snapshot);
}

type ModelCatalogOrigin = "pinned" | "cache" | "bundled";

export async function selectBootModelCatalog(args: {
  env?: NodeJS.ProcessEnv;
  dir?: string;
  loadBundled?: () => Promise<ModelCatalogDocument>;
} = {}): Promise<{ document: ModelCatalogDocument; origin: ModelCatalogOrigin }> {
  const env = args.env ?? process.env;
  const dir = args.dir ?? modelCatalogCacheDir();
  const loadBundled = args.loadBundled ?? loadBundledModelCatalog;

  const pin = env.AVE_MODEL_CATALOG?.trim();
  if (pin) {
    if (pin === "bundled") return { document: await loadBundled(), origin: "pinned" };
    const read = /^[0-9a-f]{64}$/.test(pin) ? await readCachedModelCatalog(dir, pin)
      : isAbsolute(pin) ? await readModelCatalogFile(pin)
      : { ok: false as const, reason: "it must be bundled, the sha256 of a cached catalog, or an absolute path" };
    if (!read.ok) throw new Error(`AVE_MODEL_CATALOG=${pin} cannot be used: ${read.reason}`);
    return { document: read.value, origin: "pinned" };
  }

  const bundled = await loadBundled();
  const cached = await readCurrentModelCatalog(dir);
  if (!cached.ok) {
    if (cached.reason !== "absent") log.warn({ reason: cached.reason }, "cached model catalog unusable; using the bundled snapshot");
    return { document: bundled, origin: "bundled" };
  }
  const { document } = cached.value;
  if (Date.parse(document.provenance.fetchedAt) < Date.parse(bundled.provenance.fetchedAt)) {
    return { document: bundled, origin: "bundled" };
  }
  return { document, origin: "cache" };
}

/** Install the selected catalog before any service can resolve a model. */
export async function installBootModelCatalog(): Promise<void> {
  const { document, origin } = await selectBootModelCatalog();
  log.info({ origin, sha256: document.sha256, fetchedAt: document.provenance.fetchedAt }, "model catalog installed");
  installModelCatalog(document);
}
