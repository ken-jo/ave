#!/usr/bin/env node
// Compare tracked catalog barrels with the assembler output, including fragment order.
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildI18nCatalogArtifacts, MESSAGES_DIR } from "./i18n-catalog-artifacts.mjs";

const LABEL = "[i18n-barrels]";

/**
 * Compare each barrel on disk against what the assembler would write.
 *
 * @param {string} [messagesDir] Root of the message catalogs.
 * @returns {{ fragmentCount: number, checked: number, divergent: { path: string, reason: "content" | "line-endings" | "unreadable", detail?: string }[] }}
 */
export function findDivergentBarrels(messagesDir = MESSAGES_DIR) {
  const { fragments, artifacts } = buildI18nCatalogArtifacts(messagesDir);
  const divergent = [];

  for (const { path, content } of artifacts) {
    let actual;
    try {
      actual = readFileSync(path, "utf-8");
    } catch (err) {
      // A missing barrel is a divergence.
      divergent.push({ path, reason: "unreadable", detail: err.message });
      continue;
    }
    if (actual === content) continue;
    divergent.push({
      path,
      // Report line-ending differences separately from content changes.
      reason: actual.replace(/\r\n/g, "\n") === content ? "line-endings" : "content",
    });
  }

  return { fragmentCount: fragments.length, checked: artifacts.length, divergent };
}

const REASON_TEXT = {
  content: "committed bytes differ from the assembler's output",
  "line-endings": "differs only in line endings; the working tree should be LF (see .gitattributes)",
  unreadable: "cannot be read",
};

// Imports without a script path must not call resolve(undefined).
const invokedPath = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === invokedPath) {
  let result;
  try {
    result = findDivergentBarrels();
  } catch (err) {
    // An unreadable fragment directory fails closed.
    console.error(`${LABEL} FAIL — cannot assemble the catalog barrels: ${err.message}`);
    process.exit(1);
  }

  if (result.divergent.length > 0) {
    for (const { path, reason, detail } of result.divergent) {
      console.error(
        `${LABEL} ${relative(process.cwd(), path)} — ${REASON_TEXT[reason]}${detail ? ` (${detail})` : ""}`,
      );
    }
    console.error(
      `${LABEL} FAIL — ${result.divergent.length} barrel(s) diverge from \`node scripts/i18n-build-catalog.mjs\`.`,
    );
    console.error(
      `${LABEL} These barrels are generated. Do not edit them by hand — add or remove a`,
    );
    console.error(
      `${LABEL} fragment under src/i18n/messages/generated/ and re-run the assembler.`,
    );
    process.exit(1);
  }

  console.log(`${LABEL} OK — ${result.checked} barrel(s) match ${result.fragmentCount} fragment(s)`);
}
