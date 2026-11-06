import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

// Korean is built in, so the footprint gate must fail a package without its lazy catalog chunk.
const scriptSrc = readFileSync(resolve(process.cwd(), "scripts/check-package-footprint.mjs"), "utf8");

function chunkPattern(name: string): RegExp {
  const entry = new RegExp(String.raw`\{\s*name:\s*"${name}",\s*pattern:\s*/(.+?)/([a-z]*)\s*\}`).exec(scriptSrc);
  if (!entry) throw new Error(`check-package-footprint.mjs has no ${name} LAZY_RENDERER_CHUNKS entry`);
  return new RegExp(entry[1], entry[2]);
}

const KO = chunkPattern("i18n-ko");
const PACKAGED = ["/dist/src/renderer/chunks/i18n-ko.c95c7cd2.js"];

describe("packaged footprint Korean chunk guard", () => {
  it("accepts the emitted contenthash Korean chunk", () => {
    expect(PACKAGED.some((entry) => KO.test(entry))).toBe(true);
  });

  it("reports a package without the Korean catalog chunk as missing", () => {
    const withoutCatalog = PACKAGED.filter((entry) => !entry.includes("/i18n-ko."));
    expect(withoutCatalog.some((entry) => KO.test(entry))).toBe(false);
  });

  it("does not let the seed chunk or a license sidecar stand in for the catalog", () => {
    expect(KO.test("/dist/src/renderer/chunks/i18n-ko-seed.ad8a8012.js")).toBe(false);
    expect(KO.test("/dist/src/renderer/chunks/i18n-ko.c95c7cd2.js.LICENSE.txt")).toBe(false);
  });
});

describe("Korean catalog stays lazy", () => {
  it("is imported statically by no production module", () => {
    const src = resolve(process.cwd(), "src");
    const staticKo = /^\s*import\s(?!type\b)[^;]*from\s+["'][^"']*messages\/ko\.js["']/mu;
    const offenders = readdirSync(src, { recursive: true, encoding: "utf8" })
      .filter((file) => /\.(?:ts|tsx|mts|cts)$/u.test(file) && !/(?:^|[\\/])__tests__[\\/]/u.test(file))
      .filter((file) => staticKo.test(readFileSync(resolve(src, file), "utf8")));
    expect(offenders).toEqual([]);
  });
});
