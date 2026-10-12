/**
 * Boot's catalog install, without the test setup's copy.
 *
 * Every test worker installs the bundled snapshot in a setup file
 * (`src/__tests__/vitest-model-catalog.ts`), which would hide a boot that
 * resolved a model before installing one. This file empties the process's
 * catalog first, so it sees what a fresh process sees: a read throws, boot's
 * own install step (the dynamic import and verification the main bundle
 * ships) makes it answer, and `bootstrapCoreServices` runs that step before
 * the first service it constructs.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { installBundledModelCatalog } from "../bundled.js";
import { activeModelCatalog, installModelCatalog } from "../../../shared/model-catalog/active.js";
import { resolveModelContextWindow } from "../../../shared/context-budget.js";
import type { ModelCatalogDocument } from "../../../shared/model-catalog/types.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..");
type Slot = { source?: ModelCatalogDocument | (() => ModelCatalogDocument); resolved?: ModelCatalogDocument };
const slot = (globalThis as Record<symbol, Slot | undefined>)[Symbol.for("ave.modelCatalog.active")] as Slot;

describe("boot's model catalog install", () => {
  let setupSource: Slot["source"];
  beforeEach(() => {
    setupSource = slot.source;
    delete slot.source;
    delete slot.resolved;
  });
  afterEach(() => {
    if (setupSource !== undefined) installModelCatalog(setupSource);
  });

  it("refuses a read before install, and answers after boot's install step", async () => {
    expect(() => activeModelCatalog()).toThrow(/not installed/);
    expect(() => resolveModelContextWindow({ vendor: "openai", model: "gpt-5.2" })).toThrow(/not installed/);

    await installBundledModelCatalog();

    const snapshot = JSON.parse(readFileSync(join(ROOT, "src/core/model-catalog/bundled-snapshot.json"), "utf-8")) as ModelCatalogDocument;
    expect(activeModelCatalog().sha256).toBe(snapshot.sha256);
    expect(resolveModelContextWindow({ vendor: "openai", model: "gpt-5.2" }).source).toBe("model-catalog");
  });

  it("is the first step of bootstrapCoreServices that constructs anything", () => {
    const source = readFileSync(join(ROOT, "src/boot/services.ts"), "utf-8");
    const body = source.slice(source.indexOf("export async function bootstrapCoreServices"));
    const install = body.indexOf("await installBundledModelCatalog();");
    expect(install).toBeGreaterThan(0);
    // Everything before it is the log sink, which resolves no model.
    const firstConstruction = body.search(/\bnew [A-Z]\w*\(/);
    expect(firstConstruction).toBeGreaterThan(install);
    expect(body.slice(0, install)).not.toMatch(/settingsService|resolve\w*ContextWindow|activeModelCatalog/);
  });
});
