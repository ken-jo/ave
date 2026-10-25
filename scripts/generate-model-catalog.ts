// Reproduce the bundled snapshot from committed input; --fetch replaces input and regenerates.
// Run unconditionally and print exactly one outcome line.
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  MODEL_CATALOG_LABEL as LABEL,
  fetchAndWriteModelCatalog,
  generateModelCatalog,
  modelCatalogDrift,
  writeModelCatalog,
} from "./lib/model-catalog.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function outcome({ path, document, diagnostics }: ReturnType<typeof generateModelCatalog>): string {
  for (const diagnostic of diagnostics) {
    console.error(`${LABEL} ${diagnostic.provider}${diagnostic.model ? `/${diagnostic.model}` : ""}: ${diagnostic.message}`);
  }
  const models = Object.values(document.providers).reduce((sum, provider) => sum + Object.keys(provider.models).length, 0);
  return `wrote ${path} (${Object.keys(document.providers).length} providers, ${models} models, ${diagnostics.length} diagnostics, sha256 ${document.sha256})`;
}

async function run(args: readonly string[]): Promise<string> {
  if (args.length > 1 || (args.length === 1 && !["--check", "--fetch"].includes(args[0] as string))) {
    throw new Error(`unexpected arguments '${args.join(" ")}'; the options are --check and --fetch`);
  }
  const mode = args[0];
  if (mode === "--fetch") return outcome(await fetchAndWriteModelCatalog(ROOT));
  if (mode !== "--check") return outcome(writeModelCatalog(ROOT));
  const drift = modelCatalogDrift(ROOT);
  if (drift) throw new Error(`${drift}. Run \`bun run generate:model-catalog\` and commit the result.`);
  return "the snapshot and the packaged license match their input";
}

try {
  console.log(`${LABEL} ${await run(process.argv.slice(2))}`);
} catch (error) {
  // Print a concise gate verdict rather than a stack trace.
  const message = error instanceof Error ? error.message : String(error);
  console.error(message.startsWith(LABEL) ? message : `${LABEL} ${message}`);
  process.exitCode = 1;
}
