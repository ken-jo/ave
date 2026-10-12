/**
 * Write the bundled model catalog, check the committed copy, download new
 * input, or compare the catalog with the hand-kept pricing table.
 *
 *   node --import tsx scripts/generate-model-catalog.ts           write the snapshot from the committed input
 *   node --import tsx scripts/generate-model-catalog.ts --check   fail if the snapshot differs from what the input generates
 *   node --import tsx scripts/generate-model-catalog.ts --fetch   download models.dev, replace the input, write the snapshot
 *   node --import tsx scripts/generate-model-catalog.ts --report  print DEFAULT_PRICING against the snapshot, as Markdown
 *
 * The generator is `scripts/lib/model-catalog.ts`; this file is its command
 * line, and it runs unconditionally for the reason
 * `generate-plugin-host-protocol-schema.ts` gives. Every run except
 * `--report` prints exactly one outcome line; only `wrote …` and `… matches
 * its input` exit 0.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MODEL_CATALOG_LABEL as LABEL,
  MODEL_CATALOG_PATHS,
  fetchModelCatalogInput,
  generateModelCatalog,
  modelCatalogPricingReport,
} from "./lib/model-catalog.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function write(path: string, text: string): void {
  const target = join(ROOT, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text, "utf-8");
}

function writeSnapshot(): string {
  const { path, text, document, diagnostics } = generateModelCatalog(ROOT);
  write(path, text);
  for (const diagnostic of diagnostics) {
    console.error(`${LABEL} ${diagnostic.provider}${diagnostic.model ? `/${diagnostic.model}` : ""}: ${diagnostic.message}`);
  }
  const models = Object.values(document.providers).reduce((sum, provider) => sum + Object.keys(provider.models).length, 0);
  return `wrote ${path} (${Object.keys(document.providers).length} providers, ${models} models, ${diagnostics.length} diagnostics, sha256 ${document.sha256})`;
}

async function run(args: readonly string[]): Promise<string | undefined> {
  if (args.length > 1 || (args.length === 1 && !["--check", "--fetch", "--report"].includes(args[0] as string))) {
    throw new Error(`unexpected arguments '${args.join(" ")}'; the options are --check, --fetch and --report`);
  }
  const mode = args[0];
  if (mode === "--fetch") {
    const { input, source, license } = await fetchModelCatalogInput();
    write(MODEL_CATALOG_PATHS.input, input);
    write(MODEL_CATALOG_PATHS.source, source);
    write(MODEL_CATALOG_PATHS.license, license);
    return writeSnapshot();
  }
  if (mode === "--report") {
    console.log(modelCatalogPricingReport(generateModelCatalog(ROOT).document));
    return undefined;
  }
  if (mode !== "--check") return writeSnapshot();
  const { path, text } = generateModelCatalog(ROOT);
  let committed: string;
  try {
    committed = readFileSync(join(ROOT, path), "utf-8");
  } catch {
    throw new Error(`${path} is missing; run bun run generate:model-catalog`);
  }
  if (committed.replace(/\r\n/g, "\n") !== text) {
    throw new Error(
      `${path} differs from what ${dirname(MODEL_CATALOG_PATHS.input)}/ generates. Run `
        + "`bun run generate:model-catalog` and commit the result.",
    );
  }
  return `${path} matches its input`;
}

try {
  const outcome = await run(process.argv.slice(2));
  if (outcome) console.log(`${LABEL} ${outcome}`);
} catch (error) {
  // One line, not a stack: this is a gate's verdict, read in a build log.
  const message = error instanceof Error ? error.message : String(error);
  console.error(message.startsWith(LABEL) ? message : `${LABEL} ${message}`);
  process.exitCode = 1;
}
