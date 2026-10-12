/**
 * The model catalog this process resolves against.
 *
 * Resolution is synchronous and runs on both sides of the IPC boundary — the
 * engine budgets compaction with it and the renderer's context ring divides by
 * the same answer — so the catalog is installed once per process and read from
 * here, not threaded through every call. The main process installs the
 * verified bundled snapshot at boot (`src/core/model-catalog/bundled.ts`); the
 * renderer installs the copy main hands it over `ave:llm:get-model-catalog`
 * before it mounts.
 *
 * Reading before anything was installed is a startup-order defect and throws:
 * answering from the legacy table instead would put a different window in
 * front of the user than the one the engine budgets against, which is the
 * disagreement this catalog exists to end.
 */
import type { ModelCatalogDocument } from "./types.js";

type CatalogSource = ModelCatalogDocument | (() => ModelCatalogDocument);

/**
 * Held on the global object, not in module scope: a second instance of this
 * module — a test that resets its module registry, a chunk that inlined a
 * copy — must see the catalog the process installed, not report it missing.
 */
const SLOT = Symbol.for("ave.modelCatalog.active");
type Slot = { source?: CatalogSource; resolved?: ModelCatalogDocument };
const slot: Slot = ((globalThis as Record<symbol, Slot | undefined>)[SLOT] ??= {});

/**
 * Install the catalog for this process. A function is called once, on first
 * read, so a process (or a test file) that never resolves a model never pays
 * for parsing the document.
 */
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
