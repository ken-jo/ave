/**
 * The bundled model catalog's generator (issue #2501): committed models.dev
 * input in, `src/core/model-catalog/bundled-snapshot.json` out.
 *
 * The input under `scripts/model-catalog/` is committed so the snapshot is
 * reproducible from the repository alone: `models-dev-input.json` is the
 * pruned download, `models-dev-source.json` records where and when it was
 * downloaded, and `models-dev-LICENSE.txt` is the license the data is
 * distributed under. `--fetch` replaces all three; everything else reads them.
 * The packaged app ships the same license text from `resources/licenses/`.
 */
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  buildModelCatalogDocument,
  formatCatalogJson,
  type ModelCatalogSource,
} from "../../src/core/model-catalog/document-builder.js";
import type { CatalogDiagnostic } from "../../src/shared/model-catalog/normalize.js";
import { pruneModelsDevDocument } from "../../src/shared/model-catalog/normalize.js";
import { catalogProviderIds } from "../../src/shared/model-catalog/provider-map.js";
import type { ModelCatalogDocument, ModelCatalogLicense } from "../../src/shared/model-catalog/types.js";

export const MODEL_CATALOG_LABEL = "[model-catalog]";
const MODELS_DEV_API_URL = "https://models.dev/api.json";
const MODELS_DEV_REPOSITORY = "https://github.com/anomalyco/models.dev";
const MODELS_DEV_GITHUB_API = "https://api.github.com/repos/anomalyco/models.dev";
const MODELS_DEV_BRANCH = "dev";
const MODELS_DEV_SCHEMA_PATH = "packages/core/src/schema.ts";

export const MODEL_CATALOG_PATHS = {
  input: "scripts/model-catalog/models-dev-input.json",
  source: "scripts/model-catalog/models-dev-source.json",
  license: "scripts/model-catalog/models-dev-LICENSE.txt",
  /** The attribution the installer ships (`build.extraResources` → `licenses/models.dev`). */
  packagedLicense: "resources/licenses/models.dev/LICENSE-MIT",
  snapshot: "src/core/model-catalog/bundled-snapshot.json",
} as const;

/** Depth at which a JSON value is written on one line: a model record, in both files. */
const INPUT_COMPACT_DEPTH = 3;
const SNAPSHOT_COMPACT_DEPTH = 4;

/** The license as the catalog carries it; the copyright line is read from the text, not restated. */
function modelCatalogLicense(text: string): ModelCatalogLicense {
  const copyright = text.split("\n").find((line) => line.startsWith("Copyright"));
  if (!text.startsWith("MIT License") || !copyright) {
    throw new Error(`${MODEL_CATALOG_PATHS.license} is not an MIT license with a copyright line`);
  }
  return { spdx: "MIT", copyright: copyright.trim(), repository: MODELS_DEV_REPOSITORY, text };
}

function readText(root: string, path: string): string {
  try {
    // A copy checked out with CRLF is the same input; the blob is LF (.gitattributes).
    return readFileSync(join(root, path), "utf-8").replace(/\r\n/g, "\n");
  } catch {
    throw new Error(`${path} is missing; run bun run generate:model-catalog -- --fetch`);
  }
}

/** The snapshot the committed input generates, as the bytes the file must hold. */
export function generateModelCatalog(root: string): {
  path: string;
  text: string;
  document: ModelCatalogDocument;
  diagnostics: CatalogDiagnostic[];
} {
  const input: unknown = JSON.parse(readText(root, MODEL_CATALOG_PATHS.input));
  const source = JSON.parse(readText(root, MODEL_CATALOG_PATHS.source)) as ModelCatalogSource;
  const license = modelCatalogLicense(readText(root, MODEL_CATALOG_PATHS.license));
  const { document, diagnostics } = buildModelCatalogDocument({
    input,
    providerIds: catalogProviderIds(),
    source,
    license,
  });
  return {
    path: MODEL_CATALOG_PATHS.snapshot,
    text: formatCatalogJson(document, SNAPSHOT_COMPACT_DEPTH),
    document,
    diagnostics,
  };
}

/** The committed input files a download produces: the pruned document, its source record, and the license. */
async function fetchModelCatalogInput(fetchImpl: typeof fetch = fetch): Promise<{
  input: string;
  source: string;
  license: string;
}> {
  const response = await fetchImpl(MODELS_DEV_API_URL, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`${MODELS_DEV_API_URL} answered ${response.status}`);
  const raw = Buffer.from(await response.arrayBuffer());
  const fetchedAt = new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
  const pruned = pruneModelsDevDocument(JSON.parse(raw.toString("utf-8")), catalogProviderIds());

  // The deployed document carries no revision, so the repository head at
  // download time is recorded as the nearest one. Best effort: an API limit
  // must not stop a download that already succeeded.
  let upstreamHeadAtFetch: string | undefined;
  let upstreamSchemaBlob: string | undefined;
  try {
    const head = await fetchImpl(`${MODELS_DEV_GITHUB_API}/commits/${MODELS_DEV_BRANCH}`, { signal: AbortSignal.timeout(15_000) });
    if (head.ok) upstreamHeadAtFetch = ((await head.json()) as { sha?: string }).sha;
    if (upstreamHeadAtFetch) {
      const schema = await fetchImpl(
        `${MODELS_DEV_GITHUB_API}/contents/${MODELS_DEV_SCHEMA_PATH}?ref=${upstreamHeadAtFetch}`,
        { signal: AbortSignal.timeout(15_000) },
      );
      if (schema.ok) upstreamSchemaBlob = ((await schema.json()) as { sha?: string }).sha;
    }
  } catch {
    // Recorded as absent; the fields are optional for exactly this reason.
  }
  const licenseResponse = await fetchImpl(
    `https://raw.githubusercontent.com/anomalyco/models.dev/${upstreamHeadAtFetch ?? MODELS_DEV_BRANCH}/LICENSE`,
    { signal: AbortSignal.timeout(15_000) },
  );
  if (!licenseResponse.ok) throw new Error(`the models.dev LICENSE answered ${licenseResponse.status}`);
  const license = (await licenseResponse.text()).replace(/\r\n/g, "\n");
  modelCatalogLicense(license);

  const etag = response.headers.get("etag") ?? undefined;
  const source: ModelCatalogSource = {
    url: MODELS_DEV_API_URL,
    fetchedAt,
    ...(etag ? { etag } : {}),
    rawSha256: createHash("sha256").update(raw).digest("hex"),
    ...(upstreamHeadAtFetch ? { upstreamHeadAtFetch } : {}),
    ...(upstreamSchemaBlob ? { upstreamSchemaBlob } : {}),
  };
  return {
    input: formatCatalogJson(pruned, INPUT_COMPACT_DEPTH),
    source: formatCatalogJson(source, 1),
    license,
  };
}

function writeText(root: string, path: string, text: string): void {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text, "utf-8");
}

/** The snapshot the committed input generates, written, with the packaged license kept equal to the input's. */
export function writeModelCatalog(root: string): ReturnType<typeof generateModelCatalog> {
  const generated = generateModelCatalog(root);
  writeText(root, generated.path, generated.text);
  writeText(root, MODEL_CATALOG_PATHS.packagedLicense, generated.document.license.text);
  return generated;
}

/**
 * Download new input and regenerate. Every download finishes before the
 * first file is written, so a failed run leaves the committed input as it was.
 */
export async function fetchAndWriteModelCatalog(
  root: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ReturnType<typeof generateModelCatalog>> {
  const { input, source, license } = await fetchModelCatalogInput(fetchImpl);
  writeText(root, MODEL_CATALOG_PATHS.input, input);
  writeText(root, MODEL_CATALOG_PATHS.source, source);
  writeText(root, MODEL_CATALOG_PATHS.license, license);
  return writeModelCatalog(root);
}

/** Why the committed files differ from what the input generates, or `undefined` when they match. */
export function modelCatalogDrift(root: string): string | undefined {
  const { path, text, document } = generateModelCatalog(root);
  const committed = (relative: string): string | undefined => {
    try {
      return readFileSync(join(root, relative), "utf-8").replace(/\r\n/g, "\n");
    } catch {
      return undefined;
    }
  };
  if (committed(path) !== text) {
    return `${path} differs from what ${dirname(MODEL_CATALOG_PATHS.input)}/ generates`;
  }
  if (committed(MODEL_CATALOG_PATHS.packagedLicense) !== document.license.text) {
    return `${MODEL_CATALOG_PATHS.packagedLicense} is not the license ${MODEL_CATALOG_PATHS.license} carries`;
  }
  return undefined;
}
