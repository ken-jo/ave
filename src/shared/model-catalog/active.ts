/** Install one catalog per process before synchronous resolution; missing installation is a boot-order error, never a legacy-table fallback. */
import type { ModelCatalogDocument } from "./types.js";

type CatalogSource = ModelCatalogDocument | (() => ModelCatalogDocument);

/** Store on the global object so duplicate module instances and reset registries share the installed catalog. */
const SLOT = Symbol.for("ave.modelCatalog.active");
type Slot = { source?: CatalogSource; resolved?: ModelCatalogDocument };
const slot: Slot = ((globalThis as Record<symbol, Slot | undefined>)[SLOT] ??= {});

/** Evaluate lazy catalog factories on first read so unused processes avoid parsing cost. */
export function installModelCatalog(next: CatalogSource): void {
  slot.source = next;
  if (typeof next === "function") delete slot.resolved;
  else slot.resolved = next;
}

/** The installed catalog; throws when this process never installed one. */
export function activeModelCatalog(): ModelCatalogDocument {
  if (slot.resolved) return slot.resolved;
  const { source } = slot;
  if (source === undefined) {
    throw new Error("model catalog is not installed: the process entry must call installModelCatalog before resolving a model");
  }
  const resolved = typeof source === "function" ? source() : source;
  slot.resolved = resolved;
  return resolved;
}
