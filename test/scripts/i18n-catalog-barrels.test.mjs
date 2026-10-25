// Key sets cannot detect barrel order; include both positive and negative order fixtures.
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildI18nCatalogArtifacts } from "../../scripts/i18n-catalog-artifacts.mjs";
import { findDivergentBarrels } from "../../scripts/check-i18n-catalog-barrels.mjs";

function fixtureMessagesDir(fragmentNames) {
  const root = mkdtempSync(join(tmpdir(), "ave-i18n-barrels-"));
  mkdirSync(join(root, "generated"));
  mkdirSync(join(root, "generated-locales"));
  for (const name of fragmentNames) {
    writeFileSync(
      join(root, "generated", `${name}.ts`),
      `export const en = { "${name}.key": "text" } as const;\n`
        + `export const ko: Record<keyof typeof en, string> = { "${name}.key": "텍스트" };\n`,
    );
  }
  return root;
}

function assemble(root) {
  for (const { path, content } of buildI18nCatalogArtifacts(root).artifacts) {
    writeFileSync(path, content, "utf-8");
  }
}

test("passes when the barrels are what the assembler writes", () => {
  const root = fixtureMessagesDir(["alpha", "beta"]);
  try {
    assemble(root);
    const { divergent, checked, fragmentCount } = findDivergentBarrels(root);
    assert.deepEqual(divergent, []);
    assert.equal(checked, 2);
    assert.equal(fragmentCount, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails when a barrel is hand-edited into the wrong fragment order", () => {
  // Reordering alone leaves the key set unchanged.
  const root = fixtureMessagesDir(["alpha", "beta", "gamma"]);
  try {
    assemble(root);
    const barrel = join(root, "generated", "index.ts");
    const shuffled = readFileSync(barrel, "utf-8")
      .replace('import { en as en_gamma } from "./gamma.js";\n', "")
      .replace(
        'import { en as en_alpha } from "./alpha.js";',
        'import { en as en_gamma } from "./gamma.js";\nimport { en as en_alpha } from "./alpha.js";',
      );
    writeFileSync(barrel, shuffled);

    const { divergent } = findDivergentBarrels(root);
    assert.equal(divergent.length, 1);
    assert.equal(divergent[0].path, barrel);
    assert.equal(divergent[0].reason, "content");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("fails when a new fragment is not reflected in the barrels", () => {
  const root = fixtureMessagesDir(["alpha"]);
  try {
    assemble(root);
    assert.deepEqual(findDivergentBarrels(root).divergent, []);

    writeFileSync(
      join(root, "generated", "omega.ts"),
      'export const en = { "omega.key": "text" } as const;\n'
        + 'export const ko: Record<keyof typeof en, string> = { "omega.key": "텍스트" };\n',
    );

    const { divergent } = findDivergentBarrels(root);
    assert.equal(divergent.length, 2);
    assert.deepEqual(divergent.map((entry) => entry.reason), ["content", "content"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports a CRLF working tree as a line-ending problem, not a content one", () => {
  const root = fixtureMessagesDir(["alpha"]);
  try {
    assemble(root);
    const barrel = join(root, "generated-locales", "ko.ts");
    writeFileSync(barrel, readFileSync(barrel, "utf-8").replace(/\n/g, "\r\n"));

    const { divergent } = findDivergentBarrels(root);
    assert.equal(divergent.length, 1);
    assert.equal(divergent[0].reason, "line-endings");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("reports a missing barrel instead of treating it as a match", () => {
  const root = fixtureMessagesDir(["alpha"]);
  try {
    assemble(root);
    rmSync(join(root, "generated", "index.ts"));

    const { divergent } = findDivergentBarrels(root);
    assert.equal(divergent.length, 1);
    assert.equal(divergent[0].reason, "unreadable");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("orders fragments by code unit, independent of directory order", () => {
  // Filesystem order is unspecified; code-unit order places Z before a.
  const root = fixtureMessagesDir(["alpha", "Zulu", "beta"]);
  try {
    assert.deepEqual(buildI18nCatalogArtifacts(root).fragments, ["Zulu", "alpha", "beta"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
